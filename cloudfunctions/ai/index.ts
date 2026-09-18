/**
 * AI 服务端基础设施云函数（Ticket 01）。
 *
 * 这一票只做**共用管道**，不做三个 AI 功能本身（那是 05/06/07）：
 * 统一模型调用入口 → 输入/输出内容安全检测 → 用时与费用记账 → 月度成本上限 → 分类失败。
 *
 * 动作（`event.action`）：
 * - `chat`：文本对话（部门问答 07、课表助手 06 用）；
 * - `vision`：多模态（课表截图识别 05 用，图片先过内容安全再送模型）；
 * - `moderateText` / `moderateImage`：只做内容安全检测，文字与图片分开；
 * - `usage`：查当月累计用量与上限判断；
 * - `probe`：探测未认证状态下微信官方内容安全接口是否可用（维护者在控制台手动跑）。
 *
 * 硬约束（见 docs/development-spec.md「AI 功能」）：
 * - 密钥只在云函数环境变量，不进代码、数据库与小程序包；
 * - 单次调用有明确超时边界，整体还有一次云函数调用的总截止；
 * - 三类失败可区分、文案各自独立，且**任何情况都不向调用方抛裸异常**。
 */
import * as cloud from 'wx-server-sdk';
import { Config, ModelTarget, loadConfig, resolveModelTarget, secretsOf } from './config';
import { AiFailure, describeError, fail, messageFor, redactSecrets, toFailure } from './errors';
import { ModelCallResult, ModelInvocation, callModel } from './providers';
import { SafetyOutcome, WechatSecurityApi, checkImage, checkText } from './safety';
import { runProbe } from './probe';
import {
  ActionName,
  AiResponse,
  CallUsage,
  ConversationMessage,
  FailureClass,
  NormalizedImage,
  SafetyReport,
  SubCallRecord,
  TokenUsage,
  UsageSummary,
} from './types';
import {
  UsageDb,
  applyRecord,
  assertWithinCap,
  capWarningFor,
  newRequestId,
  readUsageSummary,
  recordSubCall,
  toCallUsage,
} from './usage';

// wx-server-sdk 4.0.2 的 d.ts 把 DYNAMIC_CURRENT_ENV 声明为 symbol，而 init 的 env 参数
// 类型未包含 symbol —— 属于类型声明滞后，运行时是官方推荐用法（与 newsSync 一致）。
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV as unknown as string });

const db = cloud.database() as unknown as UsageDb;

const ALLOWED_ACTIONS: ActionName[] = ['chat', 'vision', 'moderateText', 'moderateImage', 'usage', 'probe'];
/** 一次请求最多带多少条消息：防止调用方把整段历史塞进来把成本放大。 */
const MAX_MESSAGES = 20;
/** 单条消息最大长度（字符）：超出按参数错误处理，让调用方自己截断比默默截断可控。 */
const MAX_MESSAGE_CHARS = 8000;
/** 微信 msgSecCheck 的 content 上限是 2500 字；分片检测每次不超过 2000 字。 */
const MODERATION_CHUNK_CHARS = 2000;
/** 一次调用最多检测几段：超过的部分不检测，并在报告里写明，绝不假装检过。 */
const MAX_MODERATION_CHUNKS = 3;
/** 留给内容安全与记账的时间（毫秒）：模型调用不能把总截止用满。 */
const TIMEOUT_RESERVE_MS = 500;
const ALLOWED_IMAGE_MIME = ['image/png', 'image/jpeg'];

/** 云函数事件（都是 unknown，逐个收敛；调用方传错只影响本次调用）。 */
export interface AiEvent {
  action?: unknown;
  feature?: unknown;
  system?: unknown;
  messages?: unknown;
  image?: unknown;
  text?: unknown;
  maxTokens?: unknown;
  timeoutMs?: unknown;
  [key: string]: unknown;
}

/** 一次调用的可变状态：失败路径也要能拿到已发生的用量与告警。 */
interface RunLog {
  requestId: string;
  feature: string;
  action: ActionName | '';
  config: Config;
  summary: UsageSummary;
  /** 主模型调用的用量（内容安全检测的用量记进记录、不进这个字段）。 */
  usage: CallUsage | null;
  provider: string;
  model: string;
  safety: SafetyReport | null;
  warnings: string[];
}

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: false };

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function sanitizeAction(raw: unknown): ActionName | null {
  const value = safeString(raw);
  return (ALLOWED_ACTIONS as string[]).includes(value) ? (value as ActionName) : null;
}

