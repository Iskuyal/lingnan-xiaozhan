import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const names = ['today','week','import','review','course','settings','manage','assistant','notice','changed','study','goals','goal-edit','plan-input','constraints','preview','saved','conflict','campus','departments','department','department-qa','news','article','calendar','fitness','fitness-result','advancement','clarify','answer','defense','practice','pending','feedback','recap','empty','read-error','import-error','partial-change','expired-plan','delete','material','ai-unavailable','lost-found','publish','item','claim','mine','basic-rules','claim-review','full-week','field-error','unknown-times','goal-delete','goals-empty','practice-2','feedback-2','practice-3','feedback-3','reanswer','reanswer-result','exit','fitness-missing','constraint-clarify','department-answer','course-detail','day-agenda','draft-edit','import-ready','notice-edit','week-eleven','undo-result','batch-result','long-course'];
names.push('photo-source','excel-review','practice-record','copied-record','review-other-course');
const file = id => `${String(id).padStart(2,'0')}-${names[id-1]}.html`;
const paths = {
  home:'M3 10 12 3l9 7M5 9v12h5v-7h4v7h5V9', calendar:'M4 5h16v16H4zM7 3v4M17 3v4M4 10h16M8 14h2M14 14h2M8 18h2',
  book:'M3 4c4-1 7 0 9 2v15c-2-2-5-3-9-2ZM21 4c-4-1-7 0-9 2v15c2-2 5-3 9-2Z',
  campus:'M3 21h18M5 21V10l7-5 7 5v11M9 21v-7h6v7M3 10l9-7 9 7',
  arrow:'M5 12h14M13 6l6 6-6 6', back:'m14 6-6 6 6 6', down:'m6 9 6 6 6-6',
  plus:'M12 5v14M5 12h14', check:'m5 12 4 4L19 6', close:'m6 6 12 12M6 18 18 6',
  settings:'M9 3h6l1 4 4 1v8l-4 1-1 4H9l-1-4-4-1V8l4-1Z M15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0',
  spark:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
  photo:'M3 7h4l2-3h6l2 3h4v13H3ZM16 13a4 4 0 1 0-8 0 4 4 0 0 0 8 0',
  upload:'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6',
  file:'M5 3h9l5 5v13H5ZM14 3v6h5M8 13h8M8 17h5',
  news:'M4 4h16v17H4ZM7 8h10M7 12h4M7 16h4M14 12h3v5h-3Z',
  people:'M16 7a4 4 0 1 0-8 0 4 4 0 0 0 8 0M5 21v-3a7 7 0 0 1 14 0v3M20 5a3 3 0 0 1 0 6M21 15v6',
  flag:'M5 21V3m0 0c4-3 8 3 14 0v10c-6 3-10-3-14 0',
  chat:'M3 4h18v13H9l-6 4ZM7 8h10M7 12h6',
  search:'M16.5 10a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Zm-1.5 5 6 6',
  clock:'M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0M12 7v5l3 2',
  shield:'M12 3 3 6v6c0 5 9 9 9 9s9-4 9-9V6ZM8 12l3 3 5-6',
  edit:'m14 4 6 6M4 20l1-6L16 3l5 5L10 19ZM4 20l6-1',
  heart:'M3 12h4l2-6 5 13 3-7h4',
  link:'m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m4 2 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
  warning:'m12 3 10 18H2ZM12 9v5M12 17v1',
  refresh:'M20 11a8 8 0 1 0-2 7M20 4v7h-7',
  brand:'M4 20V8l8-5 8 5v12M8 20V10l4-3 4 3v10M3 20h18',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]??paths.spark}"/></svg>`;
const A = (id,text,cls='btn primary',extra='') => `<a class="${cls}" href="${file(id)}" ${extra}>${text}</a>`;
const tag = (text,cls='') => `<span class="tag ${cls}">${text}</span>`;
const head = (title,id,text='查看全部') => `<div class="section-head"><h2>${title}</h2>${id?A(id,`${text}${icon('arrow')}`,'text-link'):''}</div>`;
const card = (html,cls='') => `<div class="card ${cls}">${html}</div>`;
const notice = (text,cls='info') => `<div class="notice ${cls}">${text}</div>`;
const field = (label,value,cls='',hint='',id='') => {const select=value.includes('⌄');return `<div class="field"${id?` id="${id}"`:''}><div class="label">${label}</div><div class="fieldbox ${cls} ${select?'select-box':''}">${select?`<span>${value.replace('⌄','').trim()}</span>${icon('down')}`:value}</div>${hint?`<div class="field-hint">${hint}</div>`:''}</div>`;};
const kv = (k,v) => `<div class="kv"><span class="key">${k}</span><span class="val">${v}</span></div>`;
const actions = (...buttons) => `<div class="actions">${buttons.join('')}</div>`;
const item = (id,ic,title,sub='',cls='') => A(id,`<div class="icon-box ${cls}">${icon(ic)}</div><div class="grow"><div class="item-title">${title}</div>${sub?`<div class="item-sub">${sub}</div>`:''}</div><span class="chev">›</span>`,'list-item');
const steps = (current,labels=['选择文件','核对课程','保存课表']) => `<div class="steps">${labels.map((x,i)=>`${i?'<span class="step-line"></span>':''}<span class="step ${i===current?'on':''}"><i>${i+1}</i>${x}</span>`).join('')}</div>`;
const source = text => `<div class="source">${text}</div>`;
const planItems = () => `<p class="window-note">节次为可用窗口，具体起点未定。</p>`+[ ['13','周五','听力 · 精听与复述','第 1–2 节内'],['14','周六','听力 · 句子听写','第 5–6 节内'],['15','周日','听力 · 错题回听','第 5–6 节内'] ].map(([d,w,t,s])=>`<div class="plan-item"><div class="plan-date">${w}<strong>${d}</strong></div><div class="grow"><h3>${t}</h3><div class="plan-window"><span>${s}</span><span>学习 30 分钟</span></div></div></div>`).join('');
const stats = () => `<div class="plan-stat"><div><strong class="num">3<span>次</span></strong><p>本周安排</p></div><div><strong class="num">90<span>分钟</span></strong><p>总学习时长</p></div><div><strong class="num">0</strong><p>已知冲突</p></div></div>`;
const importRows = [['高等数学','周一 3–4 节 · C203'],['Java 程序设计','周一 5–6 节 · B604'],['专业实践','周二 7–8 节 · 实训楼'],['Java 程序设计','周三 3–4 节 · B604'],['数据库原理','周三 5–6 节 · A302'],['大学体育','周三 7–8 节 · 体育馆'],['高等数学','周四 5–6 节 · C203'],['大学英语','周五 3–4 节 · A405'],['英语听说','周五 7–8 节 · A302']];
const importSummary = (withSource=false) => `<p class="field-hint" style="margin:8px 0">点“修正”可重新核对任意一条。</p>`+card(importRows.map(([n,t],i)=>`<div class="import-summary"><div class="grow"><h3>${n}</h3><p class="item-sub">${t}</p></div>${A(n==='英语听说'?79:68,'修正','row-edit',`aria-label="重新核对${n}"`)}</div>${withSource&&i===4?`<details class="inline-source"><summary>对照数据库原理的原单元格</summary>${sourceFragment('Excel')}${A(68,'打开这条草稿','text-link')}</details>`:''}`).join(''));
const replacementDock = (back=75) => `<div class="replace-warning"><b>本次会替换当前整份课表</b><span>已有课程和手工修改都会被替换。</span></div><div class="dock-actions">${A(2,'确认替换整份课表')}${A(back,'继续核对','btn secondary')}</div>`;
const sourceFragment = (kind='Excel',data={course:'数据库原理',slot:'周三<br>5–6 节',place:'A302',cell:'C8'}) => `<div class="source-fragment"><div class="source-fragment-head">${kind==='Excel'?`示例课表.xlsx · 工作表1 · ${data.cell}`:'课表截图.png · 疑点裁片示意'}</div><table><thead><tr><th>课程</th><th>上课</th><th>地点</th></tr></thead><tbody><tr><td>${data.course}</td><td>${data.slot}</td><td class="source-value">${data.place}</td></tr></tbody></table><p>虚构原材料示例 · 不是实际上传的文件或图片</p></div>`;
const pages=[];
function screen(id,title,route,body,{tab='',back=1,white=false,dormant=false,state='常规',proposed=false,top='',kind='任务页',dock='',compact=false}={}) {
  const tabs = [['home','今天',1],['calendar','课表',2],['book','学习',11],['campus','校园',19]];
  const nav = tab==='今天' ? `<span class="brand-mark">${icon('brand')}</span><span class="brand-name grow">岭南小栈</span>` : `${tab?'':A(back,icon('back'),'nav-back','aria-label="返回上一步"')}<span class="nav-title">${title}</span>`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · 岭南小栈设计稿</title><link rel="stylesheet" href="_mockup.css"></head><body><div class="app ${tab?'with-tabs':''} ${white?'white':''}"><div class="status"><span>9:41</span><div class="signals"><span>▴▴▴</span><span>◔</span><span class="battery"></span></div></div><div class="nav">${nav}<div class="capsule" aria-hidden="true"><b>•••</b><span class="sep"></span><span class="circle"></span></div></div>${dormant?'<div class="dormant">暂缓模块设计附录 · 不新增正式入口</div>':''}${top}<main class="content">${body}</main><div class="provenance">静态设计稿 · 演示内容，非实际运行截图${proposed?' · 导航待实现':''}</div>${tab?`<nav class="tabbar" aria-label="主导航方案">${tabs.map(([ic,label,target])=>A(target,`${icon(ic)}<span>${label}</span>`,`${tab===label?'on':''}`)).join('')}</nav>`:''}</div></body></html>`;
  const rendered = html.replace('class="app ',`class="app ${dock?'with-dock ':''}${compact?'compact-task ':''}`).replace('<div class="provenance">',`${dock?`<div class="dock">${dock}</div>`:''}<div class="provenance">`).replaceAll('（静态示意）','').replaceAll('（静态确认示意）','');
  writeFileSync(join(root,file(id)),rendered);
  pages.push({id:String(id).padStart(2,'0'),file:file(id),title,route,state,kind,proposed,dormant});
}

screen(1,'今天','pages/home/index',`
  <div class="home-intro"><div><div class="kicker">11 月 11 日，星期三 · 示例</div><h1>上午好，<br>把今天安排好。</h1></div><div class="date-tile"><span>NOV</span><strong class="num">11</strong></div></div>
  <section class="next-class"><div class="row between"><span class="small">下一节课</span>${tag('第 3–4 节','outline')}</div><div class="hero-time num">10:10 <span style="font-size:15px;font-weight:400">— 11:45</span></div><h2 class="hero-title">Java 程序设计</h2><p class="hero-meta">博雅楼 B604 · 示例教师</p><div class="hero-foot"><span class="tiny">时刻来自已填写的作息</span>${A(66,`课程详情 ${icon('arrow')}`,'')}</div></section>
  <div class="quick-grid">${[['spark','问课表',8],['photo','导入课表',3],['flag','目标日',12],['news','校园资讯',23]].map(([ic,t,id])=>A(id,`<span class="icon-box">${icon(ic)}</span><span>${t}</span>`,'')).join('')}</div>
  ${head('今天的安排',2,'看课表')}
  ${card(`<div class="daily-row"><div class="time">10:10<small>第 3–4 节</small></div><div class="track"></div><div class="grow"><h3>Java 程序设计</h3><div class="item-sub">博雅楼 B604</div></div>${tag('下一节','red')}</div><div class="daily-row"><div class="time">14:00<small>第 5–6 节</small></div><div class="track blue"></div><div class="grow"><h3>数据库原理</h3><div class="item-sub">博雅楼 A302</div></div></div><div class="daily-row"><div class="time">16:00<small>第 7–8 节</small></div><div class="track green"></div><div class="grow"><h3>大学体育</h3><div class="item-sub">综合体育馆</div></div></div>`)}
  ${head('继续你的计划',17,'本周计划')}
  <div class="study-strip"><span class="strip-mark"></span><div class="grow"><h3>英语听力，周五见</h3><p class="item-sub">本周 3 次 · 已保存在本机</p></div>${A(17,'查看','strip-action')}</div>
`,{tab:'今天',kind:'入口页',proposed:true});

