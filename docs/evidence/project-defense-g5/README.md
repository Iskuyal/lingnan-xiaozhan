# 2026-10-02 A 类收尾证据（CI 审计修复 · docs:check 盲点 · 客户端超时 · 真机缺口 · G5 素材）

- 用途：记录「agent 可独立完成」清单（A1–A5）本轮**实际做了什么、判据是什么、哪一步没做到**；B 类（必须人来做）只记缺口。
- 分支 `codex/project-defense-a-cleanup`，基线 `main` = **`6b1835d`（合并 PR #127）**；工作目录是独立 worktree，**未触碰**负责人本地未提交的 `docs/competition/principal-2026-10-08/*`。
- 关联 Issue：**[#111–#115 全部仍 OPEN](https://github.com/Iskuyal/wx-match/issues/115)**（合入不等于验收，本轮**没有关闭任何 Issue**）；G5 为 [#116](https://github.com/Iskuyal/wx-match/issues/116)。
- ⚠️ **本轮的真实调用跑在第三方审核下**（`AI_SAFETY_PROVIDER=openai`，非默认 `wechat`），见 [A1 真实调用](#a1-真实调用发一次真请求2026-10-02)。

---

## A1 CI `npm audit` 失败：修好了，并做了部署回读与真实调用

### 1. 复现（本地，与 CI 同一条判据）

`main` 的 CI 长期红在「审计锁定依赖」这一步（[run 36972101873](https://github.com/Iskuyal/wx-match/actions/runs/36972101873)，2026-10-02T06:08Z）。本地用同一条命令复现：

```text
npm audit --audit-level=low --prefix cloudfunctions/ai
→ axios 0.27.2 - 0.33.0 · Severity: high
  GHSA-9fr6-4gfg-395g（Prototype-Pollution Gadget in the Default Instance…）
  GHSA-x97p-jq2g-jp4f（Prototype Pollution Gadget in axios toFormData Options）
→ 3 vulnerabilities (2 moderate, 1 high)，exit 1
```

依赖链：`wx-server-sdk@4.0.2 → @cloudbase/node-sdk@3.17.2 → axios`（项目用 `overrides` 把 axios 钉在 `0.33.0`，**正好落在公告范围内**）。

### 2. 选型：为什么是「`overrides` 钉到 `0.34.0`」

两个公告的修复版本（GitHub Advisory API 实读）：

| 公告 | 受影响范围（axios） | 修复版本 |
| --- | --- | --- |
| `GHSA-9fr6-4gfg-395g` | `>=0.27.2, <0.34.0` | **0.34.0** |
| `GHSA-x97p-jq2g-jp4f` | `>=0.28.0, <0.34.0` | **0.34.0** |

评估过的四条路，只选一条：

| 方案 | 结论 | 代价 / 风险 |
| --- | --- | --- |
| 升级 `wx-server-sdk` 到「axios 已修补」的版本 | **不存在这样的版本** | `4.0.2`（latest）与 `4.0.3-beta.1` 都锁 `@cloudbase/node-sdk`，而后者（含 `latest` 3.18.3 与 `next` 4.1.0）一律锁 `axios: 0.27.2` |
| `overrides` 钉到 axios **1.20.0** | 可行 | 要把 1.x 注进为 0.27 写的 node-sdk；虽然它只用 `axios.get/post/put/delete` 与 `axios.get(url,{timeout})`，仍是跨大版本注入，收益不如 0.34.0 |
| **`overrides` 钉到 axios `0.34.0`（选定）** | **已落地** | 只在 0.x 内移动一个补丁位；**0.34.0 与 0.33.0 的依赖完全一致**（`form-data ^4.0.4` / `proxy-from-env ^1.1.0` / `follow-redirects ^1.15.4`），运行时 Nodejs16.13 不变 |
| 按 `npm audit fix --force` 降级到 `wx-server-sdk@3.0.4` | 可行但**不选** | 把云函数 SDK 从 4 降到 3（依赖 `@cloudbase/node-sdk@2.10.0`），破坏面比换 axios 补丁大得多 |

落地改动：`package.json` 与 `cloudfunctions/{ai,timetable,newsSync}/package.json` 的 `overrides.axios` 由 `0.33.0` 改 `0.34.0`，并用 `npm install --package-lock-only --ignore-scripts` + `npm ci --ignore-scripts` 重新生成锁。四份锁的 diff **只有 axios 的 `version` / `resolved` / `integrity` 三行**，没有其它包被顺带升级。

### 3. 判据（缺一不可，全部实测）

| 判据 | 结果 |
| --- | --- |
| 三个云函数目录 + 根目录 `npm audit --audit-level=low` | **四份全部 `found 0 vulnerabilities`，exit 0**（改前 `ai` 目录 exit 1） |
| `npm test` | **725/725 通过**（改前基线 720 项 + 本轮新增 5 项超时契约测试） |
| `npm run typecheck` | 通过 |
| `npm run docs:check` | 通过（0 错误） |
| **不改任何安全配置** | 未动 `AI_MODERATE_OUTPUT` / `AI_SAFETY_FAIL_MODE` / 任何环境变量（本轮**没有**执行过改环境变量的动作） |
| **重新部署并发一次真实请求** | 见下 |

### 4. 部署与回读（`ai`，环境 `cloudbase-d2gjtbbwu3575cd7b`）

```text
cli cloud functions deploy --env cloudbase-d2gjtbbwu3575cd7b --names ai \
  --remote-npm-install --project <dist 绝对路径>
→ success: true，filesCount 20，packSize 97.3 KB
```

- 部署前先 `download` 留档（回滚用），部署后再 `download` 回读，用 [defense-g4-deploy-readback.cjs](../../../scripts/defense-g4-deploy-readback.cjs) 逐文件比 SHA-256：**函数根目录 20/20 逐字节一致，0 个不一致、0 个缺失**（完整 64 位哈希见 [deploy/manifest.json](deploy/manifest.json)）。
- 与部署前相比**只有两个根目录文件变了**：`package.json`（`axios 0.33.0 → 0.34.0`）与 `package-lock.json`；其余 18 个文件哈希不变。原始前后文件留档在 [deploy/before-2026-10-02](deploy/before-2026-10-02/) 与 [deploy/after-2026-10-02](deploy/after-2026-10-02/)。
- `info` 回读：**Active / timeout 60 / Nodejs16.13**（[原始输出](deploy/info-after-2026-10-02.txt)）。
- 明细与复跑方式见 [deploy/README.md](deploy/README.md)。

### A1 真实调用（发一次真请求，2026-10-02）

从**小程序端**发真实云调用（控制台 / HTTP 触发拿不到内容安全凭证，必然 `-501001`），用 [probe-ai-raw-response.cjs](../../../scripts/probe-ai-raw-response.cjs) 打部署后的 `ai`：先发只读的 `{action:"usage"}`（0 消耗），再发一次 `project-defense` 真实作答。

| 次序 | 时间（UTC） | 结果 | 原始记录 |
| --- | --- | --- | --- |
| 尝试 1 | 07:15:33 | **失败**：`failureClass=model_unavailable`，`detail` =「内容安全检测不可用：模型调用超时：请求超时（6000ms）：`https://api.commandcode.ai/provider/v1/chat/completions`（`AI_SAFETY_FAIL_MODE=closed`，拒绝调用…）」 | [real-call-attempt1-safety-timeout-2026-10-02.json](real-call-attempt1-safety-timeout-2026-10-02.json) |
| 尝试 2 | 07:17:15 | **成功**：`ok:true`、四节齐全（【引用核对】逐条标「成立/不成立」并给条目号、【是否对应回答】、【待验证保留】、【追问】）、`elapsedMs=33250`、4272 token / 0.001068 元 | [real-call-success-2026-10-02.json](real-call-success-2026-10-02.json) |
| 只读探针 | 07:15:33 | `{action:"usage"}` → `ok:true`，当月 **286 次 / 283,321 token / 0.070848 元**（上限 50、告警线 40、`warn:false`、`exceeded:false`） | [usage-probe-2026-10-02.json](usage-probe-2026-10-02.json) |

**这次调用顺带回答了交接单的第一条**：线上**仍然是第三方审核**——成功那次返回 `safety.provider="openai"`、`api="text-moderation"`、`passed=true`、`checked=true`，业务模型 `deepseek/deepseek-v4.1-flash`，全程**没有出现 `errcode=45009`**。⇒ 「换回 `wechat` 就会被当天配额拦死」这个前提**今天仍然成立**。

**口径边界（别把这个结论说过头）**：

- 这次调用证明的是「**换成 axios 0.34.0 并重新部署后，`ai` 云函数仍能真实调用**」；它**不是**「axios 那两条公告的修复路径被走到」的证据——`ai` 自己发的 HTTP 走它的 `http` 模块，数据库请求走 node 原生 http，`@cloudbase/node-sdk` 里 axios 只出现在 **metadata 探测**与 **extension shim**（`dist/utils/metadata.js`、`dist/cloudbase.js` 的 `requestClient`）两个位置。
- 尝试 1 的失败是**第三方审核端点单次 6 秒超时**触发的 fail-closed（`AI_SAFETY_FAIL_MODE=closed` 按设计拒绝调用、记 `model_unavailable`），**不是**依赖升级引起；重试即成功。
- 两次都被计入月度用量（`calls` 286 → 291）。**额度是消耗品**，本轮共用掉 5 次计数（含 1 次失败）。

---

## A2 `docs:check` 的盲点：链接目标必须能在干净检出里出现

### 1. 盲点

`scripts/check-docs.mjs` 原来**只看磁盘**：链接目标在本地存在就放过，因此**查不出指向 `artifacts/`、`dist/` 这类被 gitignore 的路径的链接**——本地绿、CI 干净检出 404。PR #127 就是这样被拦下的（`00de091` 当时只能人工删链接，没有把判据补上）。

### 2. 改法

新增 `collectVisibleFiles(root)`：`git ls-files --cached --others --exclude-standard -z`，作为「**git 能看见**」的集合；`checkDocuments({root, files, visible})` 在原本的「磁盘存在」判据之后**加一道**「目标必须在这个集合里」，CLI 入口传入该集合。

两个刻意的取舍（写进了代码注释）：

- **用「git 能看见」而不是「已跟踪」**：`collectDocumentationFiles` 本身**包含未跟踪的新文档**（提交前也要能跑 `docs:check`），若只认 `--cached`，新文档之间的互链会在提交前误报。`--others --exclude-standard` 后的判据恰好等于「这份文件会不会出现在干净检出里」。
- **必须带 `-z`**：默认输出会把非 ASCII 文件名转义成 `\xxx`，中文文件名会误报（测试用 `docs/中文.md` 锁住）。
- 目录链接（如 `[目录](docs/)`）按「目录下有没有可见文件」判断——git 不跟踪目录本身。
- `visible` 未传时跳过该判据，供不依赖 git 的单元测试使用。

### 3. 判据（全部实测）

| 判据 | 结果 |
| --- | --- |
| `npm run docs:check` 仍绿 | `文档检查：144 个 Markdown，1140 个本地引用，0 个错误。` exit 0 |
| **故意加一个指向 `artifacts/` 的链接必须报错** | 造 `docs/_probe-gitignore-link.md` → `[回读](../artifacts/probe/out.json)`（目标文件真实存在、被 gitignore）⇒ `文档检查：145 个 Markdown，1116 个本地引用，1 个错误。` exit 1，报错原文：`docs/_probe-gitignore-link.md:3 目标不在 git 里：被 .gitignore 忽略的文件在 CI 的干净检出中不存在 (../artifacts/probe/out.json)`；删掉探针文件后回到 0 错误（探针文件与目标目录都已清理，未入库） |
| 测试锁住行为 | [tests/docs.test.cjs](../../../tests/docs.test.cjs) 新增 2 例：① 注入 `visible` 集合 → 被忽略目标报错、进入集合则放过；② 在真 git 仓库里跑 `collectVisibleFiles` → `-z` 下中文文件名不转义、被忽略的 `artifacts/` 不在集合里、目录链接靠可见文件通过 |

> 维护者可以顺手用同一判据复查历史文档：把 `visible` 传进去跑一次 `npm run docs:check` 就是全仓库体检。

---

## A3 客户端超时：按「高于实测上界」实现，并同步设计契约

### 1. 缺口

设计契约 5.1 原写「超过 **30 秒**未返回，按 `model_unavailable` 结束本次并保留输入」，但代码里**根本没有客户端超时**（`services/ai.ts` 与 `services/defense/index.ts` 零 timeout），真机断网实测**约 60 秒**才失败。而 30 秒写在「12–23 秒」的年代，正常时延现在已到 **20–45 秒** ⇒ **照字面实现会砍掉正常请求**。

### 2. 实现（阈值 75 秒）

- `miniprogram/services/ai.ts` 新增 `AI_CALL_TIMEOUT_MS = 75000` 与 `CLIENT_TIMEOUT_WARNING = 'client_timeout'`；`callAi(data, timeoutMs = AI_CALL_TIMEOUT_MS)` 给云调用套一层超时。
- **超时不抛错**：返回 `failureClass='model_unavailable'` 的合成结果（`warnings` 带 `client_timeout`）——契约要的是「按 model_unavailable 结束」，抛错会走 `transportMessage` 那套「没能发出去」的文案，两者不是一件事。
- 页面因此**照既有失败态走**：文案「模型暂时没有返回结果」、`retryable: true`、**保留草稿**、不推进轮次、不产生反馈（`defenseFailureCopy` / `recordFailure` 未改）。
- `requestFeedback(session, question, timeoutMs?)` 增加**可选**参数透传，只为让测试用小阈值验证超时路径；生产调用不传，用默认值。

**为什么是 75 秒**（三层阈值，写进了设计契约 5.1.1）：

| 层 | 阈值 | 说明 |
| --- | --- | --- |
| 服务端总预算 `AI_TOTAL_DEADLINE_MS` | 代码默认 15000 毫秒；G4 文档记的线上口径 50000 毫秒 | 线上取值只能在云开发控制台确认，仓库里读不到 |
| 平台云调用 | 约 60 秒 | 真机断网实测「约 60 秒才失败」就是它 |
| **客户端兜底（本次新增）** | **75 秒** | 高于实测上界 45 秒，也高于上面两层；只在平台没有按时收尾时兜住 |

⇒ 定位是**兜底而不是主路径**，价值是「等待有上界」不再依赖平台行为，**不是**把失败提前。

### 3. 判据（全部实测）

| 判据 | 结果 |
| --- | --- |
| 超时后失败态文案正确、草稿保留 | [tests/defense-timeout.test.cjs](../../../tests/defense-timeout.test.cjs) 5 例全过：挂住的云调用 → `model_unavailable`（不抛错、带标记）；`requestFeedback` 超时 → 可重试文案「你的回答…」；`recordFailure` 后 `draft` 与 `round` 不变、`feedbacks` 为空；页面把失败卡上屏、`answer` 保留、`sections` 为空 |
| 契约与实现一致 | [设计契约](../../design/project-defense/README.md) 5.1 的 30 秒那条**已改写**为 75 秒 + 指向 5.1.1；原「未实现、阈值偏低」的实测注记**保留原文**并加了一句「同日晚些时候已按 75 秒实现」；新增 5.1.1 记录实现与三层阈值 |
| 有测试 | 新增 5 例；并加了一条**阈值守卫**（断言 `AI_CALL_TIMEOUT_MS >= 75000` 且 `> 45000`），防止有人改回 30 秒 |
| **不改变正常路径** | 阈值内返回照旧成功（单测）；`npm test` **725/725**、`npm run typecheck` 通过 |
| 界面 | **没有新增或改动界面**：超时复用既有的失败态（设计图 `07-failure`），因此本轮**不出新设计图**、PNG 不需要重渲 |

> 连带修一处测试环境缺口：`tests/departments-qa.test.cjs` 用 `vm.runInNewContext` 装沙箱，本来没有 `setTimeout`（小程序运行时有），`callAi` 加超时后该用例报 `setTimeout is not defined`。修法是**把定时器注入沙箱**，让沙箱继续如实模拟小程序环境，而不是在生产代码里给缺失的全局量开后门。

---

## A4 真机补测：**本轮没有真机可测，如实记缺口**

### 1. 设备状态（动手前先查，这是纪律要求）

```text
adb devices -l            （D:\dev-cache\...\platform-tools\adb.exe）→ 空
D:\MuMu\nx_main\adb.exe devices -l                                  → 空
```

- G4 用过的真机 **Xiaomi `25113PN0EC` / `513dcd80`**（[G4 设备事实](../project-defense-g4/real-device-facts-2026-10-02.json)）**本轮未连接**；先前 `adb` 里看到的 `emulator-5554` 在重启 adb server 后也不在了，且**没有任何安卓设备**可供操作。
- ⇒ **扫码加载新预览、返回手势后状态不串、真机额度路径、基础库版本**四项**全部未执行**：不写成「已验证」，也不写成「无问题」。

### 2. agent 能做的部分：预览码已生成（未推送、未扫码）

`cli preview --qr-format image` 成功（包体 437.2 KB），预览码写到 **gitignore 的** `artifacts/device/g5-qr.png`（46,426 B）。该路径**不入库、不链**（`artifacts/` 会被 A2 的新判据拦下，本来也不该链）。**没有** `adb push`（无设备）、**没有**扫码验证。

### 3. 顺带修正一条 CLI 经验（与 G4 记录不同）

G4 的 [deploy/README.md](../project-defense-g4/deploy/README.md) 把 `cli cloud functions download` 的 `code 17 二维码输出路径无效或不存在` 解释为「开发者工具未登录 / 项目未打开」。本轮**多次实测**：

- `--path` 指向**不存在**的目录 → **必现** code 17（同一会话、已登录、项目已打开）；
- 先 `New-Item -ItemType Directory` 建好该目录，**同一条命令立刻成功**。

⇒ code 17 至少有「**输出目录不存在**」这个成因，上面那条解释不是唯一成因。同理，`cli` 现在需要 IDE 安全设置里的 **CLI access token**（`--token` 或 `WECHAT_DEVTOOLS_CLI_TOKEN`），否则 initialize 直接拒绝——**token 只在 IDE 界面可见，不写进仓库、不写进证据**。

---

## A5 G5 素材（10-08 用）

按 [G4 → G5 输入清单](../project-defense-g4/g5-inputs-2026-10-02.md) 的四个输入产出三份**新增**文件（不改已有文件）：

| 文件 | 内容 |
| --- | --- |
| [g5-ppt-outline-2026-10-08.md](../../competition/principal-2026-10-08/g5-ppt-outline-2026-10-08.md) | P01–P10 主讲页（合计 **480 秒**）+ 备用页；逐页「标题 / 要点 / 证据链接 / 停留秒数」，另列「必须由负责人提供」与「不得出现的表述」 |
| [g5-speaker-script-2026-10-08.md](../../competition/principal-2026-10-08/g5-speaker-script-2026-10-08.md) | 8 分钟讲稿，带时间轴与逐段证据出处；正文（`>` 引用块）**1,710 汉字** ≈ 6 分 50 秒（250 字/分钟）+ 45 秒预录视频 = 7 分 35 秒，留 25 秒余量 |
| [g5-demo-script-2026-10-08.md](../../competition/principal-2026-10-08/g5-demo-script-2026-10-08.md) | 演示脚本：T-1/T-30 准备、现场一轮逐步表、降级矩阵 A–J、额度预算与「额度已尽」话术、排障口径、演示后记录 |

口径要点（全部按仓库证据）：

- **时延**用实测区间：模拟器 16.9–33.2 秒（n=10，中位 22.9，出处是[设计契约 5.1](../../design/project-defense/README.md) 与 [G4 输入清单第一节](../project-defense-g4/g5-inputs-2026-10-02.md)）、换第三方审核后约 35 秒/次、真机 ≲45 秒/轮（其中一轮 ≤48 秒）、真断网约 60 秒才失败；页面与设计图文案已是「20–45 秒」，明确写「12–23 秒已作废」；降级方案 = 现场只跑一轮 + 45 秒预录视频。
- **额度**写清两个上限（微信内容安全 100 次/天全功能共用；`AI_USER_DAILY_LIMIT=30`；**被拒绝的请求也计数**）与预算表；「额度已尽」话术照读。
- **审核配置**如实标注第三方审核且**只能由负责人在控制台确认**；讲稿里超时兜底写成「本轮 PR 的改动（阈值 ≥75 秒，高于实测上界）」，**没有**写成早已验收。
- **B 类只作缺口**；无授权结果、无「学校已授权」；链接全部指向被 git 跟踪的文件（A2 的新判据下 0 错误）。

产出后做了一轮**独立只读复核**（另一位 agent，按 10 条清单逐项查数字可回核、禁用表述、前提标注、时延、额度、B 类、链接、额度/断网路径交叉、超时表述、时间轴），随后**按复核结论整改**：成本数字改为可回核的 278 次 / 266,612 token / 0.066670 元、讲稿压到 1,710 字、把「页面上可区分两个额度上限」改成「**页面上不可区分**，只能用探针原始返回区分」、把额度失败与传输失败的重试语义拆开、去掉抢在负责人拍板前下的结论。复核发现集中在**三份新文件**，已全部处理；复核报告未入库（属过程记录）。

另外**更正了来源文档里的一句错话**：[g5-inputs 第二节第 3 条](../project-defense-g4/g5-inputs-2026-10-02.md) 原写 `quota_exhausted` 会「保留草稿 + **重试入口**（真机已验）」，与代码（`retryable: false`）和 G4 主清单失败路径 ② 相反，且额度路径**不是真机验的**。原文保留，同处追加了带日期的 ⚠️ 更正块。

> ⚠️ **未做（缺口）**：三份文件**还没挂到目录索引**——`docs/competition/principal-2026-10-08/README.md` 与 `docs/competition/README.md` 在负责人本地有未提交改动，为避免冲突本轮**没有触碰**这两个索引文件。

---

## 本轮没做 / 做不到（按 B 类如实记，别读成“已修复”）

| # | 事 | 本轮状态 |
| --- | --- | --- |
| B1 | 第二个人类评审（独立读 8 例并给 ②③ 判定） | **未做**：只有 1 个人 + 1 个 AI 复核过 |
| B2 | 拍板「『未被如实保留』算不算道德评价」 | **未拍板**：G5 三份文件都把它列为待负责人决定 |
| B3 | 审核配置保留第三方还是回滚 `wechat` | **未决定**：本轮只**读实**线上仍是 `openai`（真实调用返回）；改环境变量只能在云开发控制台，CLI 无此能力 |
| B4 | 真机上扫码加载新预览 | **未做**：无设备连接（见 A4） |
| B5 | 真实学生样本 | **仍是 0**：8 例全是维护者自编；不能声称学习效果、通过率、教师认可 |
| B6 | 10-08 的授权结果 | **本轮无从得知**：属负责人对外沟通结果 |

其它如实记录的缺口：

- **`cloudfunctions/lost-found` 没有锁文件、也不在 CI 的 `npm audit` 步骤里**（CI 只审计 `ai` / `timetable` / `newsSync`），因此它的 `wx-server-sdk` 传递依赖**没有**被本轮钉住。`tests/security-dependencies.test.cjs` 已把「四份有锁文件、且被 CI 审计的清单」写成注释说明，避免把「已固定」的范围说过头。
- **`xlsx-cdn-probe` 这个 G4 遗留的一次性探针函数仍在云端函数列表里**（本轮 `cli cloud functions list` 仍能看到），清理要维护者在控制台做。
- **真实学习效果、在线引用准确率、真机返回手势、基础库版本**：本轮都没有新增结论。

## 复跑方式

```text
# A1：审计判据（四份都要 0 漏洞）
npm audit --audit-level=low
for f in ai timetable newsSync; do npm audit --audit-level=low --prefix "cloudfunctions/$f"; done

# A1：部署回读（需先 download 到临时目录，见 deploy/README.md）
node scripts/defense-g4-deploy-readback.cjs --dist=dist/cloudfunctions/ai \
  --archive=<回读目录> --against=docs/evidence/project-defense-g5/deploy/before-2026-10-02

# A2：全仓库文档体检（含「目标是否在 git 里」）
npm run docs:check

# A3：超时契约
npm run build && node --test --test-concurrency=1 tests/defense-timeout.test.cjs
```
