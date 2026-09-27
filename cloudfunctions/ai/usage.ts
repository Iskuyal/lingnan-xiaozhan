/**
 * 用量记账与月度成本上限。
 *
 * 落两处：
 * - `ai_usage_records`：每次子调用（模型调用、第三方内容安全检测）一条，记录耗时、
 *   token、金额与失败分类——「每次调用记录耗时与用量」的落点；
 * - `ai_usage_monthly`：每月一条汇总文档（`_id` 为东八区月份，如 `2026-09`），用原子自增累加；
 *   同集合还有 `accounting-gate:<月份>` 闸门文档，阻止记账失败后继续产生费用。
 *
 * 单价与上限都来自环境变量：默认值是 AI 资讯实测的 **DeepSeek 官方**单价（中转实际单价未实测）
 * 与规格定下的 50 元上限，换中转、换模型、调整上限都只改配置，不动代码。
 */
import { Config } from './config';
import { fail } from './errors';
import { CallUsage, SubCallRecord, TokenUsage, UsageSummary } from './types';

export const USAGE_RECORD_COLLECTION = 'ai_usage_records';
export const USAGE_MONTH_COLLECTION = 'ai_usage_monthly';

/** 单次调用记录的字段契约（测试据此锁定形状，避免字段悄悄改名）。 */
export const USAGE_RECORD_FIELDS: string[] = [
  'requestId', 'userKey', 'feature', 'action', 'kind', 'provider', 'model', 'ok', 'failureClass',
  'durationMs', 'promptTokens', 'completionTokens', 'totalTokens', 'estimated', 'usageUnknown',
  'costYuan', 'month', 'createdAt',
];

/** 月度汇总文档的字段契约。 */
export const USAGE_MONTH_FIELDS: string[] = [
  'month', 'calls', 'failures', 'promptTokens', 'completionTokens', 'totalTokens', 'costYuan', 'updatedAt',
];

/**
 * 记账所需的最小数据库接口（只用到 add / doc.get / doc.update 与原子自增）。
 *
 * 刻意**不声明 `doc.set`**：月度汇总只允许「原子自增」与「首次插入」两种写法，
 * 整体覆盖式写入会把当月累计冲掉（见 `recordSubCall` 的注释）。
 */
