# 岭南 UI 原生实现与离线验证

日期：2026-10-17。负责人已批准 [57 屏设计](../../design/lingnan-ui-2026/README.md)，实现跟踪 [Issue #137](https://github.com/Iskuyal/wx-match/issues/137)。本次将 16 条在用页面改写为原生 WXML/WXSS；初始源码提交 `153e0ad`，随后在 `4141f01` 整合 main 的网络提示与收尾记录。当前渲染版本及截图哈希见 [manifest.json](manifest.json)。

2026-10-18合入补记：[PR #139](https://github.com/Iskuyal/wx-match/pull/139)已合入main `a35ec6c`；本记录的测试和截图仍为10-17证据。合入不表示部署或新版本真机验收。

## 已实现

- 首页采用官网 EST.2001 盾形横版校徽；统一岭南红、纸白表面、边框、文字层级、44/48px 控件和来源动作。
- 课表、导入校对、编辑、管理、设置保留现有业务接口。七天等宽并横向滚动，节次轴位于滚动区域外；只收起末尾空课时，晚间课程保留。非连续周次、列表、同格多课、本人确认与替换语义保留。
- 部门与资讯、目标日及编辑、校历、体测、升学问答采用同一视觉体系；保留真实内容、缺失说明、来源和降级路径。未将设计中的示例课程、新闻或分数写入产品数据。
- 答辩练习先选择材料，再明确开始。完整材料由原有 G0 冻结事实卡生成，包含前言、不变量、条目与边界，未改原件；客户端仍只向模型接口发送 materialId。支持目录定位、固定关闭和返回当前轮/重答草稿，复盘显示及复制原有四节反馈，不生成能力分数。
- 课程管理增加逐门编辑与确认删除，复用既有服务端归属接口；未能落格的课程也可在管理列表处理。微信原生按钮默认宽度以显式宽度约束修正。

## 验证

| 检查 | 实际结果与边界 |
| --- | --- |
| 改版前基线 | 本机原有 757 项测试通过；保存构建快照。修改前因工具登录失效，未取得本轮客户端基线截图 |
| 整合 main 后 | `npm test` 767/767 通过，0 失败、0 跳过；`npm run typecheck` 通过 |
| 新增回归 | 材料原文及边界、选择再开始、查阅保持原轮/重答草稿、完整复制、七天与晚间课程、无法落格课程的行内编辑/取消删除、单门确认删除 |
| 原生模拟器 | [10 项交互检查与 30 张截图清单](simulator.json)，本轮全部通过；基础库 3.17.2，iPhone 12/13 (Pro)，屏幕 390×844，内容区 390×753 |
| 数据与副作用 | 接管后云函数、数据库、上传与本机存储均为内存夹具；真实云请求 0 次。连接前启动资讯读取不在此统计范围；未调用付费业务模型、未部署、未保存真实课程或个人目标日 |
| 320px 辅助布局 | [8个画面](narrow/report.json)由实际渲染树和当前WXSS在Chrome按320×568视口排版，未发现页面横向溢出；这是浏览器辅助，原生控件与键盘差异不能由它证明 |
| 原生窄屏与真机 | 当前工具无可选老机型，本轮未取得320px微信截图。新 UI 真机、读屏、系统字号、真实上传/保存与剪贴板均未由本轮证明 |

截图为实际小程序渲染，不是 HTML 设计图。课程、新闻、目标日及模型反馈明确为离线示例；模拟失败和成功反馈均不作为真实模型质量、实际服务可用性或学习效果证明。

原始本机日志保存在 `artifacts/ui-implementation/`，该目录按项目约定不入仓；可审阅截图及结构化结果归档于本目录。前期失败尝试也保留在该本机目录，不能把旧缓存或未滚动的图片当作当前通过证据。

## 主要画面

[首页](screenshots/01-home.png) · [周课表](screenshots/02-timetable.png) · [周日与晚间](screenshots/03-timetable-right.png) · [课程详情](screenshots/04-course-sheet.png) · [课程管理](screenshots/07-course-manage.png) · [校对草稿](screenshots/09b-import-review.png) · [材料 F5 定位](screenshots/22-defense-reader.png) · [三轮复盘](screenshots/24-defense-review.png) · [重答](screenshots/25-defense-reanswer.png) · [读取失败](screenshots/27-timetable-error.png)。其余页面及输入清单见 [视觉简报](visual-brief.md)。

## 复跑

```powershell
npm test
npm run typecheck
npm run docs:check
& '<微信开发者工具>/cli.bat' reset-fileutils --project '<仓库>/dist'
& '<微信开发者工具>/cli.bat' auto --project '<仓库>/dist' --auto-port 9420 --trust-project
node scripts/verify-lingnan-ui.cjs
node scripts/render-lingnan-narrow.cjs
```

先完成构建，再清理编译缓存、关闭并重新打开当前项目、重置文件索引和启用自动化，避免新模板读取旧脚本。原生截图脚本临时放大本项目后台窗口以取得可读PNG，结束后恢复原窗口几何，不更改模拟机型。构建与共享端口的模拟器验证串行运行。最后两项使用离线夹具；不要以会调用真实 AI 的 `verify:wechat` 替代本轮验证命令。

独立视觉复查使用 [固定输入](visual-brief.md)和 manifest 中的提示词哈希，普通改版模式、1 名全新上下文评审；意见另存，不把此前静态设计评分套用到实现。

首轮原始证据、7.4/10局部意见及证据缺口归档于[review-1](review-1/visual-review-1.md)，它只属于旧版本。定向修订先画[紧凑布局](../../design/lingnan-ui-implementation/README.md)，压缩课表首屏、折叠文件详情，保留替换后果；另补正部门问答截图、区分失败动作、合并重复追问、提高材料类型标签可读性。当前版本评分另列，不合并历史分数。

最终[第三轮独立意见](visual-review-3.md)对当前静态覆盖局部暂评8/10，未观察到高影响布局缺陷；未给完整总体分数，保留原生窄屏和操作连续性等缺口。各轮版本、修订与未采纳取舍见[复查记录](revisions.md)。
