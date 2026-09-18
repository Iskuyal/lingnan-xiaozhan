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
 *   绝不假装「已检测通过」。放行未检测内容会给审核留下风险，默认值因此是挡住。
 */
import { Config, ModelTarget, resolveSafetyTarget } from './config';
import { AiFailure, describeError, fail, redactSecrets } from './errors';
import { postJson } from './http';
import { ConversationMessage, NormalizedImage, SafetyReport, TokenUsage } from './types';
import { callModel } from './providers';

/**
 * 微信内容安全云调用接口。`wx-server-sdk` 通过 `cloud.openapi.security` 暴露：
 * 云调用需要在函数目录的 `config.json` 里声明 `permissions.openapi`，否则会返回 48001。
 */
export interface WechatSecurityApi {
  msgSecCheck(params: Record<string, unknown>): Promise<unknown>;
  imgSecCheck(params: Record<string, unknown>): Promise<unknown>;
}

/** 微信云调用可能 resolve 也可能 reject（违规内容常以错误码返回），两种都收在这里。 */
export type WechatCall = { ok: true; response: unknown } | { ok: false; error: unknown };

/**
 * 微信错误码说明。只列与内容安全相关的常见码，供探测结论与排查使用；
 * 依据：官方内容安全接口文档与云调用错误码表，不逐条抄全表。
 */
export const WECHAT_ERRCODE_NOTES: Record<string, string> = {
  '-1': '系统繁忙，请稍后重试',
  0: '调用成功',
  87014: '内容含有违法违规内容（被拒）',
  40001: 'access_token 无效（云调用下通常与函数权限或环境有关）',
  41001: '缺少 access_token 参数',
  42001: 'access_token 已过期',
  47001: '参数格式错误',
  48001: 'api 未授权：该接口未获得调用权限（未认证小程序、未声明 openapi 权限时会返回它）',
  48002: 'api 禁止调用：接口被禁（账号类型或审核状态限制）',
  61010: '用户访问记录超时：v2 接口要求 openid 对应的用户近期访问过小程序',
};

export function wechatErrcodeNote(errCode: number): string {
  return WECHAT_ERRCODE_NOTES[String(errCode)] ?? '未在项目维护的错误码表中，请对照官方错误码文档';
}

/** 取 errCode / errMsg：返回体与抛出的错误对象字段名一致。 */
function wechatErrorFields(raw: unknown): { errCode: number; errMsg: string } {
  if (raw === null || raw === undefined || typeof raw !== 'object') return { errCode: -1, errMsg: '' };
  const source = raw as { errCode?: unknown; errcode?: unknown; errMsg?: unknown; errmsg?: unknown };
  const code = source.errCode ?? source.errcode;
  const message = source.errMsg ?? source.errmsg;
  return {
    errCode: typeof code === 'number' && Number.isFinite(code) ? code : -1,
    errMsg: typeof message === 'string' ? message : '',
  };
}

export type WechatVerdict = 'pass' | 'reject' | 'review' | 'error';

export interface WechatOutcome {
  errCode: number;
  errMsg: string;
  verdict: WechatVerdict;
  detail: string;
}

/**
 * 判定 `security.msgSecCheck` 的结果。
 *
 * 两种返回形态都要认：
 * - v2（带 openid）：errcode 0，判定在 `result.suggest`：pass / review / risky；
 * - v1（只传 content）：合规 errcode 0，违规以 errcode 87014 返回（可能 resolve 也可能 reject）。
 * 因此这里既看 errcode 也看 suggest，缺一不可。
 */
export function judgeMsgSecCheck(call: WechatCall): WechatOutcome {
  const raw = call.ok ? call.response : call.error;
  const { errCode, errMsg } = wechatErrorFields(raw);
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

  if (errCode === 87014) return { errCode, errMsg, verdict: 'reject', detail: `${detail}｜${wechatErrcodeNote(errCode)}` };
  if (errCode !== 0) return { errCode, errMsg, verdict: 'error', detail: `${detail}｜${wechatErrcodeNote(errCode)}` };
  if (suggest === 'risky') return { errCode, errMsg, verdict: 'reject', detail: `${detail}｜suggest=risky` };
  if (suggest === 'review') return { errCode, errMsg, verdict: 'review', detail: `${detail}｜suggest=review（需人工复审）` };
  return { errCode, errMsg, verdict: 'pass', detail };
}

