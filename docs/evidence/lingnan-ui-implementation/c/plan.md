# C 分支 · 学习计划页九种状态（岭南红 UI 第二轮）

实施者：c-plan　｜　工作树：`.worktrees/lingnan-ui-c`（分支 `codex/lingnan-ui-c`）
任务板：`task-2`（C-2 学习计划页全状态）
设计稿：`docs/design/lingnan-red-2026-11-11/` 的 `14-plan-input`、`15-constraints`、`16-preview`、`17-saved`、`18-conflict`、`40-expired-plan`、`43-ai-unavailable`、`49-basic-rules`、`64-constraint-clarify`
业务基线：`a35f9d9`；导航公共件 NAV_SHA：`2490ebd3ae94b8b58eebe70b1e658caf05fd6688`（HEAD `446eaf7` 已合入）

## 一、改了哪些文件

只动了 `miniprogram/pages/goals/plan/` 下三个文件（`index.json` 未改），另加 1 个新测试与本文档。`services/goals/**`（含 `plan.ts`、`saved.ts`、`intent.ts` 的 `PlanConstraints` / `constraints` 结构）、`app.json`、`app.wxss`、`styles/ui.wxss`、`ui/navigation.ts`、`ui/study/study.wxss` 与任何既有 `tests/*.test.cjs` 一行未改。

| 文件 | 行数（改后） | 对应设计稿 | 改动 |
| --- | --- | --- | --- |
| `miniprogram/pages/goals/plan/index.ts` | 1290（原 630） | 全部九屏 | 新增 `screen` 判别字段与状态推导、设计稿 h1/导语、统计三格、计划段、冲突卡、依据四行；新增基础规则页五组控件与映射；`generate()` 改为委托 `runGenerate()`；迟到保护原样保留 |
| `miniprogram/pages/goals/plan/index.wxml` | 504（原 164） | 全部九屏 | 按 `screen` 分屏重写：三步条 + 九块 `wx:elif` + 五态底部 dock；保留全部旧 `id` 与 `.gp-card` / `.gp-error` 选择器 |
| `miniprogram/pages/goals/plan/index.wxss` | 92（原 85） | 版式 | 首行 `@import "../../../ui/study/study.wxss";`；改为 `gp-*` 局部补充 + `u2-` / `st-` 组合；保留 `.gp-week` / `.gp-cell*` / `.gp-legend*` 网格样式 |
| `miniprogram/pages/goals/plan/index.json` | 3 | — | **未改动**（`navigationBarTitleText` 仍是「备考计划」，既有测试钉住）；设计稿的标题改由运行时 `wx.setNavigationBarTitle` 逐屏切换 |
| `tests/ui-v2-c-plan.test.cjs` | 新建 635 行 / 30345 B | — | 9 个用例（见第三节） |
| `docs/evidence/lingnan-ui-implementation/c/plan.md` | 本文件 | — | — |

## 二、状态模型

一个路由承载九屏，用**推导出来的判别字段** `screen`，不替换原字段：

```ts
type Screen =
  | 'loading' | 'pick' | 'missing'          // 三个前置门槛（读课表 / 没目标 / 目标已删）
  | 'input'                                 // 设计 14
  | 'rules'                                 // 设计 49
  | 'draft'                                 // 设计 15
  | 'clarify'                               // 设计 64（dropped / problems）
  | 'unavailable'                           // 设计 43
  | 'preview'                               // 设计 16
  | 'saved' | 'conflict' | 'expired';        // 设计 17 / 18 / 40
```

`refreshScreen()` 只读不写业务真相，优先级即状态机：

```
status(loading/pick/missing)
  → savedView → savedExpired ? expired : conflicts>0 ? conflict : saved
  → rulesOpen            → rules
  → aiDraftReady         → draft
  → plan !== null        → preview
  → aiOutcome clarify    → clarify
  → aiOutcome unavailable→ unavailable
  → 否则                  → input
```

为什么这样而不是九个 `if` 堆在业务字段上：

