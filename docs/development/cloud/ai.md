# AI 云函数：调用、安全与成本

按主题拆分的配置与操作参考。带日期的探测和部署记录是历史快照；执行前按当前代码和控制台状态复核。

[当前状态](../../status.md) · [云开发总览](README.md)

## AI 云函数（Ticket 01：统一调用入口、内容安全、用量与成本上限）

**状态（2026-09-19 更新）**：函数代码、桩测试与构建布局检查已完成并本地通过（`cloudfunctions/ai/`，逐项见 [Ticket 01](../../tasks/tickets/01-ai-foundation.md)）。**两轴代码复核（Standards + Spec）提出的问题已在本轮修复**：月度累加不再被写失败覆盖、「是否有过检测」用 `checked` 明确标出、内容安全与云存储下载都有硬超时、402 与 429 分开、输入检测覆盖全部消息角色且长文本逐段检。**云端侧（2026-09-19）**：函数已部署、两个用量集合与模型环境变量已配；微信内容安全探测在**小程序端**跑通（两条接口 `errcode 0`，记录见下「微信内容安全探测记录」）；**超时已改到 20 秒且端到端已跑通**——`npm run smoke:ai` 返回 `ok=true`、模型输出「链路已通」、`elapsedMs=4600`，用时超过 3 秒而未被截断，故 20 秒配置确实生效（原始输出见 [Ticket 01 端到端冒烟记录](../../evidence/p5-foundation/README.md)）。**数据库侧无密钥外泄**：控制台抽查 `ai_usage_records` 真实记录只有用量字段；**云函数内存核实为 256MB**（日志 `Memory: 256MB MemUsage: 37.4MB`）。**2026-09-19 复测更正**：步骤 F（月度上限拦截）已由负责人确认完成；**`vision`（图片路径）真实调用经独立复测未通过**——三张真实课表截图 + 一张 570 字节合成小图全部在 8000ms 处超时（`failureClass=model_unavailable`、`AI_VISION_MODEL=qwen/qwen3.8-flash`），文本 `chat` 同时正常。复测入口 `npm run smoke:ai:vision`，候选修复与判据见本节「Ticket 01 人工步骤」。

这一层是 05（课表截图识别）、06（课表助手）、07（部门问答）的共同前置：三处都只调这一个函数，避免各自重复实现「调模型 + 过内容安全 + 失败降级」。**本票不实现三个 AI 功能本身。**

### 动作与调用契约

云函数名 `ai`。事件与返回的字段就是 05/06/07 要依赖的接口，改动等于改动三处调用方。

| 事件字段 | 取值 | 说明 |
| --- | --- | --- |
| `action` | `chat` / `vision` / `moderateText` / `moderateImage` / `usage` / `probe` | 必填 |
| `feature` | 如 `department-qa`、`advancement-qa`、`timetable-screenshot`、`timetable-assistant` | 只用于记账与统计，未知值不影响调用；**`advancement-qa` 例外**：它会触发升学问答的服务端约束（见下文「升学问答的服务端约束」） |
| `system` | string | 系统提示词（可选）；**同样要过内容安全**（属于调用方送进来的文本）。没有单独的字符上限，但被下面的**输入总量上限**覆盖：`system` 自己超窗同样按 `invalid_request` 拒绝 |
| `messages` | `[{"role":"user"｜"assistant"｜"system","text":"..."}]` | 非空数组、最多 20 条；`role` 必填且只接受这三个值（写错返回 `invalid_request`，不会默认当成 `user`）；`content` 可作 `text` 的别名；单条 ≤8000 字；**与 `system` 拼起来 ≤20000 字**（一次内容安全检测的覆盖上限，超出即 `invalid_request`） |
| `text` | string | `moderateText` 用（管理员限定的诊断动作）；按 2000 字窗口逐段检测（最多 10 片 = 2 万字），超出部分在报告里写明并置 `checked: false`——**只有这个动作允许不完整检测**，`chat` / `vision` 的输入超窗直接拒绝、输出超窗不返回内容 |
| `image` | `{"fileID":"cloud://..."}` 或 `{"base64":"...","mimeType":"image/png"}` | `vision` / `moderateImage` 用；只接受 PNG / JPG，默认上限 1MB。**格式不再靠猜**：fileID 的扩展名认不出、base64 没给 `mimeType` 都返回 `invalid_request`。客户端走 fileID：`wx.cloud.uploadFile` 返回的 `cloud://…` 才叫 fileID，`prepareUpload` 给的裸 cloudPath 不是（传裸路径会被 `downloadFile` 拒绝） |
| `maxTokens` / `timeoutMs` | number | 可选覆盖；`timeoutMs` 仍受环境变量上限约束。**分带时 `maxTokens` 会被服务端按本带课程数抬高**（见下一行的 `bands`）：按整张表设的上限装不下较大的带，沿用会把那一带截断，而截断的 JSON 看起来像模型失败 |
| `bands` | `'auto'` 或 ≥2 的整数 | 仅 `vision` 用，可选。按**节次**把整张课表切成若干带、**并行**调用模型，解决「一次调用识别整张表要 170 秒 > 云函数 60 秒上限」：`'auto'` 让服务端按自己的超时预算与实测画像算带数（客户端固定下发它）；数字指定带数，上限 6。**缺省、1、负数与非数字一律退回单次调用的原路径**（数字字符串不接受，不猜）；预算连一次调用的固定开销都装不下时也退回单带——切多了只是同样的失败乘以带数。**带数越多，模型调用次数与成本按倍数增长**（一次 `vision` 会记 N 条模型账，见「成本」一节），**内容安全检测次数不变** |

返回形状所有动作统一，调用方只需要看前三个字段：

| 字段 | 说明 |
| --- | --- |
| `ok` | 是否完成。**入口不抛异常**：中转挂掉、超时、参数写错都返回 `false` |
| `failureClass` | `model_unavailable` / `content_rejected` / `quota_exhausted` / `invalid_request` / `internal` / `citation_unverified`；成功为空串 |
| `message` | 用户可见文案；**成功时为空串**（`usage` 的上限告警在 `capWarning`，`probe` 的结论在 `message` 与 `probe.conclusion`） |
| `text` | `chat` / `vision` 成功时的模型输出 |
| `detail` | 维护者排查细节（密钥已剔除） |
| `usage` / `usageSummary` / `capWarning` | 本次用量 / 当月累计 / 接近上限的告警 |
| `safety` / `probe` / `warnings` | 检测结论（含 `checked`）/ 探测记录 / 非致命告警（如记账失败、`checked=false`） |

`usage` 动作只读不拦（已超上限也要能查），其余动作的执行顺序是：

**读当月用量 → 月度上限判定 → 输入内容安全 → 模型调用 → 输出内容安全**。
`vision` 的输入检测**先图后文**（图片先过 `imgSecCheck` 再送模型）；`moderateText` / `moderateImage` 也先判上限再检测。
超上限时一次外部请求都不发（连内容检测都不发）；图片被拒时不会送模型（Ticket 05 的硬要求）。

**超时边界**：模型调用、第三方审核、**微信云调用与云存储下载**都有硬超时（见环境变量表），
任一步超时都在 `AI_TOTAL_DEADLINE_MS` 之内以可识别的失败结束，不会无限挂起。
其中检测类调用超时归入「模型不可用或超时」（可重试），与配置/权限类的 `internal` 区分开。

