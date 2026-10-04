/* Targeted v6 refinements: visible evidence controls, student scenarios and complete course details. */
'use strict';
const v6Reduce=reduce,v6Modal=modal,v6Render=render,v6Grid=grid;
reduce=function(s,action,payload={}){
 if(action==='close'&&s.modal==='departmentSource')return {...structuredClone(s),modal:'deptChat',toast:''};
 if(action==='selectFitnessGroup')return {...structuredClone(s),fitGroup:payload.value===undefined?'male-lower':payload.value,toast:''};
 if(action==='fitnessResult'&&!s.fitGroup)return {...structuredClone(s),toast:'请先选择本片演示的性别与年级组。'};
 if(action==='fitnessRules'||action==='courseList'||action==='departmentSource')return {...structuredClone(s),modal:action};
 if(action==='courseDetail'){const next=v6Reduce(s,action,payload);next.selectedCourseID=payload.id||2;return next;}
 return v6Reduce(s,action,payload);
};
grid=function(s){return v6Grid(s).replace(/id="course-(\d+)"/g,'id="course-$1" data-course-id="$1"');};
modal=function(s,t){
 if(s.modal==='departmentSource')return `<div class="sheet-shadow"></div><div class="sheet"><div class="sheet-title">原资料依据</div><div class="source-link"><b>学生组织机构简介</b><p>发布机构：学校官网 · 团委</p><p>资料日期：官网未标注<br>登记核查：2026-09-18</p><div class="muted">lnc.edu.cn/tw/sygk/xszz</div></div><div class="notice">组织名录与简介依据已登记公开资料；联系方式未公布，不补猜。</div>${sourceControl('department-copy','复制原资料链接（演示）')}<div class="spacer"></div>${button('department-source-close','close','返回问答','secondary')}</div>`;
 if(s.modal==='fitnessRules')return `<div class="sheet-shadow"></div><div class="sheet rules-sheet"><div class="sheet-title">七项参考评分依据</div><div class="muted">演示使用已登记的大学组权重，七项合成数据。</div>${fitItems.map(x=>`<div class="kv"><span>${x[0]}</span><strong>${x[1]}分 × ${x[2]}%</strong></div>`).join('')}<div class="notice">加权参考分81。学校采用口径、最低档处理与正式成绩仍需另核对。</div>${button('rules-close','close','返回估算结果','secondary')}</div>`;
 if(s.modal==='courseList')return `<div class="sheet-shadow"></div><div class="sheet list-sheet"><div class="sheet-title">第${s.week}周课程列表</div>${s.saved.map(c=>`<button data-course-id="${c.id}" data-action="courseDetail" class="full-course"><b>${escapeHtml(c.name)}</b><span>周${dayNames[c.day]} · 第${c.start}–${c.end}节 · ${escapeHtml(c.location)}</span></button>`).join('')}<div class="spacer"></div>${button('list-close','close','返回周课表','secondary')}</div>`;
 if(s.modal==='course'){
  const c=s.saved.find(c=>c.id===(s.selectedCourseID||2));
  if(c)return `<div class="sheet-shadow"></div><div class="sheet"><div class="sheet-title">${escapeHtml(c.name)}</div><div class="kv"><span>星期 / 节次</span><strong>周${dayNames[c.day]} · 第${c.start}–${c.end}节</strong></div><div class="kv"><span>教学周</span><strong>第1–16周</strong></div><div class="kv"><span>上课地点</span><strong>${escapeHtml(c.location)}</strong></div><div class="kv"><span>来源</span><strong>合成演示数据</strong></div><div class="spacer"></div>${button('sheet-close','close','返回课表','secondary')}</div>`;
 }
 return v6Modal(s,t);
};
function sourceControl(id,text){return button(id,'copySource',text,'secondary evidence-action');}
function insertEvidenceControls(){
 const page=document.querySelector('.app-page .page-inner');if(!page)return;
 if(state.route==='article'&&state.newsResult){
  page.querySelector('#article-source')?.remove();
  const title=page.querySelector('.article-title');
  title.insertAdjacentHTML('afterend',`<div class="evidence-inline"><span>学校官网 · 2026-09-12</span>${sourceControl('article-source','核对原文来源')}</div>`);
 }
 if(state.route==='advancement'&&state.advancementResult){
  page.querySelector('#advancement-source')?.remove();page.querySelector('#advancement-send')?.remove();page.querySelector('.field')?.remove();page.querySelector('.spacer')?.remove();
  const original=page.querySelector('.source-link');
  original.insertAdjacentHTML('beforebegin',`<div class="evidence-inline"><span>2026年 · 广东 · 普通专升本</span>${sourceControl('advancement-source','核对官方出处')}</div>`);
 }
 if(state.route==='fitness'&&state.fitness){
  page.classList.add('v6-fitness-result');
  page.querySelector('.score').insertAdjacentHTML('afterend',button('fitness-rules','fitnessRules','查看七项评分依据','secondary evidence-action'));
 }
 if(state.route==='fitness'&&!state.fitness){
  const heading=page.querySelector('.h2');heading.insertAdjacentHTML('afterend',`<div class="fitness-group-control"><label for="fitness-group">选择性别与大学年级组</label><select id="fitness-group"><option value="">请选择演示组别</option><option value="male-lower" ${state.fitGroup==='male-lower'?'selected':''}>男生 · 大一 / 大二（本片样例）</option></select></div>`);
 }
 if(state.modal==='deptChat'&&state.messages.some(m=>m.role==='assistant')){
  document.querySelector('.sheet .bubble:not(.user)')?.insertAdjacentHTML('beforeend',`<div class="department-evidence"><span>学生组织机构简介 · 学校官网团委<br>登记核查：2026-09-18</span>${button('department-source','departmentSource','核对原资料','secondary evidence-action')}</div>`);
 }
 if(state.route==='week'&&!state.modal){
  page.querySelector('.section')?.insertAdjacentHTML('beforeend',button('week-list','courseList','课程列表','week-list-control'));
  page.querySelector('.grid-legend').textContent='点课程块查看完整名称与地点；也可切换课程列表。';
  const changed=state.saved.find(c=>c.id===2),manualCourse=state.saved.find(c=>c.name==='自主学习');
  if(changed&&manualCourse)page.querySelector('.grid').insertAdjacentHTML('beforebegin',`<div class="mobile-course-recap"><b>本次保存的课程结果</b><span>修改：${escapeHtml(changed.name)}</span><small>周${dayNames[changed.day]} · 第${changed.start}–${changed.end}节 · 第1–16周 · ${escapeHtml(changed.location)}</small><span>新增：${escapeHtml(manualCourse.name)}</span><small>周${dayNames[manualCourse.day]} · 第${manualCourse.start}–${manualCourse.end}节 · 第1–16周 · ${escapeHtml(manualCourse.location)}</small></div>`);
 }
}
render=function(t,manualState=null){
 const result=v6Render(t,manualState),f=MODEL.features.find(x=>t>=x.start&&t<x.end);
 if(f){
  if(t<f.process)document.getElementById('action-readout').innerHTML=`<b>学生使用场景</b><div class="scenario-copy">${escapeHtml(f.scenario||f.intro)}</div>`;
  if(t>=f.result&&t<f.end){document.getElementById('caption').textContent=f.delta||f.outcome;document.getElementById('caption').classList.add('result-change');}
  else document.getElementById('caption').classList.remove('result-change');
 }
 insertEvidenceControls();
 if(mobileMode()&&f){const phase=t<f.process?0:t<f.result?1:2;document.getElementById('phone').style.top=(phase===0?292:phase===1?242:212)+'px';}
 else document.getElementById('phone').style.top='41px';
 return result;
};
document.getElementById('viewport').addEventListener('click',e=>{
 const target=e.target.closest('[data-course-id]');if(!target)return;
 e.stopImmediatePropagation();e.preventDefault();manual=true;playing=false;soundtrack.pause();document.getElementById('play').textContent='播放';
 state=reduce(state,'courseDetail',{id:Number(target.dataset.courseId)});render(currentTime,state);
},true);
document.getElementById('viewport').addEventListener('change',e=>{if(e.target.id!=='fitness-group')return;manual=true;playing=false;soundtrack.pause();state=reduce(state,'selectFitnessGroup',{value:e.target.value});render(currentTime,state);document.getElementById('play').textContent='播放';});
soundtrack.src=document.body.classList.contains('export')?'':'../校园工具-产品演示优化-v6.mp4';
window.demoVersion='v6';render(currentTime);