1. **原字段是契约**。`tests/goals-plan.test.cjs`（45 条，不可修改）断言的是 `status` / `plan` / `savedView` / `aiDraftReady` / `dropped` / `error` / `steps` 等原字段，`screen` 只是它们的函数。改 `screen` 不动任何一条既有断言，反过来就不成立。
2. **优先级只写一处**。九屏的互斥关系（例如「已保存且发现冲突」必须是 conflict 而不是 saved）是这次新增的语义，集中在 `refreshScreen()` 的 8 行里，模板只做 `wx:elif` 分流。
3. **推导数据一次算完**。`stepBar`（三步条）、`statCells`（统计三格）、`planItems`（计划段）、`conflictItems` / `conflictRestTitle` / `conflictRestNote`（冲突卡）、`evidenceRows`（依据四行）在同一处算好，模板里没有计算表达式——避免 WXML 里出现难以测试的字符串拼接。

`aiOutcome` 是新加的三值字段（`'' | 'clarify' | 'unavailable'`），因为「AI 这次是要求澄清还是暂时不可用」在原实现里只体现在 `aiMessage` 文本上，无法判别。`showPlan()` 的 `dropped` / `problems` 分支会同时写入 `aiOutcome: 'clarify'` 与 `clarifyQuote`（从提示里正则取出被引号括起来的原话），设计 64 的引文块才有内容。

## 三、与设计稿的对齐

### 已落地

- **14 输入**：三步条「说说情况 / 核对约束 / 预览计划」；h1「这一周，你想怎么学？」+ 导语「说说空闲时间和薄弱项。AI 整理后，你先核对，我们再安排时段。」；`你的情况` 大输入框（120 字上限）；小字「只发送目标名称和这段情况」+ 徽标「课表不发送」；主按钮「整理我的学习约束」；提示条「识别结果先给你核对，不会直接创建或保存计划。」；列表项「用基础规则安排 / 手动选择时长、频率和可用时段」→ 49。
- **49 基础规则**：眉标「基础规则 · 不请求 AI」；h1「自己定，也能安排清楚。」；五组控件——`每次学习时长`（30/45/60/90 分段）、`每周安排次数`（2–6 段）、`优先练习`（文本，12 字上限）、`不安排的星期`（周一–周日 chip 多选）、`不可用时段 · 可多选`（周六、周日各行 × 上午/下午/晚间 + 「晚上一律不排」开关）；提示「上午按第 1–4 节排除；规则检查已知课程、日期和时长，不安排过去时段。」；底部「按这些规则生成预览」+「返回 AI 整理入口」。
- **15 约束核对**：h1「这是你的意思吗？」+「AI 草稿」徽标；导语「每条都附上你的原话。核对后，再结合课表安排本周时段。」；`st-constraint` 逐条：序号圆环（`st-draft-mark`）+ 识别值 + 「原话：…」 + 右侧「修改」；默认项追加「默认：…」；底部「确认这些约束，生成预览」+「返回修改情况」+「只生成预览，不会保存或改动正式课程。」
- **64 约束澄清**：h1「有一句，还需要说具体一点。」；`u2-quote` 引原话；`u2-notice` 说明为什么无法确定（`dropped` / `problems` 原文）；小字「已确认的其他条件都保留；这里不会悄悄忽略限制，也不会按默认排。」；底部「返回修改这句话」+「自己选择不可用时段」+ 置灰「澄清后再生成预览」。
- **43 AI 不可用**：h1「这次先手动安排。」+ `aiMessage`；「已保留的情况」输入框（原话保留）；提示「不会自动重复请求，也没有保存新计划。」；底部「用基础规则设置」+「返回修改情况」。
- **16 预览**：h1「这一周，这样安排。」+「未保存」徽标；统计三格 本周安排 / 总学习时长 / 已知冲突；绿勾行「已检查已知课程与不可用时段」；`N 次练习` 分组；每段 `st-plan-item`：日期块（周X + 日）+ 题目 + 「第 a–b 节内」+「学习 M 分钟」（**窗口与分钟数分开写**）；提示「排在所示节次内，每次学习 M 分钟。未填写作息，不推算具体钟点。只保存本机计划，不加入正式课程。」；「对照本周课表」网格（6 行 × 周一至周五 + 图例三项 + 周末单列）；「为什么这样排」（rationale + 依据行 + `dropped` 红字 + 默认项小字）；底部「保存这份计划」+「换一个安排」+「重新核对约束」。
- **17 已保存**：眉标「已保存在本机」+ 徽标「离线可查看」；h1 由计划里读得出的弱项生成（`给听力，留好时间。`）；统计三格 + 计划段；「保存时的核对」逐段状态（冲突 / 已过去 / 未核对）；「这份计划的依据」四行（约束来源 / 每次·每周 / 避开 / 原计划日期）+「按保存时的课表检查 · 重新打开会提示新发现的冲突」；`savedNotice` 提示条；「去课表查看本周安排」+「重新生成计划」+「撤回本机计划」。
- **18 冲突**：眉标「已保存计划 · 课表有变化」；h1「有一处时间撞上了。」+ 导语「原计划仍在，没有自动改动。」；提示条首行「周X第 a–b 节与新课程冲突」+「请核对后决定是否重新生成。」；冲突卡（`冲突` 红标 + 原计划 / 新增课程 / 检查时间）+「另外 N 次练习 · 未发现已知课程冲突」；「按最新课表重新生成」+「先保留这份计划」+「去看课表」/「撤回本机计划」。
- **40 过期快照**：眉标「历史快照 · 目标有变化」；h1「计划还在，时间已经过去了。」+「历史记录」徽标；导语「保存于 X 月 X 日 — X 日，对应的目标日已删除或已过去。」；提示「只供回看；不再作为本周有效安排。不会自动创建目标或重新排程。」；依据卡 + 「选择一个有效目标」/「撤回本机计划」。

