# C 分支 · 目标日首页与编辑页（岭南红 UI 第二轮）

实施者：c-goals　｜　工作树：`.worktrees/lingnan-ui-c`（分支 `codex/lingnan-ui-c`）
任务板：`task-1`（C-1 目标日首页与编辑页）
设计稿：`docs/design/lingnan-red-2026-11-11/` 的 `12-goals`、`55-goals-empty`、`13-goal-edit`、`54-goal-delete`
业务基线：`a35f9d9f1c11bba60e32cb65e314f629cceeb2ba`；导航公共件 NAV_SHA：`2490ebd3ae94b8b58eebe70b1e658caf05fd6688`

## 一、改了哪些文件

只动了任务允许的 8 个页面文件，另加 1 个新测试与本文档。`services/goals/**`（含 `plan.ts`、`saved.ts`）、`app.json`、`app.wxss`、`styles/ui.wxss`、`ui/navigation.ts`、`ui/study/study.wxss` 与任何既有 `tests/*.test.cjs` 一行未改。

| 文件 | 对应设计稿 | 改动 |
| --- | --- | --- |
| `miniprogram/pages/goals/index.ts` | 12 / 55 | 新增 `feature`（下一个目标 / 今天的目标大数字卡）、`hasSavedPlan` / `savedTitle` / `savedMeta` / `savedStale` / `savedStaleNote`（本机已存计划快照卡）、`onViewSaved()`、`setNavigationTitle()`；`goHome()` 改为栈底走 `openUiTab('today')`，`navigateBack` 逻辑保留；`onShow` 重载、三组计数与全部旧方法/文案不变 |
| `miniprogram/pages/goals/index.wxml` | 12 / 55 | 换成 `u2-` 版式：h1 两行 + 右上角新建按钮、`u2-hero` 主卡（`st-hero-count` 大数字 / `st-hero-name`）、已存计划白卡、三组分组列表（未到期 / 今天 / 已过期）、空态两个按钮、页脚「回到今天」 |
| `miniprogram/pages/goals/index.wxss` | 12 / 55 | 首行 `@import "../../ui/study/study.wxss";`；重写为 `.goals-*` + `.goal-*` + `u2-`/`st-` 组合；保留 `.goal-item-upcoming` / `.goal-item-today` / `.goal-item-expired` / `.goal-name` / `.goal-state` / `.goal-action*` 等既有选择器名 |
| `miniprogram/pages/goals/index.json` | 12 | 未改动（`navigationBarTitleText` 仍是「目标日」）；空态标题改由运行时 `setNavigationBarTitle('我的目标日')` 切换 |
| `miniprogram/pages/goals/edit/index.ts` | 13 / 54 | 保留全部既有逻辑与文案；删除确认文案补第二行「已保存的学习计划保留原快照，并提示目标已删除。」；新增 `setNavigationTitle()`（新建 / 编辑两态）；`goBack()` 栈底改为 `openUiTab('today')` 并以 `reLaunch('/pages/goals/index')` 兜底 |
| `miniprogram/pages/goals/edit/index.wxml` | 13 / 54 | 换成 `u2-` 版式 + `st-field` / `st-input` 表单：目标名称、目标日期（picker）、是否计入当天（开关）、预览卡、提示条、底部「保存目标日」/「删除目标日」/「取消」；missing 态换成 `u2-empty` |
| `miniprogram/pages/goals/edit/index.wxss` | 13 / 54 | 首行 `@import "../../../ui/study/study.wxss";`；重写为 `.goal-*` + `u2-`/`st-` 组合 |
| `miniprogram/pages/goals/edit/index.json` | 13 | 标题「目标日」→「编辑目标日」 |
| `tests/ui-v2-c-goals-home.test.cjs` | — | 新建，20 个用例（见第三节） |
| `docs/evidence/lingnan-ui-implementation/c/goals-home.md` | — | 本文件 |

## 二、与设计稿的对齐与偏差

### 已落地

