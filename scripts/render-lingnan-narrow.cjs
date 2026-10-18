/** 取实际小程序渲染树和当前 WXSS，在 Chrome 中辅助检查 320px 排版。
 * 不是微信 320px 模拟器，不证明原生控件、键盘、读屏或交互兼容。
 */
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {connectMini}=require('./lib/mini-connect.cjs');
const {fixtures,install,waitForApp}=require('./verify-lingnan-ui.cjs');
const directory=path.resolve(process.argv[2]||'artifacts/ui-implementation/narrow-browser');
const css=file=>fs.readFileSync(file,'utf8').replace(/@import\s+["']([^"']+)["'];/gu,(_,p)=>css(path.resolve(path.dirname(file),p)));
function html(tree,route){
 const tag={view:'div',text:'span',image:'img','scroll-view':'div',picker:'div',block:'div'};
 const body=tree.replace(/<(\/?)(view|text|image|scroll-view|picker|block)(?=[\s>])/gu,(_,close,name)=>`<${close}${tag[name]}`)
   .replace(/\s(?:disabled|hidden|checked|readonly)="(?:false|undefined)"/gu,'')
   .replace(/src="\/assets\//gu,`src="file:///${path.resolve('miniprogram/assets').replace(/\\/gu,'/')}/`);
 const styles=(css(path.resolve('miniprogram/app.wxss'))+css(path.resolve(`miniprogram/${route}.wxss`)))
   .replace(/(^|[}\n])\s*page\s*\{/gu,'$1body {').replace(/(-?\d*\.?\d+)rpx/gu,(_,n)=>`${Number(n)*320/750}px`);
 return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>320px 浏览器辅助检查</title><style>body{margin:0}div,button{box-sizing:border-box}button,input,textarea{font:inherit}button{border:0}img{height:auto}.native-nav{height:88px;padding:45px 10px 0;background:white;text-align:center;font-size:12px}.scope{padding:4px 12px;font-size:10px;background:#fff4e4;color:#78420e}${styles}.grid-scroll{overflow-x:auto}.reader-scroll{overflow-y:auto}body:has(.reader-mask){height:568px;overflow:hidden}.reader-mask{top:88px}body:has(.reader-mask) .scope{display:none}</style><body><div class="native-nav">320px 浏览器布局辅助</div><div class="scope">实际渲染树 + WXSS；非320px微信截图</div>${body}</body></html>`;
}
async function run(){
 fs.mkdirSync(directory,{recursive:true});
 const mini=await connectMini();let installed=false;
 const report={mode:'browser_layout_from_native_tree',boundary:'320px Chrome辅助排版，非微信320px原生，不证明交互或平台控件',screens:[],passed:false};
 const capture=async(name,page,selector='.page')=>{
  await page.waitFor(350);const root=await page.$(selector);const tree=await root.outerWxml();
  fs.writeFileSync(path.join(directory,`${name}.html`),html(tree,page.path));
  report.screens.push({name,route:page.path});
 };
 try{
  await waitForApp(mini);
  await install(mini,fixtures());installed=true;
  await mini.reLaunch('/pages/timetable/import/index');let preflight=await mini.currentPage();await preflight.callMethod('toggleMetaDetails');
  await mini.reLaunch('/pages/home/index');let page=await mini.currentPage();await capture('01-home',page);
  await mini.reLaunch('/pages/timetable/index?today=2026-10-12');page=await mini.currentPage();await capture('02-timetable',page);
  await mini.reLaunch('/pages/timetable/edit/index?id=mock-jsp');page=await mini.currentPage();await capture('03-course-edit',page);
  await mini.reLaunch('/pages/timetable/import/index');page=await mini.currentPage();
  await page.callMethod('startImport',{path:'mock.xls',name:'布局示例.xls'});await capture('04-import-review',page);
  await page.callMethod('toggleMetaDetails');await capture('05-import-metadata',page);
  await mini.reLaunch('/pages/departments/index');page=await mini.currentPage();await capture('06-department-qa',page);
  await mini.reLaunch('/pages/defense/index');page=await mini.currentPage();await capture('07-defense-materials',page,'.defense');
  await page.callMethod('onBegin');await page.callMethod('onOpenMaterial');await page.waitFor(400);await capture('08-defense-reader',page,'.defense');
  const rendered=spawnSync(process.execPath,['scripts/render-mockups.mjs',directory,'--width','320','--height','568','--scale','1','--check-overflow'],{encoding:'utf8'});
  report.renderOutput=rendered.stdout+rendered.stderr;report.passed=rendered.status===0;
  if(!report.passed)process.exitCode=1;
 }catch(error){report.error=error.stack;process.exitCode=1;}
 finally{
  if(installed){await mini.reLaunch('/pages/home/index').catch(()=>{});await mini.evaluate(()=>{const o=globalThis.__lingnanUi.original;wx.cloud.callFunction=o.call;wx.cloud.database=o.database;wx.cloud.uploadFile=o.upload;wx.getStorageSync=o.get;wx.setStorageSync=o.set;wx.removeStorageSync=o.remove;delete globalThis.__lingnanUi;}).catch(()=>{});}
  mini.disconnect();fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
 }
 console.log(JSON.stringify({passed:report.passed,screens:report.screens.length,error:report.error,render:report.renderOutput}));
}
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1;});
