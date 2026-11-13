"""Build the static gallery and bind unchanged sources and screenshots to one version."""
from pathlib import Path
from PIL import Image
import json,hashlib,html
ROOT=Path(__file__).resolve().parent
REVIEW=ROOT/'review'
SCREENS=json.loads((ROOT/'screens.json').read_text(encoding='utf-8'))
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
groups=[('四个主入口',[1,2,11,19]),('导入、查课与通知调课',[3,76,68,79,4,75,69,66,5,6,7,8,9,70,10,71,72,39,73,51,74,67]),('目标与 AI 学习计划',[12,13,14,15,16,17,18,49,64,43,40,54,55]),('校园内容与问答',[20,21,65,22,23,24,25,28,29,30]),('体测',[26,27,63]),('项目讲解与答辩练习',[31,42,32,33,34,56,57,58,59,35,60,61,77,62,78]),('空、错误与未知时间',[36,37,38,52,53]),('暂缓模块附录',[44,45,46,47,48,50])]
byid={int(s['id']):s for s in SCREENS}
sections=[]
for title,ids in groups:
    cards=[]
    for id in ids:
        s=byid[id]; stem=Path(s['file']).stem
        cards.append(f'<article><div class="caption"><b>{id:02} · {html.escape(s["title"])}</b><span>{html.escape(s["state"])}</span></div><a href="../{s["file"]}"><img loading="lazy" src="../png/{stem}.png" alt="{html.escape(s["title"])}设计图"></a><div class="links"><a href="../{s["file"]}">浏览 HTML 分镜</a><a href="../png/{stem}.png">完整 PNG</a><a href="narrow/{stem}.png">320px 窄屏</a></div></article>')
    sections.append(f'<section><h2>{title}</h2><div class="grid">'+''.join(cards)+'</div></section>')
gallery='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>岭南红 · UI/UX 设计图册</title><style>*{box-sizing:border-box}body{margin:0;background:#f0f2f6;color:#2b2422;font:14px/1.7 -apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif}header{padding:48px max(24px,calc((100vw - 1500px)/2));background:#fff;border-top:6px solid #c41c23}h1{font-size:36px;letter-spacing:-1px;margin:8px 0 12px}header small{color:#c41c23;letter-spacing:2px}header p{max-width:800px;color:#6b5d57}main{max-width:1550px;padding:24px;margin:auto}section{margin:0 0 60px}h2{font-size:23px;margin:24px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:28px;align-items:start}article{min-width:0}.caption{padding:12px 0;min-height:72px}.caption b{font-size:14px}.caption span{display:block;color:#6b5d57;font-size:12px}img{display:block;width:100%;height:auto;border-radius:13px;border:1px solid #e0e2e7;box-shadow:0 8px 24px #22242b08}.links{display:flex;flex-wrap:wrap;gap:14px;margin:12px 0}a{color:#9e171d;text-decoration:none}a:hover{text-decoration:underline}.links a{min-height:44px;display:flex;align-items:center;font-size:12px}.quick{display:flex;gap:20px;flex-wrap:wrap}.quick a{min-height:44px;display:flex;align-items:center}footer{text-align:center;padding:40px;color:#6b5d57}@media(min-width:1500px){.grid{grid-template-columns:repeat(4,1fr)}}@media(max-width:600px){h1{font-size:28px}.grid{grid-template-columns:1fr}}</style><header><small>LINGNAN / DESIGN PROPOSAL / 2026.11.11</small><h1>让重要的安排，一眼就看见。</h1><p>岭南小栈 · 岭南红全量 UI/UX 重设计。74 张静态画面覆盖现有 22 个页面路径，以及两处聚合入口与四项底部导航提案。课程与案例使用虚构内容，学校与部门简介依据项目保存的公开资料；这是设计图，不是已部署的小程序截图。</p><div class="quick"><a href="overview.png">四个主入口总览</a><a href="../README.md">设计说明与任务路径</a><a href="checks.json">静态检查记录</a></div></header><main>'''+''.join(sections)+'''</main><footer>HTML 为尺寸与静态跳转示意 · PNG 为评审件 · 未实现真实输入、模型调用、保存与上下文持久化</footer></html>'''
gallery=gallery.replace('74 张静态画面',f'{len(SCREENS)} 张静态画面').replace('学校与部门简介依据项目保存的公开资料','学校、部门与政策事实依据项目保存的公开资料')
(REVIEW/'index.htm').write_text(gallery,encoding='utf-8')
sources=sorted([p for p in ROOT.iterdir() if p.suffix in ['.html','.css','.mjs','.py']]+[ROOT/'screens.json',REVIEW/'index.htm'])
source_entries=[{'file':p.relative_to(ROOT).as_posix(),'sha256':sha(p)} for p in sources]
images=[]
for p in sorted(list((ROOT/'png').glob('*.png'))+list(REVIEW.rglob('*.png'))):
    with Image.open(p) as im: size=list(im.size)
    if p.parent==ROOT/'png': viewport=390; typ='main'; sid=p.name[:2]
    elif p.parent.name=='narrow': viewport=320; typ='narrow full-page'; sid=p.name[:2]
    elif p.parent.name=='scroll': viewport=int(p.stem.split('-')[1]) if p.stem.startswith('week-') else int(p.stem.split('-')[1]);typ='scroll state';sid=p.name[:2]
    elif p.parent.name=='details': viewport=int(p.stem.split('-')[-1]);typ='element render at DPR3';sid=p.stem.split('-')[1]
    else: viewport=None;typ='contact sheet';sid=None
    images.append({'file':p.relative_to(ROOT).as_posix(),'sha256':sha(p),'pixelSize':size,'viewportWidth':viewport,'type':typ,'screenId':sid,'data':'fictional scenario 2026-11-11; school/department records 2026-09-17/18, policy record 2026-10-03; not refreshed live'})
version=hashlib.sha256(json.dumps({'sources':source_entries,'images':images},sort_keys=True).encode()).hexdigest()
manifest={'version':'LN-'+version[:16],'contentFingerprintSHA256':version,'scope':f'{len(SCREENS)} static screens, all 22 registered routes plus proposed study/campus hubs; no motion requirement','sources':source_entries,'images':images,'checksSHA256':sha(REVIEW/'checks.json')}
(REVIEW/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'version':manifest['version'],'sources':len(source_entries),'images':len(images)},ensure_ascii=False))
