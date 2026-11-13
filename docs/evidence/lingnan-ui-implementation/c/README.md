# 岭南红 UI 并行实施 · C 角色交付报告

本报告覆盖目标日、学习计划、校历、体测、升学问答、答辩练习六块（C 范围）。
自测结论不等于 Codex 最终验收；本文件只记录 C 自己跑出来的数字与亲眼核过的截图。

## 1. 身份与提交基线

| 项 | 值 |
| --- | --- |
| 角色 | C（学习工具与目标日/学习计划/校历/体测/升学问答/答辩练习） |
| 分支 | `codex/lingnan-ui-c`（worktree `F:\VibeCoding\wx-match\.worktrees\lingnan-ui-c`） |
| 起始交接 SHA | `da008af9eeee032f1aac38911488badd8d4af873`（`docs(协作): 固定岭南红UI三人并行实施与审查交接`） |
| 业务基线 | `a35f9d9f1c11bba60e32cb65e314f629cceeb2ba`（`feat(AI): 补齐调课与学习计划闭环并交付岭南红设计稿`） |
| 合入的公共基础 NAV_SHA | `2490ebd3ae94b8b58eebe70b1e658caf05fd6688`（`codex/lingnan-ui-foundation`，A 负责） |
| 建立 NAV_SHA 的 merge commit | `446eaf7e0b6ff3f357560752d82350662714804e`（`chore(协作): 合入岭南红公共基础 NAV_SHA`） |
| **实际被测的代码提交** | `c487329a23885937cfecc0f219a66d7922815be3`（`feat(学习工具): 按岭南红设计重写目标日、学习计划、校历、体测、升学与答辩六块`，33 个文件） |
| 证据与报告提交 | 本报告所在的提交（最终 HEAD，SHA 由交付消息给出——报告不自指自身哈希） |
| 最终 HEAD | 由交付消息给出 |
| 分支地址 | https://github.com/Iskuyal/wx-match/tree/codex/lingnan-ui-c |

第 4 节的 `npm test` / `npm run typecheck` / `npm run docs:check` 三项在 `c487329` 上重新跑过（日志 `.scratch/final-test6.log`），数字与表中一致。`22b4bc2` 相对 `c487329` **只增加了 `docs/evidence/` 下的报告与截图，没有改动任何代码、测试或小程序资源**（`git show --stat 22b4bc2` 可核：全部为新增 `.md` / `.png` / `.json`）。所以第 4 节的数字对 `22b4bc2` 同样成立，不需要重测。

合入方式：`git merge --no-ff 2490ebd`，A 的提交成为第二父；未改写公共文件，未合 main，未部署。

## 2. 改动文件

### 2.1 重写的页面（C 范围，23 个文件）

| 页面 | 文件 |
| --- | --- |
| 目标日首页 | `miniprogram/pages/goals/index.ts` / `.wxml` / `.wxss` |
| 目标日编辑 | `miniprogram/pages/goals/edit/index.ts` / `.wxml` / `.wxss` / `.json` |
| 学习计划 | `miniprogram/pages/goals/plan/index.ts` / `.wxml` / `.wxss` |
| 校历与考试 | `miniprogram/pages/calendar/index.ts` / `.wxml` / `.wxss` |
| 体测估算 | `miniprogram/pages/fitness/index.ts` / `.wxml` / `.wxss` |
| 升学问答 | `miniprogram/pages/advancement/index.ts` / `.wxml` / `.wxss` |
| 答辩练习 | `miniprogram/pages/defense/index.ts` / `.wxml` / `.wxss` |

`git diff --stat`：**25 个已跟踪文件，+4010 / −978**（含下节两个脚本与一个模块测试）。

### 2.2 新增文件