/** 业务落点标记：只用于记账与统计，未知值不影响调用。 */
function sanitizeFeature(raw: unknown, action: ActionName | null): string {
  const value = safeString(raw).trim();
  if (value !== '' && value.length <= 64) return value;
  return action === null ? 'unknown' : action;
}

/** 微信云调用接口；本地测试或 SDK 缺该方法时返回 undefined，由 safety 层按 failMode 处理。 */
function wechatSecurity(): WechatSecurityApi | undefined {
  const openapi = (cloud as unknown as { openapi?: { security?: Partial<WechatSecurityApi> } }).openapi;
  const security = openapi === undefined ? undefined : openapi.security;
  if (security === undefined
    || typeof security.msgSecCheck !== 'function'
    || typeof security.imgSecCheck !== 'function') {
    return undefined;
  }
  return security as WechatSecurityApi;
}

/** 调用上下文的 openid：v2 内容检测与用户隔离都要它；控制台手动调用时为空。 */
function currentOpenid(): string {
  try {
    const context = cloud.getWXContext() as { OPENID?: unknown } | undefined;
    return context !== undefined && context !== null && typeof context.OPENID === 'string' ? context.OPENID : '';
  } catch {
    return '';
  }
}

/** 当前云环境标识（不是密钥），写进探测记录便于核对探测发生在哪个环境。 */
function currentEnv(): string {
  const env = process.env.TCB_ENV ?? process.env.SCF_NAMESPACE ?? '';
  return typeof env === 'string' ? env : '';
}

/** 从 fileID 猜 MIME；猜不到按 PNG（截图场景最常见），调用方可用 mimeType 显式覆盖。 */
function mimeFromFileID(fileID: string): string {
  const lower = fileID.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return 'image/png';
}

/** 去掉可能带的 data URL 前缀，返回纯 base64；前缀里的 MIME 作为兜底。 */
function stripDataUrl(raw: string): { base64: string; mimeType: string } {
  const match = /^data:([^;,]+);base64,(.*)$/su.exec(raw.trim());
  if (match === null) return { base64: raw.trim(), mimeType: '' };
  return { base64: match[2], mimeType: match[1].toLowerCase() };
}

/**
 * 把事件里的图片收敛成规范化图片。
 *
 * 支持两种来源：云存储 fileID（05 的上传路径）与直接 base64。
 * 大小与格式在这里拦住：微信 imgSecCheck 明确限制 1MB / PNG-JPG，早失败比送上去被拒清楚。
 */
async function resolveImage(raw: unknown, config: Config): Promise<NormalizedImage> {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    fail('invalid_request', '图片参数需要 {"fileID":"cloud://..."} 或 {"base64":"..."}');
  }
  const source = raw as { fileID?: unknown; base64?: unknown; mimeType?: unknown };
  let base64 = '';
  let mimeType = safeString(source.mimeType).toLowerCase();
  if (typeof source.fileID === 'string' && source.fileID !== '') {
    let content: Buffer;
    try {
      const downloaded = (await cloud.downloadFile({ fileID: source.fileID })) as unknown as { fileContent?: unknown };
      const value = downloaded === null || downloaded === undefined ? undefined : downloaded.fileContent;
      if (!Buffer.isBuffer(value)) fail('invalid_request', `云存储文件下载结果异常：${source.fileID}`);
      content = value as Buffer;
    } catch (error) {
      if (error instanceof AiFailure) throw error;
      fail('invalid_request', `云存储文件下载失败：${describeError(error)}`);
    }
    if (mimeType === '') mimeType = mimeFromFileID(source.fileID);
    base64 = content.toString('base64');
  } else if (typeof source.base64 === 'string' && source.base64.trim() !== '') {
    const parsed = stripDataUrl(source.base64);
    base64 = parsed.base64;
    if (mimeType === '' && parsed.mimeType !== '') mimeType = parsed.mimeType;
  } else {
    fail('invalid_request', '图片参数需要 fileID 或 base64');
  }
  if (mimeType === '') mimeType = 'image/png';
  if (!ALLOWED_IMAGE_MIME.includes(mimeType)) {
    fail('invalid_request', `图片格式 ${mimeType} 不支持，只接受 ${ALLOWED_IMAGE_MIME.join(' / ')}`);
  }
  // base64 长度换算成字节上限（偏保守），再解一次拿精确值判断是否超出配置上限。
  const approximateBytes = Math.floor((base64.length * 3) / 4);
  if (approximateBytes > config.maxImageBytes) {
    fail('invalid_request', `图片约 ${approximateBytes} 字节，超过上限 ${config.maxImageBytes} 字节（AI_MAX_IMAGE_BYTES）`);
  }
  const bytes = Buffer.from(base64, 'base64').byteLength;
  if (bytes === 0) fail('invalid_request', '图片内容为空或不是合法 base64');
  if (bytes > config.maxImageBytes) {
    fail('invalid_request', `图片 ${bytes} 字节，超过上限 ${config.maxImageBytes} 字节（AI_MAX_IMAGE_BYTES）`);
  }
  return { base64, mimeType };
}

