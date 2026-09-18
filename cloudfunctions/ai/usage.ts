/**
 * 用量记账与月度成本上限。
 *
 * 落两处：
 * - `ai_usage_records`：每次子调用（模型调用、第三方内容安全检测）一条，记录耗时、
 *   token、金额与失败分类——「每次调用记录耗时与用量」的落点；
 * - `ai_usage_monthly`：每月一条文档（`_id` 为东八区月份，如 `2026-09`），用原子自增累加，
 *   是累计用量查询与成本上限判断的唯一来源。
 *
 * 单价与上限都来自环境变量：默认值是 AI 资讯实测的官方单价与规格定下的 50 元上限，
 * 换中转、换模型、调整上限都只改配置，不动代码。
 */
import { Config } from './config';
import { fail } from './errors';
import { CallUsage, SubCallRecord, TokenUsage, UsageSummary } from './types';

export const USAGE_RECORD_COLLECTION = 'ai_usage_records';
export const USAGE_MONTH_COLLECTION = 'ai_usage_monthly';

/** 单次调用记录的字段契约（测试据此锁定形状，避免字段悄悄改名）。 */
export const USAGE_RECORD_FIELDS: string[] = [
  'requestId', 'feature', 'action', 'kind', 'provider', 'model', 'ok', 'failureClass',
  'durationMs', 'promptTokens', 'completionTokens', 'totalTokens', 'estimated', 'costYuan',
  'month', 'createdAt',
];

/** 月度汇总文档的字段契约。 */
export const USAGE_MONTH_FIELDS: string[] = [
  'month', 'calls', 'failures', 'promptTokens', 'completionTokens', 'totalTokens', 'costYuan', 'updatedAt',
];

/** 记账所需的最小数据库接口（只用到 add / doc.get / doc.set / doc.update 与原子自增）。 */
export interface UsageDb {
  command: { inc(value: number): unknown };
  collection(name: string): {
    add(options: { data: Record<string, unknown> }): Promise<unknown>;
    doc(id: string): {
      get(): Promise<{ data?: unknown }>;
      set(options: { data: Record<string, unknown> }): Promise<unknown>;
      update(options: { data: Record<string, unknown> }): Promise<unknown>;
    };
  };
}

/** 东八区月份（YYYY-MM）。定时任务与用户都在东八区，成本上限按月判断必须用东八区的月份。 */
export function shanghaiMonth(date: Date): string {
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 7);
}

/**
 * 粗略估算 token 数：中日韩字符按 1 token/字，其余非空白字符按 4 字符/token。
 * 只在服务端没返回 usage 时兜底——不估算就等于把成本记成 0，上限会被系统性低估。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (/\s/u.test(char)) continue;
    if (/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/u.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** 金额保留 6 位小数：单次调用常常是 0.000x 元，位数太少会记成 0。 */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** 由 token 数与单价算出金额。 */
export function costOf(usage: TokenUsage, priceInputPerMillion: number, priceOutputPerMillion: number): number {
  const input = (usage.promptTokens / 1e6) * priceInputPerMillion;
  const output = (usage.completionTokens / 1e6) * priceOutputPerMillion;
  return round6(input + output);
}

/** 把 token 用量与单价组成一次调用的完整用量。 */
export function toCallUsage(usage: TokenUsage, config: Config): CallUsage {
  return {
    ...usage,
    costYuan: costOf(usage, config.priceInputPerMillion, config.priceOutputPerMillion),
    priceInputPerMillion: config.priceInputPerMillion,
    priceOutputPerMillion: config.priceOutputPerMillion,
  };
}