- **12-goals**：h1「每个目标，/ 都有准备的时间。」竖排两行 + 44×44 右上角新建按钮；lead「只保存在这台设备，无需填写个人账号。」；红色主卡（`u2-hero`，22px 内边距、`--r-hero` 圆角）里「下一个目标 / 今天的目标」小标 + 名称 + 52px 大数字 +「天后 · 12 月 19 日」单位小字，底部一条 1px `#ffffff40` 分隔线 +「为这个目标安排学习 →」；已存计划白卡（标题 +「生成日期 · N 段 / M 分钟」+ 绿色「已保存」/「待核对」标签 +「重新打开计划」）；分组列表（`u2-list` + 78px 行高语义、`u2-tag-red` 状态标签、44px 触控「排学习计划 / 修改 / 删除」）；页头/分组的 `u2-section` 节奏（24px 上、12px 下）。
- **55-goals-empty**：`u2-empty-icon` 82×82 圆角 24 的图标块 +「下一个目标，是什么？」+ 说明 + 主按钮「新建目标日」+ 次按钮「查看保留的历史计划」，两个按钮都是 50px 高整宽。
- **13-goal-edit**：h1「给目标一个日期。」+ 说明；三个字段（目标名称带字数提示、目标日期 picker 带 `›` 与 50px 高输入框、是否计入当天开关）；实时预览卡（名称 + 状态 + 「日期 · 计入/不计入当天 · 今天（北京时间）…」）；`u2-notice-info`「只存本机；删除或修改目标后，已经保存的计划会保留原快照并提示变化。」；底部 50px 高「保存目标日」+「删除目标日」（仅编辑态）。
- **54-goal-delete**：确认弹窗标题「删除这个目标日？」、正文三行（不可恢复 / `名称 · 日期` / 已保存计划保留原快照并提示目标已删除）、确认键「删除」。

### 有意偏差（需评审知晓）

1. **「备注（选填）」未落地**：设计稿 13 有第三个字段，但 `services/goals/index.ts` 的 `GoalDay` 只有 `{id,name,date,countToday,createdAt,updatedAt}`，服务层是冻结区、存储结构 `goal-days/v1` 不得扩展。按任务书要求**不写假字段**，本轮 WXML 完全没有「备注」字样（测试 `wxml 里不出现「备注」，存储对象的键不新增` 会守住这条）。若要补，需要先由服务层 owner 决定字段与迁移。
2. **「管理目标」列表未做**：设计稿 12 的 section-head 是「管理目标」+ 一条「修改目标日期与名称」入口；本轮按服务层既有能力改为三组真实分组（未到期 / 今天 / 已过期），每行自带「修改 / 删除」，所以没有单独的「管理目标」区块，页面 data 里也没有 `管理目标` 这个字符串。`scripts/ui-v2-c-capture.cjs` 第 80 行的 `expect: ['英语考试', '管理目标']` 因此会缺一项（脚本不在本任务可写范围）。
3. **删除走系统弹窗而非独立页面**：设计稿 54 是独立页面，但既有实现与既有测试都用 `wx.showModal`（`tests/goal-pages.test.cjs` 钉住 `modal[0].title === '删除这个目标日？'`）。保留 `showModal`，文案与按钮语义对齐设计 54。
4. **`scripts/verify-goals.cjs` 同步整改（已跑通）**：该脚本是上一轮的手工 E2E（不在 `npm test` 里）。本轮采用「保留钩子 + 修过时断言」的混合做法：
   - 在新 WXML 里保留旧类名作语义钩子：空态 `class="u2-empty goal-empty"`、标题 `class="u2-empty-title goal-empty-title"`；编辑页预览卡 `class="u2-card goal-preview ge-preview"`、状态 `class="goal-preview-state ge-preview-state"`、meta `class="goal-preview-meta ge-preview-meta"`。`.goal-item-upcoming`、`.goal-item-today`、`.goal-item-expired`、`.goal-name`、`.goal-state`、`.goal-action*`、`#goal-new`、`#goal-name`、`#goal-count-today`、`#goal-save` 也都保留可用。
   - 同时改了脚本里 4 处**过时断言**（不是把选择器搬到新类名就完事）：
     1. `tapAction()` 的 `${groupClass} .goal-action${which === 'delete' ? '-warn' : ''}` → `${groupClass} .goal-action-${which === 'delete' ? 'warn' : 'edit'}`：未到期/今天两组现在有三个键，按 `.goal-action` 取第 0 个会点到「排学习计划」。
     2. 首页入口带无数据时的 `.goal-strip-name` 期望 `'还没有目标日'` → `'记住重要的日子'`；`.goal-strip-value` 的「去添加」改为断言该节点不存在（没有目标日时不该出现剩余天数）。
     3. 空态标题 `'还没有目标日'` → `'下一个目标，是什么？'`（设计稿 55 原文）。
     4. 删掉 `.goal-strip-unit` 必须为「天后」的断言：home 页在业务基线 `a35f9d9`（提交 `153e0ad`）改写后已没有这个节点，天数和单位合成在 `.goal-strip-value` 里，`${expectedFar + 1}天后` 那条保留。
   - 上述 2～4 项其实在业务基线 `a35f9d9` 之后就已过时（`verify-goals.cjs` 最后一次修改 `a34c38e` 是 `a35f9d9` 的祖先），不是本轮改坏的。
   - **实测结果**：`$env:WECHAT_AUTO_PORT='9465'; node scripts/verify-goals.cjs` → `"result": "passed"`，9 项 check 全绿（入口带、空态、预览 22 天、新建落未到期、默认日期为今天、退出重进仍在、计入当天 +1、删除生效、首页天数），并产出 9 张截图到 `.scratch/verify-goals-run/`。