### 数据模型（两个新集合）

| 集合 | 内容 | 客户端权限 |
| --- | --- | --- |
| `ai_usage_records` | 每次子调用一条：`requestId`、`feature`、`kind`（`model` / `moderation`）、`provider`、`model`、`ok`、`failureClass`、`durationMs`、`promptTokens`、`completionTokens`、`totalTokens`、`estimated`、`usageUnknown`、`costYuan`、`month`、`createdAt` | 不对客户端开放（预设「所有用户不可读写」） |
| `ai_usage_monthly` | 每月一条汇总文档（`_id` 为东八区月份，如 `2026-09`）：`calls`、`failures`、三种 token 合计、`costYuan`、`updatedAt`；同集合的 `accounting-gate:<月份>` 文档是收费调用的闸门 | 不对客户端开放 |

- `usage` 动作、上限判定都读 `ai_usage_monthly`；读不到用量（数据库故障）时**拒绝调用**而不是当作零——上限判断不能因为读失败而失效。只有「文档不存在」（当月首次调用）才按零处理。
- **月度汇总只允许两种写法**：原子自增，或当月文档不存在时用固定 `_id` 插入初值。写失败（非「文档不存在」）一律**向上抛出并记为可处理的记账失败**（返回值 `warnings` 里能看到），绝不回退成覆盖式写入——那会把当月累计冲成单次调用的数字，使成本上限失效。首次插入用月份作 `_id`：并发下只有一个能插入，另一个回到自增，因此不会各写一份丢计数。
- **本地待部署修复（2026-09-27）**：收费动作在上限判断前，按 `month` 计数 `ai_usage_records`。若记录数大于月度汇总的 `calls`，说明至少一笔已落记录没有计入汇总，后续 AI 调用按 `internal` 暂停；维护者须先核对记录与汇总并修复账目。`usage` 查询仍可读汇总，但该数字在漏记修复前不能当成真实总成本。记录集合若日后清理，必须同时设计核对口径。
- **明细写入本身失败的兜底**：在读取汇总、判断上限及调用外部模型前，先在 `ai_usage_monthly` 以固定 `_id` 创建当月闸门；同月同一时刻只允许一笔收费请求。全部子调用记账成功才删除闸门；任一记录或汇总写失败、函数意外退出或删除闸门失败时，后续请求停止，维护者需核对第三方账单、明细与汇总后再清理闸门。此做法以并发吞吐换取故障时的成本边界，未在云端验证。
- 服务端不返回 usage 时按字符数估算（中文 1 token/字、英文 4 字符/token，图片按固定常数），并标记 `estimated: true`；不估算等于把成本记成 0。
- **一次用户动作未必只有一条模型记录**：`vision` 分带并行时按带数各记一条（`requestId` 相同、`feature` 相同），
  返回值 `usage` 是各带的合计。因此 `ai_usage_monthly.calls` 统计的是**子调用次数**，不能当成「用户操作次数」；
  按 `feature=timetable-screenshot` 查成本时要按 `requestId` 聚合，否则会把一次识别读成多次。
- **接口根本不返回用量时**（OpenAI `/moderations`）既不算 0 元也不编 token 数：记录里 `usageUnknown: true`、`totalTokens: 0`，金额按 `AI_SAFETY_CALL_PRICE_YUAN`（每次审核固定价，默认 0 表示不计入）计，返回值 `warnings` 写明这一次是怎么记的。
- 两个集合需要人工在控制台创建（见人工步骤 B）。当前修复开始按 `month` 计数记录；部署时核对该查询的耗时，并按实际数据量为 `ai_usage_records.month` 建单字段索引。月度汇总仍按 `_id` 直读。

### 环境变量（密钥只在这里）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AI_PROVIDER` | `openai` | 模型接口格式：`openai`（本项目的中转）/ `anthropic` |
| `AI_BASE_URL` | 无（必填） | OpenAI 兼容接口根地址，**中转的实际地址以服务商为准** |
| `AI_API_KEY` | 无（必填） | 模型密钥；不写进代码、数据库、小程序包与文档 |
| `AI_MODEL` | 无（必填） | 文本模型名；**中转的模型名未实测**（AI 资讯实测用的是官方 `deepseek-flash`），按服务商实际值填 |
| `AI_VISION_MODEL` | 取 `AI_MODEL` | 多模态模型名。**当前部署值待与负责人核对：2026-09-20 实测冒烟返回的 `model` 是 `deepseek/deepseek-v4.1-flash`**（不再是画像测量时的 `qwen/qwen3.8-flash`），因此 `cloudfunctions/ai/vision.ts` 的画像常数描述的是旧模型，`bands: 'auto'` 会偏保守多切带 |
| `AI_ANTHROPIC_BASE_URL` / `AI_ANTHROPIC_API_KEY` / `AI_ANTHROPIC_VERSION` | `https://api.anthropic.com` / 无 / `2023-06-01` | 走 Anthropic 格式时需要 |
| `AI_TIMEOUT_MS` | `8000` | 单次模型调用超时（毫秒），必须 ≤ `AI_TOTAL_DEADLINE_MS` |
| `AI_TOTAL_DEADLINE_MS` | `15000` | 一次云函数调用的总截止；模型、内容安全、云存储下载都受它约束，**必须小于云函数超时时间**（部署时按 20 秒设置） |
| `AI_DOWNLOAD_TIMEOUT_MS` | `5000` | 云存储下载（`vision` 的 fileID 路径）单次超时；下载同样会一直不返回，超时归入「模型不可用或超时」 |
| `AI_MAX_TOKENS` / `AI_TEMPERATURE` | `1024` / `0.2` | 默认生成参数 |
| `AI_EXTRA_BODY_JSON` | 空 | 追加进请求体的 JSON，如关闭思考模式：`{"chat_template_kwargs":{"thinking":false}}`（AI 资讯实测记录该模型默认开启思考、输出 token 偏高，未测关闭后的降幅） |
| `AI_PRICE_INPUT_PER_MILLION` / `AI_PRICE_OUTPUT_PER_MILLION` | `1` / `4` | 单价（元/百万 token）。默认值是实测的 DeepSeek **官方**空闲时段价（不是中转价）；**中转的实际单价未实测**，请按实际单价配置，否则上限判断偏低 |
| `AI_MONTHLY_CAP_YUAN` | `50` | 月度成本上限（规格定案值）；达到即拒绝调用 |
| `AI_CAP_WARN_RATIO` | `0.8` | 告警线比例：达到 `上限 × 比例` 起在返回值里带 `capWarning`，但不拦 |
| `AI_MODERATE_OUTPUT` | `true` | 是否对模型输出做内容安全检测 |
| `AI_MAX_IMAGE_BYTES` | `1048576` | 图片大小上限；默认与微信 `imgSecCheck` 的 1MB 限制对齐，Ticket 05 的截图需先压缩 |
| `AI_SAFETY_PROVIDER` | `wechat` | 内容安全适配器：`wechat` / `openai` / `anthropic` / `off`。**`off` 是仅开发与排障使用的逃生口，生产不得使用**（规格把「AI 文字与用户图片都要过内容安全」列为硬约束）；用它时报告 `checked:false` 并进 `warnings` |
| `AI_SAFETY_FAIL_MODE` | `closed` | 检测服务不可用时：`closed` 拒绝调用（默认）/ `open` 放行并在报告里写明「未检测」且 `checked:false`。**`open` 同样仅限开发与排障，生产不得使用** |
| `AI_SAFETY_REVIEW_AS` | `reject` | 微信 `suggest=review`（需人工复审）的处置：默认按拒绝 |
| `AI_SAFETY_OPENAI_MODE` | `chat` | 第三方审核的调用方式：`chat`（用审核提示词，任何兼容中转可用）/ `moderations`（走 OpenAI 官方 `/moderations` 接口读 `results[0].flagged`）。**接口格式由 `AI_SAFETY_PROVIDER` 决定**（选 `anthropic` 就用 Anthropic 格式），没有单独的 `AI_SAFETY_FORMAT` 开关 |
| `AI_SAFETY_BASE_URL` / `AI_SAFETY_API_KEY` / `AI_SAFETY_MODEL` | 取模型配置 | 第三方审核的地址、密钥、模型（默认复用模型配置） |
| `AI_SAFETY_TIMEOUT_MS` | `6000` | **访问微信云调用与第三方审核的单次超时**（毫秒）；第三方审核另有一层同值 +1 秒的兜底定时器。超时归入「模型不可用或超时」（可重试） |
| `AI_SAFETY_CALL_PRICE_YUAN` | `0` | 每次审核调用的固定价（元）：接口不返回 token 用量时（`/moderations`）按它记账；`0` 表示不计入金额，但记录会带 `usageUnknown: true` 且返回值有告警 |
| `AI_SAFETY_MAX_TOKENS` / `AI_SAFETY_SCENE` | `256` / `1` | 审核最大输出 token、微信 `msgSecCheck` 的 scene（1 资料 / 2 评论 / 3 论坛 / 4 社交日志） |
| `AI_MSG_MODEL_UNAVAILABLE` / `AI_MSG_CONTENT_REJECTED` / `AI_MSG_CONTENT_REJECTED_IMAGE` / `AI_MSG_QUOTA_EXHAUSTED` / `AI_MSG_INVALID_REQUEST` / `AI_MSG_INTERNAL` / `AI_MSG_CITATION_UNVERIFIED` | 见下表 | 覆盖用户可见文案，**改措辞不用改代码**；`AI_MSG_CONTENT_REJECTED_IMAGE` 只覆盖「用户上传的图片被拒」这一种输入（05 截图路径），缺省时不回落到图片专属文案而是用 `AI_MSG_CONTENT_REJECTED` |

