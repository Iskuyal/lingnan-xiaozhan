# 01：AI 服务端基础设施

**What to build:** 产品里任何一个 AI 功能调用模型时，都走同一套服务端管道。学生在任意 AI 入口提问、上传图片时，系统能稳定地调用外部大模型、对输入输出做内容安全检测、并在模型不可用或内容被拒时给出可区分的失败而不是白屏或假成功。密钥只在云服务端，不进入小程序包。

这一票不面向最终用户界面，但它是 05、06、07 三票的共同前置——那三处都需要「调模型 + 过内容安全 + 失败降级」，先建一次，避免每处重复造。

**Blocked by:** 无。P5-A 收尾项已于 2026-09-18 由负责人确定（成功指标、成本上限、内容安全接入方式、失败分类与文案），结论写入 [开发规格](../../development-spec.md) 的「AI 功能」一节。模型接入的端到端验证在本票执行。

**Status:** **in-progress（2026-09-19）**——本地代码、桩测试与文档已完成并通过（`npm run typecheck`、`npm test` **297 项全过**，其中本票 81 项）；两轴代码复核（Standards + Spec）提出的 11 项问题已修复（见下「复核修复记录」）。**云端侧**：部署、两个用量集合与模型环境变量已完成；**微信内容安全探测已在未认证状态下跑通**（两条接口 `errcode 0`，官方适配器可用，不需要第三方审核密钥）；**端到端已跑通**（`npm run smoke:ai`：`ok=true`、模型返回「链路已通」、耗时 4600ms，证明 20 秒超时已生效）；**数据库侧无密钥外泄已抽查**（`ai_usage_records` 一条真实记录只有用量字段，无密钥字段/值）；**云函数内存已核实为 256MB**（控制台日志 `Memory: 256MB MemUsage: 37.4MB`，2026-09-19）。**2026-09-19 补充**：负责人告知本票剩余项已核实（记为负责人确认）；**但 `vision`（截图识别）路径经独立复测（三张真实课表截图 + 一张 570 字节合成小图）全部在 8000ms 处超时失败**（`failureClass=model_unavailable`、`detail=模型调用超时：请求超时（8000ms）`、`provider=openai model=qwen/qwen3.8-flash`），因此该条按「**已执行、未通过**」记录，不计为通过——图片先过内容安全这一步本身是通的（`checked=true`、`errcode 0`），卡住的是模型调用。复测入口 `npm run smoke:ai:vision`（本票新增），证据见 [Ticket 01 端到端冒烟记录](../../evidence/p5-foundation/README.md)。逐项状态见下与 [云开发文档](../../cloud-development.md#ticket-01-人工步骤)。

**成果位置**：云函数 `cloudfunctions/ai/`（`index.ts` 入口与流水线、`config.ts` 环境变量、`errors.ts` 失败分类与文案、`http.ts` 带硬超时的 JSON POST 与通用超时、`providers.ts` 两种接口格式适配、`safety.ts` 内容安全适配层、`usage.ts` 用量记账与上限、`probe.ts` 微信接口探测、`config.json` 云调用权限声明、`package.json`）。测试 `tests/ai-providers.test.cjs`、`tests/ai-safety.test.cjs`、`tests/ai-flow.test.cjs`、`tests/ai-bundle.test.cjs` 与夹具 `tests/ai-harness.cjs`。文档见 [云开发文档](../../cloud-development.md) 的「AI 云函数」一节（调用契约、数据模型、环境变量表、失败文案表、探测记录表、人工步骤）。

- [x] 云函数侧提供统一的模型调用入口，密钥来自云函数环境变量，不落在代码、数据库或小程序包里（**本地完成**：入口只从 `process.env` 取密钥；记录与返回值都不含密钥；`tests/ai-bundle.test.cjs` 断言小程序包与云函数产物无密钥、依赖只有 `wx-server-sdk`。云端检查见人工步骤 E）
- [x] 单次调用有明确超时边界，超时后返回可识别的失败，不无限挂起（**本地完成**：`https.request` + 硬定时器 `destroy`，超时归入「模型不可用或超时」；**微信云调用与云存储下载同样套了硬超时**，第三方审核另有一层兜底定时器；测试断言 60ms / 1 秒边界内结束且连接被主动关闭）
- [x] 每次调用记录耗时与用量，可查询累计用量（**本地完成**：`ai_usage_records` 每次子调用一条，`ai_usage_monthly` 按月累加，`{"action":"usage"}` 查询；服务端缺 usage 时按字符数估算并标记 `estimated`；接口根本不返回用量时标记 `usageUnknown` 并按可配置的每次固定价计）
- [x] **提供累计用量查询接口，并实现月度成本上限判定**：接近阈值告警、超过拒绝，阈值来自环境变量（**本地完成**：`AI_MONTHLY_CAP_YUAN` 默认 50、`AI_CAP_WARN_RATIO` 默认 0.8；单价同样来自环境变量 `AI_PRICE_INPUT_PER_MILLION` / `AI_PRICE_OUTPUT_PER_MILLION`）
- [x] **内容安全为可切换的适配层**：微信官方 `security.msgSecCheck` / `security.imgSecCheck` 云调用为主，同时支持第三方审核（OpenAI 与 Anthropic 两种接口格式）（**本地完成**：`AI_SAFETY_PROVIDER` 四档切换；第三方支持 chat 判定与 OpenAI `/moderations` 两种形态；文字与图片是两个独立入口）
- [x] **先探测未认证状态下微信内容安全接口是否可用并记录结论**（**已验证（2026-09-19）**：`security.msgSecCheck` / `security.imgSecCheck` 在**小程序端** v2 形态下均返回 `errcode 0`——未认证小程序可以调用官方云调用；结论已回填 [云开发文档](../../cloud-development.md#微信内容安全探测记录) 的探测记录表。**同一轮发现并修掉一个会误导决策的缺陷**：控制台触发返回的平台码 `-501001`（云调用未从小程序端触发）此前会被读成「微信接口不可用」并建议切第三方；现在探测记录带 `valid` / `invalidReason`，**无效测量不切换适配器**）
- [x] 文字内容安全检测可用；违规内容被拒绝并返回可与「调用失败」区分的结果（**本地完成**：违规 → `content_rejected`；检测服务不可用 → `internal`；两条路径都有测试）
- [x] 图片内容安全检测可用，接口与文字检测分开（**本地完成**：`moderateImage` 与 `moderateText` 分开，图片走 `imgSecCheck` 的 `media` 字段；vision 流水线保证「图片先检后送模型」；图片格式判断不出来按参数错误拒绝，不再默认 PNG）
- [x] 失败结果能区分三类，三类文案各自独立、不合并成一句（**本地完成**：`model_unavailable` / `content_rejected` / `quota_exhausted` + 两类辅助分类；测试断言三类文案两两不同且有独立环境变量可改措辞；**402 归额度类、429 归模型不可用**，瞬时限流不会被说成「请下月再试」）
- [x] 端到端验证：一句测试文本经模型返回结果（**已验证（2026-09-19）**：`npm run smoke:ai` 从小程序端真实调用一次，返回 `ok=true`、模型输出「链路已通」、`elapsedMs=4600`；内容安全走微信官方适配器 `provider=wechat checked=true passed=true errcode=0`；用量 105 token 已记账、当月累计可查。耗时 4.6 秒同时证明**超时已改到 20 秒**、`-504003` 截断不再出现。原始输出见 [Ticket 01 端到端冒烟记录](../evidence/p5-foundation/README.md)）
- [x] **全过程无密钥外泄：数据库侧抽查一次**（**已验证（2026-09-19）**：控制台打开 `ai_usage_records` 抽查一条真实记录，字段为 `_id / action / completionTokens / costYuan / createdAt / durationMs / estimated / failureClass / feature / kind / model / month / ok / promptTokens`，**没有任何密钥字段，也搜不到密钥值**；小程序包与云函数产物侧由 `tests/ai-bundle.test.cjs` 断言，见人工步骤 E）
- [x] 第三方中转不可用时，调用方拿到的是可处理的错误而不是未捕获异常（**本地完成**：入口不抛异常，连接失败/超时/5xx/非 JSON/空内容都收敛成分类失败；测试覆盖 ECONNREFUSED 与永不响应两种形态）
- [x] `npm run typecheck`、`npm test` 通过（**本地完成**：typecheck 两份配置均无错误；`npm test` 296 项全过（2026-09-19 复跑为 **297 项全过、0 失败**，含 #34/#35 的回归项），其中本票 81 项）

## 本地验证（2026-09-18，全部为桩驱动，无网络、无密钥）

- `npm run typecheck`：`tsc --noEmit`（小程序）+ `tsc --noEmit -p cloudfunctions/tsconfig.json`（云函数）均通过，无输出。
- `npm test`：先构建再跑 `tests/*.test.cjs`，**296 项全过、0 失败**；其中本票 81 项——适配器请求/响应映射 12 项、内容安全适配层 16 项、入口流水线 46 项、构建布局与密钥 7 项。
- 覆盖的关键行为：两种接口格式的请求体与返回映射（含多模态分块与 usage 字段差异）；超时边界与网络错误分类（模型、微信云调用、云存储下载、第三方审核四条路径）；三类失败的分类与文案独立性（402 与 429 分开）；上限的告警与拒绝、上限来自环境变量；用量记账（含缺 usage 时的估算、接口不返回用量时的 `usageUnknown` 与固定价、失败调用也记账）；**月度累加只自增不覆盖**（update 失败保留累计、首次插入用固定 `_id`、并发两次调用不丢计数）；`checked` 标志（真的检过 / off / fail-open / 长文本只检一部分）；**输入检测覆盖 system 与 assistant 消息**、长文本逐段送检；图片先过检测再送模型、图片参数与大小上限、格式无法判断时按参数错误拒绝；未知消息角色按参数错误拒绝；第三方审核切换后不调用微信接口；微信检测不可用时的 fail closed 与 fail open；探测动作的三种结论与探测超时；**平台码（`-501001` / `-501007`，云调用未从小程序端触发）判为无效测量、不切换适配器**；构建布局与「AI 不进小程序包」。
- 未覆盖的部分（**仍需在云上验证**）：真实模型调用（`npm run smoke:ai`，等控制台把超时改成 20 秒）、云函数**超时**配置、真实密钥不外泄检查。真实微信内容安全调用与云函数部署已由 2026-09-19 的云端记录覆盖（见下）；**2026-09-19 复核**：真实模型调用、超时配置、数据库侧密钥抽查均已补上（见「人工步骤当前状态」），仍未覆盖的是 `vision`（截图识别）路径的真实调用与月度上限拦截实测。

## 人工步骤

见 [云开发文档](../../cloud-development.md) 的 [Ticket 01 人工步骤](../../cloud-development.md#ticket-01-人工步骤)：A 部署 `ai`、B 建集合与配环境变量、C 确认超时与内存、D 跑微信内容安全探测并回填记录、E 端到端验证与密钥外泄检查、F 核对月度上限真的会拦。每步都写了动作 / 对象 / 判据。

**人工步骤当前状态（2026-09-19 复核）**：A / B / C / D / E 已完成——C 的超时已由负责人改成 20 秒并被 4600ms 的端到端调用证明未被截断；**内存也随本次日志核实**：控制台函数日志出现 `Memory: 256MB MemUsage: 37.4MB`（`timetable` 函数的日志行，同环境函数配置一致），记为 **256MB**；E 的数据库侧抽查确认 `ai_usage_records` 无密钥字段。**只剩 F（月度上限拦截实测）**，另 `vision` 路径的真实调用未跑。

## 按配置可改的默认值（票面未指定，本票选的默认，需负责人认可或调整）

| 项 | 默认 | 改法 |
| --- | --- | --- |
| 模型接口格式 | OpenAI 兼容（`AI_PROVIDER=openai`）——**选它是待验证的假设**：项目按中转接入，但中转实际返回的格式与模型名**未实测**，联调后回填结论 | 环境变量 |
| 内容安全适配器 | `wechat`（微信官方为主，负责人的定案） | `AI_SAFETY_PROVIDER`（`off` 仅开发/排障） |
| 检测服务不可用时的处置 | `closed`：拒绝调用，绝不假装已检测 | `AI_SAFETY_FAIL_MODE`（`open` 仅开发/排障） |
| 微信 `suggest=review` | 按拒绝处理（fail closed） | `AI_SAFETY_REVIEW_AS` |
| 三类失败的用户文案 | 见 [云开发文档](../../cloud-development.md#失败分类与默认文案) 的表；措辞偏中性、每类末尾给出下一步 | `AI_MSG_*` 环境变量 |
| 单次模型超时 / 单次云函数总截止 | 8 秒 / 15 秒（云函数超时按 20 秒） | `AI_TIMEOUT_MS` / `AI_TOTAL_DEADLINE_MS` |
| 内容安全与云存储下载的单次超时 | 审核与微信云调用 6 秒、云端文件下载 5 秒 | `AI_SAFETY_TIMEOUT_MS` / `AI_DOWNLOAD_TIMEOUT_MS` |
| 单价 | 1 元 / 4 元每百万 token（AI 资讯实测的 **DeepSeek 官方**空闲时段价；中转单价未实测） | `AI_PRICE_*`，**必须按中转实际价格改** |
| 每次审核的固定价 | 0（不计入金额，但记录带 `usageUnknown` 并告警） | `AI_SAFETY_CALL_PRICE_YUAN` |
| 告警线 | 上限的 80% | `AI_CAP_WARN_RATIO` |
| 图片大小上限 | 1MB（与微信 `imgSecCheck` 限制对齐） | `AI_MAX_IMAGE_BYTES` |
| 第三方审核的调用方式 | 复用模型配置，用「审核判定」提示词读回 JSON；OpenAI 侧可切 `/moderations` | `AI_SAFETY_OPENAI_MODE` |

## 本票的取舍与已知限制

- **第三方内容审核没有统一标准接口**：OpenAI 有 `/moderations`，Anthropic 没有对应端点。本票的做法是「用各自的接口格式发一个审核提示词、读回 `{"allowed":bool}`（OpenAI 侧可选官方 `/moderations`）」，这样任何兼容中转都能用。规格只要求「支持两种接口格式」，具体做法是票面未指定的部分，若负责人另有指定服务，只需新增一个适配器分支。
- **探测只证明「接口可调用」**：不发违规文本是刻意选择（不制造违规内容），因此「违规会被拦」由官方错误码表与桩测试覆盖，不是探测结论。**2026-09-19 实测**：未认证小程序可以调用官方云调用（两条接口 `errcode 0`），原先「未认证 → 48001」的假设**没有成立**；48001 对应的真实条件仍未实测。**同一轮新增一条已实测的平台约束**：云调用必须由小程序端触发，控制台 / CLI / HTTP 触发都会拿到 `-501001`（见探测记录表与 `npm run probe:wechat`）。
- **`invalid_request` 与 `internal` 是新增的两类失败**：规格只要求三类用户可见失败可区分，这两类是调用方参数错误与内部错误的补充分类，文案同样独立、不与他人合并。
- **用量读失败时拒绝调用**（fail closed）：读不到月度用量就无法判断上限，宁可挡住也不静默超支；只有「当月文档不存在」按零处理。
- **检测超时归入「模型不可用或超时」**：检测没做完与「检测配置错」不是一回事，前者可重试、后者要改配置；两类都在 fail closed 下拒绝调用，不会放未检内容过去。
- **`off` / fail-open 是逃生口**：两者都会让 `checked=false` 并进 `warnings`，生产不得使用；默认值 `wechat` + `closed` 才是规格要求的「文字与图片都过内容安全」。
- **`AI_MODEL` 没有代码默认值**：中转（CommandCode）的模型名无公开依据，猜一个默认值只会让错误延后暴露；`AI_BASE_URL` / `AI_API_KEY` 同理。「中转也是 OpenAI 兼容格式」**未实测**。
- **`ai_usage_records` 保留策略未定**：按实测单价，50 元约合 1.6 万次调用，量级可控，清理策略等真实调用量出来再定。

## 复核修复记录（2026-09-18，两轴代码复核）

按严重度从高到低修复了 11 项，行为差异与覆盖测试如下：

| # | 问题 | 修复 | 测试 |
| --- | --- | --- | --- |
| 1 | 月度用量会被覆盖（`try{update}catch{}` 后无条件 `set`），成本上限失真 | 只在确认「文档不存在」（抛缺失错误或 `updated: 0`）时插入；用固定 `_id` 插入初值以避免并发各写一份；其它写失败向上抛出并记为 `warnings` 里的可处理失败 | 入口流水线 5 项：update 失败保留累计、首次插入、并发两次调用、SDK 不回计数、`updated: 0` |
| 2 | 微信内容安全调用与云存储下载没有超时 | 新增通用硬超时 `withTimeout`；微信云调用、第三方审核、云存储下载都套上；超时归入 `model_unavailable`（可重试） | 入口流水线 3 项 + 内容安全 2 项：微信不响应、下载不响应、探测不响应、第三方不响应、`timedOut` 标记 |
| 3 | 402 与 429 被合并成「额度用尽，请下月再试」 | 402 → `quota_exhausted`；429 → `model_unavailable`（可重试措辞）；三类数量与名字不变 | 适配器 2 项（分类 + 429 的实际链路） |
| 4 | fail-open / `off` 返回 `passed: true`，调用方会读成「已检测通过」 | `SafetyReport` 加 `checked`；跳过与部分检测一律 `checked: false` + 写明原因与模式，并进 `warnings`；文档把 `off` / fail-open 标为仅开发/排障 | 流水线 3 项 + 内容安全 3 项 |
| 5 | 只检查 user 角色文字；超长文本只检前一段却仍 `passed: true` | 输入检测覆盖 `system` 事件字段与全部消息角色；长文本逐段（2000 字窗口、最多 2 万字）送检，超出部分写明范围并 `checked: false` | 流水线 4 项 |
| 6 | `/moderations` 用量记为 null → 成本记 0 元 | 记录带 `usageUnknown`；金额按 `AI_SAFETY_CALL_PRICE_YUAN`（每次固定价）计或标记不计入；返回值告警写明计价方式 | 流水线 2 项 + 内容安全 1 项 |
| 7 | 文档/测试/代码不一致（`AI_SAFETY_FORMAT`、执行顺序、`usage` 的 `message` 契约） | 删掉不存在的 `AI_SAFETY_FORMAT`（文档与测试）；改写执行顺序（含 `usage` 只读不拦、vision 先图后文、超时边界）；`message` 契约改为「成功为空串」，上限告警走 `capWarning` | 流水线 1 项（查询接口 `message` 为空、告警在 `capWarning`） |
| 8 | `mimeFromFileID` 默认 PNG、未知 role 强制成 `user` | 两者都改成明确拒绝并给出可读错误（要求显式 `mimeType` / 合法 role） | 流水线 2 项 |
| 9 | 未核实的措辞当成事实 | 「中转也是 OpenAI 兼容格式」「48001 与未认证的因果关系」等改成「未实测，探测/联调后回填」 | 无（文档与注释） |
| 10 | 三类失败、上限与告警只写在云开发文档 | 补进 `CONTEXT.md` 术语表，便于 05/06/07 按同一套词汇消费 | 无（文档） |
| 11 | 重复实现（`invokeWechat`、拒绝串、`/moderations` 传输） | 探测复用 `safety.invokeWechat`；拒绝串统一走 `rejectionDetail`；`/moderations` 与模型调用共用 `providers.requestJson` | 由既有测试间接覆盖 |

## 云端收尾与探测路径修复（2026-09-19）

**云端进度**：`ai` 已部署（Active / Nodejs16.13，11 个文件 / 42.4 KB）；两个用量集合与模型环境变量已就绪（`usage` 返回 `capYuan 50`、告警线 40、`AI_PRICE_*` = 0.25 元/百万 token、当月 15 条子调用记录 / 0 token / 0 元）。**唯一阻塞项是超时**：仍是默认 3 秒，`npm run smoke:ai` 实测被 `-504003 Invoking task timed out after 3 seconds` 打断；控制台改成 20 秒（`newsSync` 已是 20 秒）后重跑步骤 E / F。

本轮修掉的缺陷（由「负责人按原步骤 D 从控制台跑探测」暴露）：

| # | 问题 | 修复 | 测试 |
| --- | --- | --- | --- |
| 1 | **平台错误码被当成接口结论**：控制台触发探测时两条接口返回 CloudBase 的 `-501001`（`INVALID_WX_ACCESS_TOKEN`，官方口径「云调用鉴权失败，未从小程序端触发使用云调用的云函数」），而代码把它读成「微信官方内容安全接口不可用」并建议切第三方适配器——照此改配置会白配一套第三方审核密钥，并把「没测到」写成「不可用」 | 错误码表补 `-501001` / `-501007` 并写明「必须由小程序端触发」；探测记录新增 `valid` / `invalidReason`，**无效测量一律不切换适配器**（`recommendedProvider` 保持 `wechat`），结论与 `message` 以「本次探测无效」开头；单条 `note` 给出重跑命令 | 入口流水线 2 项（`-501001`、`-501007`）+ 错误码表 3 条措辞断言 |
| 2 | **人工步骤 D 给出的验证路径本身测不出结论**：控制台「测试」页没有小程序侧云调用票据，探测**必然**失败；同理步骤 E 的 `chat` 也会在内容安全这一步失败（默认适配器 `wechat` 就是云调用），步骤 B 的 `usage` 反而可以 | 新增小程序端入口 `npm run probe:wechat`（探测）与 `npm run smoke:ai`（端到端），都用 automator `evaluate` → `wx.cloud.callFunction`；人工步骤按「哪些动作能在控制台测、哪些必须从小程序端测」重写 | 无（脚本需要开发者工具环境；判据由下面的实测给出） |

实测记录（2026-09-19，UTC+8；原始记录在 `artifacts/verify/ai-probe.json` 与 `ai-smoke.json`）：

| 调用方式 | 动作 | 结果 |
| --- | --- | --- |
| 控制台「测试」页 | `probe` | `-501001` × 2 → `probe.valid: false`（修复前会被读成「接口不可用」） |
| 小程序端 | `probe` | `errcode 0` × 2（544ms / 458ms），带 openid（v2 形态）→ `probe.valid: true`、`recommendedProvider: wechat` |
| 小程序端 | `chat` | `-504003`（函数超时 3 秒）→ 待控制台把超时改成 20 秒 |
| 小程序端 | `usage` | `ok: true`，`capYuan 50`、告警线 40、单价 0.25 元/百万 token |