| 文件 | 说明 |
| --- | --- |
| `miniprogram/ui/study/study.wxss` | 六页共用样式底座（`st-` 前缀，9358B）；五页首行 `@import "../../ui/study/study.wxss";` |
| `tests/ui-v2-c-goals-home.test.cjs` | 目标日首页 20 例 |
| `tests/ui-v2-c-plan.test.cjs` | 学习计划 9 例 |
| `tests/ui-v2-c-tools.test.cjs` | 校历/体测/升学 10 例 |
| `tests/ui-v2-c-defense.test.cjs` | 答辩练习 14 例 |
| `tests/ui-v2-c-cross-tab.test.cjs` | 跨 tab 与导航契约 9 例 |
| `scripts/ui-v2-c-capture.cjs` | 原生模拟器截图与状态核对（31 个场景） |
| `scripts/ui-v2-c-run.cjs` | 串行构建 + 定向测试跑手（目录租约，避免多人共用 `dist/` 互删） |
| `docs/evidence/lingnan-ui-implementation/c/` | 本报告 + 4 份模块报告 + 35 张截图 + 2 份 capture-report |

### 2.3 改到的两个非页面文件（需在审查时特别确认）

- `scripts/lib/ui-capture-window.ps1`（+69/−…）：原先按 `MainWindowTitle` 找窗口，IDE 窗口最小化时 `MoveWindow` 静默失败导致截图只有 149×321。改为 `EnumWindows` + `GetWindowTextW` 精确匹配、先 `ShowWindow(SW_RESTORE)` 再 `MoveWindow`，并新增 `-Title` / `-Matches` / `-Action list` 参数。**只影响截图工具，不进小程序产物。**
- `scripts/verify-goals.cjs`（+20/−…）：新 UI 的 DOM 与文案变了，脚本 4 处断言过时（`.goal-action` 现分 `-edit`/`-warn` 且多了「排学习计划」键；首页入口带文案、空态标题、`.goal-strip-unit` 已合并进 `.goal-strip-value`）。**改的是断言不是选择器搬迁**，实测 `WECHAT_AUTO_PORT=9465 node scripts/verify-goals.cjs` → `"result": "passed"`，9 项 check 全绿。
- `tests/campus-tools-pages.test.cjs`（+14/−…）：`goHome()` 现在先走 `openUiTab('today')`（Promise），把该用例改 `async` + `await setImmediate`，并新增一条「有 switchTab 时必须切 tab 不 reLaunch」。属 C 模块专属测试，A 维护的公共测试未动。

## 3. 设计图编号 → 实际页面/状态

设计稿目录：`docs/design/lingnan-red-2026-11-11/png/`。C 相关 35 个编号，**31 个已留原生证据图**。