/** 解析对话消息：调用方可以写 `text` 或 `content`（两种命名都常见）。 */
function parseMessages(raw: unknown): ConversationMessage[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail('invalid_request', 'messages 必须是非空数组，元素形如 {"role":"user","text":"..."}');
  }
  if (raw.length > MAX_MESSAGES) {
    fail('invalid_request', `messages 最多 ${MAX_MESSAGES} 条，当前 ${raw.length} 条`);
  }
  const messages: ConversationMessage[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') fail('invalid_request', 'messages 的每个元素都必须是对象');
    const source = entry as { role?: unknown; text?: unknown; content?: unknown; image?: unknown };
    const role = safeString(source.role) === 'assistant' ? 'assistant' : safeString(source.role) === 'system' ? 'system' : 'user';
    const text = typeof source.text === 'string' ? source.text : typeof source.content === 'string' ? source.content : '';
    if (text === '' && source.image === undefined) fail('invalid_request', 'messages 的每条消息都需要 text（或 content）');
    if (text.length > MAX_MESSAGE_CHARS) {
      fail('invalid_request', `单条消息超过 ${MAX_MESSAGE_CHARS} 字，请调用方先截断或分段`);
    }
    // 消息级图片刻意不支持：vision 只认事件顶层的 image 字段，避免同一张图被塞进多条消息重复计费。
    if (source.image !== undefined) fail('invalid_request', '消息级图片暂不支持，请用事件顶层的 image 字段（vision 动作）');
    messages.push({ role, text });
  }
  return messages;
}

/** 把图片挂到最后一条 user 消息上（两条接口格式都按「当前轮携带图片」处理）。 */
function attachImage(messages: ConversationMessage[], image: NormalizedImage): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      messages[index] = { ...messages[index], image };
      return;
    }
  }
  fail('invalid_request', 'vision 动作需要至少一条 user 消息来承载图片');
}

function userText(messages: ConversationMessage[]): string {
  return messages.filter((message) => message.role === 'user').map((message) => message.text).join('\n');
}

/** 按剩余总时限算模型调用的超时；没有余量就不发请求（可识别失败，不挂起）。 */
function modelTimeoutMs(log: RunLog, startedAt: number, requested: unknown): number {
  const remaining = log.config.totalDeadlineMs - (Date.now() - startedAt) - TIMEOUT_RESERVE_MS;
  const asked = typeof requested === 'number' && Number.isFinite(requested) ? requested : log.config.timeoutMs;
  const budget = Math.min(asked, log.config.timeoutMs, remaining);
  if (budget < 1000) {
    fail('model_unavailable', `本次调用剩余时间不足以发起模型请求（剩余约 ${Math.max(0, Math.round(remaining))}ms）`);
  }
  return Math.floor(budget);
}

/** 写一条调用记录并累加月度汇总；记账失败不推翻已经完成的模型调用，但要在返回值里告警。 */
async function record(log: RunLog, entry: SubCallRecord): Promise<void> {
  try {
    await recordSubCall(db, entry, log.config, new Date());
    log.summary = applyRecord(log.summary, entry);
  } catch (error) {
    log.warnings.push(`用量记账失败，本次成本未计入月度累计：${describeError(error)}`);
  }
}

