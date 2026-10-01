# 项目讲解与答辩练习：G1 首评重跑提示词

关联任务：[Issue #112](https://github.com/Iskuyal/wx-match/issues/112)：完成受控文字 PoC 与首次反馈评测（Blocked by [Issue #111](https://github.com/Iskuyal/wx-match/issues/111)）。

状态：**取代** [G1 提示词](project-defense-g1-prompt.md)（开启件）与 [G1 真实评测续跑提示词](project-defense-g1-resume-prompt.md)（续跑件），后两者保留为历史。本件供另一位执行者在**阻断项修好之后**执行 G1 的真实模型首评重跑。阶段范围与关口见[执行方案](../planning/project-defense-stages-2026-09-30.md)；素材与冻结件见 [G0 素材包](../evidence/project-defense-g0/README.md)；上一轮实测与阻塞见 [G1 证据](../evidence/project-defense-g1/README.md)。**本阶段不新增页面、不做设计图、不改产品功能代码**（那是 G3）。

以下整段可以复制给其他执行者：

```text
你在 wx-match（原生微信小程序 + TypeScript，GitHub 仓库 Iskuyal/wx-match）项目工作。
现在只执行“项目讲解与答辩练习”G1 的真实模型评测**首评重跑**（Issue #112）。

一、当前真实状态（先读，不要按旧文档的乐观口径理解）
- G0 素材包与 G1 的**离线部分**已合入 main（PR #118/#119/#120/#121 的内容都在 main 里；
  合并提交 38a87e8 / 6e5e6a4 / 6976b05 / 61c811e，状态同步 925cc65）。
  **Issue #111、#112 仍未验收（OPEN）** —— 合入不等于验收。
- 真实调用**已经发生过两轮、共 7 次**（第一轮 6 = 会话批次 5 + 输出预算诊断探针 1；
  第二轮阻断项单点复核 1），**全部拿不到可判定反馈**。已记录的消耗：3,726 token、
  ≥0.000932 元 —— **两者都只有 1 次回传**，其余请求未回传用量，**未知不记成 0**。
- **阻断项未修复**：模型把内容写进 reasoning_content，返回的 content 为空、
  finish_reason=length。修法是云函数环境变量（关思考或换模型），**只能由负责人在云控制台改
  并点「部署/保存」生效**；执行者读不到也改不了。
- **6 个开发样例的样例批次从未执行**（逐例首评 0/6）。会话中借用过 CS1-1/CS1-2/CS1-3，
  那是被截断的探针式响应，**不构成逐例首评**，不得据此回填 verdict。
- **留出样例 HS-1 / HS-2 至今从未被调用** —— 这是本阶段最宝贵的资产：首次结果的独立性
  仍然完好。一旦用于调参就永久失效。
- 上一轮的第二轮实测走了一个**未入库的临时探针**，导致该证据在仓库内不可复现（已如实记为
  限制）。**本轮禁止再写临时探针**，一律用入库的 scripts/poc-project-defense.cjs。

二、前置核对（不满足就停下报告，不要先花额度）
1. 从最新 main 取独立 worktree 与 codex/ 分支；保留无关未提交改动；开工前报告基线 SHA 与
   现有未提交文件。
2. GitHub 状态：Issue #111/#112 与 PR #118/#119/#120/#121 的实际状态。#119–#121 可能显示
   CLOSED 而内容其实已全部在 main（GitHub 因 base 不是 main 而不标 MERGED），不要据此以为
   内容缺失。
3. 读：AGENTS.md、docs/agents/issue-tracker.md、docs/README.md、
   docs/planning/project-defense-stages-2026-09-30.md、
   docs/evidence/project-defense-g0/（README、rubric.md、abnormal-cases.md、budget.md、
   两份事实卡、samples-development.json、samples-heldout.json）、
   docs/evidence/project-defense-g1/（README 与 runs.json）、docs/development/cloud/ai.md
   （尤其「内容安全适配层」「失败分类与默认文案」）、docs/development/local-setup.md。
   只追读本任务引用的必要文件。
4. 离线自检必须 0 错误、**装配指纹必须仍是 64b4d06b911e4022**：`npm run poc:defense`
   （不触网、不花钱）。**指纹变了就停下报告** —— 说明冻结件被改过，留出样例的独立性要重新评估。
5. 额度：先跑只读的 `npm run poc:defense:usage`。上一轮该动作被 assertAdmin 拒（登录账号不在
   AI_ADMIN_OPENIDS 白名单）。**读回失败就写「未核实」，不要写 0**，也不要自己调额。
6. 请负责人确认：阻断项环境变量**是否已改、是否已点部署/保存**。无法确认就**停下报告，
   不要先花额度** —— 上一轮正是在「余额读不清」的情况下发出了 6 次调用，违反阶段方案与
   budget.md 的「余额不清或已用尽则仅交付离线部分」，已被如实记为纪律偏离。

三、命令（已实测：真实调用模式必须显式带 --allow-spend）
注意：package.json 里的四个真实调用脚本**默认不带** --allow-spend（脚本的设计是默认拒绝
花钱），必须用 npm 的参数透传形式追加，否则会直接报「真实调用需要显式 --allow-spend」：

  npm run poc:defense                                   # --plan 离线自检，不花钱
  npm run poc:defense:usage                             # 只读额度，不花钱
  npm run poc:defense:session  -- --allow-spend         # 会话 5 次请求
  npm run poc:defense:samples  -- --allow-spend         # 首评 8 次（开发 6 + 留出 2 同批）
  npm run poc:defense:dev      -- --allow-spend         # 调参后复测：仅开发 6，不碰留出
  npm run poc:defense:abnormal -- --allow-spend         # 异常 6 次
  等价写法：npm run build && node scripts/poc-project-defense.cjs --samples --allow-spend

四、固定顺序（顺序本身就是判据，不要调换、不要跳步）
① `npm run poc:defense`：0 错误、指纹不变。
② 负责人确认阻断项已改并已部署（不消耗额度）。未确认 ⇒ 停。
③ `npm run poc:defense:session -- --allow-spend`（5 次）。用它的**第一个请求 R1** 当阻断项
   确认：R1 若仍 content 为空、finish_reason=length，**立即停止**，不要跑 ④⑤，把本轮记为
   「阻断项未解、首评未执行」。这样就不需要上一轮那种一次性探针 —— 确认与会话批次是同一次
   调用、且可用入库脚本复现。本批 5 个请求若都拿不到内容，同样停止并如实记录。
④ 只有 ③ 显示四节写完、content 非空，才跑 `npm run poc:defense:samples -- --allow-spend`
   （8 次：开发 6 与留出 2 **同批**，确保留出样例的**首次结果早于任何提示词调整**）。
⑤ 再跑 `npm run poc:defense:abnormal -- --allow-spend`（6 次）。
⑥ 逐例按 rubric.md 四步判定并回填。只有 ④ 不达标（6 例中不足 5 例有效反馈）才考虑调参；
   调参后复测**只能**用 `npm run poc:defense:dev -- --allow-spend`，**绝不允许**重跑留出样例。

五、额度与调用纪律
- 一次完整会话最多 5 个请求；每批最多 12 个（脚本已锁 --max-calls=12）。
- 与升学评测共用个人日额度、个人分钟额度、内容安全预算与月度 50 元上限；未上架期内容安全
  100 次/天、按片消耗，**全量 19 个请求预计约 71 次检测**。
- 不调高限额、不关闭内容安全检测（尤其不得为省配额关 AI_MODERATE_OUTPUT）、不改
  AI_SAFETY_FAIL_MODE；除负责人批准外不改任何环境变量。
- 配额报错先查 45009，不要往模型或密钥方向找。预留 10 月 8 日现场演示额度。
- 逐次记录客户端端到端与服务端耗时、token、费用；**未知不记成已知 0**。

六、判定纪律
- 按 rubric.md 四步顺序：先核对引用编号与原句 → 再判反馈是否对应回答 → 再判追问是否有
  针对性 → 最后判有没有把未验证说成已完成（**这一项一旦发生即整例不通过**）。
- 反馈中的引用编号与原句必须 **100%** 对应当前材料 / 回答。
- **留出样例按首次结果单列**，不并入开发样例通过率，不得用于调参。
- 异常样例单列，不得用来调参后仍当未见样本。
- 材料差异必须提示核对，**不得判学生撒谎**或给道德评价；不得以润色流畅度当证据改善。
- 逐例逐字保存原始响应，不改写；失败与空响应保留实际记录，不隐藏。
- 两轮调整仍不达标就缩为「单题 → 依据反馈 → 重答」重测；仍不行保留探索原型。不扩语音、
  图片、RAG 或评分来掩盖反馈问题。

七、必须写进状态面（本轮评审的教训，不要重犯）
- **真实消耗必须写进 docs/status.md**：多少次请求、token、金额。只有 1 次回传就写「仅 1 次
  回传」，其余写「未知、不记成 0」。**不许**在没把握时写「未消耗任何额度」（上一版
  docs/status.md 就是这么写的，与该分支自己的证据直接冲突，被评审判为合入阻断项）。
- 记录里写分支与 HEAD SHA，**不写个人磁盘绝对路径**（docs/README.md 有明文要求）。
- **新证据必须可由入库脚本复现**；若确实用了临时脚本，必须把它一并入库，否则在证据里明确
  写「本项在仓库内不可复现」，不要留下无法复核的孤证。
- 当前状态只写进 docs/status.md；带日期的实测表保留原样作为历史，不改写史实，需要更正时
  新加一条带日期的说明。

八、收口与验证
- 产出放 docs/evidence/project-defense-g1/：逐例记录（原始响应、耗时、token、费用、判定）、
  额度与配置读回、go/no-go；首评与调参后复测分开统计。
- 跑 `npm run docs:check`、`npm run check:defense-g0`、`npm run poc:defense`（指纹）、
  `node --test --test-concurrency=1 tests/*.test.cjs` 与 `npm test`（当前基线 685/685）；
  `git diff --check` 应无输出。
- 只有改了业务代码才补构建 / 行为回归；不要为了 PoC 部署业务代码。
- 中文提交，按仓库约定开 PR 并关联 Issue #112。**不要关闭 Issue #111 / #112**（验收是负责人
  的决定）。

九、最后报告必须说清
- 6 个开发样例通过几个、2 个留出样例的首次结果、6 个异常样例的实际记录、实际花费与剩余额度
  （读不到就写未核实）、以及 PoC 对 G2/G3 的结论（可行 / 需改什么 / 不可行）。
- G1「真实模型可行」只在真实调用成功且引用核对与越界判定达标时才成立；额度不足、只跑通桩、
  或只有短文本成功时，**保持未完成**。
- 不得写成：新功能已上线、真实学生学习效果已达标、教师已认可或已评价、阻断项已修复、
  引用核对已 100%。
```

## 交接说明（不复制给执行者）

- **取代关系**：本件取代 [project-defense-g1-prompt.md](project-defense-g1-prompt.md)（开启件）与 [project-defense-g1-resume-prompt.md](project-defense-g1-resume-prompt.md)（续跑件）。两份旧件保留为历史记录，其执行顺序已被 2026-10-01 的实测取代。
- **`--allow-spend` 的写法是实测结论**：`package.json` 的 `poc:defense:session`/`:samples`/`:dev`/`:abnormal` 四个脚本**不带** `--allow-spend`，而脚本在 `scripts/poc-project-defense.cjs` 的真实调用分支强制要求它。这不是缺陷，是**默认拒绝花钱**的安全设计（`--plan` 不受影响，因为它在花费闸门之前就返回）；所以必须用 `npm run <脚本> -- --allow-spend` 的参数透传形式。旧的续跑件直接写 `npm run poc:defense:samples`，照做会立刻报错。
- **② 为什么并入 ③**：上一轮的「单点确认」是写了一个未入库的探针脚本完成的，这正是「第二轮证据在仓库内不可复现」的根因。会话批次的第一个请求本身就是一次紧挨着的真实调用，用它当阻断项确认，既省一次探针、又让确认过程可用入库脚本复现。
- **G1 关口没有变**：引用 100% 对应、无把待验证说成已完成、6 例至少 5 例有效、留出样例单列、至少一次完整流程可运行、异常与额度失败留实际记录。本页只是把它翻译成可执行步骤；两处不一致时以[执行方案](../planning/project-defense-stages-2026-09-30.md)与 [budget.md](../evidence/project-defense-g0/budget.md) 为准并回报。
- **已知的两个遗留缺陷**（均**留待 G3**，本阶段不要顺手改，以免改动已交付脚本的行为）：① 客户端空回复回灌；② 脚本里 `proofBoundary` 只生成 3 条、`mode` 硬编码为离线值，而 `runs.json` 的真实记录由脚本外的合并步骤补齐 —— 这正是不可复现限制的来源。
- **测试计数口径**：`tests/defense-g1.test.cjs` 共 14 个 `test()`，其中 8 个**标题**含「负例」，写作「14 项测试（8 项标题含负例）」，不要写成「14 项负例」。
- 若开工时额度或部署条件仍不满足，执行者应先交付离线准备并回报具体缺口，**不要用桩输出填充「完成」**。
