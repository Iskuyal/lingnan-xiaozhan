// 静态设计内容；不是生产数据，也不会被小程序构建引用。
export const figmaFileKey = 'rZS8zZHE1euLlZzuVGxvOH';
export const colors = { brand:'#c41c23', deep:'#8c1614', gold:'#c69a28', paper:'#fdf7f5', shade:'#faeee9', text:'#2b2422', secondary:'#6b5d57', muted:'#746760', white:'#ffffff', line:'#ded4cf', warn:'#9a5b1e', warnBg:'#fff4e4', success:'#147a70', successBg:'#e8f3f0', blue:'#2f5f9e', blueBg:'#e9eff6' };
const note=(text,tone='neutral',title='')=>({type:'note',text,tone,title});
const section=(title,meta='')=>({type:'section',title,meta});
const card=(title,text,meta='',target='',tone='white')=>({type:'card',title,text,meta,target,tone});
const row=(title,text,target='',icon='arrow')=>({type:'row',title,text,target,icon});
const button=(label,target,tone='primary')=>({type:'button',label,target,tone});
const field=(label,value,hint='',error='')=>({type:'field',label,value,hint,error});
const source=(title,text,meta)=>({type:'source',title,text,meta});
const chips=(items,selected=0)=>({type:'chips',items,selected});
const metric=(value,label,text,tone='red')=>({type:'metric',value,label,text,tone});
const quote=(text,who='你')=>({type:'quote',text,who});
const steps=(items,active)=>({type:'steps',items,active});
const page=(id,title,subtitle,route,blocks,extra={})=>({id,title,subtitle,route,blocks,back:'01',...extra});
export const screens = [
 page('01','校园工具','广东岭南职业技术学院','pages/home/index',[
  {type:'brand'},
  {type:'hero',title:'校园日常，\n从容一点。',text:'读资讯、找组织、查课表。',meta:'广州校区 / 清远校区'},
  {type:'primaryEntry',title:'我的课表',text:'导入课程，安排每一周',target:'02',icon:'calendar'},
  section('校园与日常','常用入口'),
  {type:'tiles',items:[{title:'学生部门',text:'了解组织与职责',icon:'people',target:'16'},{title:'校园资讯',text:'官网信息与来源',icon:'news',target:'19'},{title:'校历与考试',text:'查日期，也查依据',icon:'calendar',target:'23'},{title:'目标日',text:'记住重要的日子',icon:'flag',target:'21'}]},
  section('学习与成长'),row('体测估算','按国家标准估算，缺项不猜','24','activity'),row('升学与实习问答','从官方原文中找依据','27','book'),row('项目讲解与答辩练习','三轮练习，一次复盘','30','chat'),
  section('校园资讯','示例资讯'),card('关于本学期课程安排的通知（示例）','查看正文和资料来源','2026-10-16 · 示例资讯','20'),
  section('认识岭南'),note('广东岭南职业技术学院\n广州校区 / 清远校区\n学校简介以官网公开资料为准。'),button('复制学校官网链接','35','secondary')
 ],{kind:'home',back:null}),
 page('02','我的课表','从一份课表开始','pages/timetable/index',[
  {type:'empty',icon:'calendar',title:'还没有保存的课程',text:'导入教务导出的 Excel，或识别课表截图。\n校对确认后，才会成为你的课表。'},
  button('导入课表','05'),button('手工添加课程','10','secondary'),note('不需要提供教务账号和密码。\n个人课表按微信身份保存，公开资讯可直接浏览。'),row('学期与作息设置','只显示你确认过的日期和时刻','12','settings')
 ]),
 page('03','我的课表','2026–2027 学年第一学期 · 示例课表','pages/timetable/index',[
  {type:'weeknav'}, {type:'week'},
  note('按节次查看；未设置作息，不显示具体上课时刻。'),
  {type:'tiles',compact:true,items:[{title:'导入课表',text:'Excel / 截图',icon:'upload',target:'05'},{title:'管理课程',text:'新增、修改、删除',icon:'edit',target:'11'}]},
  button('打开课表助手','13'),row('学期与作息','第 1 周日期、节次时刻','12','settings')
 ]),
 page('04','课程详情','来自你已保存的课表 · 示例','pages/timetable/index',[
  card('使用 JSP 开发 Web 应用系统','周二 · 第 1–2 节','第 2–6、8–17 周 · 清远校区','', 'blue'),
  field('地点','博雅楼 B602'),field('教师','示例教师'),field('学分','4'),
  button('编辑这门课程','10'),button('返回周课表','03','secondary'),note('关闭详情后，仍回到当前教学周。')
 ],{back:'03'}),
 page('05','导入课表','先导入，再校对，最后保存','pages/timetable/import/index',[
  steps(['选择','校对','确认'],0),
  card('从微信聊天选择 Excel','先在教务系统下载课表文件，再发送到微信聊天或「文件传输助手」。','小程序从聊天记录中选文件','06'),
  card('识别课表截图','选一张清晰、完整的课表截图。识别结果需要你逐项核对。','图片会上传，用于识别与安全检查','07'),
  button('从聊天选择 Excel','06'),button('选择课表截图','07','secondary'),
  note('此步骤只生成草稿，不会改动已保存课表。\n识别或上传失败时，可以重新选图、改用 Excel 或手工录入。'),row('手工添加课程','没有文件，也可以开始','10','edit')
 ],{back:'03'}),
 page('06','校对导入草稿','Excel · 示例课表.xlsx','pages/timetable/import/index',[
  steps(['选择','校对','确认'],1),note('有 1 处需要核对。原文已保留，请先修正再保存。','warning','草稿尚未保存'),
  card('使用 JSP 开发 Web 应用系统','周二 · 第 1–2 节 · 第 2–6、8–17 周','博雅楼 B602 · 可点开编辑','10'),
  card('数据库应用技术','周三 · 第 3–4 节 · 第 1–16 周','地点无法识别 · 请核对','08','warning'),
  card('大学英语','周五 · 第 5–6 节 · 第 1–16 周','示例楼 B305 · 可点开编辑','10'),
  button('核对 1 处问题','08'),button('放弃草稿，返回课表','03','secondary')
 ],{back:'05'}),
 page('07','识别课表截图','正在处理 · 状态示意','pages/timetable/import/index',[
  steps(['选择','校对','确认'],0),{type:'empty',icon:'scan',title:'正在识别你的课表',text:'完成后会生成可编辑的草稿。\n这一步还不会保存课程。'},
  note('正在等待识别结果，请勿重复提交。\n你可以返回课表，已保存课程不会受影响。'),button('返回课表','03','secondary'),
  section('其他导入方式'),row('从 Excel 导入','先把文件发送到微信聊天','06','upload'),row('手工添加','逐门录入课程','10','edit'),
  button('查看识别成功稿（演示）','08','tertiary')
 ],{back:'05'}),
 page('08','核对课程信息','Excel / 截图共用校对 · 示例','pages/timetable/edit/index',[
  note('地点没有识别清楚，请对照原始课表填写。','warning','待核对 1 / 1'),
  card('保留的原文','数据库应用技术 [1-16]周 3-4节 B?05','只读原文 · 不自动猜测'),
  field('课程名','数据库应用技术'),field('地点','B305','按原图校对后的示例值'),field('星期与节次','周三 · 第 3–4 节'),field('教学周','第 1–16 周 · 每周'),
  button('保存这处校对，返回草稿','09'),button('取消校对','06','secondary')
 ],{back:'06'}),
 page('09','确认导入','核对完成 · 3 门示例课程','pages/timetable/import/index',[
  steps(['选择','校对','确认'],2),note('即将替换当前整份课表，请确认后继续。','warning','替换前再看一眼'),
  card('当前课表','6 门课程','当前已保存的课程'),card('导入后的课表','3 门课程 · 已核对','替换后以本次草稿为准','','blue'),
  note('取消会保留当前 6 门课程。\n确认保存成功后才返回周课表；失败仍停留在草稿。'),
  button('确认替换为 3 门课程','03'),button('取消，继续校对','06','secondary')
 ],{back:'06'}),
 page('10','编辑课程','新增 / 编辑共用表单 · 示例','pages/timetable/edit/index',[
  section('基本信息'),field('课程名 *','使用 JSP 开发 Web 应用系统'),field('教师','示例教师','不知道可以留空'),field('地点','博雅楼 B602'),field('学分','4','没有可以留空'),field('备注','实训课','选填'),
  section('上课安排'),chips(['一','二','三','四','五','六','日'],1),field('节次 *','第 1 节 — 第 2 节','这里只填节次，具体时刻可在设置中补充'),field('起止周 *','第 2 周 — 第 17 周'),chips(['每周','单周','双周'],0),field('课程颜色','靛青 · 同名课程保持同色'),
  button('保存课程','03'),button('取消，返回课表','03','secondary'),note('离开前请保存修改；删除课程还需要你再次确认。')
 ],{back:'03'}),
 page('11','管理课程','按课程查看 · 示例数据','pages/timetable/manage/index',[
  button('新增课程','10'),section('已保存课程','3 门示例'),
  row('使用 JSP 开发 Web 应用系统','周二 1–2 节 · 博雅楼 B602','10','book'),row('数据库应用技术','周三 3–4 节 · B305','10','book'),row('大学英语','周五 5–6 节 · B305','10','book'),
  note('删除前显示课程名和影响范围；取消不写入。','warning'),button('查看删除确认示意','36','secondary'),button('返回周课表','03','tertiary')
 ],{back:'03'}),
 page('12','学期与作息','日期和时刻，只用你确认的','pages/timetable/settings/index',[
  section('学期设置'),field('学期名称','2026–2027 学年第一学期'),field('第 1 周周一','2026-09-07','示例日期，由本人确认'),
  note('学校作息表尚未核实，不预置默认时刻。\n未填写的节次，课表只显示节次。','warning'),
  section('作息时间','可留空'),field('第 1 节','未填写 — 未填写','点击选择开始 / 结束时刻'),field('第 2 节','未填写 — 未填写'),row('下午 / 晚间节次','展开后继续填写','','settings'),
  button('保存设置','03'),button('返回课表','03','secondary'),note('保存失败保留本次输入；清空作息不删除课程。')
 ],{back:'03'}),
 page('13','课表助手','只处理你自己的课表','pages/timetable/index',[
  chips(['查课','增改课程'],0),quote('第 8 周星期二第 1–2 节有什么课？'),
  card('第 8 周 · 周二','使用 JSP 开发 Web 应用系统\n第 1–2 节 · 博雅楼 B602','回答示例 · 依据已保存课表','','blue'),
  note('增改课程会先给出变更提案，由你确认后才保存。'),
  field('输入你的问题','第 1–16 周，周三第 7–8 节加一节数据库实验，B305。'),button('发送，查看变更提案','14'),button('返回周课表','03','secondary')
 ],{back:'03'}),
 page('14','确认课程变更','助手提出的建议 · 尚未保存','pages/timetable/index',[
  quote('第 1–16 周，周三第 7–8 节加一节数据库实验，B305。'),
  note('这次将新增 1 门课程。请检查周次、地点和节次。','warning','等待你确认'),
  card('新增 · 数据库实验','周三 · 第 7–8 节\n第 1–16 周 · 每周','B305 · 示例提案','','blue'),
  note('课程数：3 → 4\n取消不会改变现有课表；保存成功后才显示已更新。'),button('确认新增课程','43'),button('取消这次变更','13','secondary'),button('查看失败恢复示意','15','tertiary')
 ],{back:'13'}),
 page('15','助手暂时不可用','失败分支示意','pages/timetable/index',[
  {type:'empty',icon:'cloud',title:'这次没有完成请求',text:'模型暂时不可用或响应超时。\n你的课表没有因此改动。'},
  quote('第 1–16 周，周三第 7–8 节加一节数据库实验，B305。'),button('重试这条请求','14'),button('改用手工编辑','10','secondary'),button('返回周课表','03','tertiary'),
  section('其他失败的文案'),note('内容未通过安全检查：请调整问题后再试。','warning'),note('今日可用次数已用完：稍后再试，仍可手工编辑。','warning')
 ],{back:'03'}),
 page('16','学生部门','先了解，再找到适合你的组织','pages/departments/index',[
  note('公开资料可直接浏览。未公布的校区、联系方式不推测。'),
  section('组织名录','5 个已收录组织'),row('校学生团委','校区未标注','','people'),row('校学生会','校区未标注 · 查看详情示例','17','people'),row('校学生社团管理部','校区未标注','','people'),row('青年志愿者联合会','广州校区、清远校区','','people'),row('退役军人事务服务部','校区未标注','','people'),
  button('向部门问答提问','18'),source('资料来源','学校官网公开资料','仓库资料核查日 2026-09-18；不是本轮重新核实')
 ],{prototypeNote:'列表示范链接以校学生会为详情样例；其他组织复用同布局。'}),
 page('17','校学生会','学生组织资料','pages/departments/detail/index',[
  {type:'orgHero',mark:'学生会',title:'校学生会',text:'校区未标注'},section('组织介绍'),note('职责、下设部门与动态按学校官网已核实资料展示；本稿不新增组织事实。'),
  section('联系方式'),note('官网未公布联系方式。\n本页不提供报名或部门账号。'),
  section('部门动态'),card('动态标题按来源原文展示','若只有标题级资料，回答不补写主办方、地点或报名方式。','示例条目 · 查看原文来源','35'),
  button('就这个组织提问','18'),source('学校官网','资料有缺失时，问答会直接说明。','资料快照核查于 2026-09-18')
 ],{back:'16'}),
 page('18','部门问答','当前对象：校学生会','pages/departments/detail/index',[
  quote('在哪里可以报名加入？'),card('资料中未找到报名方式','官网未公布这项信息，无法根据现有资料确认。','回答示例 · 不替组织生成联系方式'),
  source('参考资料 · 校学生会','当前资料仅支持查看组织介绍与已收录动态。','复制原文链接，可在微信里粘贴查看'),
  field('继续提问','例如：这个组织有哪些职责？'),button('提问（演示状态）','18'),button('返回组织详情','17','secondary'),note('问答失败保留问题；可重试或继续阅读公开资料。')
 ],{back:'17'}),
 page('19','校园资讯','来自学校官网，保留出处','pages/news/index',[
  note('以下为布局示例，不是实时学校通知。\n页面应显示最近成功读取时间，失败保留旧内容。'),
  {type:'newsLead',title:'关于本学期课程安排的通知',text:'示例资讯 / 2026-10-16',target:'20'},
  section('更多资讯','示例标题'),row('校园开放日活动回顾（示例）','2026-10-15 · 学校官网','20','news'),row('图书馆服务时间调整（示例）','2026-10-14 · 学校官网','20','news'),row('课程项目展示安排（示例）','2026-10-13 · 学校官网','20','news'),
  button('加载更多（演示）','34','secondary'),source('学校官网','发布日期与正文依原文展示。','最近成功读取：2026-10-16 09:00（示例）')
 ]),
 page('20','资讯详情','示例资讯 · 用于阅读版式评审','pages/news/detail/index',[
  {type:'article',title:'关于本学期课程安排的通知',meta:'2026-10-16 · 示例资讯',paragraphs:['这里是资讯正文的排版样例，用于检查长标题、段落和中文标点的阅读效果。本文不是学校发布的真实通知。','正文保留清楚的段落层次，日期、地点与参加对象来自原文。没有原文的信息不自行补全。','分享打开时直接阅读本页；没有上一页时，提供返回首页入口。']},
  source('原文出处','学校官网 · 实际正文须对应真实来源','资料读取时间与发布日期分别展示'),button('复制原文链接','35','secondary'),button('返回资讯列表','19','tertiary'),button('返回首页','01','tertiary')
 ],{back:'19'}),
 page('21','目标日','重要的日子，给它一个位置','pages/goals/index',[
  note('只保存在这台设备，不联网、不上传。'),metric('15','天后','课程项目展示 · 2026-10-31\n自定义示例事项 · 不计入当天'),
  row('课程项目展示','2026-10-31 · 点击编辑','22','flag'),button('添加目标日','22'),
  section('没有目标日时'),card('还没有目标日','添加一件你想记住的事。','空态示例','22'),note('过期事项显示「已过」，目标日当天显示「就是今天」。')
 ]),
 page('22','编辑目标日','一件事，一个日期','pages/goals/edit/index',[
  field('事项名称','课程项目展示','示例自定义事项'),field('目标日期','2026-10-31'),chips(['不计入当天','计入当天'],0),
  metric('15','天后','以 2026-10-16 为示例今天\n课程项目展示 · 2026-10-31'),button('保存目标日','21'),button('取消','21','secondary'),button('删除这条目标日','36','tertiary'),note('删除需二次确认；保存失败不改原记录。')
 ],{back:'21'}),
 page('23','校历与考试','查日期，也能核对来源','pages/calendar/index',[
  note('设计采用仓库资料快照，不是实时查询结果。\n考试与报名分开显示，未公布时不沿用往年。'),
  section('学校校历'),card('学期与教学安排','以本校通知为准','学校校历与全国放假安排分别核对','35'),
  section('考试日期卡'),card('已结束的考试批次','日期已过，显示「已结束」','历史资料样式，不继续显示倒计时','35'),card('待公布的考试安排','待公布','没有可核实日期时，不生成具体日期','35'),
  source('每条日期各自附来源','发布主体 · 适用范围 · 发布日期 · 核查日','正文与复制原文链接并列'),button('复制对应官方入口','35','secondary')
 ]),
 page('24','体测估算','按国家标准，算一份参考','pages/fitness/index',[
  note('国家学生体质健康标准（2014 年修订）。\n学校具体规则未核实；输入仅本机计算，不上传、不保存。'),
  chips(['男','女'],0),chips(['大一 / 大二','大三 / 大四'],0),
  field('身高 / 体重','175 厘米 / 61.3 千克'),field('肺活量','4300 毫升'),field('50 米跑','7.0 秒'),field('坐位体前屈','17.7 厘米'),field('立定跳远','248 厘米'),field('引体向上','15 次'),field('1000 米跑','3′42″','可填分秒或总秒数；此值为 222 秒'),
  button('估算','25'),note('留空的项目不会当成 0 分；缺项不生成总分。')
 ]),
 page('25','估算结果','男 · 大一 / 大二 · 完整示例','pages/fitness/index',[
  metric('84.0','良好','估算分 · 7 项已计入\n标准分 84.0 + 附加分 0'),
  note('这是按国家标准得到的估算，不是学校成绩。\n学校具体计分规则尚未核实。','warning'),
  {type:'table',heads:['项目','成绩','得分'],rows:[['BMI','20.0','100'],['肺活量','4300 毫升','80'],['50 米跑','7.0 秒','85'],['坐位体前屈','17.7 厘米','80'],['立定跳远','248 厘米','80'],['引体向上','15 次','80'],['1000 米跑','3′42″','80']]},
  button('修改数据，重新估算','24'),button('查看缺项结果','26','secondary')
 ],{back:'24'}),
 page('26','还缺 1 项数据','体测估算 · 缺项示例','pages/fitness/index',[
  note('肺活量没有填写，本次不给出总分和等级。\n未填项不会被当成 0 分。','warning','暂不给出学年总分'),
  {type:'table',heads:['项目','状态','单项分'],rows:[['BMI','20.0','100'],['肺活量','未填写','—'],['50 米跑','7.0 秒','85'],['坐位体前屈','17.7 厘米','80'],['立定跳远','248 厘米','80'],['引体向上','15 次','80'],['1000 米跑','3′42″','80']]},
  note('已填写项目仍可逐项查看，不能据此判断学校成绩。'),button('补填肺活量','24'),button('返回首页','01','secondary')
 ],{back:'24'}),
 page('27','升学与实习问答','从官方原文里找依据','pages/advancement/index',[
  note('资料有适用年份与核查日。回答不构成报考资格、录取或岗位判断。'),
  field('想了解什么？','2026 年普通专升本何时预报名？'),button('提问','28'),
  section('可以这样问'),row('普通专升本报名时间','按已收录年份查原文','28','book'),row('三二分段转段考核','先确认考试类型与年份','28','book'),
  section('资料范围'),source('官方材料快照','只展示有依据的内容；核对失败时直接给原文。','资料核查于 2026-10-03'),note('岗位、薪资与录取分数线不在当前资料范围。')
 ]),
 page('28','回答与依据','2026 普通专升本 · 历史资料','pages/advancement/index',[
  quote('2026 年普通专升本何时预报名？'),
  card('官方原文摘录 · [S1]','网上预报名时间为2026年1月12日09:00至19日18:00','已结束的 2026 批次，不适用于 2027 年'),
  source('[S1] 广东省2026年普通高等学校专升本招生工作规定','广东省教育考试院 · 粤招办普〔2025〕51号','发布 2025-11-19 · 核查 2026-10-03'),
  button('复制 [S1] 原文链接','35','secondary'),field('继续提问','可补充考试类型、适用年份'),button('查看暂不可用状态','29','secondary'),button('返回提问','27','tertiary')
 ],{back:'27'}),
 page('29','先查看原文','问答未能完成 · 状态示意','pages/advancement/index',[
  note('这次 AI 解释没有完成，问题已保留。\n你仍可阅读已找到的官方原文。','warning'),quote('2026 年普通专升本何时预报名？'),
  source('[S1] 官方原文摘录','网上预报名时间为2026年1月12日09:00至19日18:00','2026 历史批次 · 核查 2026-10-03'),button('复制原文链接','35','secondary'),button('重试这次提问','28'),button('修改问题','27','tertiary'),note('等待中可选择「取消，直接看原文」；资料未命中与模型失败分开提示。')
 ],{back:'27'}),
 page('30','项目讲解与答辩练习','把项目讲清楚，把依据说出来','pages/defense/index',[
  steps(['选材料','三轮练习','复盘'],0),
  card('课表导入与校对','本项目自有材料 · 9 条事实 + 3 条不变量','含待验证事项；不代表已验证全部功能','31'),
  card('打字练习小游戏','维护者原创设计情景','没有代码或测试记录；不是现有产品功能'),
  note('三轮提问，一次复盘，最多一次重答。\n只核对材料依据，不打分，不评定职业能力。'),
  note('每次反馈历史实测约 20–45 秒。\n会话只留在本页，退出后不保存。','warning'),button('选择「课表导入与校对」开始','31')
 ]),
 page('31','第 1 轮 / 共 3 轮','材料：课表导入与校对','pages/defense/index',[
  steps(['问题与目标','方案取舍','验证限制'],0),
  card('问题与目标','这个功能是给谁、解决什么问题的？请用两三句话说清。'),
  {type:'textarea',label:'你的回答',value:'学生把教务课表发到微信聊天，再选择文件导入。系统先生成草稿，遇到不确定信息交给学生校对，确认后才保存。[F1][F4]',hint:'20–500 字 · 示例回答 · 草稿仅留在本页'},
  source('材料速查','F1 从微信聊天选文件\nF4 识别不出的只标记不猜\nF8 三项仍待验证','条目编号用于回核，不是能力分数'),
  button('提交这一轮','32'),button('退出练习','37','secondary')
 ],{back:'30'}),
 page('32','正在核对你的回答','第 1 轮 · 等待状态示意','pages/defense/index',[
  {type:'empty',icon:'scan',title:'逐句对照材料依据',text:'需要读取材料，再核对你写的内容。\n历史实测约 20–45 秒，并非时延保证。'},
  note('停止等待后回到当前轮，保留已写内容。\n直接退出则清空本次材料、回答与反馈。'),button('停止等待，保留草稿','31','secondary'),button('退出练习','37','tertiary'),button('查看反馈稿（演示）','33','tertiary'),button('查看失败稿（演示）','38','tertiary')
 ],{back:'31'}),
 page('33','这一轮的依据核对','第 1 轮 · 静态反馈示例','pages/defense/index',[
  section('引用核对'),card('[F1] [F4] 可回核','从聊天选文件、识别不确定交给学生校对，与本份材料对应。'),
  section('是否对应回答'),note('本轮回答涉及学生与课表导入问题；反馈只核对材料与回答的对应。'),
  section('待验证保留'),note('[F8] 服务端隔离、分页与临时文件等仍待验证；练习不改变事实状态。','warning'),
  section('追问'),card('下一轮 · 方案及取舍','为什么先生成草稿，再由学生确认后保存？'),
  button('进入第 2 轮','39'),button('查看三轮复盘稿（演示）','40','secondary')
 ],{back:'31'}),
 page('34','资讯暂时没有更新','列表恢复状态示意','pages/news/index',[
  note('读取新资讯失败，仍展示最近一次成功的内容。','warning'),card('关于本学期课程安排的通知（示例）','旧内容仍可阅读','最近成功读取：2026-10-16 09:00（示例）','20'),button('重试读取','19'),
  section('首次无数据时'),card('暂时没有可展示的资讯','稍后重试；首页其他工具仍可使用。'),button('返回首页','01','secondary')
 ],{back:'19'}),
 page('35','链接已复制','原文链接复制反馈','pages/news/detail/index',[
  {type:'empty',icon:'check',title:'原文链接已复制',text:'在微信内合适的位置粘贴后查看原文。'},button('返回资讯详情','20','secondary'),note('如果复制失败，可以留在正文页重新复制。')
 ],{back:'20'}),
 page('36','删除前确认','删除状态示意','pages/timetable/manage/index',[
  note('确定删除「大学英语」？','warning','删除 1 门课程'),card('大学英语','周五 · 第 5–6 节','本操作只影响这门已保存课程'),button('确认删除（演示）','44'),button('取消，保留课程','11','secondary'),
  section('目标日删除的对应文案'),note('确定删除「课程项目展示」？\n取消后这条目标日仍保留。'),button('取消，返回目标日','22','tertiary')
 ],{back:'11'}),
 page('37','离开这次练习？','退出确认状态示意','pages/defense/index',[
  note('本次会话只存在当前页面。离开后，材料选择、回答、反馈与复盘将不保存。','warning','离开会清空本次练习'),button('继续练习','31'),button('确认退出，回首页','01','secondary')
 ],{back:'31'}),
 page('38','这一轮没能完成','第 1 轮 · 失败示意','pages/defense/index',[
  note('模型暂时不可用或响应超时。\n你的回答已保留，轮次没有推进。','warning'),
  quote('学生从微信聊天选择课表文件，先校对草稿，再确认保存。[F1][F4]'),button('重试当前轮','32'),button('返回修改回答','31','secondary'),button('复制已写的回答','38','tertiary'),note('失败不表示「你没讲清楚」。\n安全拒绝与额度用尽应使用各自原因文案。')
 ],{back:'31'}),
 page('39','第 2 轮 / 共 3 轮','材料：课表导入与校对','pages/defense/index',[
  steps(['问题与目标','方案取舍','验证限制'],1),card('方案及取舍','它是怎么做的？请说明关键环节，以及你放弃或没做的做法。'),{type:'textarea',label:'你的回答',value:'',hint:'20–500 字；未提交内容只保留在本页'},source('材料速查','[F1] 微信聊天选文件\n[F4] 未识别字段交由学生校对','示例轮次；第三轮复用结构，主题为验证与限制'),button('提交本轮（查看复盘示意）','40'),button('退出练习','37','secondary')
 ],{back:'31'}),
 page('40','三轮练习复盘','复盘示例 · 三轮反馈完成后','pages/defense/index',[
  steps(['选材料','三轮练习','复盘'],2),
  row('问题与目标','已反馈 · 对照 F1、F4'),row('方案及取舍','已反馈 · 对照 F4、INV-1'),row('验证与限制','已反馈 · F8 待验证仍保留'),
  note('仅整理各维度反馈和待验证事项，不评判项目质量，也不生成分数。'),
  button('复制复盘文字','40','secondary'),button('重答一处薄弱项','41'),button('退出练习','37','tertiary')
 ],{back:'31'}),
 page('41','重答一处薄弱项','本次仅一次 · 补充可回核的依据','pages/defense/index',[
  card('要补充的地方','解释为什么必须先校对，再确认保存。','材料：课表导入与校对'),
  {type:'textarea',label:'重新写一段回答',value:'识别不出的字段只标记不猜，学生核对后才确认保存。[F4] 草稿与已保存课表分开；未确认前不写入。[INV-1]',hint:'20–500 字；必须自己新写'},
  note('只把句子写长不算增加依据；材料中的待验证项继续保留。'),button('提交这次重答','42'),button('返回复盘','40','secondary')
 ],{back:'40'}),
 page('42','这次练习到这里','重答已结束 · 静态示例','pages/defense/index',[
  card('新增了可回核的依据','重答加入了 [F4] 与 [INV-1] 的对应说明。','示例反馈，不是学习效果证明'),note('[F8] 中的待验证事项仍未解决。\n会话不会长期保存，离开前可复制复盘。','warning'),button('复制复盘文字','42','secondary'),button('回到首页','01')
 ],{back:'40'}),
 page('43','课程已更新','确认保存成功后的状态示意','pages/timetable/index',[
  note('已按你的确认新增「数据库实验」。','neutral','变更已保存'),card('数据库实验','周三 · 第 7–8 节 · 第 1–16 周','B305 · 示例课程','','blue'),metric('4','门课程','本次变更：3 → 4\n只在保存成功后显示这条结果'),button('继续使用课表助手','13','secondary'),button('返回首页','01','tertiary')
 ],{back:'13'}),
 page('44','已删除这门课程','管理课程 · 删除成功示意','pages/timetable/manage/index',[
  note('「大学英语」已删除，其余 2 门课程保留。'),section('已保存课程','2 门示例'),row('使用 JSP 开发 Web 应用系统','周二 1–2 节 · 博雅楼 B602','10','book'),row('数据库应用技术','周三 3–4 节 · B305','10','book'),button('新增课程','10'),button('返回首页','01','secondary')
 ],{back:'11'})
];
// 第二轮修订：每屏只呈现一种当前状态；评审导航由渲染器放在产品画面外。
const get=id=>screens.find(s=>s.id===id);
const reviewLinks=items=>({type:'reviewLinks',items});
get('01').blocks=get('01').blocks.filter(b=>b.type!=='hero');
get('01').blocks.splice(1,0,{type:'heroCompact',title:'把校园日常，安排好。',text:'读资讯、找组织、查课表。'});
get('03').blocks=get('03').blocks.map(b=>b.type==='week'?{...b,rows:3}:b);
get('03').blocks.splice(1,0,{type:'weekToolbar',items:[{label:'管理课程',target:'11'},{label:'导入',target:'05'},{label:'设置',target:'12'}]});
get('03').blocks=get('03').blocks.filter(b=>b.type!=='tiles'&&b.type!=='row');
get('03').blocks.splice(4,0,row('第 7–12 节，本周无课','展开完整周视图','55','calendar'));
get('07').blocks=get('07').blocks.filter(b=>!(b.type==='button'&&b.label.includes('演示')));
get('07').blocks.push(reviewLinks([{label:'识别成功 → 校对',target:'08'},{label:'识别失败',target:'49'}]));
get('10').blocks.find(b=>b.type==='chips'&&b.items.length===7).weekdays=true;
get('10').blocks.push(reviewLinks([{label:'节次输入错误',target:'50'}]));
get('11').blocks.find(b=>b.type==='button'&&b.target==='36').label='删除「大学英语」';
get('13').blocks=get('13').blocks.filter(b=>b.type!=='chips');
get('13').blocks[0]=quote('第 8 周星期二第 1–2 节有什么课？');
get('13').blocks.find(b=>b.type==='note').text='可以查课，也可以提出新增或修改。涉及改课时，由你确认后才会保存。';
get('15').blocks=get('15').blocks.slice(0,5);
get('15').blocks.push(reviewLinks([{label:'安全检查未通过',target:'45'},{label:'可用次数用完',target:'46'}]));
get('17').blocks=[section('组织介绍'),note('校学生会是在校党委领导和校团委指导下的全校性学生组织。组织架构为“主席团 + 工作部门”，设权益部、文娱部、器材部、体育部、学创部 5 个部门。'),section('联系方式'),note('官网未公布联系方式。'),section('已收录动态'),card('第四届校园提案大赛圆满结束','资料快照收录的动态标题。','原文发布 2026-03-09 · 核查 2026-09-18','35'),button('就这个组织提问','18'),source('学校官网 · 团委','当前资料校区未标注；可复制来源核对。','资料核查于 2026-09-18')];
get('18').blocks.find(b=>b.type==='button'&&b.target==='18').label='发送问题';
get('19').blocks[0]=note('来源：学校官网\n最近成功读取：2026-10-16 09:00（示例）');
get('19').blocks.find(b=>b.type==='button').label='加载更多';
get('21').blocks=get('21').blocks.slice(0,4);
get('21').blocks.push(reviewLinks([{label:'首次没有目标日',target:'47'}]));
get('22').blocks.find(b=>b.type==='button'&&b.target==='36').target='51';
get('23').subtitle='资料核查于 2026-09-29 · 非实时';
get('23').blocks=[note('以下为已收录资料的快照；报名、适用年份和来源分别显示。'),section('学校校历'),card('学校校历','暂未收录可核实的公开日期。','可到学校教务处核对','35'),section('四六级'),card('大学英语四级笔试（CET4）','考试：2026-12-12 09:00–11:20\n报名：以本校教务处通知为准','2026 下半年 · 全国 · 快照核查 2026-09-29','35'),section('计算机等级'),card('2026 年 9 月批次 · 已结束','考试：2026-09-19 至 09-21','广东 · 原文发布 2026-06-24','35'),source('中国教育考试网 / 学校教务处','日期卡均可复制对应来源链接。','资料快照不代表本轮重新核实')];
get('25').blocks=get('25').blocks.filter(b=>!(b.type==='button'&&b.target==='26'));
get('25').blocks.push(reviewLinks([{label:'肺活量缺项的结果',target:'26'}]));
get('28').blocks=get('28').blocks.filter(b=>!(b.type==='button'&&b.target==='29'));
get('28').blocks.splice(get('28').blocks.findIndex(b=>b.type==='field')+1,0,button('发送问题','28'));
get('28').blocks.push(reviewLinks([{label:'模型暂不可用',target:'29'}]));
get('32').blocks=get('32').blocks.filter(b=>!(b.type==='button'&&b.label.includes('演示')));
get('32').blocks.push(reviewLinks([{label:'成功返回反馈',target:'33'},{label:'请求失败，保留回答',target:'38'}]));
get('33').blocks=get('33').blocks.filter(b=>!(b.type==='button'&&b.target==='40'));
get('34').blocks=get('34').blocks.slice(0,3);
get('34').blocks.push(button('返回首页','01','secondary'),reviewLinks([{label:'首次没有资讯',target:'48'}]));
get('35').blocks.push(button('返回首页','01','tertiary'));
get('36').blocks=get('36').blocks.slice(0,4);
get('38').blocks.find(b=>b.type==='note'&&b.text.includes('失败不表示')).text='请求未完成，不会对你的回答生成评价。';
get('39').blocks.find(b=>b.type==='button'&&b.target==='40').target='53';
get('39').blocks.find(b=>b.type==='button'&&b.target==='53').label='提交第 2 轮';
get('39').blocks.find(b=>b.type==='source').meta='引用条目须能在材料中回核。';
screens.push(
 page('45','内容未通过检查','课表助手 · 安全检查状态', 'pages/timetable/index',[
  note('这条问题未通过安全检查，请调整表述后再试。','warning'),quote('原问题会保留在输入框中。'),button('修改问题','13'),button('返回课表','03','secondary')
 ],{back:'13'}),
 page('46','今日可用次数已用完','课表助手 · 额度状态','pages/timetable/index',[
  note('今天暂时不能继续请求助手。已保存课表仍可查看和手工编辑。','warning'),button('手工编辑课程','10'),button('返回课表','03','secondary')
 ],{back:'03'}),
 page('47','目标日','重要的日子，给它一个位置','pages/goals/index',[
  {type:'empty',icon:'flag',title:'还没有目标日',text:'添加一件你想记住的事。'},button('添加目标日','22'),note('只保存在这台设备，不联网、不上传。')
 ]),
 page('48','校园资讯','暂时没有可展示的资讯','pages/news/index',[
  {type:'empty',icon:'news',title:'暂时没有资讯',text:'稍后再来看看，也可以重新读取。'},button('重新读取','19'),button('返回首页','01','secondary')
 ]),
 page('49','截图识别没有完成','你的已保存课表未改动','pages/timetable/import/index',[
  note('图片识别暂时不可用或请求超时。这次没有生成可保存的课表。','warning'),button('重新选择截图','07'),button('改用 Excel 导入','05','secondary'),button('手工添加课程','10','secondary'),button('返回课表','03','tertiary')
 ],{back:'05'}),
 page('50','请检查节次','编辑课程 · 输入错误状态','pages/timetable/edit/index',[
  field('课程名','数据库实验'),field('起始节次','5'),field('结束节次','3','','结束节次不能早于起始节次，请修改。'),note('本次输入尚未保存，其他字段已保留。','warning'),button('返回修改节次','10'),button('取消编辑','03','secondary')
 ],{back:'10'}),
 page('51','删除前确认','目标日 · 课程项目展示','pages/goals/edit/index',[
  note('确定删除「课程项目展示」？','warning','删除这条目标日'),card('课程项目展示','2026-10-31','只删除这一条本机记录'),button('确认删除这条目标日','47'),button('取消，保留目标日','22','secondary')
 ],{back:'22'}),
 page('52','第 3 轮 / 共 3 轮','材料：课表导入与校对','pages/defense/index',[
  steps(['问题与目标','方案取舍','验证限制'],2),card('验证与限制','哪些部分验证过、哪些还没验证？请如实说明依据与限制。'),{type:'textarea',label:'你的回答',value:'我能说明文件选择、草稿和确认保存的设计。[F1][F4] 但材料中 F8 列出的隔离、分页与临时文件问题仍待验证，不把它们说成已通过。',hint:'20–500 字 · 依据不足可以说明仍待验证'},button('提交第 3 轮','54'),button('退出练习','37','secondary')
 ],{back:'39'}),
 page('53','第 2 轮的依据核对','材料：课表导入与校对','pages/defense/index',[
  section('引用核对'),card('[F4] [INV-1] 可回核','先校对草稿，再由本人确认，才能成为已保存课表。'),section('是否对应回答'),note('本轮说明了草稿和保存之间的区别。'),section('待验证保留'),note('[F8] 的待验证事项继续保留。','warning'),section('追问'),card('第 3 轮 · 验证与限制','哪些部分已有依据，哪些仍未验证？'),button('开始第 3 轮','52')
 ],{back:'39'}),
 page('54','第 3 轮的依据核对','三轮已完成反馈后进入复盘','pages/defense/index',[
  section('引用核对'),card('[F1] [F4] [F8] 可回核','已完成的说明与仍待验证的事项分别保留。'),section('是否对应回答'),note('本轮讨论验证依据和限制。'),section('待验证保留'),note('没有新证据支持 [F8] 已完成，本轮继续保留待验证。','warning'),section('追问'),note('本轮为最后一轮；可以整理三轮复盘，再重答一处。'),button('查看三轮复盘','40')
 ],{back:'52'}),
 page('55','完整周课表','七天有课 / 长标题 · 压力样例','pages/timetable/index',[
  {type:'weeknav'},{type:'week',rows:6,dense:true},note('左右滑动查看完整七天；点课程查看完整名称和地点。'),button('返回当前周','03','secondary')
 ],{back:'03'})
);


