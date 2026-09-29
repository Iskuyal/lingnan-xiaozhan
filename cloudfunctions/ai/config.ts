/**
 * AI 云函数配置：全部来自云函数环境变量，代码里不放密钥，也不写死价格与上限。
 *
 * 为什么每项都有默认值（除密钥与模型名）：Ticket 01 要求密钥只在云函数环境变量、
 * 月度上限与单价「来自环境变量而非写死」，默认值只是让函数少配几项也能跑；
 * 数值默认值都注明出处（AI 资讯实测报告 / 开发规格），不是拍脑袋。
 * 密钥与模型名故意**没有**默认值：本项目实测过的是 DeepSeek 官方 API（见
 * docs/reference/ai-news-poc.md），**中转地址、模型名与实际单价均未实测**，
 * 猜一个默认值只会让错误延后暴露。
 */
import { fail } from './errors';
import {
  ProviderFormat,
  SafetyFailMode,
  SafetyOpenAiMode,
  SafetyProviderName,
  SafetyReviewPolicy,
} from './types';

/** 已解析配置；键来自环境变量，值已做类型与范围收敛。 */
export interface Config {
  provider: ProviderFormat;
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel: string;
  anthropicBaseUrl: string;
  anthropicApiKey: string;
  anthropicVersion: string;
  /** 单次模型调用超时（毫秒）。 */
  timeoutMs: number;
  /** 一次云函数调用的总截止（毫秒）：内容安全 + 模型 + 输出检测都算在里面。 */
  totalDeadlineMs: number;
  /** 云存储下载（vision 的 fileID 路径）单次超时：下载同样可能一直不返回。 */
  downloadTimeoutMs: number;
  maxTokens: number;
  temperature: number;
  /** 追加进模型请求体的 JSON，用于关闭思考模式等厂商特有参数。 */
  extraBody: Record<string, unknown>;
  priceInputPerMillion: number;
  priceOutputPerMillion: number;
  monthlyCapYuan: number;
  capWarnRatio: number;
  moderateOutput: boolean;
  maxImageBytes: number;
  safety: SafetyConfig;
}

/** 内容安全适配层配置。 */
export interface SafetyConfig {
  provider: SafetyProviderName;
  failMode: SafetyFailMode;
  reviewAs: SafetyReviewPolicy;
  baseUrl: string;
  apiKey: string;
  model: string;
  anthropicVersion: string;
  /**
   * OpenAI 格式下的调用方式：chat（任何兼容中转可用，默认）/ moderations（OpenAI 官方审核接口）。
   * 接口格式由 `provider` 决定（anthropic 就用 Anthropic 格式），不单独配，避免两个开关打架。
   */
  openaiMode: SafetyOpenAiMode;
  timeoutMs: number;
  /** 每次审核调用的固定价（元）：接口不返回 token 用量时按它记账，默认 0。 */
  fixedPriceYuan: number;
  /** 微信 msgSecCheck v2 的 scene：1 资料、2 评论、3 论坛、4 社交日志。 */
  scene: number;
  /** 第三方审核单次调用的最大输出 token（只要求返回一个短 JSON）。 */
  maxTokens: number;
}

export function envString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  return raw.trim();
}

export function envNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function envBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') return true;
  if (value === 'false' || value === '0' || value === 'no' || value === 'off') return false;
  return fallback;
}