const grid = (full=false,changed=false) => {
  // The period axis is a separate column; result frames initially show the changed Friday.
  let html=['一 9','二 10','三 11','四 12','五 13','六 14','日 15'].map((x,i)=>`<div class="day ${!changed&&i===2?'today':''}">${x}${!changed&&i===2?'<span class="day-state">今天</span>':''}</div>`).join('');
  let positions={ '0-0':['高等数学','C203','blue'],'0-2':['Java 程序设计','B604',''],'0-4':['大学英语','A405','lilac'],'1-0':['Java 程序设计','B604',''],'1-2':['数据库原理','A302','blue'],'1-3':['高等数学','C203','blue'],'2-1':['专业实践','实训楼','green'],'2-2':['大学体育','体育馆','green'],'2-4':['英语听说','A302','lilac'] };
  if(changed){ delete positions['0-2'];positions['1-4']=['Java 程序设计','A302','']; }
  if(full){
    positions=Object.fromEntries(Object.entries(positions).map(([k,v])=>{const [r,d]=k.split('-');return [`${Number(r)+1}-${d}`,v];}));
    Object.assign(positions,{'0-0':['移动应用开发与专业综合实践','B1204','blue'],'4-5':['大学生创新创业基础与项目实践','A503','green'],'4-6':['英语听力与跨文化沟通','A302','lilac'],'5-5':['项目设计与展示','C204','']});
  }
  const labels=full?['1–2','3–4','5–6','7–8','9–10','11–12']:['3–4','5–6','7–8'];
  for(let r=0;r<labels.length;r++){for(let d=0;d<7;d++){const c=positions[`${r}-${d}`],isChanged=changed&&r===1&&d===4;html+=`<div class="cell">${c?A(c[0].includes('专业综合')?74:66,`${isChanged?'<span class="course-flag">本次调整</span>':''}<span class="course-name">${c[0]}</span><span class="course-room">${c[1]}</span>`,'course '+c[2]+(isChanged?' changed':''),`title="${c[0]} · ${c[1]}"`):''}</div>`;}}
  return `<div class="week-shell"><div class="period-axis"><div class="axis day">节次</div>${labels.map(x=>`<div class="axis">${x}</div>`).join('')}</div><div class="week-scroll ${changed?'result-focused':''}"><div class="week-grid">${html}</div></div></div>`;
};
screen(2,'我的课表','pages/timetable/index',`
  <div class="row between"><div class="kicker">2026–2027 学年 · 第一学期</div>${A(7,'管理','text-link')}</div>
  <div class="week-control"><div class="week-nav">${A(2,icon('back'),'icon-button','aria-label="上一周（静态示意）"')}<span class="week-title">第 10 周</span>${A(2,icon('arrow'),'icon-button','aria-label="下一周（静态示意）"')}</div>${A(8,'问课表','chip on')}</div>
  <div class="row between range-header"><span class="kicker">11/9 — 11/15</span>${A(51,'3–8 节 · 看完整12节 ›','text-link')}</div>
  <div class="seg">${A(2,'周课表','on')}${A(67,'每日安排','')}</div><div class="space-sm"></div>
  ${grid()}<p class="field-hint">横向滑动看完整一周 · 当前第 3–8 节</p>
  ${A(8,`<span class="ai-orb">${icon('spark')}</span><div class="grow"><div class="item-title">课表助手</div><div class="item-sub">问课程，或贴通知调整安排</div></div>${icon('arrow')}`,'assistant-entry')}
  ${head('独立学习计划',17,'查看')}${card(`<div class="row between"><h3>英语听力</h3>${tag('本机计划')}</div><p class="item-sub">周五 1–2 节 · 周六、周日 5–6 节</p>${source('共 3 次，每次 30 分钟 · 与正式课程分开展示')}`)}
`,{tab:'课表',kind:'周课表',proposed:true});

screen(3,'导入课表','pages/timetable/import/index',`
  ${steps(0)}<h1>把课表带进来。</h1><p class="intro">选择文件或截图，核对后再保存。<br>不用绑定教务账号。</p>
  ${A(76,`<div class="upload-icon">${icon('file')}</div><div class="grow"><h3>从微信聊天选择 Excel</h3><p class="item-sub">支持 .xls、.xlsx 课表文件</p></div>${icon('arrow')}`,'choice-card featured')}
  ${A(4,`<div class="upload-icon">${icon('photo')}</div><div class="grow"><h3>拍照或选择截图</h3><p class="item-sub">AI 识别，逐项核对课程</p></div>${icon('arrow')}`,'choice-card')}
  ${head('Excel 怎么准备？')}${card(`<div class="stack"><p><b class="red">01</b>　在教务系统下载自己的课表</p><p><b class="red">02</b>　发送给微信「文件传输助手」</p><p><b class="red">03</b>　回到这里，从聊天记录选择</p></div>`)}
  <div class="space"></div>${notice('保存前都会显示核对页；重新导入会替换整份已保存课表，包括手工修改。')}
  ${actions(A(5,'手工添加课程','btn secondary'))}
`,{back:2});

screen(4,'核对导入结果','pages/timetable/import/index',`
  ${steps(1)}<div class="row between"><h1>先核对，再保存。</h1>${tag('草稿','amber')}</div><p class="intro">课表截图.png · 9 条安排，涉及 7 门课程</p>
  ${notice('<b>还有 1 处地点待核对</b><br>修正或确认后再保存；草稿尚未写入。')}
  <div class="space-sm"></div>${card(`<div class="row between"><div class="grow"><h3>Java 程序设计</h3><p class="item-sub">周三 3–4 节 · B604 · 第 1–16 周</p></div>${tag('已核对','green')}</div>`)}
  ${card(`<div class="row between"><h3>数据库原理</h3>${tag('待核对','amber')}</div><p class="item-sub">周三 5–6 节 · 第 1–16 周</p>${kv('识别地点','博雅楼 A3O2')}${notice('截图中的 O / 0 不清楚，请对照原图。')}${A(75,'对照截图，核对地点','text-link')}`)}
  ${card(`<div class="row between"><div class="grow"><h3>大学体育</h3><p class="item-sub">周三 7–8 节 · 体育馆 · 第 1–16 周</p></div>${tag('已核对','green')}</div>`)}
  <details class="more-courses"><summary>展开其余 6 条，逐条重新核对</summary><div class="list">${[0,1,2,6,7,8].map(i=>`<div class="import-summary"><div class="grow"><h3>${importRows[i][0]}</h3><p class="item-sub">${importRows[i][1]}</p></div>${A(i===8?79:68,'修正','row-edit')}</div>`).join('')}</div></details>
`,{back:3,state:'解析草稿与替换确认',compact:true,dock:`<p class="dock-note">还有 1 处待核对，暂不替换保存。</p>${A(75,'先核对这处地点')}${A(3,'放弃草稿，重新选择','text-link')}`});

screen(5,'课程详情与编辑','pages/timetable/edit/index',`
  <div class="eyebrow">课程编辑 · 示例</div><h1 style="margin-top:8px">Java 程序设计</h1><p class="intro">修改自己的课表记录，保存后才会生效。</p>
  ${field('课程名称','Java 程序设计','','','course-name')}${field('教师（选填）','示例教师')}
  <div class="field-pair">${field('星期','星期三　⌄')}${field('节次','第 3–4 节　⌄')}</div>
  ${field('上课地点','博雅楼 B604')}
  <div class="field" id="course-weeks"><div class="label">上课周次 · 支持不连续选择</div><div class="week-picker">${Array.from({length:18},(_,i)=>`<span class="chip ${i<16?'on':''}">${i+1}</span>`).join('')}</div><p class="field-hint">已选第 1–16 周；可单独取消某一周。</p></div>
  ${actions(A(2,'保存课程'),A(41,'删除这门课','btn secondary'))}
`,{back:2});

screen(6,'学期与作息','pages/timetable/settings/index',`
  <h1>让时间对得上。</h1><p class="intro">学期决定周次，作息决定具体上课时刻。<br>示例值由用户填写，不代表学校官方作息。</p>
  ${card(`<h2>学期</h2>${field('学期名称','2026–2027 学年第一学期')}${field('第 1 周的星期一','2026 年 9 月 7 日　⌄')}${field('学期总周数','18 周　⌄')}`)}
  ${card(`<div class="row between"><h2>作息时间</h2>${tag('选填')}</div><p class="item-sub">点时刻选择或修改；未填的节次不推算钟点。</p><div class="time-heading"><span>节次</span><span>开始</span><span>结束</span></div>${[['第1节','选择时刻','选择时刻'],['第2节','选择时刻','选择时刻'],['第3节','10:10','10:55'],['第4节','11:00','11:45']].map(([s,a,b])=>`<div class="time-setting"><span>${s}</span>${A(6,`<span>${a}</span>${icon('down')}`,'time-input',`aria-label="设置${s}开始时刻"`)}${A(6,`<span>${b}</span>${icon('down')}`,'time-input',`aria-label="设置${s}结束时刻"`)}</div>`).join('')}${A(6,'展开其余节次','text-link')}`)}
  ${actions(A(2,'保存设置'))}
`,{back:2});

screen(7,'管理课程','pages/timetable/manage/index',`
  <div class="row between"><div><h1>我的课程</h1><p class="item-sub">示例列表 · 展示其中 3 门课程</p></div>${A(5,icon('plus'),'icon-button','aria-label="添加课程"')}</div>
  <div class="space"></div><div class="list">${item(5,'book','Java 程序设计','周三 3–4 节 · 第 1–16 周')}${item(5,'book','数据库原理','周三 5–6 节 · 第 1–16 周')}${item(5,'heart','大学体育','周三 7–8 节 · 第 1–16 周')}</div>
  ${head('课表设置')}<div class="list">${item(3,'upload','重新导入课表','核对后替换整份课表')}${item(6,'clock','学期与作息','设置第 1 周和节次时刻')}</div>
`,{back:2});

screen(8,'课表助手','pages/timetable/index#assistant',`
  <div class="eyebrow">${icon('spark')} 课表助手</div><h1 style="margin-top:14px">课表里的事，<br>直接问。</h1><p class="intro">查课程、贴调课通知，或描述要修改什么。<br>修改都先给你核对。</p>
  <div class="chip-row">${A(8,'周五有哪些课？','chip')}${A(9,'粘贴一段调课通知','chip')}${A(8,'这周哪天有空？','chip')}</div>
  <div class="message user">周三上午有什么课？</div><div class="message"><div class="byline"><span class="brand-mark">${icon('spark')}</span>课表查询 · 示例结果</div><p>第 3–4 节有 <b>Java 程序设计</b>，在博雅楼 B604。</p>${source('依据：你已保存的课表 · 当前第 10 周')}${A(66,'查看课程详情','text-link')}</div>
  <div class="space"></div><div class="composer"><span class="grow muted">输入问题或粘贴通知…</span>${A(9,icon('arrow'),'send','aria-label="查看通知草稿示例"')}</div><p class="field-hint">本页是静态分镜；示例结果未调用 AI。</p>
`,{back:2,kind:'对话与查询结果'});