| 设计编号 | 实际页面 | 状态 | 证据图 |
| --- | --- | --- | --- |
| 12-goals | `pages/goals/index` | 有目标（未到期/今天/已过期三组） | `shots/12-goals.png` |
| 55-goals-empty | `pages/goals/index` | 空态 | `shots/55-goals-empty.png` |
| 13-goal-edit | `pages/goals/edit/index` | 修改已有目标 | `shots/13-goal-edit.png` |
| 54-goal-delete | `pages/goals/index` | 删除确认弹窗 | `shots/54-goal-delete.png` |
| 14-plan-input | `pages/goals/plan/index` | 输入约束 | `shots/14-plan-input.png` |
| 49-basic-rules | `pages/goals/plan/index` | 基础规则（不调模型） | `shots/49-basic-rules.png` |
| 15-ai-draft | `pages/goals/plan/index` | AI 约束草稿待本人核对 | `shots/15-ai-draft.png` |
| 16-preview | `pages/goals/plan/index` | 规则预览（未保存） | `shots/16-preview.png` |
| 17-saved | `pages/goals/plan/index` | 已本机保存 | `shots/17-saved.png` |
| 18-conflict | `pages/goals/plan/index` | 课表变化后冲突 | `shots/18-conflict.png` |
| 40-expired-plan | `pages/goals/plan/index` | 计划对应目标日已失效 | `shots/40-expired-plan.png` |
| 64-constraint-clarify | `pages/goals/plan/index` | 约束歧义澄清 | `shots/64-constraint-clarify.png` |
| 43-ai-unavailable | `pages/goals/plan/index` | 模型不可用，保留已填情况 | `shots/43-ai-unavailable.png` |
| 25-calendar | `pages/calendar/index` | 校历与考试 | `shots/25-calendar.png` |
| 26-fitness | `pages/fitness/index` | 体测录入 | `shots/26-fitness.png` |
| 27-fitness-result | `pages/fitness/index` | 七项齐全出总分 | `shots/27-fitness-result.png` |
| 63-fitness-missing | `pages/fitness/index` | 缺项不出总分 | `shots/63-fitness-missing.png` |
| 28-advancement | `pages/advancement/index` | 升学问答首屏 | `shots/28-advancement.png` |
| 29-clarify | `pages/advancement/index` | 范围不清需澄清 | `shots/29-clarify.png` |
| 30-answer | `pages/advancement/index` | AI 解释 + 对应原文 | `shots/30-answer.png` |
| 31-defense | `pages/defense/index` | 材料选择 | `shots/31-defense.png` |
| 32-practice | `pages/defense/index` | 第 1 轮作答 | `shots/32-practice.png` |
| 33-pending | `pages/defense/index` | 等待反馈 | `shots/33-pending.png` |
| 34-feedback | `pages/defense/index` | 本轮反馈 | `shots/34-feedback.png` |
| 42-material | `pages/defense/index` | 材料查阅浮层 | `shots/42-material.png` |
| 35-recap | `pages/defense/index` | 三轮复盘 | `shots/35-recap.png` |
| 60-reanswer | `pages/defense/index` | 重答输入 | `shots/60-reanswer.png` |
| 61-reanswer-result | `pages/defense/index` | 重答后反馈（结束） | `shots/61-reanswer-result.png` |
| 62-exit | `pages/defense/index` | 退出确认弹窗 | `shots/62-exit.png` |
| 77-practice-record | `pages/defense/index` | 练习记录（可复制） | `shots/77-practice-record.png` |
| 78-copied-record | `pages/defense/index` | 复制完成 | `shots/78-copied-record.png` |

**未单独留图的 4 个**（同构状态，不算缺失，已在各模块报告中说明）：
- `15-constraints`：与 `15-ai-draft` 同一屏，设计稿把同一页拆成两张走查图。
- `56-practice-2` / `57-feedback-2` / `58-practice-3` / `59-feedback-3`：与 `32-practice` / `34-feedback` 同构，只是轮次不同；截图脚本的 `defenseAdvance(round)` 已能产出，本轮按证据成本取前三轮代表图。

## 4. 测试命令与实际结果

全部在最终代码上执行，`dist/` 由 `node scripts/build.mjs` 重新构建。

| 命令 | 实际结果 |
| --- | --- |
| `npm test` | **tests 998 / pass 998 / fail 0 / cancelled 0 / skipped 0 / todo 0**，duration ≈ 26.8 s，exit 0（日志 `.scratch/final-test5.log`） |
| `npm run typecheck` | exit 0（`tsc --noEmit` + `tsc --noEmit -p cloudfunctions/tsconfig.json`） |
| `npm run docs:check` | **268 个 Markdown / 2136 个本地引用 / 0 个错误** |
| `node scripts/ui-v2-c-capture.cjs` | **31/31 场景通过**，全部 371×802 原生截图 |

历史基线是 918 项（交接时）与 A 合入后的 936 项；998 = 936 + C 新增 5 个 `ui-v2-c-*` 测试文件的 62 例。

### 4.1 模块专项（各模块负责人自跑）

| 范围 | 结果 |
| --- | --- |
| `tests/goal-pages.test.cjs` + `tests/ui-v2-c-goals-home.test.cjs` | 34 / 34 |
| `tests/goals-plan.test.cjs` + `saved-plan.test.cjs` + `plan-intent.test.cjs` + `ui-v2-c-plan.test.cjs` | 65 / 65 |
| `tests/ui-v2-c-tools.test.cjs` + `calendar` + `fitness` + `advancement` + `advancement-model` + `campus-tools-pages` + `wxss` | 62 / 62 |
| `tests/lingnan-ui.test.cjs` + `defense-wiring/g0/g1/g3/cloud/timeout` + `wxss` + `ui-v2-c-defense.test.cjs` | 90 / 90 |
| `tests/ui-v2-c-cross-tab.test.cjs` | 9 / 9 |