### 设计图编号 → 页面状态 → 入口条件 对照表

| 设计图 | `screen` | 页面实例里的入口（真实触发方式） | 关键 data |
| --- | --- | --- | --- |
| `14-plan-input` | `input` | `onLoad()` 后未选目标/未生成时；`hideRules()`、`editAiInput()` 也会回落到这里 | `constraintText` / `aiMessage` / `hasSaved` |
| `49-basic-rules` | `rules` | 输入页「用基础规则安排」行 → `showRules()`；43 屏「用基础规则设置」→ `onRulesFromAi()` | `ruleMinutes` / `ruleBlocks` / `ruleFocus` / `ruleWeekdays` / `rulePeriodRows` / `ruleNoEvening` |
| `15-constraints` | `draft` | `understandAi()` 拿到 `kind:'constraints'` 回复 → `aiDraftReady=true` | `aiEvidence`（每条 `label`/`value`/`quote`）、`aiDefaults` |
| `64-constraint-clarify` | `clarify` | `understandAi()` 得到 `kind:'clarify'`，或 `showPlan()` 拿到非空 `dropped` / `problems` | `clarifyQuote`、`clarifyReason`、`dropped`、`error` |
| `43-ai-unavailable` | `unavailable` | `understandAi()` 得到 `kind:'unavailable'`（`callAi` 返回 `ok:false`，如额度用尽） | `aiMessage`、`constraintText`（原话保留） |
| `16-preview` | `preview` | `confirmAiPlan()` 或 `generateRules()` → `showPlan()` 成功且 `blocks.length>0` | `statCells`、`planItems`、`gridRows`、`weekendLines`、`rationale`、`planMinutesText` |
| `17-saved` | `saved` | `onSave()` 写本机后；或 `onLoad()` 命中本机 `study-plan/v1` 且无冲突、目标未删 | `savedRows`、`savedSummary`、`savedRange`、`evidenceRows`、`savedNotice` |
| `18-conflict` | `conflict` | `savedView=true` 且 `scanConflicts()` 扫到与新课程重叠（`onShow()` 重读课表后刷新） | `conflictItems`、`conflictRestTitle`、`conflictRestNote`、`savedNotice` |
| `40-expired-plan` | `expired` | `savedView=true` 且（原目标日被删 或 目标日期已过 → `savedPlanView().title==='已保存的历史计划'`） | `savedGoalMissing`、`savedRows`、`evidenceRows` |

三个前置门槛不属于九张设计图，但同一路由也要能表达：`loading`（读课表前）、`pick`（本机还没有目标日）、`missing`（`?id=` 带来的目标日已被删）。它们的设计依据是既有实现与既有测试，不是本轮设计稿。

### 有意偏差（需评审知晓）