screen(9,'核对调课','pages/timetable/index#proposal',`
  ${steps(1,['粘贴通知','核对改动','确认保存'])}<div class="row between"><h1>只改通知说的周。</h1>${tag('待确认','amber')}</div><p class="intro">已整理 1 项修改，请对照原通知核对。</p>
  <div class="quote">“第 11 周周三 3–4 节 Java 程序设计调到周五 5–6 节，地点改为博雅楼 A302，其余周次不变。”</div>
  <div class="space"></div>${card(`<div class="row between"><h2>Java 程序设计</h2>${tag('仅第 11 周','red')}</div><div class="change-diff"><div><div class="tiny muted">原安排</div><b>周三 3–4 节</b><div class="small muted">博雅楼 B604</div></div><span>→</span><div><div class="tiny">新安排</div><b>周五 5–6 节</b><div class="small">博雅楼 A302</div></div></div>${kv('生效范围','仅第 11 周')}${kv('其余周次','第 1–10、12–16 周保持原样')}${notice('只修改你的个人课表；不会更改教务系统。','info')}`)}
  ${actions(A(10,'确认修改第 11 周'),A(70,'修改原通知，重新识别','btn secondary'),A(8,'取消，返回助手','text-link'))}
`,{back:8,state:'限定周次提案'});

screen(10,'调课已保存','pages/timetable/index#applied',`
  <div class="result-icon">${icon('check')}</div><h1>第 11 周，已调整。</h1><p class="intro">Java 程序设计的新安排已保存。</p>
  ${card(`<div class="eyebrow">第 11 周 · 11 月 20 日</div><h2 style="margin-top:12px">周五，第 5–6 节</h2><p class="item-sub">博雅楼 A302</p>${source('其余周次保留原安排：周三 3–4 节 · 博雅楼 B604')}`)}
  <div class="space"></div>${notice('这次修改仍可撤销。示例：剩余 8 秒。','success')}${actions(A(71,'查看第 11 周课表'),A(72,'撤销这次修改','btn secondary'))}
`,{back:8,state:'保存成功与撤销'});

screen(11,'学习','提案：pages/study/index',`<div class="study-overview">
  <h1>学习，也有好安排。</h1><p class="intro">目标、计划与日常练习，都在这里。</p>
  <div class="goal-hero compact"><div class="row between"><h3>英语考试 · 示例</h3>${tag('12 月 19 日','outline')}</div><div class="row between" style="margin-top:8px"><div class="count num">38<span>天后</span></div><span class="small">本周 3 次学习</span></div>${A(17,`继续查看本周计划 ${icon('arrow')}`,'hero-link')}</div>
  ${head('学习工具')}<div class="list">${item(12,'flag','目标日与学习计划','管理目标与本周安排')}${item(31,'chat','项目讲解与答辩练习','三轮练习，一次复盘')}${item(28,'book','升学与实习问答','依据已收录的官方原文')}${item(26,'heart','体测估算','国家标准参考 · 本机计算')}</div></div>
`,{tab:'学习',proposed:true,kind:'学习入口'});

screen(12,'目标日','pages/goals/index',`
  <div class="row between"><div><h1>每个目标，<br>都有准备的时间。</h1></div>${A(13,icon('plus'),'icon-button','aria-label="新建目标日"')}</div><p class="intro">只保存在这台设备，无需填写个人账号。</p>
  <div class="goal-hero"><p class="small">下一个目标 · 示例</p><h2 style="margin-top:8px">英语考试</h2><div class="count num">38<span>天后 · 12 月 19 日</span></div>${A(14,`为这个目标安排学习 ${icon('arrow')}`,'hero-link')}</div>
  <div class="space-sm"></div>${card(`<div class="row between"><div><h3>英语听力 · 本周计划</h3><p class="item-sub">11 月 9 日 — 15 日 · 共 3 次</p></div>${tag('已保存','green')}</div>${A(17,'重新打开计划','text-link')}`)}
  ${head('管理目标')}<div class="list">${item(13,'edit','修改目标日期与名称','英语考试 · 2026 年 12 月 19 日')}</div>
`,{back:11});

screen(13,'编辑目标日','pages/goals/edit/index',`
  <h1>给目标一个日期。</h1><p class="intro">这是你自己的计划日期，可以随时修改。</p>
  ${field('目标名称','英语考试')}${field('目标日期','2026 年 12 月 19 日　⌄')}${field('备注（选填）','重点准备英语听力')}
  ${notice('只存本机；删除或修改目标后，已经保存的计划会保留原快照并提示变化。')}
  ${actions(A(12,'保存目标日'),A(54,'删除目标日','btn secondary'))}
`,{back:12});

screen(14,'安排学习计划','pages/goals/plan/index',`
  ${steps(0,['说说情况','核对约束','预览计划'])}<div class="eyebrow">英语考试 · 12 月 19 日</div><h1 style="margin-top:10px">这一周，<br>你想怎么学？</h1><p class="intro">说说空闲时间和薄弱项。AI 整理后，<br>你先核对，我们再安排时段。</p>
  ${field('你的情况','我周四没空，周末上午有兼职，每次半小时，听力总拖后腿，一周安排三回。','textarea')}
  <div class="row between"><span class="small muted">只发送目标名称和这段情况</span>${tag('课表不发送')}</div>
  ${actions(A(15,`${icon('spark')} 整理我的学习约束`))}
  ${notice('识别结果先给你核对，不会直接创建或保存计划。','info')}
  ${head('也可以直接设置')}<div class="list">${item(49,'settings','用基础规则安排','手动选择时长、频率和可用时段')}</div>
`,{back:12,state:'自然语言输入'});

screen(15,'核对学习约束','pages/goals/plan/index#constraints',`
  ${steps(1,['说说情况','核对约束','预览计划'])}<div class="row between"><h1>这是你的意思吗？</h1>${tag('AI 草稿','amber')}</div><p class="intro">每条都附上你的原话。核对后，<br>再结合课表安排本周时段。</p>
  ${card([
    ['每次 30 分钟','每次半小时'],['每周 3 次','一周安排三回'],['重点练习：听力','听力总拖后腿'],['周四不安排','我周四没空'],['周末上午不安排','周末上午有兼职']
  ].map(([title,quote],index)=>`<div class="constraint"><div class="row"><span class="check-circle draft">${index+1}</span><h3 class="grow">${title}</h3>${A(14,'修改','edit')}</div><p class="evidence">“${quote}”</p></div>`).join(''))}
`,{back:14,state:'带原话依据的约束草稿',compact:true,dock:`${A(16,'确认这些约束，生成预览')}${A(14,'返回修改情况','text-link')}<p class="dock-note">只生成预览，不会保存或改动正式课程。</p>`});

screen(16,'预览学习计划','pages/goals/plan/index#preview',`
  ${steps(2,['说说情况','核对约束','预览计划'])}<div class="row between"><h1>这一周，这样安排。</h1>${tag('未保存','amber')}</div><p class="intro">英语听力 · 11 月 9 日 — 15 日</p>
  ${card(`${stats()}<div class="divider" style="margin-top:0"></div><div class="row small green">${icon('check')}已检查已知课程与不可用时段</div>`)}
  ${head('3 次听力练习')}${card(planItems())}
  <div class="space"></div>${notice('排在所示节次内，每次学习 30 分钟。未填写作息，不推算具体钟点。只保存本机计划，不加入正式课程。','info')}
`,{back:15,state:'规则排程预览',compact:true,dock:`<p class="dock-note">只保存本机计划，不加入正式课程。</p>${A(17,'保存这份计划')}<div class="row between">${A(16,'换一个安排','text-link')}${A(15,'重新核对约束','text-link')}</div>`});

screen(17,'本周学习计划','pages/goals/plan/index#saved',`
  <div class="row between"><div class="eyebrow">${icon('shield')} 已保存在本机</div>${tag('离线可查看','green')}</div><h1 style="margin-top:15px">给听力，留好时间。</h1><p class="intro">英语考试 · 11 月 9 日 — 15 日</p>
  ${card(`${stats()}${planItems()}`)}
  ${head('这份计划的依据')}${card(`${kv('约束来源','AI 整理，经你确认')}${kv('每次 / 每周','30 分钟 / 3 次')}${kv('避开','周四、周末上午')}${source('按保存时的课表检查 · 重新打开会提示新发现的冲突')}`)}
  ${actions(A(2,'去课表查看本周安排','btn secondary'),A(14,'重新生成计划','text-link'))}
`,{back:12,state:'已保存与离线重开'});

screen(18,'计划需要核对','pages/goals/plan/index#conflict',`
  <div class="eyebrow">已保存计划 · 课表有变化</div><h1 style="margin-top:12px">有一处时间撞上了。</h1><p class="intro">原计划仍在，没有自动改动。</p>
  ${notice('<b>周五第 1–2 节与新课程冲突</b><br>请核对后决定是否重新生成。')}
  <div class="space"></div>${card(`<div class="row between"><h3>听力 · 精听与复述</h3>${tag('冲突','red')}</div>${kv('原计划','周五第 1–2 节 · 30 分钟')}${kv('新增课程','高等数学 · 第 1–2 节')}${source('11 月 13 日 · 当前课表检查结果')}`)}
  ${card(`<h3>另外 2 次练习</h3><p class="item-sub">周六、周日第 5–6 节<br>未发现已知课程冲突</p>`)}
  ${actions(A(14,'按最新课表重新生成'),A(17,'先保留这份计划','btn secondary'))}
`,{back:17,state:'课表变化后的冲突'});

screen(19,'校园','提案：pages/campus/index',`
  <div class="home-intro"><div><div class="eyebrow">在岭南，发现日常。</div><h1 style="margin-top:10px">校园里的事。</h1></div><span class="brand-mark" style="padding:12px;background:white;border-radius:16px">${icon('campus')}</span></div>
  <div class="campus-head"><div class="campus-monogram">${icon('brand')}</div><div class="grow"><h3>广东岭南职业技术学院</h3><p class="item-sub">校园资料与日常工具</p><p class="tiny muted">学生参赛作品 · 非学校官方应用</p></div></div>
  ${head('先找到你需要的')}<div class="tool-pair">${A(20,`<span class="icon-box">${icon('people')}</span><h3>学生部门</h3><p class="item-sub">认识组织，依据资料提问</p>`,'tool-tile')}${A(25,`<span class="icon-box">${icon('calendar')}</span><h3>校历与考试</h3><p class="item-sub">日期、适用范围与出处</p>`,'tool-tile')}</div>
  ${head('校园资讯',23,'全部资讯')}${card(`<span class="tag">示例资讯</span><h2 style="margin-top:12px">把课堂所学，带进实践现场</h2><p class="item-sub">此处展示资讯卡片排版，不是实际新闻。</p>${A(24,'阅读全文','text-link')}${source('来源位置 · 发布日期位置')}`)}
  ${head('认识岭南')}${card(`<p class="muted">学校设广州、清远两个校区，专业覆盖大健康、电子信息、智能制造、财经商贸与文化艺术等领域。</p>${source('依据项目保存的学校官网简介 · 核查于 2026-09-17<br>不是本轮重新核查的最新信息。')}${A(19,'复制学校官网链接（静态示意）','text-link')}`)}
`,{tab:'校园',proposed:true,kind:'校园入口'});

