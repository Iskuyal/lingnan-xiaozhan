# A 段交付：公共基础、首页与校园（岭南红原生实现）

2026-11-13。本目录是 A（公共基础 + 首页/学习/校园/部门/资讯）的交付证据，供 Codex 复核。
设计已由负责人确认（79 图，LN-6c774710ba24831b，静态评分 8.5/8.6），本轮直接实施，不重复索取视觉确认。

## 身份与提交

| 项 | 值 |
| --- | --- |
| 角色 | A：公共基础、首页、学习/校园聚合入口、部门、资讯 |
| 起始交接 SHA | `da008af9eeee032f1aac38911488badd8d4af873` |
| 业务基线 | `a35f9d9f1c11bba60e32cb65e314f629cceeb2ba` |
| 公共基础 NAV_SHA | `2490ebd3ae94b8b58eebe70b1e658caf05fd6688`（分支 `codex/lingnan-ui-foundation`，HEAD `958565d` 只多一条进度文档） |
| 本分支 | `codex/lingnan-ui-a`（从 `958565d` 建，包含 NAV_SHA 全部内容） |
| 实际被测代码 | `8b1b6ee88bf9ed0d1df950be4bf2f525abf99e7e` |
| 最终 HEAD | 本文件所在提交（只追加本文档与进度记录；其后的提交不改产品代码，SHA 见交付消息与 Issue #147 评论） |

## 改动范围

只动 A 的归属：`app.json`、`app.wxss`、`styles/ui.wxss`、`ui/navigation.ts`、`assets/ui-v2/`、
`pages/home|study|campus|departments|news`，以及公共测试与 `scripts/verify-ui-v2-a.cjs`。
没有改云函数、`services/` 业务逻辑、存储结构、B/C 的页面，也没有碰 79 张设计原稿。

## 设计图 → 页面/状态

| 图 | 页面 | 实现状态 |
| --- | --- | --- |
| 01 今天 | `pages/home/index` | 日期角标、下一节课红卡（时刻取该课程最后节次的结束时间）、四个快捷入口、今日时间线、继续计划 |
| 53 未知作息 | 同上 | `hero.mode=unknown-times`：只按节次看，不出现任何具体时刻，给「填写作息 / 直接看周课表」 |
| 36 无课表 | 同上 | `hero.mode=empty`：导入课表 / 先手工添加一门课，并说明不猜测「正在上课」 |
| 37 读取失败 | 同上 | `hero.mode=error`：可重试，不说「今天没课」 |
| 11 学习 | `pages/study/index` | 目标日红卡（本机目标日 + 已保存计划段数）、四个学习工具 |
| 19 校园 | `pages/campus/index` | 学校卡、部门/校历入口、最近资讯三态、学校资料与出处、复制官网链接 |
| 20 学生部门 | `pages/departments/index` | 抬头、问答入口卡、五个组织、出处；问答面板进入即展开 |
| 21 组织资料 | `pages/departments/detail/index` | 徽记 + 名称 + 核查日、校区说明、介绍、下设部门、联系与动态、未找到分支 |
| 22 / 65 部门问答 | `pages/departments/qa.wxml/.wxss` | 学生气泡、回答气泡、来源条、发送区；资料不足时如实说明 |
| 23 校园资讯 | `pages/news/index` | 日期列 + 标题、来源与同步时间常驻、加载更多与失败重试、空态 |
| 24 资讯详情 | `pages/news/detail/index` | 标题、来源与日期、正文段落、原文链接与复制、返回 |

导航：四个真实 tab（今天/课表/学习/校园），公共导航接口严格按共享约定实现，
跨 tab 只经 `ui/navigation.ts` 的一次性意图，不复制第二个 storage key。

## 测试与实际结果

命令均在本分支、`8b1b6ee` 上跑出：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `node scripts/build.mjs` | 通过（微信小程序已构建至 `dist/`） |
| `npm test` | **934 / 934 通过，0 失败 0 跳过**（基线 918，净增 16：导航契约 12、tab 注册契约 6，减去两条旧入口测试的合并） |
| `npm run docs:check` | 264 个 Markdown、2136 个本地引用、0 错误 |
| `node scripts/verify-ui-v2-a.cjs` | **14 项检查、21 张原生截图通过**（端口 9461，独立项目目录） |

