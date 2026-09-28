# 内容安全审计报告（AI 内容通路）

- 审计日期：2026-09-27
- 审计对象：`main` @ `4e3c8d7`（含 PR #59 安全整改、#67 审查修复）
- 审计范围：**内容安全检测的有效覆盖**——用户文字与图片进入第三方模型的通路、模型输出上屏的通路、外部内容进入展示面的通路
- 审计方式：读码 + 用 `tests/ai-harness.cjs` 夹具驱动真实编译产物做可运行复现（复现脚本与输出见文末）
- 与既有报告的关系：[PR #57 安全审计](pr-57-security-audit.md) 覆盖越权读取与运维入口；本报告**不复述已整改项**，只查内容检测本身的覆盖缺口
- **修复状态（2026-09-28）**：CT-01 与 CT-02 已修复并带回归测试，随 [PR #74](https://github.com/Iskuyal/wx-match/pull/74) 合入 `main`（合并提交 `50cb884`），见文末「修复（2026-09-28）」一节；**云函数尚未重新部署，线上行为仍是修复前**。CT-03 / CT-04 / CT-05 未修，保持原判。

## 结论

检测**接入**是完整的：所有模型调用前都有输入检测、生成文字上屏前都有输出检测，`off` / fail-open 都会如实标 `checked=false`。缺口不在"有没有接"，而在**检测窗口的大小**：一次固定 2 万字的窗口，同时小于请求允许携带的输入量和模型可能产出的输出量，窗口外的部分**既不检测、也不拦截**，只写一条告警。

| 编号 | 风险 | 一句话 | 2026-09-28 |
| --- | --- | --- | --- |
| CT-01 | 高 | 检测窗口 2 万字 < 输入上限（20×8000 字 + 无上限的 `system`）；窗口外的输入未过检即送第三方模型，且**长对话里最新一轮提问正好落在窗口外** | 已修复（待部署） |
| CT-02 | 高 | 同一个窗口在输出侧：模型输出超 2 万字时，尾部**未经检测就返回客户端并上屏**——正面违反开发规格的硬约束 | 已修复（待部署） |
| CT-03 | 中 | `news_articles` 全用户可读（含未登录单页模式），入库前无内容安全环节，唯一闸门是 HTML 清洗与域名白名单 | 未修 |
| CT-04 | 低 | 课表侧自由文本（Excel 原文 / 手工输入 / 学期名）不过检，与截图路径形成两套标准；数据按 openid 隔离，不对外展示 | 未修 |
| CT-05 | 低（推断） | 分片无重叠，跨片拼接的违规内容可能两边都不命中；**未实测** | 未修 |

## 发现

### CT-01 高风险：检测窗口小于输入上限，窗口外输入未过检即送模型

**位置**：`cloudfunctions/ai/index.ts:66,68,70,75`（上限）、`:311-318`（拼输入）、`:406-447`（分片与截断）、`:657`（`system` 无长度上限）

三个上限互相矛盾：

| 项 | 值 | 出处 |
| --- | --- | --- |
| 单条消息上限 | 8000 字 | `index.ts:68` |
| 消息条数上限 | 20 条 | `index.ts:66` |
| 事件顶层 `system` | **无上限** | `index.ts:657` 只做 `safeString` |
| 一次检测的覆盖量 | 2000 字 × 10 片 = **2 万字** | `index.ts:70,75` |

也就是说，一次合法请求最多能带 16 万字（`system` 再往上不封顶），而检测只看前 2 万字。超出部分走 `index.ts:431-445` 的分支：把范围写进 `safety.detail`、`checked` 置 false、追加一条告警——**然后照常把完整的文本送进模型**（`:677-681` 只拦 `rejected`，截断路径的 `rejected` 是 false）。

**这不是只有恶意构造才触发。** 07 部门问答与 06 课表助手每轮都回传最近 20 条历史（`services/ai.ts:133,141`），`inputText` 按 `system → 消息顺序` 拼接，最新一条在**末尾**。长对话累积到 2 万字以上后，**用户当前这一轮提问正好落在未检测的那一段**。

复现（探针 1）：5 条 8000 字消息共 4 万字，违规标记放在最后一条末尾。结果 `ok: true`，`msgSecCheck` 累计只送检 20,002 字，**标记从未送检**，却出现在发给模型的请求体里。

### CT-02 高风险：同一窗口在输出侧，未检测的生成文字照样上屏

**位置**：`cloudfunctions/ai/index.ts:563-573`（`moderateOutput`）、`:699`（调用点）、`cloudfunctions/ai/vision.ts:99-104`（分带输出上限）

`moderateOutput` 同样受 2 万字窗口限制，且截断后**只告警不拦截**：只要 `rejected` 为 false，完整输出就经 `response.text` 返回客户端，客户端用 `{{}}` 原样渲染（`pages/departments/qa.wxml:53`、`pages/timetable/index.wxml:174`）。

开发规格把这一条列为硬约束：**"AI 生成的文字与用户上传的图片都要过内容安全检测，否则审核会被打回"**（`docs/development-spec.md:125`）。输出侧溢出是这个硬约束上唯一的直接缺口。

可达性（区分实测与估算）：

- **已实测**：`vision` 分带识别的**合并输出**能超过 2 万字。6 带合并后 30,737 字，只检了前 20,006 字，**尾部 10,731 字未经检测就返回**（探针 3）。分带是 Ticket 05 的默认路径（客户端固定下发 `bands: 'auto'`）。
- **已实测（机制）**：stub 返回 2.5 万字的 `chat` 输出时，尾部 5,001 字未检测即返回（探针 2）。
- **估算（未实测）**：中文输出受 `AI_MAX_TOKENS`（默认 1024，上限 8192，`config.ts:152`）约束，8192 token 的中文约 0.8-1.2 万字，**够不到** 2 万字窗口；要够到需要以 ASCII 为主的长输出（8192 token × 约 4 字符/token ≈ 3 万字）。因此 `chat` 路径需要用户主动要求长英文/结构化输出才触发，分带 `vision` 路径才是现实入口。

### CT-03 中风险：外部抓取内容进入全用户可读展示面，无内容安全环节

**位置**：`cloudfunctions/newsSync/parse.ts`（清洗）、`cloudfunctions/newsSync/record.ts:38-54`（入库形状）、`docs/cloud-development.md:156`（权限）

`news_articles` 的客户端规则是自定义 `{"read": true, "write": false}`，**刻意覆盖未登录单页模式**——任何进入该集合的文本对所有访问者可见。内容来自 `lnc.edu.cn` 官网抓取，写入前只有 HTML 剥离、实体解码、署名裁剪（`parse.ts:38-84,300-317`）与域内白名单，**没有任何内容安全检测**。

这不是 UGC，不构成"审核必被打回"，但意味着：官网一旦发布违规内容（或站点被篡改），会直接对全部用户展示，而仓库侧没有检测闸门、也没有下线开关。**建议**：入库前接一次 `security.msgSecCheck`（同步发生在定时触发里，配额压力可控），或至少加一条按关键词的自动下线与告警。

### CT-04 低风险：课表自由文本不过检，与截图路径两套标准

**位置**：`cloudfunctions/timetable/index.ts:339-359`（`saveDraft` / 落库）、`:405-484`（`createCourse` / `updateCourse`）、`timetable/record.ts:11-23`（字段与长度上限）

`timetable` 云函数接受课程名、教师、地点、备注、原文、学期名等自由文本并落库、回显，全程不接内容安全；而**同样形态的数据**经截图识别路径时是过检的（`cloudfunctions/ai/index.ts:672-699`）。

影响有限：这些数据按 `owner: openid` 严格隔离（`cloudfunctions/timetable/index.ts:91-97`），客户端互相读不到，仓库内也没有分享/导出入口，因此**不构成对外展示风险**。列入报告是因为"同一产品同一份数据两套检测标准"在审核问询时不好解释，且 Ticket 11 的 OCR 回填（`scripts/ocr-backfill.cjs:186,206`）尚未落地入库，落地时若沿用 `timetable` 的写法会形成第三条无检测通路。

### CT-05 低风险（推断，未实测）：分片无重叠

**位置**：`cloudfunctions/ai/index.ts:70,414-419`

分片按固定 2000 字切、片之间不重叠，因此切点位置可预测（2000 / 4000 / 6000…）。把违规表达跨切点摆放，理论上可能两片都判通过。这是对检测模型行为的推断，**本项目未实测**，列为加固项：要么给分片留少量重叠，要么用满微信 2500 字的单次上限（当前 2000 是保守取值）减少片数。

## 已确认的控制（本次复核通过，未发现问题）

- **检测接入无遗漏**：`cloudfunctions/ai` 内所有模型调用（`chat` / `vision` 单带 / 分带）都在输入检测之后；`callModel` 的调用点只有 `invokeModel`（受流水线约束）与审核适配器自身。
- **输入检测覆盖 system 与 assistant 历史**，不是只检 user（`index.ts:305-318`）。
- **图片先检后送模型**，且 `imgSecCheck` 与 `msgSecCheck` 是两个独立入口（`safety.ts:546-567`）。
- **失败方向正确**：检测不可用默认 fail-closed；`off` 与 fail-open 都返回 `checked: false` 并写明模式（`safety.ts:240-266,513-526`）。
- **客户端不把"跳过"读成"干净"**：`checked !== true` 一律按未检测处理并显示提示行（`services/ai.ts:108,117-124`，`pages/departments/qa.wxml:54`）。
- **无注入面**：小程序端无 `rich-text` / `<web-view` / `innerHTML` / `wx.request`，AI 文本与用户内容都走 `{{}}` 转义；用户上传的图片从不在页面渲染。
- **无跨用户 UGC**：客户端无写库能力，课表按 `owner` 隔离，仓库内无分享入口。
- **用量记录不含内容正文**，用户标识只存 SHA-256 摘要（`access.ts:11-13`）。
- **运维与独立审核动作需 `AI_ADMIN_OPENIDS`**，默认白名单为空即全拒（`access.ts:20-29`，`index.ts:803-804`）。

## 建议的修复方向（CT-01 / CT-02 同一根因，一处改动即可）

根因是"检测窗口"与"输入/输出可达长度"两个常量各自演化、互不约束。三选一，推荐第 1 条：

1. **让窗口覆盖上限，并对溢出 fail-closed**：把 `MAX_MESSAGE_CHARS × MAX_MESSAGES + system` 收敛到检测覆盖量以内（例如消息上限降到 20 条 × 1000 字），并给 `system` 补长度上限；同时把"超出窗口"从告警改为 `content_rejected` / `invalid_request`——与项目既有的 fail-closed 纪律一致。
2. **输出侧按上限反推**：把 `AI_MAX_TOKENS` 与分带合并的**总输出预算**约束在窗口内（`maxTokens × 带数 × 每 token 字符数 ≤ 20000`），配置加载时校验，超了就拒绝启动而不是静默截断。
3. **截断即拒**：保留现有上限，但凡发生截断（输入或输出）直接不返回内容——用户体验最差，但改动最小。

注意：`tests/ai-flow.test.cjs:811-822` 目前**把截断放行当预期行为断言**（`'前 2 万字没发现问题就不拦'`），修 CT-01/CT-02 必须同步改这条测试。

## 审计基线状态

本地完整回归：`npm test` **471 项，468 通过、3 失败**。3 条失败全部在 `tests/security-dependencies.test.cjs`，原因是**本机 `node_modules` 早于依赖加固提交**——锁文件 pin 的是 `jimp@1.6.1` / `xlsx@0.20.3` / `axios@0.33.0` / `lodash.unset@4.18.0`，本机装的是 `0.22.12` / `0.18.5` / `0.27.2` / `4.5.2`。`main` 最近 5 次 CI（工作流「小程序检查」，含 `npm ci --ignore-scripts`）均为 success，因此这 3 条**不是仓库回归**；同步环境用 `npm ci --ignore-scripts`（需要能访问 npm 与 `cdn.sheetjs.com`）。

内容安全相关的测试文件（`ai-flow`、`ai-safety`、`security-audit`、`departments-qa`、`timetable-assistant`）本次全部通过——也就是说，**本报告的发现都不被现有测试覆盖或阻断**，其中 CT-01/CT-02 的截断行为还被 `ai-flow.test.cjs:811-822` 当预期固化下来。

## 审计边界（本次无法验证）

- 云端环境变量的实际值（`AI_SAFETY_PROVIDER` / `AI_SAFETY_FAIL_MODE` / `AI_MODERATE_OUTPUT` / `AI_MAX_TOKENS`）只能从控制台读，仓库里读不到。**若生产把 `AI_MODERATE_OUTPUT` 配成 false，CT-02 的缺口会从"超长才触发"变成"完全不检测输出"**——这是发布前值得人工确认的一项（线上自检办法：看对话里是否出现"⚠️ 本轮回答没有经过内容安全检测"提示行）。
- 微信 `msgSecCheck` 的实际判定行为（含 CT-05 的跨片拼接）未实测；`imgSecCheck` 对**图片内文字**的识别能力也未实测，因此截图里的违规文字是否被图片检测拦住、还是靠输出检测兜住，本项目没有数据。
- 分片检测串行 10 次对总截止的挤占（一次 15 秒总预算里，检测可能占掉大部分）未实测。

## 复现方式

复现脚本已归档在 [docs/evidence/content-safety-audit-2026-09-27/](../evidence/content-safety-audit-2026-09-27/README.md)，依赖已提交的测试夹具，不需要密钥、不访问网络：

```bash
npm run build
node docs/evidence/content-safety-audit-2026-09-27/probe-moderation-window.cjs
```

## 修复（2026-09-28）

采用上面的第 1 条 + 输出侧补一档分片（不是第 2 条的配置校验，也不是第 3 条的「截断即拒」）：

| 侧 | 改动 | 位置 |
| --- | --- | --- |
| 输入 | 新增 `MAX_INPUT_CHARS = MODERATION_CHUNK_CHARS × MAX_INPUT_CHUNKS = 20000`：`system` 与全部消息拼起来超窗口即 `invalid_request`，**在花检测配额与下载图片之前**拒绝；错误 detail 写明总字数与 system 字数，用户文案指向「精简或清空对话」 | `cloudfunctions/ai/index.ts`（`runModelAction`） |
| 输出 | 新增 `MAX_OUTPUT_CHUNKS = 20`（4 万字）：输出先判长度，再**分片全检**，超 4 万字按 `internal` 失败且不返回任何文字——宁可这次没有结果，也不上屏未检测内容 | 同文件 `moderateOutput` |
| 诊断入口 | 管理员限定的 `moderateText` 动作保留「部分报告 + `checked=false`」；它不喂模型也不上屏，报告本身就是结论 | 同文件动作分发 |
| 客户端 | `MAX_INPUT_CHARS = 20000` 与服务端同源，`HISTORY_INPUT_BUDGET = MAX_INPUT_CHARS - 4000`，`chatMessages(history, system)` 从最旧一条开始剪到预算内（最后一条提问永不被剪）；`system` 是必传参数，漏传编译期就报错，不会静默跳过预算判断。`system` 不再单独设长度上限（见下），拼接规则在服务端只留 `inputText()` 一处 | `miniprogram/services/ai.ts`、07 两个页面统一走 `qa.ts` 的 `qaChatEvent()`、06 在 `pages/timetable/index.ts` |

对上面「建议的修复方向」的两处偏离，理由记在这里：

- **`system` 没有单独的长度上限**：推荐里写「给 `system` 补长度上限」，实现改成让 `system` 参与**聚合上限**（`system` 单独超窗同样被拒）。理由是项目里几个系统提示词本身就不短——课表助手在真实规模（50 门课）下 system 约 5094 字，单设一个「比如 2000 字」的上限会直接打断 06；聚合上限才是安全真正需要的那个不变量。
- **输出超限归 `internal` 而不是 `content_rejected` / `model_unavailable`**：模型这次是成功返回的，失败的是「本地没能把这段输出检完」，与既有的「内容安全检测不可用（fail closed）」同族；记成 `model_unavailable` 会把这类事件混进模型/中转的失败统计里。用户文案单独写（「回答过长已丢弃该回答」），优先于 `AI_MSG_INTERNAL`。

回归测试（`tests/ai-flow.test.cjs`）：输入超窗拒绝且 0 次检测 / 0 次模型调用、窗口内尾部标记必须送检、输出 2.5 万字分片全检（`checked=true`、无 `checked=false` 告警）、输出 4.5 万字不返回内容且归 `internal`、2 万字边界内通过且多 1 字被拒、**部门动态注入的最长文本 < 客户端留白**（用真实语料，防止语料变长后留白失效）。`tests/timetable-assistant.test.cjs` 补客户端自剪口径（含「预算由服务端上限推导」的断言）。原先固化「截断放行」的那条测试已改写为诊断动作的部分报告用例。

修复后复跑三个探针（输出见[证据](../evidence/content-safety-audit-2026-09-27/README.md)）：

```text
探针 1：ok = false ｜failureClass = "invalid_request" ｜模型调用次数 = 0 ｜送模型的请求体里出现标记 = false
探针 2：ok = true ｜safety.checked = true ｜返回文本 25006 字 ｜未检测字符数 = 0
探针 3：ok = true ｜safety.checked = true ｜合并输出 30737 字 ｜未检测字符数 = 0
```

本地完整回归：`npm test` **504 项全通过**（先按[审计基线](#审计基线状态)的办法同步过 `node_modules`）。

**仍未完成**：新版 `ai` 云函数尚未部署，线上行为仍是修复前；`AI_MODERATE_OUTPUT` 与 `AI_SAFETY_FAIL_MODE` 的云端实际值仍待人工确认；CT-03 / CT-04 / CT-05 未修。云端复验已写成可执行探针 `npm run probe:ai-window`（超长输入拒绝 + 长输出全检两档，判定逻辑见 `scripts/lib/ai-window-judge.cjs`，有单测覆盖修复前后的两种返回值形状）。**探针脚本本身尚未在开发者工具与云端跑过**——本地没有自动化端口与云环境，需要部署时一并执行，判据见[待办总表 V8](../tasks/pending.md)。

实测输出摘要：

```text
===== 探针 1：输入侧 =====
请求 ok = true ｜failureClass = ""
safety.checked = false
msgSecCheck 调用次数 = 11 ｜累计送检字符 = 20002
  检测过的文本里出现标记 = false
  送模型的请求体里出现标记 = true
  请求携带字符数 = 40000 ｜未检测却进了模型的字符数 = 19998

===== 探针 2：输出侧（chat）=====
请求 ok = true
safety.checked = false
  检测过的文本里出现标记 = false
  返回给客户端的 text 里出现标记 = true
  返回给客户端的 text 长度 = 25006 ｜未检测字符数 = 5001

===== 探针 3：vision 分带合并输出 =====
请求 ok = true ｜模型调用次数 = 6
合并输出长度 = 30737 ｜累计送检字符 = 20006 ｜未检测字符数 = 10731
  合并输出里出现标记 = true ｜safety.checked = false
```

三例的共同点：请求都**成功返回**，检测结论都如实标了 `checked=false` 并留了告警，但**内容照常流通**——这正是缺口的性质：不是"假装检过"，而是"检过的公开承认没检全，却仍然放行"。
