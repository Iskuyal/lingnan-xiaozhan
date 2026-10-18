/** 本机开发者工具离线 UI 验证。接管后所有云函数、数据库和存储均替换为内存夹具。
 * 初始连接前的启动读取不在统计范围；本脚本不验证模型、部署、真机或真实保存。
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { connectMini } = require('./lib/mini-connect.cjs');

const event = dataset => ({ currentTarget: { dataset } });
const input = value => ({ detail: { value } });
async function waitForApp(mini) {
  for(let attempt=0;attempt<20;attempt++) {
    try { const page=await mini.currentPage();if(page?.path) return; } catch { /* CLI auto may precede the first page metadata. */ }
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  throw new Error('开发者工具启动页面尚未就绪，请等待编译完成后复跑');
}
function captureWindow(action, geometry) {
  if (process.platform !== 'win32') return null;
  const args=['-NoProfile','-NonInteractive','-File',path.resolve('scripts/lib/ui-capture-window.ps1'),'-Action',action];
  if (geometry) for (const [key,value] of Object.entries(geometry)) args.push(`-${key}`,String(value));
  const result=spawnSync('powershell.exe',args,{encoding:'utf8',windowsHide:true});
  if(result.status!==0) throw new Error(result.stderr || '无法准备原生截图窗口');
  return action==='prepare'?JSON.parse(result.stdout):null;
}
function fixtures() {
  const course = (id, name, weekday, start, end, location) => ({ id, name, weekday,
    teacher:'示例教师', location, campus:'清远校区', siteNumber:'', note:'布局验证示例', credits:'2',
    sectionRanges:[{start,end}], startSection:start, endSection:end,
    weeks:Array.from({length:20},(_,i)=>i+1), weeksRecognized:true, weekText:'1–20周',
    source:'manual', warnings:[], rawText:'', semester:'布局验证示例学期', createdAt:'', updatedAt:'' });
  return {
    courses:[course('mock-math','高等数学（布局示例）',1,1,2,'崇礼楼306'),
      {...course('mock-jsp','JSP程序设计（布局示例）',3,3,4,'实训楼B305'),weeks:[2,3,4,5,6,8,9,10,11,12,13,14,15,16,17],weekText:'2–6,8–17周'},
      course('mock-sun','晚间课程（布局示例）',7,11,12,'实训楼A205')],
    news:[{ id:'mock-news', title:'校园资讯布局验证示例：长标题与来源保持完整可读', date:'2026-10-16',
      url:'https://lnc.edu.cn/', sourceLabel:'学校官网（离线布局示例）', updatedAt:'2026-10-16T00:00:00Z',
      paragraphs:['这是一条明确标识的离线布局验证示例，不是学校发布的新闻。','用于检查长标题、中文正文、来源说明和返回操作。'] }],
    storage:{ 'goal-days/v1':[{ id:'mock-goal',name:'课程项目展示（布局示例）',date:'2026-10-30',countToday:false,createdAt:1,updatedAt:1 }] },
    feedback:'【引用核对】离线模拟反馈：F5说明确认前不写入。\n【是否对应回答】离线示例对应了导入、校对和确认步骤。\n【待验证保留】F8的未验证事项继续保留。\n【追问】请结合F4补充你如何校对原始条目。',
  };
}

async function install(mini, data) {
  await mini.evaluate(data => {
    const original = { call:wx.cloud.callFunction, database:wx.cloud.database, upload:wx.cloud.uploadFile,
      get:wx.getStorageSync, set:wx.setStorageSync, remove:wx.removeStorageSync };
    globalThis.__lingnanUi = { original, data, calls:[], mode:'ready' };
    wx.getStorageSync = key => data.storage[key] ?? '';
    wx.setStorageSync = (key,value) => { data.storage[key] = value; };
    wx.removeStorageSync = key => { delete data.storage[key]; };
    wx.cloud.database = () => {
      let offset=0, count=20, id='';
      const query = { collection(){return query;}, field(){return query;}, orderBy(){return query;},
        skip(value){offset=value;return query;},limit(value){count=value;return query;},
        where(value){id=value.id;return query;},doc(value){id=value;return query;},
        get(){ return Promise.resolve({data:id ? data.news.filter(row=>row.id===id) : data.news.slice(offset,offset+count)}); } };
      return query;
    };
    wx.cloud.callFunction = options => {
      const state = globalThis.__lingnanUi;
      const action = options.data?.action;
      state.calls.push({name:options.name,action});
      if (options.name === 'ai') {
        if (options.data?.feature === 'project-defense') return Promise.resolve({result:{ok:true,text:data.feedback,warnings:[],citations:[],safety:{checked:false},capWarning:''}});
        return Promise.resolve({result:{ok:false,failureClass:'model_unavailable',message:'离线模拟：模型不可用',text:'',warnings:[],citations:[],safety:null}});
      }
      if (options.name !== 'timetable') return Promise.reject(new Error('离线验证阻止了未配置云接口'));
      if (state.mode === 'error') return Promise.reject(new Error('离线模拟：课表读取失败'));
      if (action === 'list') return Promise.resolve({result:{ok:true,courses:state.mode==='empty'?[]:data.courses,count:state.mode==='empty'?0:data.courses.length,semester:'布局验证示例学期',updatedAt:''}});
      if (action === 'getSettings') return Promise.resolve({result:{ok:true,saved:true,settings:{semesterName:'布局验证示例学期',startDate:'2026-08-24',totalWeeks:20,sectionTimes:Array.from({length:12},()=>({start:'',end:''}))}}});
      if (action === 'prepareUpload') return Promise.resolve({result:{ok:true,cloudPath:'mock/ui.xls',maxBytes:10485760}});
      if (action === 'importDraft') return Promise.resolve({result:{ok:true,draft:{meta:{origin:'excel',school:'布局示例',sheetName:'课表',grade:'2026',major:'离线示例专业',semester:'布局验证示例学期',className:'离线示例班级',fileName:'布局示例.xls',department:'',exportedAt:''},courses:data.courses,stats:{sheets:1,cells:3,courses:data.courses.length,entries:data.courses.length,duplicates:0,warnings:0},problems:[]}}});
      if (action === 'deleteCourse') { data.courses=data.courses.filter(row=>row.id!==options.data.id); return Promise.resolve({result:{ok:true,count:data.courses.length}}); }
      return Promise.reject(new Error(`离线验证阻止写入：${action}`));
    };
    wx.cloud.uploadFile = options => { setTimeout(()=>options.success({fileID:'cloud://mock-ui-only'}),0); return {onProgressUpdate(){}}; };
  },data);
}