### 4.2 跨 tab 回归（NAV_SHA 合入后补）

`tests/ui-v2-c-cross-tab.test.cjs` 守的是接上公共导航后才暴露的错，9 例：
1. 学习工具三页「回到学习」走 `openUiTab('study')`，无 switchTab 时退回 `reLaunch` 且路由已注册；
2. 校历/体测/升学「回到今天」在栈底切今天 tab、栈中有上一页只返回；
3. 目标日首页与编辑页同语义；
4. 计划页「去课表」写公共 key `lingnan/ui-timetable-intent/v1`（`{kind:'plan-week', planDate, id, createdAt}`）再切课表 tab，无 switchTab 退回 `/pages/timetable/index?planDate=…`；
5. C 的页面源文件**不得**出现 `lingnan/` / `timetable-intent` / `TIMETABLE_INTENT`（不许私造公共 key）；
6. C 不得直接 `switchTab` 到课表（会丢掉 `plan-week` 意图）；
7. 导航不发云请求、不改 `goal-days/v1` 与 `study-plan/v1`。

**该测试发现并修正了真实缺陷**：`pages/calendar/index.ts`、`pages/advancement/index.ts`、`pages/fitness/index.ts` 的 `goHome()` 原先都是 `reLaunch({url:'/pages/home/index'})`——reLaunch 到 tab 页不是 tab 切换语义，底栏不高亮。三处统一改为 `openUiTab('today').catch(() => wx.reLaunch(...))`。

## 5. 原生截图与数据身份

- 路径：`docs/evidence/lingnan-ui-implementation/c/shots/`，**31 张 PNG，全部 371×802**，逐张读完 PNG 头校验宽高一致。
- 生成方式：微信开发者工具原生模拟器（`miniprogram-automator` 连 `ws://127.0.0.1:9463`），独立项目副本 `.scratch/capture-project-<dist 指纹>`，**不经浏览器渲染**。
- 机器可读核对：`shots/capture-report.json` → `capturedAt=2026-11-13T12:53:10.948Z`、`width:390`、`31/31 ok:true`、每张 `missing:[]`、含 `size`。
- 数据身份：全部来自本地种子，不触碰真实业务数据、不调真实 AI。
  - 目标日：`goal-days/v1` 注入三条（英语考试 2026-12-19 `countToday:true`、普通话水平测试 2027-03-08、英语四级报名截止 2026-09-25 已过期）。
  - 体测：七项全量（175 / 61.3 / 4300 / 7.0 / 17.7 / 248 / 15 / `3′42″`）；缺项态去掉 `distanceRun`。
  - 学习计划：`study-plan/v1` 每场景先 `removeStorageSync`，再由页面真实生成。
  - 答辩/升学：`wx.cloud.callFunction` 在页内被替换为固定回包（含 `safety:{passed:true,checked:true}`），**没有真实网络请求**。
- 学习计划六屏不是 setData 造出来的：用 `mini.evaluate` 取 `getCurrentPages()` 的实例，直接调 `pickGoal/showRules/showPlan/onSave/showSavedPlan`，再用 `expectScreen` 校验推导字段 `screen` 与设计状态一致。`page.callMethod` 只能造 data，造不出推导屏，所以走这条路。

### 5.1 截图局限（如实说明）

- **371×802 不是 390 逻辑宽度**：IDE 项目窗口放大到 1720×1080 时截图为 371×802；宽度受 IDE 窗口可放大上限约束，未达设计稿 390。**320px 窄屏未做真机核对**，只有 `@media (max-width: 350px)` 样式兜底（C 各页都有该分支）。这一点与 A/B 的证据口径一致，不应被当作 320px 已验收。
- 设计稿 8.5/8.6 的运行成绩**未沿用**；本报告所有成绩都来自本轮实际命令输出。

## 6. 六块实际完成情况

### 6.1 目标日（12 / 13 / 54 / 55）
- 首页三组真实分组（未到期 / 今天 / 已过期）+ hero 卡显示最近目标与剩余天数；空态「下一个目标，是什么？」。
- 编辑页 `index.json` 标题改「编辑目标日」；运行时再 `setNavigationBarTitle('我的目标日')`。
- 删除走 `wx.showModal`（既有测试钉住 modal 文案），未建设计 54 的独立页。