### 失败分类与默认文案

三类是开发规格要求「可区分、各自独立、不合并成一句」的失败；后两类是调用方与内部错误，同样各自成句。

| `failureClass` | 默认文案（可被上表环境变量覆盖） | 触发条件 |
| --- | --- | --- |
| `model_unavailable` | AI 模型暂时不可用或响应超时，请稍后重试；已保存的课表与部门资料仍可正常查看。 | 连接失败、超时（模型 / 内容安全 / 云存储下载都算）、5xx、鉴权失败、返回非 JSON 或空内容、**429 瞬时限流** |
| `content_rejected` | 文字：内容未通过安全检测，请修改后重试。／图片（`vision` / `moderateImage` 的输入图被拒）：这张图片没有通过内容安全检测，请换一张再试。 | 输入或输出被内容安全适配器判为违规（`risky` / `87014` / `flagged` / `allowed=false`）。**文案按输入类型区分**：文字有「改一改再试」的余地，图片只能换一张；两句话各自独立，可分别用 `AI_MSG_CONTENT_REJECTED` / `AI_MSG_CONTENT_REJECTED_IMAGE` 覆盖 |
| `quota_exhausted` | 本月 AI 使用额度已用尽，暂时无法使用 AI 功能，请下月再试或联系维护者。 | 当月累计成本 ≥ `AI_MONTHLY_CAP_YUAN`，或模型服务返回 **402**（服务商额度/余额不足） |
| `invalid_request` | AI 请求参数不正确，请重试；若反复出现请联系维护者。 | 动作、消息角色、图片参数不合法（含图片超限、格式不支持、格式无法判断）；**`system` 与全部消息拼起来超过 `MAX_INPUT_CHARS`（2 万字）**——窗口外的文字测不到，直接拒绝，不消耗检测配额也不进模型 |
| `internal` | AI 服务内部错误，请稍后重试。 | 配置缺失、用量读不到、内容安全检测不可用（fail closed，配置/权限类原因）等；**模型输出超过 `MAX_OUTPUT_CHARS`（4 万字）**——本地检不完全部输出，丢弃该回答而不是上屏未检测内容（模型这次是成功返回的，故不归 `model_unavailable`） |
| `citation_unverified` | 这条回答没能核对上官方原文的出处，已改为展示检索到的原文摘录。 | **升学问答专用**：模型正常返回，但回答里含日期/数字/条件的句子**核不到所引段落的出处**（见「升学问答的服务端约束」）。这时**不返回模型答案**（`text` 为空），调用方降级为本地原文摘录。与「模型不可用」分开是因为下一步不同：模型没坏，是这条回答没依据。改措辞用 `AI_MSG_CITATION_UNVERIFIED` |

**默认文案是可供负责人修改的默认值**，改法见上一节的环境变量；三类必需失败不得合并成一句（有测试锁定）。
**两处例外**：输入超窗与输出超限这两条在 `fail(..., { message })` 里带了固定文案（「对话或材料太长，请精简后重试」／「回答过长已丢弃」），它们**优先于 `AI_MSG_INVALID_REQUEST` / `AI_MSG_INTERNAL`**——默认文案对这两种情况给不出可执行的下一步。改措辞要改代码（同 `access.ts` 的维护者拒绝文案）。
**429 与 402 必须分开**：429 是瞬时限流（可重试），说成「本月额度已用尽，请下月再试」会让用户白等一个月；只有 402 才归「额度或配额用尽」。

### 升学问答的服务端约束（`feature = advancement-qa`）

升学问答把「模型说的话有没有官方依据」放在服务端把关（实现 `cloudfunctions/ai/advancement.ts`，
逐字语料由 `scripts/build.mjs` 从 `docs/evidence/advancement-poc/corpus.json` 生成 `advancement-corpus.js` 随函数部署）。
调用方与其它 `chat` 的差别只有两个事件字段，以及一个额外的返回字段：

| 事件字段 | 取值 | 说明 |
| --- | --- | --- |
| `scope` | `{category, year, region}` | 本次适用范围，三个字段缺一不可。服务端按自己的语料复核：类别要在可信语料的类别里、年份要在该类别收录的年份里、地区要一致，任何一条不符按 `invalid_request` 拒绝 |
| `passageIds` | `string[]`，1~3 条 | 本次检索到的**段落 id**。调用方只给 id，**正文一律由服务端从自己那份语料取**——客户端传不了「官方原文」；id 不在语料里、与 scope 不符、重复或超上限都按 `invalid_request` 拒绝 |

