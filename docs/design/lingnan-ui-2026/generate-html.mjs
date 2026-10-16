import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { screens, iconSvg } from './design-data.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export const nameOf=s=>`${s.id}-${({ '01':'home','02':'timetable-empty','03':'timetable-week','04':'course-detail','05':'import','06':'draft','07':'recognition','08':'correction','09':'replace-confirm','10':'course-edit','11':'course-manage','12':'settings','13':'assistant','14':'change-confirm','15':'assistant-failure','16':'departments','17':'department-detail','18':'department-qa','19':'news','20':'news-detail','21':'goals','22':'goal-edit','23':'calendar','24':'fitness-input','25':'fitness-result','26':'fitness-incomplete','27':'advancement','28':'advancement-source','29':'advancement-fallback','30':'defense-materials','31':'defense-practice','32':'defense-pending','33':'defense-feedback','34':'news-recovery','35':'copy-feedback','36':'delete-confirm','37':'exit-confirm','38':'defense-failure','39':'defense-round2','40':'defense-review','41':'defense-reanswer','42':'defense-done','43':'course-saved','44':'course-deleted','45':'assistant-safety','46':'assistant-quota','47':'goals-empty','48':'news-empty','49':'import-failure','50':'course-invalid','51':'goal-delete-confirm','52':'defense-round3','53':'defense-feedback2','54':'defense-feedback3','55':'timetable-dense'})[s.id]}.html`;
const names=Object.fromEntries(screens.map(s=>[s.id,nameOf(s)]));
const href=id=>esc(names[id]||names['01']);
const link=(id,body,cls='')=>`<a class="${cls}" href="${href(id)}">${body}</a>`;
function render(b){switch(b.type){
 case'brand':return '<div class="brand official"><img src="assets/lingnan-logo-official.png" alt="广东岭南职业技术学院官方横版校徽" width="320" height="113"></div>';
 case'heroCompact':return `<section class="hero-compact"><h1>${esc(b.title)}</h1><p>${esc(b.text)}</p></section>`;
 case'weekToolbar':return `<div class="week-toolbar">${b.items.map(i=>link(i.target,esc(i.label))).join('')}</div>`;
 case'reviewLinks':return '';
 case'hero':return `<section class="hero"><div class="overline">LINGNAN / CAMPUS TOOLS</div><h1>${esc(b.title).replaceAll('\n','<br>')}</h1><p>${esc(b.text)}</p><div class="meta">${esc(b.meta)}</div></section>`;
 case'primaryEntry':return link(b.target,`<div><small>每周安排</small><h2>${esc(b.title)}</h2><p>${esc(b.text)}</p></div><div class="entry-icon">${iconSvg(b.icon,'#ffffff',30)}</div>`,'primary-entry');
 case'section':return `<div class="section"><h2>${esc(b.title)}</h2><span>${esc(b.meta)}</span></div>`;
 case'tiles':return `<div class="tiles ${b.compact?'compact':''}">${b.items.map(i=>link(i.target,`${iconSvg(i.icon)}<h3>${esc(i.title)}</h3><p>${esc(i.text)}</p>`,'tile')).join('')}</div>`;
 case'row':{const x=`${iconSvg(b.icon)}<div class="row-copy"><h3>${esc(b.title)}</h3><p>${esc(b.text)}</p></div>${b.target?'<span class="row-arrow">›</span>':''}`;return b.target?link(b.target,x,'row'):`<div class="row">${x}</div>`;}
 case'note':return `<aside class="note ${b.tone}">${b.title?`<strong>${esc(b.title)}</strong>`:''}${esc(b.text)}</aside>`;
 case'card':{const x=`<h3>${esc(b.title)}</h3><p>${esc(b.text)}</p><div class="meta">${esc(b.meta)}</div>`;return b.target?link(b.target,x,`card ${b.tone}`):`<section class="card ${b.tone}">${x}</section>`;}
 case'button':return link(b.target,esc(b.label),`btn ${b.tone}`);
 case'field':return `<div class="field"><label>${esc(b.label)}</label><div class="value">${esc(b.value)}</div>${b.hint?`<div class="hint">${esc(b.hint)}</div>`:''}${b.error?`<div class="error">${esc(b.error)}</div>`:''}</div>`;
 case'textarea':return `<div class="field textarea"><label>${esc(b.label)}</label><div class="value">${esc(b.value)||'按材料说明，不确定的写「还没验证」'}</div><div class="hint">${esc(b.hint)}</div></div>`;
 case'chips':return `<div class="chips ${b.weekdays?'weekdays':''}">${b.items.map((v,i)=>`<span class="chip ${i===b.selected?'selected':''}">${esc(v)}</span>`).join('')}</div>`;
 case'steps':return `<div class="steps">${b.items.map((v,i)=>`<div class="step ${i===b.active?'current':''}"><b>${i+1}</b><span>${esc(v)}</span></div>`).join('')}</div>`;
 case'empty':return `<section class="empty"><div class="glyph">${iconSvg(b.icon,'#8c1614',36)}</div><h2>${esc(b.title)}</h2><p>${esc(b.text)}</p></section>`;
 case'source':return `<section class="source"><h3>${esc(b.title)}</h3><p>${esc(b.text)}</p><small>${esc(b.meta)}</small></section>`;
 case'metric':return `<section class="metric"><strong>${esc(b.value)}</strong><span class="label">${esc(b.label)}</span><p>${esc(b.text)}</p></section>`;
 case'quote':return `<div class="quote"><small>${esc(b.who)}</small>${esc(b.text)}</div>`;
 case'table':return `<table class="table"><thead><tr>${b.heads.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${b.rows.map(r=>`<tr>${r.map(c=>`<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
 case'newsLead':return link(b.target,`<h2>${esc(b.title)}</h2><p>${esc(b.text)}</p>`,'news-lead');
 case'article':return `<article class="article"><h2>${esc(b.title)}</h2><div class="meta">${esc(b.meta)}</div>${b.paragraphs.map(p=>`<p>${esc(p)}</p>`).join('')}</article>`;
 case'orgHero':return `<section class="org-hero"><strong>${esc(b.mark)}</strong><h2>${esc(b.title)}</h2><p>${esc(b.text)}</p></section>`;
 case'weeknav':return `<div class="weeknav">${link('03','‹','')}<div><strong>第 8 周</strong><small>周次手动切换 · 示例</small></div>${link('03','›','')}</div>`;
 case'week':{const count=b.rows||6;const courses=b.dense?[{c:2,r:2,t:'使用JSP开发Web应用系统',l:'博雅楼B602',cl:''},{c:3,r:3,t:'数据库应用技术',l:'B305',cl:'green'},{c:4,r:4,t:'软件测试与质量保证',l:'实训楼A101',cl:'purple'},{c:5,r:5,t:'计算机网络基础',l:'A303',cl:''},{c:6,r:4,t:'大学英语',l:'B305',cl:'purple'},{c:7,r:6,t:'创新创业实践',l:'创客空间',cl:'green'},{c:8,r:7,t:'周日课程示例',l:'B602',cl:''}]:[{c:3,r:2,t:'JSP应用系统',l:'博雅楼B602',cl:''},{c:4,r:3,t:'数据库应用技术',l:'B305',cl:'green'},{c:6,r:4,t:'大学英语',l:'B305',cl:'purple'}];return `<div class="week-hint">左右滑动查看周一至周日 →</div><div class="week-scroll" tabindex="0" aria-label="横向滚动查看完整七天课表"><div class="weekgrid" style="grid-template-rows:30px repeat(${count},87.36px)"><div></div>${'一二三四五六日'.split('').map((d,i)=>`<div class="day ${i===1?'current':''}">${d}</div>`).join('')}${['1–2','3–4','5–6','7–8','9–10','11–12'].slice(0,count).map((p,r)=>`<div class="period" style="grid-column:1;grid-row:${r+2}">${p}</div>`).join('')}${courses.map(i=>`<a href="${href('04')}" class="course ${i.cl}" style="grid-column:${i.c};grid-row:${i.r}"><span class="course-name">${i.t}</span><small>${i.l}</small></a>`).join('')}</div></div>`;}

 default:throw Error(b.type);
}}
for(const s of screens){const html=`<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(s.title)} · 岭南 UI 设计提案</title><link rel="stylesheet" href="_tokens.css"><link rel="stylesheet" href="_mockup.css"><link rel="stylesheet" href="_refinements.css"></head><body><div class="status"><span>9:41</span><span>▴ ▴ ▰</span></div><nav class="navbar" aria-label="页面导航">${s.back?link(s.back,'‹','back'):'<span style="width:12px"></span>'}<div class="navtitle">${esc(s.title)}</div><span class="capsule" aria-label="微信胶囊示意">··· | ◉</span></nav><div class="design-label">静态设计提案 · 示例内容 / 非小程序运行截图</div><main class="screen ${s.kind==='home'?'home':'work'}"><header class="head"><div class="eyebrow">LINGNAN / ${s.id}</div><h1>${esc(s.title)}</h1><p class="subtitle">${esc(s.subtitle)}</p></header>${s.blocks.map(render).join('\n')}</main><footer class="footer">广东岭南职业技术学院 · 校园工具 UI 提案 · 2026-10-16</footer>${s.blocks.filter(b=>b.type==='reviewLinks').map(b=>`<aside class="review-tools"><strong>评审导航 · 不进入小程序界面</strong>${b.items.map(i=>link(i.target,esc(i.label))).join('')}</aside>`).join('')}</body></html>\n`;writeFileSync(join(root,nameOf(s)),html);}
writeFileSync(join(root,'screens.json'),JSON.stringify(screens.map(s=>({...s,file:names[s.id]})),null,2)+'\n');
console.log(`已生成 ${screens.length} 张静态 HTML；无脚本、无真实业务调用。`);
