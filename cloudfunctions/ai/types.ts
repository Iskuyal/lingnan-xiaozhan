/**
 * AI 服务端基础设施（Ticket 01）的类型契约。
 *
 * 这一层是 05（课表截图识别）、06（课表助手）、07（部门问答）的共同前置：
 * 所有 AI 功能只通过本函数的 `main` 入口调模型，密钥只来自云函数环境变量。
 * 事件与返回值的形状一旦被那三票依赖，就不要再随手改；改这里等于改三处调用方。
 */
import { AdvancementResult } from './advancement';

/**
 * 失败分类。
 *
 * 前三类是开发规格「AI 功能」一节要求**可区分、文案各自独立**的用户可见失败：
 * 模型不可用或超时、内容被安全策略拒绝、额度或配额用尽。
 * 后两类是调用方参数错误与云函数内部错误，同样有独立文案——
 * 把参数错误或内部错误说成「模型不可用」会让排查方向跑偏。
 *
 * `citation_unverified` 是 2026-09-30 升学问答模型版新增的第六类：模型答了，但回答里的
 * 日期/数字/条件句**没有可核对的出处**，服务端不把它作为官方结论返回。它既不是模型不可用
 * （模型正常返回了），也不是内容违规，更不该混进 `internal`（那不是调用方能处理的）；
 * 调用方据此降级为本地原文摘录。
 */
export type FailureClass =
  | 'model_unavailable'
  | 'content_rejected'
  | 'quota_exhausted'
  | 'invalid_request'
  | 'internal'
  | 'citation_unverified';

/** 云函数支持的入口动作；05/06/07 只会用到 chat / vision / moderateText / moderateImage。 */
export type ActionName = 'chat' | 'vision' | 'moderateText' | 'moderateImage' | 'usage' | 'probe';

/** 模型接口格式：OpenAI 兼容（项目使用的中转）与 Anthropic 格式。 */
export type ProviderFormat = 'openai' | 'anthropic';

/** 内容安全适配器：微信官方云调用优先，第三方按 OpenAI / Anthropic 两种接口格式接入，也可整体关闭。 */
export type SafetyProviderName = 'wechat' | 'openai' | 'anthropic' | 'off';

/** 内容安全检测「不可用」时的处置：closed = 拒绝调用（默认，宁可挡住也不放未检内容出去）。 */
export type SafetyFailMode = 'closed' | 'open';

/** 微信 `suggest=review`（需人工复审）的处置，默认按拒绝处理（fail closed）。 */
export type SafetyReviewPolicy = 'reject' | 'pass';

/** OpenAI 格式第三方审核的两种调用方式：chat（任何兼容中转可用）与 moderations（OpenAI 官方审核接口）。 */
export type SafetyOpenAiMode = 'chat' | 'moderations';

export type MessageRole = 'system' | 'user' | 'assistant';

/**
 * 规范化后的图片输入：base64 与 MIME 类型。
 * 客户端可以传云存储 fileID（由云函数下载）或直接传 base64，两者都在 index.ts 收敛成这个形状。
 */
export interface NormalizedImage {
  base64: string;
  mimeType: string;
}

/** 一条对话消息；图片只允许挂在 user 消息上（两种接口格式都这么约定）。 */
export interface ConversationMessage {
  role: MessageRole;
  text: string;
  image?: NormalizedImage;
}

/**
 * 服务端返回的 token 用量。
 *
 * - `estimated` 为真：服务端没给 usage，按字符数估算；
 * - `usageUnknown` 为真：连估算都不成立（接口根本不返回用量，如 OpenAI `/moderations`），
 *   金额按「每次审核固定价」或 0 记，但**必须带这个标记**，
 *   否则记录里的 0 元会被读成「这次是免费的」，成本上限随之失真。
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
  usageUnknown: boolean;
}

/** 一次调用（模型或第三方审核）的用量与金额，是记账与成本上限判断的最小单位。 */
export interface CallUsage extends TokenUsage {
  costYuan: number;
  priceInputPerMillion: number;
  priceOutputPerMillion: number;
}

/** 单次子调用（模型调用、第三方审核调用）的落库记录。 */
export interface SubCallRecord {
  /** 不可逆的用户摘要；不落明文 openid。 */
  userKey: string;
  /** 同一次云函数调用内的子调用共用，便于把「一次用户请求」在库里串起来。 */
  requestId: string;
  /** 业务落点：department-qa / timetable-screenshot / timetable-assistant / probe / 未知。 */
  feature: string;
  action: ActionName | '';
  /** model = 模型调用；moderation = 第三方内容安全检测。 */
  kind: 'model' | 'moderation';
  provider: string;
  model: string;
  ok: boolean;
  failureClass: FailureClass | '';
  durationMs: number;
  usage: CallUsage;
}

/** 月度累计用量：成本上限判断与维护者查询都读它。 */
export interface UsageSummary {
  /** 东八区的月份，形如 2026-09。 */
  month: string;
  calls: number;
  failures: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costYuan: number;
  capYuan: number;
  warnRatio: number;
  warnThresholdYuan: number;
  /** 已达告警线但未超上限。 */
  warn: boolean;
  /** 已超上限：后续调用会被拒绝，失败分类为 quota_exhausted。 */
  exceeded: boolean;
  priceInputPerMillion: number;
  priceOutputPerMillion: number;
  updatedAt: string;
}