// Remaining task pages are generated below with the same component language.
screen(20,'学生部门','pages/departments/index',`
  <h1>在这里，<br>找到同路的人。</h1><p class="intro">浏览项目已保存的公开组织资料，<br>了解职责，也可以依据资料提问。</p>
  ${A(22,`<span class="ai-orb">${icon('chat')}</span><div class="grow"><h3>不确定找哪个部门？</h3><p class="item-sub">问问部门，先找到资料中的答案</p></div>${icon('arrow')}`,'assistant-entry')}
  ${head('已收录组织 · 节选')}<div class="list">${item(21,'people','校学生会','组织与部门 · 官网未标注校区')}${item(21,'flag','校学生团委','组织介绍 · 官网未标注校区')}${item(21,'book','校学生社团管理部','组织介绍与部门资料')}</div>
  ${source('学校官网 · 团委 · 学生组织<br>项目资料核查于 2026-09-18，本轮未重新联网核查。')}
`,{back:19});

screen(21,'组织资料','pages/departments/detail/index',`
  <div class="row"><span class="dept-symbol">学</span><div><h1>校学生会</h1><p class="item-sub">学校官网保存资料 · 2026-09-18</p></div></div>
  <div class="space"></div>${notice('适用校区以原资料标注为准；未标注时不推断。','info')}
  ${head('组织介绍')}${card(`<p>校学生会联系和服务同学。保存的官网资料采用“主席团 + 工作部门”的组织架构，列出五个工作部门。</p>`)}
  ${head('下设部门')}${card(`<div class="chip-row">${['权益部','文娱部','器材部','体育部','学创部'].map(x=>`<span class="tag">${x}</span>`).join('')}</div><p class="item-sub">资料列出部门名称；未逐项说明职责的部分不作推断。</p>${A(65,'依据这些资料提问','text-link')}`)}
  ${head('联系与动态')}${card(`${kv('公开联系方式','保存资料未提供')}${kv('最新招新安排','当前收录范围内无法确认')}${source('学校官网 · 团委 · 学生组织<br>资料核查 2026-09-18 · 未重新核查现状')}`)}
  ${actions(A(22,`${icon('chat')} 问问这个组织`),A(19,'返回校园','btn secondary'))}
`,{back:20});

screen(22,'部门问答','pages/departments/index#qa',`
  <div class="eyebrow">${icon('chat')} 依据已收录的组织资料</div><h1 style="margin-top:12px">问之前，<br>先选对范围。</h1><p class="intro">当前组织：学生会 · 示例</p>
  <div class="message user">现在报名需要什么材料？</div>
  <div class="message"><div class="byline"><span class="brand-mark">${icon('spark')}</span>当前资料里没有这项信息</div><p>已收录的组织介绍没有报名材料和报名时间，暂时无法确认。</p><p style="margin-top:10px">你可以先查看部门职责，再根据学校发布的新公告核对报名要求。</p>${source('已查范围：组织介绍与下设部门资料<br>未收录：最新招新公告')}${A(21,'查看已收录资料','text-link')}</div>
  <div class="chip-row">${A(65,'有哪些下设部门？','chip')}${A(20,'更换组织范围','chip')}</div><div class="space"></div>
  <div class="composer"><span class="grow muted">继续问这个组织…</span>${A(22,icon('arrow'),'send','aria-label="问答结果静态示意"')}</div>
`,{back:21,state:'资料不足与继续查阅'});

screen(23,'校园资讯','pages/news/index',`
  <div class="eyebrow">读动态，也看出处</div><h1 style="margin-top:10px">校园正发生。</h1><p class="intro">来自学校公开来源。以下为排版示例，<br>不代表已发布的真实新闻。</p>
  <div class="tabs">${A(23,'全部','on')}${A(23,'学校要闻','')}${A(23,'校园动态','')}</div>
  ${[['11','NOV','把课堂所学，带进实践现场','产教融合 · 示例资讯'],['10','NOV','一场关于校园生活的交流','校园活动 · 示例资讯'],['08','NOV','图书馆里的新发现','学习生活 · 示例资讯'],['06','NOV','从一次实践开始，走近专业','专业实践 · 示例资讯']].map(([d,m,t,s])=>A(24,`<div class="news-date"><strong>${d}</strong>${m}</div><div class="grow"><h3>${t}</h3><p class="item-sub">${s}</p></div>`,'news-row')).join('')}
  ${source('列表实装保留真实来源、发布日期及同步状态。<br>刷新失败保留已读内容，另给重试入口。')}
`,{back:19,white:true});

screen(24,'资讯详情','pages/news/detail/index',`
  <article class="article"><div class="eyebrow">校园动态 · 虚构排版示例</div><h1 style="margin-top:16px">把课堂所学，<br>带进实践现场</h1><div class="article-meta"><span>来源：示例学校资讯</span><time datetime="2026-11-11">示例日期 2026年11月11日</time></div>
  <div class="notice info">本文为设计示例，不是学校实际发布的新闻。</div><p>一次走出课堂的实践，可以从一个具体的问题开始。学生记录观察、整理材料，再把课堂上学到的方法用在真实场景中。</p>
  <h2>让问题带着学习往前走</h2><p>小组先把观察记录整理在一起，比较不同场景里遇到的困难。有的方案需要重新画图，有的想法则要回到课堂，查清原理再继续。</p><p>实践结束后，大家把尝试过的方法和还没解决的问题留下来，作为下一次学习的起点。</p></article>
  ${source('此处为来源说明示意。复制只获得原文链接，不代表已经在小程序中打开官网。')}
  ${actions(A(24,`${icon('link')} 复制原文链接（静态示意）`,'btn secondary'),A(19,'返回校园','text-link'))}
`,{back:23,white:true,kind:'长文阅读'});

screen(25,'校历与考试','pages/calendar/index',`
  <h1>重要日期，<br>有据可查。</h1><p class="intro">日期、适用范围、原文来源一起看。<br>以下事项仅作日期状态排版示例。</p>
  ${card(`<div class="row between"><h3>示例考试事项</h3>${tag('待公布','amber')}</div><div class="large-quote">日期待公布</div>${kv('报名','以本校通知为准')}${kv('适用范围','待核实后展示')}${source('尚无可核实的官方日期；不沿用往年安排。')}${A(25,'查看官方查询入口（静态示意）','text-link')}`)}
  ${card(`<div class="row between"><h3>示例校历事项</h3>${tag('日期展示示意')}</div><div class="large-quote num">11 月 20 日</div><p class="small muted">虚构日期，仅用于排版；不作为学校安排。</p>${kv('报名','此事项不适用')}${source('实装读取现有官方条目、发布日期与核查日期。')}${A(25,'复制原文链接（静态示意）','text-link')}`)}
`,{back:19});

screen(26,'体测估算','pages/fitness/index',`
  <h1>看看自己的状态。</h1><p class="intro">按国家标准估算，缺项就留空。<br>只在本机计算，不上传、不保存。</p>
  <div class="field"><div class="label">性别 · 示例选项</div><div class="seg">${A(26,'男','on')}${A(26,'女','')}</div></div>
  <div class="field"><div class="label">年级组</div><div class="seg">${A(26,'大一 / 大二','on')}${A(26,'大三 / 大四','')}</div></div>
  <div class="field-pair">${field('身高（厘米）','175')}${field('体重（千克）','61.3')}</div>
  ${field('肺活量（毫升）','4300')}
  <div class="field-pair">${field('50 米跑（秒）','7.0')}${field('体前屈（厘米）','17.7')}</div>
  ${field('立定跳远（厘米）','248')}${field('引体向上（次）','15')}${field('1000 米跑','3′42″','','可以输入分秒，也可以填写总秒数。')}
  ${actions(A(27,'查看估算结果'))}${source('国家学生体质健康标准（2014 年修订）<br>不代表本校计分口径或学校正式成绩。')}
`,{back:11});

screen(27,'体测估算结果','pages/fitness/index#result',`
  <div class="eyebrow">估算结果 · 大一 / 大二 · 男</div><h1 style="margin-top:12px">每一项，都看清楚。</h1><p class="intro">虚构输入的排版示例 · 非学校成绩</p>
  ${card(`<div class="row between"><span class="small muted">估算学年总分</span>${tag('良好','red')}</div><div class="score num">84.0</div><p class="small muted">国家标准参考 · 7 项均有输入</p><div class="divider"></div><div class="row between small"><span>标准分 84.0</span><span>附加分 0.0</span></div>`)}
  ${head('单项明细')}<div class="card"><table class="score-table"><thead><tr><th>项目</th><th>成绩</th><th>单项分</th></tr></thead><tbody>${[['BMI','20.0','100'],['肺活量','4300 mL','80'],['50 米跑','7.0 秒','85'],['坐位体前屈','17.7 cm','80'],['立定跳远','248 cm','80'],['引体向上','15 次','80'],['1000 米跑','3′42″','80']].map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
  <div class="space"></div>${notice('缺项时不显示学年总分与等级；已填项目的加权分也不会冒充总分。','info')}${actions(A(26,'返回修改成绩','btn secondary'))}
`,{back:26,state:'完整结果与缺项口径'});

screen(28,'升学与实习问答','pages/advancement/index',`
  <div class="eyebrow">${icon('book')} 依据已收录的官方原文</div><h1 style="margin-top:12px">下一步怎么走，<br>先把依据找清楚。</h1><p class="intro">先确认你问的是哪一类升学或实习，<br>有出处再解释；资料里没有就说明。</p>
  ${field('你的问题','转段考核包括哪些部分？','textarea')}${actions(A(29,'查找相关原文'))}
  <div class="chip-row">${A(29,'专升本还是转段？','chip')}${A(30,'看看带出处的回答','chip')}</div>
  <div class="space"></div>${notice('仅覆盖已收录资料；回答不作为报考资格或录取判断。','info')}
`,{back:11});

screen(29,'确认问题范围','pages/advancement/index#clarify',`
  <div class="eyebrow">先确认范围，再找依据</div><h1 style="margin-top:12px">你问的是哪一种？</h1><p class="intro">不同通道的考核与报名条件不同，<br>先选对问题范围。</p><div class="message user">专升本需要考什么？</div>
  <div class="stack">${A(30,`<div class="grow"><h3>普通专升本</h3><p class="item-sub">面向普通专升本招生政策</p></div>${icon('arrow')}`,'choice-card')}${A(30,`<div class="grow"><h3>三二分段转段</h3><p class="item-sub">面向三二分段转段考核</p></div>${icon('arrow')}`,'choice-card')}</div>
  ${actions(A(28,'都不是，重新描述','btn secondary'))}
`,{back:28,state:'歧义澄清'});