export interface UsageDb {
  command: { inc(value: number): unknown };
  collection(name: string): {
    add(options: { data: Record<string, unknown> }): Promise<unknown>;
    doc(id: string): {
      get(): Promise<{ data?: unknown }>;
      update(options: { data: Record<string, unknown> }): Promise<unknown>;
      remove(): Promise<unknown>;
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

/**
 * 合并同一次请求里的多次模型调用用量（分带识别的多个子调用，见 `vision.ts`）。
 *
 * 金额按各项相加而不是「先合 token 再乘单价」：各项的单价可能不同（命中不同模型或改过配置），
 * 相加才是这次请求真实产生的成本。`estimated` 与 `usageUnknown` 取**或**——
 * 任一项是估算或未知，合计就不能声称自己是精确值。
 */
export function sumCallUsage(list: CallUsage[], config: Config): CallUsage {
  const total: CallUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costYuan: 0,
    estimated: false,
    usageUnknown: false,
    priceInputPerMillion: config.priceInputPerMillion,
    priceOutputPerMillion: config.priceOutputPerMillion,
  };
  for (const item of list) {
    total.promptTokens += item.promptTokens;
    total.completionTokens += item.completionTokens;
    total.totalTokens += item.totalTokens;
    total.costYuan = round6(total.costYuan + item.costYuan);
    total.estimated = total.estimated || item.estimated;
    total.usageUnknown = total.usageUnknown || item.usageUnknown;
  }
  return total;
}

/**
 * 用量未知时的记账：接口不返回 token 用量（如 OpenAI `/moderations`），既拿不到精确值也无法估算。
 *
 * 两个都不能做：不能记 0 元（会被读成「这次免费」，上限随之失真），也不能编一个 token 数。
 * 做法是「按每次审核的**固定价**计金额 + 标记 `usageUnknown`」，固定价由
 * `AI_SAFETY_CALL_PRICE_YUAN` 配置（默认 0，此时金额为 0 但有标记，调用次数照记）。
 */
export function unknownUsage(fixedPriceYuan: number, config: Config): CallUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimated: true,
    usageUnknown: true,
    costYuan: round6(Math.max(0, fixedPriceYuan)),
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

/** 从各种异常形状里取错误文本（云数据库的错误信息在 errMsg / message 上）。 */
function errorMessageOf(error: unknown): string {
  if (error === null || error === undefined) return '';
  if (typeof error !== 'object') return String(error);
  const source = error as { errMsg?: unknown; message?: unknown };
  const message = source.errMsg ?? source.message;
  return typeof message === 'string' ? message : '';
}

/**
 * 判断异常是否是「文档不存在」。云数据库对缺失文档抛的错误里带这类字样；
 * 其余读取失败（网络、权限、集合不存在）一律视为数据库故障。
 */
export function isMissingDocumentError(error: unknown): boolean {
  return /not exist|does not exist|doesn't exist|DOCUMENT_NOT_EXIST|non-exists/iu.test(errorMessageOf(error));
}

/** 取 SDK 返回的 `updated` 计数；返回 null 表示这次返回里没有可识别的计数。 */
export function updatedCount(result: unknown): number | null {
  if (result === null || result === undefined || typeof result !== 'object') return null;
  const stats = (result as { stats?: unknown }).stats;
  if (stats !== null && stats !== undefined && typeof stats === 'object') {
    const value = (stats as { updated?: unknown }).updated;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  const direct = (result as { updated?: unknown }).updated;
  return typeof direct === 'number' && Number.isFinite(direct) ? direct : null;
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

/**
 * 月度汇总写入失败时，调用记录已经落库。下次收费调用必须先发现这笔漏记，
 * 否则只读汇总会继续放行，让成本上限失去约束。
 * 只检查“记录多于汇总”：历史记录清理后，汇总较大仍是保守的上限口径。
 */
export async function assertNoUnaccountedRecords(db: UsageDb, summary: UsageSummary): Promise<void> {
  const records = db.collection(USAGE_RECORD_COLLECTION) as unknown as {
    where(condition: { month: string }): { count(): Promise<{ total?: unknown }> };
  };
  const result = await records.where({ month: summary.month }).count();
  if (!Number.isSafeInteger(result.total) || (result.total as number) < 0) {
    fail('internal', '无法核对本月 AI 调用记录数，已暂停调用');
  }
  if ((result.total as number) > summary.calls) {
    fail('internal', '本月 AI 调用记录多于月度汇总，存在漏记；已暂停调用，请维护者核对并修复账目');
  }
}

/**
 * 一个月只允许一笔收费请求进入外部调用：先占住固定 _id，再发模型请求。
 * 若任何子调用记账失败，闸门保留，后续请求停下等待维护者核账；
 * 这也覆盖“明细记录 add 自身失败，汇总与明细都没有痕迹”的路径。
 */
function accountingGateId(month: string): string {
  return `accounting-gate:${month}`;
}

export async function acquireAccountingGate(db: UsageDb, month: string, requestId: string, now: Date): Promise<void> {
  try {
    await db.collection(USAGE_MONTH_COLLECTION).add({
      data: { _id: accountingGateId(month), requestId, createdAt: now.toISOString() },
    });
  } catch {
    fail('internal', 'AI 记账闸门正在使用或待核对，已暂停新调用；维护者须确认上笔用量后处理');
  }
}

export async function releaseAccountingGate(db: UsageDb, month: string): Promise<void> {
  await db.collection(USAGE_MONTH_COLLECTION).doc(accountingGateId(month)).remove();
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

/** 月度汇总的原子自增增量。 */
function monthDelta(db: UsageDb, record: SubCallRecord, createdAt: string): Record<string, unknown> {
  return {
    calls: db.command.inc(1),
    failures: db.command.inc(record.ok ? 0 : 1),
    promptTokens: db.command.inc(record.usage.promptTokens),
    completionTokens: db.command.inc(record.usage.completionTokens),
    totalTokens: db.command.inc(record.usage.totalTokens),
    costYuan: db.command.inc(record.usage.costYuan),
    updatedAt: createdAt,
  };
}

/**
 * 写一条调用记录并累加月度汇总。
 *
 * 汇总用原子自增（`command.inc`）：两次调用并发时也不会互相覆盖。
 *
 * **当月文档的初始化只在确认「文档不存在」时发生**，且插入带固定 `_id`：
 * - `update` 抛「文档不存在」，或 SDK 明确回 `updated: 0` → 才走首次插入；
 * - 其它 update 失败（网络、权限、集合不存在）**原样抛出**，由入口记为「可处理的记账失败」——
 *   绝不能因为一次失败的 update 就去 `set`，那会把当月累计覆盖成单次调用的数字，
 *   累计用量与上限判定随之失真（成本上限失效）。
 */
export async function recordSubCall(db: UsageDb, record: SubCallRecord, config: Config, now: Date): Promise<void> {
  const month = shanghaiMonth(now);
  const createdAt = now.toISOString();
  const data: Record<string, unknown> = {
    requestId: record.requestId,
    userKey: record.userKey,
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
    usageUnknown: record.usage.usageUnknown,
    costYuan: record.usage.costYuan,
    month,
    createdAt,
  };
  await db.collection(USAGE_RECORD_COLLECTION).add({ data });

  const delta = monthDelta(db, record, createdAt);
  const monthly = db.collection(USAGE_MONTH_COLLECTION);
  const doc = monthly.doc(month);
  let updated: number | null;
  try {
    updated = updatedCount(await doc.update({ data: delta }));
  } catch (error) {
    if (!isMissingDocumentError(error)) throw error;
    updated = 0;
  }
  if (updated !== null && updated > 0) return;
  if (updated === null) {
    // SDK 没回计数：读一次确认文档在不在，不在才初始化——绝不拿「读不到计数」当理由去覆盖。
    try {
      await doc.get();
      return;
    } catch (error) {
      if (!isMissingDocumentError(error)) throw error;
    }
  }
  await initializeMonth(monthly.add.bind(monthly), doc, month, record, createdAt, delta);
}

/**
 * 当月文档首次写入：用固定 `_id` 插入初值。
 * 并发下另一个调用可能刚好插入成功（`_id` 唯一），此时回到原子自增，避免各写一份丢计数。
 */
async function initializeMonth(
  add: (options: { data: Record<string, unknown> }) => Promise<unknown>,
  doc: {
    get(): Promise<{ data?: unknown }>;
    update(options: { data: Record<string, unknown> }): Promise<unknown>;
  },
  month: string,
  record: SubCallRecord,
  createdAt: string,
  delta: Record<string, unknown>,
): Promise<void> {
  const initial: Record<string, unknown> = {
    _id: month,
    month,
    calls: 1,
    failures: record.ok ? 0 : 1,
    promptTokens: record.usage.promptTokens,
    completionTokens: record.usage.completionTokens,
    totalTokens: record.usage.totalTokens,
    costYuan: record.usage.costYuan,
    updatedAt: createdAt,
  };
  try {
    await add({ data: initial });
    return;
  } catch (error) {
    // 只在「文档确实已存在」时退回自增；其它错误如实抛出（记账失败会被记进调用返回值）。
    let exists = false;
    try {
      await doc.get();
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) throw error;
  }
  await doc.update({ data: delta });
}

/**
 * 上限判定：已达月度上限直接拒绝调用（`quota_exhausted`），
 * 接近阈值只告警，不拦（是否需要提前拦由负责人按 `AI_CAP_WARN_RATIO` 决定）。
 */
export function assertWithinCap(summary: UsageSummary): void {
  if (!summary.exceeded) return;
  fail(
    'quota_exhausted',
    '本月 AI 总成本已达上限；维护者可通过专用用量接口核对。',
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