/** 判定 `security.imgSecCheck`：合规 errcode 0，违规返回 87014（resolve 或 reject 都可能出现）。 */
export function judgeImgSecCheck(call: WechatCall): WechatOutcome {
  const raw = call.ok ? call.response : call.error;
  const { errCode, errMsg } = wechatErrorFields(raw);
  const detail = `errcode=${errCode}${errMsg === '' ? '' : `｜errmsg=${errMsg}`}`;
  if (errCode === 87014) return { errCode, errMsg, verdict: 'reject', detail: `${detail}｜${wechatErrcodeNote(errCode)}` };
  if (errCode !== 0) return { errCode, errMsg, verdict: 'error', detail: `${detail}｜${wechatErrcodeNote(errCode)}` };
  return { errCode, errMsg, verdict: 'pass', detail };
}

/** 一次内容安全检测的结果（含第三方审核的用量，供入口记账）。 */
export interface SafetyOutcome {
  report: SafetyReport;
  /** 第三方审核用的模型名；微信侧为接口名。 */
  model: string;
  /** 第三方审核的 token 用量；微信侧与 moderations 接口为 null。 */
  usage: TokenUsage | null;
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

function outcome(options: {
  provider: string;
  api: string;
  passed: boolean;
  detail: string;
  rejected: boolean;
  model: string;
  usage: TokenUsage | null;
  durationMs: number;
}): SafetyOutcome {
  return {
    report: { provider: options.provider, api: options.api, passed: options.passed, detail: options.detail },
    model: options.model,
    usage: options.usage,
    durationMs: options.durationMs,
    rejected: options.rejected,
  };
}

/**
 * 「内容安全检测不可用」的处置：默认挡住（closed）。可配置为放行，
 * 但报告里会写明「未检测」，不会让调用方以为已经检过。
 */
function unavailable(config: Config, provider: string, api: string, detail: string, durationMs: number): SafetyOutcome {
  const note = `内容安全检测不可用：${detail}`;
  if (config.safety.failMode === 'open') {
    return outcome({
      provider, api, passed: true, detail: `${note}（AI_SAFETY_FAIL_MODE=open，已放行未检测内容）`,
      rejected: false, model: api, usage: null, durationMs,
    });
  }
  fail('internal', `${note}（AI_SAFETY_FAIL_MODE=closed，拒绝调用；可切换第三方适配器或改为 open，见 docs/cloud-development.md）`);
}

function reviewPolicy(config: Config): { rejected: boolean; detail: string } {
  if (config.safety.reviewAs === 'pass') return { rejected: false, detail: 'review 按放行处理（AI_SAFETY_REVIEW_AS=pass）' };
  return { rejected: true, detail: 'review 按拒绝处理（AI_SAFETY_REVIEW_AS=reject，默认）' };
}

async function invokeWechat(call: () => Promise<unknown>): Promise<WechatCall> {
  try {
    return { ok: true, response: await call() };
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
  // v2 需要 openid 与 scene；拿不到 openid（例如控制台手动探测）时退回 v1 形态，
  // 判定逻辑两者都覆盖（见 judgeMsgSecCheck）。
  const params: Record<string, unknown> = openid === ''
    ? { content: input.text }
    : { content: input.text, version: 2, scene: config.safety.scene, openid };
  const call = await invokeWechat(() => api.msgSecCheck(params));
  const judged = judgeMsgSecCheck(call);
  const durationMs = Date.now() - startedAt;
  const form = openid === '' ? 'v1（无 openid）' : `v2（scene=${config.safety.scene}）`;
  if (judged.verdict === 'error') {
    return unavailable(config, 'wechat', 'security.msgSecCheck', `${form}｜${judged.detail}`, durationMs);
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
  }));
  const judged = judgeImgSecCheck(call);
  const durationMs = Date.now() - startedAt;
  if (judged.verdict === 'error') {
    return unavailable(config, 'wechat', 'security.imgSecCheck', judged.detail, durationMs);
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
  const invocation = {
    system: MODERATION_SYSTEM_PROMPT,
    messages: [moderationMessage(input)],
    timeoutMs: input.timeoutMs === undefined ? target.timeoutMs : input.timeoutMs,
  };
  let result;
  try {
    result = await callModel(target, invocation);
  } catch (error) {
    const detail = error instanceof AiFailure ? error.detail : describeError(error);
    return unavailable(config, target.format, api, redactSecrets(detail, [target.apiKey]), Date.now() - startedAt);
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
  let response;
  try {
    response = await postJson({
      url: `${target.baseUrl}/moderations`,
      headers: { Authorization: `Bearer ${target.apiKey}` },
      body,
      timeoutMs: input.timeoutMs === undefined ? target.timeoutMs : input.timeoutMs,
    });
  } catch (error) {
    return unavailable(config, target.format, api, redactSecrets(describeError(error), [target.apiKey]), Date.now() - startedAt);
  }
  if (response.status < 200 || response.status >= 300) {
    return unavailable(
      config, target.format, api,
      redactSecrets(`HTTP ${response.status}：${response.body.slice(0, 200)}`, [target.apiKey]),
      Date.now() - startedAt,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(response.body) as unknown;
  } catch {
    return unavailable(config, target.format, api, '审核接口返回不是合法 JSON', Date.now() - startedAt);
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
    // moderations 接口不返回 usage，如实记为空而不是猜一个数。
    usage: null,
    durationMs: Date.now() - startedAt,
  });
}

function thirdPartyUnavailable(config: Config, provider: string, api: string): SafetyOutcome {
  return unavailable(config, provider, api, '第三方审核适配器未配置完整（需要 AI_SAFETY_BASE_URL / AI_SAFETY_API_KEY / AI_SAFETY_MODEL）', 0);
}

/**
 * 文字内容安全检测入口。
 * 适配器由 `AI_SAFETY_PROVIDER` 选择：wechat（默认）/ openai / anthropic / off。
 */
export async function checkText(config: Config, input: TextCheckInput): Promise<SafetyOutcome> {
  const provider = config.safety.provider;
  if (provider === 'off') {
    return outcome({
      provider: 'off', api: 'none', passed: true, detail: '内容安全检测已关闭（AI_SAFETY_PROVIDER=off）',
      rejected: false, model: '', usage: null, durationMs: 0,
    });
  }
  if (provider === 'wechat') return wechatText(config, input);
  const target = resolveSafetyTarget(config);
  if (target === null) return thirdPartyUnavailable(config, provider, 'text-moderation');
  return thirdPartyCheck(config, target, { text: input.text, timeoutMs: input.timeoutMs }, 'text-moderation');
}

/**
 * 图片内容安全检测入口。**与文字检测分开**：微信侧是两个接口，Ticket 05 要先过图片检测再送模型。
 */
export async function checkImage(config: Config, input: ImageCheckInput): Promise<SafetyOutcome> {
  const provider = config.safety.provider;
  if (provider === 'off') {
    return outcome({
      provider: 'off', api: 'none', passed: true, detail: '内容安全检测已关闭（AI_SAFETY_PROVIDER=off）',
      rejected: false, model: '', usage: null, durationMs: 0,
    });
  }
  if (provider === 'wechat') return wechatImage(config, input);
  const target = resolveSafetyTarget(config);
  if (target === null) return thirdPartyUnavailable(config, provider, 'image-moderation');
  return thirdPartyCheck(config, target, { image: input.image, timeoutMs: input.timeoutMs }, 'image-moderation');
}