screen(30,'原文与解释','pages/advancement/index#answer',`
  <div class="eyebrow">2026 年已存政策 · 非新年度报考依据</div><h1 style="margin-top:12px">转段考核，<br>有哪几个部分？</h1><p class="intro">回答示例，非真实模型返回。<br>依据项目 2026-10-03 收录资料，未重新核查。</p>
  ${card(`<div class="row between"><h3>依据原文解释</h3>${tag('示例回答')}</div><p style="margin-top:12px">保存的 2026 年文件将转段考核分为三个部分：<b>公共课程统一考试、基本素质考核、专业能力考核</b>。<span class="source-ref">[S1]</span></p><p>这份文件适用于其规定的 2023 年试点招生群体，不能直接套用到其他年级或新年度。<span class="source-ref">[S2]</span></p><p class="small muted">这里只解释收录文件，不据此判断你本人能否报考。</p>`)}
  ${head('对应原文 · 2 处依据')}${card(`<h3>关于做好广东省2026年普通高等学校三二分段专升本转段招生工作的通知</h3>${source('广东省招生委员会办公室<br>粤招办普〔2025〕53号 · 发布 2025-11-29<br>适用：广东省2026年转段招生 · 收录 2026-10-03')}<div class="divider"></div><h3 class="source-ref">[S1] 转段考核构成</h3><p class="small" style="margin-top:8px">原文列出三部分，要求“分项考核、综合评价”。</p><div class="divider"></div><h3 class="source-ref">[S2] 招生对象</h3><p class="small" style="margin-top:8px">原文针对2023年试点高职院校招收的三二分段培养全日制学生，并有其他条件。</p>${A(30,'复制原文链接（静态示意）','text-link')}`)}
  ${actions(A(28,'继续提问','btn secondary'))}
`,{back:28,state:'解释与逐条来源'});

screen(31,'项目讲解与答辩练习','pages/defense/index',`
  <div class="eyebrow">项目讲解练习 · 先选材料</div><h1 style="margin-top:8px">这次，练哪一个？</h1><p class="intro">两份维护者编写的练习材料，选择一份开始。</p>
  <div class="card material-option"><label class="material-pick" for="material-campus"><input type="radio" name="material" id="material-campus" value="campus" checked><strong>校园工具项目</strong></label><p class="material-brief">已完成：课表导入与查询<br>尚未验证：真实学生使用效果</p>${A(42,'查看完整材料','text-link')}</div>
  <div class="card material-option"><label class="material-pick" for="material-course"><input type="radio" name="material" id="material-course" value="course"><strong>课程小组项目</strong></label><p class="material-brief">已完成：任务列表与表单校验<br>尚未验证：真实协作效果</p>${A(42,'查看完整材料','text-link')}</div>
  <details class="practice-bounds"><summary>练习方式与会话边界</summary><p>三轮提问、一次复盘和一次重答。反馈只对照材料，不生成职业能力等级或学校成绩；这些材料不代表真实学生项目。</p></details>
`,{back:11,compact:true,dock:`${A(32,'用已选材料开始练习')}<p class="dock-note" style="margin-top:8px">3 轮练习 · 可复制记录 · 退出不保存</p>`});

screen(32,'第 1 轮练习','pages/defense/index#practice',`
  <div class="row between"><div class="eyebrow">校园工具项目 · 练习材料</div><span class="small muted">1 / 3 轮</span></div>
  <div class="progress-track"><i class="done"></i><i></i><i></i></div>
  <div class="question-card"><span class="small">第 1 轮 · 项目动机</span><h2>项目解决什么问题？<br>用一条用户路径说明。</h2></div>
  ${field('你的回答','学生从 Excel 导入课表，逐项核对后保存。之后可以查看每周课程，不需要把教务账号交给小程序。','textarea')}
  <div class="row between small muted"><span>示例回答 · 20–500 字</span>${A(42,'查阅材料','text-link')}</div>
  ${actions(A(33,'提交这一轮，获取反馈'))}${notice('退出将清空本次会话；提交失败会保留当前回答。','info')}
`,{back:31,state:'作答与材料查阅'});

screen(33,'正在核对回答','pages/defense/index#pending',`
  <div class="eyebrow">第 1 轮 / 共 3 轮</div><h1 style="margin-top:16px">正在对照材料，<br>核对你的回答。</h1><p class="intro">你的回答已留在本页，等待结束后，<br>这里会显示反馈与下一轮问题。</p>
  ${card(`<div class="row"><span class="ai-orb">${icon('spark')}</span><div><h3>正在生成反馈</h3><p class="item-sub">示例等待：12 秒</p></div></div><div class="loading-bars"><span></span><span></span><span></span></div><p class="small muted">会先核对材料条目，再整理可改进的表述。</p>`)}
  ${actions(A(32,'停止等待，保留回答','btn secondary'),A(62,'退出练习','text-link'))}${notice('停止等待后回到作答；不表示云端请求一定已取消。','info')}
`,{back:32,state:'长等待与保留草稿'});

screen(34,'本轮反馈','pages/defense/index#feedback',`
  <div class="row between"><div class="eyebrow">第 1 轮反馈 · 示例</div>${tag('依据材料')}</div><h1 style="margin-top:14px">路径讲清了，<br>还可以再具体一点。</h1><p class="intro">反馈围绕你的表述与材料，<br>不评价职业能力，不输出成绩。</p>
  ${card(`<div class="feedback-block" style="border:0;padding-top:0"><h3 class="green">已经说清楚</h3><p>你描述了“导入 → 校对 → 保存 → 按周查看”的用户路径。<span class="source-ref">[F1]</span></p></div><div class="feedback-block"><h3>可以补充</h3><p>解释识别不清楚时，用户怎样修正草稿，避免把识别结果直接当成正式课程。<span class="source-ref">[F2]</span></p></div>${A(42,'核对 F1、F2 材料条目','text-link')}`)}
  ${head('下一轮 · 处理失败')}${card(`<h3>如果课表图片识别错了，<br>用户怎样继续完成导入？</h3>`)}
  ${actions(A(56,'继续第 2 轮'),A(42,'查看本轮材料依据','btn secondary'))}
`,{back:32,state:'依据反馈与后续提问'});

screen(35,'练习复盘','pages/defense/index#recap',`
  <div class="eyebrow">三轮练习结束 · 示例复盘</div><h1 style="margin-top:12px">这次，<br>说得更有依据了。</h1><p class="intro">回看三问，再补充第 3 轮的验证方案。</p>
  ${card(`<div class="feedback-block" style="border:0;padding-top:0"><h3>01　项目解决什么</h3><p>用一条用户路径讲清楚了。<span class="source-ref">[F1]</span></p></div><div class="feedback-block"><h3>02　识别错误怎么办</h3><p>已说明用户校对与修正草稿。<span class="source-ref">[F2]</span></p></div><div class="feedback-block"><div class="row between"><h3>03　效果怎样验证</h3>${tag('可重答一次','red')}</div><p>已区分测试与真实学生效果；可再补充一种未来验证方法，注明尚未执行。<span class="source-ref">[F3]</span></p></div>`)}
  <div class="space"></div>${notice('可再回答一次第 3 轮的问题，当前会话只提供一次重答。','info')}
  ${actions(A(60,'重新回答第 3 轮问题'),A(77,'查看并复制练习记录','btn secondary'),A(62,'结束练习','text-link'))}
`,{back:34,state:'复盘与一次重答'});

screen(36,'先导入你的课表','pages/home/index#empty',`
  <div class="home-intro"><div><div class="kicker">11 月 11 日，星期三 · 示例</div><h1>新的一天，<br>从自己的课表开始。</h1></div></div>
  <div class="empty" style="padding-top:20px"><div class="empty-icon">${icon('calendar')}</div><h2>这里还没有课表</h2><p>导入后，就能按周看课程，<br>查询和核对自己的安排。</p>${actions(A(3,'导入我的课表'),A(5,'先手工添加一门课','btn secondary'))}</div>
  ${notice('还没设置学期与作息时，只显示节次；不猜测“正在上课”或“今天没课”。','info')}
  ${head('也可以先逛逛')}<div class="list">${item(19,'campus','校园资料与资讯','浏览无需绑定教务账号')}${item(11,'book','学习工具','记一个目标日，或练习项目讲解')}</div>
`,{tab:'今天',state:'首次为空与未知作息',proposed:true});

screen(37,'课表暂时没读到','pages/timetable/index#error',`
  <div class="empty"><div class="empty-icon">${icon('refresh')}</div><h1>课表暂时没读到。</h1><p>可能是网络连接有变化。<br>没有确认数据前，先不判断你有没有课。</p>${actions(A(2,'重新读取课表'),A(17,'查看本机已保存的学习计划','btn secondary'))}</div>
  ${notice('重新读取不会重新导入或覆盖课程。','info')}${actions(A(1,'返回今天','text-link'))}
`,{back:2,state:'读取失败'});

screen(38,'截图识别没有完成','pages/timetable/import/index#error',`
  ${steps(0)}<div class="empty"><div class="empty-icon">${icon('photo')}</div><h1>截图识别未完成</h1><p>识别服务没有返回可用课程。<br>原课表没有被修改。</p></div>
  ${card(`<h3>可以这样继续</h3><p class="item-sub">重新选择一张清晰、完整的课表截图，<br>或改用 Excel / 手工添加。</p>`)}
  ${actions(A(3,'重新选择截图'),A(3,'改用 Excel 导入','btn secondary'),A(5,'手工添加课程','text-link'))}
`,{back:3,state:'识别失败与替代路径'});

screen(39,'部分修改已保存','pages/timetable/index#partial',`
  <div class="eyebrow">调课通知 · 示例批次</div><h1 style="margin-top:12px">1 项已保存，<br>1 项还没完成。</h1><p class="intro">保留已经成功的修改，<br>只重试没有完成的那一项。</p>
  ${card(`<div class="row between"><h3>Java 程序设计</h3>${tag('已保存','green')}</div><p class="item-sub">仅第 11 周 · 改为周五第 5–6 节</p>${A(8,'撤销这项修改','text-link')}`)}
  ${card(`<div class="row between"><h3>数据库原理</h3>${tag('待重试','amber')}</div><p class="item-sub">仅第 11 周 · 周三第 5–6 节</p><div class="change-diff"><div><span class="tiny muted">原地点</span><p>博雅楼 A302</p></div><span>→</span><div><span class="tiny">待保存地点</span><p>博雅楼 A306</p></div></div><p class="small muted">未收到保存结果，重试后会核对是否已完成。</p>${notice('只重试这一项，已经保存的修改不会再做一次。','info')}`)}
  ${actions(A(73,'只重试未完成的 1 项'),A(8,'返回助手，保留当前结果','btn secondary'))}
`,{back:8,state:'部分成功与定向重试'});

screen(40,'历史学习计划','pages/goals/plan/index#expired',`
  <div class="eyebrow">历史快照 · 目标有变化</div><h1 style="margin-top:12px">计划还在，<br>时间已经过去了。</h1><p class="intro">保存于 11 月 2 日 — 8 日，<br>对应的目标日已删除。</p>
  ${notice('只供回看；不再作为本周有效安排。不会自动创建目标或重新排程。','info')}
  <div class="space"></div>${card(`<div class="row between"><h3>英语听力</h3>${tag('历史记录')}</div><p class="item-sub">原目标：英语考试 · 快照保留</p>${kv('保存时约束','每周 3 次，每次 30 分钟')}${kv('原计划日期','11 月 6 日、7 日、8 日')}${source('离线仍可查看；生成新计划前需先选一个有效目标。')}`)}
  ${actions(A(12,'选择一个有效目标'),A(17,'返回计划示例','btn secondary'))}
`,{back:12,state:'过期与目标删除'});

