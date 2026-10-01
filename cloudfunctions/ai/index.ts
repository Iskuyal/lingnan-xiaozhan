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
 * - `probe`：探测微信官方内容安全接口是否可用（**必须从小程序端触发**，如 `npm run probe:wechat`；控制台「测试」页拿不到云调用票据，只会得到 -501001）。
 *
 * 硬约束（见 docs/product/spec.md「AI 功能」）：
 * - 密钥只在云函数环境变量，不进代码、数据库与小程序包；
 * - 单次调用有明确超时边界，整体还有一次云函数调用的总截止；
 * - 三类失败可区分、文案各自独立，且**任何情况都不向调用方抛裸异常**。
 */
import * as cloud from 'wx-server-sdk';
import { Config, ModelTarget, loadConfig, resolveModelTarget, secretsOf } from './config';
import { AiFailure, MessageInputKind, describeError, fail, messageFor, redactSecrets, toFailure } from './errors';
import { isTimeoutError, withTimeout } from './http';
import { ModelCallResult, ModelInvocation, callModel } from './providers';
import { SafetyOutcome, WechatSecurityApi, checkImage, checkText, rejectionDetail } from './safety';
import { runProbe } from './probe';
import { buildActivityContext, DepartmentActivityCorpus, isActivityQuestion, isDepartmentActivityCorpus } from './rag';
import {
  ActionName,
  AiResponse,
  CallUsage,
  ConversationMessage,
  DepartmentActivityCitation,
  FailureClass,
  MessageRole,
  NormalizedImage,
  SafetyReport,
  SubCallRecord,
  TokenUsage,
  UsageSummary,
} from './types';
import {
  UsageDb,
  acquireAccountingGate,
  applyRecord,
  assertWithinCap,
  assertNoUnaccountedRecords,
  capWarningFor,
  newRequestId,
  readUsageSummary,
  releaseAccountingGate,
  recordSubCall,
  shanghaiMonth,
  sumCallUsage,
  toCallUsage,
  unknownUsage,
} from './usage';
import { BandCallResult, VISION_PROFILE, bandMaxTokens, bandedSystem, mergeBands, planBands, predictSeconds } from './vision';
import { assertAdmin, assertOwnPhotoFile, consumeProbeWindow, consumeUserLimits, isAdmin, requireOpenid, userKey } from './access';
import {
  ADVANCEMENT_QA_FEATURE,
  AdvancementCorpus,
  AdvancementResult,
  injectedAdvancementText,
  isAdvancementCorpus,
  resolveAdvancementScope,
  resolveAdvancementSources,
  verifyAdvancementAnswer,
} from './advancement';
import {
  DEFENSE_FEATURE,
  defenseMaterialIds,
  defenseSystem,
  loadDefenseMaterials,
  verifyDefenseAnswer,
} from './defense';

// wx-server-sdk 4.0.2 的 d.ts 把 DYNAMIC_CURRENT_ENV 声明为 symbol，而 init 的 env 参数
// 类型未包含 symbol —— 属于类型声明滞后，运行时是官方推荐用法（与 newsSync 一致）。
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV as unknown as string });

const db = cloud.database() as unknown as UsageDb;

const ALLOWED_ACTIONS: ActionName[] = ['chat', 'vision', 'moderateText', 'moderateImage', 'usage', 'probe'];
/** 一次请求最多带多少消息：防止调用方把整段历史塞进来把成本放大。 */
const MAX_MESSAGES = 20;
/** 单条消息最大长度（字符）：超出按参数错误处理，让调用方自己截断比默默截断可控。 */
const MAX_MESSAGE_CHARS = 8000;
/**
 * 答辩练习的材料上限（字符）：材料要整段拼进 system 与所有消息一起过内容安全，
 * 事实卡两份合计约 3 千字级；给到 4000 留余量，再多按参数错误拒绝而不是悄悄截断材料
 * （截掉的若是条目行，回答引用它就变成「引用不存在的编号」）。
 */
const MAX_DEFENSE_MATERIAL_CHARS = 4000;
/** 材料 id 的长度上限：id 由服务端登记（`FC-1` / `FC-2`），这里只是别让超长字符串进日志。 */
const MAX_DEFENSE_MATERIAL_ID_CHARS = 32;
/** 微信 msgSecCheck 的 content 上限是 2500 字；分片检测每次不超过 2000 字。 */
const MODERATION_CHUNK_CHARS = 2000;
/** 输入侧最多分几片：2000 字 × 10 = 2 万字。见 `MAX_INPUT_CHARS`。 */
const MAX_INPUT_CHUNKS = 10;
/**
 * 一次调用的输入上限（字符）= 一次检测能覆盖的字数。
 *
 * 输入长度由调用方决定，因此超窗口的部分**不能靠「多检几片」兜住**，也不允许带着
 * `checked: false` 继续送模型——窗口外的文字等于绕过内容安全。超出即按参数错误拒绝
 * （fail-closed），由调用方精简历史后重试。
 */
const MAX_INPUT_CHARS = MODERATION_CHUNK_CHARS * MAX_INPUT_CHUNKS;
/**
 * 输出侧最多分几片：2000 字 × 20 = 4 万字。
 *
 * 输出长度不受调用方控制，不能靠「拒绝调用」在事前兜住，所以给的分片比输入多一档
 * （分带识别的合并结果可以上万字）；仍然超出时按失败处理，**绝不返回没检过的文字**。
 * 每片都是一次微信检测调用，档位同时是每日配额的暴露上限。
 */
