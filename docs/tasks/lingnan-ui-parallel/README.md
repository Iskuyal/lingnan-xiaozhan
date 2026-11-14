# 岭南红原生实现：三人并行交接

2026-11-14续办：三人提交已齐，Codex已按冻结SHA集成并分轴审查，修复跨模块问题后1023项测试及8项原生夹具检查通过。当前状态及未覆盖项以[审查报告](../../review/lingnan-ui-integration-2026-11-14.md)为准；下文是原交接与开发者阶段记录，不再代表实现尚未开始。

2026-11-13：负责人确认「设计图可以」，授权将实现交给三个DeepSeek开发者并行处理，最终由Codex审查交付和测试。**设计已确认，代码实施尚未完成。** 本目录是任务提示词，不是实现成果或验收报告。

三人分别读取 [共享约定](contract.md) 和自己的任务书：[A 公共导航与校园](a-shell-campus.md)、[B 课表全流程](b-timetable.md)、[C 学习与日常工具](c-study-tools.md)。每个人只在独立检出目录和自己的分支工作。

代码/设计冻结基线：`a35f9d9f1c11bba60e32cb65e314f629cceeb2ba`。启动时的交接文档提交由负责人提示词提供；它必须包含该基线且不改变其业务代码。设计版本 `LN-6c774710ba24831b`，79张图的静态总体评分为8.5/8.6。负责人本次认可后，设计说明中旧的「待定稿」不再是开工阻碍，无需再画三套方案或重复索取确认。

跟踪：[Issue #147](https://github.com/Iskuyal/wx-match/issues/147)。A维护公共进度；B、C在各自交付报告和Issue评论中记录结果。任何开发者的自测均不代替Codex最终审查。

## 顺序与依赖

1. 三人同时开始阅读、核对范围和开发各自页面。B、C不改公共文件来绕过依赖。
2. A优先从交接基线创建并推送 `codex/lingnan-ui-foundation`：公共导航接口、四个真实tab、两个可正常跳到现有功能的聚合页基础、公共视觉基础。先通过类型、构建和导航契约测试，并记录完整 `NAV_SHA`。基础提交只代表入口可用，不代表新视觉已全部完成。
3. 基础分支随后冻结。A从 `NAV_SHA` 创建 `codex/lingnan-ui-a` 继续页面实现；B、C把自己的工作先提交，再合入同一个 `NAV_SHA`。使用普通merge，保留共同祖先，不把基础cherry-pick成三个副本，也不追随A后续页面提交。
4. 三人分别交付可审查的分支和完整HEAD、自己的测试及截图。公共文件只由A修改，跨模块缺陷写入交接报告，不擅自越界修别人的模块。
5. Codex核查基线和文件归属，从共同基础建立集成候选，依次合入A、B、C，独立做规范/规格审查、完整回归和原生截图核对。最终比较范围为冻结基线到集成HEAD，公共基础也在审查范围内。

## 负责人交回材料

给Codex三条分支链接或三份完整HEAD即可启动；保留各人的交付报告。建议同时提供共同 `NAV_SHA` 和原生证据目录。不要只交截图或「测试全过」一句话。

## 执行进度（A 维护，B/C 只读）

### 2026-11-13 公共基础已发布并冻结

- 分支：`codex/lingnan-ui-foundation`（A 推送）
- 完整 **NAV_SHA**：`2490ebd3ae94b8b58eebe70b1e658caf05fd6688`。产品代码、测试与导航接口冻结在此提交；其后只追加本文件与 `docs/status.md` 的进度记录，不含产品代码改动。
- 起点：handoff `da008af9eeee032f1aac38911488badd8d4af873`（含业务基线 `a35f9d9f1c11bba60e32cb65e314f629cceeb2ba`）
- 实际被测代码就是 NAV_SHA；下节的测试结果在该提交上跑出。
- 内容：`miniprogram/ui/navigation.ts`（四 tab 路由 + 一次性课表意图）、`app.json` 四个真实 tab 与本地 81×81 图标、22 个旧路由保留、`pages/study/index` 与 `pages/campus/index` 最小可用入口、`app.wxss` 灰白画布与新圆角令牌（旧 token 名与值不变）、`styles/ui.wxss` 的 `u2-` 共享件。
- 验证：`npm run typecheck`、`node scripts/build.mjs`、`npm test` **936/936 通过**、`npm run docs:check` 通过（`tests/ui-navigation.test.cjs` 12 项、`tests/ui-v2-a-tabbar.test.cjs` 6 项为本轮新增）。
- 边界：本提交只代表四个入口可用与导航接口可复用；新视觉尚未完成，原生模拟器截图与 320px 核对待 `codex/lingnan-ui-a` 交付。

### B/C 如何使用

1. 从 `2490ebd3ae94b8b58eebe70b1e658caf05fd6688` 创建或（普通 merge）合入自己的分支，保留共同祖先。
2. 课表页在课程与设置都读取完成后调用一次 `consumeTimetableIntent()`，按 `assistant`/`week`/`plan-week` 应用；不要另建导航模块或第二个 storage key。
3. 公共文件（`app.json`、`app.wxss`、`styles/ui.wxss`、`ui/navigation.ts`、公共测试）仍只由 A 修改；需要改时写进交接报告。
4. A 后续页面提交在 `codex/lingnan-ui-a`，B/C 不追随，只合入同一个 NAV_SHA。

### 2026-11-13 A 段页面完成（`codex/lingnan-ui-a`）

- 实际被测代码：`8b1b6ee88bf9ed0d1df950be4bf2f525abf99e7e`（从 `958565d` 建，含 NAV_SHA 全部内容）。
- 覆盖：首页（图 01/53/36/37）、学习（11）、校园（19）、部门（20/21/22/65）、资讯（23/24），
  以及 `.u2-` 共享件与 10 个 v2 线性图标。
- 验证：typecheck、build、`npm test` **934/934**、`npm run docs:check`、
  `node scripts/verify-ui-v2-a.cjs` **14 项检查 + 21 张原生截图**（9461 端口、独立项目目录、夹具接管，
  真实模型调用 0 次）。
- 证据与未解决项：[A 段交付](../../evidence/lingnan-ui-implementation/a/README.md)（含 320px 原生未取、
  意图消费端在 B、真机未验等如实标注）。
- 边界：未合 main、未部署、未调用真实业务 AI；公共文件仍由 A 维护，B/C 不追随本分支的页面提交。

### 待办

- B：课表按设计图 02 等重做，并在课程/设置读完后 `consumeTimetableIntent()` 应用意图。
- C：学习工具页（目标/计划/日历/体测/升学/答辩）按图重做。
- Codex：从共同基础建立集成候选，依次合入 A、B、C 后独立审查与回归。
- B/C：各自模块交付；跨模块缺陷写入报告，不代改对方页面。
- Codex：从共同基础建立集成候选，依次合入 A、B、C 后独立审查与回归。