screen(41,'确认删除课程','pages/timetable/manage/index#delete',`
  <div class="eyebrow">删除前核对</div><h1 style="margin-top:12px">删除这门课程？</h1><p class="intro">Java 程序设计 · 示例课程</p>
  ${card(`${kv('上课','周三第 3–4 节')}${kv('周次','第 1–16 周')}${kv('地点','博雅楼 B604')}`)}
  <div class="space"></div>${notice('这会删除所选课程记录，不能从这里撤销。只影响个人课表，不修改教务系统。')}
  ${actions(A(7,'确认删除课程'),A(5,'保留课程，返回编辑','btn secondary'))}
`,{back:5,state:'破坏性操作确认'});

screen(42,'练习材料','pages/defense/index#material',`
  <div class="eyebrow">维护者编写 · 静态练习材料</div><h1 style="margin-top:12px">校园工具项目</h1><p class="intro">以下编号是练习中的引用依据。<br>不是经独立验证的学生项目。</p>
  ${card(`<div class="feedback-block" style="border:0;padding-top:0"><span class="source-ref">F1 · 已完成</span><h3 style="margin-top:6px">从导入到查看</h3><p>学生从 Excel 或截图导入课表，核对草稿后保存，再按周查看课程。</p></div><div class="feedback-block"><span class="source-ref">F2 · 已完成</span><h3 style="margin-top:6px">先核对，后写入</h3><p>识别结果为草稿；不清楚的字段由学生校对，确认前不替换正式课程。</p></div><div class="feedback-block"><span class="source-ref">F3 · 尚未验证</span><h3 style="margin-top:6px">真实学生使用效果</h3><p>离线测试和界面演示不能证明真实学生学习效果，后续需要实际反馈。</p></div>`)}
  ${actions(A(32,'返回作答，保留原回答','btn secondary'))}
`,{back:32,state:'长材料与返回草稿'});

screen(43,'约束暂时没整理好','pages/goals/plan/index#error',`
  ${steps(0,['说说情况','核对约束','预览计划'])}<div class="empty" style="padding-top:20px"><div class="empty-icon">${icon('spark')}</div><h1>这次先手动安排。</h1><p>AI 当前用量已达上限。<br>你刚才写的情况还在，可以继续修改。</p></div>
  ${field('已保留的情况','我周四没空，周末上午有兼职，每次半小时，听力总拖后腿，一周安排三回。','textarea')}
  ${actions(A(49,'用基础规则设置'),A(14,'返回修改情况','btn secondary'))}
  ${notice('不会自动重复请求，也没有保存新计划。','info')}
`,{back:14,state:'额度不足与保留输入'});

// Dormant routes remain an appendix; nothing here activates lost-and-found in production.
screen(44,'失物招领','pages/lost-found/index',`
  <h1>让东西，回到主人身边。</h1><p class="intro">以下为暂缓模块的界面附录，<br>不纳入当前正式主导航。</p>
  <div class="seg">${A(44,'全部','on')}${A(44,'寻物','')}${A(44,'招领','')}</div><div class="space"></div>
  ${card(`${tag('招领中','green')}<h2 style="margin-top:12px">一把深色雨伞</h2><p class="item-sub">图书馆公共区域 · 11 月 10 日</p><p class="small muted" style="margin-top:12px">虚构物品示例 · 不公开认领校验细节</p>${A(46,'查看物品','text-link')}`)}
  ${actions(A(45,'发布物品信息'),A(48,'我的发布与认领','btn secondary'))}
`,{back:19,dormant:true});
screen(45,'发布物品','pages/lost-found/publish/index',`
  <h1>留下足够的信息。</h1><p class="intro">公开信息帮助查找，关键特征留作核验。</p>
  ${field('信息类型','招领　⌄')}${field('物品名称','深色雨伞')}${field('发现地点','图书馆公共区域')}${field('公开描述','一把深色雨伞，已交到服务台。','textarea')}${notice('联系信息与核验细节按现有权限处理；不要公开证件号码等个人信息。','info')}
  ${actions(A(48,'确认发布（静态示意）'),A(44,'放弃，返回列表','btn secondary'))}
`,{back:44,dormant:true});
screen(46,'物品详情','pages/lost-found/detail/index',`
  ${tag('招领中','green')}<h1 style="margin-top:12px">一把深色雨伞</h1><p class="intro">虚构物品 · 11 月 10 日</p>
  ${card(`${kv('发现地点','图书馆公共区域')}${kv('保管方式','请按发布者的交接说明核对')}<div class="divider"></div><p>已交到服务台。认领时请补充能够证明归属的物品特征。</p>`)}
  ${actions(A(47,'提交认领申请'),A(44,'返回列表','btn secondary'))}
`,{back:44,dormant:true});
screen(47,'认领与核验','pages/lost-found/claim/index',`
  <h1>用细节，核对归属。</h1><p class="intro">一把深色雨伞 · 虚构示例</p>
  ${field('物品特征与补充说明','描述你知道的独有细节，交给发布者核对。','textarea placeholder')}${notice('申请提交后等待发布者核验，核验通过与确认交接是两个独立状态。','info')}
  ${actions(A(48,'提交认领申请（静态示意）'),A(46,'取消，返回详情','btn secondary'))}
`,{back:46,dormant:true});
screen(48,'我的发布与认领','pages/lost-found/mine/index',`
  <h1>每一件，看到进展。</h1><p class="intro">虚构示例 · 仅展示本人的记录</p>
  ${card(`<div class="row between"><h3>一把深色雨伞</h3>${tag('待核验','amber')}</div><p class="item-sub">我的认领 · 已提交说明</p>${A(47,'查看申请','text-link')}`)}
  ${card(`<div class="row between"><h3>蓝色水杯</h3>${tag('待核验','amber')}</div><p class="item-sub">我的发布 · 收到 1 条申请</p>${A(50,'查看申请并核验','text-link')}`)}
  ${source('发布者视角沿用现有“需补充 / 通过 / 拒绝 / 确认交接”权限与状态，不新增 AI 匹配。')}
`,{back:44,dormant:true});

screen(49,'基础规则设置','pages/goals/plan/index#basic',`
  <div class="eyebrow">基础规则 · 不请求 AI</div><h1 style="margin-top:12px">自己定，<br>也能安排清楚。</h1><p class="intro">英语考试 · 本周规则设置示例</p>
  ${field('每次学习时长','30 分钟　⌄')}${field('每周安排次数','3 次　⌄')}${field('优先练习','听力')}
  <div class="field"><div class="label">不安排的星期</div><div class="chip-row">${['一','二','三','四','五','六','日'].map(x=>`<span class="chip ${x==='四'?'on':''}">周${x}</span>`).join('')}</div></div>
  <div class="field"><div class="label">不可用时段 · 可多选</div>${['周六','周日'].map(day=>`<div class="blocked-periods"><b>${day}</b>${['上午','下午','晚间'].map((p,i)=>`<label class="period-option"><input type="checkbox" ${i===0?'checked':''}><span>${p}</span></label>`).join('')}</div>`).join('')}<p class="field-hint">上午按第1–4节排除；规则检查已知课程、日期和时长，不安排过去时段。</p></div>
  ${actions(A(16,'按这些规则生成预览'),A(14,'返回 AI 整理入口','btn secondary'))}
`,{back:14,state:'基础规则替代入口'});

screen(50,'核验认领申请','pages/lost-found/claim/index#owner',`
  <div class="eyebrow">发布者视角 · 虚构示例</div><h1 style="margin-top:12px">先核验，<br>再确认交接。</h1><p class="intro">蓝色水杯 · 收到 1 条认领申请</p>
  ${card(`<div class="row between"><h3>申请说明</h3>${tag('待核验','amber')}</div><p style="margin-top:12px">申请者提供了杯身标记和遗失时间，用于发布者私下核对。</p>${source('只有具有对应权限的发布者可审核申请；不公开联系方式与校验细节。')}`)}
  ${actions(A(50,'通过核验（静态示意）'),A(50,'要求补充信息（静态示意）','btn secondary'),A(50,'拒绝申请（静态示意）','text-link'))}
  ${notice('通过后才显示“确认交接”；核验通过本身不代表物品已经交还。','info')}
`,{back:48,dormant:true,state:'发布者权限与交接'});

screen(51,'完整周课表','pages/timetable/index#full',`
  <div class="row between"><div><h1>第 10 周</h1><p class="item-sub">11 月 9 日 — 15 日 · 压力样例</p></div>${A(6,icon('settings'),'icon-button','aria-label="课表设置"')}</div><div class="space"></div>
  ${notice('七天均有课、长课程名与晚间节次样例。左右滑动看周末，节次轴保持可见；点击课程查看完整名称与地点。','info')}<div class="space"></div>${grid(true)}
  ${actions(A(2,'收起为常用节次','btn secondary'),A(17,'查看独立学习计划','text-link'))}
`,{back:2,state:'完整十二节与长课程名',kind:'二维滚动课表'});

screen(52,'课程字段需要修正','pages/timetable/edit/index#invalid',`
  <h1>先把这两处补齐。</h1><p class="intro">已填内容都保留着，修正后就能保存。</p>
  ${notice('还不能保存：课程名为空，周次超出本学期范围。','error')}
  ${field('课程名称（必填）','请填写课程名称','placeholder invalid')}<div class="field-error">填写课程名，方便你在课表中识别。</div><a class="text-link" href="${file(5)}#course-name">去填写课程名称 ›</a>
  ${field('上课周次','第 19 周','invalid')}<div class="field-error">本学期共 18 周，请选择第 1–18 周。</div><a class="text-link" href="${file(5)}#course-weeks">去选择有效周次 ›</a>
  ${field('地点（已保留）','博雅楼 B604')}
  <div class="actions"><span class="btn disabled" aria-disabled="true">修正上述 2 项后保存</span>${A(5,'返回编辑，修改字段','btn secondary')}</div>
`,{back:5,state:'无效输入与保留内容'});

screen(53,'今天的节次安排','pages/home/index#unknown-times',`
  <div class="home-intro"><div><div class="kicker">11 月 11 日，星期三 · 示例</div><h1>今天的安排，<br>先按节次看。</h1></div></div>
  ${notice('<b>还没有填写作息时间</b><br>先展示今天的课程，不判断哪节正在上。','info')}
  <div class="space"></div>${card(`<div class="daily-row"><div class="time">3–4<small>节次</small></div><div class="track"></div><div class="grow"><h3>Java 程序设计</h3><p class="item-sub">博雅楼 B604</p></div></div><div class="daily-row"><div class="time">5–6<small>节次</small></div><div class="track blue"></div><div class="grow"><h3>数据库原理</h3><p class="item-sub">博雅楼 A302</p></div></div>`)}
  ${actions(A(6,'填写我的作息时间'),A(2,'直接看周课表','btn secondary'))}
`,{tab:'今天',state:'未知作息且有课程',proposed:true});

screen(54,'确认删除目标日','pages/goals/edit/index#delete',`
  <div class="eyebrow">删除前核对</div><h1 style="margin-top:12px">删除这个目标日？</h1><p class="intro">英语考试 · 2026 年 12 月 19 日</p>
  ${notice('删除后，目标日不再出现在列表中。已保存的学习计划保留原快照，并提示目标已删除。')}
  ${actions(A(55,'确认删除目标日'),A(13,'保留目标日','btn secondary'))}
`,{back:13,state:'目标删除影响'});
screen(55,'我的目标日','pages/goals/index#empty',`
  <div class="empty"><div class="empty-icon">${icon('flag')}</div><h1>下一个目标，是什么？</h1><p>记一个考试、展示或比赛日期，<br>再为它留出学习时间。</p>${actions(A(13,'新建目标日'),A(40,'查看保留的历史计划','btn secondary'))}</div>
`,{back:11,state:'无有效目标与历史计划入口'});

