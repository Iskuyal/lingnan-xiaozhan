/* v8 镜头层：叠在 v7 渲染链之上，按手机内元素的实时坐标做推近；手机只做 translate + scale。 */
'use strict';
const v8Base=render;
const v8Stage=document.getElementById('stage'),v8Phone=document.getElementById('phone');
const V8_ANCHOR={x:1090,y:450,fx:205,pano:401};
// [起, 止, 镜头焦点, 倍数上限, 高亮, 高亮标签(|分隔), 批注标题, 批注正文]；焦点与高亮为手机内选择器，逗号分隔多个
const V8_SHOTS=[
[0,6,'',1,'','',0,0],
[6,9,'',1,'#home-timetable','',0,0],
[9,14,'#home-timetable,#home-goals',2,'#home-timetable','','六个入口','课表、部门、资讯、校历、体测、目标日，一屏可见。'],
[14,18,'#home-timetable,#home-goals',2,'','',0,0],
[18,21,'',1,'#home-timetable','',0,0],
[21,24,'#choose-excel,#choose-image',2.2,'#choose-excel','','两种导入方式','从聊天选 Excel，或使用课表截图。'],
[24,26,'#pick-file',2.2,'#pick-file','','选择课表文件','演示文件是合成数据，不含真实学生信息。'],
[26,29,'',1,'','','读取并整理','把文件内容整理成课程草稿。'],
[29,32,'#edit-1,#edit-4',1.9,'#edit-2','','先看草稿，不直接保存','逐门核对；地点缺失的一门待修正。'],
[32,36.5,'#location-input',2.2,'#location-input','','只改这一项','补上 B305，其他字段保持不变。'],
[36.5,38,'#draft-save,#draft-abandon',2.2,'#draft-save','','确认保存','点“确认保存”进入最后一步。'],
[38,40,'#save-cancel,#save-confirm',2.2,'#save-confirm','','确认前不写入','取消不改变课表；确认后才保存 6 门课程。'],
[40,45,'.grid',2.2,'#course-2','地点 B305','',0],
[45,49,'#choose-excel,#choose-image',2.2,'#choose-image','','改用课表截图','没有 Excel 时，拍照或选择课表图片。'],
[49,52,'#pick-photo',1.9,'#pick-photo','','选一张课表截图','演示图片是代码绘制的合成课表。'],
[52,54,'',1,'','','识别为草稿','演示使用固定识别结果，未调用真实模型。'],
[54,57,'#edit-1,#edit-4',1.9,'#edit-2','','识别后人工校对','逐门核对课程、节次和地点，再决定保存。'],
[57,59,'#save-cancel,#save-confirm',2.2,'#save-confirm','','确认替换课表','已有课表会被这份草稿替换，确认后才生效。'],
[59,63,'.grid',2.2,'','',0,0],
[63,66,'#week-prev,#week-next,.grid',1.8,'#week-next','',0,0],
[66,68,'#week-prev,#week-next,.grid',1.8,'#week-next','','按教学周查看','点右上角箭头，切到下一周。'],
[68,70,'.sheet',2,'.sheet','','点开一门课','详情在底部展开：星期、节次、地点。'],
[70,71,'.grid,#week-edit',1.8,'#week-edit','','',0],
[71,73,'.sheet',1.9,'#manual-name','','手工新增','不依赖导入，也能补一门临时课程。'],
[73,75,'.sheet',1.9,'#manual-location','','自主学习 · B301','填好名称与地点，保存进入周课表。'],
[75,76.5,'.grid',2,'#course-106','','新增后立即可见','自主学习出现在周三第 9–10 节。'],
[76.5,79,'#location-input',2.2,'#location-input','','改一间教室','数据库应用：B305 → B308。'],
[79,83,'.grid',2.2,'#course-106,#course-2','新增：自主学习|B308','',0],
[83,86,'#week-edit,#assistant-open',2.2,'#assistant-open','',0,0],
[86,91,'.sheet',2,'#chat-input','','像聊天一样查课','输入“周三有什么课？”，助手按已保存课表回答。'],
[91,94,'.sheet',2,'','','依据已有课表','回答只依据个人课表，不超出范围。'],
[94,99,'.sheet',2,'.sheet .bubble:not(.user)','','',0],
[99,102,'.sheet',2,'#chat-input','',0,0],
[102,106,'.sheet',2,'#chat-input','','提出增改要求','“周四第9–10节加项目实践，地点B408”。'],
[106,109,'.sheet',2,'#chat-send','','发送要求','这一步只生成提案，不改动课表。'],
[109,114,'.proposal,#apply-course',2,'#apply-course','','先给提案，再确认','点“确认新增”才执行；取消则课表不变。'],
[114,121,'.grid',2.2,'#course-7','项目实践 · B408','',0],
[121,122,'#home-departments,#home-news',2,'#home-departments','',0,0],
[122,125,'#department-0,#department-4',2,'#department-0','',0,0],
[125,128,'#dept-ask',1.8,'#dept-ask','','进入组织页','先看职责和下设部门，再提问。'],
[128,133,'.sheet',2,'#chat-input','','围绕资料追问','答案依据已登记的官网资料。'],
[133,136.5,'.sheet',2,'','','没有公布的不补猜','资料里没有的信息，如实说明。'],
[136.5,139,'.sheet',2,'#department-source','','',0],
[139,141.2,'.sheet',2,'#department-copy','','',0],
[141.2,143,'.sheet',2,'#department-source','','',0],
[143,147,'#news-0',2.2,'#news-0','',0,0],
[147,150,'',1.4,'','','进入文章','历史公开文章摘要，非当前新闻。'],
[150,153,'#article-source',2,'#article-source','','正文之后是来源','滑到底就能看到原文来源入口。'],
[153,155,'#article-source',2.2,'#article-source','','复制来源链接','演示反馈，不操作系统剪贴板。'],
[155,161,'#article-source',2,'#article-source','','',0],
[161,164,'#goal-new',2.2,'#goal-new','',0,0],
[164,167,'.sheet',2,'#goal-save','','填目标名称与日期','目标日只保存在本机，不联网。'],
[167,176,'.goal-card',2.2,'.goal-card','','',0],
[176,179,'#calendar-cet',2.2,'#calendar-cet','',0,0],
[179,182,'.sheet',2,'','','日期与适用范围','登记日期与适用范围写在一起，不替官方下结论。'],
[182,190,'.sheet',2,'#calendar-source','','',0],
[190,193,'#fit-0,#fit-6',2.2,'','',0,0],
[193,197,'#fit-0,#fit-6',2.2,'#fit-0','','七项合成成绩','选择年级组，填入七项合成成绩。'],
[197,200,'.page-inner',1.5,'','','计算参考分','按登记规则在本机估算。'],
[200,208,'.score,#fitness-rules',2.2,'#fitness-rules','','',0],
[208,211,'#advancement-send',2.2,'#advancement-send','',0,0],
[211,215,'#advancement-send,#scope-select',2,'#scope-select','','先澄清范围','类别、年份与地区确定后再查资料。'],
[215,218,'.sheet',2,'#scope-search','','只查已收录资料','模糊问题先收窄，不凭印象回答。'],
[218,220,'.notice',2,'','','原文与出处','结果带官方摘录和出处。'],
[220,222,'.source-link',1.9,'#advancement-source','','原文与出处','结果带官方摘录和出处。'],
[222,228,'#advancement-source,.original-excerpt',1.9,'#advancement-source','','',0],
[228,234.1,'',1,'','',0,0]
];
const v8Cams=[];
const v8IO=x=>x<=0?0:x>=1?1:x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;
const v8Cat=id=>['excel','photo','week','query','change'].includes(id)?'个人课表':['home','department','news'].includes(id)?'校园信息':'日常工具';
function v8Reset(){v8Phone.style.left='0px';v8Phone.style.top='0px';v8Phone.style.transformOrigin='0 0';v8Phone.style.transform='none';}
function v8Boxes(sel,last){
 const p=v8Phone.getBoundingClientRect(),k=p.width/410,out=[];
 for(const part of sel.split(',')){const q=part.trim();if(!q)continue;const list=[...document.querySelectorAll(q)];for(const el of(last?list.slice(-1):list)){const r=el.getBoundingClientRect();if(r.width<1||r.height<1)continue;out.push({x:(r.left-p.left)/k,y:(r.top-p.top)/k,w:r.width/k,h:r.height/k});}}
 return out;}
