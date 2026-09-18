/**
 * AI 云函数客户端封装（cloudfunctions/ai,Ticket 01 交付）。
 *
 * 产品里所有 AI 功能（部门问答 07 / 课表截图识别 05 / 课表助手 06）都经这里调用：
 * 密钥只在云函数环境变量，客户端只传 action / feature / 提示词与消息。
 * 三类用户可见失败（模型不可用 / 内容被拒 / 额度用尽）的文案各自独立，
 * 与两类技术失败（参数错误 / 内部错误）不合并（开发规格「AI 功能」）。
 */

export const AI_FUNCTION = 'ai';

/** 五类失败的用户文案：前三类必须可区分，后两类只用于兜底排查。 */
export const AI_MESSAGES: Record<string, string> = {
  model_unavailable: 'AI 暂时不可用，请稍后再试；已保存的内容不受影响',
  content_rejected: '这次输入没有通过内容安全检测，请换个说法再试',
  quota_exhausted: '本月的 AI 用量已达上限，下个月恢复后再试',
  invalid_request: '请求没有送达 AI 服务，请稍后重试',
  internal: 'AI 服务开小差了，请稍后重试',
};

/** 云函数返回中页面需要的字段；记账与探测字段不引入客户端。 */
export interface AiCallResult {
  ok: boolean;
  failureClass: string;
  message: string;
  text: string;
  capWarning: string;
}

function requireCloud(): void {
  if (typeof wx === 'undefined' || wx.cloud === undefined) {
    throw new Error('云开发不可用：请确认基础库版本与 app.ts 中的 wx.cloud.init');
  }
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
    failureClass: typeof source.failureClass === 'string' ? source.failureClass : '',
    message: typeof source.message === 'string' ? source.message : '',
    text: typeof source.text === 'string' ? source.text : '',
    capWarning: typeof source.capWarning === 'string' ? source.capWarning : '',
  };
}

/** 业务失败的用户文案：三类用户可见失败各自独立；未知分类给服务端原文，再兜底内部错误文案。 */
export function userMessage(result: AiCallResult): string {
  if (result.ok) return '';
  const known = AI_MESSAGES[result.failureClass];
  if (known !== undefined && known !== '') return known;
  if (result.message !== '') return result.message;
  return AI_MESSAGES.internal;
}

/** 调用未到达云端（未部署/超时/权限/网络）时的可读文案，原始错误打控制台留排查。 */
export function transportMessage(error: unknown): string {
  let raw = '';
  if (error !== null && error !== undefined && typeof error === 'object') {
    const candidate = error as { message?: unknown; errMsg?: unknown };
    if (typeof candidate.message === 'string' && candidate.message !== '') raw = candidate.message;
    else if (typeof candidate.errMsg === 'string' && candidate.errMsg !== '') raw = candidate.errMsg;
  } else {
    raw = error === null || error === undefined ? '' : String(error);
  }
  if (/FUNCTION_NOT_FOUND|FunctionName parameter could not be found/u.test(raw)) {
    return 'AI 服务暂时不可用（云函数尚未部署），请稍后重试';
  }
  if (/permission denied|-501023/u.test(raw)) {
    return '没有权限使用 AI 服务，请确认已用微信登录后重试';
  }
  if (/timeout|-504003/u.test(raw)) {
    return 'AI 服务响应超时，请稍后重试';
  }
  if (raw !== '') console.error('AI 调用失败：', raw);
  return 'AI 服务暂时不可用，请稍后重试';
}

/** chat 动作的事件组装（07 部门问答、06 课表助手共用）。 */
export function chatEvent(
  feature: string,
  system: string,
  messages: { role: 'user' | 'assistant'; text: string }[],
): Record<string, unknown> {
  return { action: 'chat', feature, system, messages };
}