function envJson(env: NodeJS.ProcessEnv, name: string): Record<string, unknown> {
  const raw = env[name];
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail('internal', `${name} 必须是 JSON 对象，例如 {"chat_template_kwargs":{"thinking":false}}`);
    }
    return parsed as Record<string, unknown>;
  } catch {
    fail('internal', `${name} 不是合法 JSON`);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 接口根地址去尾斜杠：拼接路径时不会出现 `//`。 */
function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * 读取配置。
 *
 * `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` 缺失时**不在这里报错**：
 * `usage` 与 `probe` 两个动作不需要模型配置，只有真正要调模型时才用 resolveModelTarget 校验，
 * 这样维护者能在没配密钥时先查用量、先跑内容安全探测。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const provider: ProviderFormat = envString(env, 'AI_PROVIDER', 'openai') === 'anthropic' ? 'anthropic' : 'openai';
  const totalDeadlineMs = clamp(envNumber(env, 'AI_TOTAL_DEADLINE_MS', 15000), 3000, 60000);
  const timeoutMs = clamp(envNumber(env, 'AI_TIMEOUT_MS', 8000), 1000, totalDeadlineMs);
  const model = envString(env, 'AI_MODEL', '');
  const baseUrl = normalizeBaseUrl(envString(env, 'AI_BASE_URL', ''));
  const apiKey = envString(env, 'AI_API_KEY', '');
  const anthropicVersion = envString(env, 'AI_ANTHROPIC_VERSION', '2023-06-01');
  const safetyProviderRaw = envString(env, 'AI_SAFETY_PROVIDER', 'wechat');
  const safetyProvider: SafetyProviderName =
    safetyProviderRaw === 'openai' || safetyProviderRaw === 'anthropic' || safetyProviderRaw === 'off'
      ? safetyProviderRaw
      : 'wechat';

  return {
    provider,
    baseUrl,
    apiKey,
    model,
    // 没有单独的视觉模型时复用文本模型名：单模型同时支持多模态时只配一项。
    visionModel: envString(env, 'AI_VISION_MODEL', model),
    anthropicBaseUrl: normalizeBaseUrl(envString(env, 'AI_ANTHROPIC_BASE_URL', 'https://api.anthropic.com')),
    anthropicApiKey: envString(env, 'AI_ANTHROPIC_API_KEY', ''),
    anthropicVersion,
    timeoutMs,
    totalDeadlineMs,
    // 下载超时同样受总截止约束：不能比一次云函数调用能用的时间还长。
    downloadTimeoutMs: Math.floor(clamp(envNumber(env, 'AI_DOWNLOAD_TIMEOUT_MS', 5000), 1000, totalDeadlineMs)),
    maxTokens: Math.floor(clamp(envNumber(env, 'AI_MAX_TOKENS', 1024), 1, 8192)),
    temperature: clamp(envNumber(env, 'AI_TEMPERATURE', 0.2), 0, 2),
    extraBody: envJson(env, 'AI_EXTRA_BODY_JSON'),
    // 单价默认值来自 AI 资讯实测（DeepSeek **官方** API：V4.1 Flash 空闲时段 输入 1 元 / 输出 4 元每百万 token，
    // docs/reference/ai-news-poc.md 第三节）。中转的实际单价**未实测**（见该文档与 cloud-development.md
    // 「已知限制」），负责人必须把**实际单价**配进环境变量，否则成本上限判断会偏低。
    priceInputPerMillion: Math.max(0, envNumber(env, 'AI_PRICE_INPUT_PER_MILLION', 1)),
    priceOutputPerMillion: Math.max(0, envNumber(env, 'AI_PRICE_OUTPUT_PER_MILLION', 4)),
    monthlyCapYuan: Math.max(0, envNumber(env, 'AI_MONTHLY_CAP_YUAN', 50)),
    capWarnRatio: clamp(envNumber(env, 'AI_CAP_WARN_RATIO', 0.8), 0, 1),
    moderateOutput: envBool(env, 'AI_MODERATE_OUTPUT', true),
    // 微信 imgSecCheck 官方限制：图片不超过 1MB、尺寸 750x1334 以内、格式 PNG/JPG。
    // 默认按 1MB 拦，Ticket 05 的截图需要先压缩到该范围内。
    maxImageBytes: Math.floor(clamp(envNumber(env, 'AI_MAX_IMAGE_BYTES', 1048576), 1024, 10 * 1024 * 1024)),
    safety: {
      provider: safetyProvider,
      failMode: envString(env, 'AI_SAFETY_FAIL_MODE', 'closed') === 'open' ? 'open' : 'closed',
      reviewAs: envString(env, 'AI_SAFETY_REVIEW_AS', 'reject') === 'pass' ? 'pass' : 'reject',
      baseUrl: normalizeBaseUrl(envString(env, 'AI_SAFETY_BASE_URL', baseUrl)),
      apiKey: envString(env, 'AI_SAFETY_API_KEY', apiKey),
      // 默认用同一个模型做审核判定（走中转时通常只有这一个模型可用）。
      model: envString(env, 'AI_SAFETY_MODEL', model),
      anthropicVersion: envString(env, 'AI_SAFETY_ANTHROPIC_VERSION', anthropicVersion),
      openaiMode: envString(env, 'AI_SAFETY_OPENAI_MODE', 'chat') === 'moderations' ? 'moderations' : 'chat',
      // 微信云调用与云存储下载都用这条超时；下限 1 秒，避免配出必然超时的值。
      timeoutMs: Math.floor(clamp(envNumber(env, 'AI_SAFETY_TIMEOUT_MS', Math.min(timeoutMs, 6000)), 1000, totalDeadlineMs)),
      // 接口不返回 token 用量时（如 OpenAI /moderations）的每次固定价；0 表示不计入金额，但会标记 usageUnknown。
      fixedPriceYuan: Math.max(0, envNumber(env, 'AI_SAFETY_CALL_PRICE_YUAN', 0)),
      scene: Math.floor(clamp(envNumber(env, 'AI_SAFETY_SCENE', 1), 1, 4)),
      maxTokens: Math.floor(clamp(envNumber(env, 'AI_SAFETY_MAX_TOKENS', 256), 16, 2048)),
    },
  };
}