### 6.2 学习计划（14 / 15 / 16 / 17 / 18 / 40 / 43 / 49 / 64）
- 12 屏判别模型（`screen` 由 `status/plan/savedView/aiDraftReady/aiOutcome/rulesOpen` 推导，不靠 setData 造假）。
- **流程保持「AI 约束草稿 → 本人确认 → 规则预览 → 本机保存/重开」**：`services/goals/plan.ts` 的算法未改，只在其上做屏与文案；换排法、保存、重开都不再请求模型。
- 保存写 `study-plan/v1`，重开走 `savedPlanView()`；课表变化时进冲突屏且**不自动改动原计划**；目标日失效进 expired 只供回看。
- 约束识别只认五类（时长 / 每周次数 / 薄弱项 / 不排日期 / 不排时段），其余原句进 `dropped` 并停在澄清屏，**不按默认忽略**。

### 6.3 校历与考试（25）
- 零日期常量，只渲染 `CALENDAR_EVENTS` 9 条；无官方日期的 4 条不显示日期、不给倒计时，改「日期待公布 / 日期以本校为准 / 暂无官方日期」+ 卡内原因说明。
- 复制原文链接保留成功/失败 toast 文案。

### 6.4 体测估算（26 / 27 / 63）
- 页面不计算任何分数，单项分直渲染 `estimate()`；总分卡只在 `result.total !== null` 时渲染。
- 缺项屏明写「不给学年总分、也不给等级」，`totalText` 为 `—`，此屏没有大分数位置；缺项可就地补填。

### 6.5 升学问答（28 / 29 / 30）
- `canAskModel` 为假时不调 `callAi`；降级时 `modelText === result.answer`（本地原文不改写）。
- 正文 `[S1]` 与「对应原文」共用编号、点任一侧高亮另一侧；范围条「2026 年已存政策 · 非新年度报考依据」+ 通道/年份/地区。
- 范围不清时走澄清屏并给三个可点通道，不请求模型。

### 6.6 答辩练习（31 / 32 / 33 / 34 / 35 / 42 / 60 / 61 / 62 / 77 / 78）
- 九段同页切换（材料 → 作答 → 等待 → 反馈 → 复盘 → 重答 → 结束 → 记录 → 复制）。
- **练习记录复制**（设计 77/78）：段名与设计稿逐字对齐，三轮完整记录 + 复盘 + 重答独立成段。
  - 原答原字符串直取，**不 trim、不截断、不改写**；
  - 回答与反馈同轮同时非空才纳入（pending 跳过）；
  - 复盘只纳入 `status==='已反馈'` 的行，编号连续无空号；
  - 复制全程只读内存（`cloud` 0 次、`storage` 0 次）；
  - 空会话不调 `setClipboardData` 只提示；复制失败不重置会话，可重试。
- **退出恢复**：`wx.showModal` 明确「会话只在页面内存」；取消保留，确认才清空并返回。

## 7. 未解决项与已知偏差

按影响排序，均为如实记录：

