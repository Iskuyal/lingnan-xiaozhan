/**
 * 模型适配层：两种接口格式（OpenAI 兼容 / Anthropic），文本与多模态走同一条路径。
 *
 * 分工刻意拆成三块，便于用桩验证而不碰网络：
 * - `buildModelRequest`：把规范化的对话映射成具体接口的请求（URL + 头 + 体）；
 * - `parseModelResponse`：把具体接口的返回映射成 `{ text, usage }`；
 * - `callModel`：串起 HTTP 与状态码分类，超时与网络错误统一收敛为「模型不可用或超时」。
 */
import { ModelTarget } from './config';
import { AiFailure, describeError, fail, redactSecrets, toFailure } from './errors';
import { HttpResponse, isTimeoutError, postJson } from './http';
import { ConversationMessage, NormalizedImage, TokenUsage } from './types';
import { estimateTokens } from './usage';

/** 图片在 token 估算里的固定开销：截图类图片无法按字符数估算，取一个偏保守的常数并注明是估算。 */
export const IMAGE_TOKEN_ESTIMATE = 800;

export interface ModelInvocation {
  system: string;
  messages: ConversationMessage[];
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ModelCallResult {
  text: string;
  usage: TokenUsage;
  finishReason: string;
  elapsedMs: number;
  httpStatus: number;
}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** 把图片转成 OpenAI 兼容接口接受的 data URL。 */
function dataUrl(image: NormalizedImage): string {
  return `data:${image.mimeType};base64,${image.base64}`;
}

/** 判断一条消息在具体接口里是否要展开成 content 数组（带图的消息必须）。 */
function isRichMessage(message: ConversationMessage): boolean {
  return message.image !== undefined;
}

function openAiMessages(invocation: ModelInvocation): unknown[] {
  const messages: unknown[] = [];
  if (invocation.system.trim() !== '') messages.push({ role: 'system', content: invocation.system });
  for (const message of invocation.messages) {
    if (message.role === 'system') {
      // 调用方可以自己带 system 消息（例如 07 要把部门资料作为上下文），按原样透传。
      messages.push({ role: 'system', content: message.text });
      continue;
    }
    if (!isRichMessage(message)) {
      messages.push({ role: message.role, content: message.text });
      continue;
    }
    const parts: unknown[] = [];
    if (message.text !== '') parts.push({ type: 'text', text: message.text });
    if (message.image !== undefined) {
      parts.push({ type: 'image_url', image_url: { url: dataUrl(message.image) } });
    }
    messages.push({ role: message.role, content: parts });
  }
  return messages;
}

/**
 * Anthropic 格式要求 user / assistant 交替出现，且 system 单独放顶层。
 * 相邻同角色消息合并成一条，避免调用方（05/06/07）为了适配接口格式自己拼接。
 */
function anthropicMessages(invocation: ModelInvocation): unknown[] {
  const merged: { role: 'user' | 'assistant'; text: string; image?: NormalizedImage }[] = [];
  for (const message of invocation.messages) {
    if (message.role === 'system') continue; // system 已在顶层
    const last = merged[merged.length - 1];
    if (last !== undefined && last.role === message.role) {
      last.text = last.text === '' ? message.text : `${last.text}\n\n${message.text}`;
      if (message.image !== undefined) last.image = message.image;
      continue;
    }
    merged.push({ role: message.role, text: message.text, image: message.image });
  }
  return merged.map((message) => {
    const blocks: unknown[] = [];
    if (message.text !== '') blocks.push({ type: 'text', text: message.text });
    if (message.image !== undefined) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: message.image.mimeType, data: message.image.base64 },
      });
    }
    return { role: message.role, content: blocks };
  });
}

/** 模型接口地址：两家的路径不同，由适配器决定，调用方不需要知道。 */
export function chatEndpoint(target: ModelTarget): string {
  return target.format === 'anthropic' ? `${target.baseUrl}/v1/messages` : `${target.baseUrl}/chat/completions`;
}