/** 调用模型并记账：成功与失败都留下记录（失败调用同样是排查线索）。 */
async function invokeModel(log: RunLog, target: ModelTarget, invocation: ModelInvocation): Promise<ModelCallResult> {
  const startedAt = Date.now();
  try {
    const result = await callModel(target, invocation);
    log.provider = target.format;
    log.model = target.model;
    log.usage = toCallUsage(result.usage, log.config);
    await record(log, {
      requestId: log.requestId,
      feature: log.feature,
      action: log.action,
      kind: 'model',
      provider: target.format,
      model: target.model,
      ok: true,
      failureClass: '',
      durationMs: result.elapsedMs,
      usage: log.usage,
    });
    return result;
  } catch (error) {
    const failure = toFailure(error);
    log.provider = target.format;
    log.model = target.model;
    await record(log, {
      requestId: log.requestId,
      feature: log.feature,
      action: log.action,
      kind: 'model',
      provider: target.format,
      model: target.model,
      ok: false,
      failureClass: failure.failureClass,
      durationMs: Date.now() - startedAt,
      usage: toCallUsage(ZERO_USAGE, log.config),
    });
    throw failure;
  }
}

/**
 * 文字内容安全检测（长文本分片）。
 * 分片是为了兼容微信 msgSecCheck 的 2500 字上限；超过 `MAX_MODERATION_CHUNKS` 段的部分
 * **不检测**，只在报告里写明——不做「假装检过」的事。
 */
async function moderateText(log: RunLog, text: string, wechat: WechatSecurityApi | undefined, openid: string): Promise<SafetyOutcome> {
  const chunks: string[] = [];
  for (let index = 0; index < text.length && chunks.length < MAX_MODERATION_CHUNKS; index += MODERATION_CHUNK_CHARS) {
    chunks.push(text.slice(index, index + MODERATION_CHUNK_CHARS));
  }
  if (chunks.length === 0) chunks.push('');
  const truncated = text.length > MODERATION_CHUNK_CHARS * MAX_MODERATION_CHUNKS;
  let last: SafetyOutcome | null = null;
  for (const chunk of chunks) {
    const outcome = await checkSafely(log, () => checkText(log.config, { text: chunk, wechat, openid }), 'text-moderation');
    last = outcome;
    if (outcome.rejected) return outcome;
  }
  if (last === null) fail('internal', '内容安全检测没有产生任何结果');
  if (truncated) {
    return {
      ...last,
      report: {
        ...last.report,
        detail: `${last.report.detail}｜文本超过 ${MODERATION_CHUNK_CHARS * MAX_MODERATION_CHUNKS} 字，仅检测了前 ${MAX_MODERATION_CHUNKS} 段`,
      },
    };
  }
  return last;
}

/** 图片内容安全检测入口（与文字分开）。 */
async function moderateImage(
  log: RunLog,
  image: NormalizedImage,
  wechat: WechatSecurityApi | undefined,
  openid: string,
): Promise<SafetyOutcome> {
  return checkSafely(log, () => checkImage(log.config, { image, wechat, openid }), 'image-moderation');
}

/** 内容安全检测的记账包装：检测本身的失败也要留记录，然后按原分类抛出。 */
async function checkSafely(log: RunLog, run: () => Promise<SafetyOutcome>, api: string): Promise<SafetyOutcome> {
  const startedAt = Date.now();
  try {
    const outcome = await run();
    log.safety = outcome.report;
    await record(log, {
      requestId: log.requestId,
      feature: log.feature,
      action: log.action,
      kind: 'moderation',
      provider: outcome.report.provider,
      model: outcome.model,
      // 违规判定是**检测成功**的结果，不算调用失败；检测服务不可用才算失败。
      ok: true,
      failureClass: '',
      durationMs: outcome.durationMs,
      usage: outcome.usage === null ? toCallUsage(ZERO_USAGE, log.config) : toCallUsage(outcome.usage, log.config),
    });
    return outcome;
  } catch (error) {
    const failure = toFailure(error);
    await record(log, {
      requestId: log.requestId,
      feature: log.feature,
      action: log.action,
      kind: 'moderation',
      provider: log.config.safety.provider,
      model: api,
      ok: false,
      failureClass: failure.failureClass,
      durationMs: Date.now() - startedAt,
      usage: toCallUsage(ZERO_USAGE, log.config),
    });
    throw failure;
  }
}

