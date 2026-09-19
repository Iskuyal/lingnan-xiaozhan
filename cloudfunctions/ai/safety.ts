/**
 * 内容安全适配层（可切换）。
 *
 * 接入方式由负责人 2026-09-18 确定：**以微信官方内容安全接口为主**
 * （`security.msgSecCheck` / `security.imgSecCheck` 云调用），同时支持第三方审核 API
 * （OpenAI 与 Anthropic 两种接口格式）。文字与图片是**两个独立入口**，因为微信侧本就是两个接口，
 * 第三方侧的请求体也不同。
 *
 * 判定与失败刻意分开：
 * - 内容被判违规 → 调用方拿到 `content_rejected`（与「调用失败」可区分）；
 * - 检测服务本身不可用 → 按 `AI_SAFETY_FAIL_MODE` 处理，默认 closed：抛 `internal` 失败，
 *   绝不假装「已检测通过」。放行未检测内容会给审核留下风险，默认值因此是挡住；
 * - 检测**超时**（微信云调用、云存储下载、第三方审核 HTTP）→ 归入「模型不可用或超时」
 *   （`model_unavailable`，可重试），因为它和「配置/权限错」不是一回事。
 *
 * 「有没有真的检测」由报告上的 `checked` 明确表达：关闭（`off`）与 fail-open 都返回
 * `checked: false` 并写明模式，调用方与日志不得把「跳过」读成「通过」。
 */
import { Config, ModelTarget, resolveSafetyTarget } from './config';
import { AiFailure, describeError, fail, failTimeout, redactSecrets, safetyQuotaMessage } from './errors';
import { isTimeoutError, withTimeout } from './http';
import { ConversationMessage, NormalizedImage, SafetyReport, TokenUsage } from './types';
import { callModel, requestJson } from './providers';

/**
 * 微信内容安全云调用接口。`wx-server-sdk` 通过 `cloud.openapi.security` 暴露：
 * 官方文档口径是「云调用需要在函数目录的 `config.json` 里声明 `permissions.openapi`」，
 * 缺声明时**可能**返回 48001——本项目尚未实测（探测动作 `{"action":"probe"}` 的结论回填前，
 * 48001/48002/61010 与具体原因的对应关系都只是待验证的假设，不是既成事实）。
 *
 * **云调用还有一个前置条件（2026-09-18 已实测到它的反例）**：云调用必须由**小程序端**触发。
 * 云开发控制台的「测试」页、CLI、HTTP 触发、云函数互调都不会带上小程序侧的云调用票据，
 * 因此这些方式下调用必然返回 `-501001`；这条结果**不是**「微信接口不可用」的证据。
 * 官方依据见 {@link WECHAT_ERRCODE_NOTES} 里 -501001 的说明。
 */
export interface WechatSecurityApi {
  msgSecCheck(params: Record<string, unknown>): Promise<unknown>;
  imgSecCheck(params: Record<string, unknown>): Promise<unknown>;
}

/** 微信云调用可能 resolve 也可能 reject（违规内容常以错误码返回），两种都收在这里。 */
export type WechatCall = { ok: true; response: unknown } | { ok: false; error: unknown };

/**
 * 内容安全侧的**配额类**错误码：目前只有实测过的 45009（当日调用配额用尽）。
 *
 * 只放实测过的码。新增必须先在云上撞到并记录，不按猜测扩充——
 * 归错类的代价不是少一条日志，而是给用户一条错的下一步（见 `unavailable` 的 quota 分支）。
 */
export const WECHAT_QUOTA_ERRCODES: number[] = [45009];

/** 这个错误码是不是「检测配额用尽」。 */
export function isQuotaErrcode(errCode: number): boolean {
  return WECHAT_QUOTA_ERRCODES.includes(errCode);
}

/**
 * 微信错误码说明。只列与内容安全相关的常见码，供探测结论与排查使用；
 * 依据：官方内容安全接口文档与云调用错误码表，不逐条抄全表。
 * **本项目未实测**：这些码与「未认证小程序」的因果关系要等探测结论出来才成立。
 */