function laterPractice(id,round,dimension,question,answer,next,back){
  screen(id,`第 ${round} 轮练习`,'pages/defense/index#practice',`<div class="row between"><div class="eyebrow">校园工具项目 · 示例材料</div><span class="small muted">${round} / 3 轮</span></div><div class="progress-track">${[1,2,3].map(n=>`<i class="${n<=round?'done':''}"></i>`).join('')}</div><div class="question-card"><span class="small">第 ${round} 轮 · ${dimension}</span><h2>${question}</h2></div>${field('你的回答',answer,'textarea')}<div class="row between small muted"><span>20–500 字</span>${A(42,'查阅材料','text-link')}</div>${actions(A(next,'提交这一轮，获取反馈'))}${notice('回答保留在当前会话，退出后不保存。','info')}`,{back,state:`第${round}轮作答`});
}
laterPractice(56,2,'处理失败','如果课表图片识别错了，<br>用户怎样继续完成导入？','先保留识别草稿，让用户逐项核对并修正不清楚的字段。如果不能得到可用结果，可以重新选图、改用 Excel，或手工录入。',57,34);
screen(57,'第 2 轮反馈','pages/defense/index#feedback',`
  <div class="eyebrow">第 2 轮反馈 · 示例</div><h1 style="margin-top:14px">恢复路径，<br>这次说清楚了。</h1><p class="intro">反馈只对照材料中的实际能力。</p>
  ${card(`<h3 class="green">已经说清楚</h3><p style="margin-top:12px">回答说明了草稿修正、重选图片、Excel 和手工录入的替代路径。<span class="source-ref">[F2]</span></p>${A(42,'核对 F2 材料条目','text-link')}`)}
  ${head('下一轮 · 验证边界')}${card(`<h3>怎样证明项目有用？<br>哪些结果现在还不能下结论？</h3>`)}${actions(A(58,'继续第 3 轮'))}
`,{back:56,state:'第二轮反馈与下一轮'});
laterPractice(58,3,'验证边界','项目有用，凭什么？<br>哪些效果还没验证？','已经做了功能测试，能导入和显示课程。但真实学生使用后是否节省时间，还没有进行独立的使用反馈记录，不能直接说已经改善了学习效果。',59,57);
screen(59,'第 3 轮反馈','pages/defense/index#feedback',`
  <div class="eyebrow">第 3 轮反馈 · 示例</div><h1 style="margin-top:14px">把“已经做到”，<br>和“还没验证”分开。</h1><p class="intro">三轮练习到这里结束，接下来回看整段讲解。</p>
  ${card(`<h3 class="green">边界表达清楚</h3><p style="margin-top:12px">你区分了功能测试和真实学生的使用效果，没有把后续验证写成现有成果。<span class="source-ref">[F3]</span></p><div class="divider"></div><h3>下一步可以补充</h3><p style="margin-top:8px">说出一种未来可执行的观察方式，例如记录一次任务完成过程；明确这仍是计划。</p>${A(42,'核对 F3 材料条目','text-link')}`)}${actions(A(35,'查看三轮复盘'))}
`,{back:58,state:'第三轮反馈与收尾'});
screen(60,'重新回答一处','pages/defense/index#reanswer',`
  <div class="eyebrow">第 3 轮重答 · 本次仅一次</div><h1 style="margin-top:12px">这次，<br>把验证方法也讲出来。</h1><p class="intro">沿用同一份材料与原问题。</p>
  ${card(`<h3>项目有用，凭什么？<br>哪些效果还没验证？</h3>`)}
  ${field('重答内容','功能测试说明流程能运行，真实学生效果还没有证据。后续计划让学生完成一次导入和查课，记录问题和反馈；这项观察目前还没执行。','textarea')}
  ${A(42,'再核对 F3 材料','text-link')}${actions(A(61,'提交这一次重答'),A(35,'暂不重答，返回复盘','btn secondary'))}
`,{back:35,state:'一次重答与草稿'});
screen(61,'重答反馈','pages/defense/index#finished',`
  <div class="result-icon">${icon('check')}</div><h1>到这里，<br>这次练习完成了。</h1><p class="intro">三轮问答、一次复盘与一次重答。</p>
  ${card(`<h3>重答后的变化 · 示例</h3><p style="margin-top:12px">补充了“记录导入与查课过程”的验证计划，并明确它尚未执行。<span class="source-ref">[F3]</span></p>${source('这份反馈围绕材料和当前表述，不代表专业能力等级或独立项目验收。')}`)}
  ${actions(A(77,'查看并复制练习记录'),A(62,'结束练习','btn secondary'),A(35,'回看三轮复盘','text-link'))}
`,{back:35,state:'重答结束与可回看'});
screen(62,'结束这次练习？','pages/defense/index#exit',`
  <div class="eyebrow">离开前确认</div><h1 style="margin-top:12px">结束这次练习？</h1><p class="intro">本次会话只保留在当前页面内存中。</p>
  ${notice('退出后，材料选择、回答、反馈与复盘都会清空。想保留内容，可先复制当前已有的回答与反馈。')}
  ${actions(A(78,`${icon('file')} 复制现有回答与反馈`,'btn secondary'),A(31,'确认结束，清空会话'),A(35,'继续留在练习中','text-link'))}
`,{back:35,state:'退出与会话丢失确认'});

screen(63,'已填项目的估算','pages/fitness/index#missing',`
  <div class="eyebrow">体测估算 · 缺项示例</div><h1 style="margin-top:12px">还差一项，<br>先不给学年总分。</h1><p class="intro">1000 米跑未填写，其余输入已保留。</p>
  ${notice('不把缺项当成 0 分，也不替你猜。补全后才能显示完整总分和等级。')}
  <div class="space"></div>${card(`<h3>缺少的项目</h3>${kv('1000 米跑','未填写')}${A(26,'补填 1000 米跑成绩','btn soft')}`)}
  ${head('已填项目的单项结果')}<div class="card"><table class="score-table"><thead><tr><th>项目</th><th>成绩</th><th>单项分</th></tr></thead><tbody>${[['BMI','20.0','100'],['肺活量','4300 mL','80'],['50 米跑','7.0 秒','85'],['坐位体前屈','17.7 cm','80'],['立定跳远','248 cm','80'],['引体向上','15 次','80'],['1000 米跑','未填写','—']].map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>${source('这里只显示单项；不展示不完整加权总分与等级。')}</div>
  ${actions(A(26,'返回补充 1000 米跑成绩'),A(11,'先返回学习工具','btn secondary'))}
`,{back:26,state:'缺项且不误报总分'});

screen(64,'有一句还需确认','pages/goals/plan/index#clarify',`
  ${steps(1,['说说情况','核对约束','预览计划'])}<h1>有一句，<br>还需要说具体一点。</h1><p class="intro">先确认这句的意思，避免安排超出你的时间。</p>
  <div class="quote">“周末尽量别太早。”</div><div class="space"></div>${notice('还无法确定要排除哪个时段。可以改成“周末上午不安排”，或者返回基础规则手动选择。')}
  ${actions(A(14,'返回修改这句话'),A(49,'自己选择不可用时段','btn secondary'))}
  <span class="btn disabled" aria-disabled="true">澄清后再生成预览</span><p class="field-hint">已确认的其他条件保留；这里不会悄悄忽略限制。</p>
`,{back:14,state:'无法理解的约束与禁止直接排程'});

screen(65,'部门资料里的答案','pages/departments/index#answer',`
  <div class="eyebrow">部门问答 · 示例回答</div><h1 style="margin-top:12px">答到了，<br>也能找到出处。</h1><p class="intro">依据项目保存资料，非本轮真实模型返回。</p>
  <div class="message user">校学生会有哪些下设部门，各做什么？</div>
  ${card(`<div class="byline"><h3>依据已收录资料</h3></div><p style="margin-top:12px">保存的官网资料列出五个工作部门：<b>权益部、文娱部、器材部、体育部、学创部</b>。<span class="source-ref">[1]</span></p><p>这段资料没有逐部门说明具体职责，暂时不能替你确认各自负责的工作。</p><div class="divider"></div><h3 class="small">[1] 学生组织机构简介 · 校学生会</h3><p class="item-sub">学校官网 · 团委 · 学生组织<br>官网未标注所属校区 · 核查于 2026-09-18</p>${A(21,'回到组织资料核对','text-link')}`)}
  <div class="space"></div><div class="composer"><span class="grow muted">继续问这个组织…</span>${A(22,icon('arrow'),'send','aria-label="查看资料不足示例"')}</div>
`,{back:20,state:'带来源的回答'});

screen(66,'课程详情','pages/timetable/index#detail',`
  <div class="eyebrow">第 10 周 · 星期三</div><h1 style="margin-top:12px">Java 程序设计</h1><p class="intro">你已保存的课程 · 示例</p>
  ${card(`<div class="eyebrow">第 3–4 节</div><div class="large-quote num">10:10 — 11:45</div>${kv('地点','博雅楼 B604')}${kv('教师','示例教师')}${kv('周次','第 1–16 周')}${source('具体时刻来自你填写的作息。未填作息时，只显示第 3–4 节。')}`)}
  ${actions(A(5,`${icon('edit')} 编辑这门课`,'btn secondary'),A(2,'返回课表','text-link'))}
`,{back:2,state:'只读详情与编辑入口'});

screen(67,'每日安排','pages/timetable/index#day',`
  <div class="row between"><div><h1>第 10 周</h1><p class="item-sub">11 月 9 日 — 15 日 · 示例</p></div>${A(8,'问课表','chip on')}</div><div class="space"></div>
  <div class="seg">${A(2,'周课表','')}${A(67,'每日安排','on')}</div>
  <div class="week-days">${[['一',9],['二',10],['三',11],['四',12],['五',13],['六',14],['日',15]].map(([w,d])=>A(67,`<span>周${w}</span><strong>${d}</strong>`,d===11?'on':'','aria-label="日期选择静态示意"')).join('')}</div>
  <p class="field-hint">↔ 左右滑动日期，查看完整一周</p>
  ${head('11 月 11 日 · 周三')}${card(`<div class="daily-row"><div class="time">10:10<small>第 3–4 节</small></div><div class="track"></div><div class="grow"><h3>Java 程序设计</h3><p class="item-sub">博雅楼 B604</p></div></div><div class="daily-row"><div class="time">14:00<small>第 5–6 节</small></div><div class="track blue"></div><div class="grow"><h3>数据库原理</h3><p class="item-sub">博雅楼 A302</p></div></div><div class="daily-row"><div class="time">16:00<small>第 7–8 节</small></div><div class="track green"></div><div class="grow"><h3>大学体育</h3><p class="item-sub">综合体育馆</p></div></div>`)}
  ${actions(A(17,'查看本周独立学习计划','btn secondary'))}
`,{tab:'课表',state:'可切换的单日列表',proposed:true});