const MAX_OUTPUT_CHUNKS = 20;
const MAX_OUTPUT_CHARS = MODERATION_CHUNK_CHARS * MAX_OUTPUT_CHUNKS;
/** 留给内容安全与记账的时间（毫秒）：模型调用不能把总截止用满。 */
const TIMEOUT_RESERVE_MS = 500;
const ALLOWED_IMAGE_MIME = ['image/png', 'image/jpeg'];
/** 消息角色只认这三种；调用方写别的值按参数错误处理，不做猜测。 */
const MESSAGE_ROLES: MessageRole[] = ['system', 'user', 'assistant'];

/**
 * 部门问答的 feature 名（客户端 `miniprogram/services/ai.ts` 导出同名常量、两个部门页面使用；
 * 跨包有意复制一份，项目惯例同 FAILURE_CLASSES）。
 * 只有这个 feature 的 chat 动作会做部门动态检索注入，其余动作与功能不受影响。
 */
const DEPARTMENT_QA_FEATURE = 'department-qa';
/** 部门动态检索注入的 top-k：动态条目只有标题级信息，三条足够覆盖且不挤占提示词预算。 */
const ACTIVITY_RETRIEVAL_K = 3;

/**
 * 构建注入的部门动态语料（scripts/build.mjs → dist/cloudfunctions/ai/department-corpus.js）。
 *
 * 缺失或读坏时返回 null：检索注入整体禁用、问答退回纯语料模式（fail-open）——
 * 检索是增强不是前提，语料出问题不能把原有的部门问答链路一起拖垮。
 */
function loadDepartmentCorpus(): DepartmentActivityCorpus | null {
  try {
    const loaded: unknown = require('./department-corpus');
    return isDepartmentActivityCorpus(loaded) ? loaded : null;
  } catch {
    return null;
  }
}
const departmentCorpus = loadDepartmentCorpus();

/**
 * 构建注入的升学语料（scripts/build.mjs → dist/cloudfunctions/ai/advancement-corpus.js）。
 *
 * 与部门语料的 fail-open 相反：这份语料是升学问答的**前提**——回答只能建立在可信段落上，
 * 缺失时按 `internal` 拒绝（fail-closed），不退化成凭模型常识回答。
 */
function loadAdvancementCorpus(): AdvancementCorpus | null {
  try {
    const loaded: unknown = require('./advancement-corpus');
    return isAdvancementCorpus(loaded) ? loaded : null;
  } catch {
    return null;
  }
}
const advancementCorpus = loadAdvancementCorpus();

/** 指代上一轮动态的短追问，须连同上一轮问题和回答检索，才能保留事实依据。 */
function activitySearchQuestion(messages: ConversationMessage[]): string {
  let currentIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user' && messages[i].text.trim() !== '') {
      currentIndex = i;
      break;
    }
  }
  if (currentIndex < 0) return '';
  const current = messages[currentIndex].text.trim();
  const followUp = /^(那|它|这个|这项|该|上面|刚才|前面|其中|第[一二三1-3]个)/u.test(current);
  if (followUp) {
    for (let i = currentIndex - 1; i >= 0; i -= 1) {
      if (messages[i].role !== 'user') continue;
      if (isActivityQuestion(messages[i].text)) {
        const answer = messages.slice(i + 1, currentIndex)
          .filter((message) => message.role === 'assistant').at(-1)?.text.slice(0, 500) ?? '';
        return `${messages[i].text} ${answer} ${current}`;
      }
      break;
    }
  }
  return isActivityQuestion(current) ? current : '';
}

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
  userKey: string;
  isAdmin: boolean;
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
  accountingFailed: boolean;
  /** 部门动态检索注入的引用清单（chat 动作才可能有值）。 */
  activityCitations: DepartmentActivityCitation[];
  /** 升学问答的引用与出处校验结论（advancement-qa 的 chat 动作才可能有值）。 */
  advancementResult: AdvancementResult | null;
}

const ZERO_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  estimated: false,
  usageUnknown: false,
};

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

/**
 * 从 fileID 的扩展名判断 MIME；**判断不出来就返回 null**。
 * 不能默认按 PNG：那会让 `.gif` / `.webp` / 无扩展名的非图片文件悄悄通过格式门，
 * 到了微信 imgSecCheck 才被拒，错误位置离原因很远。
 */