export const WECHAT_ERRCODE_NOTES: Record<string, string> = {
  '-1': '系统繁忙或调用未成功返回，请稍后重试',
  0: '调用成功',
  87014: '内容含有违法违规内容（被拒）',
  40001: 'access_token 无效（云调用下可能与环境或函数权限有关）',
  41001: '缺少 access_token 参数',
  42001: 'access_token 已过期',
  47001: '参数格式错误',
  48001: 'api 未授权：该接口未获得调用权限（官方文档提到未声明 openapi 权限会返回它；未认证小程序是否必然返回 48001 **未实测**，以探测结论为准）',
  48002: 'api 禁止调用：接口被禁（账号类型或审核状态限制，**未实测**）',
  45009: '接口调用超过当日配额上限（`fail reach max api daily quota limit`）：**已实测（2026-09-19）**，'
    + '文本与图片两个接口的配额**各自计算**（当天 `msgSecCheck` 报 45009 时 `imgSecCheck` 仍返回 0），'
    + '次日恢复；默认 `AI_SAFETY_FAIL_MODE=closed` 下会拒绝调用（当天的问答 / 助手 / 识图全部不可用）。'
    + '排障时看到这个码就不要再查模型或密钥，也不要靠调大超时去试。',
  61010: '用户访问记录超时：v2 接口要求 openid 对应的用户近期访问过小程序（**未实测**，以探测结论为准）',
  // 以 -5 开头的码来自**云开发平台（CloudBase）**，不是微信开放接口的错误码；语义与排查方向都不同，
  // 因此单独成组：它们说的是「这次调用怎么发起的」，不是「接口能不能用」。
  '-501001': '云调用鉴权失败（CloudBase `INVALID_WX_ACCESS_TOKEN`）：本次调用没有小程序侧的云调用票据。'
    + '官方原文为「云调用鉴权失败，未从小程序端触发使用云调用的云函数」——'
    + '**控制台「测试」页、CLI、HTTP 触发、云函数互调都不会带上票据，必然返回此码**；'
    + '云调用必须由小程序端触发（开发者工具模拟器或真机）。'
    + '2026-09-18 本次实测与该口径一致（控制台触发，两条接口同为 -501001）；'
    + '**若从小程序端触发仍返回此码**，才轮到核查环境与小程序的绑定、函数 `config.json` 的 openapi 声明。',
  '-501007': '参数无效（CloudBase `INVALID_PARAMETERS`）：若 detail 写着 `missing wxCloudApiToken`，'
    + '含义与 -501001 相同——本次调用没有云调用票据，不是从小程序端触发的（官方 FAQ「遇到 missing wxCloudApiToken 报错是怎么回事」）',
};

export function wechatErrcodeNote(errCode: number): string {
  return WECHAT_ERRCODE_NOTES[String(errCode)] ?? '未在项目维护的错误码表中，请对照官方错误码文档';
}

/** 取 errCode / errMsg：返回体与抛出的错误对象字段名一致；超时错误没有 errMsg，用它的 message。 */
function wechatErrorFields(raw: unknown): { errCode: number; errMsg: string; timedOut: boolean } {
  if (raw === null || raw === undefined || typeof raw !== 'object') return { errCode: -1, errMsg: '', timedOut: false };
  const source = raw as { errCode?: unknown; errcode?: unknown; errMsg?: unknown; errmsg?: unknown };
  const code = source.errCode ?? source.errcode;
  const message = source.errMsg ?? source.errmsg;
  const timedOut = isTimeoutError(raw);
  return {
    errCode: typeof code === 'number' && Number.isFinite(code) ? code : -1,
    errMsg: typeof message === 'string' ? message : timedOut ? describeError(raw) : '',
    timedOut,
  };
}

export type WechatVerdict = 'pass' | 'reject' | 'review' | 'error';

export interface WechatOutcome {
  errCode: number;
  errMsg: string;
  verdict: WechatVerdict;
  detail: string;
  /** 是否由超时引起：调用方据此给「可重试」的措辞，而不是照配置类错误处理。 */
  timedOut: boolean;
}

/** 错误码说明，超时时额外写明「是超时」而不是笼统的「系统繁忙」。 */
function wechatNote(errCode: number, timedOut: boolean): string {
  const base = wechatErrcodeNote(errCode);
  return timedOut ? `调用超时（未在超时边界内返回）｜${base}` : base;
}