screen(68,'核对草稿地点','pages/timetable/edit/index#draft',`
  <div class="eyebrow">只修改草稿，原课表不变</div><h1 style="margin-top:12px">对照文件，<br>把这一条看清楚。</h1><p class="intro">数据库原理 · 周三第 5–6 节</p>
  ${sourceFragment('Excel')}
  ${field('课程草稿地点','博雅楼 A302','','上方为原文件 C8 单元格示例；这里的修改只影响草稿。')}${card(`<h3 class="small muted">课程上下文 · 只读</h3>${kv('上课','星期三 · 第 5–6 节')}${kv('周次','第 1–16 周')}`)}
  ${actions(A(69,'确认地点，返回导入核对'),A(4,'暂不修改，返回草稿','btn secondary'))}
`,{back:4,state:'导入待核对字段纠正'});

screen(69,'导入核对已完成','pages/timetable/import/index#ready',`
  ${steps(2)}<div class="row between"><h1>核对已完成</h1>${tag('9 条已核对','green')}</div><p class="intro">9 条安排 · 7 门课程 · 第 1–16 周</p>
  <p class="verified-line">${icon('check')} 数据库原理地点已确认为 A302。</p>${importSummary()}
`,{back:4,state:'全部确认后的替换保存',compact:true,dock:replacementDock()});

screen(70,'修改调课通知','pages/timetable/index#notice-edit',`
  <div class="eyebrow">原通知已保留</div><h1 style="margin-top:12px">先把原意改清楚。</h1><p class="intro">原提案不会在这里保存。重新识别后，<br>仍要核对生效周、节次与地点。</p>
  ${field('调课通知','第 11 周周三 3–4 节 Java 程序设计调到周五 5–6 节，地点改为博雅楼 A302，其余周次不变。','textarea')}
  ${notice('重新识别会再请求一次 AI。你的原课表尚未改变。','info')}
  ${actions(A(9,'重新识别，再核对提案'),A(9,'保留原提案，返回核对','btn secondary'))}
`,{back:9,state:'通知纠错与保留原文'});

screen(71,'我的课表','pages/timetable/index#week-eleven',`
  <div class="row between"><div class="kicker">2026–2027 学年 · 第一学期</div>${A(7,'管理','text-link')}</div>
  <div class="week-control"><div class="week-nav">${A(2,icon('back'),'icon-button','aria-label="上一周"')}<span class="week-title">第 11 周</span>${A(2,icon('arrow'),'icon-button','aria-label="下一周"')}</div>${A(8,'问课表','chip on')}</div>
  <div class="row between range-header"><span class="kicker">11/16 — 11/22</span>${A(51,'3–8 节 · 看完整12节 ›','text-link')}</div>
  <div class="seg">${A(71,'周课表','on')}${A(67,'每日安排','')}</div>
  <div class="change-strip"><b>已保存 · 仅第11周</b><span>Java · 周五5–6节 · 博雅楼A302</span></div>
  ${grid(false,true).replaceAll('一 9','一 16').replaceAll('二 10','二 17').replaceAll('三 11','三 18').replaceAll('四 12','四 19').replaceAll('五 13','五 20').replaceAll('六 14','六 21').replaceAll('日 15','日 22')}<p class="field-hint">“本次调整”标出新安排；滑动可看其他日期。</p>
  ${head('独立学习计划')}${card(`<h3>还没有这一周的计划</h3><p class="item-sub">11 月 9 日 — 15 日的已保存计划仍可回看。</p>${A(17,'查看其他周的计划','text-link')}`)}
`,{tab:'课表',state:'限定周次保存后的对应周课表',proposed:true,compact:true});

screen(72,'这次调课已撤销','pages/timetable/index#undone',`
  <div class="result-icon">${icon('check')}</div><h1>第 11 周，<br>恢复原安排了。</h1><p class="intro">Java 程序设计 · 本次限定调课已撤销</p>
  ${card(`${kv('恢复为','周三第 3–4 节')}${kv('地点','博雅楼 B604')}${kv('周次','第 1–16 周恢复原安排')}${source('本次在第 11 周新增的周五安排已撤回。')}`)}
  ${actions(A(2,'返回当前周课表'),A(8,'继续使用课表助手','btn secondary'))}
`,{back:8,state:'原子撤销的可见结果'});

screen(73,'本批修改已完成','pages/timetable/index#batch-result',`
  <div class="result-icon">${icon('check')}</div><h1>这次，2 项都完成了。</h1><p class="intro">已保存项没有重复执行；<br>刚才待重试的修改已确认成功。</p>
  ${card(`<div class="row between"><h3>Java 程序设计</h3>${tag('先前已保存','green')}</div><p class="item-sub">仅第 11 周 · 周五第 5–6 节</p>`)}
  ${card(`<div class="row between"><h3>数据库原理</h3>${tag('重试后已保存','green')}</div><p class="item-sub">仅第 11 周 · 地点改为博雅楼 A306</p>`)}
  ${actions(A(8,'返回助手查看本批结果','btn secondary'))}
`,{back:39,state:'部分失败重试后的成功结果'});

screen(74,'课程详情','pages/timetable/index#long-detail',`
  <div class="eyebrow">第 10 周 · 周一 · 压力样例</div><h1 style="margin-top:12px">移动应用开发与<br>专业综合实践</h1><p class="intro">完整课程名称与地点</p>
  ${card(`${kv('上课节次','第 1–2 节')}${kv('完整地点','实训楼 B1204')}${kv('教师','未填写')}${kv('周次','第 1–16 周')}${source('第 1–2 节作息未填写，仅显示节次。')}`)}
  ${actions(A(51,'返回完整周课表','btn secondary'))}
`,{back:51,state:'长课程名详情承接'});

screen(75,'对照截图核对','pages/timetable/edit/index#photo',`
  <div class="eyebrow">课表截图.png · 只修正导入草稿</div><h1 style="margin-top:12px">原图和识别结果，<br>放在一起核对。</h1><p class="intro">数据库原理 · 周三第 5–6 节</p>
  ${sourceFragment('photo')}<div class="space-sm"></div>${notice('识别结果：博雅楼 A3O2。请对照上方裁片，确认 O / 0。')}
  ${field('核对后的地点','博雅楼 A302','','示例中原图为数字 0；仍需你本人确认。')}
  ${actions(A(69,'确认地点，返回导入核对'),A(4,'暂不修改，返回草稿','btn secondary'))}
`,{back:4,state:'截图原材料与识别结果对照',compact:true});

screen(76,'核对 Excel 课程','pages/timetable/import/index#excel',`
  ${steps(1)}<h1>核对 Excel 课程</h1><p class="intro">示例课表.xlsx<br>9 条安排 · 7 门课程 · 第 1–16 周</p>${importSummary(true)}
`,{back:3,state:'Excel 原文件与已解析课程',compact:true,dock:replacementDock(68)});

screen(77,'本次练习记录','pages/defense/index#record',`
  <div class="eyebrow">校园工具项目 · 完整会话示例</div><h1 style="margin-top:8px">把这次练习带走。</h1><p class="intro">包含原答、逐轮反馈与重答，分别标明。<br>以下均为虚构练习内容。</p>
  ${card(`<div class="row between"><h3>第 1 轮 · 项目动机</h3>${tag('原答')}</div><p class="record-label">问题</p><p class="small">项目解决什么问题？用一条用户路径说明。</p><p class="record-label">你的回答</p><p class="small">学生从 Excel 导入课表，逐项核对后保存。之后可以查看每周课程，不需要把教务账号交给小程序。</p><p class="record-label">材料反馈</p><p class="small">你描述了“导入 → 校对 → 保存 → 按周查看”的用户路径。[F1]</p><p class="small">解释识别不清楚时，用户怎样修正草稿，避免把识别结果直接当成正式课程。[F2]</p>`)}
  ${card(`<h3>第 2 轮 · 处理失败</h3><p class="record-label">问题</p><p class="small">如果课表图片识别错了，用户怎样继续完成导入？</p><p class="record-label">你的回答</p><p class="small">先保留识别草稿，让用户逐项核对并修正不清楚的字段。如果不能得到可用结果，可以重新选图、改用 Excel，或手工录入。</p><p class="record-label">材料反馈</p><p class="small">回答说明了草稿修正、重选图片、Excel 和手工录入的替代路径。[F2]</p>`)}
  ${card(`<h3>第 3 轮 · 验证边界</h3><p class="record-label">问题</p><p class="small">项目有用，凭什么？哪些效果还没验证？</p><p class="record-label">你的回答</p><p class="small">已经做了功能测试，能导入和显示课程。但真实学生使用后是否节省时间，还没有进行独立的使用反馈记录，不能直接说已经改善了学习效果。</p><p class="record-label">材料反馈</p><p class="small">你区分了功能测试和真实学生的使用效果，没有把后续验证写成现有成果。[F3]</p><p class="small">说出一种未来可执行的观察方式，例如记录一次任务完成过程；明确这仍是计划。</p>`)}
  ${card(`<h3>三轮复盘</h3><p class="small">01　用一条用户路径讲清楚了。[F1]</p><p class="small">02　已说明用户校对与修正草稿。[F2]</p><p class="small">03　已区分测试与真实学生效果；可再补充一种未来验证方法，注明尚未执行。[F3]</p>`)}
  ${card(`<div class="row between"><h3>第 3 轮 · 一次重答</h3>${tag('重答','red')}</div><p class="record-label">你的重答 · 沿用第 3 轮问题</p><p class="small">功能测试说明流程能运行，真实学生效果还没有证据。后续计划让学生完成一次导入和查课，记录问题和反馈；这项观察目前还没执行。</p><p class="record-label">重答反馈</p><p class="small">补充了“记录导入与查课过程”的验证计划，并明确它尚未执行。[F3]</p>`)}
`,{back:35,compact:true,dock:`${A(78,'复制这份练习记录')}<p class="dock-note" style="margin-top:8px">复制到剪贴板；本程序不自动保存会话。</p>`});

screen(78,'练习记录已复制','pages/defense/index#copied',`
  <div class="result-icon">${icon('check')}</div><h1>已复制当前记录。</h1><p class="intro">可以粘贴到自己的笔记中，<br>再决定是否结束练习。</p>
  ${card(`<h3>这次复制了什么</h3><p class="item-sub">当前会话已有的问题、回答、已返回的反馈及重答；原答与反馈分开标注。</p>${source('未完成的轮次和未返回的反馈不会补写。')}`)}
  <div class="space"></div>${notice('退出仍会清空本页会话；复制不等于本程序自动保存。','info')}
  ${actions(A(31,'确认结束，清空会话'),A(35,'继续留在练习中','btn secondary'))}
`,{back:62,state:'复制成功后退出或继续'});

screen(79,'重新核对课程','pages/timetable/edit/index#other-draft',`
  <div class="eyebrow">导入草稿 · 逐条修正</div><h1 style="margin-top:8px">英语听说</h1><p class="intro">原文件与草稿放在一起，<br>可继续修改地点或上课安排。</p>
  ${sourceFragment('Excel',{course:'英语听说',slot:'周五<br>7–8 节',place:'A302',cell:'C12'})}
  ${field('草稿地点（可修改）','博雅楼 A302')}${field('星期与节次（可修改）','周五 · 第 7–8 节　⌄')}${field('上课周次','第 1–16 周　⌄')}
  ${actions(A(69,'确认这条，返回导入清单'),A(76,'取消修改，返回清单','btn secondary'))}
`,{back:76,state:'非疑点课程的重新核对',compact:true});

// Delivery metadata and static contact-sheet index; no JS in any design HTML.
writeFileSync(join(root,'screens.json'),JSON.stringify(pages,null,2)+'\n');
console.log(`Generated ${pages.length} static design screens.`);