| 返回字段 | 说明 |
| --- | --- |
| `advancement.scope` / `advancement.corpusVersion` | 本次生效的范围与语料版本（`adv-corpus-<12 位哈希>`，语料一改就变） |
| `advancement.sources[]` | 实际注入并用于引用的可信段落（含逐字引文、文号、发布主体、适用年份、原文链接） |
| `advancement.verified` / `advancement.refused` / `advancement.violations[]` | 出处校验结论：`verified` 不是 `true` 就**不能当官方结论上屏**；`refused` 表示模型自己回复「无法核实」；`violations` 是短代码（如 `s2:uncited_claim`、`s1:unsupported_number(30)`），不含回答正文 |

注入与校验顺序（都在模型之后、返回之前）：**输入检测 → 模型 → 输出检测 → 出处校验**。
校验规则（逐句）：

1. 除固定过渡语外，所有业务句**必须带 `[Sn]` 标记**，否则 `uncited_claim`；分号保留，避免切掉条件与列表标题；
2. 标记只能指向本次注入的段落（`unknown_marker`）；同句有多个标记时按并集核对；
3. 句中数字要在**所引段落的可核对字段**（段落正文 + 材料标题 + 文号 + 发布日期 + 适用年份）里找到：
   数量必须数值相等（`1.5万` = `15000`），日期仅允许相同写法或省略完整年份；禁止任意数字后缀匹配；
   否则 `unsupported_number(<该数字>)`——标记里带上具体数字，便于维护者定位（回答正文本身不返回）。
4. 数字初筛通过还不够：业务句必须对应所引正文的**完整原句**，只允许标点、空格、等值数量、适用年份重复/省略；保留主语、否定、条件、比较词和词序。否则 `unsupported_claim`。这是模型选句与排列的保守模式，不保证任意释义，不能证明语料本身正确或回答完整。
5. 校验不过 → `citation_unverified`，`text` 为空，调用方降级为本地原文摘录；只有完整固定短语「无法核实」（可带末尾句号）→
   `ok: true` + `refused: true`，同样由调用方决定怎么展示（产品页面仍列出原文，由学生自己核对）。

**语料缺失或格式不对时 fail-closed**：升学问答没有可信语料就按 `internal` 拒绝，
不退化成「凭模型常识回答」（部门动态语料的 fail-open 只适用于部门问答）。

### 内容安全适配层

- **文字与图片是两个独立入口**（`checkText` / `checkImage`）：微信侧本就是 `security.msgSecCheck` 与 `security.imgSecCheck` 两个云调用，第三方侧的请求体也不同。
- **检查范围**：`chat` / `vision` 会检**调用方送进来的全部文字**——事件顶层 `system`、每条消息（user / assistant / **system**）以及 `vision` 的图片，外加模型输出（`AI_MODERATE_OUTPUT`）。文字按 2000 字一片送检，**窗口 = 一次能检完的字数**，两侧处置不同（2026-09-28 修复，[内容安全审计 CT-01/CT-02](../../review/content-safety-audit-2026-09-27.md)）：
  - **输入侧**：`MAX_INPUT_CHARS = 2000 × 10 = 2 万字`（`system` 与全部消息拼起来算）。超出即 `invalid_request` 拒绝，**不消耗检测配额、不进模型、不下载图片**；返回值 `detail` 写明总字数与 system 字数，用户文案指向「精简或清空对话」。客户端 `miniprogram/services/ai.ts` 同源声明 `MAX_INPUT_CHARS`，并留更大余量按 `HISTORY_INPUT_BUDGET = 16000` 自剪最旧历史（服务端还会注入部门动态语料，实测最长约 380 字）。
  - **输出侧**：`MAX_OUTPUT_CHUNKS = 20`（4 万字）。输出先判长度，再分片**全检**；超过 4 万字按 `internal` 失败且**一个字都不返回**。输出长度不受调用方控制，所以这里不能像输入那样「提前拒绝」，只能是「检完才给」或「不给」。
  - 只有管理员限定的诊断动作 `moderateText` 保留「部分报告 + `checked: false`」：它不喂模型也不上屏。**两条通路都不再产生「窗口外文字照常流通」的行为**——修复前它们会带着 `checked=false` 放行。