/**
 * 判定 `security.msgSecCheck` 的结果。
 *
 * 两种返回形态都要认：
 * - v2（带 openid）：errcode 0，判定在 `result.suggest`：pass / review / risky；
 * - v1（只传 content）：合规 errcode 0，违规以 errcode 87014 返回（可能 resolve 也可能 reject）。
 * 因此这里既看 errcode 也看 suggest，缺一不可。
 * （上述形态来自官方文档，**本项目尚未在云上实测**，探测结论回填后才算确认。）
 */
export function judgeMsgSecCheck(call: WechatCall): WechatOutcome {
  const raw = call.ok ? call.response : call.error;
  const { errCode, errMsg, timedOut } = wechatErrorFields(raw);
  const payload = raw !== null && typeof raw === 'object'
    ? (raw as { result?: unknown })
    : {};
  const result = payload.result !== null && payload.result !== undefined && typeof payload.result === 'object'
    ? (payload.result as { suggest?: unknown; label?: unknown })
    : {};
  const suggest = typeof result.suggest === 'string' ? result.suggest : '';
  const label = typeof result.label === 'number' ? result.label : 0;
  const detail = [
    `errcode=${errCode}`,
    errMsg === '' ? '' : `errmsg=${errMsg}`,
    suggest === '' ? '' : `suggest=${suggest}`,
    label === 0 ? '' : `label=${label}`,
  ].filter((part) => part !== '').join('｜');

  if (errCode === 87014) return { errCode, errMsg, timedOut: false, verdict: 'reject', detail: `${detail}｜${wechatNote(errCode, false)}` };
  if (errCode !== 0) return { errCode, errMsg, timedOut, verdict: 'error', detail: `${detail}｜${wechatNote(errCode, timedOut)}` };
  if (suggest === 'risky') return { errCode, errMsg, timedOut: false, verdict: 'reject', detail: `${detail}｜suggest=risky` };
  if (suggest === 'review') return { errCode, errMsg, timedOut: false, verdict: 'review', detail: `${detail}｜suggest=review（需人工复审）` };
  return { errCode, errMsg, timedOut: false, verdict: 'pass', detail };
}

/** 判定 `security.imgSecCheck`：合规 errcode 0，违规返回 87014（resolve 或 reject 都可能出现）。 */
export function judgeImgSecCheck(call: WechatCall): WechatOutcome {
  const raw = call.ok ? call.response : call.error;
  const { errCode, errMsg, timedOut } = wechatErrorFields(raw);
  const detail = `errcode=${errCode}${errMsg === '' ? '' : `｜errmsg=${errMsg}`}`;
  if (errCode === 87014) return { errCode, errMsg, timedOut: false, verdict: 'reject', detail: `${detail}｜${wechatNote(errCode, false)}` };
  if (errCode !== 0) return { errCode, errMsg, timedOut, verdict: 'error', detail: `${detail}｜${wechatNote(errCode, timedOut)}` };
  return { errCode, errMsg, timedOut: false, verdict: 'pass', detail };
}

/** 一次内容安全检测的结果（含第三方审核的用量，供入口记账）。 */
export interface SafetyOutcome {
  report: SafetyReport;
  /** 第三方审核用的模型名；微信侧为接口名。 */
  model: string;
  /** 第三方审核的 token 用量；微信侧为 null（免费接口），`usageUnknown` 为真时也表示未知。 */
  usage: TokenUsage | null;
  /**
   * 接口不返回 token 用量（如 OpenAI `/moderations`）：拿不到用量，也估算不出。
   * 记账时不得静默记成 0 元——入口按「每次审核固定价」计并标记，见 usage.unknownUsage。
   */
  usageUnknown: boolean;
  durationMs: number;
  /** 内容被判违规（区别于「检测本身失败」）。 */
  rejected: boolean;
}

export interface TextCheckInput {
  text: string;
  openid?: string;
  timeoutMs?: number;
  wechat?: WechatSecurityApi;
}

export interface ImageCheckInput {
  image: NormalizedImage;
  openid?: string;
  timeoutMs?: number;
  wechat?: WechatSecurityApi;
}

/** 一次检测的结果装配：`checked` 默认真（真的检过），跳过与部分检测必须显式改假。 */
function outcome(options: {
  provider: string;
  api: string;
  passed: boolean;
  detail: string;
  rejected: boolean;
  model: string;
  usage: TokenUsage | null;
  durationMs: number;
  checked?: boolean;
  usageUnknown?: boolean;
}): SafetyOutcome {
  return {
    report: {
      provider: options.provider,
      api: options.api,
      passed: options.passed,
      checked: options.checked !== false,
      detail: options.detail,
    },
    model: options.model,
    usage: options.usage,
    usageUnknown: options.usageUnknown === true,
    durationMs: options.durationMs,
    rejected: options.rejected,
  };
}