/** 构造一次模型调用请求（纯映射，无副作用，测试直接核对请求形状）。 */
export function buildModelRequest(target: ModelTarget, invocation: ModelInvocation): BuiltRequest {
  const maxTokens = invocation.maxTokens === undefined ? target.maxTokens : invocation.maxTokens;
  const body: Record<string, unknown> = target.format === 'anthropic'
    ? {
      model: target.model,
      max_tokens: maxTokens,
      temperature: target.temperature,
      // Anthropic 顶层 system 为空时不要带空串，部分网关会因此报参数错误。
      ...(invocation.system.trim() === '' ? {} : { system: invocation.system }),
      messages: anthropicMessages(invocation),
    }
    : {
      model: target.model,
      messages: openAiMessages(invocation),
      max_tokens: maxTokens,
      temperature: target.temperature,
    };
  // 厂商特有参数（例如关闭思考模式的 chat_template_kwargs）由环境变量追加，允许覆盖上面的默认值。
  for (const [key, value] of Object.entries(target.extraBody)) body[key] = value;
  const headers: Record<string, string> = target.format === 'anthropic'
    ? {
      'x-api-key': target.apiKey,
      'anthropic-version': target.anthropicVersion,
    }
    : { Authorization: `Bearer ${target.apiKey}` };
  return { url: chatEndpoint(target), headers, body: JSON.stringify(body) };
}

/** 从 OpenAI 风格的消息内容里取文本（content 可能是字符串，也可能是分块数组）。 */
function openAiContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const candidate = block as { type?: unknown; text?: unknown };
    if (typeof candidate.text === 'string' && (candidate.type === 'text' || candidate.type === 'output_text' || candidate.type === undefined)) {
      parts.push(candidate.text);
    }
  }
  return parts.join('');
}

function numberField(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function parseOpenAiUsage(raw: unknown): TokenUsage | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const promptTokens = numberField(source, 'prompt_tokens');
  const completionTokens = numberField(source, 'completion_tokens');
  const totalTokens = numberField(source, 'total_tokens');
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return null;
  return {
    promptTokens,
    completionTokens,
    totalTokens: totalTokens || promptTokens + completionTokens,
    estimated: false,
    usageUnknown: false,
  };
}

function parseAnthropicUsage(raw: unknown): TokenUsage | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const promptTokens = numberField(source, 'input_tokens');
  const completionTokens = numberField(source, 'output_tokens');
  if (promptTokens === 0 && completionTokens === 0) return null;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, estimated: false, usageUnknown: false };
}

/**
 * 解析模型返回。
 * 返回结构不符合预期（HTTP 200 但不是模型返回）按「模型不可用」处理并写清原因：
 * 这是中转的典型故障形态，调用方需要拿到可处理的失败而不是异常。
 */