function numberFrom(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** 空汇总（当月还没发生过调用，或文档缺失）。 */
export function emptySummary(month: string, config: Config, updatedAt: string): UsageSummary {
  return {
    month,
    calls: 0,
    failures: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costYuan: 0,
    capYuan: config.monthlyCapYuan,
    warnRatio: config.capWarnRatio,
    warnThresholdYuan: round6(config.monthlyCapYuan * config.capWarnRatio),
    warn: false,
    exceeded: false,
    priceInputPerMillion: config.priceInputPerMillion,
    priceOutputPerMillion: config.priceOutputPerMillion,
    updatedAt,
  };
}

function toSummary(month: string, raw: Record<string, unknown> | null, config: Config, updatedAt: string): UsageSummary {
  if (raw === null) return emptySummary(month, config, updatedAt);
  const summary: UsageSummary = {
    month,
    calls: numberFrom(raw, 'calls'),
    failures: numberFrom(raw, 'failures'),
    promptTokens: numberFrom(raw, 'promptTokens'),
    completionTokens: numberFrom(raw, 'completionTokens'),
    totalTokens: numberFrom(raw, 'totalTokens'),
    costYuan: numberFrom(raw, 'costYuan'),
    capYuan: config.monthlyCapYuan,
    warnRatio: config.capWarnRatio,
    warnThresholdYuan: round6(config.monthlyCapYuan * config.capWarnRatio),
    warn: false,
    exceeded: false,
    priceInputPerMillion: config.priceInputPerMillion,
    priceOutputPerMillion: config.priceOutputPerMillion,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : updatedAt,
  };
  summary.warn = summary.costYuan >= summary.warnThresholdYuan && summary.costYuan < summary.capYuan;
  summary.exceeded = summary.costYuan >= summary.capYuan;
  return summary;
}

/**
 * 判断异常是否是「文档不存在」。云数据库对缺失文档抛的错误里带这类字样；
 * 其余读取失败（网络、权限、集合不存在）一律视为数据库故障。
 */
export function isMissingDocumentError(error: unknown): boolean {
  const message = error === null || error === undefined
    ? ''
    : typeof error === 'object'
      ? String((error as { errMsg?: unknown; message?: unknown }).errMsg ?? (error as { message?: unknown }).message ?? '')
      : String(error);
  return /not exist|does not exist|doesn't exist|DOCUMENT_NOT_EXIST|non-exists/iu.test(message);
}

/**
 * 读当月累计用量。
 *
 * 读失败**不降级为零**：读不到就无法判断上限，继续调用等于放弃成本控制。
 * 因此除「文档不存在」（当月首次调用）外，读取失败原样抛出，由入口收敛成 internal 失败——
 * 宁可挡住，也不静默超支。
 */
export async function readUsageSummary(db: UsageDb, config: Config, now: Date): Promise<UsageSummary> {
  const month = shanghaiMonth(now);
  const updatedAt = now.toISOString();
  try {
    const result = await db.collection(USAGE_MONTH_COLLECTION).doc(month).get();
    const data = result === null || result === undefined ? null : result.data;
    if (data === null || data === undefined || typeof data !== 'object') return emptySummary(month, config, updatedAt);
    return toSummary(month, data as Record<string, unknown>, config, updatedAt);
  } catch (error) {
    if (isMissingDocumentError(error)) return emptySummary(month, config, updatedAt);
    throw error;
  }
}

/** 把一条子调用记录累加进汇总（纯函数，返回新的汇总对象）。 */
export function applyRecord(summary: UsageSummary, record: SubCallRecord): UsageSummary {
  const next: UsageSummary = {
    ...summary,
    calls: summary.calls + 1,
    failures: summary.failures + (record.ok ? 0 : 1),
    promptTokens: summary.promptTokens + record.usage.promptTokens,
    completionTokens: summary.completionTokens + record.usage.completionTokens,
    totalTokens: summary.totalTokens + record.usage.totalTokens,
    costYuan: round6(summary.costYuan + record.usage.costYuan),
    updatedAt: new Date().toISOString(),
  };
  next.warn = next.costYuan >= next.warnThresholdYuan && next.costYuan < next.capYuan;
  next.exceeded = next.costYuan >= next.capYuan;
  return next;
}

/**
 * 写一条调用记录并累加月度汇总。
 *
 * 汇总用原子自增（`command.inc`）：两次调用并发时也不会互相覆盖。
 * 当月文档还不存在时先 `set` 出初值；`set` 与并发调用之间仍可能各写一份（丢一次计数），
 * 概率极低且方向不受控，故在此注明为已知限制而不是假装没有。
 */
export async function recordSubCall(db: UsageDb, record: SubCallRecord, config: Config, now: Date): Promise<void> {
  const month = shanghaiMonth(now);
  const createdAt = now.toISOString();
  const data: Record<string, unknown> = {
    requestId: record.requestId,
    feature: record.feature,
    action: record.action,
    kind: record.kind,
    provider: record.provider,
    model: record.model,
    ok: record.ok,
    failureClass: record.failureClass,
    durationMs: Math.max(0, Math.round(record.durationMs)),
    promptTokens: record.usage.promptTokens,
    completionTokens: record.usage.completionTokens,
    totalTokens: record.usage.totalTokens,
    estimated: record.usage.estimated,
    costYuan: record.usage.costYuan,
    month,
    createdAt,
  };
  await db.collection(USAGE_RECORD_COLLECTION).add({ data });

  const delta: Record<string, unknown> = {
    calls: db.command.inc(1),
    failures: db.command.inc(record.ok ? 0 : 1),
    promptTokens: db.command.inc(record.usage.promptTokens),
    completionTokens: db.command.inc(record.usage.completionTokens),
    totalTokens: db.command.inc(record.usage.totalTokens),
    costYuan: db.command.inc(record.usage.costYuan),
    updatedAt: createdAt,
  };
  const monthly = db.collection(USAGE_MONTH_COLLECTION);
  try {
    await monthly.doc(month).update({ data: delta });
    return;
  } catch {
    // 文档不存在：写入初值。若并发调用刚好也建了文档，以先写入者为准（见函数注释）。
  }
  await monthly.doc(month).set({
    data: {
      month,
      calls: 1,
      failures: record.ok ? 0 : 1,
      promptTokens: record.usage.promptTokens,
      completionTokens: record.usage.completionTokens,
      totalTokens: record.usage.totalTokens,
      costYuan: record.usage.costYuan,
      updatedAt: createdAt,
    },
  });
}

/**
 * 上限判定：已达月度上限直接拒绝调用（`quota_exhausted`），
 * 接近阈值只告警，不拦（是否需要提前拦由负责人按 `AI_CAP_WARN_RATIO` 决定）。
 */
export function assertWithinCap(summary: UsageSummary): void {
  if (!summary.exceeded) return;
  fail(
    'quota_exhausted',
    `本月（${summary.month}）累计成本 ${summary.costYuan} 元，已达上限 ${summary.capYuan} 元；`
    + `调整 AI_MONTHLY_CAP_YUAN 或等下一自然月后自动恢复。`,
  );
}

/** 接近上限时的告警文案；未达告警线返回空字符串。 */
export function capWarningFor(summary: UsageSummary): string {
  if (summary.capYuan <= 0) return '';
  if (summary.exceeded) {
    return `本月 AI 成本 ${summary.costYuan} 元，已达上限 ${summary.capYuan} 元，后续调用会被拒绝。`;
  }
  if (!summary.warn) return '';
  const percent = Math.round((summary.costYuan / summary.capYuan) * 100);
  return `本月 AI 成本 ${summary.costYuan} 元，已达上限 ${summary.capYuan} 元的 ${percent}%，接近阈值后调用会被拒绝。`;
}

/** 一次云函数调用内串起多个子调用用的请求号（时间戳 + 随机后缀，够区分排查用）。 */
export function newRequestId(now: Date, random: () => number = Math.random): string {
  return `${now.toISOString()}-${Math.floor(random() * 0x1000000).toString(16).padStart(6, '0')}`;
}