/**
 * 「内容安全检测不可用」的处置：默认挡住（closed）。可配置为放行，
 * 但报告里会写明「未检测」且 `checked: false`，不会让调用方以为已经检过。
 *
 * 两种成因单独分类，因为它们的**下一步不同**：
 * - 超时：临时故障、可重试 → 归「模型不可用或超时」（`model_unavailable`）；
 * - 配额用尽（微信 45009 / 第三方 402）：再试也不会好，但会恢复 → 归「额度或配额用尽」
 *   （`quota_exhausted`），文案与月度上限分开（见 `safetyQuotaMessage`）。
 *   归成 `internal` 会让页面说「AI 服务开小差了，请稍后重试」——用户按这条建议立刻重试，
 *   只会一直失败，真正的选择是等次日或换审核方式（2026-09-19 实测踩到过这个分类缺口）。
 * 其余（配置、权限、票据）才是 `internal`。
 */
function unavailable(
  config: Config,
  provider: string,
  api: string,
  detail: string,
  durationMs: number,
  options: { timedOut?: boolean; quotaExhausted?: boolean } = {},
): SafetyOutcome {
  const timedOut = options.timedOut === true;
  const note = `内容安全检测不可用：${detail}`;
  if (config.safety.failMode === 'open') {
    return outcome({
      provider, api, passed: true, checked: false,
      detail: `${note}（AI_SAFETY_FAIL_MODE=open，已放行未检测内容；检查项 checked=false）`,
      rejected: false, model: api, usage: null, durationMs,
    });
  }
  if (options.quotaExhausted === true) {
    throw new AiFailure('quota_exhausted', `${note}（AI_SAFETY_FAIL_MODE=closed，拒绝调用）`, {
      message: safetyQuotaMessage(),
    });
  }
  if (timedOut) {
    failTimeout('model_unavailable', `${note}（AI_SAFETY_FAIL_MODE=closed，拒绝调用；超时属可重试失败，稍后重试即可）`);
  }
  fail('internal', `${note}（AI_SAFETY_FAIL_MODE=closed，拒绝调用；可切换第三方适配器或改为 open，见 docs/cloud-development.md）`);
}

function reviewPolicy(config: Config): { rejected: boolean; detail: string } {
  if (config.safety.reviewAs === 'pass') return { rejected: false, detail: 'review 按放行处理（AI_SAFETY_REVIEW_AS=pass）' };
  return { rejected: true, detail: 'review 按拒绝处理（AI_SAFETY_REVIEW_AS=reject，默认）' };
}

/** 单次内容安全调用的超时：调用方给了时限就用它，但不得超过配置上限、也不得低于 1 秒。 */
function safetyTimeoutMs(config: Config, asked: number | undefined): number {
  const base = typeof asked === 'number' && Number.isFinite(asked) && asked > 0 ? asked : config.safety.timeoutMs;
  return Math.max(1000, Math.floor(Math.min(base, config.safety.timeoutMs)));
}

/**
 * 捕获到的异常是不是「检测服务额度/配额用尽」。
 * 第三方适配器把 402 归到 `quota_exhausted`（见 providers 的 `classifyHttpStatus`），
 * 这里保住这个分类往上传，不要被「检测不可用」的兜底冲成 `internal`。
 */
function isQuotaFailure(error: unknown): boolean {
  return error instanceof AiFailure && error.failureClass === 'quota_exhausted';
}

/**
 * 调一次微信云调用，收成 `WechatCall`。
 * **带硬超时**：云调用同样可能一直不返回，票面要求单次调用有明确超时边界，超时按调用失败返回。
 */
export async function invokeWechat(call: () => Promise<unknown>, timeoutMs: number, target: string): Promise<WechatCall> {
  try {
    return { ok: true, response: await withTimeout(call(), timeoutMs, target) };
  } catch (error) {
    return { ok: false, error };
  }
}