/** 内容被判违规：统一抛 `content_rejected`，细节留给维护者。 */
function rejectContent(outcome: SafetyOutcome): never {
  fail('content_rejected', `${outcome.report.provider}｜${outcome.report.api}｜${outcome.report.detail}`);
}

/**
 * 读当月用量。
 * 读不到用量就无法判断上限，读失败按**拒绝调用**处理（fail closed），而不是当作零继续跑。
 * 上限判定（assertWithinCap）不在这里做：查用量本身不该被上限挡住。
 */
async function readSummary(config: Config, now: Date): Promise<UsageSummary> {
  try {
    return await readUsageSummary(db, config, now);
  } catch (error) {
    fail('internal', `读取月度用量失败，无法判断成本上限：${describeError(error)}`);
  }
}

/**
 * chat / vision 的完整流水线：配额 → 输入检测 → 模型 → 输出检测。
 * 顺序是刻意的：先判上限（不该花的钱不花）、先检输入（违规内容不送第三方）、再检输出（生成内容不上屏前不放手）。
 */
async function runModelAction(log: RunLog, event: AiEvent, startedAt: number): Promise<string> {
  const vision = log.action === 'vision';
  const messages = parseMessages(event.messages);
  const system = safeString(event.system);
  const wechat = wechatSecurity();
  const openid = currentOpenid();

  if (!vision && event.image !== undefined && event.image !== null) {
    fail('invalid_request', '图片请走 vision 动作；chat 动作只处理文字');
  }
  let image: NormalizedImage | undefined;
  if (vision) {
    if (event.image === undefined || event.image === null) {
      fail('invalid_request', 'vision 动作需要 image（云存储 fileID 或 base64）');
    }
    image = await resolveImage(event.image, log.config);
    attachImage(messages, image);
  }

  // 1) 输入内容安全：用户提问与上传的图片都要先过检测。
  if (image !== undefined) {
    const imageOutcome = await moderateImage(log, image, wechat, openid);
    if (imageOutcome.rejected) rejectContent(imageOutcome);
  }
  const inputText = userText(messages);
  if (inputText !== '') {
    const textOutcome = await moderateText(log, inputText, wechat, openid);
    if (textOutcome.rejected) rejectContent(textOutcome);
  }

  // 2) 模型调用（带明确超时边界）。
  const target = resolveModelTarget(log.config, {
    vision,
    maxTokens: typeof event.maxTokens === 'number' ? event.maxTokens : undefined,
    timeoutMs: modelTimeoutMs(log, startedAt, event.timeoutMs),
  });
  const result = await invokeModel(log, target, {
    system,
    messages,
    maxTokens: target.maxTokens,
    timeoutMs: target.timeoutMs,
  });

  // 3) 输出内容安全：AI 生成的文字上屏前再检一次。
  if (log.config.moderateOutput && result.text !== '') {
    const outputOutcome = await moderateText(log, result.text, wechat, openid);
    if (outputOutcome.rejected) rejectContent(outputOutcome);
  }
  return result.text;
}

function baseResponse(options: {
  log: RunLog | null;
  action: ActionName | '';
  feature: string;
  startedAt: number;
}): AiResponse {
  const { log } = options;
  return {
    ok: false,
    action: options.action,
    failureClass: '',
    message: '',
    detail: '',
    feature: options.feature,
    provider: log === null ? '' : log.provider,
    model: log === null ? '' : log.model,
    text: '',
    safety: log === null ? null : log.safety,
    usage: log === null ? null : log.usage,
    usageSummary: log === null ? null : log.summary,
    capWarning: log === null ? '' : capWarningFor(log.summary),
    warnings: log === null ? [] : log.warnings.slice(),
    probe: null,
    elapsedMs: Date.now() - options.startedAt,
  };
}

/** 失败返回：带分类与独立文案，`detail` 已剔除密钥。 */
function failureResponse(error: unknown, options: {
  log: RunLog | null;
  action: ActionName | '';
  feature: string;
  startedAt: number;
  secrets: string[];
}): AiResponse {
  const failure: AiFailure = toFailure(error);
  const response = baseResponse(options);
  response.ok = false;
  response.failureClass = failure.failureClass;
  response.message = failure.message;
  response.detail = redactSecrets(failure.detail, options.secrets);
  return response;
}

