/**
 * AI 云函数客户端封装（cloudfunctions/ai,Ticket 01 交付）。
 *
 * 产品里所有 AI 功能（部门问答 07 / 课表截图识别 05 / 课表助手 06）都经这里调用：
 * 密钥只在云函数环境变量，客户端只传 action / feature / 提示词与消息。
 * 三类用户可见失败（模型不可用 / 内容被拒 / 额度用尽）的文案各自独立，
 * 与两类技术失败（参数错误 / 内部错误）不合并（开发规格「AI 功能」）。
 *
 * 失败文案以**服务端返回的 `message` 为准**（服务端可用环境变量改措辞），
 * 本地 `AI_MESSAGES` 只在服务端没给文案时兜底；传输层错误映射见 `services/cloud.ts`。
 *
 * 三处 AI 功能共用的纯逻辑也放在这里，避免各票各写一份：
 * 对话历史裁剪与消息形状（`ChatMessage` / `chatMessages`）、从模型输出取 JSON（`extractJson`）、
 * 内容安全结论的用户提示（`safetyChecked` / `safetyNoteFor`）。
 */
import { requireCloud, transportMessage as sharedTransportMessage } from './cloud';

export const AI_FUNCTION = 'ai';

/**
 * 失败分类，与服务端 `cloudfunctions/ai/types.ts` 的 `FailureClass` 一一对应。
 *
 * 小程序**不引用云函数目录**（构建布局有断言），因此在这里同步一份联合类型：
 * 服务端改了分类名，`FAILURE_CLASSES` 与它的比对测试会失败（见
 * `tests/departments-qa.test.cjs`），而不是让客户端静默落到未知分类。
 */
export type FailureClass =
  | 'model_unavailable'
  | 'content_rejected'
  | 'quota_exhausted'
  | 'invalid_request'
  | 'internal';

/** 失败分类清单（运行时可用，供测试与服务端类型比对）。 */
export const FAILURE_CLASSES: FailureClass[] = [
  'model_unavailable',
  'content_rejected',
  'quota_exhausted',
  'invalid_request',
  'internal',
];

/**
 * 五类失败的用户兜底文案：前三类必须可区分，后两类只用于服务端没给 `message` 时兜底。
 *
 * 服务端返回的 `message` 非空时优先用它——负责人改云函数环境变量里的文案
 * （`AI_MSG_*`）应当立刻生效，「改措辞不用改代码」（docs/cloud-development.md）。
 */
export const AI_MESSAGES: Record<FailureClass, string> = {
  model_unavailable: 'AI 暂时不可用，请稍后再试；已保存的内容不受影响',
  content_rejected: '这次输入没有通过内容安全检测，请换个说法再试',
  quota_exhausted: '本月的 AI 用量已达上限，下个月恢复后再试',
  invalid_request: 'AI 服务无法处理这次请求（例如内容过长或格式不支持），请调整后重试',
  internal: 'AI 服务开小差了，请稍后重试',
};

/**
 * 图片输入（课表截图）的兜底文案覆盖项。
 *
 * 「换个说法」是文字语义：图片被拒时用户能做的只有换一张图，因此图片路径的
 * `content_rejected` 兜底改为「换一张」。仍然只在**服务端没给 `message`** 时使用
 * （服务端文案优先，云函数侧另有图片专属默认文案 `AI_MSG_CONTENT_REJECTED_IMAGE`）。
 */
export const AI_IMAGE_MESSAGES: Partial<Record<FailureClass, string>> = {
  content_rejected: '这张图片没有通过内容安全检测，请换一张再试',
};

/** 本地兜底文案按输入类型选择：`image` 表示这次调用上传的是图片。 */
export type AiInputKind = 'text' | 'image';

/**
 * 服务端的内容安全结论（`safety` 字段）。
 *
 * `passed` 与 `checked` 是两件事：`passed: true` 只表示「检过的范围内没发现问题」，
 * `checked: false` 表示这次**没有真正检测**（`AI_SAFETY_PROVIDER=off`、
 * `AI_SAFETY_FAIL_MODE=open` 放行未检内容，或长文本只检了前一段）。
 * 调用方不得把「跳过」读成「干净」——页面上的做法见 `pages/departments/qa.ts`。
 */
