"""静态设计渲染走查；不调用微信、云端或业务模型。"""
from pathlib import Path
import json, hashlib, re, subprocess
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]
ARTIFACTS = REPO / 'artifacts' / 'lingnan-ui-2026'
ARTIFACTS.mkdir(parents=True, exist_ok=True)
(ROOT / 'review' / 'narrow').mkdir(parents=True, exist_ok=True)
SCREENS = json.loads((ROOT / 'screens.json').read_text(encoding='utf-8'))
results, failures, paths = [], [], []

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe', headless=True)
    page = browser.new_page(viewport={'width':390,'height':844}, device_scale_factor=1)
    for width in (390,320):
        page.set_viewport_size({'width':width,'height':844})
        for s in SCREENS:
            file = ROOT/s['file']
            page.goto(file.as_uri())
            page.evaluate('document.fonts.ready')
            evidence = page.evaluate('''() => {
              const badText=[...document.querySelectorAll('h1,h2,h3,p,.value,.note,.btn,.course,.row-copy')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.textContent.trim().slice(0,50));
              const links=[...document.querySelectorAll('a')].map(e=>({href:e.getAttribute('href'),text:e.textContent.trim(),width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}));
              return {viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,scriptCount:document.scripts.length,badText,links,images:[...document.images].map(e=>({ok:e.complete&&e.naturalWidth>0,width:e.naturalWidth,height:e.naturalHeight}))};
            }''')
            bad = []
            if evidence['scrollWidth']>width: bad.append('horizontal overflow')
            if evidence['scriptCount']: bad.append('script in static HTML')
            if evidence['badText']: bad.append('text overflow '+str(evidence['badText']))
            if any(not i['ok'] for i in evidence['images']): bad.append('broken image')
            for link in evidence['links']:
                target_name,_,fragment=link['href'].partition('#')
                target_file=ROOT/(target_name or s['file'])
                if not target_file.exists(): bad.append('missing target '+link['href'])
                elif fragment and ('id="'+fragment+'"') not in target_file.read_text(encoding='utf-8'): bad.append('missing fragment '+link['href'])
                if link['width']<43.5 or link['height']<43.5: bad.append('small target '+link['text'][:18])
            if width==320: page.screenshot(path=str(ROOT/'review'/'narrow'/(file.stem+'.png')),full_page=True)
            item={'screen':s['id'],'width':width,'horizontalOverflow':evidence['scrollWidth']>width,'linkCount':len(evidence['links']),'issues':bad}
            results.append(item)
            if bad: failures.append(item)

    # 核对同一课程的非连续周次，不让起止周快捷输入掩盖第7周排除状态。
    week_expected=json.loads(subprocess.check_output(['node','-e',"process.stdout.write(JSON.stringify(require('./dist/services/timetable/weeks.js').parseWeekNotation('2-6,8-17').weeks))"],cwd=REPO,encoding='utf-8'))
    page.goto((ROOT/next(s['file'] for s in SCREENS if s['id']=='10')).as_uri())
    week_selected=[int(t) for t in page.locator('.week-choice.selected').all_text_contents()]
    assert week_selected==week_expected and 7 not in week_selected,'non-continuous week selection preserved'

    # 画面跳转只验证静态演示链，不验证真实保存、AI、上传、复制或状态持久化。
    page.set_viewport_size({'width':390,'height':844})
    chains=[
      ('import',['01','02','05','06','08','09','03']),
      ('assistant-cancel',['03','13','14','13']),
      ('assistant-confirm',['13','14','43']),
      ('delete-confirm',['11','36','44']),
      ('fitness',['24','25','26','24']),
      ('news',['19','20','35','20']),
      ('defense-cancel',['30','31','32','31']),
      ('defense-reanswer',['40','41','42','01']),
      ('defense-three-rounds',['33','39','53','52','54','40']),
      ('goal-delete',['22','51','47']),
      ('import-recovery',['49','05','07']),
      ('course-invalid',['50','10'])
      ,('material-reference',['31','56','31']),('reanswer-reference',['41','57','41'])
    ]
    by_id={s['id']:s for s in SCREENS}
    for label,seq in chains:
        page.goto((ROOT/by_id[seq[0]]['file']).as_uri())
        for target in seq[1:]:
            page.locator('a[href="'+by_id[target]['file']+'"],a[href^="'+by_id[target]['file']+'#"]').first.click()
            assert page.url.split('#')[0].endswith(by_id[target]['file']),label
        paths.append({'name':label,'screens':seq,'staticLinks':'passed','businessBehavior':'not tested'})

    # 真实浏览器局部水平滚动：验证固定列宽可查看周末；不外推微信手势。
    stress=[]
    (ROOT/'review'/'stress').mkdir(exist_ok=True)
    for width in (390,320):
        page.set_viewport_size({'width':width,'height':844})
        page.goto((ROOT/by_id['55']['file']).as_uri())
        scroller=page.locator('.week-scroll')
        for position in ('left','middle','right'):
            if position=='left': scroller.evaluate('(e)=>e.scrollLeft=0')
            if position=='middle': scroller.evaluate('(e)=>e.scrollLeft=(e.scrollWidth-e.clientWidth)/2')
            if position=='right':
                scroller.hover()
                page.mouse.wheel(700,0)
                page.wait_for_timeout(200)
            value=scroller.evaluate('(e)=>({left:e.scrollLeft,max:e.scrollWidth-e.clientWidth})')
            if position!='left': assert value['left']>0,'week horizontal scrolling'
            axis=page.locator('.period-label').evaluate_all('''(nodes)=>nodes.map(e=>{
                const b=e.getBoundingClientRect(),r=document.createRange();r.selectNodeContents(e);const t=r.getBoundingClientRect();
                return {text:e.textContent,left:b.left,right:b.right,textLeft:t.left,textRight:t.right};
            })''')
            viewport=scroller.bounding_box()
            shell=page.locator('.week-shell').bounding_box()
            assert all(a['left']>=shell['x'] and a['right']<=viewport['x']+1 for a in axis),'period axis outside horizontal scrolling'
            assert all(a['textLeft']>=a['left'] and a['textRight']<=a['right'] for a in axis),'whole period text inside fixed axis'
            assert [a['text'] for a in axis]==['1–2','3–4','5–6','7–8','9–10','11–12']
            page.screenshot(path=str(ROOT/'review'/'stress'/f'week-{width}-{position}.png'),full_page=True)
            stress.append({'viewport':width,'position':position,'horizontalScroll':value,'periodAxisVisible':True,'passed':True})

    # 长材料的上/中/下三个实际视口，用来检查查阅及关闭入口。
    page.set_viewport_size({'width':320,'height':844})
    page.goto((ROOT/by_id['56']['file']).as_uri())
    material_height=page.evaluate('document.documentElement.scrollHeight')
    for label,offset in [('top',0),('middle',material_height/2-422),('bottom',material_height)]:
        page.evaluate('(y)=>scrollTo(0,y)',offset)
        page.screenshot(path=str(ROOT/'review'/'stress'/f'material-320-{label}.png'))
    page.locator('a[href="#F5"]').click()
    assert '#F5' in page.url and '确认前不写' in page.locator('#F5').inner_text()
    page.screenshot(path=str(ROOT/'review'/'stress'/'material-320-F5.png'))

    # 用本轮截图生成宽幅目录，原图保持完整；它是评审导航，不导入 Figma。
    featured=['01','03','06','14','16','20','21','23','25','28','31','40']
    cells=''.join('<section><header>'+i+' · '+by_id[i]['title']+'</header><img src="'+(ROOT/'png'/(Path(by_id[i]['file']).stem+'.png')).as_uri()+'"></section>' for i in featured)
    board='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;background:#eee5df;color:#2b2422;font-family:"Microsoft YaHei",sans-serif;padding:48px}h1{font-size:36px;margin:0 0 12px}p{font-size:16px;margin:0 0 32px;color:#6b5d57}.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:24px}section{min-width:0}header{height:44px;font-size:13px;font-weight:600}img{width:100%;height:auto;display:block;box-shadow:0 5px 20px #2b242215}</style><h1>岭南校园工具 / 全流程 UI 提案</h1><p>'''+str(len(SCREENS))+''' 张画面 · 12 张代表稿一览 · 静态示例，未修改小程序实现 · 2026-10-16</p><div class="grid">'''+cells+'</div></html>'
    board_path=ARTIFACTS/'overview.html'
    board_path.write_text(board,encoding='utf-8')
    page.set_viewport_size({'width':1920,'height':1080})
    page.goto(board_path.as_uri())
    page.evaluate('document.fonts.ready')
    page.screenshot(path=str(ROOT/'review'/'overview.png'),full_page=True)
    browser.close()

