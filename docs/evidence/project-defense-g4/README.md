# G4 真实效果与真机（**部分执行**，逐项标注）

- 对应 [Issue #115](https://github.com/Iskuyal/wx-match/issues/115)；前置 [Issue #114](https://github.com/Iskuyal/wx-match/issues/114)（G3 最小纵向实现）。
- 阶段方案：[G0–G5 执行方案](../../planning/project-defense-stages-2026-09-30.md)；设计定稿：[docs/design/project-defense/](../../design/project-defense/README.md)；G3 证据：[project-defense-g3](../project-defense-g3/README.md)。
- 分支 `codex/project-defense-g4`；HEAD `39405fe`（`main` 合并 PR #124/#125/#126 之后）。只写分支与 SHA，不写个人磁盘绝对路径。
- **本文现在是结果 + 缺口，不是承诺**。执行日期：2026-10-01（部署）、2026-10-02（回归与端到端失败路径、happy path 前三轮）。

## 结论（go / no-go）

**NO-GO（未取得真实效果结论）。** 已证实的是「部署真的生效」与「链路在真实环境里可跑通、失败路径按契约收口」；
**没有**取得新冻结样例的首评判定、对照实验与真机记录，因此本阶段**不能**给出「真实学习效果」类结论。

阻塞原因不是代码，是**额度**——且是**两个不同的上限**：2026-10-02 的实际阻塞点是**内容安全检测的当日配额（`errcode=45009`）**；
个人日调用上限（`AI_USER_DAILY_LIMIT`）另有其物，**值读不到、不要写成 5**（见文末「额度」一节，含一次已更正的错误推断）。
一次完整答辩练习会话约 **15–20 次内容安全检测 / 4–5 次模型调用**，而内容安全 100 次/天是全部功能共用的 ⇒ **这同时是 10 月 8 日演示的风险**，须负责人预排。

## 逐项清单

### 0. 合并后基线（2026-10-01）

- [x] PR #124 → #125 → #126 按序合并进 `main`；**未关闭任何 Issue**。
      `#126` 与已合入的 `#125` 在 `docs/status.md` 的答辩练习行冲突，已在 G3 分支上合 `main` 解决（取并集：保留 main 的 G1 口径 + 补 G2/G3 事实 + 把「未合入 main」更正为已合入），`npm run docs:check` 0 错误。
- [x] 独立 worktree（`codex/project-defense-g4`，基于合并后的 `main`）：`npm ci` 成功；`npm run build` 成功（构建日志显示答辩练习材料已注入 2 份、3050 字）。
- [x] `npm test` **718/718 通过、0 失败**；`npm run typecheck` 通过；`npm run docs:check` 通过（133 个 Markdown、897 个本地引用、0 错误）。
      注：阶段方案与 G3 记的基线是 **717/717**；合并后的 `main` 是 **718/718**（多出的 1 项来自 PR #124）。**≥717 的要求满足**，两个数字都保留、不改写 G3 的历史记录。

### 1. 部署 `ai`（2026-10-01）——**已执行并通过回读**

- [x] 部署前 `download` 留档（旧版）、部署后 `download` 回读，**函数根目录入口文件 20/20 逐字节一致**（`index.js` 更新为 55,204 B，新增 `defense.js` / `defense-materials.js`）。
- [x] `info` 回读：**Active / timeout 60 / Nodejs16.13**（与部署前一致）——原始输出留档 [deploy/info-after-2026-10-02.txt](deploy/info-after-2026-10-02.txt)。
- [x] 部署前后 `index.js` 的差异留档为可复核的补丁：[deploy/index-js-diff-2026-10-01.patch](deploy/index-js-diff-2026-10-01.patch)（由归档的两个 `index.js` 直接 `git diff --no-index` 生成，**+55 / −0 行**、全部落在 `DEFENSE_FEATURE` 守卫内）。
- [ ] 环境变量核对：**未改**（本轮没有执行任何改环境变量的动作），但**值读不到**——`info` 只回 status/timeout/runtime。**不写成「已从 CLI 核对」**。
- [x] 只部署 `ai`，未动 `newsSync` / `timetable`。
- 明细与完整哈希表：[deploy/README.md](deploy/README.md)。

### 2. 既有功能回归——**已执行并通过**

- [x] 部署后跑 `scripts/verify-advancement-model.cjs --require-live`（真实模型调用）：**M1 / M2 / M3 / M4 / M4b 全部通过**，退出码 0。
      原始报告（`passed: true`、M1 的 `source: "live"` 与逐字模型输出）留档 [regression-advancement-2026-10-02.json](regression-advancement-2026-10-02.json)。
      升学问答的现场模型解释、出处标记与卡片一一对应、缺失年份先澄清不调用模型、语料不含则拒答给官方入口、传输失败降级为原文摘录并给重试入口，均未被本次部署改动。
- [x] `npm run poc:defense:usage` 返回 `ok:true`，说明 `AI_EXTRA_BODY_JSON` 仍是**合法 JSON**（非法时 `ai` 会全动作 fail-closed）。
- 佐证「不是侥幸」：部署前后 `index.js` 的 diff 为 **+55 行 / −0 行**，全部在 `DEFENSE_FEATURE` 守卫内，既有功能路径一行未改。

### 3. 开发者工具端到端（模拟器）

环境：`微信开发者工具` + `cli auto --auto-port 9421 --trust-project`（**9420 被上一轮遗留实例占用，工具自动改绑 9421**；脚本用 `WECHAT_AUTO_PORT` 指到真实端口，否则会连到旧构建）。平台 `devtools`，机型 `iPhone 12/13 (Pro)`，基础库 `3.17.2`。

- **happy path（部分）**：首页 `#defense-entry` → 材料页列出 **2 份**材料 → 选 `FC-1` →
  第 1/2/3 轮各拿到**四节齐全**的反馈（`【引用核对】【是否对应回答】【待验证保留】【追问】`）且每轮都有**针对性追问** → 进入**复盘**，三个维度均显示「已反馈」。
  **卡在重答**：第 4 次调用被 `quota_exhausted` 拒绝，`done` 态与「退出后再进会话已清空」**未取得**。
  此处**无法从页面区分**是内容安全 45009 还是个人日计数——答辩练习把两者都映射成同一句「额度或当日检测配额已用尽」（见文末「额度」一节）。
  09:59 的原始探针显示当天落在 **45009**，因此按内容安全配额解释。
- **失败路径（3/3 通过，13 条断言全过）**：`e2e-failure-2026-10-02.json`
  - ① **断网**（脚本把 `wx.cloud.callFunction` 换成 reject，**是 mock，不是真实断网**）：进入失败态、文案「这次没能发出去」、**已写 82 字保留**、不显示反馈、给重试入口。
  - ② **额度**（**真实调用**）：服务端 `quota_exhausted` → 文案「额度或当日检测配额已用尽」、正文指向 **45009** 排障、**不可重试**、已写内容保留、不显示反馈。
  - ③ **四节不齐**（脚本把返回换成三节，**是 stub**）：文案「这次的反馈不完整」、**缺节内容一个字都不上屏**、回答保留。
- ⚠️ **证据强度说明（缺口，如实记）**：happy path 那次运行的 JSON **没有落盘**——脚本当时在额度失败后中断
  （失败态里没有 `.primary`，取到 `null` 抛错），而那时的异常路径还没有写报告的逻辑。
  因此上面前三轮的结论**只有控制台输出，没有可入库的机器可读记录**，复核时**不能**把它当成「有 artifacts 的实测」。
  脚本**已修**：阶段异常现在会记进 `report.aborted` 并**照常写出已经跑到的那部分**；**下一次运行必然留下 JSON**。
- [ ] 等待态耗时区间与「取消后草稿还在」：未单独跑（等待态在实际调用中出现过，未单独断言）。
- [ ] 云数据库 `ai_usage_records` / `ai_usage_monthly` 不含材料或回答正文：**未核对**。

### 4. 真实设备——**未执行（已把执行件备好）**

- [ ] 真机走通同一路径、记录机型与基础库：**未执行**。本环境**无法操作物理设备**（需要真人扫码操作）；负责人已选择「自己跑并回传记录」，本轮**尚未回传**。
- [x] **已生成预览二维码**（2026-10-02，`cli preview`，**不消耗 AI 额度**）：`√ preview`、退出码 0、包体 **436.4 KB**（446,921 字节）、AppID `wxdcef3a86d7e9eeff`。二维码与 info 落在 `artifacts/verify/`（gitignore，不入库），**预览码有时效、过期重跑同一条命令即可**。构建信息留档 [preview-build-2026-10-02.json](preview-build-2026-10-02.json)。
- [x] 逐项执行清单（扫码 → 9 步路径 → 必须回传的字段 → 专项观察 → 额度提示）：[real-device-checklist.md](real-device-checklist.md)。
- **`realDevice` 记为 `false`**（本阶段所有结果都来自模拟器）。**不得写「真机已通过」**。
- 阻塞叠加：真机同样吃**内容安全 100 次/天**（全部功能共用）与个人日上限，**一条完整路径（约 15–20 次检测）就会占掉当天可观份额**，清单里给了「真机优先只跑一轮」的折中顺序。

### 5. 新冻结样例首评——**判据已冻结，尚未开跑**

- [x] **另建样例目录**并**先冻结判据**：[samples/frozen-2026-10-02.json](samples/frozen-2026-10-02.json)，冻结哈希 `71ffad8b6897652b738ee10f44c8f7d6aca9d72584903747434b6707e571bf3d`。
      运行脚本 `scripts/verify-defense-g4-first-eval.cjs` 开跑前用 `--expect-hash` 校验该哈希，**判据变了就拒绝开跑**。
      两个护栏都已**离线实测**（不消耗额度）：哈希不符时退出码 1 且**不写任何文件**；`--resume=<上次报告>` 时「样例都已判定过」的会话整段跳过（合成 8 例已判定的输入 → 4 个会话全跳过、0 次模型调用、退出码 0）。
- [x] **断点续跑护栏**：额度一次大约只够一个会话，脚本支持 `--resume`，**保证留出样例的首次结果不会因为重跑变成第二次结果**。会话内必须按轮次顺序提交，所以跳过粒度是**整段会话**。
- [x] **不复用 G1 的 8 个样例**：本集 id 为 `G4-S1…S6` / `G4-H1` / `G4-H2`，正文全新；冻结件里同时登记了 G1 的 8 个 id 以便逐条比对。
- [x] 样例设计覆盖三类回答与**两个陷阱**：边界篡改（把 `F8` / `D7` / `D8` 这类「待验证/未测试」说成已完成）、只润色不加证据；留出样例另列。
- [ ] **逐例判定（引用支持率、越界断言数、四步判定）：未执行**——需要 8 次真实调用，受日额度限制。
- 自动化分工：① 引用核对由脚本自动判；②③④ 需要人读语义，脚本只**原样落盘**反馈正文并给 ④ 一条关键词**提示**，**不代替人下结论**。

### 6. 对照实验（固定检查表 vs 通用 AI 提示）——**未执行**

- [ ] 未执行：需要额外真实调用；受同一日额度限制。**不写成「已完成」**。

## 成本与额度（服务端 `usage` 实测，不是估算）

| 时点 | 当月调用 | token | 费用 | 失败数 |
| --- | --- | --- | --- | --- |
| 2026-10-01 G4 前（历史基线） | 94 次子调用 | 74,534 | 0.018635 元 | — |
| 2026-10-01 当日读数 | 96 次 | 74,534 | 0.018635 元 | 5 |
| 2026-10-01 收尾读数 | 102 次 | 75,202 | 0.018802 元 | 5 |
| **2026-10-02 09:47 本轮读数** | **137 次** | **91,973** | **0.022995 元** | **6** |
| **2026-10-02 10:02 复读**（含 3 次被额度拒绝的探针） | **140 次** | **91,973** | **0.022995 元** | **9** |

> 两次读数之间调用数 137 → 140，而 **token 与费用一分未动**（91,973 / 0.022995）
> ⇒ **被 `quota_exhausted` 拒绝的请求不产生模型消耗**，只是给计数 +1。这条也说明「次数」与「花费」不是一回事。
> 10:02 的原始输出留档 [usage-2026-10-02.json](usage-2026-10-02.json)。

- 上限 50 元、告警线 40 元 ⇒ **未告警、未超限**。
- **剩余额度：读不到**（服务端不返回剩余额度字段）⇒ 记「**未核实**」，不按「50 − 已用」推算。
- 单次答辩练习反馈：现场客户端端到端 **12–23 秒**（与 G1 口径一致，属 G3 降级设计输入）。
- 内容安全：每次调用都过检测（`safety.checked=true`）；未上架期 100 次/天与升学、10-8 演示共用。

### ⚠️ 额度：有**两个**不同的上限，别混为一谈

两者的 `failureClass` 都是 `quota_exhausted`，但来源不同，排障方向完全不同。

**① 内容安全检测的当日配额（`errcode=45009`）——2026-10-02 的实际阻塞点**

- 2026-10-02 09:59 与 10:02 两次用 `scripts/probe-ai-raw-response.cjs` 实测（原始返回留档 [quota-probe-2026-10-02.json](quota-probe-2026-10-02.json)）：`ok:false`、`failureClass=quota_exhausted`，文案「内容安全检测的额度已用尽，AI 功能暂时不可用；未上架小程序每天有检测次数上限，通常次日恢复。」，`detail` 含 **`errcode=45009` / `fail reach max api daily quota limit`**。
- 这是**微信侧** `msgSecCheck` 的当日配额（未上架期 100 次/天，与升学问答、10-8 演示**共用**），**不是**模型、不是密钥、不是超时。默认 `AI_SAFETY_FAIL_MODE=closed` 下 fail-closed，当天全部问答 / 助手 / 识图都不可用。
- **本阶段后半段的真实调用就是被它拦下的**：09:46 回归能过、09:47 前三轮能过，之后（含重答）就落在 `quota_exhausted` 上。

**② 个人日调用上限（`AI_USER_DAILY_LIMIT`）——值读不到，不要写成 5**

- `cloudfunctions/ai/access.ts` 的日计数按 **UTC+8 天键**、上限取 `AI_USER_DAILY_LIMIT`（代码默认 30）。
- **2026-10-01 16:58** 确实被它拦下过一次：文案「今日 AI 调用次数已达上限，请稍后再试。」（`label='今日'`）⇒ 该计数器**确实生效**。
- **但 2026-10-02 没有任何证据说明它 ≈5**：10-02 09:59 那次请求**先通过了** `consumeUserLimits`（该检查在动作分发之前），才在后面的内容安全环节失败 ⇒ 当天的个人日计数**没有打满**，上限必然 **> 6**。
- ⇒ **本页上一版写的「两天都在第 6 次被拒、生效值 ≈5」是错的**（把 10-02 的内容安全阻塞误当成个人日计数），已更正。真实值**读不到**（`config.json` 无 `envVariables`，`info` 只回 status/timeout/runtime）⇒ 记「**未核实**」。
- 10-01 那次能打满，与当天 G1 已发起 19 次真实云请求一致 ⇒ **更像默认 30 而不是 5**；但没读到值，**不写成结论**。

**对 10 月 8 日演示的影响（两种上限都会咬人）**

- 一次完整答辩练习会话约 **15–20 次内容安全检测 / 4–5 次模型调用**；
- 内容安全 100 次/天是**所有功能共用**的 ⇒ 满打满算约 **5 次完整会话/天**；
- 个人日上限若确为默认 30，同样要与其他功能共享。
- ⇒ 演示当天要**预排调用次数**，不要现场反复重试；真机与彩排尽量错开在模拟器验证之后。

**绕开微信 45009 的第三条路（负责人已批准、切换前验证已完成、尚未启用）**：把内容安全换成第三方审核。切换前的预验证、选定模型、代价与回滚见 [safety-provider-switch-2026-10-02.md](safety-provider-switch-2026-10-02.md)。要点：中转**不支持** `/moderations`（404），只能用 chat 模式；现用模型 `deepseek/deepseek-v4.1-flash` **不能**当审核员（输出预算全耗在 reasoning 上，2048 上限内拿不到 JSON），须换成 `deepseek/deepseek-v4-flash-fast`；替换后实测**确实会拦**广告/辱骂/赌博。环境变量只能在**云开发控制台**改（CLI 无此能力）。

## 本轮新增的可复现脚本（全部入库）

| 脚本 | 作用 |
| --- | --- |
| `scripts/verify-defense-g4-e2e.cjs` | 端到端：`--phase=failure`（三条失败路径）/ `--phase=happy`（完整路径） |
| `scripts/verify-defense-g4-first-eval.cjs` | 冻结样例首评：校验冻结哈希 → 逐例取回四节原始反馈 → 自动判①、落盘供人判②③④ |
| `scripts/probe-ai-raw-response.cjs` | 读回 `ai` 的**原始返回**（不经页面文案映射），直发或页面两种模式 |
| `scripts/defense-g4-deploy-readback.cjs` | 部署回读比对：本地构建 vs 线上 `download` 逐文件比 SHA-256，生成 `deploy/manifest.json` |
| `scripts/verify-defense-g4-comparison.cjs` | 对照实验：同一材料与回答，固定检查表 vs 通用 AI 提示，两边都落盘逐字输出与耗时 |

**没有**使用未入库的临时脚本；以上证据都能由这五个脚本 + 本文各节的 CLI 命令复现。

## 续跑手册（额度恢复后照做，顺序不要改）

**0. 开桥（先 build 再开桥；反过来会让自动化桥失效，表现为 `timeout waiting for automator response`、0 次云请求）**

```powershell
npm run build                                                   # 需要重建时才跑
& '<开发者工具目录>\cli.bat' cache --clean compile --project '<worktree>\dist'
& '<开发者工具目录>\cli.bat' auto --project '<worktree>\dist' --auto-port 9421 --trust-project
```

**看 `auto` 输出的 `autoPort`**：被占用时工具会**自动换端口**，脚本（`WECHAT_AUTO_PORT`）必须与它一致，否则会连到旧构建。连接偶发 `Uncaught [object Object]`，重开 `auto` 即可。

**1. 补完端到端 happy path**（约 1–2 次调用）

```powershell
$env:WECHAT_AUTO_PORT='9421'
node scripts/verify-defense-g4-e2e.cjs --phase=happy --out=docs/evidence/project-defense-g4/e2e-happy-<日期>.json
```

预期：`H-A`（重答→`done`）与 `H-X`（退出后再进会话清空）。**跑完把 JSON 入库**——这正是目前缺的那一份。

**2. 新冻结样例首评**（8 次调用，跨天跑；**先跑开发样例，留出样例最后**）

```powershell
node scripts/verify-defense-g4-first-eval.cjs `
  --samples=docs/evidence/project-defense-g4/samples/frozen-2026-10-02.json `
  --expect-hash=71ffad8b6897652b738ee10f44c8f7d6aca9d72584903747434b6707e571bf3d `
  --out=docs/evidence/project-defense-g4/first-eval-<日期>.json
# 被额度打断后，下次带上已完成的那份，整段已判定会话会被跳过：
#   --resume=docs/evidence/project-defense-g4/first-eval-<上次日期>.json
```

- **`--expect-hash` 不符会拒绝开跑**（判据被改过就不跑）。
- ① 引用核对脚本自动判；**②③④ 必须人读**：`judgement.step2/3/4` 的 `verdict` 留空待填，填完才算判定完成。
- 留出样例 `G4-H1`/`G4-H2` 的**首次结果单列**，**不得用于调参**。

**3. 对照实验**（2 次调用）

```powershell
node scripts/verify-defense-g4-comparison.cjs --material=FC-1 --out=docs/evidence/project-defense-g4/comparison-<日期>.json
```

`humanScoring` 的四项（完成步骤 / 定位依据是否方便 / 有效建议数 / 完成时间）同样**留给人填**。

**4. 每次跑完读一次额度并存证**（只读、不花钱）

```powershell
npm run poc:defense:usage | Out-File docs/evidence/project-defense-g4/usage-<日期>.json -Encoding utf8
```

**5. 判据回填后收口**

```powershell
npm run docs:check; npm test; npm run typecheck; git diff --check
```

把逐例判定、留出首次结果、对照结果回填本文件，更新 [docs/status.md](../../status.md) 的答辩练习行（**只改当前状态；带日期的历史实测表保留原样，需要更正时新加带日期的说明**），然后提交并推到 PR #127（**不关闭任何 Issue**）。

**6. 真机**：按 [real-device-checklist.md](real-device-checklist.md) 执行；`realDevice` **按实际记录**，没跑就写 `false`。

## 不得据此声称

- 新功能已上线、已被学生使用、教师已认可或已评价；
- 真实学习效果达标、通过率或职业等级有效；
- 引用核对已 100%（那是 G1 对 8 个**维护者自编**样例的结论，不是在线保证）；
- 真机已通过（本轮一次都没跑，`realDevice: false`）；
- 新冻结样例首评 / 对照实验已执行（**只冻结了判据，没有开跑**）；
- 除本页已记录的缺口之外，其他缺口已修复。