/** 微信官方文字检测。 */
async function wechatText(config: Config, input: TextCheckInput): Promise<SafetyOutcome> {
  const startedAt = Date.now();
  const api = input.wechat;
  if (api === undefined) {
    return unavailable(config, 'wechat', 'security.msgSecCheck', '云函数未拿到 cloud.openapi.security（检查 wx-server-sdk 版本与函数 config.json 的 openapi 声明）', 0);
  }
  const openid = typeof input.openid === 'string' ? input.openid : '';
  const timeoutMs = safetyTimeoutMs(config, input.timeoutMs);
  // v2 需要 openid 与 scene；拿不到 openid（例如控制台手动探测）时退回 v1 形态，
  // 判定逻辑两者都覆盖（见 judgeMsgSecCheck）。
  const params: Record<string, unknown> = openid === ''
    ? { content: input.text }
    : { content: input.text, version: 2, scene: config.safety.scene, openid };
  const call = await invokeWechat(() => api.msgSecCheck(params), timeoutMs, 'wechat security.msgSecCheck');
  const judged = judgeMsgSecCheck(call);
  const durationMs = Date.now() - startedAt;
  const form = openid === '' ? 'v1（无 openid）' : `v2（scene=${config.safety.scene}）`;
  if (judged.verdict === 'error') {
    return unavailable(config, 'wechat', 'security.msgSecCheck', `${form}｜${judged.detail}`, durationMs, {
      timedOut: judged.timedOut,
      quotaExhausted: isQuotaErrcode(judged.errCode),
    });
  }
  if (judged.verdict === 'reject') {
    return outcome({
      provider: 'wechat', api: 'security.msgSecCheck', passed: false, detail: `${form}｜${judged.detail}`,
      rejected: true, model: 'security.msgSecCheck', usage: null, durationMs,
    });
  }
  if (judged.verdict === 'review') {
    const policy = reviewPolicy(config);
    return outcome({
      provider: 'wechat', api: 'security.msgSecCheck', passed: !policy.rejected,
      detail: `${form}｜${judged.detail}｜${policy.detail}`, rejected: policy.rejected,
      model: 'security.msgSecCheck', usage: null, durationMs,
    });
  }
  return outcome({
    provider: 'wechat', api: 'security.msgSecCheck', passed: true, detail: `${form}｜${judged.detail}`,
    rejected: false, model: 'security.msgSecCheck', usage: null, durationMs,
  });
}

/** 微信官方图片检测。 */
async function wechatImage(config: Config, input: ImageCheckInput): Promise<SafetyOutcome> {
  const startedAt = Date.now();
  const api = input.wechat;
  if (api === undefined) {
    return unavailable(config, 'wechat', 'security.imgSecCheck', '云函数未拿到 cloud.openapi.security（检查 wx-server-sdk 版本与函数 config.json 的 openapi 声明）', 0);
  }
  const call = await invokeWechat(() => api.imgSecCheck({
    media: { contentType: input.image.mimeType, value: Buffer.from(input.image.base64, 'base64') },
  }), safetyTimeoutMs(config, input.timeoutMs), 'wechat security.imgSecCheck');
  const judged = judgeImgSecCheck(call);
  const durationMs = Date.now() - startedAt;
  if (judged.verdict === 'error') {
    return unavailable(config, 'wechat', 'security.imgSecCheck', judged.detail, durationMs, {
      timedOut: judged.timedOut,
      quotaExhausted: isQuotaErrcode(judged.errCode),
    });
  }
  return outcome({
    provider: 'wechat',
    api: 'security.imgSecCheck',
    passed: judged.verdict === 'pass',
    detail: judged.detail,
    rejected: judged.verdict === 'reject',
    model: 'security.imgSecCheck',
    usage: null,
    durationMs,
  });
}

/** 第三方审核的判定提示词：只要求一个短 JSON，便于解析。 */
export const MODERATION_SYSTEM_PROMPT = [
  '你是内容安全审核员，负责判断内容是否适合展示在面向大学生的校园小程序里。',
  '色情、暴力、违法犯罪、赌博、欺诈、辱骂、政治敏感、广告引流、以及其它不适宜内容都算违规。',
  '只输出一个 JSON 对象，形如 {"allowed": true, "reason": "一句话理由"}；不要输出其它文字。',
].join('\n');

