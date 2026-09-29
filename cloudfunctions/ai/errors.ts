/**
 * 失败分类与用户可见文案。
 *
 * 硬约束（开发规格「AI 功能」）：三类失败「模型不可用或超时」「内容被安全策略拒绝」
 * 「额度或配额用尽」必须可区分，**文案各自独立、不合并成一句**。
 *
 * 文案默认值写在代码里，但每一项都可以由云函数环境变量覆盖——
 * 措辞是负责人的决定，改措辞不该改代码（见 docs/development/cloud/ai.md 的环境变量表）。
 */
import { FailureClass } from './types';

const DEFAULT_MESSAGES: Record<FailureClass, string> = {
  model_unavailable: 'AI 模型暂时不可用或响应超时，请稍后重试；已保存的课表与部门资料仍可正常查看。',
  content_rejected: '内容未通过安全检测，请修改后重试。',
  quota_exhausted: '本月 AI 使用额度已用尽，暂时无法使用 AI 功能，请下月再试或联系维护者。',
  invalid_request: 'AI 请求参数不正确，请重试；若反复出现请联系维护者。',
  internal: 'AI 服务内部错误，请稍后重试。',
};

/** 文案覆盖用的环境变量名（与上面的键一一对应）。 */
const MESSAGE_ENV: Record<FailureClass, string> = {
  model_unavailable: 'AI_MSG_MODEL_UNAVAILABLE',
  content_rejected: 'AI_MSG_CONTENT_REJECTED',
  quota_exhausted: 'AI_MSG_QUOTA_EXHAUSTED',
  invalid_request: 'AI_MSG_INVALID_REQUEST',
  internal: 'AI_MSG_INTERNAL',
};

/**
 * 图片输入专属的默认文案：一条被拒的图片没有「改一改再试」的余地，用户能做的只有换一张；
 * 「请修改后重试」是文字语义。只覆盖需要区分的一类，其余类型与文字共用默认值。
 */
const DEFAULT_IMAGE_MESSAGES: Partial<Record<FailureClass, string>> = {
  content_rejected: '这张图片没有通过内容安全检测，请换一张再试。',
};

/** 图片专属文案的环境变量覆盖（改措辞不用改代码，与文字版并列）。 */
const IMAGE_MESSAGE_ENV: Partial<Record<FailureClass, string>> = {
  content_rejected: 'AI_MSG_CONTENT_REJECTED_IMAGE',
};

/** 输入类型：决定取哪一套默认文案（服务端调用方知道被拒的是图还是字）。 */
export type MessageInputKind = 'text' | 'image';

/**
 * 内容安全检测侧的**额度/配额用尽**文案，与 `quota_exhausted` 的默认文案（月度成本上限）分开。
 *
 * 两者同属「额度或配额用尽」一类（规格的三类失败之一），但**下一步不同**：
 * 月度上限要「下月再试」，当日检测配额（微信 45009，未上架小程序 100 次/天）是「次日恢复」——
 * 把当日的检测配额说成月度上限，会让用户白等一个月。这与「429 不归 quota_exhausted」是同一条理由：
 * 分类管的是可执行的下一步，不是错误来自谁。
 *
 * 实测依据：2026-09-19 在 `msgSecCheck` 上撞到 `45009 fail reach max api daily quota limit`，
 * 当时被归成 `internal`、用户看到「AI 服务开小差了」，而实际原因是当天检测次数用尽
 * （见 docs/development/cloud/ai.md 的内容安全配额一节）。
 */
const DEFAULT_SAFETY_QUOTA_MESSAGE = '内容安全检测的额度已用尽，AI 功能暂时不可用；未上架小程序每天有检测次数上限，通常次日恢复。';

/** 检测配额文案的环境变量名（与其它文案同一套覆盖规则：改措辞不改代码）。 */
export const SAFETY_QUOTA_MESSAGE_ENV = 'AI_MSG_QUOTA_EXHAUSTED_SAFETY';

/** 内容安全检测额度用尽时的用户文案：环境变量优先，缺省用代码里的默认值。 */
export function safetyQuotaMessage(): string {
  const override = process.env[SAFETY_QUOTA_MESSAGE_ENV];
  return typeof override === 'string' && override.trim() !== '' ? override.trim() : DEFAULT_SAFETY_QUOTA_MESSAGE;
}