function successResponse(log: RunLog, action: ActionName, startedAt: number): AiResponse {
  const response = baseResponse({ log, action, feature: log.feature, startedAt });
  response.ok = true;
  return response;
}

/**
 * 云函数入口。
 *
 * **不抛异常**：任何失败都变成带分类的返回值（调用方拿到的是可处理的错误）。
 * 失败时也尽量返回当月用量，便于页面与维护者判断是不是撞上了上限。
 */
export async function main(event: AiEvent = {}): Promise<AiResponse> {
  const startedAt = Date.now();
  const now = new Date();
  const requestId = newRequestId(now);
  const secrets: string[] = [];
  const action = sanitizeAction(event.action);
  const feature = sanitizeFeature(event.feature, action);

  // 探测不需要模型配置：维护者可能还没配密钥就先跑它。
  if (action === 'probe') {
    try {
      const result = await runProbe({ wechat: wechatSecurity(), openid: currentOpenid(), env: currentEnv(), now });
      return {
        ok: result.ok,
        action,
        failureClass: '',
        message: result.conclusion,
        detail: result.pasteLine,
        feature,
        provider: 'wechat',
        model: 'security.msgSecCheck / security.imgSecCheck',
        text: '',
        safety: null,
        usage: null,
        usageSummary: null,
        capWarning: '',
        warnings: [],
        probe: result.record,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      return failureResponse(error, { log: null, action, feature, startedAt, secrets });
    }
  }

  let log: RunLog | null = null;
  try {
    const config = loadConfig();
    secrets.push(...secretsOf(config));
    if (action === null) {
      fail('invalid_request', `未知动作「${safeString(event.action)}」，可用动作：${ALLOWED_ACTIONS.join('、')}`);
    }
    const summary = await readSummary(config, now);
    log = {
      requestId,
      feature,
      action,
      config,
      summary,
      usage: null,
      provider: '',
      model: '',
      safety: null,
      warnings: [],
    };

    // 查用量在任何情况下都要能用（哪怕已经超上限），因此先于上限判定返回。
    if (action === 'usage') {
      const response = successResponse(log, action, startedAt);
      response.message = capWarningFor(summary);
      response.detail = `当月累计 ${summary.calls} 次调用、${summary.totalTokens} token、${summary.costYuan} 元`
        + `（上限 ${summary.capYuan} 元，告警线 ${summary.warnThresholdYuan} 元）`;
      return response;
    }

    // 上限判定：达到上限直接拒绝，接近阈值只告警（告警随返回值带出）。
    assertWithinCap(summary);

    if (action === 'moderateText') {
      const text = safeString(event.text);
      if (text === '') fail('invalid_request', 'moderateText 需要 text');
      const outcome = await moderateText(log, text, wechatSecurity(), currentOpenid());
      const response = successResponse(log, action, startedAt);
      response.safety = outcome.report;
      if (outcome.rejected) {
        response.ok = false;
        response.failureClass = 'content_rejected';
        response.message = messageFor('content_rejected');
        response.detail = `${outcome.report.provider}｜${outcome.report.api}｜${outcome.report.detail}`;
      }
      return response;
    }

    if (action === 'moderateImage') {
      if (event.image === undefined || event.image === null) fail('invalid_request', 'moderateImage 需要 image（fileID 或 base64）');
      const image = await resolveImage(event.image, log.config);
      const outcome = await moderateImage(log, image, wechatSecurity(), currentOpenid());
      const response = successResponse(log, action, startedAt);
      response.safety = outcome.report;
      if (outcome.rejected) {
        response.ok = false;
        response.failureClass = 'content_rejected';
        response.message = messageFor('content_rejected');
        response.detail = `${outcome.report.provider}｜${outcome.report.api}｜${outcome.report.detail}`;
      }
      return response;
    }

    const text = await runModelAction(log, event, startedAt);
    const response = successResponse(log, action, startedAt);
    response.text = text;
    return response;
  } catch (error) {
    // catch 里 action 仍可能是 null（未知动作/在读配置前就失败），统一收敛成空字符串。
    return failureResponse(error, { log, action: action ?? '', feature, startedAt, secrets });
  }
}

/** 供测试与文档核对的导出（失败分类清单与必需的三类）。 */
export { REQUIRED_FAILURE_CLASSES } from './errors';
export type { FailureClass };
