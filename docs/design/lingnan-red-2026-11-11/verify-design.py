"""Verify static design evidence. No WeChat, database, paid model or application writes."""
from pathlib import Path
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw, ImageFont
import json, hashlib, re, subprocess

ROOT=Path(__file__).resolve().parent
REPO=ROOT.parents[2]
WORK=REPO/'artifacts'/'lingnan-redesign'
REVIEW=ROOT/'review'
for d in [WORK,REVIEW,REVIEW/'narrow',REVIEW/'scroll',REVIEW/'details']:
    d.mkdir(parents=True,exist_ok=True)
SCREENS=json.loads((ROOT/'screens.json').read_text(encoding='utf-8'))
BYID={int(s['id']):s for s in SCREENS}
def path(id): return ROOT/BYID[id]['file']
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
failures=[]
results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe')
    page=browser.new_page(viewport={'width':390,'height':844})
    for width in [390,320]:
        page.set_viewport_size({'width':width,'height':844})
        for s in SCREENS:
            page.goto((ROOT/s['file']).as_uri())
            page.evaluate('document.fonts.ready')
            check=page.evaluate('''() => ({
              width:innerWidth, scroll:document.documentElement.scrollWidth,
              scripts:document.scripts.length,
              textOverflow:[...document.querySelectorAll('h1,h2,h3,p,.btn,.fieldbox,.kv,.nav-title,.plan-stat')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.textContent.trim().slice(0,50)),
              links:[...document.querySelectorAll('a')].map(a=>({href:a.getAttribute('href'),text:a.innerText,visible:a.getClientRects().length>0,rect:{w:a.getBoundingClientRect().width,h:a.getBoundingClientRect().height}})),
              images:[...document.images].map(i=>i.complete&&i.naturalWidth>0),
              contentScroll:document.querySelector('.with-tabs .content')?.scrollHeight??null
            })''')
            issues=[]
            if check['scroll']>width: issues.append('page overflow')
            if check['scripts']: issues.append('JS in static screen')
            if check['textOverflow']: issues.append({'textOverflow':check['textOverflow']})
            if any(not x for x in check['images']): issues.append('missing image')
            for a in check['links']:
                target=(ROOT/a['href'].split('#')[0])
                if not target.exists(): issues.append('broken link: '+a['href'])
                elif '#' in a['href'] and ('id="'+a['href'].split('#',1)[1]+'"') not in target.read_text(encoding='utf-8'): issues.append('missing anchor: '+a['href'])
                if a['visible'] and min(a['rect']['w'],a['rect']['h'])<43.5: issues.append('small target: '+a['text'][:18])
            results.append({'screen':s['id'],'width':width,'issues':issues})
            if issues: failures.append(results[-1])
            if width==320:
                page.screenshot(path=str(REVIEW/'narrow'/(Path(s['file']).stem+'.png')),full_page=True)
            if s['id'] in ['01','02','11','19','36','53','67']:
                page.locator('.content').evaluate('(e)=>e.scrollTop=e.scrollHeight')
                page.screenshot(path=str(REVIEW/'scroll'/f"{s['id']}-{width}-bottom.png"))
            if s['id'] in ['04','15','16','31','69','76','77']:
                page.locator('.content').evaluate('(e)=>e.scrollTop=e.scrollHeight')
                page.screenshot(path=str(REVIEW/'scroll'/f"{s['id']}-{width}-confirmation-bottom.png"))
                content_box=page.locator('.content').bounding_box()
                dock_box=page.locator('.dock').bounding_box()
                if content_box['y']+content_box['height']>dock_box['y']+1: failures.append({'dockOverlap':s['id'],'width':width})
            if s['id']=='77':
                page.locator('.content').evaluate('(e)=>e.scrollTop=(e.scrollHeight-e.clientHeight)/2')
                page.screenshot(path=str(REVIEW/'scroll'/f'77-{width}-record-middle.png'))
            if s['id']=='04':
                page.locator('.more-courses summary').click()
                row_sizes=page.locator('.more-courses .row-edit').evaluate_all('(es)=>es.map(e=>({w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height}))')
                if len(row_sizes)!=6 or any(min(x['w'],x['h'])<43.5 for x in row_sizes): failures.append({'expandedCourseTargets':width,'sizes':row_sizes})
                page.locator('.content').evaluate('(e)=>e.scrollTop=e.scrollHeight')
                page.screenshot(path=str(REVIEW/'scroll'/f'04-{width}-expanded-courses.png'))
    # Fixed period axis remains visible while the week scrolls, at both widths.
    scrolling=[]
    for width in [390,320]:
        page.set_viewport_size({'width':width,'height':844})
        page.goto(path(51).as_uri())
        for position in ['left','middle','right']:
            page.locator('.week-scroll').evaluate('(e,p)=>e.scrollLeft=p==="left"?0:p==="middle"?(e.scrollWidth-e.clientWidth)/2:e.scrollWidth',position)
            axis=page.locator('.period-axis .axis').evaluate_all('(es)=>es.map(e=>({text:e.innerText,x:e.getBoundingClientRect().x,w:e.getBoundingClientRect().width}))')
            container=page.locator('.week-shell').bounding_box()
            ok=len(axis)==7 and all(a['x']>=container['x'] and a['x']+a['w']<=container['x']+38 for a in axis)
            if not ok: failures.append({'weekAxis':width,'position':position})
            page.screenshot(path=str(REVIEW/'scroll'/f'week-{width}-{position}.png'),full_page=True)
            scrolling.append({'width':width,'position':position,'axisVisible':ok})
    changed_visibility=[]
    for width in [390,320]:
        page.set_viewport_size({'width':width,'height':844})
        page.goto(path(71).as_uri())
        cell=page.locator('.course.changed').bounding_box()
        area=page.locator('.week-scroll').bounding_box()
        content=page.locator('.content').bounding_box()
        visible=cell['x']>=area['x'] and cell['x']+cell['width']<=area['x']+area['width']+1 and cell['y']+cell['height']<=content['y']+content['height']+1
        changed_visibility.append({'width':width,'changedCellVisibleInitially':visible,'marker':page.locator('.course-flag').inner_text()})
        if not visible: failures.append({'changedCellInitial':width,'cell':cell,'area':area,'content':content})
        page.screenshot(path=str(REVIEW/'scroll'/f'71-{width}-changed-initial.png'))
    # Static links show intended destinations, not real writes or state persistence.
    chains=[
      ('import-excel',[1,3,76,68,69,2]),('import-photo',[3,4,75,69,2]),('notice',[2,8,9,70,9,10,71]),('notice-undo',[10,72,2]),('partial-retry',[39,73,8]),('plan',[11,12,14,15,16,17,2]),
      ('plan-fallback',[43,49,16,17]),('plan-conflict',[18,14]),('historical',[40,12]),
      ('goal-delete',[13,54,55,40]),('campus-reading',[19,23,24,19]),
      ('department',[19,20,21,22,21]),('advancement',[11,28,29,30,28]),
      ('fitness',[11,26,27,26]),('fitness-incomplete',[63,26]),
      ('defense',[31,32,33,32]),('later-rounds',[34,56,57,58,59,35,60,61,62,31]),
      ('claim',[44,46,47,48,50]),('import-failure',[38,3]),('invalid',[52,5]),
      ('constraint-clarify',[64,49,16]),('long-course',[51,74,51]),('other-course-correction',[76,79,69,2]),
      ('copy-record-and-exit',[35,77,78,31]),('copy-record-and-stay',[62,78,35])
    ]
    navigation=[]
    page.set_viewport_size({'width':390,'height':844})
    for name,ids in chains:
        page.goto(path(ids[0]).as_uri())
        for id in ids[1:]:
            try:
                page.locator(f'a[href="{BYID[id]["file"]}"],a[href^="{BYID[id]["file"]}#"]').first.click(timeout=3000)
                assert page.url.split('#')[0].endswith(BYID[id]['file'])
            except Exception as e: failures.append({'chain':name,'target':id,'error':str(e)[:160]}); break
        else: navigation.append({'name':name,'screens':ids,'staticLinks':'passed'})
    # Native HTML radio selection and local scroll are static-prototype checks only.
    page.set_viewport_size({'width':320,'height':844})
    page.goto(path(31).as_uri())
    page.locator('label[for="material-course"]').click()
    assert page.locator('#material-course').is_checked()
    page.screenshot(path=str(REVIEW/'scroll'/'31-320-material-two.png'),full_page=True)
    page.goto(path(67).as_uri())
    page.locator('.week-days').evaluate('(e)=>e.scrollLeft=e.scrollWidth')
    assert page.locator('.week-days a').last.bounding_box()['x']<320
    page.screenshot(path=str(REVIEW/'scroll'/'67-320-dates-right.png'))
    page.goto(path(71).as_uri())
    page.locator('.content').evaluate('(e)=>e.scrollTop=0')
    page.locator('.week-scroll').evaluate('(e)=>e.scrollLeft=0')
    page.screenshot(path=str(REVIEW/'scroll'/'71-320-changed-friday.png'))
    # All four learning tool names should be visible without scrolling at 320px.
    page.goto(path(11).as_uri())
    tool_names=page.locator('.study-overview .item-title').all_text_contents()
    tool_visibility=page.locator('.study-overview .item-title').evaluate_all('(es)=>es.map(e=>{let r=e.getBoundingClientRect(),c=document.querySelector(".content").getBoundingClientRect();return r.top>=c.top&&r.bottom<=c.bottom})')
    if not all(tool_visibility): failures.append({'learningToolVisibility':dict(zip(tool_names,tool_visibility))})
    page.goto(path(15).as_uri())
    constraints_visible=page.locator('.constraint .evidence').evaluate_all('(es)=>es.map(e=>{let r=e.getBoundingClientRect(),c=document.querySelector(".content").getBoundingClientRect();return r.top>=c.top&&r.bottom<=c.bottom})')
    if not all(constraints_visible): failures.append({'constraintQuotesVisibleAt320':constraints_visible})
    page.goto(path(31).as_uri())
    material_visibility=page.locator('.material-option').evaluate_all('(es)=>es.map(e=>{let r=e.getBoundingClientRect(),c=document.querySelector(".content").getBoundingClientRect();return r.top>=c.top&&r.bottom<=c.bottom})')
    if not all(material_visibility): failures.append({'materialChoicesAt320':material_visibility})
    list_density=[]
    for screen_id in [69,76]:
        page.goto(path(screen_id).as_uri())
        first_three=page.locator('.import-summary').evaluate_all('(es)=>es.slice(0,3).map(e=>{let r=e.getBoundingClientRect(),c=document.querySelector(".content").getBoundingClientRect();return r.top>=c.top&&r.bottom<=c.bottom})')
        list_density.append({'screen':screen_id,'firstThreeVisibleAt320':first_three})
        if len(first_three)!=3 or not all(first_three): failures.append({'importFirstThreeVisible':screen_id,'visible':first_three})
    original_answers=[]
    for source_id in [32,56,58,60]:
        page.goto(path(source_id).as_uri())
        original_answers.append(page.locator('.fieldbox.textarea').inner_text())
    page.goto(path(77).as_uri())
    record_text=page.locator('.content').inner_text()
    originals_match=all(answer in record_text for answer in original_answers)
    if not originals_match: failures.append({'recordOriginalAnswerMismatch':True})
    # Readable element renders supplement the original full-frame appendix evidence.
    # They come from the same HTML at DPR3; no text is painted onto screenshots.
    detail_page=browser.new_page(viewport={'width':320,'height':844},device_scale_factor=3)
    appendix_details=[]
    for width in [320,390]:
        detail_page.set_viewport_size({'width':width,'height':844})
        for screen_id in [44,45,46,47,48,50]:
            detail_page.goto(path(screen_id).as_uri())
            detail_page.evaluate('document.fonts.ready')
            label=detail_page.locator('.dormant')
            label.screenshot(path=str(REVIEW/'details'/f'appendix-{screen_id}-{width}.png'))
            appendix_details.append({'screen':screen_id,'width':width,'text':label.inner_text(),'logicalBounds':label.bounding_box(),'detailDPR':3})
    browser.close()