## 三、测试

命令（一律走 `scripts/ui-v2-c-run.cjs` 串行构建，不直接跑 `build.mjs` / `npm test`）：

```
node scripts/ui-v2-c-run.cjs tests/goal-pages.test.cjs tests/ui-v2-c-goals-home.test.cjs
npx tsc --noEmit
```

既有 `tests/goal-pages.test.cjs`（14 条，不可修改）全部继续通过，说明存储结构与旧行为契约未破：`id="goal-plan-{{item.id}}"` 仍恰好 2 处、`goal-item-expired` 段内无排计划入口、三组标签与 meta 文案一字不变、编辑页三条路径与校验文案不变。

新增 `tests/ui-v2-c-goals-home.test.cjs` 的 20 个用例：

| # | 用例 |
| --- | --- |
| 1 | 空态：hasGoals=false、todayText、groups 为空、标题「我的目标日」 |
| 2 | 空态：新建 → 编辑页，查看历史计划 → 计划页 |
| 3 | 空态 WXML：文案与 `#goal-new-empty` / `#goal-history` |
| 4 | 常规三组：计数 [2,1,1]、标签、`meta` 文案 |
| 5 | 主卡取今天那条（`dateText` =「9 月 29 日」） |
| 6 | 无今天时主卡取最近未到期（18 天 /「10 月 16 日」） |
| 7 | 只有已过期时不出主卡（feature=null） |
| 8 | 已存计划卡：标题、meta、已保存标签 |
| 9 | 目标被改 → `savedStale=true` +「目标日已被修改」提示 |
| 10 | 目标被删 → `savedStale=true` +「原目标日已删除 … 不会自动改写」 |
| 11 | 计划 JSON 损坏 → 不出计划卡但列表照常，且 `console.error` |
| 12 | 栈深 >1：`goHome` 只 `navigateBack`，不 `switchTab` |
| 13 | 栈底：`goHome` 走 `switchTab('/pages/home/index')`，无 toast |
| 14 | 运行环境无 `switchTab`：降级 toast「暂时无法回到今天」 |
| 15 | 源码契约：从 `../../ui/navigation` 导入并调用 `openUiTab('today')` |
| 16 | 新建路径：标题、填名/日期、67→68 天、保存 1 条、toast、返回 |
| 17 | 编辑路径：回填、标题「编辑目标日」、只改这一条、toast「已保存」 |
| 18 | 编辑页删除：确认文案、取消保留、确认后清空并返回 |
| 19 | 新建态「删除目标日」不渲染、不弹窗、不动数据 |
| 20 | 保存失败：校验错误与存储异常都把 `saving` 复位；连点只写 1 条；missing 态不写库；WXML 无「备注」 |

## 四、未解决项与风险

