// 输出供 Figma Plugin API 执行的可审查脚本。不会随小程序发布。
import { screens, colors, iconSvg } from './design-data.mjs';
const mode=process.argv[2]||'init';
const common=String.raw`
const ids=[]; const keep=n=>{ids.push(n.id);return n;};
const rgb=h=>({r:parseInt(h.slice(1,3),16)/255,g:parseInt(h.slice(3,5),16)/255,b:parseInt(h.slice(5,7),16)/255});
const C=${JSON.stringify(colors)};
await Promise.all(['Regular','Medium','Bold'].map(style=>figma.loadFontAsync({family:'Noto Sans SC',style})).concat([figma.loadFontAsync({family:'Noto Serif SC',style:'Bold'})]));
const V=Object.fromEntries((await figma.variables.getLocalVariablesAsync()).map(v=>[v.name,v]));
const styles=Object.fromEntries((await figma.getLocalTextStylesAsync()).map(s=>[s.name,s]));
const paint=k=>{const p={type:'SOLID',color:rgb(C[k]||k)};return V['color/'+k]?figma.variables.setBoundVariableForPaint(p,'color',V['color/'+k]):p;};
function fill(n,k){n.fills=k?[paint(k)]:[];}
function auto(parent,name,dir='VERTICAL',w=350,gap=16,bg=null,pad=0){const n=keep(figma.createAutoLayout(dir));n.name=name;n.resize(w,10);n.primaryAxisSizingMode=dir==='VERTICAL'?'AUTO':'FIXED';n.counterAxisSizingMode=dir==='VERTICAL'?'FIXED':'AUTO';n.itemSpacing=gap;fill(n,bg);n.paddingTop=n.paddingBottom=n.paddingLeft=n.paddingRight=pad;if(parent)parent.appendChild(n);n.layoutSizingHorizontal='FIXED';n.layoutSizingVertical='HUG';return n;}
function text(parent,value,size=13,color='text',weight='Regular',w=350,serif=false){const t=keep(figma.createText());t.name=String(value).slice(0,36)||'空文本';const key=(serif?'Serif':'Sans')+'/'+size+'/'+weight;const s=styles[key];if(s)t.textStyleId=s.id;else{t.fontName={family:serif?'Noto Serif SC':'Noto Sans SC',style:weight};t.fontSize=size;t.lineHeight={unit:'PERCENT',value:165};}t.characters=String(value||' ');fill(t,color);t.textAutoResize='HEIGHT';t.resize(w,Math.max(size*1.5,20));if(parent)parent.appendChild(t);t.textAutoResize='HEIGHT';t.layoutSizingVertical='HUG';return t;}
function border(n,k='line'){n.strokes=[paint(k)];n.strokeWeight=1;}
function prop(comp,node,name,value){const key=comp.addComponentProperty(name,'TEXT',String(value));node.componentPropertyReferences={characters:key};return key;}
const track=n=>{ids.push(n.id);if('children'in n)for(const c of n.children)track(c);return n;};
`;
const init=String.raw`
if(figma.currentPage.children.some(n=>n.name==='00 · 基础与组件'))throw Error('基础已存在；禁止重复创建');
figma.currentPage.name='01 · 全流程设计';
const collection=figma.variables.createVariableCollection('岭南校园工具 / 设计提案');collection.renameMode(collection.modes[0].modeId,'浅色');const mid=collection.modes[0].modeId;
for(const[k,h]of Object.entries(C)){const v=figma.variables.createVariable('color/'+k,collection,'COLOR');v.scopes=['FRAME_FILL','SHAPE_FILL','TEXT_FILL','STROKE_COLOR'];v.setValueForMode(mid,{...rgb(h),a:1});V[v.name]=v;}
for(const size of [4,8,12,16,20,24,32,48]){const v=figma.variables.createVariable('space/'+size,collection,'FLOAT');v.scopes=['GAP'];v.setValueForMode(mid,size);V[v.name]=v;}
for(const size of [11,12,13,14,15,16,17,20,22,24,28,34,48])for(const weight of ['Regular','Medium','Bold']){const s=figma.createTextStyle();s.name='Sans/'+size+'/'+weight;s.fontName={family:'Noto Sans SC',style:weight};s.fontSize=size;s.lineHeight={unit:'PERCENT',value:165};styles[s.name]=s;}
for(const size of [27,28,34]){const s=figma.createTextStyle();s.name='Serif/'+size+'/Bold';s.fontName={family:'Noto Serif SC',style:'Bold'};s.fontSize=size;s.lineHeight={unit:'PERCENT',value:145};styles[s.name]=s;}
const base=auto(null,'00 · 基础与组件','VERTICAL',1240,24,'white',32);base.x=120;base.y=120;
text(base,'岭南校园工具 / 设计基础',28,'text','Bold',1176);text(base,'设计提案 · 非生产组件库；颜色承接 app.wxss；中文 Figma 字体使用 Noto Sans SC，标题使用 Noto Serif SC。',14,'secondary','Regular',1176);
const swatches=auto(base,'语义色彩','HORIZONTAL',1176,12);for(const k of ['brand','deep','paper','text','secondary','warn','blue','success']){const sw=auto(swatches,k,'VERTICAL',128,6,C[k]?k:'white',10);text(sw,k,12,['brand','deep','text','secondary','warn','blue','success'].includes(k)?'white':'text','Medium',108);text(sw,C[k],11,['brand','deep','text','secondary','warn','blue','success'].includes(k)?'white':'text','Regular',108);}
const componentZone=auto(base,'复用组件','HORIZONTAL',1176,28);const col1=auto(componentZone,'操作组件','VERTICAL',350,16);const col2=auto(componentZone,'内容组件','VERTICAL',350,16);const col3=auto(componentZone,'表单与来源','VERTICAL',350,16);
const buttons=[];
for(const variant of ['primary','secondary','tertiary']){const c=keep(figma.createComponent());c.name='tone='+variant;c.layoutMode='VERTICAL';c.resize(350,48);c.primaryAxisSizingMode='AUTO';c.counterAxisSizingMode='FIXED';c.minHeight=48;c.paddingTop=c.paddingBottom=12;c.paddingLeft=c.paddingRight=16;c.primaryAxisAlignItems='CENTER';c.counterAxisAlignItems='CENTER';c.cornerRadius=8;fill(c,variant==='primary'?'brand':variant==='secondary'?'white':null);if(variant==='secondary')border(c,'deep');const label=text(c,'主要动作',15,variant==='primary'?'white':'deep','Medium',318);label.textAlignHorizontal='CENTER';prop(c,label,'Label','主要动作');c.description='根据任务命名动作；提交中防重复；secondary 为取消或返回；页面使用实例。';col1.appendChild(c);buttons.push(c);}
const buttonSet=keep(figma.combineAsVariants(buttons,col1));buttonSet.name='LN / Button';buttonSet.layoutMode='VERTICAL';buttonSet.itemSpacing=12;buttonSet.paddingTop=buttonSet.paddingBottom=buttonSet.paddingLeft=buttonSet.paddingRight=12;buttonSet.primaryAxisSizingMode='AUTO';buttonSet.counterAxisSizingMode='AUTO';fill(buttonSet,null);
function component(parent,name){const c=keep(figma.createComponent());c.name=name;c.layoutMode='VERTICAL';c.resize(350,10);c.primaryAxisSizingMode='AUTO';c.counterAxisSizingMode='FIXED';c.itemSpacing=8;parent.appendChild(c);return c;}
const card=component(col2,'LN / Card');card.paddingTop=card.paddingBottom=card.paddingLeft=card.paddingRight=16;card.cornerRadius=10;fill(card,'white');border(card);prop(card,text(card,'内容标题',16,'text','Medium',318),'Title','内容标题');prop(card,text(card,'说明内容',13,'text','Regular',318),'Body','说明内容');prop(card,text(card,'来源与状态',11,'muted','Regular',318),'Meta','来源与状态');card.description='内容分组；保留标题、说明、来源；Blue 用于课程信息，Warning 用于待核对。';
const field=component(col3,'LN / Field');fill(field,null);prop(field,text(field,'字段名称',13,'text','Medium',350),'Label','字段名称');const value=auto(field,'输入区域','VERTICAL',350,0,'white',12);value.cornerRadius=7;border(value,'muted');value.minHeight=48;prop(field,text(value,'字段内容',14,'text','Regular',326),'Value','字段内容');prop(field,text(field,'填写说明',11,'muted','Regular',350),'Hint','填写说明');field.description='静态输入状态；实现时使用原生 input、picker、textarea；不将设计文字当成真实输入组件。';
const cite=component(col3,'LN / Source');cite.paddingTop=cite.paddingBottom=14;fill(cite,null);prop(cite,text(cite,'资料来源',13,'deep','Medium',350),'Title','资料来源');prop(cite,text(cite,'原文或依据摘要',13,'text','Regular',350),'Body','原文或依据摘要');prop(cite,text(cite,'发布 / 核查 / 适用范围',11,'muted','Regular',350),'Meta','发布 / 核查 / 适用范围');cite.description='出处与正文分离；小程序复制 URL，不依赖未配置的 web-view。';
text(col2,'关键约束',17,'deep','Bold',350);text(col2,'草稿 ≠ 已保存\nAI 提案需本人确认\n未公布字段不猜\n体测估算 ≠ 学校成绩\n答辩反馈 ≠ 能力评级',14,'secondary','Regular',350);
const top=auto(null,'01 · 关键路径预览','VERTICAL',1270,24,'paper',24);top.x=120;top.y=base.y+base.height+120;text(top,'先看一条完整路径',28,'text','Bold',1222);text(top,'首页 → 导入 / 校对 → 保存结果。其余画面在下方按任务顺序排列。',14,'secondary','Regular',1222);top.placeholder=true;
const all=auto(null,'02 · 全流程画面','VERTICAL',3098,64,null,0);all.x=120;all.y=top.y+250;all.placeholder=true;
return {createdNodeIds:ids,foundationId:base.id,previewId:top.id,allId:all.id,pageId:figma.currentPage.id,variables:Object.keys(V).length,styles:Object.keys(styles).length,components:[...buttons,card,field,cite].map(c=>({id:c.id,name:c.name})),collectionId:collection.id};
`;
const build=String.raw`
const spec=${JSON.stringify(process.argv.slice(3).length?screens.filter(s=>process.argv.slice(3).includes(s.id)):screens)};
const chosen=${JSON.stringify(process.argv.slice(3))};
const compNames=['LN / Card','LN / Field','LN / Source'];const comps={};for(const name of compNames){const c=figma.currentPage.findOne(n=>n.type==='COMPONENT'&&n.name===name);if(!c)throw Error('缺少组件 '+name);comps[name]=c;}
const buttonSet=figma.currentPage.findOne(n=>n.type==='COMPONENT_SET'&&n.name==='LN / Button');
const all=figma.currentPage.children.find(n=>n.name==='02 · 全流程画面');if(!all)throw Error('缺少总画板');
const icons=${JSON.stringify(Object.fromEntries(['arrow','calendar','people','news','flag','activity','book','chat','upload','edit','settings','scan','cloud','check'].map(k=>[k,iconSvg(k)])))};
function icon(parent,key,size=24){const n=figma.createNodeFromSvg(icons[key]||icons.arrow);track(n);n.name='图标 / '+key;n.resize(size,size);parent.appendChild(n);return n;}
function setTexts(inst,values){const props={};for(const[key,value]of Object.entries(values)){const p=Object.keys(inst.componentProperties).find(k=>k.startsWith(key+'#'));if(p)props[p]=String(value||' ');}inst.setProperties(props);}
const reactions=[];const screenIds={};const logoSlots=[];
function action(n,target){if(target)reactions.push({nodeId:n.id,target});return n;}
function instance(parent,name,values){const n=comps[name].createInstance();track(n);parent.appendChild(n);setTexts(n,values);return n;}
function cta(parent,label,target,tone='primary'){const main=buttonSet.children.find(c=>c.type==='COMPONENT'&&c.name==='tone='+tone);const n=main.createInstance();track(n);parent.appendChild(n);setTexts(n,{Label:label});action(n,target);return n;}
function block(parent,b){let n;
switch(b.type){
case 'reviewLinks':return null;
case 'weekPicker':n=auto(parent,'自选教学周','VERTICAL',350,8);text(n,'已选：'+b.selected.join('、')+' 周',13,'deep','Medium',350);break;
case 'materialIndex':n=auto(parent,'材料条目目录','VERTICAL',350,8);text(n,b.items.join(' / '),13,'deep','Medium',350);break;
case 'toast':n=auto(parent,'原位结果提示','HORIZONTAL',350,8,'successBg',12);text(n,b.text,13,'success','Medium',282);break;
case 'courseRow':n=auto(parent,b.title,'VERTICAL',350,8,'white',15);border(n);text(n,b.title,15,'text','Medium',320);text(n,b.text,12,'muted','Regular',320);const actions=auto(n,'当前课程操作','HORIZONTAL',320,12);action(text(actions,'编辑',13,'deep','Medium',100),b.edit);action(text(actions,'删除',13,'deep','Medium',100),b.remove);break;
case 'heroCompact':n=auto(parent,'首页短标题','VERTICAL',350,4);text(n,b.title,24,'text','Bold',350,true);text(n,b.text,12,'secondary','Regular',350);break;
case 'weekToolbar':n=auto(parent,'课表操作','HORIZONTAL',350,8);for(const i of b.items){const t=auto(n,i.label,'VERTICAL',111,0,'white',12);border(t,'deep');text(t,i.label,12,'deep','Medium',87);action(t,i.target);}break;
case 'brand':n=auto(parent,'官方校徽 / 保持原比例','VERTICAL',350,0,'deep',12);border(n);const logo=keep(figma.createRectangle());logo.name='官方校徽图像槽';logo.resize(326,326*113/320);fill(logo,'white');n.appendChild(logo);logoSlots.push(logo.id);break;
case 'hero':n=auto(parent,'首页标题','VERTICAL',350,12);text(n,'LINGNAN / CAMPUS TOOLS',11,'deep','Medium',350);text(n,b.title,34,'text','Bold',350,true);text(n,b.text,15,'text','Regular',350);text(n,b.meta,11,'muted','Regular',350);const line=keep(figma.createRectangle());line.resize(350,2);fill(line,'brand');n.appendChild(line);break;
case 'primaryEntry':n=auto(parent,'课表主入口','HORIZONTAL',350,12,'brand',20);n.cornerRadius=12;n.minHeight=112;const copy=auto(n,'入口说明','VERTICAL',242,4);text(copy,'每周安排',11,'white','Regular',242);text(copy,b.title,24,'white','Bold',242);text(copy,b.text,13,'white','Regular',242);const ic=icon(n,b.icon,36);for(const v of ic.findAllWithCriteria({types:['VECTOR']})){v.strokes=[paint('white')];}n.counterAxisAlignItems='CENTER';action(n,b.target);break;
case 'section':n=auto(parent,b.title,'HORIZONTAL',350,8);text(n,b.title,17,'text','Bold',246);text(n,b.meta,11,'muted','Regular',96);n.counterAxisAlignItems='CENTER';break;
case 'tiles':n=auto(parent,'工具入口','VERTICAL',350,10);for(let j=0;j<b.items.length;j+=2){const r=auto(n,'入口行','HORIZONTAL',350,10);for(const i of b.items.slice(j,j+2)){const t=auto(r,i.title,'VERTICAL',170,8,'white',14);border(t);t.cornerRadius=10;t.minHeight=b.compact?96:116;icon(t,i.icon);text(t,i.title,16,'text','Medium',142);text(t,i.text,11,'muted','Regular',142);action(t,i.target);}}break;
case 'row':n=auto(parent,b.title,'HORIZONTAL',350,12);n.paddingTop=n.paddingBottom=12;n.minHeight=76;n.counterAxisAlignItems='CENTER';icon(n,b.icon);const rcopy=auto(n,'条目说明','VERTICAL',278,4);text(rcopy,b.title,15,'text','Medium',278);text(rcopy,b.text,12,'muted','Regular',278);if(b.target){text(n,'›',20,'muted','Regular',20);action(n,b.target);}break;
case 'note':n=auto(parent,b.title||'说明','VERTICAL',350,6,b.tone==='warning'?'warnBg':'white',15);if(b.title)text(n,b.title,14,b.tone==='warning'?'warn':'text','Bold',320);text(n,b.text,13,b.tone==='warning'?'warn':'text','Regular',320);break;
case 'card':n=instance(parent,'LN / Card',{Title:b.title,Body:b.text,Meta:b.meta});if(b.tone==='blue'){fill(n,'blueBg');border(n,'blue');}if(b.tone==='warning'){fill(n,'warnBg');border(n,'warn');}action(n,b.target);break;
case 'button':n=cta(parent,b.label,b.target,b.tone);break;
case 'field':n=instance(parent,'LN / Field',{Label:b.label,Value:b.value,Hint:b.hint||b.error});break;
case 'textarea':n=auto(parent,b.label,'VERTICAL',350,8);text(n,b.label,13,'text','Medium',350);const area=auto(n,'回答草稿','VERTICAL',350,0,'white',13);border(area,'muted');area.cornerRadius=7;area.minHeight=158;text(area,b.value||'按材料说明，不确定的写「还没验证」',14,'text','Regular',324);text(n,b.hint,11,'muted','Regular',350);break;
case 'chips':n=auto(parent,'选项','HORIZONTAL',350,6);for(let j=0;j<b.items.length;j++){const width=(350-6*(b.items.length-1))/b.items.length;const p=auto(n,b.items[j],'VERTICAL',width,0,j===b.selected?'deep':'white',9);p.minHeight=44;p.cornerRadius=8;border(p,j===b.selected?'deep':'muted');p.counterAxisAlignItems='CENTER';const tx=text(p,b.items[j],13,j===b.selected?'white':'text','Medium',Math.max(10,width-18));tx.textAlignHorizontal='CENTER';}break;
case 'steps':n=auto(parent,'任务进度','HORIZONTAL',350,7);for(let j=0;j<b.items.length;j++){const st=auto(n,b.items[j],'VERTICAL',112,8);const circle=auto(st,'步骤 '+(j+1),'VERTICAL',24,0,j===b.active?'deep':'shade',0);circle.resize(24,24);circle.primaryAxisSizingMode='FIXED';circle.cornerRadius=12;const tx=text(circle,String(j+1),11,j===b.active?'white':'muted','Bold',24);tx.textAlignHorizontal='CENTER';text(st,b.items[j],11,j===b.active?'deep':'muted','Medium',112);}break;
case 'empty':n=auto(parent,b.title,'VERTICAL',350,16,null,8);n.paddingTop=38;n.paddingBottom=30;n.counterAxisAlignItems='CENTER';const glyph=auto(n,'状态图标','VERTICAL',76,0,'shade',20);glyph.cornerRadius=18;icon(glyph,b.icon,36);const et=text(n,b.title,22,'text','Bold',334);et.textAlignHorizontal='CENTER';const ep=text(n,b.text,13,'secondary','Regular',334);ep.textAlignHorizontal='CENTER';break;
case 'source':n=instance(parent,'LN / Source',{Title:b.title,Body:b.text,Meta:b.meta});break;
case 'metric':n=auto(parent,'结果摘要','VERTICAL',350,12,'deep',20);n.cornerRadius=12;const mt=auto(n,'数字与单位','HORIZONTAL',310,8);text(mt,b.value,48,'white','Bold',140);text(mt,b.label,16,'white','Medium',150);mt.counterAxisAlignItems='CENTER';text(n,b.text,12,'white','Regular',310);break;
case 'quote':n=auto(parent,'本人问题 / 回答','VERTICAL',322,4,'shade',14);n.cornerRadius=12;border(n);text(n,b.who,11,'muted','Regular',294);text(n,b.text,14,'text','Regular',294);break;
case 'table':n=auto(parent,'结果明细表','VERTICAL',350,0,'white');for(const [idx,rr]of [b.heads,...b.rows].entries()){const tr=auto(n,'表格行 '+idx,'HORIZONTAL',350,0,idx===0?'shade':'white');tr.paddingTop=tr.paddingBottom=12;for(let j=0;j<rr.length;j++){const cell=auto(tr,'单元格','VERTICAL',j===0?154:98,0,null,8);text(cell,rr[j],12,'text',idx===0||j===2?'Medium':'Regular',j===0?138:82);}}break;
case 'newsLead':n=auto(parent,'资讯头条','VERTICAL',350,14,null,0);n.paddingTop=n.paddingBottom=22;text(n,b.title,27,'text','Bold',350,true);text(n,b.text,11,'muted','Regular',350);action(n,b.target);break;
case 'article':n=auto(parent,'资讯正文','VERTICAL',350,20);text(n,b.title,28,'text','Bold',350,true);text(n,b.meta,11,'muted','Regular',350);for(const p of b.paragraphs)text(n,p,16,'text','Regular',350);break;
case 'orgHero':n=auto(parent,'组织标题','VERTICAL',350,16,'deep',20);n.cornerRadius=10;text(n,b.mark,34,'white','Bold',310,true);text(n,b.title,20,'white','Bold',310);text(n,b.text,12,'white','Regular',310);break;
case 'weeknav':n=auto(parent,'切换教学周','HORIZONTAL',350,12);const prev=auto(n,'上一周','VERTICAL',44,0,'white',10);border(prev);text(prev,'‹',20,'text','Regular',24);const current=auto(n,'当前教学周','VERTICAL',238,2);const w=text(current,'第 8 周',20,'text','Bold',238);w.textAlignHorizontal='CENTER';const wm=text(current,'手动切换周次 · 示例',11,'muted','Regular',238);wm.textAlignHorizontal='CENTER';const next=auto(n,'下一周','VERTICAL',44,0,'white',10);border(next);text(next,'›',20,'text','Regular',24);break;
case 'week':n=auto(parent,'周课表网格','HORIZONTAL',350,3,'white',6);border(n);n.cornerRadius=9;const widths=[24,22,67.6,67.6,22,67.6,22,22];const data={2:{r:0,title:'JSP应用系统',room:'博雅楼B602',bg:'blueBg',ink:'blue'},3:{r:1,title:'数据库应用技术',room:'B305',bg:'successBg',ink:'success'},5:{r:2,title:'大学英语',room:'B305',bg:'shade',ink:'deep'}};for(let col=0;col<8;col++){const column=auto(n,'星期列 '+col,'VERTICAL',widths[col],3);const header=auto(column,'星期','VERTICAL',widths[col],0,col===2?'deep':null);header.resize(widths[col],30);header.primaryAxisSizingMode='FIXED';const dt=text(header,col===0?'':'一二三四五六日'[col-1],11,col===2?'white':'text','Regular',widths[col]);dt.textAlignHorizontal='CENTER';for(let ri=0;ri<6;ri++){const cell=auto(column,'第 '+(ri*2+1)+'–'+(ri*2+2)+' 节','VERTICAL',widths[col],4);cell.resize(widths[col],87.36);cell.primaryAxisSizingMode='FIXED';if(col===0){text(cell,['1–2','3–4','5–6','7–8','9–10','11–12'][ri],9,'muted','Regular',widths[col]);}const d=data[col];if(d&&d.r===ri){fill(cell,d.bg);cell.paddingLeft=cell.paddingRight=5;cell.paddingTop=7;cell.cornerRadius=5;text(cell,d.title,12,d.ink,'Regular',widths[col]-10);text(cell,d.room,11,d.ink,'Regular',widths[col]-10);action(cell,'04');}}}break;
default:throw Error('未知区块 '+b.type);
}return n;}
const already=Object.fromEntries(all.findAllWithCriteria({types:['FRAME']}).filter(n=>/^UI \d{2} /.test(n.name)).map(n=>[n.name.slice(3,5),n.id]));
for(const s of spec.filter(s=>chosen.length===0||chosen.includes(s.id))){if(already[s.id]){screenIds[s.id]=already[s.id];continue;}const index=Number(s.id)-1;const rowIndex=Math.floor(index/7);let board=all.children.find(n=>n.name==='画面行 '+rowIndex);if(!board)board=auto(all,'画面行 '+rowIndex,'HORIZONTAL',3098,48);
const frame=auto(board,'UI '+s.id+' '+s.title,'VERTICAL',390,0,'paper');screenIds[s.id]=frame.id;frame.clipsContent=false;
const status=auto(frame,'系统状态栏','HORIZONTAL',390,0,'white',0);status.paddingLeft=status.paddingRight=22;status.paddingTop=6;status.minHeight=34;text(status,'9:41',12,'text','Bold',260);text(status,'▴ ▴ ▰',12,'text','Bold',86);
const nav=auto(frame,'微信原生导航示意','HORIZONTAL',390,8,'white',0);nav.paddingLeft=nav.paddingRight=18;nav.minHeight=54;nav.counterAxisAlignItems='CENTER';if(s.back){const bk=auto(nav,'返回','VERTICAL',44,0,null);text(bk,'‹',26,'text','Regular',44);action(bk,s.back);}const tw=s.back?204:256;text(nav,s.title,16,'text','Medium',tw);const cap=auto(nav,'微信胶囊占位','VERTICAL',82,0,'white',0);cap.resize(82,30);cap.primaryAxisSizingMode='FIXED';cap.cornerRadius=15;border(cap);const ct=text(cap,'··· | ◉',16,'text','Regular',82);ct.textAlignHorizontal='CENTER';
const label=auto(frame,'设计身份标注','VERTICAL',390,0,'white',4);label.paddingLeft=20;label.paddingRight=20;text(label,'静态设计提案 · 示例内容 / 非小程序运行截图',10,'muted','Regular',350);
const body=auto(frame,'页面内容','VERTICAL',390,16,null,20);body.minHeight=730;if(s.id!=='01')text(body,s.subtitle,13,'secondary','Regular',350);for(const b of s.blocks)block(body,b);
const footer=auto(frame,'评审件页脚','VERTICAL',390,0,null,20);text(footer,'校园工具 UI 提案 · 2026-10-16',11,'muted','Regular',350);
}
all.placeholder=false;
return {createdNodeIds:ids,screenIds,logoSlots,reactions,screenCount:Object.keys(screenIds).length,fonts:['Noto Sans SC','Noto Serif SC'],bounds:{x:all.x,y:all.y,width:all.width,height:all.height}};
`;
const script=common+(mode==='init'?init:build);
new (Object.getPrototypeOf(async function(){}).constructor)(script);
console.log(script);