def lum(h):
    rgb=[int(h[i:i+2],16)/255 for i in [1,3,5]]
    return sum(k*(v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4) for k,v in zip([.2126,.7152,.0722],rgb))
contrasts=[]
for fg,bg in [('#ffffff','#c41c23'),('#2b2422','#ffffff'),('#6b5d57','#f5f6f8'),('#6b5d57','#ffffff'),('#147a70','#e8f3f0'),('#83501e','#fff5e8'),('#865e17','#fbf4e2'),('#8c1614','#fff0ef'),('#405d7c','#eaf0f7'),('#655183','#f0edf8')]:
    ratio=(max(lum(fg),lum(bg))+.05)/(min(lum(fg),lum(bg))+.05)
    contrasts.append({'fg':fg,'bg':bg,'ratio':round(ratio,2),'normalText45':ratio>=4.5})
    if ratio<4.5: failures.append({'contrast':[fg,bg],'ratio':ratio})
tokens=dict(re.findall(r'(--[\w-]+):\s*([^;]+);',(ROOT/'_tokens.css').read_text()))
production=dict(re.findall(r'(--[\w-]+):\s*([^;]+);',(REPO/'miniprogram'/'app.wxss').read_text()))
token_issues={k:v for k,v in tokens.items() if production.get(k)!=v}
if token_issues: failures.append({'tokenMismatch':token_issues})
control_ratio=(lum('#ffffff')+.05)/(lum('#8d8d98')+.05)
if control_ratio<3: failures.append({'inputBorderContrast':control_ratio})
routes=json.loads((REPO/'miniprogram'/'app.json').read_text())['pages']
covered={s['route'].split('#')[0] for s in SCREENS}
missing_routes=sorted(set(routes)-covered)
if missing_routes: failures.append({'missingRoutes':missing_routes})
fitness=json.loads(subprocess.check_output(['node','-e',"process.stdout.write(JSON.stringify(require('./dist/services/fitness/index.js').estimate({sex:'male',band:'freshman',height:175,weight:61.3,vitalCapacity:4300,sprint50:7,sitAndReach:17.7,standingLongJump:248,strength:15,distanceRunSeconds:222})))"],cwd=REPO,text=True,encoding='utf-8'))
fitness_ok=fitness['total']==84 and [i['score'] for i in fitness['items']]==[100,80,85,80,80,80,80]
if not fitness_ok: failures.append({'fitnessMismatch':fitness})

