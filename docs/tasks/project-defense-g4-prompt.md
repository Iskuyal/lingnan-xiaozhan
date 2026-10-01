# 项目讲解与答辩练习：G4 部署与真实验收（下一轮提示词）

日期：2026-10-01。用途：**交接给下一轮对话/执行者**。范围只做 G4（Issue #115）：合并 → 部署回读 → 开发者工具端到端 → 真机 → 新冻结样例首评与对照。配套清单见 [G4 证据](../evidence/project-defense-g4/README.md)（现全部标为未执行）。

---

你在 wx-match 仓库工作（原生微信小程序 + TypeScript，GitHub `Iskuyal/wx-match`）。本轮只做「项目讲解与答辩练习」的 **G4：真实效果与真机**。工作目录用**独立 worktree**，不要动用户已有的未提交改动。

## 一、当前真实状态（先读，不要按旧口径理解）

- G0 素材包、G1 首评、G2 设计定稿、G3 最小纵向实现**都已完成，但都在未合并的分支上**：
  - **PR #124**（G1 首评重跑证据）、**PR #125**（G2 八张设计图与业务契约定稿）、**PR #126**（G3 实现 + G4 清单）——均 **OPEN、base = `main`、MERGEABLE**。
  - Issue **#111 / #112 / #113 / #114 / #115 全部 OPEN**。**合入不等于验收；不要关闭任何 Issue。**
- **`ai` 云函数尚未部署新版**：G3 新增的 `cloudfunctions/ai/defense.ts`、`index.ts` 接线与构建产物 `defense-materials.js` **都不在线上**。不部署时，答辩练习页面点进去会以「反馈不完整」失败收场（服务端没有该 feature 分支）。
- **本功能从未真实调用过**：G1 首评评的是「PoC 能不能产出可判定的反馈」，用的是 G0 的 8 个**维护者自编**样例。**G1 的留出样例首次结果已经消耗**（`HS-1` 空内容失败、`HS-2` 通过），**不得重跑充当初次结果**；G4 必须**新冻结**样例。
- 测试基线：`npm test` **717/717**（G3 分支实测）；G0 装配指纹 **`64b4d06b911e4022`**——**G4 不得改动 G0 冻结件**，新样例另建目录。
- 真实消耗基线（服务端 `usage` 读数，不是估算）：当月 2026-10 **94 次子调用 / 74,534 token / 0.018635 元**，上限 50 元、告警线 40 元，未告警未超限。
- 内容安全：未上架期 **100 次/天**；一次完整会话约 **15–20 次检测**；与升学问答、10-8 演示**共用**。
- 时延：答辩练习单次模型调用实测 **12–23 秒**（G1 数据），远高于升学 ≤8 秒口径——本轮要给出「是否接受 / 如何降级」的结论或输入。

## 二、环境与工具的真实坑（上一轮实测踩过，不要重踩）

1. **CLI 令牌**：`$env:WECHAT_DEVTOOLS_CLI_TOKEN='<令牌>'`（由负责人提供；**不得写进仓库、证据或提交**）。
2. **`npm run build` 会让自动化桥失效**（表现为 `timeout waiting for automator response`，0 次云请求）。顺序必须是：**先 build → `cli cache --clean compile` → `cli auto --project <dist> --auto-port 9420 --trust-project` → 再跑 node 脚本**。带真实调用的 npm 脚本自身会先 build，所以优先用 `node scripts/...` 直接跑。
3. **`cli cloud functions download` 曾返回 `code 17`「二维码输出路径无效或不存在」**：该命令要求开发者工具已登录且项目已打开。重试路径：确认登录 → `cli auto` → 再 download；仍失败改用控制台导出，并如实记为「未取得回读」。
4. **云函数环境变量现值**（负责人确认并已部署）：`AI_MAX_TOKENS=4096`、`AI_TIMEOUT_MS=40000`、`AI_TOTAL_DEADLINE_MS=50000`、`AI_EXTRA_BODY_JSON={"chat_template_kwargs":{"enable_thinking":false}}`。
5. **`AI_EXTRA_BODY_JSON` 必须是合法 JSON**：上一轮它一度非法，导致 `ai` 函数**所有动作 fail-closed**（连只读 `usage` 都 2ms 报 `internal`），被只读闸门拦下才没有白花额度。改完必须先跑 `npm run poc:defense:usage`，返回 `ok:true` 才允许花钱。

## 三、命令

- `npm ci` · `npm run build` · `npm test` · `npm run typecheck` · `npm run docs:check`
- 只读额度：`npm run poc:defense:usage`（不花钱、不过内容安全）
- 部署前留档与部署后回读：`cli cloud functions download --env cloudbase-d2gjtbbwu3575cd7b --name ai --path <目录> --project <dist>`
- 部署：`cli cloud functions deploy --env cloudbase-d2gjtbbwu3575cd7b --names ai --remote-npm-install --project <dist 绝对路径>`
- 状态读回：`cli cloud functions info --names ai --env cloudbase-d2gjtbbwu3575cd7b --project <dist>`