function v8Measure(i){
 const sh=V8_SHOTS[i];if(!sh[2])return{s:sh[3],fy:V8_ANCHOR.pano};
 v8Base(sh[0]+Math.min(1.4,(sh[1]-sh[0])*.8));v8Reset();
 const bs=v8Boxes(sh[2],false);
 if(!bs.length){(window.v8Misses=window.v8Misses||[]).push([sh[0],sh[2]]);return null;}
 const y0=Math.min(...bs.map(b=>b.y)),y1=Math.max(...bs.map(b=>b.y+b.h)),x0=Math.min(...bs.map(b=>b.x)),x1=Math.max(...bs.map(b=>b.x+b.w));
 const s=Math.max(1,Math.min(sh[3],760/(y1-y0+48),880/(x1-x0+40)));
 return{s,fy:Math.max(400/s,Math.min(802-400/s,(y0+y1)/2))};}
function v8Build(){const keep=currentTime;let prev={s:1,fy:V8_ANCHOR.pano};for(let i=0;i<V8_SHOTS.length;i++){const c=v8Measure(i)||prev;v8Cams[i]=c;prev=c;}v8Base(keep);}
v8Stage.insertAdjacentHTML('afterbegin','<div class="v8-backdrop"></div>');
v8Stage.insertAdjacentHTML('beforeend','<div id="v8-layer" class="v8-layer"><div class="v8-rail"><i></i><b>校园工具</b><em>微信小程序 · 代码复现演示</em></div><div id="v8-left"></div><svg id="v8-leader" class="v8-leader" viewBox="0 0 1600 900"></svg><div id="v8-marks"></div><div id="v8-lockup" class="v8-lockup"><span class="mark"></span><h1>校园工具</h1><p>读资讯，找组织，查课表。</p></div><div id="v8-outro" class="v8-outro"></div><div id="v8-cover-id" class="v8-identity">代码复现演示 · 合成示例与模拟AI响应 · 非真机录屏</div></div>');
const v8$=id=>document.getElementById(id);
function v8Outro(t){const o=v8$('v8-outro'),a=ease((t-228)/.8);o.style.display=t>=228?'block':'none';o.style.opacity=a;
 if(t>=228&&!o.dataset.ready){o.dataset.ready='1';o.innerHTML='<div class="v8-lockup" style="top:70px"><span class="mark"></span><h1>校园工具</h1><p>读资讯，找组织，查课表。</p></div><div class="chips">'+MODEL.features.map((f,i)=>`<span><b>${String(i+1).padStart(2,'0')}</b>${escapeHtml(f.title)}</span>`).join('')+'</div><div class="v8-boundary">代码复现演示 · 合成示例与模拟AI响应 · 非真机录屏；升学问答效果仍待独立验收</div>';}}