/** 三类必需失败（供测试与文档核对；改动这里等于改动验收口径）。 */
export const REQUIRED_FAILURE_CLASSES: FailureClass[] = ['model_unavailable', 'content_rejected', 'quota_exhausted'];

/** 取某一类失败的用户文案：环境变量优先，缺省用代码里的默认值；`image` 时先看图片专属文案。 */
export function messageFor(failureClass: FailureClass, inputKind: MessageInputKind = 'text'): string {
  if (inputKind === 'image') {
    const imageEnv = IMAGE_MESSAGE_ENV[failureClass];
    const imageOverride = imageEnv === undefined ? undefined : process.env[imageEnv];
    if (typeof imageOverride === 'string' && imageOverride.trim() !== '') return imageOverride.trim();
    const imageDefault = DEFAULT_IMAGE_MESSAGES[failureClass];
    if (imageDefault !== undefined) return imageDefault;
  }
  const override = process.env[MESSAGE_ENV[failureClass]];
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return DEFAULT_MESSAGES[failureClass];
}

/** 默认文案（不受环境变量影响），文档与测试据此核对「三类不合并」与图片专属措辞。 */
export function defaultMessageFor(failureClass: FailureClass, inputKind: MessageInputKind = 'text'): string {
  if (inputKind === 'image') {
    const imageDefault = DEFAULT_IMAGE_MESSAGES[failureClass];
    if (imageDefault !== undefined) return imageDefault;
  }
  return DEFAULT_MESSAGES[failureClass];
}

export function messageEnvKey(failureClass: FailureClass): string {
  return MESSAGE_ENV[failureClass];
}

/**
 * 带失败分类的错误。`message` 是给用户看的文案，`detail` 是给维护者排查的细节，
 * 两者刻意分开：细节里可能出现服务端返回片段，不该直接上屏。
 */
export class AiFailure extends Error {
  readonly failureClass: FailureClass;
  readonly detail: string;
  /**
   * 是否由超时引起。让超时在整条链路上都是**可识别**的：
   * 调用方据此给出可重试措辞，内容安全层据此把「检测超时」与「检测配置错误」分开。
   */
  readonly timedOut: boolean;

  constructor(failureClass: FailureClass, detail = '', options: { message?: string; timedOut?: boolean } = {}) {
    super(options.message === undefined ? messageFor(failureClass) : options.message);
    this.name = 'AiFailure';
    this.failureClass = failureClass;
    this.detail = detail;
    this.timedOut = options.timedOut === true;
  }
}

/**
 * 抛出一个分类失败。`detail` 面向维护者，可以包含服务端错误文本（密钥在外层统一剔除）；
 * `options.message` 覆盖默认文案——分类不变，只是把「下一步怎么做」写得更具体。
 */
export function fail(failureClass: FailureClass, detail = '', options: { message?: string } = {}): never {
  throw new AiFailure(failureClass, detail, options);
}

/** 抛出一个由超时引起的分类失败（同一个类，但带上可重试标记）。 */
export function failTimeout(failureClass: FailureClass, detail = ''): never {
  throw new AiFailure(failureClass, detail, { timedOut: true });
}

/** 把任意异常收敛成分类失败：非 AiFailure 一律按内部错误处理，调用方拿到的是可处理的错误。 */
export function toFailure(error: unknown): AiFailure {
  if (error instanceof AiFailure) return error;
  return new AiFailure('internal', describeError(error));
}

/** 从各种异常形状里取一句可读的描述（兼容云函数的 errMsg 风格）。 */
export function describeError(error: unknown): string {
  if (error !== null && error !== undefined && typeof error === 'object') {
    const candidate = error as { message?: unknown; errMsg?: unknown; detail?: unknown };
    if (typeof candidate.message === 'string' && candidate.message !== '') return candidate.message;
    if (typeof candidate.errMsg === 'string' && candidate.errMsg !== '') return candidate.errMsg;
    if (typeof candidate.detail === 'string' && candidate.detail !== '') return candidate.detail;
  }
  return error === null || error === undefined ? '未知错误' : String(error);
}

/**
 * 剔除字符串里的密钥。
 *
 * 返回值与日志都可能带上服务端的原始错误文本，万一中转把请求里的 Authorization 回显出来，
 * 这里做最后一道拦截：**密钥不进日志、不进返回值**。
 */
export function redactSecrets(text: string, secrets: (string | undefined)[]): string {
  let result = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue;
    result = result.split(secret).join('***');
  }
  return result;
}