/** 从模型输出里抠出 { allowed, reason }：允许被 ``` 围栏包住，也允许前后有解释文字。 */
export function parseModerationJson(text: string): { allowed: boolean; reason: string } | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  const candidate = fenced === null ? text : fenced[1];
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as { allowed?: unknown; reason?: unknown };
    if (typeof parsed.allowed !== 'boolean') return null;
    return { allowed: parsed.allowed, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
  } catch {
    return null;
  }
}

/** 第三方审核的对话内容：文字与图片都能带上，两种接口格式共用。 */
function moderationMessage(input: { text?: string; image?: NormalizedImage }): ConversationMessage {
  const parts: string[] = ['请审核以下内容：'];
  if (typeof input.text === 'string' && input.text !== '') parts.push(input.text);
  return { role: 'user', text: parts.join('\n'), image: input.image };
}

/** 第三方审核的超时兜底余量：正常路径由 HTTP 层的定时器先结束，这层只防「定时器没生效」。 */
const THIRD_PARTY_TIMEOUT_SLACK_MS = 1000;

async function thirdPartyCheck(
  config: Config,
  target: ModelTarget,
  input: { text?: string; image?: NormalizedImage; timeoutMs?: number },
  api: string,
): Promise<SafetyOutcome> {
  const startedAt = Date.now();
  // OpenAI 官方的 /moderations 接口返回结构与 chat 不同，单独走一条路径（AI_SAFETY_OPENAI_MODE=moderations）。
  if (target.format === 'openai' && config.safety.openaiMode === 'moderations') {
    return openAiModerations(config, target, input, api, startedAt);
  }
  const timeoutMs = input.timeoutMs === undefined ? target.timeoutMs : input.timeoutMs;
  const invocation = {
    system: MODERATION_SYSTEM_PROMPT,
    messages: [moderationMessage(input)],
    timeoutMs,
  };
  let result;
  try {
    result = await withTimeout(callModel(target, invocation), timeoutMs + THIRD_PARTY_TIMEOUT_SLACK_MS, `${target.format} 审核接口`);
  } catch (error) {
    const detail = error instanceof AiFailure ? error.detail : describeError(error);
    return unavailable(config, target.format, api, redactSecrets(detail, [target.apiKey]), Date.now() - startedAt, {
      timedOut: isTimeoutError(error),
      quotaExhausted: isQuotaFailure(error),
    });
  }
  const parsed = parseModerationJson(result.text);
  if (parsed === null) {
    return unavailable(config, target.format, api, `审核模型未返回可解析的判定 JSON：${result.text.slice(0, 120)}`, Date.now() - startedAt);
  }
  return outcome({
    provider: target.format,
    api,
    passed: parsed.allowed,
    detail: `allowed=${parsed.allowed}${parsed.reason === '' ? '' : `｜reason=${parsed.reason}`}`,
    rejected: !parsed.allowed,
    model: target.model,
    usage: result.usage,
    durationMs: Date.now() - startedAt,
  });
}

/** OpenAI `/moderations` 接口：判定在 results[0].flagged。 */
async function openAiModerations(
  config: Config,
  target: ModelTarget,
  input: { text?: string; image?: NormalizedImage; timeoutMs?: number },
  api: string,
  startedAt: number,
): Promise<SafetyOutcome> {
  const text = typeof input.text === 'string' ? input.text : '';
  const parts: unknown[] = [];
  if (text !== '') parts.push({ type: 'text', text });
  if (input.image !== undefined) {
    parts.push({ type: 'image_url', image_url: { url: `data:${input.image.mimeType};base64,${input.image.base64}` } });
  }
  // 纯文字时用字符串入参；带图时用分块数组（官方 moderations 接口的两种入参形态）。
  const body = JSON.stringify({ model: target.model, input: input.image === undefined ? text : parts });
  let payload: unknown;
  try {
    // 走与模型调用同一条传输/状态码/JSON 解析路径，避免两处实现分叉。
    const response = await requestJson(
      target,
      { url: `${target.baseUrl}/moderations`, headers: { Authorization: `Bearer ${target.apiKey}` }, body },
      { timeoutMs: input.timeoutMs === undefined ? target.timeoutMs : input.timeoutMs, label: '审核接口' },
    );
    payload = response.payload;
  } catch (error) {
    const detail = error instanceof AiFailure ? error.detail : describeError(error);
    return unavailable(config, target.format, api, redactSecrets(detail, [target.apiKey]), Date.now() - startedAt, {
      timedOut: isTimeoutError(error),
      quotaExhausted: isQuotaFailure(error),
    });
  }
  const results = payload !== null && typeof payload === 'object' ? (payload as { results?: unknown }).results : undefined;
  const first = Array.isArray(results) && results.length > 0 && results[0] !== null && typeof results[0] === 'object'
    ? (results[0] as { flagged?: unknown; categories?: unknown })
    : null;
  if (first === null || typeof first.flagged !== 'boolean') {
    return unavailable(config, target.format, api, '审核接口返回缺少 flagged 字段', Date.now() - startedAt);
  }
  const categories = first.categories !== null && first.categories !== undefined && typeof first.categories === 'object'
    ? Object.entries(first.categories as Record<string, unknown>)
      .filter(([, value]) => value === true)
      .map(([key]) => key)
    : [];
  return outcome({
    provider: target.format,
    api,
    passed: !first.flagged,
    detail: `flagged=${first.flagged}${categories.length === 0 ? '' : `｜categories=${categories.join(',')}`}`,
    rejected: first.flagged,
    model: target.model,
    // moderations 接口不返回 usage：如实记为「用量未知」，由入口按固定价或标记不计入，不猜 token 数也不静默记 0。
    usage: null,
    usageUnknown: true,
    durationMs: Date.now() - startedAt,
  });
}