1. **截图宽度 371 而非 390；320px 仅样式兜底未真机核。** IDE 窗口可放大上限所致，不是页面问题。
2. **设计 13「备注（选填）」未落地**：`GoalDay` 无该字段、存储结构冻结在本轮，不写假字段。设计 12 的「管理目标」区块改为三组真实分组 + 行内修改/删除。
3. **设计 54 独立删除页未建**：走 `wx.showModal`，既有测试钉住 modal 文案。
4. **`goStudy()` 的 `openUiTab('study')` 成功分支未被单测覆盖**：wx 桩无 `switchTab`，只有退回 `reLaunch` 的分支被断言；跨 tab 测试补了导航契约，但 switchTab 成功路径仍靠人工读代码。同理 `goHome()` 的 switchTab 分支只在校历页有专项断言。
5. **规则页 `focus` 输入 `slice(0,12)` 静默截断**，无字数提示；超过 12 字会自动截断而不提示用户。
6. **`noWeekendMorning` 由「周六上午 + 周日上午都勾中」推导**：只勾周六上午时走 `blockedSections`。语义更准，但与「勾任一上午即算」的直觉不同；改 `ruleWeekendMorning()` 一处即可切换。
7. **设计 43 在纯离线（课表也读不到）时不可达**：`understandAi()` 与 `runGenerate()` 都先 `loadTimetable()`，课表失败在第一步就停在 14/49 + 一行提示。已用截图证明「课表可读 + 模型失败」这一半可达（`43-ai-unavailable.png`）。
8. **`#qa-again` 改名 `#qa-reask` 后与原 id 并存**，按旧 id 找元素的脚本需同步。
9. **`miniprogram/pages/{goals,goals/edit,calendar,fitness,advancement,defense}/index.json` 里周目标日与答辩页标题未逐一核对**：目标日编辑页已改「编辑目标日」，答辩页仍为「项目讲解与答辩练习」。若设计稿要求别的标题需再调。
10. **答辩页 `index.json` 未改**：标题保持「项目讲解与答辩练习」。
11. **`scripts/verify-goals.cjs` 改的是断言**（4 处过时文案/选择器 + 1 处多余节点断言）：已实测 9 项 check 全绿，但这属于 C 改动共享验证脚本，请审查时确认是否可接受。
12. **`.scratch/` 下的探针脚本与截图项目副本未提交**（`.gitignore` 排除），交付物只含 `scripts/ui-v2-c-*.cjs` 两个可复用脚本。
13. **未做真实云端/真机联调**：所有 AI 落点在截图时用固定回包替换 `wx.cloud.callFunction`，只证明界面与降级逻辑，**不证明真实模型输出质量**。真实模型评估仍按既定决策关卡另走。

## 8. 提交与复现

```powershell
git clone https://github.com/Iskuyal/wx-match
cd wx-match
git worktree add .worktrees/lingnan-ui-c codex/lingnan-ui-c
cd .worktrees/lingnan-ui-c
npm ci
npm run typecheck        # exit 0
npm test                 # 998/998
npm run docs:check       # 268 md / 2136 引用 / 0 错误
```

原生截图复现（需要微信开发者工具已启用 CLI 服务端口）：

```powershell
# 1) 起自动化会话（分离进程，前台启动会让端口立刻进 TimeWait）
Start-Process -FilePath "D:\微信web开发者工具\cli.bat" `
  -ArgumentList "auto","--project","<capture 项目副本绝对路径>","--auto-port","9463","--trust-project" `
  -WindowStyle Hidden
Start-Sleep -Seconds 20
# 2) 截图 + 状态核对
node scripts/ui-v2-c-capture.cjs --out docs/evidence/lingnan-ui-implementation/c/shots
```

## 9. 证据文件索引

| 文件 | 内容 |
| --- | --- |
| `c/goals-home.md` | 目标日两页实现、20 例测试明细、截图数字 |
| `c/plan.md` | 学习计划 12 屏模型、约束识别规则、9 例测试明细 |
| `c/tools.md` | 校历/体测/升学三页实现、10 例测试明细 |
| `c/defense.md` | 答辩练习九段状态机、复制四边界、14 例测试明细 |
| `c/shots/` | 31 张原生截图（371×802）+ `capture-report.json`（`31/31 ok:true`，每张 `missing:[]`） |
| `c/shots-goals/` | 目标日 4 张独立截图 + `capture-report.json`（4 条记录，每张 `missing:[]`；该报告字段名是 `shots` 而非 `results`，且没有 `ok` 字段，判定依据是 `missing` 为空） |

本报告固定「实际被测的代码提交 = `c487329a23885937cfecc0f219a66d7922815be3`」。证据与报告随后作为一次提交落地，即最终 HEAD（SHA 在交付消息中给出；报告内不自指自身哈希）。两者之间**只多出 `docs/evidence/` 下的报告与截图，没有代码改动**（42 个文件全部为新增 `.md` / `.png` / `.json`）。若审查后要求改代码，需重跑第 4 节全部命令，不能沿用本次数字。