export interface AiSafetyReport {
  provider: string;
  api: string;
  passed: boolean;
  checked: boolean;
  detail: string;
}

/** 云函数返回中页面需要的字段；记账与探测字段不引入客户端。 */
export interface AiCallResult {
  ok: boolean;
  failureClass: FailureClass | '';
  /** 服务端用户可见文案；成功时为空串。 */
  message: string;
  text: string;
  capWarning: string;
  /** 内容安全结论；服务端没返回时为 null（按「未检测」处理，不当作干净）。 */
  safety: AiSafetyReport | null;
  /** 服务端非致命告警（如记账失败、`checked=false`）。 */
  warnings: string[];
}

/**
 * 服务端内容安全没有真正执行时的提示行（`safety.checked !== true`）。
 *
 * 依据 docs/cloud-development.md：`checked: false` 表示这次没有真正检测
 * （`AI_SAFETY_PROVIDER=off` 或 `AI_SAFETY_FAIL_MODE=open` 放行未检内容、长文本只检了前一段），
 * 调用方与日志都不得把「跳过」读成「干净」——07 与 06 都在对话里明说。
 */
export const UNCHECKED_SAFETY_NOTE = '⚠️ 本轮回答没有经过内容安全检测（服务端未执行或跳过了检测），请谨慎参考。';

/**
 * 服务端内容安全是否**真的执行过**。
 *
 * 只有 `safety.checked === true` 才算检测过：字段缺失、`safety` 为 null、
 * `checked: false`（检测被关闭/跳过/只检了一段）一律按「未检测」处理，
 * 宁可多提示一次，也不把跳过读成干净。
 */
export function safetyChecked(safety: { checked: boolean } | null | undefined): boolean {
  return safety !== null && safety !== undefined && safety.checked === true;
}

/** 未真正检测时对话里显示的提示行；检测过则为空串（页面据此隐藏该行）。 */
export function safetyNoteFor(safety: { checked: boolean } | null | undefined): string {
  return safetyChecked(safety) ? '' : UNCHECKED_SAFETY_NOTE;
}

/** 一条对话消息；07 部门问答与 06 课表助手共用（服务端 `messages` 的元素形状）。 */
export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

/** 多轮历史最多带多少条（与 ai 云函数 MAX_MESSAGES=20 对齐）；07 与 06 共用同一份。 */
export const MAX_HISTORY = 20;

/**
 * 页面上的多轮历史 → ai 云函数消息数组，只保留最近 `MAX_HISTORY` 条且不改变先后。
 *
 * 展示用的轮次可能比 `ChatMessage` 多带标记字段（如 07 的 `warning`），
 * 这里只取服务端认识的 `role` / `text` 两个字段，标记不混进送给模型的历史。
 */
export function chatMessages(history: ChatMessage[]): ChatMessage[] {
  return history.slice(-MAX_HISTORY).map((turn) => ({ role: turn.role, text: turn.text }));
}

/**
 * 从模型输出文本里取出 JSON 对象：先整体解析，失败时截取第一个 `{` 到最后一个 `}` 再试。
 *
 * 模型常把 JSON 包在 ```json 代码块或一句解释里，因此两步容错；非对象（数组、字符串）
 * 一律返回 null，由各调用方按自己的纪律回退（05 留空草稿、06 回退普通消息）。
 */
export function extractJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const tryParse = (source: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(source);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(trimmed);
  if (direct !== null) return direct;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return tryParse(trimmed.slice(start, end + 1));
}

/** 只接受服务端声明的分类名；未知值收敛成空串，由服务端 `message` 兜底。 */
function failureClassOf(value: unknown): FailureClass | '' {
  return typeof value === 'string' && (FAILURE_CLASSES as string[]).includes(value)
    ? value as FailureClass
    : '';
}

