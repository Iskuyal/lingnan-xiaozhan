"""Render and verify the complete introduction / use / result product showcase."""
from pathlib import Path
import argparse,json,subprocess,time,hashlib
from playwright.sync_api import sync_playwright
SOURCE=Path(__file__).resolve().parent
ROOT=next((p for p in SOURCE.parents if (p/'miniprogram/app.json').exists()),SOURCE.parent)
BUILD=ROOT/'artifacts/product-demo-v7'
BUILD.mkdir(parents=True,exist_ok=True)
model=json.loads((SOURCE/'showcase-model.json').read_text(encoding='utf-8'))
parser=argparse.ArgumentParser();parser.add_argument('--inspect',action='store_true');parser.add_argument('--preview',action='store_true');parser.add_argument('--from-seconds',type=float,default=0);parser.add_argument('--to-seconds',type=float);parser.add_argument('--clip-name');parser.add_argument('--ranges')
args=parser.parse_args();FPS=24
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe',headless=True,args=['--allow-file-access-from-files','--hide-scrollbars'])
 page=browser.new_page(viewport={'width':1600,'height':900},device_scale_factor=1)
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(SOURCE.joinpath('index.html').as_uri()+'?export=1');page.wait_for_load_state('networkidle');page.evaluate('document.fonts.ready')
 snapshots=[]
 for f in model['features']:
  process_time={'photo':55.5,'change':111}.get(f['id'],(f['process']+f['result'])/2)
  for phase,t in [('intro',f['start']+2),('process',process_time),('result',f['shot'])]:
   data=page.evaluate('(t)=>window.renderAt(t)',t)
   stage_file=BUILD/f'{f["id"]}-{phase}.png';page.screenshot(path=str(stage_file))
   alpha=page.add_style_tag(content='body,#stage{background:transparent!important}#backdrop{display:none!important}')
   page.locator('#phone').screenshot(path=str(BUILD/f'{f["id"]}-{phase}-phone.png'),omit_background=True)
   if phase=='result':page.locator('#phone').screenshot(path=str(BUILD/f'{f["id"]}-phone.png'),omit_background=True)
   alpha.evaluate('(e)=>e.remove()')
   snapshots.append({'feature':f['id'],'phase':phase,'time':t,'path':str(stage_file),'sha256':hashlib.sha256(stage_file.read_bytes()).hexdigest(),**data})
 page.evaluate('window.renderAt(2)');page.screenshot(path=str(BUILD/'cover.png'))
 page.evaluate('window.renderAt(231)');page.screenshot(path=str(BUILD/'ending.png'))
 # Focused process and result crops for projected slides. These are browser captures, not painted UI.
 for name,t,selector,offset,height in [('excel-edit-focus',36,'.sheet','bottom',210),('excel-result-focus',43,'.grid',89,120),('change-proposal-focus',111,'.proposal',0,None),('change-result-focus',118,'.grid',209,120)]:
  page.evaluate('(t)=>window.renderAt(t)',t);rect=page.locator(selector).bounding_box()
  y=rect['y']+max(0,rect['height']-height) if offset=='bottom' else rect['y']+offset
  page.screenshot(path=str(BUILD/(name+'.png')),clip={'x':rect['x'],'y':y,'width':rect['width'],'height':height or rect['height']})
 for name,t,selector in [('photo-input-focus',50,'.scan-picture'),('photo-draft-focus',55.5,'.course-card:has-text("数据库应用")'),('photo-save-focus',55.5,'.sticky-actions'),('query-answer-focus',97,'.sheet .bubble:not(.user)'),('department-answer-focus',137.7,'.sheet .bubble:not(.user)'),('advancement-source-focus',225,'.page-inner .source-link'),('change-controls-focus',111,'.proposal .form-actions')]:
  page.evaluate('(t)=>window.renderAt(t)',t);page.locator(selector).screenshot(path=str(BUILD/(name+'.png')))
 checks=[]
 def check(label,condition):
  if not condition:raise AssertionError(label)
  checks.append(label)
 def state():return page.evaluate('window.getDemoState()')
 page.evaluate('window.renderAt(31)');check('Excel draft is not saved',len(state()['saved'])==0)
 page.locator('#edit-2').click();page.locator('#location-input').fill('B305');page.locator('#edit-save').click()
 check('Correction retains classroom in draft',state()['draft'][1]['location']=='B305')
 page.locator('#draft-save').click();check('Save dialog still does not write',len(state()['saved'])==0)
 page.locator('#save-cancel').click();check('Cancel leaves persisted courses untouched',len(state()['saved'])==0)
 page.locator('#draft-save').click();page.locator('#save-confirm').click();check('Explicit confirmation saves six courses',len(state()['saved'])==6)
 page.evaluate('window.renderAt(55)');check('Photo recognition produces a separate draft',state()['importMode']=='photo' and len(state()['draft'])==6)
 page.locator('#draft-abandon').click();check('Abandoning photo draft preserves prior six saved courses',len(state()['saved'])==6 and state()['route']=='week')
 page.evaluate('window.renderAt(81)');check('Manual course visibly increases saved total',len(state()['saved'])==7 and any(c['name']=='自主学习' for c in state()['saved']))
 check('Manual edit changes the saved classroom',next(c for c in state()['saved'] if c['id']==2)['location']=='B308')
 page.locator('#week-prev').click();check('Previous week decrements the displayed week',state()['week']==4)
 page.locator('#week-next').click();check('Next week restores the displayed week',state()['week']==5)
 page.evaluate('window.renderAt(97)');answer=state()['messages'][-1]['text'];check('Query uses current course location and new manual course','B308' in answer and '自主学习' in answer)
 page.evaluate('window.renderAt(105)');check('Typing an AI request is labelled as proposing the request',page.locator('#action-readout').inner_text().startswith('1.'))
 page.evaluate('window.renderAt(111)');check('Pending AI proposal is labelled as awaiting confirmation',('等待本人确认' in page.locator('#focus-lens').inner_text() and '当前课程数' in page.locator('#focus-lens').inner_text() and '7门' in page.locator('#focus-lens').inner_text()) or page.locator('#action-readout').inner_text().startswith('2.'))
 check('AI proposal leaves course data unchanged',len(state()['saved'])==7 and state()['proposal'] is not None)
 page.locator('#cancel-course').click();check('Cancelling AI proposal leaves all seven courses',len(state()['saved'])==7 and state()['proposal'] is None)
 page.evaluate('window.renderAt(111)');page.locator('#apply-course').click();check('Confirmed AI action saves eighth course',len(state()['saved'])==8)
 check('New course appears in visible timetable',page.locator('#course-7').inner_text().find('项目实践')>=0)
 page.evaluate('window.renderAt(137.7)');check('Department answer contains all four listed units',all(x in state()['messages'][-1]['text'] for x in ['秘书处','组织部','宣传部','广播台']))
 page.evaluate('window.renderAt(158)');check('News result retains title, date and source',all(x in page.locator('.page-inner').inner_text() for x in ['2026-09-12','学校官网','新生入学教育']))
 page.evaluate('window.renderAt(173)');check('Goal result contains name and explicit target date','项目展示' in page.locator('.goal-card').inner_text() and '2026-10-11' in page.locator('.goal-card').inner_text())
 page.evaluate('window.renderAt(187)');check('Calendar shows registered date and source caveat','2026-11-21' in page.locator('.sheet').inner_text() and '2026-09-29' in page.locator('.sheet').inner_text())
 page.keyboard.press('Escape');check('Escape closes the calendar dialog',state()['modal']=='')
 page.evaluate('window.renderAt(204)');check('Seven fitness weights sum to 100 and result is 81',page.evaluate('fitItems.reduce((s,x)=>s+x[2],0)')==100 and page.evaluate('window.calculateDemoFitness()')==81)
 check('Fitness output has all seven rows',page.locator('.page-inner .kv').count()==7)
 page.evaluate('window.renderAt(225)');corpus=json.loads((ROOT/'docs/evidence/advancement-poc/corpus.json').read_text(encoding='utf-8')) if (ROOT/'docs/evidence/advancement-poc/corpus.json').exists() else None
 excerpt=page.locator('.original-excerpt').inner_text();check('Advancement result explicitly scopes historical year','2026' in page.locator('.page-inner').inner_text() and '2027' in page.locator('.page-inner').inner_text())
 if corpus:check('Advancement excerpt matches registered official text',excerpt==corpus['documents'][0]['passages'][0]['text'])
 check('Every feature has all three captured phases',len(snapshots)==36 and all(len([x for x in snapshots if x['feature']==f['id']])==3 for f in model['features']))
 # Same source in a narrow browser: reflow, retained result and legible unscaled phone.
 mobile=browser.new_page(viewport={'width':390,'height':844},reduced_motion='reduce')
 mobile.goto(SOURCE.joinpath('index.html').as_uri());mobile.wait_for_load_state('networkidle');mobile.evaluate('window.renderAt(81)')
 mobile.screenshot(path=str(BUILD/'mobile-week-result.png'),full_page=True)
 for name,t in [('import-edit',35),('photo-draft',55.5),('ai-proposal',111),('news-result',158),('fitness-result',204),('advancement-result',225)]:
  mobile.evaluate('(t)=>window.renderAt(t)',t);mobile.screenshot(path=str(BUILD/f'mobile-{name}.png'),full_page=True)
 check('Narrow layout does not overflow document width',mobile.evaluate('document.documentElement.scrollWidth')<=390)
 check('Narrow phone is reflowed with unscaled controls',mobile.locator('#phone').bounding_box()['width']>330 and mobile.locator('#result-panel').is_visible())
 check('Reduced-motion phone transform is disabled',mobile.locator('#phone').evaluate('(e)=>getComputedStyle(e).transform')=='none')
 mobile.evaluate('window.renderAt(81)');check('Narrow result shows complete edited course names and locations',all(x in mobile.locator('.mobile-course-recap').inner_text() for x in ['数据库应用','B308','自主学习','B301','第9–10节','第1–16周']))
 mobile.evaluate('window.renderAt(204)');last_row=mobile.locator('.v6-fitness-result .kv').last.bounding_box();fitness_view=mobile.locator('#viewport').bounding_box();check('All seven fitness scores fit the initial narrow result',last_row['y']+last_row['height']<=fitness_view['y']+fitness_view['height'])
 # Evidence controls must be initially visible inside the simulated phone, not merely reachable after scrolling.
 for feature,t,selector in [('news',158,'#article-source'),('advancement',225,'#advancement-source'),('fitness',204,'#fitness-rules')]:
  mobile.evaluate('(t)=>window.renderAt(t)',t);r=mobile.locator(selector).bounding_box();v=mobile.locator('#viewport').bounding_box()
  check(f'{feature} evidence control is visible with the result',r['y']>=v['y'] and r['y']+r['height']<=v['y']+v['height'])
  mobile.locator(selector).click()
  if feature=='fitness':
   check('Fitness rule action opens weights and reference result',mobile.locator('.rules-sheet').inner_text().find('81')>=0 and mobile.locator('.rules-sheet .kv').count()==7)
   mobile.keyboard.press('Escape');check('Closing rules preserves the original estimate',mobile.locator('.score strong').inner_text()=='81')
  else:check(f'{feature} source action gives a visible acknowledgement',mobile.locator('.toast').inner_text().find('复制')>=0)
 page.evaluate('window.renderAt(118)');page.locator('#course-7').click();check('Selecting new course shows its own name and location','项目实践' in page.locator('.sheet-title').inner_text() and 'B408' in page.locator('.sheet').inner_text())
 mobile.evaluate('window.renderAt(81)');mobile.locator('#week-list').click();check('Narrow course list exposes complete names',mobile.locator('.full-course').count()==7 and '数据库应用' in mobile.locator('.list-sheet').inner_text())
 mobile.locator('.list-sheet [data-course-id="106"]').click();check('Course list opens the selected manual course','自主学习' in mobile.locator('.sheet-title').inner_text() and 'B301' in mobile.locator('.sheet').inner_text())
 # Every changed visual type and all result states are bound to the current source fingerprint.
 source_files=[x for x in SOURCE.iterdir() if x.suffix in ['.html','.css','.js','.json','.svg']]
 fingerprint=hashlib.sha256(b''.join(x.name.encode()+x.read_bytes() for x in sorted(source_files))).hexdigest()
 mobile.evaluate('window.renderAt(137.7)');mobile.locator('#department-source').click();check('Department source opens identifiable registered material',all(x in mobile.locator('.sheet').inner_text() for x in ['学生组织机构简介','2026-09-18','lnc.edu.cn']))
 mobile.locator('#department-copy').click();check('Department source copy gives visible feedback','复制' in mobile.locator('.toast').inner_text())
 mobile.keyboard.press('Escape');check('Returning from department source preserves the answer',mobile.locator('.bubble:not(.user)').inner_text().find('秘书处')>=0)
 page.evaluate('window.renderAt(190.5)');page.locator('#fitness-calc').click();check('Missing demonstration group is explained before estimating','选择' in page.locator('.toast').inner_text() and not state()['fitness'])
 page.locator('#fitness-group').select_option('male-lower');check('Group selector updates the chosen demonstration group',state()['fitGroup']=='male-lower')
 check('No browser JavaScript errors',not errors)
 (BUILD/'voices.json').write_text(json.dumps(model['voices'],ensure_ascii=False,indent=2),encoding='utf-8')
 (BUILD/'interaction-checks.json').write_text(json.dumps({'fingerprint':fingerprint,'checks':checks,'errors':errors,'screenshots':snapshots},ensure_ascii=False,indent=2),encoding='utf-8')
 print('Checks passed:',len(checks),'source',fingerprint[:12],flush=True)
 if not args.inspect:
  ranges=json.loads(args.ranges) if args.ranges else [[29,53] if args.preview else [args.from_seconds,args.to_seconds or model['duration']]]
  for k,(start,end) in enumerate(ranges):
   path=BUILD/(f'patch-{k:02}.mp4' if args.ranges else args.clip_name or ('preview.mp4' if args.preview else 'product-silent.mp4'));duration=end-start
   proc=subprocess.Popen(['ffmpeg','-y','-loglevel','error','-f','image2pipe','-vcodec','png','-r',str(FPS),'-i','-','-an','-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p',str(path)],stdin=subprocess.PIPE)
   begun=time.monotonic()
   try:
    for n in range(round(duration*FPS)):
     t=start+n/FPS
     page.evaluate('(t)=>window.renderAt(t)',t);proc.stdin.write(page.screenshot(type='png'))
     if n%(FPS*15)==0:print(f'Range {start}-{end}: rendered {n//FPS}/{duration}s, elapsed {time.monotonic()-begun:.0f}s',flush=True)
   finally:proc.stdin.close()
   if proc.wait()!=0:raise RuntimeError('Video encoding failed')
   print(path,flush=True)
 browser.close()