## 四、固定顺序（顺序本身就是判据，不要跳步）

1. **合并** PR #124 → #125 → #126（都指向 `main`；#126 基于 G2 分支，按此顺序合可避免 `docs/status.md` 同行冲突）。**不要关闭 Issue。**
2. 在合并后的 `main` 上建**独立 worktree**；`npm ci && npm run build && npm test`（必须 ≥ 717/717）。
3. **部署前留档**：download 当前线上版本，记下函数根目录入口文件哈希与 `info` 的 status/timeout/runtime。
4. **部署 `ai`**（只部署 `ai`，不动 `newsSync` / `timetable`）。
5. **回读判据**：download 新版 → **函数根目录入口文件逐字节一致**（本次会新增 `defense.js`、`defense-materials.js`，并更新 `index.js`）→ `info` 仍 `Active` / `timeout=60`。
6. **回归**：真实跑一次升学问答或课表助手，确认既有功能没被改坏；再跑 `npm run poc:defense:usage` 确认配置仍合法。
7. **开发者工具端到端**：首页「项目讲解与答辩练习」→ 选材料（`FC-1` / `FC-2`）→ 三轮（每轮一个维度）→ 四节反馈 + 追问 → 复盘 → 重答一次 → 结束；另外各走一次失败路径（断网 / 额度或 `45009` / 四节不齐）。
8. **真机**：同路径走一遍，记录机型与基础库版本，`realDevice` 按实际记录。
9. **新冻结样例首评**（不得复用 G1 的 8 个样例）：另建样例目录，**先冻结判据再跑**；逐例按 [rubric.md](../evidence/project-defense-g0/rubric.md) 四步判定，**留出样例首次结果单列、不得用于调参**。
10. **对照实验**：同材料同任务的「固定检查表」与「通用 AI 提示」各跑一遍，记录完成步骤、定位依据是否方便、人工判定的有效建议数与完成时间；**不故意弱化对照**。

## 五、额度与调用纪律

- 一次完整会话约 15–20 次内容安全检测，单次约 0.001–0.0017 元；未上架期 100 次/天，**预留 10 月 8 日演示额度**。
- 不调高限额、不关闭内容安全（尤其不得为省配额关 `AI_MODERATE_OUTPUT`）、不改 `AI_SAFETY_FAIL_MODE`；除负责人批准外不改任何环境变量。
- 配额报错先查 `45009`，不要往模型或密钥方向找。
- 逐次记录客户端端到端与服务端耗时、token、费用、检测次数；**未知不记成已知 0**。

## 六、判定纪律（rubric 四步，顺序不能变）

1. 引用核对（编号与原句必须 **100%** 对应当前材料/回答）→ 2. 是否对应回答 → 3. 追问是否有针对性 → 4. **有没有把未验证说成已完成（一旦发生即整例不通过）**。
材料差异必须**提示核对**，**不得判学生撒谎**、不得道德评价、不得以润色流畅度当证据改善。

## 七、必须写进状态面

- **真实消耗写进 `docs/status.md`**：多少次请求、token、金额；只有 1 次回传就写「仅 1 次回传」，其余写「未知、不记成 0」。
- 记录写**分支与 HEAD SHA**，**不写个人磁盘绝对路径**。
- 新证据必须能由**入库脚本**复现；若确实用了临时脚本，必须一并入库，否则在证据里明写「本项在仓库内不可复现」。
- G4 清单与状态回填到 [docs/evidence/project-defense-g4/README.md](../evidence/project-defense-g4/README.md)，逐项标日期与结果。
- 当前状态只写 `docs/status.md`；带日期的历史实测表保留原样，需要更正时**新加带日期的说明**。

## 八、收口与验证

- 产出放 `docs/evidence/project-defense-g4/`：部署留档与回读比对、端到端逐例记录（原始响应、耗时、token、费用、判定）、真机记录、首评与对照、go/no-go。
- 跑 `npm run docs:check`、`npm test`、`npm run typecheck`、`git diff --check`。
- 只有改了业务代码才补构建/行为回归；不要为了 PoC 部署业务代码。
- 中文提交，按仓库约定开 PR 关联 Issue #115；**不要关闭任何 Issue**。

## 九、最后报告必须说清

- 部署是否**真的**生效（回读逐文件一致 + `info`），既有功能回归结果；
- 端到端哪些路径通过、哪些失败（含 `failureClass` 与实际文案）；
- 真机是否通过（机型、基础库、`realDevice`）；
- 新冻结样例逐例判定（引用支持率、越界断言数）、**留出样例首次结果**、对照实验结果；
- 实际花费与剩余额度（读不到就写「未核实」）；
- G4 结论，以及对 G2/G3/G5 的影响（含「12–23 秒」是否需要降级设计）。

## 不得声称

新功能已上线 / 已被学生使用 · 教师已认可或已评价 · 真实学习效果达标 · 引用核对已 100%（那是 G1 对 8 个**维护者自编**样例的结论）· 真机已通过（除非真的跑过）· 除已记录之外的缺口已修复。