1. **49 的「不安排的星期」与「不可用时段」合并映射**：设计稿只有「周六/周日 × 上午/下午/晚间」两行；本实现额外提供周一–周日的 `excludedWeekdays` chip，因为服务层 `PlanConstraints` 有该字段且 AI 支路会产出它，落在规则页才不至于「AI 能表达、手动不能表达」。两者都映射到同一套字段，没有新增存储。
2. **`noWeekendMorning` 不是独立开关**：它由「周六上午 + 周日上午都被勾中」推导（`ruleWeekendMorning()`），避免同一事实两个控件打架。副作用是只勾周六上午时不会置 `noWeekendMorning`，而是走 `blockedSections`——语义更精确，测试里钉住了这一点。
3. **h1 与 `headline` 分开**：`headline` 继续是业务说明（既有测试断言 `还剩 N 天`、`这个目标日已经不在了` 等），设计稿的版式标题放在新增的 `heroTitle`。两者都渲染，位置不同。
4. **`index.json` 标题未改**：`navigationBarTitleText` 被既有测试钉为「备考计划」；九屏标题改由 `wx.setNavigationBarTitle` 运行时切换（有 `typeof` 守卫，测试宿主没有该 API 时静默跳过）。
5. **「去课表」保留降级路径**：真机走 `openTimetable({kind:'plan-week', planDate})`（写意图 + `switchTab`）；宿主没有 `switchTab` 时退回 `wx.navigateTo('/pages/timetable/index?planDate=…')`。既有测试 `stub.calls.navigate === ['/pages/timetable/index?planDate=2026-11-10']` 因此继续通过，同时满足「课表已是 tab 页」的新要求。

## 四、测试

命令（一律走 `scripts/ui-v2-c-run.cjs` 串行构建，不直接跑 `build.mjs` / `npm test`）：

```
node scripts/ui-v2-c-run.cjs --wait 300 tests/goals-plan.test.cjs tests/saved-plan.test.cjs tests/plan-intent.test.cjs tests/ui-v2-c-plan.test.cjs
npx tsc --noEmit
```

**实际结果（2026-11-13 19:5x，含构建）**

| 测试文件 | tests | pass | fail | skipped |
| --- | --- | --- | --- | --- |
| `tests/goals-plan.test.cjs`（既有，未改） | 45 | 45 | 0 | 0 |
| `tests/saved-plan.test.cjs`（既有，未改） | 6 | 6 | 0 | 0 |
| `tests/plan-intent.test.cjs`（既有，未改） | 5 | 5 | 0 | 0 |
| `tests/ui-v2-c-plan.test.cjs`（新建） | 9 | 9 | 0 | 0 |
| **合计** | **65** | **65** | **0** | **0** |

四测一起跑一次（含重建）：`tests 65 / pass 65 / fail 0 / cancelled 0 / skipped 0 / todo 0 / duration 644.8387ms`（run exit 0；此前同命令 563.3356ms，差异只是构建/调度波动）。
`npx tsc --noEmit`：**退出码 0，无输出**。
顺带回归把主题规则与 tab 路由两支既有测试一起拉进来（六支一次跑，含构建）：`tests 73 / pass 73 / fail 0 / cancelled 0 / skipped 0 / todo 0 / duration 773.0654ms`，run exit 0（即 65 + `tests/wxss.test.cjs` 与 `tests/ui-v2-a-tabbar.test.cjs` 的 8 条；同命令前一次 804.5707ms，差异只是调度波动）。

新增 `tests/ui-v2-c-plan.test.cjs` 的 9 个用例：