// 第三轮：操作对象明确、来源可核对，成功反馈留在当前任务。
get('11').blocks=[button('新增课程','10'),section('已保存课程','3 门示例'),
 {type:'courseRow',title:'使用 JSP 开发 Web 应用系统',text:'周二 1–2 节 · 博雅楼 B602',edit:'10'},
 {type:'courseRow',title:'数据库应用技术',text:'周三 3–4 节 · B305',edit:'10'},
 {type:'courseRow',title:'大学英语',text:'周五 5–6 节 · B305',edit:'10',remove:'36'},
 note('删除课程还需要你再次确认，取消后课程保留。'),button('返回当前周课表','03','secondary')];
get('17').blocks.push(button('复制组织资料来源','17','secondary'));
get('18').blocks.splice(get('18').blocks.findIndex(b=>b.type==='source')+1,0,button('复制问答资料来源','18','secondary'));
const calBlocks=[];for(const b of get('23').blocks){calBlocks.push(b);if(b.type==='card')calBlocks.push(button('复制「'+b.title+'」来源','23','secondary'));}get('23').blocks=calBlocks;
const materialCards=get('30').blocks.filter(b=>b.type==='card');materialCards[0].title='● 已选 · 课表导入与校对';materialCards[0].tone='blue';materialCards[1].title='○ 打字练习小游戏';materialCards[1].meta='可选 · 没有代码或测试记录；不是现有产品功能';get('30').blocks.find(b=>b.type==='button').label='开始练习';
get('20').blocks.find(b=>b.type==='article').paragraphs=[
 '课程项目展示可以从问题、方案与验证三部分展开。同学们可提前整理项目说明、主要操作和结果依据，按课程要求准备展示内容。',
 '介绍已完成的工作时，请同时保留尚未验证的限制。演示可以展示实际操作、输入和可见结果，帮助听众理解项目如何解决具体问题。',
 '本文为资讯阅读示例，不对应学校实际通知。具体时间、地点和参加安排，请以学校发布的原文为准。'];