function v8Apply(t){
 let i=V8_SHOTS.findIndex(s=>t>=s[0]&&t<s[1]);if(i<0)i=V8_SHOTS.length-1;
 const sh=V8_SHOTS[i],cam=v8Cams[i]||{s:1,fy:V8_ANCHOR.pano},tt=t-sh[0];let s=cam.s,fy=cam.fy;
 if(i>0&&tt<.9){const pc=v8Cams[i-1]||cam,e=v8IO(tt/.9);s=pc.s*Math.pow(cam.s/pc.s,e);fy=pc.fy+(cam.fy-pc.fy)*e;}
 const dx=Math.sin(t*.6)*3,dy=Math.cos(t*.45)*3;
 v8Phone.style.left='0px';v8Phone.style.top='0px';v8Phone.style.transformOrigin='0 0';
 v8Phone.style.transform=`translate(${V8_ANCHOR.x-s*V8_ANCHOR.fx+dx}px,${V8_ANCHOR.y-s*fy+dy}px) scale(${s})`;
 v8Phone.style.opacity=t<3.4?0:t<5.4?ease((t-3.4)/2):t>=228?1-ease((t-228)/.8):1;
 const f=MODEL.features.find(x=>t>=x.start&&t<x.end);
 const lock=v8$('v8-lockup'),mv=ease((t-3.2)/1.2);lock.style.display=t<6?'block':'none';lock.style.opacity=t<3.2?ease(t/.8):t<5.4?1:1-ease((t-5.4)/.6);lock.style.transform=`translate(${-472*mv}px,0) scale(${1-.3*mv})`;v8$('v8-cover-id').style.display=t<6?'flex':'none';
 v8Outro(t);
 const left=v8$('v8-left'),marks=v8$('v8-marks'),leader=v8$('v8-leader');leader.innerHTML='';marks.innerHTML='';
 if(!f){left.innerHTML='';return;}
 const idx=MODEL.features.indexOf(f),phase=t<f.process?0:t<f.result?1:2,enter=ease((t-f.start)/.5);
 let step=phase===1?Math.min(2,Math.floor((t-f.process)/(f.result-f.process)*3)):0;
 if(f.id==='photo'||f.id==='excel')step=(state.route==='import'||state.modal==='photoPicker'||state.modal==='picker'||(state.route==='processing'&&f.id==='excel'))?0:(state.modal==='saveConfirm'||state.route==='week')?2:1;
 if(f.id==='change')step=state.modal!=='chat'?2:state.proposal?1:0;
 const phases=['介绍','过程','结果'].map((x,j)=>`<span class="${phase===j?'on':phase>j?'done':''}"><small>${String(j+1).padStart(2,'0')}</small>${x}</span>`).join('');
 let slot;
 if(phase===0)slot=`<div class="s-label">使用场景</div><div class="s-text">${escapeHtml(f.scenario)}</div><div class="s-sub">${escapeHtml(f.intro)}</div>`;
 else if(phase===1)slot=`<ul class="steps">${f.steps.map((x,j)=>`<li class="${j<step?'done':j===step?'now':''}"><span class="node">${j<step?'✓':j+1}</span>${escapeHtml(x)}</li>`).join('')}</ul>`;
 else slot=`<div class="s-label">最终结果</div><div class="r-main">${escapeHtml(f.outcome)}</div><div class="delta">${f.delta.split('；').map(r=>`<div class="row">${r.split(' → ').map((x,j,a)=>`<span class="chip${j===a.length-1?' to':''}">${escapeHtml(x)}</span>`).join('<span class="arrow">→</span>')}</div>`).join('')}</div><div class="s-sub">${escapeHtml(f.detail)}</div>`;
 const call=phase===1&&sh[6]?`<aside id="v8-callout" class="v8-callout"><h3>${escapeHtml(sh[6])}</h3><p>${escapeHtml(sh[7])}</p></aside>`:'';
 const prog=MODEL.features.map((x,j)=>`<i class="${j<idx?'done':j===idx?'now':''}" style="flex:${x.end-x.start}${j===idx?`;--p:${Math.round(100*(t-f.start)/(f.end-f.start))}%`:''}"></i>`).join('');
 left.innerHTML=`<div style="opacity:${enter}"><div class="v8-counter"><b>${String(idx+1).padStart(2,'0')}</b><i>/ ${MODEL.features.length}</i><em>${v8Cat(f.id)}</em></div><h1 class="v8-title">${escapeHtml(f.title)}</h1><nav class="v8-phases">${phases}</nav><section class="v8-slot">${slot}</section>${call}</div><div class="v8-identity">${escapeHtml(f.note)}</div><div class="v8-progress">${prog}</div>`;
 if(!sh[4])return;
 const st=v8Stage.getBoundingClientRect(),sc=st.width/1600,p=v8Phone.getBoundingClientRect(),show=ease((tt-.55)/.35);
 const tags=(sh[5]||'').split('|'),boxes=[];
 sh[4].split(',').forEach((q,n)=>{const el=[...document.querySelectorAll(q.trim())].slice(-1)[0];if(!el)return;const r=el.getBoundingClientRect();boxes.push({l:(r.left-st.left)/sc-8,t:(r.top-st.top)/sc-8,w:r.width/sc+16,h:r.height/sc+16,tag:tags[n]||''});});
 marks.style.opacity=show;
 marks.innerHTML=boxes.map(b=>`<div class="v8-hl" style="left:${b.l}px;top:${b.t}px;width:${b.w}px;height:${b.h}px"></div>`+(b.tag?`<div class="v8-hl-tag" style="left:${b.l}px;top:${b.t>44?b.t-38:b.t+b.h+8}px">${escapeHtml(b.tag)}</div>`:'')).join('');
 const co=v8$('v8-callout');
 if(co&&boxes.length){const b=boxes[0],cy=664+co.offsetHeight/2,hy=Math.max(40,Math.min(860,b.t+b.h/2));if(b.l>636){leader.style.opacity=show;leader.innerHTML=`<path d="M568 ${cy} H612 V${hy} H${b.l}"/><circle cx="${b.l}" cy="${hy}" r="7"/>`;}}
}
render=function(t,manualState=null){
 const mobile=mobileMode();document.body.classList.toggle('v8',!mobile);
 const result=v8Base(t,manualState);
 if(!mobile)v8Apply(currentTime);
 return result;
};
document.body.classList.add('v8');
if(!mobileMode())v8Build();
window.demoVersion='v8';window.v8Cams=v8Cams;window.v8Shots=V8_SHOTS;
render(currentTime);
