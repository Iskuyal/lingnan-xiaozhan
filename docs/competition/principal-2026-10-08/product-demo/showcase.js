/* v5 presentation layer: every feature has an introduction, a task, and an observable result. */
'use strict';
const MODEL=window.SHOWCASE;
events.splice(0,events.length,...MODEL.events);
chapters.splice(0,chapters.length,{at:0,label:'校园工具',title:'校园信息\n与个人安排',copy:'在微信里读资讯、找组织、管理课表。',detail:''},...MODEL.features.map(f=>({at:f.start,label:f.title,title:f.title,copy:f.intro,detail:f.note})));
voices.splice(0,voices.length,...MODEL.voices);
captions.splice(0,captions.length,...MODEL.features.map(f=>({from:f.result+.2,to:f.end-.2,text:f.outcome+'。'})));
const baseReduce=reduce,baseContent=content,baseModal=modal,baseRender=render;
reduce=function(s,action,payload={}){
 let next=structuredClone(s);
 switch(action){
 case 'homeFocus':case 'homeResult':case 'deptResult':return next;
 case 'newsResult':next.newsResult=true;next.articleScroll=false;next.toast='';return next;
 case 'importPhoto':next.route='import';next.modal='';next.importMode='photo';next.toast='';return next;
 case 'photoPicker':next.modal='photoPicker';return next;
 case 'recognize':next.modal='';next.route='processing';next.importMode='photo';return next;
 case 'draftPhoto':next=baseReduce(next,'draft');next.importMode='photo';next.draft.find(c=>c.id===2).location='B305';return next;
 case 'fillManual':next.manualName='自主学习';next.manualLocation='B301';return next;
 case 'saveManual':return baseReduce(next,action,{name:payload.name||next.manualName||'自主学习',location:payload.location||next.manualLocation||'B301'});
 case 'manualEdit':next.modal='manualEdit';next.location='B308';return next;
 case 'saveManualEdit':next.saved.find(c=>c.id===2).location=payload.location||next.location;next.modal='';next.toast='课程地点已更新为'+(payload.location||next.location);return next;
 case 'answerQuery':next.thinking=false;next.messages.push({role:'assistant',text:`第${next.week}周星期三，第5–6节有数据库应用，地点${next.saved.find(c=>c.id===2)?.location||'B308'}；第9–10节有自主学习，地点B301。`,source:'依据：已保存的个人课表 · 模拟回答'});return next;
 case 'answerDept':next.thinking=false;next.messages.push({role:'assistant',text:'校学生团委下设秘书处、组织部、宣传部、广播台。官网未公布的联系方式不补猜。',source:'依据：学校官网 · 团委 · 学生组织'});return next;
 case 'calendarDetail':next.modal='calendar';return next;
 case 'copyCalendar':next.toast='官方出处已显示，可继续核对';return next;
 case 'fillFitness':next.fitnessFilled=true;return next;
 case 'advancementScope':next.modal='scope';return next;
 case 'searchAdvancement':next.modal='';next.advancementLoading=true;return next;
 case 'advancementResult':next.advancementLoading=false;next.advancementResult=true;return next;
 case 'save':next=baseReduce(next,action,payload);next.importMode=next.importMode||'excel';next.toast='课表已保存 · 6门课程';return next;
 case 'apply':next=baseReduce(next,action,payload);next.toast='确认新增成功 · 共'+next.saved.length+'门课程';return next;
 case 'clarify':next.clarify=true;return next;
 default:return baseReduce(s,action,payload);
 }
};
grid=function(s){
 const width=document.querySelector('.screen').clientWidth-42,unit=(width-22)/5;
 let h='<div class="grid"><div class="grid-head"></div>';
 for(let n=1;n<=5;n++)h+=`<div class="grid-head">星期${dayNames[n]}</div>`;
 for(let n=1;n<=10;n++)h+=`<div class="grid-num" style="grid-row:${n+1}">${n}</div>`;
 for(let n=0;n<5;n++)h+=`<div class="grid-line" style="left:${22+n*unit}px"></div>`;
 for(const c of s.saved)h+=`<button id="course-${c.id}" data-action="courseDetail" class="block ${c.color}" style="left:${23+(c.day-1)*unit}px;top:${29+(c.start-1)*30}px;width:${unit-1}px;height:${(c.end-c.start+1)*30-1}px"><strong>${c.name}</strong>${c.location}</button>`;
 return h+'</div>';
};
function fitnessInput(s,t){const rows=[['身高 / 体重','175cm / 80kg'],['肺活量','4300ml'],['50米跑','7.0秒'],['坐位体前屈','17.7cm'],['立定跳远','248cm'],['引体向上','15次'],['1000米跑','3分42秒']];return `<div class="page-inner"><div class="tiny">大学组 · 男生大一/大二 · 合成示例</div><div class="h2">体测参考估算</div><div class="notice">填写七项成绩。参考估算不代表学校正式成绩。</div>${rows.map((x,i)=>{const value=s.fitnessFilled?x[1].slice(0,Math.ceil(x[1].length*Math.max(0,Math.min(1,(t-193-i*.27)/.5)))):'';return `<div class="kv"><label for="fit-${i}">${x[0]}</label><input id="fit-${i}" class="fit-input" value="${value}" placeholder="填写成绩"></div>`;}).join('')}<div class="spacer"></div>${button('fitness-calc','fitnessResult','计算参考分数')}<div id="fitness-input" class="tiny" style="margin-top:18px">七项齐全后显示参考总分。</div></div>`;}
const fitItems=[['体重指数（BMI）',80,15],['肺活量',80,15],['50米跑',85,20],['坐位体前屈',80,10],['立定跳远',80,10],['引体向上',80,10],['1000米跑',80,20]];
const fitTotal=fitItems.reduce((sum,x)=>sum+x[1]*x[2]/100,0);
content=function(s,t){
 if(s.route==='processing'&&s.importMode==='photo')return `<div class="page-inner" style="padding-top:86px;text-align:center"><div class="scan-picture">${miniTimetable()}</div><div class="spinner" style="transform:rotate(${t*300}deg)"></div><div class="h2">正在识别课表</div><div class="muted">图片 → 结构化课程草稿</div><div class="notice">固定模拟识别，完成后仍需逐项校对。</div></div>`;
 if(s.route==='calendar')return `<div class="page-inner"><div class="tiny">已登记资料快照 · 核查2026-09-29</div><div class="h2">校历与考试</div><div class="notice">只显示已核准日期，没有可靠日期时保留官方入口。</div><button id="calendar-cet" data-action="calendarDetail" class="calendar-card"><div class="tiny">大学英语四级口语考试</div><strong>2026-11-21</strong><div class="muted">已登记官方日期 · 查看出处　›</div></button><div class="calendar-card"><div class="tiny">学校校历</div><b>官方入口</b><div class="muted">尚无可用日期，不补猜校历。</div></div><div class="source-link">考试日期与报名截止分别核对。各考点报名安排以本考点公告为准。</div></div>`;
 if(s.route==='fitness'){if(!s.fitness)return fitnessInput(s,t);return `<div class="page-inner"><div class="tiny">大学组 · 七项合成输入</div><div class="h2">参考估算结果</div><div class="score"><strong>${fitTotal}</strong><div>良好<br><span class="tiny">加权参考总分 · 不代表正式成绩</span></div></div><div class="section" style="margin-top:17px">评分明细</div>${fitItems.map(x=>`<div class="kv"><span>${x[0]} <small style="color:var(--muted)">${x[2]}%</small></span><strong>${x[1]}分</strong></div>`).join('')}<div class="source-link">七项成绩按登记的大学组权重计算。<br>学校采用口径、最低档处理与正式成绩另核对。</div></div>`;}
 if(s.route==='article'&&s.newsResult)return `<div class="page-inner"><div class="tiny">已阅读 · 历史公开文章摘要</div><h2 class="article-title">向“新”而行，逐梦岭南——我校开展2026级新生入学教育</h2><div class="kv"><span>发布日期</span><strong>2026-09-12</strong></div><div class="kv"><span>资料来源</span><strong>学校官网 · 校园动态</strong></div><div class="article-body"><p>9月7日至11日，学校开展2026级新生入学教育，帮助新生了解校园、开启大学生活。</p><p>本片展示历史文章摘要，完整内容以官网原文为准。</p></div><div class="source-link">正文与日期、出处一起保留。<br>可复制原文链接继续核对。</div>${button('article-source','copySource','复制原文来源链接','secondary')}</div>`;
 if(s.route==='advancement')return `<div class="page-inner"><div class="tiny">有限官方资料 · 先确认适用范围</div><div class="h2">升学与实习资料</div><div class="notice">2026历史资料样例。模型独立效果仍待验收。</div><div class="field">专升本什么时候报名？</div><div class="spacer"></div>${button('advancement-send','clarify','提问')}${s.advancementLoading?'<div class="thinking">正在查询已收录官方资料…</div>':s.advancementResult?`<div class="source-link"><b>2026年 · 广东 · 普通专升本</b><div style="margin-top:9px">原文摘录</div><div class="original-excerpt">网上预报名时间为2026年1月12日09:00至19日18:00</div><div class="tiny">广东省2026年普通高等学校专升本招生工作规定<br>广东省教育考试院 · 核查2026-09-30</div></div><div class="notice">无法核对模型整理时，直接展示原文；不将2026日期用于2027安排。</div><button id="advancement-source" data-action="copySource" class="secondary official-source">官方出处 · eea.gd.gov.cn</button>`:s.clarify?`<div class="bubble">请先说明专升本类别、适用年份与地区，避免把不同政策混在一起。</div>${button('scope-select','advancementScope','选择类别、年份与地区','secondary')}`:'<div class="source-link">先确认类别、年份和地区，再查询已收录资料。无法核对时展示官方原文。</div>'}</div>`;
 let html=baseContent(s,t);
 if(s.route==='draft')html=html.replace('演示课表.xlsx',s.importMode==='photo'?'演示课表截图.png':'演示课表.xlsx');
 if(s.route==='goals')html=html.replace('2026-10-10','2026-10-11');
 if(s.route==='article')html=html.replace('本篇官网资讯介绍学校开展2026级新生入学教育。','9月7日至11日，学校开展2026级新生入学教育。').replace('小程序保留文章正文、发布日期与资料来源。学生可以在列表选择文章，在详情中继续阅读，并核对原文。','教育内容涵盖理想信念、校情校史和生涯规划等，帮助新生了解校园、开启大学生活。').replace('演示页使用简短摘要展现阅读流程；完整内容以官网原文和小程序实际详情为准。','本画面采用历史文章摘要，完整内容以官网原文为准。').replace('内容来自已选栏目同步结果，更新状态与文章日期分别展示。','阅读时保留发布日期与来源，方便继续查阅原文。');
 return html;
};
function miniTimetable(){return '<div class="mini-grid">'+['一','二','三','四','五',...Array.from({length:25},(_,i)=>[2,6,9,13,21].includes(i)?'<b>课程</b>':'')].map(x=>`<span>${x}</span>`).join('')+'</div>';}
modal=function(s,t){
 if(s.modal==='photoPicker')return `<div class="sheet-shadow"></div><div class="sheet"><div class="sheet-title">选择课表截图</div><div class="muted">合成图片 · 不使用真实学生课表</div><button id="pick-photo" data-action="recognize" class="scan-picture" style="width:100%;margin:20px 0">${miniTimetable()}</button>${button('photo-cancel','close','取消','secondary')}</div>`;
 if(s.modal==='manualEdit')return `<div class="sheet-shadow"></div><div class="sheet"><div class="sheet-title">修改课程地点</div><div class="form-label">数据库应用 · 周三第5–6节</div><input id="location-input" class="field" value="${escapeHtml(s.location)}"><div class="notice">其他字段保持不变。</div><div class="form-actions">${button('edit-cancel','close','取消','secondary')}${button('edit-save','saveManualEdit','保存修改')}</div></div>`;
 if(s.modal==='calendar')return `<div class="sheet-shadow"></div><div class="sheet"><div class="sheet-title">大学英语四级口语考试</div><div class="calendar-date">2026-11-21</div><div class="notice">已登记的官方日期快照。报名截止由各考点确定，不显示未经核准的统一截止日。</div><div class="source-link">来源：中国教育考试网<br>资料核查：2026-09-29<br>完整安排以官方公告和考点通知为准。</div>${button('calendar-source','copyCalendar','核对官方来源','secondary')}<div class="spacer"></div>${button('calendar-close','close','返回','secondary')}</div>`;
 if(s.modal==='scope')return `<div class="sheet-shadow"></div><div class="sheet"><div class="sheet-title">确认问题适用范围</div><div class="form-label">类别</div><div class="field">普通专升本</div><div class="form-label">年份 / 地区</div><div class="field">2026年 · 广东省</div><div class="notice">演示查询2026历史资料，不表示后续年份的报名安排。</div>${button('scope-search','searchAdvancement','查阅官方原文')}</div>`;
 let html=baseModal(s,t);
 if(s.modal==='manual')html=html.replace('value="自主学习"',`value="${escapeHtml(s.manualName||'自主学习')}"`).replace('value="B301"',`value="${escapeHtml(s.manualLocation||'B301')}"`);
 if(s.modal==='goal')html=html.replace('2026-10-10','2026-10-11');
 return html;
};
const stage=document.getElementById('stage');
stage.insertAdjacentHTML('beforeend','<div id="phase-rail" class="phase-rail"></div><div id="result-panel" class="result-panel"></div><div id="action-readout" class="action-readout"></div>');
const sectionSelect=document.createElement('select');sectionSelect.setAttribute('aria-label','选择演示功能');sectionSelect.innerHTML='<option value="0">完整介绍</option>'+MODEL.features.map(f=>`<option value="${f.start}">${f.title}</option>`).join('');document.querySelector('.controls').append(sectionSelect);
sectionSelect.onchange=()=>{playing=false;manual=false;soundtrack.pause();render(Number(sectionSelect.value));document.getElementById('play').textContent='播放';};
const mobileMode=()=>innerWidth<800&&!document.body.classList.contains('export');
render=function(t,manualState=null){
 const result=baseRender(t,manualState),f=MODEL.features.find(f=>t>=f.start&&t<f.end);
 const panel=document.getElementById('result-panel'),readout=document.getElementById('action-readout'),rail=document.getElementById('phase-rail');
 if(f){const phase=t<f.process?0:t<f.result?1:2;
 rail.style.display='flex';rail.innerHTML=['功能介绍','使用过程','最终结果'].map((x,i)=>`<div class="phase ${phase===i?'on':phase>i?'done':''}"><small>${String(i+1).padStart(2,'0')}</small>${x}</div>`).join('');
 const headline=document.getElementById('headline');headline.textContent=f.title;headline.style.fontSize=mobileMode()?'32px':'62px';
 document.getElementById('label').textContent=['excel','photo','week','query','change'].includes(f.id)?'个人课表': ['department','news','home'].includes(f.id)?'校园信息':'日常工具';
 document.getElementById('subcopy').textContent=f.intro;
 panel.style.display=phase===2?'block':'none';readout.style.display=phase===2?'none':'block';
 panel.innerHTML=`<div class="result-label">本次操作的最终结果<span class="result-tick">示例结果</span></div><div class="result-title">${f.id==='fitness'?'加权参考总分 81':f.id==='change'?'课程总数 7 → 8':f.id==='excel'||f.id==='photo'?'6门课程 · 已确认保存':f.id==='goals'?'项目展示 · 还剩7天':f.id==='advancement'?'2026广东普通专升本 · 原文与出处':f.outcome}</div><div class="result-body">${f.detail}</div>`;
 let step=phase===0?0:Math.min(2,Math.floor((t-f.process)/(f.result-f.process)*3));
 if(f.id==='photo'||f.id==='excel')step=state.route==='import'||state.modal==='photoPicker'||state.modal==='picker'||state.route==='processing'&&f.id==='excel'?0:state.modal==='saveConfirm'||state.route==='week'?2:1;
 if(f.id==='change')step=state.modal!=='chat'?2:state.proposal?1:0;
 readout.innerHTML=phase===0?'<b>这项功能能做什么</b>'+f.intro:`<b>${step+1}. ${f.steps[step]}</b><div class="process-mini">${f.steps.map((x,i)=>`<span class="${i===step?'active':''}">${x}</span>`).join('<i>›</i>')}</div>`;
 document.getElementById('scene-note').textContent=f.note;
 }else{rail.style.display='none';panel.style.display='none';readout.style.display='none';document.getElementById('scene-note').textContent='代码复现演示 · 合成数据与固定模拟AI响应';}
 const phone=document.getElementById('phone');
 const zoom=f&&(t>=f.process&&t<f.result)?1.035:1;const camera=f?ease((t-f.start)/.6):1;
 if(!mobileMode()){phone.style.left=(1045+(1-camera)*22)+'px';phone.style.transform=`scale(${zoom})`;}
 else{phone.style.left='16px';phone.style.transform='none';if(state.proposal){const sheet=document.querySelector('.sheet');if(sheet)sheet.scrollTop=sheet.scrollHeight;}}
 if(state.route==='article'&&state.articleScroll&&!state.newsResult){document.querySelector('.page-inner').style.transform=`translateY(-${160*ease((t-150)/1.2)}px)`;}
 const end=document.getElementById('end');end.style.display=t>=228?'flex':'none';end.style.opacity=ease((t-228)/.8);
 return {...result,feature:f?.id,phase:f?(t<f.process?'intro':t<f.result?'process':'result'):'cover'};
};
const note=document.createElement('div');note.id='scene-note';note.className='scene-note';stage.append(note);
document.getElementById('seek').max=MODEL.duration;
document.querySelector('.credit').textContent='校园主题参赛作品 · 代码复现产品流程';
document.querySelector('#end .end-note').textContent='合成示例与模拟AI响应用于产品演示；升学独立效果仍待验收';
soundtrack.src=document.body.classList.contains('export')?'':'../校园工具-功能过程与成果-v5.mp4';
resize=function(){
 if(mobileMode()){document.body.classList.add('mobile');document.body.insertBefore(document.querySelector('.controls'),stage);stage.style.transform='none';stage.style.width=innerWidth+'px';stage.style.marginLeft='0';}
 else{document.body.classList.remove('mobile');stage.style.width='1600px';const scale=Math.min(innerWidth/1600,(innerHeight-70)/900);stage.style.transform=`scale(${scale})`;stage.style.marginLeft=Math.max(0,(innerWidth-1600*scale)/2)+'px';}
};
window.addEventListener('resize',()=>{if(!document.body.classList.contains('export')){resize();render(currentTime,state);}});
// Escape is an actual close action. Paused manual interactions keep their current data.
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&state.modal)dispatch('close');});
window.demoDuration=MODEL.duration;window.demoEvents=events;window.demoVoices=voices;window.demoFeatures=MODEL.features;
window.getFeatureState=t=>render(t);window.calculateDemoFitness=()=>fitTotal;
if(!document.body.classList.contains('export'))resize();render(0);