async function run() {
  const directory = path.resolve(process.argv[2] || 'artifacts/ui-implementation/native');
  fs.mkdirSync(directory,{recursive:true});
  const report={date:new Date().toISOString(),mode:'wechat_simulator_mock',boundary:'原生模拟器；云函数/数据库/本机存储接管为示例。接管后真实云请求0次；不含连接前启动读取，不证明模型、部署或真机。',checks:[],screenshots:[],passed:false};
  const mini=await connectMini();
  let installed=false;
  let windowGeometry=null;
  const shot=async(name,page) => {
    await page.waitFor(350);
    const file=path.join(directory,`${name}.png`);
    await mini.screenshot({path:file});
    const rasterWidth=fs.readFileSync(file).readUInt32BE(16);
    assert.ok(rasterWidth >= Math.min(320,report.environment.windowWidth*.85),'模拟器截图缩放过小，不能作为可读评审证据');
    report.screenshots.push({file:path.basename(file),page:page.path,rasterWidth});
  };
  const open=async(route,name) => {
    await mini.reLaunch(route);
    const page=await mini.currentPage();
    await page.waitFor(400);
    if(name) await shot(name,page);
    return page;
  };
  const check=(name)=>report.checks.push({name,passed:true});
  try {
    await waitForApp(mini);
    windowGeometry=captureWindow('prepare');
    await new Promise(resolve=>setTimeout(resolve,800));
    report.environment=await mini.systemInfo();
    await install(mini,fixtures());installed=true;
    let page=await open('/pages/home/index','01-home');
    await (await page.$('#timetable-entry')).tap();
    await page.waitFor(800);
    page=await mini.currentPage();
    assert.equal(page.path,'pages/timetable/index');check('首页主入口进入已注册课表页');
    page=await open('/pages/timetable/index?today=2026-10-12','02-timetable');
    assert.equal(await page.data('status'),'ready');
    assert.equal((await page.data('gridUi')).columns.length,7);
    const scroll=await page.$('.grid-scroll');await scroll.scrollTo(220,0);await shot('03-timetable-right',page);
    await page.callMethod('openSheet',event({id:'mock-sun'}));await shot('04-course-sheet',page);
    await page.callMethod('closeSheet');check('课表含周日晚间课程、横向滚动与详情');
    page=await open('/pages/timetable/edit/index?id=mock-jsp','05-course-edit');
    assert.equal((await page.data('weeksEditor')).mode,'custom');check('不连续周次继续使用自选周次');
    await mini.pageScrollTo(650);await shot('06-course-weeks',page);
    page=await open('/pages/timetable/manage/index?week=8','07-course-manage');
    page=await open('/pages/timetable/settings/index','08-timetable-settings');
    page=await open('/pages/timetable/import/index','09-import-guide');
    await page.callMethod('startImport',{path:'mock-only.xls',name:'布局示例.xls'});await page.waitFor(400);
    assert.equal(await page.data('step'),'review');await shot('09b-import-review',page);
    const originalItems=JSON.stringify(await page.data('items'));
    await page.callMethod('toggleMetaDetails');await shot('09d-import-metadata',page);
    assert.equal(JSON.stringify(await page.data('items')),originalItems,'展开来源信息不改课程草稿');
    await page.callMethod('toggleMetaDetails');
    await page.callMethod('switchView',event({mode:'grid'}));await shot('09c-import-grid',page);
    assert.equal((await page.data('draftGridUi')).columns.length,7);check('文件上传与解析均模拟，列表和七天预览读取同一草稿，未保存');
    page=await open('/pages/departments/index','10-departments');
    await (await page.$('.department-item')).tap();await page.waitFor(800);page=await mini.currentPage();await shot('11-department-detail',page);check('部门入口与详情导航');
    await page.callMethod('scrollToQa');await page.waitFor(800);await shot('12-department-qa',page);
    page=await open('/pages/news/index','13-news');
    await page.callMethod('openDetail',event({id:'mock-news'}));await page.waitFor(800);page=await mini.currentPage();await shot('14-news-detail',page);check('资讯列表进入正文');
    page=await open('/pages/goals/index?today=2026-10-17','15-goals');
    page=await open('/pages/goals/edit/index?id=mock-goal&today=2026-10-17','16-goal-edit');
    page=await open('/pages/calendar/index?today=2026-10-17','17-calendar');
    page=await open('/pages/fitness/index');
    const values={height:'175',weight:'61.3',vitalCapacity:'4300',sprint50:'7.0',sitAndReach:'17.7',standingLongJump:'248',strength:'15',distanceRun:'3′42″'};
    for (const [key,value] of Object.entries(values)) await page.callMethod('onInput',{detail:{value},currentTarget:{dataset:{value:key}}});
    await page.callMethod('calculate');await mini.pageScrollTo(600);await shot('18-fitness-result',page);check('体测输入计算与结果渲染');
    page=await open('/pages/advancement/index','19-advancement-fallback');
    assert.equal(await page.data('modelPhase'),'fallback');check('模型模拟失败后展示原文依据');
    page=await open('/pages/defense/index','20-defense-materials');
    await (await page.$('#defense-begin')).tap();
    await page.waitFor(400);
    assert.equal(await page.data('phase'),'practice');
    const answer='离线布局示例：根据F4和F5先校对导入草稿，确认之后才保存，F8待验证事项继续保留。';
    await page.callMethod('onAnswerInput',input(answer));await shot('21-defense-practice',page);
    await (await page.$('#defense-material-open')).tap();
    await page.waitFor(400);
    await (await page.$('#material-index-toggle')).tap();await page.waitFor(300);
    assert.equal(await page.data('materialIndexOpen'),true);
    await page.callMethod('onLocateMaterial',event({id:'F5'}));await page.waitFor(1200);
    assert.equal(await page.data('materialIndexOpen'),false);
    assert.ok(await (await page.$('#material-reader')).property('scrollTop') > 0,'目录点击必须滚动正文');
    await shot('22-defense-reader',page);
    await (await page.$('#material-close-bottom')).tap();assert.equal(await page.data('answer'),answer);check('材料定位F5再返回，回答草稿与第一轮保持');
    for(let round=1;round<=3;round++){
      await page.callMethod('onAnswerInput',input(`${answer}本轮${round}。`));
      await page.callMethod('onSubmit');await page.waitFor(350);
      if(round===1) await shot('23-defense-feedback',page);
      if(round<3) await page.callMethod('onNextRound');
    }
    assert.equal(await page.data('phase'),'review');await shot('24-defense-review',page);
    await page.callMethod('onStartReanswer');await page.callMethod('onAnswerInput',input(`${answer}重答增加F6的边界说明。`));
    const draft=await page.data('answer');await page.callMethod('onOpenMaterial',event({anchor:'F4'}));await page.callMethod('onCloseMaterial');
    assert.equal(await page.data('phase'),'reanswer');assert.equal(await page.data('answer'),draft);assert.equal(await page.data('round'),4);
    await shot('25-defense-reanswer',page);check('三轮模拟反馈、复盘、一次重答查阅后草稿不丢失');
    await mini.evaluate(()=>{globalThis.__lingnanUi.mode='empty';});
    await open('/pages/timetable/index','26-timetable-empty');
    await mini.evaluate(()=>{globalThis.__lingnanUi.mode='error';});
    await open('/pages/timetable/index','27-timetable-error');
    report.mockCalls=await mini.evaluate(()=>globalThis.__lingnanUi.calls);
    report.passed=true;
  }catch(error){report.error=error.stack;process.exitCode=1;}
  finally{
    if(installed) {
      await mini.evaluate(()=>{globalThis.__lingnanUi.mode='ready';}).catch(()=>{});
      await mini.reLaunch('/pages/home/index').catch(()=>{});
      await mini.evaluate(()=>{const orig=globalThis.__lingnanUi.original;wx.cloud.callFunction=orig.call;wx.cloud.database=orig.database;wx.cloud.uploadFile=orig.upload;wx.getStorageSync=orig.get;wx.setStorageSync=orig.set;wx.removeStorageSync=orig.remove;delete globalThis.__lingnanUi;}).catch(()=>{});
    }
    mini.disconnect();
    if(windowGeometry) { try{captureWindow('restore',windowGeometry);}catch(error){report.windowRestoreError=error.message;} }
    fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
  }
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,screenshots:report.screenshots.length,error:report.error}));
}
if(require.main===module) run().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={fixtures,install,waitForApp};