get('35').title='资讯详情';get('35').subtitle=get('20').subtitle;get('35').back='19';get('35').blocks=[{type:'toast',text:'原文链接已复制',target:'20'},...structuredClone(get('20').blocks)];
get('43').title='我的课表';get('43').subtitle='第 8 周 · 确认保存后的示例';get('43').blocks=[{type:'toast',text:'已新增「数据库实验」，现有 4 门课程。'}, {type:'weeknav'},{type:'week',rows:4,added:true},note('周三第 7–8 节 · 数据库实验 · B305\n第 1–16 周，已按你确认的内容保存。'),button('继续使用课表助手','13','secondary'),button('返回首页','01','tertiary')];
get('44').title='我的课表';get('44').subtitle='第 8 周 · 删除成功后的示例';get('44').blocks=[{type:'toast',text:'「大学英语」已删除，其余 2 门课程保留。'},{type:'weeknav'},{type:'week',rows:2,removed:true},button('新增课程','10','secondary'),button('返回首页','01','tertiary')];

export const icons={
 arrow:'<path d="M5 12h14M13 6l6 6-6 6"/>',calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18M7 14h3M14 14h3M7 17h3"/>',people:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-3-5"/>',news:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 7h10M7 11h10M7 15h4M7 18h10"/>',flag:'<path d="M5 21V3M5 4h14l-3 5 3 5H5"/>',activity:'<path d="M2 13h5l3-9 4 16 3-7h5"/>',book:'<path d="M12 5c-3-2-7-2-10 0v15c3-2 7-2 10 0 3-2 7-2 10 0V5c-3-2-7-2-10 0v15"/>',chat:'<path d="M21 15a3 3 0 0 1-3 3H8l-5 4V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3Z"/><path d="M7 8h10M7 12h7"/>',upload:'<path d="M12 16V3M7 8l5-5 5 5M3 15v6h18v-6"/>',edit:'<path d="m15 4 5 5M4 15 15 4l5 5L9 20H4z"/>',settings:'<circle cx="12" cy="12" r="3"/><path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z"/>',scan:'<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M6 12h12M9 8h6M9 16h6"/>',cloud:'<path d="M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5 5 0 0 1 0 10M12 10v4M12 18v1"/>',check:'<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/>'
};
export function iconSvg(name,color='#8c1614',size=24){return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${icons[name]||icons.arrow}</svg>`;}