function thirdPartyUnavailable(config: Config, provider: string, api: string): SafetyOutcome {
  return unavailable(config, provider, api, '第三方审核适配器未配置完整（需要 AI_SAFETY_BASE_URL / AI_SAFETY_API_KEY / AI_SAFETY_MODEL）', 0);
}

/** 「检测被跳过」的统一说明：写明模式、原因与 checked=false，便于调用方与日志识别。 */
function skipped(api: string): SafetyOutcome {
  return outcome({
    provider: 'off',
    api,
    passed: true,
    checked: false,
    detail: '内容安全检测已关闭（AI_SAFETY_PROVIDER=off）：本次内容**未过检**，report.checked=false。'
      + '该开关仅限开发与排障使用，生产不得使用——规格把「AI 文字与用户图片都要过内容安全」列为硬约束。',
    rejected: false,
    model: '',
    usage: null,
    durationMs: 0,
  });
}

/**
 * 内容安全检测入口的共用前置：`off` 时跳过检测但仍然如实标记「没检过」。
 * 返回值不是 null 时，调用方直接返回它。
 */
function skippedOrNull(config: Config, api: string): SafetyOutcome | null {
  return config.safety.provider === 'off' ? skipped(api) : null;
}

/** 违规详情串：`provider｜api｜detail`（含是否真的检过），失败返回值与日志都用它。 */
export function rejectionDetail(outcome: SafetyOutcome): string {
  const report = outcome.report;
  return `${report.provider}｜${report.api}｜checked=${report.checked}｜${report.detail}`;
}

/**
 * 文字内容安全检测入口。
 * 适配器由 `AI_SAFETY_PROVIDER` 选择：wechat（默认）/ openai / anthropic / off。
 */
export async function checkText(config: Config, input: TextCheckInput): Promise<SafetyOutcome> {
  const off = skippedOrNull(config, 'none');
  if (off !== null) return off;
  const provider = config.safety.provider;
  if (provider === 'wechat') return wechatText(config, input);
  const target = resolveSafetyTarget(config);
  if (target === null) return thirdPartyUnavailable(config, provider, 'text-moderation');
  return thirdPartyCheck(config, target, { text: input.text, timeoutMs: input.timeoutMs }, 'text-moderation');
}

/**
 * 图片内容安全检测入口。**与文字检测分开**：微信侧是两个接口，Ticket 05 要先过图片检测再送模型。
 */
export async function checkImage(config: Config, input: ImageCheckInput): Promise<SafetyOutcome> {
  const off = skippedOrNull(config, 'none');
  if (off !== null) return off;
  const provider = config.safety.provider;
  if (provider === 'wechat') return wechatImage(config, input);
  const target = resolveSafetyTarget(config);
  if (target === null) return thirdPartyUnavailable(config, provider, 'image-moderation');
  return thirdPartyCheck(config, target, { image: input.image, timeoutMs: input.timeoutMs }, 'image-moderation');
}