function mimeFromFileID(fileID: string): string | null {
  const lower = fileID.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return null;
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
 * 格式判断不出来时**报参数错误**，不猜一个默认值——猜错会让非图片通过格式门。
 */
async function resolveImage(raw: unknown, config: Config, openid: string): Promise<NormalizedImage> {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    fail('invalid_request', '图片参数需要 {"fileID":"cloud://..."} 或 {"base64":"..."}');
  }
  const source = raw as { fileID?: unknown; base64?: unknown; mimeType?: unknown };
  let base64 = '';
  let mimeType = safeString(source.mimeType).toLowerCase();
  if (typeof source.fileID === 'string' && source.fileID !== '') {
    assertOwnPhotoFile(source.fileID, openid);
    let content: Buffer;
    try {
      // 下载走硬超时：云存储同样可能一直不返回，不能让一次 vision 调用无限挂起。
      const downloaded = await withTimeout(
        cloud.downloadFile({ fileID: source.fileID }) as Promise<unknown>,
        config.downloadTimeoutMs,
        '云存储图片下载',
      );
      const value = downloaded === null || downloaded === undefined
        ? undefined
        : (downloaded as { fileContent?: unknown }).fileContent;
      if (!Buffer.isBuffer(value)) fail('invalid_request', '云存储图片下载结果异常');
      content = value as Buffer;
    } catch (error) {
      if (error instanceof AiFailure) throw error;
      if (isTimeoutError(error)) {
        fail('model_unavailable', `云存储图片下载超时（${config.downloadTimeoutMs}ms，AI_DOWNLOAD_TIMEOUT_MS）`);
      }
      fail('invalid_request', '云存储图片下载失败');
    }
    if (mimeType === '') {
      const guessed = mimeFromFileID(source.fileID);
      if (guessed === null) {
        fail(
          'invalid_request',
          `无法从 fileID 判断图片格式；请在 image.mimeType 里显式给出（${ALLOWED_IMAGE_MIME.join(' / ')}）`,
        );
      }
      mimeType = guessed;
    }
    base64 = content.toString('base64');
  } else if (typeof source.base64 === 'string' && source.base64.trim() !== '') {
    const parsed = stripDataUrl(source.base64);
    base64 = parsed.base64;
    if (mimeType === '' && parsed.mimeType !== '') mimeType = parsed.mimeType;
  } else {
    fail('invalid_request', '图片参数需要 fileID 或 base64');
  }
  if (mimeType === '') {
    fail(
      'invalid_request',
      `base64 图片必须显式给出 mimeType（${ALLOWED_IMAGE_MIME.join(' / ')}），或用 data:image/png;base64,… 形式；`
      + '默认按 PNG 处理会让非图片悄悄通过格式门，因此不再猜。',
    );
  }
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

/**
 * 解析对话消息：调用方可以写 `text` 或 `content`（两种命名都常见）。
 * `role` 必须是 user / assistant / system 之一：写别的值（或干脆不写）按参数错误处理——
 * 默默当成 `user` 会改变消息语义（谁说的、要不要过检），属于猜测而不是容错。
 */
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
    const rawRole = safeString(source.role);
    if (!(MESSAGE_ROLES as string[]).includes(rawRole)) {
      fail('invalid_request', `messages 的 role 只接受 ${MESSAGE_ROLES.join(' / ')}，收到「${rawRole === '' ? '（缺省）' : rawRole}」`);
    }
    const role = rawRole as MessageRole;
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

/**
 * 本次调用要过检的全部文字：**所有消息**（system / user / assistant）与事件顶层的 system，
 * 以及其中 system 占的字符数（上限拒绝的 detail 要报这个数，拼接规则因此只留这一处）。
 *
 * 只检 user 是漏检：system 与 assistant 历史同样是调用方送进来的、同样会进入第三方模型的文本，
 * 违规内容从这里进去一样是问题（规格把「AI 文字都要过内容安全」列为硬约束）。
 */
function inputText(messages: ConversationMessage[], system: string): { text: string; systemChars: number } {
  const parts: string[] = [];
  const withSystem = system.trim() !== '';
  if (withSystem) parts.push(system);
  for (const message of messages) {
    if (message.text !== '') parts.push(message.text);
  }
  return { text: parts.join('\n'), systemChars: withSystem ? system.length : 0 };
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

/**
 * 内容安全检测的超时：同样受总截止约束（内容安全 + 模型 + 输出检测都在一个云函数调用里），
 * 至少留 1 秒，避免算出来是 0 而直接失败。
 */
function moderationTimeoutMs(log: RunLog, startedAt: number): number {
  const remaining = log.config.totalDeadlineMs - (Date.now() - startedAt) - TIMEOUT_RESERVE_MS;
  return Math.max(1000, Math.min(log.config.safety.timeoutMs, Math.floor(remaining)));
}

/** 去重地追加一条非致命告警（同一原因在一次调用里只出现一次）。 */
function pushWarning(log: RunLog, warning: string): void {
  if (!log.warnings.includes(warning)) log.warnings.push(warning);
}

/** 写一条调用记录并累加月度汇总；记账失败不推翻已经完成的模型调用，但要在返回值里告警。 */
async function record(log: RunLog, entry: Omit<SubCallRecord, 'userKey'>): Promise<void> {
  try {
    const recordWithUser = { ...entry, userKey: log.userKey };
    await recordSubCall(db, recordWithUser, log.config, new Date());
    log.summary = applyRecord(log.summary, recordWithUser);
  } catch (error) {
    log.accountingFailed = true;
    pushWarning(log, `用量记账失败，本次成本未计入月度累计：${describeError(error)}`);
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
 *
 * 分片是为了兼容微信 msgSecCheck 的 2500 字上限；**分到 `maxChunks` 片为止**。
 * 仍然超出时，没检测的部分明确写进报告并把 `checked` 置为 false——既不静默放过，
 * 也不让调用方以为整段都检过了。
 *
 * 调用方必须自己保证「不该出现这种报告」：输入侧靠 `MAX_INPUT_CHARS` 在事前拒绝，
 * 输出侧靠 `MAX_OUTPUT_CHARS` 在事前失败（见 `moderateOutput`）。只有诊断动作
 * （`moderateText`）会把这个部分报告直接交给调用方。
 */
async function moderateText(
  log: RunLog,
  text: string,
  wechat: WechatSecurityApi | undefined,
  openid: string,
  startedAt: number,
  maxChunks: number,
): Promise<SafetyOutcome> {
  const chunks: string[] = [];
  for (let index = 0; index < text.length && chunks.length < maxChunks; index += MODERATION_CHUNK_CHARS) {
    chunks.push(text.slice(index, index + MODERATION_CHUNK_CHARS));
  }
  if (chunks.length === 0) chunks.push('');
  const coveredChars = Math.min(text.length, MODERATION_CHUNK_CHARS * maxChunks);
  const truncated = text.length > coveredChars;
  let last: SafetyOutcome | null = null;
  for (const chunk of chunks) {
    const outcome = await checkSafely(
      log,
      () => checkText(log.config, { text: chunk, wechat, openid, timeoutMs: moderationTimeoutMs(log, startedAt) }),
      'text-moderation',
    );
    last = outcome;
    if (outcome.rejected) return outcome;
  }
  if (last === null) fail('internal', '内容安全检测没有产生任何结果');
  if (truncated) {
    // 检测只覆盖了前一段：把范围写进报告并置 checked=false，同时让它成为本次调用的结论
    // （`checked` 只降不升，后面的输出检测不会把它冲回 true）。
    const partial: SafetyOutcome = {
      ...last,
      report: {
        ...last.report,
        checked: false,
        detail: `${last.report.detail}｜文本共 ${text.length} 字，仅检测了前 ${coveredChars} 字（超过 ${MODERATION_CHUNK_CHARS}×${maxChunks} 字上限的部分未检测）`,
      },
    };
    recordSafety(log, partial.report);
    noteUnchecked(log, partial);
    return partial;
  }
  return last;
}

/** 图片内容安全检测入口（与文字分开）。 */
async function moderateImage(
  log: RunLog,
  image: NormalizedImage,
  wechat: WechatSecurityApi | undefined,
  openid: string,
  startedAt: number,
): Promise<SafetyOutcome> {
  return checkSafely(
    log,
    () => checkImage(log.config, { image, wechat, openid, timeoutMs: moderationTimeoutMs(log, startedAt) }),
    'image-moderation',
  );
}

/**
 * 记录本次调用的内容安全结论。
 * 一次 chat 会做多次检测（输入图片、输入文字、输出文字），而返回值只有一个 `safety` 字段：
 * 正常情况下用最后一步（输出检测）的报告；但只要**任何一步没检全**，就保留那一条——
 * 不能让后面一步的 `checked: true` 把「有内容没检过」冲掉。
 */
function recordSafety(log: RunLog, report: SafetyReport): void {
  if (log.safety !== null && log.safety.checked === false) return;
  log.safety = report;
}

/**
 * 检测被跳过或只做了一部分时，在返回值里留一条告警。
 * 只看 `report.detail` 不够：调用方很可能只读 `passed`，把「跳过」读成「干净」。
 */
function noteUnchecked(log: RunLog, outcome: SafetyOutcome): void {
  if (outcome.report.checked) return;
  pushWarning(log, `内容安全检测未完整执行（checked=false）：${rejectionDetail(outcome)}`);
}

/** 内容安全检测的记账包装：检测本身的失败也要留记录，然后按原分类抛出。 */
async function checkSafely(log: RunLog, run: () => Promise<SafetyOutcome>, api: string): Promise<SafetyOutcome> {
  const startedAt = Date.now();
  try {
    const outcome = await run();
    recordSafety(log, outcome.report);
    noteUnchecked(log, outcome);
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
      usage: moderationUsage(log, outcome),
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

/**
 * 一次检测的用量与金额。
 * - 有 token 用量（第三方 chat 判定）→ 按单价算；
 * - 用量未知（OpenAI `/moderations` 不返回 usage）→ 按可配置的「每次审核固定价」计，
 *   并标记 `usageUnknown`；**不静默记成 0 元**，同时留一条告警说明这一次是怎么记的；
 * - 微信云调用不返回用量且免费 → 0 元、不计入，也不报警。
 */
function moderationUsage(log: RunLog, outcome: SafetyOutcome): CallUsage {
  if (outcome.usage !== null) return toCallUsage(outcome.usage, log.config);
  if (!outcome.usageUnknown) return toCallUsage(ZERO_USAGE, log.config);
  const fixedPriceYuan = log.config.safety.fixedPriceYuan;
  pushWarning(
    log,
    fixedPriceYuan > 0
      ? `审核接口未返回 token 用量，本次按固定价 ${fixedPriceYuan} 元/次计入（AI_SAFETY_CALL_PRICE_YUAN）。`
      : '审核接口未返回 token 用量，金额记为 0 元但已标记 usageUnknown（次数照记）；'
        + '如需计入成本请配置 AI_SAFETY_CALL_PRICE_YUAN 为每次审核的固定价。',
  );
  return unknownUsage(fixedPriceYuan, log.config);
}

/** 内容被判违规：统一抛 `content_rejected`，细节留给维护者；图片用专属文案（换一张）。 */
function rejectContent(outcome: SafetyOutcome, inputKind: MessageInputKind = 'text'): never {
  throw new AiFailure('content_rejected', rejectionDetail(outcome), { message: messageFor('content_rejected', inputKind) });
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
 * 输出内容安全检测：AI 生成的文字上屏前再检一次。
 *
 * 输出长度不受调用方控制（分带识别的合并结果可能上万字），所以不能像输入那样靠
 * 「事前拒绝调用」兜底，只能：**先判长度、再逐段全检、全检通过才返回**。
 * 超过 `MAX_OUTPUT_CHARS`（分片上限）时这次就不给结果——宁可失败，
 * 也不把没检过的文字上屏（开发规格把这条列为硬约束）。
 *
 * 分类用 `internal` 而不是 `model_unavailable`：模型这次是**成功返回**的，失败的是
 * 「本地没能把这段输出检完」，与「内容安全检测不可用」同族（都是 fail-closed 的
 * 服务端能力缺口）；记成模型不可用会把这类事件混进模型/中转的失败统计里。
 */
async function moderateOutput(
  log: RunLog,
  text: string,
  wechat: WechatSecurityApi | undefined,
  openid: string,
  startedAt: number,
): Promise<void> {
  if (!log.config.moderateOutput || text === '') return;
  if (text.length > MAX_OUTPUT_CHARS) {
    fail(
      'internal',
      `模型输出 ${text.length} 字，超过一次检测能覆盖的 ${MAX_OUTPUT_CHARS} 字（${MODERATION_CHUNK_CHARS}×${MAX_OUTPUT_CHUNKS}）：`
      + '为避免未经检测的文字上屏，本次不返回结果。',
      { message: '这次的 AI 回答过长，无法完整做内容安全检查，已丢弃该回答；请重试或把问题问得更具体一些。' },
    );
  }
  const outputOutcome = await moderateText(log, text, wechat, openid, startedAt, MAX_OUTPUT_CHUNKS);
  if (outputOutcome.rejected) rejectContent(outputOutcome);
}

/**
 * `vision` 的模型调用：单带走原路径，多带则并行多次调用并在服务端合并成**一个** JSON。
 *
 * 分带只改变「发几次模型调用」，**图片与输入文字的内容安全仍然各只做一次**
 * （在 runModelAction 里已完成）——每带各检一次会让微信内容安检的每日配额按带数消耗，
 * 而配额用尽是 fail-closed 的（当天三处 AI 全部不可用）。
 */
async function runVision(
  log: RunLog,
  event: AiEvent,
  target: ModelTarget,
  context: { system: string; messages: ConversationMessage[] },
): Promise<string> {
  const bands = planBands(event.bands, target.timeoutMs);
  // 分带时每一带仍要出「本带课程数」那么多内容：调用方给的上限是按整张表设的，
  // 直接沿用会把较大的带截断（截断的 JSON 解析不出来，看起来像模型失败）。
  const perCallMaxTokens = bands.length <= 1 ? target.maxTokens : bandMaxTokens(bands.length, target.maxTokens);
  const call = (system: string): Promise<ModelCallResult> => invokeModel(log, target, {
    system,
    messages: context.messages,
    maxTokens: perCallMaxTokens,
    timeoutMs: target.timeoutMs,
  });
  if (bands.length <= 1) return (await call(context.system)).text;

  const startedAt = Date.now();
  // 每一带失败都要留住失败对象而不是立刻抛出：一带超时不该让其余带的结果一起丢掉。
  const settled = await Promise.all(bands.map(async (band): Promise<{ band: BandCallResult; usage: CallUsage | null; failure: AiFailure | null }> => {
    try {
      const result = await call(bandedSystem(context.system, band));
      // 输出被上限截断要能被识别：否则截断的 JSON 会被读成「这一带没有可用结果」，
      // 排查时会往模型或并发方向找，而真正的原因是上限不够。
      if (result.finishReason === 'length') {
        pushWarning(log, `第 ${band.from}-${band.to} 节这一带的输出达到上限（finish_reason=length，上限 ${perCallMaxTokens} token），结果可能被截断。`);
      }
      return {
        band: { band, ok: true, text: result.text },
        usage: toCallUsage(result.usage, log.config),
        failure: null,
      };
    } catch (error) {
      return { band: { band, ok: false, text: '' }, usage: null, failure: toFailure(error) };
    }
  }));

  const usages = settled.flatMap((item) => (item.usage === null ? [] : [item.usage]));
  // 全带都失败时保持 `usage: null`（与单带的失败路径一致）：没有成功的模型调用就没有用量，
  // 记一个 0 会被读成「这次没花钱」。
  if (usages.length > 0) log.usage = sumCallUsage(usages, log.config);
  for (const item of settled) {
    if (item.failure === null) continue;
    // detail 里可能有上游响应片段：返回值会带上这条告警，因此截断后再拼，不让它无限长。
    pushWarning(log, `第 ${item.band.band.from}-${item.band.band.to} 节这一段识别失败（${item.failure.message}）：${item.failure.detail.slice(0, 200)}`);
  }

  const merged = mergeBands(settled.map((item) => item.band));
  // 一带都没成功：按第一次失败抛出，页面才能给出对应的降级文案（超时 / 限流 / 被拒）。
  const firstFailure = settled.find((item) => item.failure !== null);
  if (merged.succeeded === 0 && firstFailure !== undefined && firstFailure.failure !== null) {
    throw firstFailure.failure;
  }
  const coursesPerBand = Math.ceil(VISION_PROFILE.worstCaseCourses / bands.length);
  pushWarning(
    log,
    `分带识别：按节次分 ${bands.length} 带并行调用，成功 ${merged.succeeded} 带`
    + `（画像：固定 ${VISION_PROFILE.fixedSeconds} 秒 + ${VISION_PROFILE.tokensPerSecond} token/秒 + 每门课 ${VISION_PROFILE.tokensPerCourse} token，`
    + `按最坏 ${coursesPerBand} 门/带预计每带约 ${predictSeconds(coursesPerBand).toFixed(1)} 秒）`
    + `，每带预算 ${target.timeoutMs}ms、输出上限 ${perCallMaxTokens} token，本次耗时 ${Date.now() - startedAt}ms。`,
  );
  if (merged.failed.length > 0) {
    pushWarning(log, `没有可用识别结果的节次：${merged.failed.map((band) => `${band.from}-${band.to}`).join('、')}；其余节次的结果已返回。`);
  }
  return merged.text;
}

/**
 * chat / vision 的完整流水线：配额 → 输入检测 → 模型 → 输出检测。
 * 顺序是刻意的：先判上限（不该花的钱不花）、先检输入（违规内容不送第三方）、再检输出（生成内容不上屏前不放手）。
 */
async function runModelAction(log: RunLog, event: AiEvent, startedAt: number, openid: string): Promise<string> {
  const vision = log.action === 'vision';
  const messages = parseMessages(event.messages);
  let system = safeString(event.system);
  // 答辩练习的材料（见下面的 feature 分流）：在这里声明是为了让它同时被**输入检测之前**的
  // 注入与**模型返回之后**的引用校验读到。
  let defenseMaterial = '';
  const wechat = wechatSecurity();

  // 升学问答的资料注入：与部门动态同一时机（输入检测之前），但约束更硬——
  // 语料缺失、范围不全、段落 id 越权或与范围不符，一律**在这里就拒绝**（fail-closed）：
  // 没有可信依据时不发模型请求，也就不存在「模型凭常识补一个官方日期」的机会。
  if (!vision && log.feature === ADVANCEMENT_QA_FEATURE) {
    if (advancementCorpus === null) {
      fail('internal', '升学语料未随函数部署（dist/cloudfunctions/ai/advancement-corpus.js 缺失或损坏），升学问答拒答');
    }
    const scopeOutcome = resolveAdvancementScope(advancementCorpus, event.scope);
    if ('error' in scopeOutcome) fail('invalid_request', `升学问答范围校验未通过：${scopeOutcome.error}`);
    const sourceOutcome = resolveAdvancementSources(advancementCorpus, event.passageIds, scopeOutcome.scope);
    if ('error' in sourceOutcome) fail('invalid_request', `升学问答资料来源校验未通过：${sourceOutcome.error}`);
    system = `${system}\n\n${injectedAdvancementText(sourceOutcome.sources, scopeOutcome.scope)}`;
    log.advancementResult = {
      scope: scopeOutcome.scope,
      corpusVersion: advancementCorpus.version,
      sources: sourceOutcome.sources,
      verified: false,
      refused: false,
      violations: [],
    };
    pushWarning(log, `升学资料注入 ${sourceOutcome.sources.length} 段（语料版本 ${advancementCorpus.version}）`);
  }

  // 部门动态检索注入：在输入检测之前拼进 system，注入文本与消息一起过内容安全。
  // 只对动态类问题检索（意图词表见 rag.ts），无命中 / 非动态类 / 语料缺失时不注入（system 原样）。
  if (!vision && log.feature === DEPARTMENT_QA_FEATURE) {
    const query = activitySearchQuestion(messages);
    if (query !== '' && departmentCorpus !== null) {
      const context = buildActivityContext(departmentCorpus, query, ACTIVITY_RETRIEVAL_K);
      if (context.injectedText !== '') {
        system = `${system}\n\n${context.injectedText}`;
        log.activityCitations = context.citations;
        pushWarning(log, `部门动态检索命中 ${context.citations.length} 条（top-${ACTIVITY_RETRIEVAL_K}）`);
      }
    }
  }

  // 项目讲解与答辩练习的材料注入：与升学 / 部门同一时机（输入检测之前）。
  // 客户端**只发 materialId**，材料正文由服务端从构建产物（`defense-materials.js`，源自 G0 冻结件）取：
  // 判定是「回答能不能回核到当前材料」，材料必须由服务端持有，客户端自带一份「方便自己」的材料无效。
  // 这里**覆盖** system 而不是拼接：客户端传上来的 system 一律忽略——纪律提示词是服务端契约，
  // 材料只能作为被引用的资料拼在纪律之后（`defenseSystem`），调用方改不了判定口径。
  if (!vision && log.feature === DEFENSE_FEATURE) {
    const rawMaterialId = event.materialId;
    if (typeof rawMaterialId !== 'string' || rawMaterialId.trim() === '' || rawMaterialId.length > MAX_DEFENSE_MATERIAL_ID_CHARS) {
      fail('invalid_request', '项目讲解与答辩练习需要 materialId（材料 id，非空字符串）');
    }
    const materialId = rawMaterialId.trim();
    const materials = loadDefenseMaterials();
    if (materials === null) {
      fail('internal', '答辩练习材料未随函数部署（dist/cloudfunctions/ai/defense-materials.js 缺失或损坏），已拒绝调用');
    }
    const material = materials.find((item) => item.id === materialId);
    if (material === undefined) {
      fail('invalid_request', `答辩练习没有 id 为 ${materialId} 的材料（可用：${materials.map((item) => item.id).join('、')}）`);
    }
    if (material.text.length > MAX_DEFENSE_MATERIAL_CHARS) {
      fail('internal', `答辩练习材料 ${material.id} 有 ${material.text.length} 字，超过 ${MAX_DEFENSE_MATERIAL_CHARS} 字上限`);
    }
    defenseMaterial = material.text;
    system = defenseSystem(defenseMaterial);
    pushWarning(log, `答辩练习材料 ${material.id} 注入 ${defenseMaterial.length} 字，可引用条目 ${defenseMaterialIds(defenseMaterial).length} 条`);
  }

  // 1) 输入长度：**先判上限再花任何检测配额或下载图片**。检测窗口覆盖不了的文字等于绕过
  //    内容安全，因此超窗口不是「检一部分就放行」，而是直接按参数错误拒绝，由调用方精简后重试。
  const input = inputText(messages, system);
  if (input.text.length > MAX_INPUT_CHARS) {
    fail(
      'invalid_request',
      `本次输入共 ${input.text.length} 字（其中 system ${input.systemChars} 字），`
      + `超过一次内容安全检测能覆盖的 ${MAX_INPUT_CHARS} 字（${MODERATION_CHUNK_CHARS}×${MAX_INPUT_CHUNKS}）：`
      + '未过检的文字不能送进模型，请调用方精简历史或材料后重试。',
      { message: '本次对话或材料太长，超出单次安全检测能覆盖的范围，请精简后重试（或清空对话重新开始）。' },
    );
  }

  if (!vision && event.image !== undefined && event.image !== null) {
    fail('invalid_request', '图片请走 vision 动作；chat 动作只处理文字');
  }
  let image: NormalizedImage | undefined;
  if (vision) {
    if (event.image === undefined || event.image === null) {
      fail('invalid_request', 'vision 动作需要 image（云存储 fileID 或 base64）');
    }
    image = await resolveImage(event.image, log.config, openid);
    attachImage(messages, image);
  }

  // 2) 输入内容安全：**所有消息文字**（system / user / assistant）与上传的图片都要先过检测。
  //    输入长度已按上限收敛，所以这一步必然是整段检完（`checked` 只会因检测被关闭而变假）。
  if (image !== undefined) {
    const imageOutcome = await moderateImage(log, image, wechat, openid, startedAt);
    if (imageOutcome.rejected) rejectContent(imageOutcome, 'image');
  }
  if (input.text !== '') {
    const textOutcome = await moderateText(log, input.text, wechat, openid, startedAt, MAX_INPUT_CHUNKS);
    if (textOutcome.rejected) rejectContent(textOutcome);
  }

  // 3) 模型调用（带明确超时边界）。
  const target = resolveModelTarget(log.config, {
    vision,
    maxTokens: typeof event.maxTokens === 'number' ? event.maxTokens : undefined,
    timeoutMs: modelTimeoutMs(log, startedAt, event.timeoutMs),
  });
  const result = vision
    ? await runVision(log, event, target, { system, messages })
    : (await invokeModel(log, target, {
      system,
      messages,
      maxTokens: target.maxTokens,
      timeoutMs: target.timeoutMs,
    })).text;

  // 4) 输出内容安全：AI 生成的文字上屏前再检一次（分带识别在**合并后**的文本上只检一次）。
  await moderateOutput(log, result, wechat, openid, startedAt);

  // 5) 出处校验（升学问答）：内容安全之后再过一次事实闸。句子里的日期、数字与官方事实
  //    必须指向本次注入的可信段落，否则不作为官方结论返回——调用方降级为本地原文摘录。
  //    这一步在输出检测之后：不通过的回答同样已经过检，两个结论互不掩盖。
  if (log.advancementResult !== null) {
    const verdict = verifyAdvancementAnswer(result, log.advancementResult.sources);
    log.advancementResult.verified = verdict.violations.length === 0;
    log.advancementResult.refused = verdict.refused;
    log.advancementResult.violations = verdict.violations;
    if (verdict.violations.length > 0) {
      fail(
        'citation_unverified',
        `升学问答的模型回答未通过出处校验（${verdict.violations.join('、')}），已丢弃该回答，请调用方展示原文摘录`,
        { message: '这条回答没能核对上官方原文的出处，已改为展示检索到的原文摘录。' },
      );
    }
  }

  // 6) 格式与引用校验（项目讲解与答辩练习）：同样在输出检测之后。
  //    四节标题缺失 / 顺序错、或回答引用了材料里不存在的条目编号，都不作为反馈返回——
  //    detail 只带短代码与节标题（不含回答正文），回答正文本身已经在内容安全层过检但不上屏。
  if (log.feature === DEFENSE_FEATURE) {
    const verdict = verifyDefenseAnswer(result, defenseMaterial);
    if (!verdict.ok) {
      fail(
        'citation_unverified',
        `答辩练习的模型回答未通过格式与引用校验（${verdict.problems.join('、')}），已丢弃该回答`,
      );
    }
  }
  return result;
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
    usageSummary: log === null || !log.isAdmin ? null : log.summary,
    capWarning: log === null || !log.isAdmin ? '' : capWarningFor(log.summary),
    warnings: log === null ? [] : log.warnings.slice(),
    citations: log === null ? [] : log.activityCitations.slice(),
    advancement: log === null ? null : log.advancementResult,
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
  const openid = currentOpenid();
  const admin = isAdmin(openid);

  // 探测不需要模型配置：维护者可能还没配密钥就先跑它。
  if (action === 'probe') {
    try {
      assertAdmin(openid);
      await consumeProbeWindow(db, now);
      const result = await runProbe({ wechat: wechatSecurity(), openid, env: currentEnv(), now });
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
        citations: [],
        advancement: null,
        probe: result.record,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      return failureResponse(error, { log: null, action, feature, startedAt, secrets });
    }
  }

  let log: RunLog | null = null;
  let gateHeld = false;
  let gateMonth = '';
  try {
    if (action === null) fail('invalid_request', `未知动作「${safeString(event.action)}」，可用动作：${ALLOWED_ACTIONS.join('、')}`);
    if (action === 'usage' || action === 'moderateText' || action === 'moderateImage') {
      assertAdmin(openid);
    } else {
      requireOpenid(openid);
      await consumeUserLimits(db, openid, now);
    }
    const config = loadConfig();
    secrets.push(...secretsOf(config));
    // 成本读取与上限判断也必须串行；否则等闸门时拿着旧汇总的请求会越过上限。
    if (action !== 'usage') {
      gateMonth = shanghaiMonth(now);
      await acquireAccountingGate(db, gateMonth, requestId, now);
      gateHeld = true;
    }
    const summary = await readSummary(config, now);
    log = {
      requestId,
      userKey: userKey(openid),
      isAdmin: admin,
      feature,
      action,
      config,
      summary,
      usage: null,
      provider: '',
      model: '',
      safety: null,
      warnings: [],
      accountingFailed: false,
      activityCitations: [],
      advancementResult: null,
    };

    // 查用量在任何情况下都要能用（哪怕已经超上限），因此先于上限判定返回。
    if (action === 'usage') {
      const response = successResponse(log, action, startedAt);
      // `message` 的契约是「成功时为空串」；上限告警走专门的 capWarning 字段（baseResponse 已填）。
      response.detail = `当月累计 ${summary.calls} 次调用、${summary.totalTokens} token、${summary.costYuan} 元`
        + `（上限 ${summary.capYuan} 元，告警线 ${summary.warnThresholdYuan} 元）`;
      return response;
    }

    // 先核对调用记录与汇总：记账写入失败时不能靠过时汇总继续放行。
    await assertNoUnaccountedRecords(db, summary);
    // 上限判定：达到上限直接拒绝，接近阈值只告警（告警随返回值带出）。
    assertWithinCap(summary);

    if (action === 'moderateText') {
      const raw = safeString(event.text);
      if (raw === '') fail('invalid_request', 'moderateText 需要 text');
      // 长文本按窗口逐段检测（与 chat 的输入检测同一套分片逻辑）：前 2 万字全检，
      // 超出部分在报告里写明范围并置 checked=false，不静默放过。
      // 这是**诊断动作**（管理员限定、不喂模型也不上屏），因此允许返回部分报告；
      // chat / vision 两条通路不允许：输入超窗直接拒绝，输出超窗不返回内容。
      const outcome = await moderateText(log, raw, wechatSecurity(), openid, startedAt, MAX_INPUT_CHUNKS);
      const response = successResponse(log, action, startedAt);
      response.safety = outcome.report;
      if (outcome.rejected) {
        response.ok = false;
        response.failureClass = 'content_rejected';
        response.message = messageFor('content_rejected');
        response.detail = rejectionDetail(outcome);
      }
      return response;
    }

    if (action === 'moderateImage') {
      if (event.image === undefined || event.image === null) fail('invalid_request', 'moderateImage 需要 image（fileID 或 base64）');
      const image = await resolveImage(event.image, log.config, openid);
      const outcome = await moderateImage(log, image, wechatSecurity(), openid, startedAt);
      const response = successResponse(log, action, startedAt);
      response.safety = outcome.report;
      if (outcome.rejected) {
        response.ok = false;
        response.failureClass = 'content_rejected';
        // 图片检测入口：文案用图片专属默认值（换一张），与文字路径的「修改后重试」区分。
        response.message = messageFor('content_rejected', 'image');
        response.detail = rejectionDetail(outcome);
      }
      return response;
    }

    const text = await runModelAction(log, event, startedAt, openid);
    const response = successResponse(log, action, startedAt);
    response.text = text;
    return response;
  } catch (error) {
    // catch 里 action 仍可能是 null（未知动作/在读配置前就失败），统一收敛成空字符串。
    return failureResponse(error, { log, action: action ?? '', feature, startedAt, secrets });
  } finally {
    // 未能确认所有子调用记账成功时保留闸门；下一笔请求必须等维护者核账。
    if (gateHeld && (log === null || !log.accountingFailed)) {
      await releaseAccountingGate(db, gateMonth).catch(() => undefined);
    }
  }
}

/** 供测试与文档核对的导出（失败分类清单与必需的三类）。 */
export { REQUIRED_FAILURE_CLASSES } from './errors';
export type { FailureClass };
