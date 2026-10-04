/* Camera details bind to the same live demonstration state; no slide screenshots are used. */
'use strict';
const cinemaRender=render;
const cinemaModal=modal;
modal=function(s,t){let html=cinemaModal(s,t);if(s.modal==='saveConfirm'&&s.saved.length){html=html.replace('确认保存课表？','确认替换已有课表？').replace('class="primary">确认保存','class="primary">确认替换课表');}return html;};
stage.insertAdjacentHTML('beforeend','<div id="focus-lens" class="focus-lens" hidden></div><div id="focus-camera-label" class="focus-camera-label" hidden>操作与结果细节</div><div id="cinema-course-flash" class="cinema-course-flash" hidden></div>');
document.body.classList.add('cinema-mode');
function lensMarkup(heading,main,fields,foot){return `<div class="focus-heading">${heading}</div><div class="focus-main">${escapeHtml(main)}</div><div class="focus-grid">${fields.map(x=>`<div><span>${escapeHtml(x[0])}</span><b>${escapeHtml(x[1])}</b></div>`).join('')}</div><div class="focus-foot">${escapeHtml(foot)}</div>`;}
render=function(t,manualState=null){
 const lens=document.getElementById('focus-lens');lens.innerHTML='';lens.hidden=true;document.getElementById('focus-camera-label').hidden=true;
 const result=cinemaRender(t,manualState),f=MODEL.features.find(x=>t>=x.start&&t<x.end);let html='',start=t;
 if(!mobileMode()){
  if(state.modal==='edit'&&t>=32&&t<36.5){html=lensMarkup('校对课程草稿','数据库应用',[['正在输入的地点',state.location||'待填写'],['星期与节次','周三第5–6节']],'保存修正之前，草稿不会写入个人课表。');start=32;}
  if(state.proposal){const c=state.proposal;html=lensMarkup('AI变更提案 · 等待本人确认',c.name,[['星期与节次','周'+dayNames[c.day]+'第'+c.start+'–'+c.end+'节'],['地点',c.location],['适用周次','第1–16周'],['当前课程数',state.saved.length+'门']],'核对字段，由本人确认后才执行。');start=109;}
  if(f?.id==='change'&&t>=114){const c=state.saved.find(c=>c.id===7);if(c){html=lensMarkup('确认后的演示结果','已新增：'+c.name,[['课程总数',state.saved.length+'门'],['星期与节次','周四第9–10节'],['适用周次','第1–16周'],['地点',c.location]],'新课程已出现在右侧周课表。');start=114;}}
  if(f?.id==='week'&&t>=79){const c=state.saved.find(c=>c.name==='自主学习'),changed=state.saved.find(c=>c.id===2);if(c&&changed){html=lensMarkup('手工维护后的演示结果','课表已有'+state.saved.length+'门课程',[['新增课程',c.name],['时间与地点','周三9–10节 · '+c.location],['修改课程',changed.name],['新地点',changed.location]],'适用第1–16周；完整信息也可在课程列表查看。');start=79;}}
  if(f?.id==='query'&&t>=94){html=lensMarkup('按已保存课表查阅','第'+state.week+'周星期三',[['第5–6节','数据库应用 · B308'],['第9–10节','自主学习 · B301']],'模拟回答仅依据演示中已保存的个人课程。');start=94;}
  if(f?.id==='department'&&t>=136.5&&state.modal==='deptChat'){html=lensMarkup('部门资料答疑 · 固定模拟响应','4个下设部门',[['组织','校学生团委'],['下设部门','秘书处、组织部、宣传部、广播台']],'回答依据已登记官网资料；可在右侧核对原资料。');start=136.5;}
  if(f?.id==='fitness'&&t>=200){html=lensMarkup('合成输入的参考结果','81 参考分',[['输入项目','七项齐全'],['依据入口','七项分数与权重']],'这是一组参考估算，不代表学校正式成绩。');start=200;}
  if(state.modal==='departmentSource'){html=lensMarkup('原资料核对','学生组织机构简介',[['来源','学校官网 · 团委'],['登记核查','2026-09-18']],'资料日期未标注；没有公布的信息不补猜。');start=139;}
 }
 if(html){lens.hidden=false;lens.innerHTML=html;const enter=ease((t-start)/.55);lens.style.opacity=enter;lens.style.transform=`translateY(${(1-enter)*13}px)`;document.getElementById('focus-camera-label').hidden=false;document.getElementById('action-readout').style.visibility='hidden';document.getElementById('result-panel').style.visibility='hidden';}
 else{document.getElementById('action-readout').style.visibility='visible';document.getElementById('result-panel').style.visibility='visible';}
 const halo=document.getElementById('cinema-course-flash');halo.hidden=true;
 if(!mobileMode()&&t>=114&&t<118){const target=document.getElementById('course-7');if(target){const r=target.getBoundingClientRect(),s=stage.getBoundingClientRect(),scale=s.width/1600;halo.hidden=false;halo.style.left=(r.left-s.left)/scale-3+'px';halo.style.top=(r.top-s.top)/scale-3+'px';halo.style.width=r.width/scale+6+'px';halo.style.height=r.height/scale+6+'px';halo.style.opacity=.65+.3*Math.sin((t-114)*Math.PI);}}
 return result;
};
soundtrack.src=document.body.classList.contains('export')?'':'../校园工具-纯代码动画与自然配音-v7.mp4';
window.demoVersion='v7';render(currentTime);