export function parseModelResponse(target: ModelTarget, payload: unknown): { text: string; usage: TokenUsage | null; finishReason: string } {
  if (payload === null || typeof payload !== 'object') {
    fail('model_unavailable', '模型返回不是 JSON 对象');
  }
  const source = payload as Record<string, unknown>;
  if (target.format === 'anthropic') {
    const blocks = Array.isArray(source.content) ? source.content : [];
    const text = blocks
      .map((block) => (block !== null && typeof block === 'object' ? (block as { type?: unknown; text?: unknown }) : null))
      .filter((block): block is { type?: unknown; text?: unknown } => block !== null)
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('');
    if (text.trim() === '') fail('model_unavailable', '模型返回内容为空（Anthropic 格式）');
    return {
      text,
      usage: parseAnthropicUsage(source.usage),
      finishReason: typeof source.stop_reason === 'string' ? source.stop_reason : '',
    };
  }
  const choices = Array.isArray(source.choices) ? source.choices : [];
  const first = choices.length > 0 && choices[0] !== null && typeof choices[0] === 'object'
    ? (choices[0] as Record<string, unknown>)
    : null;
  const message = first !== null && first.message !== null && typeof first.message === 'object'
    ? (first.message as Record<string, unknown>)
    : null;
  const text = message === null ? '' : openAiContentText(message.content);
  const legacyText = text === '' && first !== null && typeof first.text === 'string' ? first.text : '';
  const finalText = text === '' ? legacyText : text;
  if (finalText.trim() === '') {
    // 只报告结构，不记录上游正文、推理内容或错误消息；下次冒烟可据此区分截断与非标准响应。
    const finishReason = first?.finish_reason;
    const safeFinishReason = typeof finishReason === 'string'
      && ['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(finishReason)
      ? finishReason
      : 'missing_or_other';
    const content = message?.content;
    const contentShape = content === undefined ? 'missing'
      : content === null ? 'null'
        : Array.isArray(content) ? 'blocks'
          : typeof content === 'string' ? 'string'
            : typeof content;
    fail('model_unavailable', '模型返回内容为空（OpenAI 兼容格式）'
      + `；choices=${choices.length}；finish_reason=${safeFinishReason}；content=${contentShape}`
      + `；reasoning_content=${message?.reasoning_content === undefined ? 'missing' : 'present'}`
      + `；error=${source.error === undefined ? 'missing' : 'present'}`
      + `；usage=${source.usage === undefined ? 'missing' : 'present'}`);
  }
  return {
    text: finalText,
    usage: parseOpenAiUsage(source.usage),
    finishReason: first !== null && typeof first.finish_reason === 'string' ? first.finish_reason : '',
  };
}

/**
 * 状态码分类：额度类与「模型不可用」分开，让页面文案能对上号。
 *
 * 402 是**真正的额度/余额用尽**（服务商侧配额），归 `quota_exhausted`；
 * 429 只是**瞬时限流**（重试即可），归 `model_unavailable`——
 * 把 429 也说成「本月额度已用尽，请下月再试」会让用户白等一个月。
 */
export function classifyHttpStatus(target: ModelTarget, status: number, body: string): AiFailure {
  const snippet = redactSecrets(body.replace(/\s+/g, ' ').slice(0, 300), [target.apiKey]);
  if (status === 402) {
    return new AiFailure('quota_exhausted', `HTTP ${status}（服务商额度或余额不足）：${snippet}`);
  }
  if (status === 429) {
    return new AiFailure('model_unavailable', `HTTP ${status}（请求过于频繁，属瞬时限流，稍后重试即可）：${snippet}`);
  }
  if (status === 401 || status === 403) {
    return new AiFailure('model_unavailable', `HTTP ${status}（鉴权失败，检查 AI_API_KEY 与账号权限）：${snippet}`);
  }
  return new AiFailure('model_unavailable', `HTTP ${status}：${snippet}`);
}

/** 服务端没有返回 usage 时按字符数估算，保证成本上限判断不会因为缺字段而系统性低估。 */
export function estimateUsage(invocation: ModelInvocation, text: string): TokenUsage {
  let prompt = estimateTokens(invocation.system);
  for (const message of invocation.messages) {
    prompt += estimateTokens(message.text);
    if (message.image !== undefined) prompt += IMAGE_TOKEN_ESTIMATE;
  }
  const completionTokens = estimateTokens(text);
  return { promptTokens: prompt, completionTokens, totalTokens: prompt + completionTokens, estimated: true, usageUnknown: false };
}

/**
 * 发一次带分类的 JSON 请求：传输、状态码分类与非 JSON 都收敛成可识别失败。
 *
 * 抽出来是为了让 chat 调用与 OpenAI `/moderations` 走**同一条**传输/状态码/解析路径，
 * 不再各写一遍（两处实现分叉时，超时与限流分类会悄悄不一致）。
 */
export async function requestJson(
  target: ModelTarget,
  request: BuiltRequest,
  options: { timeoutMs: number; label: string },
): Promise<{ payload: unknown; elapsedMs: number; status: number }> {
  const startedAt = Date.now();
  let response: HttpResponse;
  try {
    response = await postJson({
      url: request.url,
      headers: request.headers,
      body: request.body,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    const detail = redactSecrets(describeError(error), [target.apiKey]);
    if (isTimeoutError(error)) {
      // 超时单独标记：调用方要能看出「这次是超时，可以重试」而不是笼统的请求失败。
      throw new AiFailure('model_unavailable', `${options.label}超时：${detail}`, { timedOut: true });
    }
    throw new AiFailure('model_unavailable', `${options.label}请求失败：${detail}`);
  }
  const elapsedMs = Date.now() - startedAt;
  if (response.status < 200 || response.status >= 300) {
    throw classifyHttpStatus(target, response.status, response.body);
  }
  try {
    return { payload: JSON.parse(response.body) as unknown, elapsedMs, status: response.status };
  } catch {
    throw new AiFailure('model_unavailable', `${options.label}返回不是合法 JSON：${redactSecrets(response.body.slice(0, 200), [target.apiKey])}`);
  }
}

/**
 * 调用模型。**任何失败都收敛成分类失败**（不抛裸异常）：
 * 中转不可用、超时、返回非 JSON 都让调用方拿到可处理的错误。
 */
export async function callModel(target: ModelTarget, invocation: ModelInvocation): Promise<ModelCallResult> {
  const request = buildModelRequest(target, invocation);
  const timeoutMs = invocation.timeoutMs === undefined ? target.timeoutMs : invocation.timeoutMs;
  const { payload, elapsedMs, status } = await requestJson(target, request, { timeoutMs, label: '模型调用' });
  let parsed;
  try {
    parsed = parseModelResponse(target, payload);
  } catch (error) {
    throw toFailure(error);
  }
  return {
    text: parsed.text,
    usage: parsed.usage === null ? estimateUsage(invocation, parsed.text) : parsed.usage,
    finishReason: parsed.finishReason,
    elapsedMs,
    httpStatus: status,
  };
}