1. **构建曾被并行分支阻断**：`miniprogram/pages/goals/plan/index.ts`（c-plan 正在改）有 8 个 TS 错误（`TS7006` 隐式 any ×6、`TS2339 coursesKnown`），`noEmitOnError` 导致 `dist/` 被清空，依赖 dist 的测试一起无法运行。不是本次改动引入；该文件修好并重建后即可复跑（真实数字见第五节）。
2. **设计稿 13 的「备注」字段**未落地（见第二节第 1 条），需要服务层 owner 决策。
3. **设计稿 12 的「管理目标」区块**未做（见第二节第 2 条），`scripts/ui-v2-c-capture.cjs` 的对应 `expect` 需调整。
4. **`scripts/verify-goals.cjs` 选择器与断言已整改并跑通**（见第二节第 4 条）。
5. **真机截图核对已补做**（用独立脚本 `.scratch/capture-goals.cjs`，不覆盖 c-tools 的 `scripts/ui-v2-c-capture.cjs` 与其输出目录）：原生开发者工具模拟器 390×671 下逐场景 `reLaunch` + 按选择器读文案 + 截图，4 张全部通过写入 `docs/evidence/lingnan-ui-implementation/c/shots-goals/`：`12-goals.png`(44626B)、`55-goals-empty.png`(41050B)、`13-goal-edit.png`(50061B)、`13-goal-edit-new.png`(51204B)，断言明细在 `shots-goals/capture-report.json`（每张的 `missing` 均为空数组）。目视核对发现的唯一视觉问题（页脚「回到今天」被 flex 挤在说明文字右侧）已修正为块级布局并重跑测试。窄屏 320px 仍靠 `@media (max-width: 350px)` 分支保证。
6. **`scripts/ui-v2-c-capture.cjs` 的 `12-goals` 场景 `expect` 仍含 `'管理目标'`**（见第二节第 2 条）：该字符串是设计稿 12 的 section-head 举例，本轮页面 data 里没有它，所以那条脚本跑 12-goals 时会缺一项。脚本不在本任务可写范围，需 lead / c-tools 决定改 `expect` 还是补字段。
7. **构建纪律**：全程只用 `node scripts/ui-v2-c-run.cjs --wait 300 <文件>`（抢文件租约 → 构建 → 串行测试），没有直接跑 `build.mjs` 或 `npm test`。中途出现过一次 dist 被并行分支清空的假失败（见第 1 条），统一走串行跑手后未再复现。

## 五、执行记录（真实跑出的数字）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 两个目标日测试文件 | `node scripts/ui-v2-c-run.cjs --wait 300 tests/goal-pages.test.cjs tests/ui-v2-c-goals-home.test.cjs` | 构建成功；tests **34** / pass **34** / fail **0** / cancelled 0 / skipped **0** / todo 0；duration_ms **284.1602** |
| 加 WXSS 规则测试 | `node scripts/ui-v2-c-run.cjs --wait 300 tests/goal-pages.test.cjs tests/ui-v2-c-goals-home.test.cjs tests/wxss.test.cjs` | 构建成功；tests **36** / pass **36** / fail **0**；duration_ms **418.7501** |
| WXSS 规则单跑 | `node scripts/ui-v2-c-run.cjs --no-build tests/wxss.test.cjs` | 2 / 2 pass（中文与括号、令牌回退值逐字一致） |
| 类型检查 | `npx tsc --noEmit` | exit **0**，无输出 |
| 跨分支回归 | `node scripts/ui-v2-c-run.cjs --no-build tests/goal-pages.test.cjs tests/ui-v2-c-goals-home.test.cjs tests/goals.test.cjs tests/ai-innovation-review.test.cjs tests/ui-v2-a-tabbar.test.cjs` | tests **65** / pass **65** / fail 0 |
| 手工 E2E | `$env:WECHAT_AUTO_PORT='9465'; node scripts/verify-goals.cjs` | `"result": "passed"`，9 项 check 全绿，9 张截图 |
| 原生截图 | `$env:WECHAT_AUTO_PORT='9470'; node .scratch/capture-goals.cjs` | 4 张 OK，`missing` 全为空 |

统计口径：`tests` 含 `goal-pages` 的 14 条 + 我新增的 20 条 = 34；再加 `wxss.test.cjs` 的 2 条 = 36。`skipped` 与 `todo` 均为 0，没有跳过的用例。