/** 模型调用的目标（含接口格式与密钥），供 providers 构造请求。 */
export interface ModelTarget {
  format: ProviderFormat;
  baseUrl: string;
  apiKey: string;
  model: string;
  anthropicVersion: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  extraBody: Record<string, unknown>;
}

/**
 * 校验并取出模型调用目标；缺配置时按内部错误处理并写清缺了哪个环境变量。
 * 信息只写环境变量名，不写值。
 */
export function resolveModelTarget(config: Config, options: { vision: boolean; maxTokens?: number; timeoutMs?: number }): ModelTarget {
  const missing: string[] = [];
  if (config.provider === 'anthropic') {
    if (config.anthropicBaseUrl === '') missing.push('AI_ANTHROPIC_BASE_URL');
    if (config.anthropicApiKey === '') missing.push('AI_ANTHROPIC_API_KEY');
    if (config.model === '') missing.push('AI_MODEL');
  } else {
    if (config.baseUrl === '') missing.push('AI_BASE_URL');
    if (config.apiKey === '') missing.push('AI_API_KEY');
    if (config.model === '') missing.push('AI_MODEL');
  }
  if (missing.length > 0) {
    fail('internal', `AI 服务未配置：缺少云函数环境变量 ${missing.join('、')}（配置方式见 docs/development/cloud/ai.md）`);
  }
  const isAnthropic = config.provider === 'anthropic';
  const model = options.vision ? config.visionModel : config.model;
  if (model === '') {
    fail('internal', 'AI 服务未配置：缺少云函数环境变量 AI_MODEL（多模态调用可另配 AI_VISION_MODEL）');
  }
  return {
    format: config.provider,
    baseUrl: isAnthropic ? config.anthropicBaseUrl : config.baseUrl,
    apiKey: isAnthropic ? config.anthropicApiKey : config.apiKey,
    model,
    anthropicVersion: config.anthropicVersion,
    timeoutMs: options.timeoutMs === undefined ? config.timeoutMs : clamp(options.timeoutMs, 1000, config.timeoutMs),
    maxTokens: options.maxTokens === undefined ? config.maxTokens : Math.floor(clamp(options.maxTokens, 1, 8192)),
    temperature: config.temperature,
    extraBody: config.extraBody,
  };
}

/** 内容安全第三方适配器的调用目标；未配置或 provider 为 wechat 时返回 null。 */
export function resolveSafetyTarget(config: Config): ModelTarget | null {
  const safety = config.safety;
  if (safety.provider !== 'openai' && safety.provider !== 'anthropic') return null;
  if (safety.baseUrl === '' || safety.apiKey === '' || safety.model === '') return null;
  return {
    // 接口格式由适配器选择决定：选 anthropic 就用 Anthropic 格式，选 openai 就用 OpenAI 格式。
    format: safety.provider === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: safety.baseUrl,
    apiKey: safety.apiKey,
    model: safety.model,
    anthropicVersion: safety.anthropicVersion,
    timeoutMs: safety.timeoutMs,
    maxTokens: safety.maxTokens,
    temperature: 0,
    extraBody: {},
  };
}

/** 所有密钥（用于日志与返回值脱敏）。 */
export function secretsOf(config: Config): string[] {
  return [config.apiKey, config.anthropicApiKey, config.safety.apiKey];
}