def lum(h):
    rgb=[int(h[i:i+2],16)/255 for i in (1,3,5)]
    return sum(a*(v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4) for a,v in zip((.2126,.7152,.0722),rgb))
contrast=[]
for fg,bg in [('#ffffff','#c41c23'),('#ffffff','#8c1614'),('#6b5d57','#fdf7f5'),('#746760','#ffffff'),('#78420e','#fff4e4'),('#254d80','#e9eff6'),('#135b54','#e4f0ed')]:
    ratio=(max(lum(fg),lum(bg))+.05)/(min(lum(fg),lum(bg))+.05)
    contrast.append({'foreground':fg,'background':bg,'ratio':round(ratio,2),'normalText45':ratio>=4.5})
    if ratio<4.5: failures.append({'contrast':[fg,bg],'ratio':ratio})
# 同一组设计输入交给现有计算器，不用旧设计稿的手写总分作期望值。
fitness_input={'sex':'male','band':'freshman','height':175,'weight':61.3,'vitalCapacity':4300,'sprint50':7,'sitAndReach':17.7,'standingLongJump':248,'strength':15,'distanceRunSeconds':222}
calculator=json.loads(subprocess.check_output(['node','-e',"process.stdout.write(JSON.stringify(require('./dist/services/fitness/index.js').estimate("+json.dumps(fitness_input)+")))"],cwd=REPO,encoding='utf-8'))
fitness_screen=next(s for s in SCREENS if s['id']=='25')
displayed=next(b for b in fitness_screen['blocks'] if b['type']=='metric')
table=next(b for b in fitness_screen['blocks'] if b['type']=='table')
fitness_match=float(displayed['value'])==calculator['total'] and displayed['label']==calculator['grade'] and [int(r[-1]) for r in table['rows']]==[i['score'] for i in calculator['items']]
fitness_example={'input':fitness_input,'calculatorTotal':calculator['total'],'displayedTotal':displayed['value'],'itemScores':[i['score'] for i in calculator['items']],'passed':fitness_match}
if not fitness_match: failures.append({'fitnessExample':fitness_example})
report={'date':'2026-10-17','designScenarioDate':'2026-10-16','environment':'Windows Chrome headless / Playwright','mode':'static design only','screens':len(SCREENS),'viewports':[390,320],'renderChecks':results,'staticNavigation':paths,'weekScrolling':stress,'nonContinuousWeeks':{'notation':'2-6,8-17','selected':week_selected,'matchesParser':True},'materialF5Anchor':'passed','contrastSamples':contrast,'fitnessExample':fitness_example,'failures':failures,'notVerified':['微信客户端/真机','模型与云端行为','真实文件/图片上传与保存','剪贴板实际写入','全部Figma画面渲染及原型连线','读屏/键盘表单/200%文字缩放']}
(ROOT/'review'/'checks.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'screens':len(SCREENS),'renderScenarios':len(results),'staticPaths':len(paths),'contrastSamples':len(contrast),'failures':failures},ensure_ascii=False))
if failures: raise SystemExit(1)