| # | 用例 | 守的契约 |
| --- | --- | --- |
| 1 | 九屏前五个入口：输入 → 基础规则 → AI 草稿 → 澄清 → 不可用 | `screen`/`navTitle`/`heroTitle` 逐屏正确；`wx.setNavigationBarTitle` 真被调用；草稿态 5 条原话、未写库；澄清态引出「周四下午要去实验室」；不可用态原话保留 |
| 2 | 九屏后四屏：预览 → 已保存 → 冲突 → 过期快照 | 统计三格 `4次/240分钟/0`、计划段首条「周二 29 听力 第 1–2 节内 学习 60 分钟」、依据四行 key、冲突卡「另外 3 次练习」、过期态 `savedGoalMissing` |
| 3 | 基础规则控件映射 | `ruleConstraints()` 深等于 `{maxMinutesPerBlock:30,blocksPerWeek:3,focus:'听力',noWeekendMorning:true,noEvening:true,excludedWeekdays:[4],blockedSections:[{6,1,4},{7,1,4}]}`；取消勾选后字段收回（不残留） |
| 4 | 按规则生成预览不请求模型 | `plan.origin==='rules'`、2 段、`weekday!==4`、`minutes<=45`、`constraintText` 含三项；`aiCount()===0`；除 `list`/`getSettings` 外无云端调用；不写 `study-plan/v1`；无定时跳转 |
| 5 | `dropped` / `problems` 必须上屏 | WXML 有 `{{dropped}}` / `.gp-error` / `{{clarifyReason}}`；`实验室` 原话进 `dropped` 且进 `error`；`200 分钟` 的 problems「180」上屏；`plan===null`；auto-scroll 到 `.gp-error` |
| 6 | 去课表走公共意图桥 | `switchTab===['/pages/timetable/index']`；存储里 `{kind:'plan-week',planDate:'2026-11-10'}`（TTL 内）；无 `navigateTo`；宿主无 `switchTab` 时退回旧 URL |
| 7 | 迟到响应不上屏（两种情形） | 退出页面后到达的回复：`aiDraftReady=false`、证据清空、计划为空、不写库；改写原话后到达的回复：新输入不被覆盖、仍不写库 |
| 8 | 换排法 / 保存 / 重开不额外请求模型 | `aiCount()` 恒为 1；换排法真的换天；保存 deepEqual 计划段且不写 `timetable/courses`；重开 `screen==='saved'`、`origin==='ai-constraints'`、存储字节不变 |
| 9 | 模板与样式契约 | 九个 `screen === 'x'` 分支都在；`Screen` 联合类型含 12 个取值；WXSS 首行 `@import "../../../ui/study/study.wxss";`；21 句设计原话在 WXML；16 个旧 `id` 全保留 |

## 五、未落地项与可达性边界

1. **设计 15（AI 草稿屏）在离线 / 模型不可用时的实际表现：不会停在 15，也不会停在 43，而是停在 14 输入屏并给一行提示。** 实测（`.scratch/probe-offline.cjs`，把 `wx.cloud.callFunction` 换成直接抛错）：
   - `onLoad` 后 `screen=input`、`status=ready`；
   - 点「整理我的学习约束」→ `screen` 仍是 `input`，`aiMessage='读不到课表，先确认网络再试：network offline'`、`error=''`、`aiOutcome=''`、`aiDraftReady=false`，`constraintText` 原样保留；
   - 转基础规则后 `generateRules()` 同样 `screen` 停在 `rules`、`error` 是同一句「读不到课表…」，`busy` 复位为 `false`。
   原因：`understandAi()` / `runGenerate()` 都是**先 `loadTimetable()` 再调模型**，课表读不到就在第一步失败，走的是「读不到课表」分支（与既有实现一致，既有测试也钉住了这句文案），而不是 `requestPlanIntent` 返回的 `kind:'unavailable'`。**设计 43 因此只在「课表读到了、模型调用失败（如额度用尽）」时可达**——这也是它该出现的时候：模型不可用但课表正常，用户仍能用基础规则排程。若产品希望「离线时也显示 43 屏」，需要在 `loadTimetable()` 失败时另设一个状态，属于产品口径变化，本轮未做。
2. **计划页不经过 `canAskModel`，它走的是 `callAi` 的 `ok` 判定。** `canAskModel` 是 `services/advancement/model.ts` 的守卫（升学模块），计划页的 AI 链路是 `services/goals/intent.ts` 的 `requestPlanIntent()` → `services/ai.ts` 的 `callAi()` → 失败时 `userMessage(result)` 归类为 `kind:'unavailable'`。所以「没有模型能力」在计划页有两种到达方式，表现不同：
   - **课表读得到、`callAi` 返回 `ok:false`（额度用尽 / 服务端拒绝）或抛错** → `requestPlanIntent` 返回 `kind:'unavailable'` → 页面进**设计 43**（`screen='unavailable'`，原话保留在 `#plan-constraint-keep`，可转基础规则）；
   - **课表读不到（离线）** → 更早失败，停在 14/49 并提示「读不到课表…」，见第 1 条。