- **`checked` 与 `passed` 是两件事**：`passed: true` 只表示「检过的范围内没发现问题」，`checked: false` 表示这次**没有真正检测**（`AI_SAFETY_PROVIDER=off`、`AI_SAFETY_FAIL_MODE=open` 放行未检内容、或长文本只检了前一段）。`checked: false` 时返回值同时会带一条 `warnings`，调用方与日志都不得把「跳过」读成「干净」。
- **微信为主**：拿到调用上下文 openid 时用 `msgSecCheck` v2（带 `version: 2`、`scene`、`openid`，判 `result.suggest`）；没有 openid 退回 v1 形态，判 `errcode`。违规可能以 `errcode 87014` 返回或抛出，两者都按违规处理。**2026-09-19 从小程序端实测：v2 形态下两条接口都返回 `errcode 0`**（记录见探测记录表）。
- **云调用必须由小程序端触发（2026-09-19 实测到反例）**：云调用要求调用方带上小程序侧的票据；控制台「测试」页、CLI、HTTP 触发、云函数互调都拿不到它，**必然**返回 `-501001`（CloudBase `INVALID_WX_ACCESS_TOKEN`，官方口径原文「云调用鉴权失败，未从小程序端触发使用云调用的云函数」）。因此**凡是要过内容安全的动作（`probe` / `chat` / `vision` / `moderateText` / `moderateImage`）都不能用控制台「测试」页验证**——那样测出的是触发方式不对，不是接口不可用；`usage` 不碰内容安全，控制台与小程序端都可测。小程序端的执行入口：`npm run probe:wechat`（探测）、`npm run smoke:ai`（文本端到端）、`npm run smoke:ai:vision`（图片路径端到端）、`npm run probe:ai-window`（检测窗口：超长输入拒绝与长输出全检，见下节）。
- **内容安全接口有每日调用配额，未上架期间只有 100 次/天（2026-09-19 查官方口径并实测撞到上限）**：官方文档写「单个 appId 调用上限为 4000 次/分钟、2,000,000 次/天；**若为未上架小程序，调用上限为 100 次/天**」（[security.msgSecCheck](https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_msgseccheck.html)）。**本项目当前未认证、未备案、未发布 ⇒ 日上限是 100 次**，一次 AI 调用至少消耗 1 次文本检测，开启输出检测时还要再加（输入按 2000 字分片、最多 10 片；输出最多 20 片——**输出分片数就是配额暴露上限**，长回答会成倍消耗当日额度）；`msgSecCheck` 与 `imgSecCheck` 的配额**各自计算**（实测：文本报 45009 时图片仍 `errcode 0`）。默认 `AI_SAFETY_FAIL_MODE=closed` 下配额用尽会**直接拒绝当天所有 AI 调用**（问答 / 助手 / 识图全挂，次日恢复）——**排障时先看有没有 45009，不要往模型或密钥方向找**。**上线前的应对手段（按官方文档口径整理，2026-09-19 查证）**：① 等次日恢复（默认，零成本）；② **`clear_quota`（重置 API 调用次数）**——`POST https://api.weixin.qq.com/cgi-bin/clear_quota?access_token=ACCESS_TOKEN`，body `{"appid":"<小程序 appid>"}`，官方声明**适用账号类型含小程序**，用小程序自己的 access_token 清空每日次数（[接口文档](https://developers.weixin.qq.com/miniprogram/dev/server/API/openApi-mgnt/api_clearquota.html)）；**每个账号每月共 10 次清零机会**（后台页面清零与 API 清零共用这 10 次，超限返回 48006），**本项目未实测**——前置是要能拿到小程序 access_token（AppID + AppSecret 换），未认证小程序能否换取**待验证**，验证步骤：换到 token 后先跑 `getApiQuota` 查一次剩余额度；③ `getApiQuota` 可查询任一接口当天的 `daily_limit` / `used` / `remain`（同样适用小程序），**演示前用它确认还剩多少次**；④ 排障期临时 `AI_SAFETY_FAIL_MODE=open`（仅开发排障、生产不得使用，测完立刻改回 `closed`）。**不要**为省配额去关 `AI_MODERATE_OUTPUT`——「AI 输出也要过内容安全」是硬约束。发布上线后配额自动放大到 4000/分钟、200 万/天，**所以这条只在上架前影响我们：演示当天要按 100 次倒排脚本**。
- **云调用权限**：函数目录 `config.json` 声明了 `permissions.openapi`（`security.msgSecCheck`、`security.imgSecCheck`），随函数上传；官方文档口径是缺声明会返回 48001。**2026-09-19 间接实测**：小程序端探测拿到 `errcode 0`，说明随函数上传的声明已生效（否则按官方口径会返回 48001）。
- **第三方**：`AI_SAFETY_PROVIDER=openai` / `anthropic` 时，用对应接口格式调一个「审核判定」提示词，读回 `{"allowed":bool,"reason":"..."}`；`AI_SAFETY_OPENAI_MODE=moderations` 时改走 OpenAI 官方 `/moderations` 接口读 `results[0].flagged`。**该做法是 Ticket 01 的实现选择**（见票面「决策」），要换成别的第三方审核服务时只需新增一个适配器分支。
- **不可用 / 超时的处置**：默认 fail closed（拒绝调用），避免未检测内容上屏。原因不同、分类也不同：
  - **超时**（微信云调用、第三方审核、云存储下载）→ `model_unavailable`（可重试，与模型超时同类）；
  - **配置 / 权限 / 协议类不可用**（如 `cloud.openapi.security` 缺失、48001、第三方适配器 **401/403 鉴权失败**、判定 JSON 解析不了）→ `internal`（要改配置）；
  - **`AI_SAFETY_FAIL_MODE=open`** → 放行，但报告 `checked: false`、`detail` 写明「未检测」，并进 `warnings`。
    该开关与 `AI_SAFETY_PROVIDER=off` 都是**仅限开发与排障的逃生口，生产不得使用**：规格把「AI 生成的文字与用户上传的图片都要过内容安全检测」列为硬约束，发布前必须确认这两项是默认值（`wechat` / `closed`）。
- 违规判定与「检测失败」在返回值里区分：违规是 `content_rejected`，检测服务本身出错是 `internal` / `model_unavailable`（或按 fail-open 放行并注明 `checked: false`）。

### 排障：所有 AI 功能都返回「AI 服务内部错误」

页面上 `internal` 只有一句通用文案，**真正的原因在返回值的 `detail` 里，必须先看 `detail` 再判断方向**。
2026-10-29 起客户端也会把 `feature / failureClass / detail` 打到**控制台**（只进控制台、不上屏，服务端已剔除密钥），改前端后就不必再手工抓原始返回。

从小程序端读原始返回（云调用只能由小程序端触发，控制台/CLI 触发会拿到 `-501001`）：

```text
"<微信开发者工具目录>\cli.bat" auto --project <仓库>/dist --auto-port 9420 --trust-project
node scripts/probe-ai-raw-response.cjs --feature=timetable-assistant --text="这周有几门课？"
node scripts/probe-ai-raw-response.cjs --payload-file=<写着 {"action":"probe"} 的 UTF-8 无 BOM 文件>
```

| `detail` 关键字 | 含义 | 下一步 |
| --- | --- | --- |
| `内容安全检测不可用：HTTP 401` / `403` … `authentication_error` | 第三方审核的密钥失效或被吊销，fail-closed 拒绝整次调用 | 控制台把 `AI_SAFETY_PROVIDER` 改回 `wechat`（默认值）先恢复，或换有效的 `AI_SAFETY_API_KEY`；**此时模型还没跑，不能用这次调用判断模型密钥**。实例见 [2026-10-29 证据](../../evidence/ai-safety-401-2026-10-29/README.md) |
| `45009` / `fail reach max api daily quota limit` | 微信当日检测配额用尽（未上架小程序约 100 次/天） | 归 `quota_exhausted`，次日恢复；上线前按配额倒排脚本 |
| `AI 记账闸门正在使用或待核对` | 上一笔收费调用的记账没确认或被异常中断，闸门留着 | 并发请求瞬时撞门可重试；持续出现要维护者核账，**不得未核账就删闸门** |
| `本月 AI 调用记录多于月度汇总` | 漏记冻结（明细多于汇总） | 维护者核对后修复账目 |
| `AI 服务未配置：缺少云函数环境变量` | `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` 等缺失 | 控制台补齐环境变量 |
| `读取月度用量失败` / `无法核对本月 AI 调用记录数` | 数据库读失败，按 fail-closed 拒绝 | 查集合权限/索引与云数据库状态 |
| `回答超过` … `已丢弃` | 模型输出超 `MAX_OUTPUT_CHARS`（4 万字），检不完全部输出 | 精简输入或重试；不要改成放行未检测内容 |

`probe` 动作（管理员限定、不花模型额度）只验证微信官方两条检测接口能不能调，**不能**用它的结论推断第三方审核或模型密钥是否有效。

### 恢复第三方审核（先本地验证，再改线上）

第三方审核是**模型调用**（走中转），不是免费接口；它的密钥失效会因 fail-closed 把**全部** AI 功能一起挡住（2026-10-29 实例见 [证据](../../evidence/ai-safety-401-2026-10-29/README.md)）。因此顺序固定为「先验证、后切换」，不要在线上试错。

**前置事实（10-02/10-29 实测）**

- 中转是 OpenAI 兼容接口（本项目记录为 CommandCode，`https://api.commandcode.ai/provider/v1`），`/chat/completions` 可用，`/moderations` 返回 **404** ⇒ `AI_SAFETY_OPENAI_MODE` 必须是 `chat`。
- 审核模型必须是 `deepseek/deepseek-v4-flash-fast` 这类「短输出」模型；业务模型 `deepseek/deepseek-v4.1-flash` 在 `AI_SAFETY_MAX_TOKENS`（夹在 2048 以内）下只输出 reasoning、正文为空，审核 JSON 解析不了 ⇒ 又会被 fail-closed 挡住。
- 模型密钥与审核密钥可以是两把。2026-10-29 的故障里模型密钥仍然有效（业务模型正常返回），只是审核那把失效；所以**先用有效的那把复用**通常是最省事的恢复路径。

**步骤**

1. 取得一把有效密钥（二选一）：
   - **复用模型密钥**：删掉 `AI_SAFETY_API_KEY` 这个覆盖项即可（代码默认回落到 `AI_API_KEY`），不必新申请；
   - 或在服务商控制台**新建一把密钥**（账号密钥轮换/吊销后旧值不能再用；新密钥只放云函数环境变量，不进仓库与命令行历史）。
2. **本地先验证**（不碰线上配置）：

   ```text
   npm run build
   $env:AI_SAFETY_API_KEY='<候选密钥>'
   npm run probe:safety-key -- --base-url=https://api.commandcode.ai/provider/v1 --model=deepseek/deepseek-v4-flash-fast
   ```

   脚本（`scripts/probe-safety-key.cjs`）直接复用云函数的审核实现，用 4 类样本验证「良性放行 + 广告/辱骂/赌博拦截」。**只有退出码 0 才继续**；失败时会打印 401/超时/JSON 解析失败的具体 `detail`。
3. 在 **云开发控制台 → 云函数 → ai → 配置 → 环境变量** 设置（CLI 不支持环境变量）：

   | 变量 | 值 |
   | --- | --- |
   | `AI_SAFETY_PROVIDER` | `openai` |
   | `AI_SAFETY_OPENAI_MODE` | `chat`（填 `moderations` 会 404） |
   | `AI_SAFETY_MODEL` | `deepseek/deepseek-v4-flash-fast`（**不要用业务模型**） |
   | `AI_SAFETY_BASE_URL` | 可删（默认取 `AI_BASE_URL`），保留则与模型地址一致 |
   | `AI_SAFETY_API_KEY` | 第 1 步的密钥；若选择复用模型密钥则**删除**这一项 |

4. 线上复测（从小程序端）：`node scripts/probe-ai-raw-response.cjs --feature=timetable-assistant --text="这周有几门课？"`，确认 `ok=true` 且 `safety.provider=openai`、`checked=true`；失败会带可读 `detail`。
5. **回滚**：`AI_SAFETY_PROVIDER` 改回 `wechat`（默认值）；其余 `AI_SAFETY_*` 可保留不生效。
6. **记录**：按下文「成本」小节把代价写进当轮证据——第三方审核每次 1.7–2.9 秒、一次业务请求要过 2–4 次审核，且按 token 计入月度上限；切换期间的批次不能与 `wechat` 配置下的结果混算。

<a id="微信内容安全探测记录"></a>

### 微信内容安全探测记录（**已回填 2026-09-19**）

未认证小程序能否调用官方内容安全云调用，是本票要探明的第一件事。探测动作 `{"action":"probe"}` 用**固定良性文本**与一个现场生成的 8×8 PNG 各调一次接口，把 errcode/errmsg 原样记下来；**不发违规文本**（那是刻意不做的事，违规路径由错误码表与桩测试覆盖）。

| 探测时间（UTC+8） | 环境 ID | 是否带 openid | `security.msgSecCheck` | `security.imgSecCheck` | 结论 | 建议适配器 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-19 01:26 | `cloudbase-d2gjtbbwu3575cd7b` | 否（控制台「测试」页触发） | `-501001` invalid wx openapi access_token | `-501001` invalid wx openapi access_token | **无效测量**：云调用未从小程序端触发，接口可用性没被测到（`probe.valid: false`） | 不切换（无效测量不改默认） |
| 2026-09-19 01:35 | `cloudbase-d2gjtbbwu3575cd7b` | 是（小程序端，v2 形态） | `errcode 0`（544ms） | `errcode 0`（458ms） | **可调用**：文本与图片两条路径都通 | `wechat`（保持默认） |
| 2026-09-20 00:17 | `cloudbase-d2gjtbbwu3575cd7b` | 是（小程序端，v2 形态） | `45009` reach max api daily quota limit | `errcode 0` | **部分可用**：文本配额用尽、图片正常；**北京时间已过午夜仍未重置**，说明它不是按自然日 0 点恢复 | 不切换（等恢复） |
| 2026-09-20 01:2x | `cloudbase-d2gjtbbwu3575cd7b` | 是（小程序端，v2 形态） | `errcode 0`（420ms） | `errcode 0`（487ms） | **可调用**：两条接口都恢复 | `wechat`（保持默认） |
| 2026-09-29 11:40 | `cloudbase-d2gjtbbwu3575cd7b` | 是（小程序端，v2 形态；**维护者白名单账号**） | `errcode 0`（620ms） | `errcode 0`（559ms） | **可调用**：配好 `AI_ADMIN_OPENIDS` 后维护者探测首次跑通（V3），`probe.valid: true`；两条接口都通 | `wechat`（保持默认） |

第二行（有效测量）粘贴进文档的原始记录：

```json
{"probedAt":"2026-09-18T17:35:47.421Z","timeZone":"Asia/Shanghai（UTC+8）","env":"cloudbase-d2gjtbbwu3575cd7b","openidPresent":true,"declaredOpenApi":["security.msgSecCheck","security.imgSecCheck"],"checks":[{"api":"security.msgSecCheck","form":"v2（带 openid）","errCode":0,"errMsg":"openapi.security.msgSecCheck:ok","verdict":"pass","note":"调用成功","elapsedMs":544},{"api":"security.imgSecCheck","form":"v2（带 openid）","errCode":0,"errMsg":"openapi.security.imgSecCheck:ok","verdict":"pass","note":"调用成功","elapsedMs":458}],"valid":true,"invalidReason":"","conclusion":"微信官方内容安全接口可调用（文本与图片均返回 errcode 0）：保持 AI_SAFETY_PROVIDER=wechat（默认）。","recommendedProvider":"wechat"}
```

**怎么读这两行**：`probe.valid` 与 `ok` 必须分开看。第一行 `ok: false` 且 `valid: false`——它**不是**「接口不可用」的证据，而是「这次调用怎么发起的」不对；只有 `valid: true` 时 `ok: false`（或部分可用）才轮到切换适配器。第一行也说明了为什么探测动作需要一个小程序端入口。

常见错误码的含义：`0` 成功；`87014` 内容违规；`48001` / `48002` 接口未授权或被禁（**未认证小程序是否必然返回它们仍未验证**，本次没碰到）；**`45009` 当日调用配额用尽（2026-09-19 实测：文本接口报它时图片接口仍正常，两个接口配额各自计算，次日恢复；默认 fail-closed 会拒绝当天所有 AI 调用）**——**这条自 2026-09-19 起归 `quota_exhausted`**（文案 `AI_MSG_QUOTA_EXHAUSTED_SAFETY`，与月度成本上限的「下月再试」分开），修复前它被归成 `internal`、页面显示「AI 服务内部错误，请稍后重试」；**该修复需重新部署 `ai` 才生效**；`61010` v2 需要 openid 近期访问过小程序；`40001` access_token 相关问题；**`-501001` / `-501007`（以 `-5` 开头的是云开发平台码，不是微信开放接口码）表示「本次调用没有小程序侧云调用票据」**，即不是从小程序端触发的——控制台、CLI、HTTP 触发、云函数互调都会踩到，属于无效测量。探测会把「是否超时」也记进 `note`（接口不响应时按调用超时记录，不会挂住）。

**切换方式**：探测结论为**有效**且显示不可用或部分可用时，在云函数环境变量里把 `AI_SAFETY_PROVIDER` 改为 `openai` 或 `anthropic`，并按需配置 `AI_SAFETY_BASE_URL` / `AI_SAFETY_API_KEY` / `AI_SAFETY_MODEL`；改完重跑一次探测与一次 `chat`（都在小程序端），确认返回值里 `safety.provider` 变成第三方。**本轮实测微信官方接口可用，默认值 `wechat` 保持不变，暂不需要第三方审核密钥。**

<a id="ticket-01-人工步骤"></a>

### Ticket 01 人工步骤（动作 / 对象 / 判据）

**2026-09-19 进展**：A（部署）、B（集合 + 环境变量）、C（超时改成 20 秒并被 4600ms 的端到端调用证明生效）、D（探测，已回填上表）与 E（端到端 + 密钥外泄检查）均已完成；**内存已核实为 256MB**（控制台日志 `Memory: 256MB MemUsage: 37.4MB`，记录在步骤 C）。**步骤 F（月度上限拦截实测）已由负责人确认完成**。**步骤 G（`vision` 路径真实调用）**分两步：① 负责人加上 `AI_EXTRA_BODY_JSON={"chat_template_kwargs":{"thinking":false}}` 与 `AI_TIMEOUT_MS=13000` 之后，**合成小图的链路冒烟通过**（`npm run smoke:ai:vision`：`ok=true`、`elapsedMs=9978`、模型返回合法 JSON、内容安全 `checked=true`）——**模型确实支持图片输入**，「模型名不支持视觉」的猜测不成立；② **但真实课表截图仍失败**，新的读数是 `detail=模型调用超时：请求超时（11417ms）`。四种输入对照（570 字节小图通过、真实截图只问一列超时、真实截图缩到 1000px 宽同样超时、真实截图两门课约 11 秒通过）说明**卡的是固定时延，与图片大小、输出长度都无关**。
**三个数已由负责人调到 60 / 50000 / 40000（`cli cloud functions info` 读回 `timeout=60`），但真实截图仍然不够**：模型拿到 40000ms 预算仍未返回（`elapsedMs=43336`、`detail=模型调用超时：请求超时（40000ms）`）。单独量的模型画像：**固定开销约 11 秒、吞吐约 86 token/秒、每门课约 300 个完成 token**，据此外推 45 门课的完整课表需要 170 秒以上（压到最紧凑格式也仍有 80–90 秒），**超过 60 秒的云函数上限 ⇒ 一次调用识别整张表在当前模型上不成立**。另外发现压缩输出格式并不降低完成 token（正文约 500 token 而完成 token 2571），符合「模型仍在输出思考内容、且计入 completionTokens」的表现，**说明先前那次「关思考」很可能没生效**（Qwen3 系的标准开关名是 `enable_thinking`，配置里写的是 `thinking`）。注意客户端 `VISION_MAX_TOKENS=2048` 对完整课表偏小，第一次拿到完整结果时要检查是否被截断。

**2026-09-19 第四轮：分带并行识别（`bands: 'auto'`，分支 `feat/vision-banded-recognition`）**。既然一次调用不成立，改成**按节次切带、并行多次调用**：带数不写死，由服务端按画像与自己的超时预算算（当前配置下 6 带 / 每带 2 节 / 每带预计约 39 秒）。**这一步不需要新的环境变量**，但**重新部署 `ai` 是必须的**（代码在云函数里）：

```powershell
npm run build
& "<开发者工具目录>\cli.bat" cloud functions deploy --env cloudbase-d2gjtbbwu3575cd7b --names ai --remote-npm-install --project <仓库>/dist
# 或在开发者工具里右键 dist/cloudfunctions/ai →「上传并部署：云端安装依赖」
```

复测按顺序、省着用配额（判据见 [P5-B 验证记录](../../evidence/p5-b/README.md#2026-09-19-第四轮改为服务端分带并行识别把不可能的一次调用拆成可行的多带)）：

```powershell
npm run smoke:ai:vision                   # ① 单带小图，确认原路径没被改坏
npm run smoke:ai:vision -- --bands=auto    # ② 分带小图，确认并发没被中转拒（告警里会出现「分带识别：按节次分 N 带并行调用」）
```

**图片与输入文字仍各只过一次内容安全**：分带只在服务端调用模型，不放大 `imgSecCheck`/`msgSecCheck` 的次数（配额是硬约束，客户端切块才会按块翻倍）。**仍然建议把 `AI_EXTRA_BODY_JSON` 换成 `{"chat_template_kwargs":{"enable_thinking":false}}`**：关掉思考后每门课的完成 token 大幅下降，`bands: 'auto'` 会自动少切几带——两者互补，不互斥。

**步骤 A：部署 `ai` 云函数**（**已完成**：2026-09-18 首次部署，2026-09-19 本轮把修复版重新部署，11 个文件 / 42.4 KB）

- **动作**：`npm run build` 后在开发者工具里右键 `dist/cloudfunctions/ai` →「上传并部署：云端安装依赖」（或 `cli.bat cloud functions deploy --env cloudbase-d2gjtbbwu3575cd7b --names ai --remote-npm-install --project <仓库>/dist`）。
- **对象**：云函数 `ai`（依赖只有 `wx-server-sdk@4.0.2`）。
- **判据**：`cli cloud functions info` 读回 `ai` 为 `Active` / `Nodejs16.13`；函数目录含 `index.js`、`package.json`、`config.json`（`config.json` 里的 `permissions.openapi` 是微信云调用的权限声明，必须随目录上传）。

**步骤 B：建集合、配环境变量**（**已完成**）

- **动作**：控制台「数据库」新建 `ai_usage_records` 与 `ai_usage_monthly`，权限都选「所有用户不可读写」；再到「云函数 → ai → 配置 → 环境变量」逐项填密钥与地址（密钥只在控制台粘贴，不写进仓库或文档）。
- **对象**：两个集合；`AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`、`AI_VISION_MODEL`、`AI_PRICE_*`、`AI_MONTHLY_CAP_YUAN`。
- **判据**：运行 `{"action":"usage"}`（控制台「测试」页即可，它不碰内容安全）返回 `ok: true`，`usageSummary.capYuan` 为 50、`month` 为当前东八区月份、返回里不出现密钥。**只配密钥不够**：单价必须按中转实际价格填，否则成本上限偏低。本轮实测：`capYuan: 50`、告警线 40、`AI_PRICE_*` = 0.25 元/百万 token（不同于代码默认值 1 / 4，说明确实按中转价格配过）。

**步骤 C：确认云函数超时与内存**（**已完成，2026-09-19**）

- **动作**：控制台把 `ai` 的超时时间设为 **20 秒**（`newsSync` 已这么设，照做；默认 3 秒会截断模型调用）。CLI 没有超时参数，只能在控制台做。
- **对象**：云函数 `ai` 的函数配置。
- **判据**：`cli cloud functions info` 读回 `ai` 的 timeout 为 20；随后 `npm run smoke:ai` 端到端成功（`ok: true` 且 `text` 非空），且 `elapsedMs` 明显小于 20000（`AI_TOTAL_DEADLINE_MS` 默认 15 秒必须小于函数超时）。
- **内存判据（2026-09-19 已核实）**：控制台函数日志出现 `Report RequestId: … Duration: 1ms Memory: 256MB MemUsage: 37.4MB`（`timetable` 函数的日志行，同环境函数配置一致）→ 记为 **256MB**。
- **实测证据**：3 秒时 `npm run smoke:ai` 返回 `cloud.callFunction:fail Error: errCode: -504003 | errMsg: Invoking task timed out after 3 seconds`；2026-09-19 改成 20 秒后同一条冒烟返回 `ok=true`、`elapsedMs=4600`、模型输出「链路已通」（原始输出见 [Ticket 01 端到端冒烟记录](../../evidence/p5-foundation/README.md)）。

**步骤 D：跑微信内容安全探测并回填上表**（**已完成**，2026-09-19）

- **动作**：**从小程序端**跑 `npm run probe:wechat`（前置：`cli auto --project <仓库>/dist --auto-port 9420 --trust-project` 已打开项目），把输出里那一行 JSON 粘贴到上表。**不要用控制台「测试」页**——云调用拿不到小程序侧票据，必然返回 `-501001`，那是无效测量。
- **对象**：`probe.checks[]` 两条（`security.msgSecCheck`、`security.imgSecCheck`）与 `probe.valid` / `probe.conclusion` / `probe.recommendedProvider`。
- **判据**：`probe.valid` 为 `true`；两条都带 `errCode` / `errMsg` / `note`；`errcode 0` 表示该接口可调用；出现 `48001` / `48002` 时才按上面的「切换方式」改 `AI_SAFETY_PROVIDER` 后重跑探测与一次 `chat`（原因是不是「未认证」要由这次探测结论确认，不要先当成事实）。**这条结论必须落到本表**，否则 05/06/07 的内容安全路径没有依据。

**步骤 E：端到端验证一次，并检查密钥外泄**（**已完成，2026-09-19**）

- **动作**：**从小程序端**跑 `npm run smoke:ai`（它发一句「只回复四个字：链路已通」）；随后读 `ai_usage_records` / `ai_usage_monthly`，并在开发者工具里检查小程序包（`dist` 下 `cloudfunctions/` 之外的 `.js`）与数据库内容。内容安全适配器为 `wechat` 时不能用控制台「测试」页跑 `chat`（见上文「云调用必须由小程序端触发」）。
- **对象**：一次真实模型调用；两个用量集合；小程序包；数据库。
- **判据**：返回值 `ok: true` 且 `text` 非空；`ai_usage_records` 新增一条 `kind: "model"`、`ok: true` 的记录并带耗时与 token；`ai_usage_monthly` 的 `calls` 与 `costYuan` 增加；小程序包里搜不到密钥字符串；数据库里搜不到密钥字符串。**这是票面「端到端验证：一句测试文本经模型返回结果，全过程无密钥外泄」的唯一证据来源。**
- **2026-09-19 实测**：`npm run smoke:ai` 返回 `ok: true`、模型输出「链路已通」；控制台抽查 `ai_usage_records` 一条真实记录，字段为 `_id / action / completionTokens / costYuan / createdAt / durationMs / estimated / failureClass / feature / kind / model / month / ok / promptTokens`，**没有密钥字段也搜不到密钥值**；小程序包一侧由 `tests/ai-bundle.test.cjs` 断言不含密钥。

**步骤 F：核对月度上限真的会拦**（**仍未执行**）

- **动作**：把 `AI_MONTHLY_CAP_YUAN` 临时改成一个小于当月已花金额的值，再跑一次 `chat`（小程序端），然后把上限改回 50。
- **对象**：上限判定路径。
- **判据**：返回 `failureClass: "quota_exhausted"`，`message` 是额度类文案（与「模型不可用」「内容被拒」不同句），且这一次没有发起模型请求（`ai_usage_records` 不新增 `kind: "model"` 记录）。

### 已知限制与未决问题（Ticket 01）

- **中转的模型名与单价未核实**：AI 资讯实测用的是 DeepSeek **官方** API（`deepseek-flash`），中转（CommandCode）的接口地址、模型名与价格**没有公开依据**，因此 `AI_MODEL` / `AI_PRICE_*` 没有代码默认值，必须由维护者按服务商实际值配置。选型已验证的部分只有「该模型支持多模态、延迟约 164ms、43 次调用约 0.13 元」，**这是官方 API 的实测，不是中转的实测**。
- **中转接口格式已实测（2026-09-19）**：端到端冒烟以 `provider=openai`、`model=deepseek/deepseek-v4.1-flash` 真实调通，OpenAI 兼容形态成立（原始输出见 [Ticket 01 端到端冒烟记录](../../evidence/p5-foundation/README.md)）。**仍未核实的是单价**：本次 105 token 记为 0.000026 元，说明生效的是环境变量里配置的 0.25 元/百万 token；这个价格是否等于中转的真实计费必须联调核对——**单价填低，50 元上限就形同虚设**。
- **成本量级参考**：按实测的官方单价，50 元约合 1.6 万次调用；走中转的实际价格可能不同，上限按实际单价判断。
- **月度首次写入不再有竞态**：当月文档用固定 `_id`（月份）插入初值，并发下只有一个能插入，另一个回到原子自增；`update` 的其它失败一律抛出并记为可处理的记账失败，**不会**回退成覆盖式写入（否则会把当月累计冲掉，成本上限失效）。
- **图片 token 为估算**：多模态请求里图片按固定常数计入估算（服务端若返回 usage 则以服务端为准）。
- **用量未知的审核调用按固定价或标记计入**：OpenAI `/moderations` 不返回 token 用量，记录带 `usageUnknown: true`；金额按 `AI_SAFETY_CALL_PRICE_YUAN`（默认 0）计，返回值有告警。若长期使用该模式，负责人应把每次固定价配上，否则这部分成本不进上限。
- **`ai_usage_records` 只增不删**：保留策略（滚动窗口/定期清理）未定，等真实调用量出来再决定。
- **探测只能证明「接口可调用」**：不发违规文本是刻意选择，因此「违规内容一定会被拦」由官方错误码表 + 桩测试覆盖，不是探测结论。
- **`invalid_request` / `internal` 两类失败**：规格只要求三类用户可见失败可区分；这两类是本票补的基础设施分类，文案同样独立。

## 2026-10-03升学诊断新增返回字段

已有维护者usage动作新增userDailyLimit（本人东八区day/used/limit/remaining），只读、不消耗业务日额度，不把月度金额余量当日余量。timings记录服务端阶段壁钟，accountingMs/modelNetworkMs/safetyNetworkMs是阶段子项，不重复相加，不替代客户端端到端。

HTTP200模型正文无效而返回usage时，失败也记真实用量，不返回推理正文；无usage标未知并提示核账。多带响应汇总包含已计费失败带，各带只记本次响应用量，不能借用共享log字段。[本轮部署/真实失败与停止](../../evidence/advancement-optimization-2026-10-03/README.md)保留旧4条空响应漏计的未核账状态。恢复真实评测前先由负责人核对，不手工猜补或删闸门。