function safetyOf(value: unknown): AiSafetyReport | null {
  if (value === null || value === undefined || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  return {
    provider: typeof source.provider === 'string' ? source.provider : '',
    api: typeof source.api === 'string' ? source.api : '',
    passed: source.passed === true,
    // 只有服务端明确回 true 才算真的检测过；字段缺失一律按未检测处理。
    checked: source.checked === true,
    detail: typeof source.detail === 'string' ? source.detail : '',
  };
}

/** 调用 ai 云函数；调用本身失败（未部署/超时/权限）时抛错，由 transportMessage 转文案。 */
export async function callAi(data: Record<string, unknown>): Promise<AiCallResult> {
  requireCloud();
  const response = await wx.cloud.callFunction({ name: AI_FUNCTION, data });
  const result = response === null || response === undefined ? undefined : response.result;
  if (result === null || result === undefined || typeof result !== 'object') {
    throw new Error('AI 服务返回了无法识别的结果');
  }
  const source = result as Record<string, unknown>;
  return {
    ok: source.ok === true,
    failureClass: failureClassOf(source.failureClass),
    message: typeof source.message === 'string' ? source.message : '',
    text: typeof source.text === 'string' ? source.text : '',
    capWarning: typeof source.capWarning === 'string' ? source.capWarning : '',
    safety: safetyOf(source.safety),
    warnings: Array.isArray(source.warnings)
      ? source.warnings.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

/**
 * 业务失败的用户文案：**服务端 `message` 优先**（改措辞不用改代码），为空才回退本地表；
 * 本地表也没有时兜底内部错误文案。三类用户可见失败的服务端文案本就各自独立。
 *
 * `inputKind` 只影响本地兜底：图片输入时 `content_rejected` 用 `AI_IMAGE_MESSAGES` 的
 * 「换一张」而不是文字语义的「换个说法」。
 */
export function userMessage(result: AiCallResult, inputKind: AiInputKind = 'text'): string {
  if (result.ok) return '';
  if (result.message !== '') return result.message;
  if (result.failureClass !== '') {
    if (inputKind === 'image') {
      const forImage = AI_IMAGE_MESSAGES[result.failureClass];
      if (forImage !== undefined && forImage !== '') return forImage;
    }
    const known = AI_MESSAGES[result.failureClass];
    if (known !== '') return known;
  }
  return AI_MESSAGES.internal;
}

/**
 * 调用未到达云端（未部署/超时/权限/网络）时的兜底文案；原始错误打控制台留排查。
 * 与五类业务失败文案分开：传输失败不是「AI 内部错误」，两者排查方向不同。
 */
export const AI_TRANSPORT_FALLBACK = 'AI 服务暂时不可用，请稍后重试';

/** 调用未到达云端（未部署/超时/权限/网络）时的可读文案，原始错误打控制台留排查。 */
export function transportMessage(error: unknown): string {
  return sharedTransportMessage(error, {
    service: 'AI 服务',
    logLabel: 'AI 调用失败',
    fallback: AI_TRANSPORT_FALLBACK,
  });
}

/** chat 动作的事件组装（07 部门问答、06 课表助手共用）。 */
export function chatEvent(feature: string, system: string, messages: ChatMessage[]): Record<string, unknown> {
  return { action: 'chat', feature, system, messages };
}

/**
 * vision 动作的事件组装（05 课表截图识别用）：图片走事件顶层 `image` 的 fileID。
 *
 * 客户端只上传到云存储再用 fileID 调用（服务端仍支持 base64，那是给控制台探测与其它
 * 调用方留的入口；客户端侧没有这条路径，因此这里不声明 base64 分支）。
 */
export function visionEvent(
  feature: string,
  system: string,
  prompt: string,
  image: { fileID: string },
  maxTokens?: number,
): Record<string, unknown> {
  const event: Record<string, unknown> = {
    action: 'vision',
    feature,
    system,
    messages: [{ role: 'user', text: prompt }],
    image,
  };
  if (maxTokens !== undefined) event.maxTokens = maxTokens;
  return event;
}