3. **设计 15 没有独立的「AI 正在理解」屏**：`aiBusy=true` 期间仍停在 14，只是主按钮文案变「AI 正在理解…」且 `disabled`。设计稿也没有该屏，这里只是说明加载态没有单独页面。
4. **16/17/18 三张原生截图**：`scripts/ui-v2-c-capture.cjs` 不在本任务可写范围，本轮未改；三屏的渲染与文案由 `tests/ui-v2-c-plan.test.cjs` 用例 1/2 覆盖（`statCells`/`planItems`/`conflictItems` 逐项断言）。截图由 lead 侧脚本另行打通。
5. **`noWeekendMorning` 与 `blockedSections` 的边界**：只勾周六上午时走 `blockedSections` 而非 `noWeekendMorning`（见第二节偏差 2）。若评审希望「勾任一个上午就算周末上午不排」，需要改 `ruleWeekendMorning()` 一处，属产品口径而不是技术限制。
6. **`PlanConstraints.focus` 上限 12 字**：规则页输入框按 `slice(0, 12)` 截断，超长输入不提示（服务层校验会拒绝超长，这里提前截断，避免走到「约束数据不完整」）。若希望显示字数提示，需要加字段与样式。
7. **320px 只有样式兜底**：`@media (max-width: 350px)` 只调了周网格 gap 与卡片内边距；窄屏下五列网格的单元字（20rpx）是否可读未做真机核对。
8. **`scripts/verify-goals.cjs` 未复跑**：该脚本（上一轮手工 E2E，不在 `npm test` 里）由 c-goals 报告选择器已过时，与计划页无关。
9. **并行构建纪律**：本轮全程用 `node scripts/ui-v2-c-run.cjs`，未直接跑 `build.mjs` / `npm test`，`dist/` 与其他两人的测试未互相踩空。

## 六、执行记录

| 时间 | 动作 | 结果 |
| --- | --- | --- |
| 19:21 | 写完 `index.ts`（九屏状态机） | `tsc` 报 8 条（TS7006 ×6、TS2339 `coursesKnown`），曾致 `dist/` 被清空、全队测试阻塞 |
| 19:2x | 修 TS：显式类型注解 6 处、`this.coursesKnown`、`PlanItemView` 补 `date` | `tsc --noEmit` 0 错，已通知 lead 与 c-goals 解锁 |
| 19:3x | 重写 `index.wxml` / `index.wxss` | 首轮三测 `tests 56 / pass 55 / fail 1`：`fresh.onUnload is not a function`（漏了生命周期） |
| 19:3x | 补 `onUnload()`（`unloaded=true` / `intentRequest+=1` / `aiDraft=null`） | 三测 `tests 56 / pass 56 / fail 0` |
| 19:40 | 新建 `tests/ui-v2-c-plan.test.cjs` 首跑 | `tests 9 / pass 7 / fail 2`：①`stub.calls.timers` 应为 `stub.timers`；②`type Screen` 是多行联合类型，单行正则不匹配 |
| 19:41 | 修两处测试自身错误（断言目标写错，非产品缺陷） | `tests 9 / pass 9 / fail 0` |
| 19:5x | 完整四测（含重建，最后一次改动之后） | `tests 65 / pass 65 / fail 0 / skipped 0 / duration 644.8387ms`，run exit 0 |
| 19:5x | `npx tsc --noEmit` | 退出码 0，无输出 |
| 19:5x | 按 capture 脚本的 `wxmlExpect` 补三处静态文案（「已保存在本机」眉标、「已保存计划 · 课表有变化」眉标、冲突态导语字面量） | 回归 `goals-plan` + `ui-v2-c-plan` 合计 `54 / pass 54 / fail 0` |
| 19:5x | 六支测试 + 重建收尾（复核） | `tests 73 / pass 73 / fail 0 / skipped 0 / duration 773.0654ms`，run exit 0；`tsc --noEmit` 退出码 0 |
| 19:5x | 离线探针（`.scratch/probe-offline.cjs`，`wx.cloud.callFunction` 直接抛错） | `screen` 停在 input / rules，`aiMessage` = 同一句「读不到课表…」，`constraintText` 保留；见第五节第 1 条 |
| 19:5x | 补第五节第 2 条：计划页不走 `canAskModel`（那是 `services/advancement/model.ts` 的升学守卫），走 `requestPlanIntent → callAi → ok:false` | 说明「模型不可用」在计划页的两条到达路径：课表可读→43 屏；课表不可读→14/49 + 提示 |