原生验证的关键断言：下一课 `10:10 — 12:35`、`第 3-4 节`；没填作息时所有行 `timeText` 为空；
空课表与读取失败各自成态；学习页读到本机目标日（12月19日）；校园页资讯读取失败可重试；
部门问答资料不足时回答含「没有这项信息」；资讯详情往返与分享直达返回；
首页问课表切到课表 tab 并写入 `{kind:'assistant'}` 意图。

原生截图（`screens/`，390px 模拟器，534×1154 像素，JSON 报告 `screens/report.json`）：

| 文件 | 状态 |
| --- | --- |
| 01-home-next-class | 首页常规（下一课 + 快捷入口 + 时间线起点） |
| 02-home-timeline | 首页时间线（含「空闲 1 小时 25 分」段） |
| 03-home-unknown-times | 没填作息 |
| 04-home-empty | 无课表 |
| 05-home-error | 课表读取失败 |
| 06-study / 07-study-no-goal | 学习页有/无目标日 |
| 08-campus / 09-campus-news / 10-campus-news-error | 校园页常规、资讯区、资讯失败 |
| 11-departments / 12-department-qa / 13-department-qa-insufficient | 部门名录、问答面板、资料不足回答 |
| 14-department-detail / 15-department-detail-qa / 16-department-not-found | 部门资料、详情内问答、未找到 |
| 17-news-list / 18-news-detail / 19-news-error / 20-news-empty | 资讯列表、详情、失败、空态 |
| 21-timetable-from-home-intent | 首页问课表切到课表 tab，意图已写入 |

数据身份：截图全部来自离线夹具——云函数、云数据库与本机存储被接管，课程为「布局示例」，
资讯为「离线布局验证示例」，目标日为「英语四级考试 / 2026-12-19」。
接管后真实云请求与真实模型调用均为 **0**；`report.json.mockCalls` 只记录被夹具拦下的
`timetable` 读取与一次 `ai / department-qa` 固定响应。

## 边界与未解决项

- **320px 原生未取**：模拟器没有脚本化改设备宽度的可靠入口，本轮只做了 390px 原生截图；320px 的
  字号与换行需要真机或用开发者工具手动切设备复核，不能按已完成记录。
- **跨 tab 意图的消费端在 B**：本轮只验证「首页写入意图 + 切到课表 tab」。课表页读完课程与设置后
  调用 `consumeTimetableIntent()` 并应用 `assistant/week/plan-week` 属 B 的范围，合入后需在集成
  候选里复验一次真实点击链路。
- **真机、读屏、系统字号、键盘顶起与分享参数未验**：全部证据来自开发者工具模拟器，不代表真机。
- **分享直达只验了「无处可返时回列表」**：携带真实分享参数的冷启动路径未覆盖。
- 部门问答的回答卡片与设计 22 的图标位置仍有差别（回答用浅灰气泡而非白卡 + 图标）；文字层级、
  来源条与操作区一致，未改业务文案。
- 学习页「本周 N 段安排」只在存在已保存计划时出现；本轮夹具里没有计划，因此截图未展示该行，
  单测覆盖的是空计划与有目标日两种状态。
- 旧首页的常驻问 AI 输入条、语音按钮与全模块入口墙按设计移除，对应的旧入口测试已改为
  学习/校园两个聚合页的断言（`tests/pages.test.cjs`、`tests/home-ask.test.cjs`、
  `tests/news.test.cjs`、`tests/goal-pages.test.cjs`、`tests/defense-g3.test.cjs`、
  `tests/campus-tools-pages.test.cjs`），业务断言（超长截断、空输入、失败重试、已注册路由）保留。

## 复现

```powershell
npm install
npm run typecheck
npm run build
npm test
npm run docs:check
# 原生验证：先把当前构建拷到独立项目目录，再打开自动化端口
node scripts/build.mjs
Copy-Item -Recurse -Force dist/* artifacts/ui-v2-a/project-<唯一名字>/
& "<微信开发者工具>\cli.bat" auto --project artifacts/ui-v2-a/project-<唯一名字> --auto-port 9461 --trust-project
node scripts/verify-ui-v2-a.cjs
```

`verify-ui-v2-a.cjs` 会把截图与 `report.json` 写回本目录的 `screens/`；它只在夹具接管成功后操作页面，
失配时以非零退出码结束。