/**
 * 内容安全检测结果的摘要（回传给调用方，便于页面记录与排查）。
 *
 * `checked` 与 `passed` 是两件事，必须分开看：
 * - `passed: true` 只表示「在检测过的范围内没发现问题」；
 * - `checked: false` 表示这次**根本没有真正检测**（`AI_SAFETY_PROVIDER=off` 关闭、
 *   `AI_SAFETY_FAIL_MODE=open` 放行未检内容，或长文本只检测了前一段）。
 * 只设 `passed` 会让调用方与日志把「跳过」读成「干净」，因此这个标志是硬要求。
 */
export interface SafetyReport {
  provider: string;
  api: string;
  passed: boolean;
  /** 是否真的执行了检测（含部分检测时为 false，具体范围写在 `detail`）。 */
  checked: boolean;
  detail: string;
}

/** 探测动作里的单个接口检查（微信 errcode 原样记录）。 */
export interface ProbeCheck {
  api: string;
  /** 接口形态：v1（无 openid）/ v2（带 openid）。 */
  form: string;
  errCode: number;
  errMsg: string;
  /** pass / reject / review / error。 */
  verdict: string;
  note: string;
  elapsedMs: number;
}

/**
 * 微信内容安全接口探测记录：维护者把它粘贴进 docs/development/cloud/ai.md。
 *
 * `valid` 与 `ok` 是两件事：
 * - `valid: false` 表示**这次探测不构成证据**——调用方没有小程序侧的云调用票据
 *   （控制台「测试」页、CLI、HTTP 触发、云函数互调都会如此），微信接口的可用性根本没被测到；
 *   此时不得据 `recommendedProvider` 切换适配器。
 * - `valid: true` 时 `ok` 才表示「两条接口都返回 pass」。
 */
export interface ProbeRecord {
  probedAt: string;
  timeZone: string;
  env: string;
  /** 是否拿到小程序侧上下文：有 openid 才走 msgSecCheck v2 形态。 */
  openidPresent: boolean;
  declaredOpenApi: string[];
  checks: ProbeCheck[];
  /** 本次探测是否有效（无效时结论只是「调用方式不对」，不是「接口不可用」）。 */
  valid: boolean;
  /** 无效原因；有效时为空串。 */
  invalidReason: string;
  conclusion: string;
  recommendedProvider: string;
}

/** 探测动作的完整结果（供维护者阅读与粘贴）。 */
export interface ProbeResult {
  ok: boolean;
  /** 见 {@link ProbeRecord.valid}：探测是否有效。 */
  valid: boolean;
  record: ProbeRecord;
  conclusion: string;
  recommendedProvider: string;
  /** 便于粘贴进文档的一行 JSON。 */
  pasteLine: string;
  elapsedMs: number;
}

/** 统一返回结构。任何动作都返回它，调用方只看 `ok` / `failureClass` / `message`。 */
/**
 * 部门动态检索命中的来源条目（chat 动作 department-qa 的检索注入结果）。
 *
 * 形状与 cloudfunctions/ai/rag.ts 的 ActivityHit 一致，这里独立声明：
 * 类型契约层不反向依赖实现模块，rag.ts 的返回直接赋值给本类型。
 */
export interface DepartmentActivityCitation {
  departmentId: string;
  departmentName: string;
  title: string;
  /** 官网文章发布日期，格式 YYYY-MM-DD。 */
  publishedAt: string;
  sourceUrl: string;
  score: number;
}

export interface AiResponse {
  /** 分步服务端测量。网络/记账计数是流水线步骤的子项，不能重复相加。 */
  timings?: Record<string, number>;
  userDailyLimit?: { day: string; used: number; limit: number; remaining: number };
  ok: boolean;
  action: ActionName | '';
  failureClass: FailureClass | '';
  /** 用户可见文案；成功时为空字符串。 */
  message: string;
  /** 维护者排查用细节（已剔除密钥）；成功时通常为空。 */
  detail: string;
  feature: string;
  /** 模型接口格式（openai / anthropic）或内容安全适配器名；未成功建立调用时为空。 */
  provider: string;
  model: string;
  /** 模型输出文本；仅 chat / vision 成功时有值。 */
  text: string;
  /** 内容安全检测结论；仅 moderate* 动作有值。 */
  safety: SafetyReport | null;
  /** 本次主调用的用量与金额；没有调用模型时为空。 */
  usage: CallUsage | null;
  /** 当月累计用量；读取失败时为空。 */
  usageSummary: UsageSummary | null;
  /** 接近月度上限时的告警文案；否则为空字符串。 */
  capWarning: string;
  /** 非致命问题（如用量记账失败）：调用本身成功，但维护者需要知道。 */
  warnings: string[];
  /** 部门动态检索注入的引用清单；仅 department-qa 的 chat 动作可能有值，其余恒为空数组。 */
  citations: DepartmentActivityCitation[];
  /**
   * 升学问答的引用与校验结论；仅 advancement-qa 的 chat 动作有值，其余恒为空。
   *
   * 与 `citations` 分开是有意的：那边是部门动态条目的形状（无逐字引文），
   * 这边要给出逐字引文、文号与校验结论，混进一个字段会让两边解析互相牵制。
   * 形状见 advancement.ts 的 AdvancementResult。
   */
  advancement: AdvancementResult | null;
  /** probe 动作的完整记录；其它动作恒为空。 */
  probe: ProbeRecord | null;
  elapsedMs: number;
}