# Boards contain real rendered screens; screenshots are never painted or retouched.
fontfile='C:/Windows/Fonts/msyh.ttc'
def board(ids,out,cols=4,card_width=312,crop_height=844,title='岭南小栈 · 岭南红全新设计'):
    margin=40; gap=24; label_height=40; header=115
    cell_height=int(card_width/390*crop_height)+label_height
    rows=(len(ids)+cols-1)//cols
    im=Image.new('RGB',(margin*2+cols*card_width+(cols-1)*gap,header+margin+rows*(cell_height+gap)), '#eef0f4')
    draw=ImageDraw.Draw(im)
    draw.text((margin,22),title,font=ImageFont.truetype(fontfile,26),fill='#2b2422')
    draw.text((margin,66),'静态设计提案 / 虚构内容 / 390px / 长页完整内容见单图',font=ImageFont.truetype(fontfile,13),fill='#6b5d57')
    for i,id in enumerate(ids):
        x=margin+(i%cols)*(card_width+gap);y=header+(i//cols)*(cell_height+gap)
        draw.text((x,y),f'{id:02} · '+BYID[id]['title'],font=ImageFont.truetype(fontfile,13),fill='#2b2422')
        original=Image.open(ROOT/'png'/(path(id).stem+'.png')).convert('RGB')
        cropped=original.crop((0,0,original.width,min(original.height,int(original.width/390*crop_height))))
        cropped.thumbnail((card_width,cell_height-label_height),Image.Resampling.LANCZOS)
        im.paste(cropped,(x,y+label_height))
    im.save(REVIEW/out)

board([1,2,11,19],'overview.png',card_width=340)
for i in range(0,len(SCREENS),8):
    board([int(s['id']) for s in SCREENS[i:i+8]],f'contact-{i//8+1:02}.png',cols=4,card_width=340)

report={'mode':'static design only','screens':len(SCREENS),'routeCoverage':{'registered':len(routes),'covered':len(routes)-len(missing_routes),'missing':missing_routes},'viewports':[390,320],'renderScenarios':results,'staticNavigation':navigation,'weekScrolling':scrolling,'learningToolsVisibleAt320':dict(zip(tool_names,tool_visibility)),'constraintQuotesVisibleAt320':constraints_visible,'browserOnlyRadioSelection':True,'browserOnlySundayScroll':True,'contrastSamples':contrasts,'inputBorderContrast':round(control_ratio,2),'productionTokens':{'checked':len(tokens),'mismatches':token_issues},'fitnessFixtureMatchesCurrentCalculator':fitness_ok,'failures':failures,'notVerified':['真实微信页面及路由','模型或云端保存','上传与复制','交互持久化和动态上下文返回','读屏与系统字号','真机及动效性能']}
report['changedCellInitiallyVisible']=changed_visibility
report['materialChoicesVisibleAt320']=material_visibility
report['recordPreservesAllFourOriginalAnswers']=originals_match
report['importListInitialDensity']=list_density
report['appendixScopeDetails']=appendix_details
(REVIEW/'checks.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'screens':len(SCREENS),'renderScenarios':len(results),'staticPaths':len(navigation),'routeCoverage':report['routeCoverage'],'failures':failures},ensure_ascii=False))
if failures: raise SystemExit(1)
