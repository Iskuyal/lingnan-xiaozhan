/**
 * 官网资讯同步云函数（P3-2 / Ticket 04）。
 *
 * 职责：按栏目抓取官网列表 → 逐篇抓正文 → 用 parse.ts 解析 → 按原文 URL upsert 进
 * `news_articles` → 把进度与结果写进 `sync_state`（每个栏目一条文档）。写入只发生在这里，
 * 客户端对 `news_articles` 只有读权限（安全规则 {"read": true, "write": false}）。
 *
 * 抓取约束（依据 docs/news-sources.md 与 docs/tasks/p3-2-news-updates.md）：
 * - 官网 WAF 明写「每秒不能多于 1 个页面请求」，超限返回 403 并冻结 IP；本函数串行请求、
 *   相邻请求间隔 1.3 秒，单次调用最多 10 次页面请求（≈13 秒，云函数超时 20 秒）。
 * - 首次全量导入按页续跑：状态文档保存「下一个要读的列表页」与「待抓正文的条目队列」，
 *   每完成一次请求就落盘，被中断最多丢最后一次请求的进度，不会留下不一致状态。
 * - 遇到限速 403 立刻停止本轮并记录，**不重试**；随后 30 分钟内不再发起任何请求。
 * - 正文不在官网的条目（如微信公众号链接）只保留标题、日期与原文链接，不抓外链正文。
 *
 * 定时触发器写在同目录的 config.json（每日 06:00，触发器时区 UTC+8）；函数调用权限
 * `newsSync: {"invoke": false}` 只拦客户端调用，管理端与定时触发器不受影响。
 */
import * as https from 'https';
import * as cloud from 'wx-server-sdk';
import { newsIdFromUrl, parseArticle, parseList } from './parse';
import { NewsArticleRecord, toArticleRecord } from './record';
import {
  COLUMNS,
  INCREMENTAL_PAGES,
  listPageUrl,
  MAX_REQUESTS_PER_CALL,
  RATE_LIMIT_COOLDOWN_MS,
  REQUEST_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  RUN_LOCK_MS,
  WORK_DEADLINE_MS,
} from './columns';
import { NewsColumn, NewsListItem } from './types';

// wx-server-sdk 4.0.2 的 d.ts 把 DYNAMIC_CURRENT_ENV 声明为 symbol，而 init 的 env 参数
// 类型未包含 symbol —— 属于类型声明滞后，运行时是官方推荐用法。若 SDK 后续修正类型，可去掉断言。
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV as unknown as string });

const db = cloud.database();
const NEWS_COLLECTION = 'news_articles';
const STATE_COLLECTION = 'sync_state';
/** 状态与日志里的时间语义：定时触发器与官网都在东八区。 */
const TIME_ZONE = 'Asia/Shanghai（UTC+8）';
/** 一个栏目一次最多保留的失败摘要条数，避免状态文档无限增长。 */
const MAX_FAILURE_NOTES = 10;
/**
 * 一轮里最多记录多少个「已重试过」的条目 URL。
 * 全量一轮覆盖 1400 多条，正常情况不会有条目失败；上限只防状态文档被异常情况撑大。
 */
const MAX_ROUND_RETRIES = 100;
/**
 * 请求头：官网对缺少浏览器特征的请求返回 403（实测云函数环境如此，本机 curl 正常）。
 * 这里用常见浏览器请求头读取公开页面，不携带 Cookie，也不涉及任何身份伪装。
 */
const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

/** 官网限速（WAF）返回的 403：必须停止本轮并记录，不能当普通单篇失败继续抓。 */
class RateLimitedError extends Error {}

/**
 * 官网页面跳转到域外（例如微信公众号）：正文不在官网，不抓外链内容。
 * 与「条目 URL 本身就在域外」同样处理：只保留标题、日期与原文链接。
 */
class OffsiteBodyError extends Error {}

type Phase = 'backfill' | 'incremental';
type Mode = Phase | 'auto';

interface RoundState {
  /** 是否有一轮同步正在进行（跨调用累计计数）。 */
  active: boolean;
  phase: Phase;
  /** 增量轮当前读到第几页；全量导入用 backfillPage，两者互不影响。 */
  page: number;
  pages: number[];
  requests: number;
  inserted: number;
  updated: number;
  skipped: number;
  offsite: number;
  failed: number;
  failures: string[];
  /** 本轮已重试用过的条目 URL：同一轮内每篇至多重试一次，避免坏页面把整轮拖住。 */
  retried: string[];
}

interface ColumnState {
  column: string;
  /** 全量导入是否已完成。 */
  backfillDone: boolean;
  /** 全量导入的下一个列表页（1-based）。 */
  backfillPage: number;
  /** 已读列表页里还没有抓正文的条目。 */
  pending: NewsListItem[];
  /** pending 属于哪一轮，仅用于统计口径。 */
  pendingKind: Phase;
  round: RoundState;
  /** 上一次调用可能仍在运行的时间点（重复触发保护，见 RUN_LOCK_MS）。 */
  lockUntil: string;
  lastAttemptAt: string;
  lastSuccessAt: string;
  lastOutcome: string;
  lastError: string;
  lastRequestAt: string;
  lastRunAtLocal: string;
  /** 最近一次调用来自定时触发器还是维护者手动触发；定时触发额外记录触发器名。 */
  lastTrigger: string;
  lastTriggerName: string;
  rateLimitedAt: string;
  elapsedMs: number;
}

interface ExistingArticle {
  _id: string;
  title?: unknown;
  date?: unknown;
  paragraphs?: unknown;
}

interface ColumnRun {
  column: string;
  label: string;
  phase: Phase;
  pagesRead: number[];
  requests: number;
  inserted: number;
  updated: number;
  skipped: number;
  offsite: number;
  failed: number;
  backfillDone: boolean;
  roundComplete: boolean;
  rateLimited: boolean;
  skippedReason: string;
  failures: string[];
  lastSuccessAt: string;
  message: string;
}

/**
 * 取官网页面 HTML。只接受 200；最多跟随 3 次跳转；403/429 视为限速并抛 RateLimitedError。
 * 跳转目标若离开官网（如 mp.weixin.qq.com）则抛 OffsiteBodyError，不把外链内容抓回入库。
 */
function fetchHtml(url: string, redirects = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: REQUEST_TIMEOUT_MS, headers: REQUEST_HEADERS }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location && redirects < 3) {
        response.resume();
        const target = new URL(location, url).toString();
        if (isOffsiteUrl(target)) {
          reject(new OffsiteBodyError(`页面跳转到官网之外（${target}），正文不入库`));
          return;
        }
        resolve(fetchHtml(target, redirects + 1));
        return;
      }
      if (status !== 200) {
        // 带上响应片段：403 之类的拒绝需要看到服务端返回了什么才能判断原因。
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const snippet = Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').slice(0, 200);
          const detail = `HTTP ${status}：${url}｜响应片段：${snippet}`;
          // 官网 WAF 的限速 403 与「缺少浏览器特征」的 403 都会走到这里；
          // 两种情况都不该继续抓（继续重试只会延长冻结），一律停止本轮。
          reject(status === 403 || status === 429 ? new RateLimitedError(`疑似官网限速：${detail}`) : new Error(detail));
        });
        return;
      }
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    request.on('timeout', () => request.destroy(new Error(`请求超时：${url}`)));
    request.on('error', reject);
  });
}

/**
 * 请求闸门：串行、限速、限额。
 *
 * - 与上一次请求保持 REQUEST_INTERVAL_MS 的间隔；上一次请求发生在别的调用里也能接着排
 *   （构造时传入落盘的 lastRequestAt），避免连续手动触发时把两次调用连成高频请求。
 * - 配额与截止时间同时约束：任一超出就不再发起新请求，剩余进度留给下一次调用。
 * `intervalMs` 只为测试注入更短的间隔，生产调用不传。
 */
class RequestGate {
  used = 0;
  private lastAt: number;
  private readonly quota: number;
  private readonly deadline: number;
  private readonly intervalMs: number;

  constructor(quota: number, deadline: number, lastRequestAt: string, intervalMs: number = REQUEST_INTERVAL_MS) {
    this.quota = quota;
    this.deadline = deadline;
    this.intervalMs = intervalMs;
    const parsed = Date.parse(lastRequestAt === '' ? '' : lastRequestAt);
    this.lastAt = Number.isNaN(parsed) ? 0 : parsed;
  }

  /** 上一次请求开始的时间（ISO）；从未发起过请求时为空字符串。 */
  get lastRequestAt(): string {
    return this.lastAt === 0 ? '' : new Date(this.lastAt).toISOString();
  }

  /** 还能不能再发起请求：配额未用完，且没到本次调用的截止时间。 */
  canRequest(): boolean {
    return this.used < this.quota && Date.now() < this.deadline;
  }

  /** 等到与上一次请求的间隔满足后再发起请求。 */
  async waitTurn(): Promise<void> {
    const wait = this.lastAt + this.intervalMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  markRequest(): void {
    this.used += 1;
    this.lastAt = Date.now();
  }
}

/** 经闸门发起一次页面请求（列表页与文章页都算一次）。 */
async function fetchWithGate(gate: RequestGate, url: string): Promise<string> {
  await gate.waitTurn();
  gate.markRequest();
  return fetchHtml(url);
}

function describeError(error: unknown): string {
  if (error !== null && error !== undefined && typeof error === 'object') {
    const candidate = error as { message?: unknown; errMsg?: unknown };
    if (typeof candidate.message === 'string' && candidate.message !== '') return candidate.message;
    if (typeof candidate.errMsg === 'string' && candidate.errMsg !== '') return candidate.errMsg;
  }
  return error === null || error === undefined ? '未知错误' : String(error);
}

/** 东八区可读时间，如 2026-09-18 06:00:12 +08:00；用于记录定时任务的实际运行时间。 */
export function shanghaiStamp(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 3600 * 1000);
  return `${shifted.toISOString().slice(0, 19).replace('T', ' ')} +08:00`;
}

/** 东八区日期（YYYY-MM-DD）。定时任务在 06:00（UTC 前一天 22:00）运行，不能用 UTC 日期。 */
export function shanghaiDate(date: Date): string {
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 取较晚的一个 ISO 时间字符串（忽略空值）。 */
function laterIso(a: string, b: string): string {
  if (a === '') return b;
  if (b === '') return a;
  return a >= b ? a : b;
}

/**
 * 判断这次调用是不是定时触发器发来的，并取出触发器名。
 *
 * 依据：官方文档给的判据是 `getWXContext().SOURCE === 'wx_trigger'`，定时事件本身还带
 * `Type: 'Timer'`、`TriggerName`、`Time`（早期文档中的写法）。两者都认：事件字段够用时
 * 不调用 getWXContext（本地测试与旧版 SDK 没有该方法）。判断只影响日志与状态里的记录，
 * 不影响是否执行同步——定时与手动都走同一条路径。
 */
function detectTrigger(event: { Type?: unknown; TriggerName?: unknown }): { kind: 'timer' | 'manual'; name: string } {
  const name = typeof event.TriggerName === 'string' ? event.TriggerName : '';
  if (event.Type === 'Timer' || event.Type === 'timer') return { kind: 'timer', name };
  try {
    const context = cloud.getWXContext() as { SOURCE?: unknown } | undefined;
    if (context !== undefined && context !== null && context.SOURCE === 'wx_trigger') return { kind: 'timer', name };
  } catch {
    // 不在云函数环境（本地测试）时 getWXContext 不可用：按事件字段判断即可。
  }
  return { kind: 'manual', name };
}

/** 正文是否不在官网：外链条目（如 mp.weixin.qq.com）只存标题、日期与原文链接。 */
export function isOffsiteUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !(host === 'lnc.edu.cn' || host.endsWith('.lnc.edu.cn'));
  } catch {
    return true;
  }
}

function emptyRound(): RoundState {
  return { active: false, phase: 'backfill', page: 1, pages: [], requests: 0, inserted: 0, updated: 0, skipped: 0, offsite: 0, failed: 0, failures: [], retried: [] };
}

function emptyState(column: NewsColumn): ColumnState {
  return {
    column: column.id,
    backfillDone: false,
    backfillPage: 1,
    pending: [],
    pendingKind: 'backfill',
    round: emptyRound(),
    lockUntil: '',
    lastAttemptAt: '',
    lastSuccessAt: '',
    lastOutcome: '',
    lastError: '',
    lastRequestAt: '',
    lastRunAtLocal: '',
    lastTrigger: '',
    lastTriggerName: '',
    rateLimitedAt: '',
    elapsedMs: 0,
  };
}

/**
 * 把读到的文档收敛成合法状态：字段缺失或类型不对时退回默认值，不因脏数据中断同步。
 * 待抓队列在这里逐条校验：缺 URL 的条目无法按原文 URL 去重，直接丢弃比让它把整次同步
 * 卡在同一个坏条目上更安全（队列是「已读列表页、还没抓正文」的进度，丢了重读该页即可）。
 */
function normalizePending(raw: unknown): NewsListItem[] {
  if (!Array.isArray(raw)) return [];
  const items: NewsListItem[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const item = entry as Partial<NewsListItem>;
    if (typeof item.url !== 'string' || item.url === '') continue;
    items.push({
      id: typeof item.id === 'string' ? item.id : newsIdFromUrl(item.url),
      title: typeof item.title === 'string' ? item.title : '',
      url: item.url,
      date: typeof item.date === 'string' ? item.date : '',
    });
  }
  return items;
}

function normalizeState(column: NewsColumn, raw: unknown): ColumnState {
  const state = emptyState(column);
  if (raw === null || raw === undefined || typeof raw !== 'object') return state;
  const source = raw as Partial<ColumnState>;
  if (source.backfillDone === true) state.backfillDone = true;
  if (typeof source.backfillPage === 'number' && Number.isFinite(source.backfillPage) && source.backfillPage >= 1) {
    state.backfillPage = Math.floor(source.backfillPage);
  }
  state.pending = normalizePending(source.pending);
  state.pendingKind = source.pendingKind === 'incremental' ? 'incremental' : 'backfill';
  if (source.round !== null && typeof source.round === 'object') {
    const round = source.round as Partial<RoundState>;
    state.round = {
      active: round.active === true,
      phase: round.phase === 'incremental' ? 'incremental' : 'backfill',
      page: typeof round.page === 'number' && round.page >= 1 ? Math.floor(round.page) : 1,
      pages: Array.isArray(round.pages) ? round.pages.filter((page) => typeof page === 'number') : [],
      requests: Number(round.requests) || 0,
      inserted: Number(round.inserted) || 0,
      updated: Number(round.updated) || 0,
      skipped: Number(round.skipped) || 0,
      offsite: Number(round.offsite) || 0,
      failed: Number(round.failed) || 0,
      failures: Array.isArray(round.failures) ? round.failures.filter((note) => typeof note === 'string') : [],
      retried: Array.isArray(round.retried) ? round.retried.filter((url) => typeof url === 'string') : [],
    };
  }
  for (const key of ['lockUntil', 'lastAttemptAt', 'lastSuccessAt', 'lastOutcome', 'lastError', 'lastRequestAt', 'lastRunAtLocal', 'lastTrigger', 'lastTriggerName', 'rateLimitedAt'] as const) {
    if (typeof source[key] === 'string') state[key] = source[key] as string;
  }
  if (typeof source.elapsedMs === 'number' && Number.isFinite(source.elapsedMs)) state.elapsedMs = source.elapsedMs;
  return state;
}

/** 落盘字段：显式列出，避免把 _id 之类的文档字段写回，也便于测试锁定字段集合。 */
function stateFields(state: ColumnState): Record<string, unknown> {
  return {
    column: state.column,
    backfillDone: state.backfillDone,
    backfillPage: state.backfillPage,
    pending: state.pending,
    pendingKind: state.pendingKind,
    round: state.round,
    lockUntil: state.lockUntil,
    lastAttemptAt: state.lastAttemptAt,
    lastSuccessAt: state.lastSuccessAt,
    lastOutcome: state.lastOutcome,
    lastError: state.lastError,
    lastRequestAt: state.lastRequestAt,
    lastRunAtLocal: state.lastRunAtLocal,
    lastTrigger: state.lastTrigger,
    lastTriggerName: state.lastTriggerName,
    rateLimitedAt: state.rateLimitedAt,
    elapsedMs: state.elapsedMs,
  };
}

/** 状态文档字段集合（与 stateFields 一致），测试据此锁定同步状态的形状。 */
export const SYNC_STATE_FIELDS: string[] = [
  'column', 'backfillDone', 'backfillPage', 'pending', 'pendingKind', 'round', 'lockUntil',
  'lastAttemptAt', 'lastSuccessAt', 'lastOutcome', 'lastError', 'lastRequestAt', 'lastRunAtLocal',
  'lastTrigger', 'lastTriggerName', 'rateLimitedAt', 'elapsedMs',
];

async function readState(column: NewsColumn): Promise<ColumnState> {
  try {
    const result = (await db.collection(STATE_COLLECTION).doc(column.id).get()) as { data?: unknown };
    return normalizeState(column, result === null || result === undefined ? null : result.data);
  } catch {
    // 文档不存在（首次运行）与读取失败都按空状态处理：同步本身按 URL 幂等，
    // 重跑一次全量导入的代价是可接受的，不能因为读不到状态就中断整次调用。
    return emptyState(column);
  }
}

/**
 * 落盘同步状态。整份覆盖（set）而不是合并（update）：
 * 旧版本的字段（inserted/updated/failed 等）不会残留在文档里误导排查。
 */
async function saveState(state: ColumnState): Promise<void> {
  await db.collection(STATE_COLLECTION).doc(state.column).set({ data: stateFields(state) });
}

/**
 * 取查询结果的数据数组。
 *
 * wx-server-sdk 4.0.2 把 get() 声明为 `Promise<IQueryResult> | void | string`（历史遗留的
 * 联合类型），运行时始终返回查询结果。这里集中收窄一次，避免在每个调用点断言。
 */
async function queryData<T>(query: { get(): unknown }): Promise<T[]> {
  const result = (await query.get()) as { data: T[] };
  return result.data;
}

/** 按原文 URL 找已有记录；只取判断所需的字段。 */
async function findArticleByUrl(url: string): Promise<ExistingArticle | null> {
  const rows = await queryData<ExistingArticle>(
    db.collection(NEWS_COLLECTION).where({ url }).field({ title: true, date: true, paragraphs: true }).limit(1),
  );
  return rows.length > 0 ? rows[0] : null;
}

/** 已有记录与列表页元信息一致且正文非空时，增量回看可以跳过正文抓取（省一次请求）。 */
function isUnchanged(existing: ExistingArticle, item: NewsListItem): boolean {
  const paragraphs = Array.isArray(existing.paragraphs) ? existing.paragraphs : [];
  return paragraphs.length > 0
    && typeof existing.title === 'string' && existing.title === item.title
    && typeof existing.date === 'string' && existing.date === item.date;
}

async function insertArticle(record: NewsArticleRecord): Promise<void> {
  await db.collection(NEWS_COLLECTION).add({ data: record });
}

async function updateArticle(id: string, data: Record<string, unknown>): Promise<void> {
  await db.collection(NEWS_COLLECTION).doc(id).update({ data });
}

/** 外链条目：只保留标题、日期与原文链接，不抓正文；已有正文时保持不动。 */
async function saveOffsiteItem(
  column: NewsColumn,
  item: NewsListItem,
  existing: ExistingArticle | null,
  capturedAt: string,
  nowIso: string,
): Promise<'inserted' | 'updated'> {
  const base = {
    id: item.id,
    url: item.url,
    title: item.title,
    date: item.date,
    sourceLabel: column.label,
    capturedAt,
    updatedAt: nowIso,
  };
  if (existing === null) {
    await insertArticle({ ...base, paragraphs: [] });
    return 'inserted';
  }
  await updateArticle(existing._id, base);
  return 'updated';
}

function pushFailure(round: RoundState, note: string): void {
  round.failed += 1;
  if (round.failures.length < MAX_FAILURE_NOTES) round.failures.push(note);
}

function summarizeFailures(failures: string[]): string {
  return failures.join(' | ');
}

function resolveMode(event: { mode?: unknown }): Mode {
  const mode = typeof event.mode === 'string' ? event.mode : '';
  if (mode === 'backfill' || mode === 'incremental') return mode;
  return 'auto';
}

/**
 * 维护者要求重跑全量：把全量游标清回第 1 页并丢掉当前队列。
 * 用于「失败留下的空洞」或「解析规则修好之后重跑」——写入仍按原文 URL 幂等更新，不会产生重复条目。
 * 只在显式传 `{"reset": true}` 时生效，定时触发不会走到这里。
 */
function resetBackfill(state: ColumnState): void {
  state.backfillDone = false;
  state.backfillPage = 1;
  state.pending = [];
  state.pendingKind = 'backfill';
  state.round = emptyRound();
}

/** 本次调用允许发起的请求数：默认 10，可由维护者在控制台传参调小，上限固定为 10。 */
function resolveBudget(event: { maxRequests?: unknown; limit?: unknown }): number {
  // `limit` 是旧版参数名，含义已从「文章数」改为「页面请求数」，保留以兼容既有排查习惯。
  const requested = Number(event.maxRequests === undefined ? event.limit : event.maxRequests);
  if (!Number.isFinite(requested) || requested <= 0) return MAX_REQUESTS_PER_CALL;
  return Math.min(Math.floor(requested), MAX_REQUESTS_PER_CALL);
}

/** 两个栏目平分一次调用的请求配额（10 → 5 + 5），让两个栏目都能推进。 */
function allocateBudget(total: number, count: number): number[] {
  const base = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

function selectColumns(column: unknown): NewsColumn[] {
  if (typeof column !== 'string' || column === '') return COLUMNS;
  const found = COLUMNS.filter((item) => item.id === column);
  if (found.length === 0) {
    throw new Error(`未知栏目「${column}」，可用栏目：${COLUMNS.map((item) => item.id).join('、')}`);
  }
  return found;
}

/** 决定接下来跑哪个阶段：全量导入没完成时不自动进增量（可用 mode 强制）。 */
function desiredPhase(mode: Mode, state: ColumnState): Phase {
  if (mode === 'incremental') return 'incremental';
  if (mode === 'backfill') return 'backfill';
  return state.backfillDone ? 'incremental' : 'backfill';
}

function beginRound(state: ColumnState, phase: Phase): void {
  state.round = emptyRound();
  state.round.active = true;
  state.round.phase = phase;
  state.round.page = 1;
  state.pending = [];
  state.pendingKind = phase;
}

/**
 * 结束当前轮：只有整轮没有任何失败（含外链条目）才算「整批成功」，
 * 失败与部分成功都不推进 lastSuccessAt。空跑的一轮（例如全量导入已完成又要求重跑）
 * 不改写成功时间与结果，避免用「什么都没做」冒充一次成功同步。
 */
function finishRound(state: ColumnState, complete: boolean, nowIso: string): void {
  const round = state.round;
  if (complete) {
    if (round.phase === 'backfill') state.backfillDone = true;
    const succeeded = round.inserted + round.updated + round.skipped + round.offsite;
    round.active = false;
    if (succeeded + round.failed === 0) return;
    state.lastOutcome = round.failed === 0 ? 'ok' : succeeded > 0 ? 'partial' : 'failed';
    if (round.failed === 0) {
      state.lastSuccessAt = nowIso;
      state.lastError = '';
    } else {
      state.lastError = summarizeFailures(round.failures);
    }
  } else {
    // 阶段被切换或调用被中断：本轮还没跑完，不能声称成功，进度保留在游标里。
    round.active = false;
    if (state.lastOutcome !== 'rate-limited') state.lastOutcome = 'running';
  }
}

function emptyRun(column: NewsColumn, state: ColumnState): ColumnRun {
  return {
    column: column.id,
    label: column.label,
    phase: state.round.phase,
    pagesRead: [],
    requests: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    offsite: 0,
    failed: 0,
    backfillDone: state.backfillDone,
    roundComplete: false,
    rateLimited: false,
    skippedReason: '',
    failures: [],
    lastSuccessAt: state.lastSuccessAt,
    message: '',
  };
}

/** 把本轮累计计数同步到本次调用的返回值（计数跨调用累计在状态文档里）。 */
function syncRunCounters(run: ColumnRun, state: ColumnState): void {
  run.phase = state.round.phase;
  run.pagesRead = state.round.pages.slice();
  run.backfillDone = state.backfillDone;
  run.inserted = state.round.inserted;
  run.updated = state.round.updated;
  run.skipped = state.round.skipped;
  run.offsite = state.round.offsite;
  run.failed = state.round.failed;
  run.failures = state.round.failures.slice();
  run.lastSuccessAt = state.lastSuccessAt;
}

interface SyncContext {
  capturedAt: string;
  nowIso: string;
}

/** 处理队列头部的条目：抓正文、校验、入库；失败抛错由调用方计入本轮失败。 */
async function processPendingItem(
  column: NewsColumn,
  item: NewsListItem,
  env: { state: ColumnState; gate: RequestGate; context: SyncContext },
): Promise<'inserted' | 'updated' | 'skipped' | 'offsite'> {
  const { state, gate, context } = env;
  const existing = await findArticleByUrl(item.url);
  if (isOffsiteUrl(item.url)) {
    // 正文不在官网（如微信公众号链接）：只保留标题、日期与原文链接，不抓外链正文。
    await saveOffsiteItem(column, item, existing, context.capturedAt, context.nowIso);
    return 'offsite';
  }
  // 增量回看：列表元信息没变且已有正文时跳过抓取，避免每天重复抓同一批文章。
  // 代价是「官网只改正文、标题与日期都不变」的修改不会被发现，见 docs/cloud-development.md。
  if (state.round.phase === 'incremental' && existing !== null && isUnchanged(existing, item)) {
    return 'skipped';
  }
  let html: string;
  try {
    html = await fetchWithGate(gate, item.url);
  } catch (error) {
    // 官网页面跳转到域外（如微信公众号）：只保留标题、日期与原文链接，不抓外链正文。
    if (error instanceof OffsiteBodyError) {
      await saveOffsiteItem(column, item, existing, context.capturedAt, context.nowIso);
      return 'offsite';
    }
    throw error;
  }
  const article = parseArticle(html, item.url, column.template);
  // HTTP 200 也可能是维护页或已改版页面，不能用解析空值覆盖最后成功内容。
  // 日期缺失仍允许入库；纯图片正文暂不支持，留待人工核查原文。
  if (article.title.trim() === '' || article.paragraphs.length === 0) {
    throw new Error('文章标题或正文未解析到，保留已有内容');
  }
  const record = toArticleRecord(article, column.label, context.capturedAt, context.nowIso);
  if (existing === null) {
    await insertArticle(record);
    return 'inserted';
  }
  await updateArticle(existing._id, record as unknown as Record<string, unknown>);
  return 'updated';
}

/**
 * 跑一个栏目：在配额与截止时间内反复「读列表页 → 抓正文队列」，每步落盘。
 * 返回值里的计数是本轮的累计值（跨多次调用）。
 */
async function syncColumn(options: {
  column: NewsColumn;
  state: ColumnState;
  quota: number;
  deadline: number;
  pacingFrom: string;
  mode: Mode;
  context: SyncContext;
}): Promise<{ run: ColumnRun; gate: RequestGate }> {
  const { column, state, quota, deadline, pacingFrom, mode, context } = options;
  const gate = new RequestGate(quota, deadline, laterIso(pacingFrom, state.lastRequestAt));
  const run = emptyRun(column, state);

  try {
    while (gate.canRequest()) {
      // 1. 队列里还有条目：先抓正文，再考虑阶段切换（不能丢已读列表页的条目）。
      if (state.pending.length > 0) {
        const item = state.pending[0];
        let retry = false;
        try {
          const outcome = await processPendingItem(column, item, { state, gate, context });
          if (outcome === 'inserted') state.round.inserted += 1;
          else if (outcome === 'updated') state.round.updated += 1;
          else if (outcome === 'skipped') state.round.skipped += 1;
          else state.round.offsite += 1;
        } catch (error) {
          // 限速 403：条目留在队列里，停止本轮，下一次调用从原处续跑（不重试）。
          if (error instanceof RateLimitedError) throw error;
          pushFailure(state.round, `${item.url}：${describeError(error)}`);
          // 同一轮内给每篇一次重试机会（放回队尾）：首次全量有 1500 多次请求，偶发 HTTP 抖动
          // 不该在库里留下永久空洞。重试仍会失败的话，下一次走到它时不再重试。
          retry = !state.round.retried.includes(item.url) && state.round.retried.length < MAX_ROUND_RETRIES;
          if (retry) state.round.retried.push(item.url);
        }
        state.pending = state.pending.slice(1);
        if (retry) state.pending.push(item);
        state.round.requests = gate.used;
        state.lastRequestAt = gate.lastRequestAt;
        await saveState(state);
        continue;
      }

      // 2. 阶段切换：全量导入完成后转增量回看，或维护者用 mode 指定。
      const want = desiredPhase(mode, state);
      if (state.round.active && state.round.phase !== want) finishRound(state, false, context.nowIso);
      if (!state.round.active) beginRound(state, want);

      // 3. 读下一个列表页；本轮页范围读完则收尾。
      const isBackfill = state.round.phase === 'backfill';
      const lastPage = isBackfill ? column.totalPages : INCREMENTAL_PAGES;
      const nextPage = isBackfill ? state.backfillPage : state.round.page;
      if (nextPage > lastPage) {
        finishRound(state, true, context.nowIso);
        await saveState(state);
        run.roundComplete = true;
        run.message = isBackfill
          ? `全量导入完成：共 ${lastPage} 页，插入 ${state.round.inserted}、更新 ${state.round.updated}、跳过 ${state.round.skipped}、外链 ${state.round.offsite}、失败 ${state.round.failed}`
          : `增量同步完成：回看最近 ${lastPage} 页，更新 ${state.round.updated}、跳过 ${state.round.skipped}、外链 ${state.round.offsite}、失败 ${state.round.failed}`;
        break;
      }

      const pageUrl = listPageUrl(column, nextPage);
      const html = await fetchWithGate(gate, pageUrl);
      const items = parseList(html, column.listUrl, column.template);
      if (items.length === 0) {
        throw new Error(`列表页没有解析到任何条目（${pageUrl}），官网结构可能已变化`);
      }
      state.pending = items;
      state.pendingKind = state.round.phase;
      if (isBackfill) state.backfillPage = nextPage + 1;
      else state.round.page = nextPage + 1;
      if (!state.round.pages.includes(nextPage)) state.round.pages.push(nextPage);
      state.round.requests = gate.used;
      state.lastRequestAt = gate.lastRequestAt;
      await saveState(state);
    }
  } catch (error) {
    const note = describeError(error);
    if (error instanceof RateLimitedError) {
      run.rateLimited = true;
      state.rateLimitedAt = context.nowIso;
      state.lastOutcome = 'rate-limited';
      state.lastError = note;
      run.message = '官网返回限速 403，已停止本轮并记录；冷却期内不再发起请求，下一次调用可续跑。';
    } else {
      // 第 3 步（列表页）或状态读写失败：本轮中断但游标保留，重跑即续。
      state.lastOutcome = 'running';
      pushFailure(state.round, note);
      state.lastError = summarizeFailures(state.round.failures);
      run.message = `本轮中断：${note}`;
    }
    state.lastRequestAt = gate.lastRequestAt;
  }

  syncRunCounters(run, state);
  run.requests = gate.used;
  // 配额用完但本轮还没跑完：结果记为「进行中」，进度已落在状态文档里。
  if (state.round.active && state.lastOutcome !== 'rate-limited') state.lastOutcome = 'running';
  if (run.message === '' && !run.roundComplete) {
    run.message = state.lastOutcome === 'rate-limited'
      ? '本轮因官网限速停止，可稍后续跑。'
      : '本次调用已用完请求配额或到时间上限，进度已保存，继续调用即可续跑。';
  }
  state.elapsedMs = Math.max(0, Date.now() - Date.parse(context.nowIso));
  return { run, gate };
}

/** 被冷却或重复触发保护跳过的栏目：不改动同步进度，只说明原因，计数清零以免误读。 */
function skippedRun(column: NewsColumn, state: ColumnState, reason: string): ColumnRun {
  const run = emptyRun(column, state);
  run.phase = state.round.phase;
  run.backfillDone = state.backfillDone;
  run.lastSuccessAt = state.lastSuccessAt;
  run.skippedReason = reason;
  run.message = reason;
  return run;
}

export async function main(event: { mode?: unknown; column?: unknown; maxRequests?: unknown; limit?: unknown; reset?: unknown; Type?: unknown; TriggerName?: unknown } = {}) {
  const startedAt = Date.now();
  const nowIso = new Date(startedAt).toISOString();
  const runAtLocal = shanghaiStamp(new Date(startedAt));
  const context: SyncContext = { capturedAt: shanghaiDate(new Date(startedAt)), nowIso };
  const { kind: trigger, name: triggerName } = detectTrigger(event);
  const runs: ColumnRun[] = [];

  try {
    const mode = resolveMode(event);
    const columns = selectColumns(event.column);
    const budget = resolveBudget(event);
    const quotas = allocateBudget(budget, columns.length);
    const deadline = startedAt + WORK_DEADLINE_MS;
    let pacingFrom = '';

    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index];
      const state = await readState(column);
      state.lastAttemptAt = nowIso;
      state.lastRunAtLocal = runAtLocal;
      state.lastTrigger = trigger;
      state.lastTriggerName = triggerName;

      // 冷却：最近触发过限速 403 时，本次调用不再发起任何请求（继续重试会延长官网冻结）。
      const cooldownUntil = state.rateLimitedAt === '' ? Number.NaN : Date.parse(state.rateLimitedAt) + RATE_LIMIT_COOLDOWN_MS;
      if (!Number.isNaN(cooldownUntil) && startedAt < cooldownUntil) {
        const minutes = Math.ceil((cooldownUntil - startedAt) / 60000);
        runs.push(skippedRun(column, state, `限速冷却中：${state.rateLimitedAt} 触发了官网限速 403，约 ${minutes} 分钟后可再试。本次未发起任何请求。`));
        continue;
      }

      // 重复触发保护：上一次调用可能仍在运行（例如定时消息重复推送），此时跳过，
      // 避免两次调用并发请求把间隔压到 1 秒以内。
      const lockUntil = state.lockUntil === '' ? Number.NaN : Date.parse(state.lockUntil);
      if (!Number.isNaN(lockUntil) && startedAt < lockUntil) {
        runs.push(skippedRun(column, state, `上一次调用可能仍在运行（${state.lockUntil} 前加锁），本次跳过以避免并发请求。`));
        continue;
      }
      state.lockUntil = new Date(startedAt + RUN_LOCK_MS).toISOString();
      if (event.reset === true) resetBackfill(state);
      await saveState(state);

      const result = await syncColumn({
        column, state, quota: quotas[index], deadline, pacingFrom, mode, context,
      });
      pacingFrom = laterIso(pacingFrom, result.gate.lastRequestAt);

      // 调用结束，释放锁（重新加锁是下一次调用的事）。
      state.lockUntil = '';
      state.lastRequestAt = laterIso(state.lastRequestAt, result.gate.lastRequestAt);
      await saveState(state);
      runs.push(result.run);
    }
  } catch (error) {
    const message = describeError(error);
    return {
      ok: false,
      trigger,
      triggerName,
      runAt: runAtLocal,
      timeZone: TIME_ZONE,
      error: message,
      columns: runs,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const totals = runs.reduce(
    (sum, run) => ({
      inserted: sum.inserted + run.inserted,
      updated: sum.updated + run.updated,
      skipped: sum.skipped + run.skipped,
      offsite: sum.offsite + run.offsite,
      failed: sum.failed + run.failed,
    }),
    { inserted: 0, updated: 0, skipped: 0, offsite: 0, failed: 0 },
  );
  const backfillDone = runs.every((run) => run.backfillDone);
  const rateLimited = runs.some((run) => run.rateLimited);
  const requestsUsed = runs.reduce((sum, run) => sum + run.requests, 0);

  return {
    ok: !rateLimited && totals.failed === 0,
    trigger,
    triggerName,
    runAt: runAtLocal,
    timeZone: TIME_ZONE,
    capturedAt: context.capturedAt,
    elapsedMs: Date.now() - startedAt,
    requestsUsed,
    columns: runs,
    totals,
    backfillDone,
    // `ok` 只说明「本次调用没有失败」，不代表整批导入完成：分批进行时单批成功也会返回 true。
    // 是否跑完整批看 batchComplete / backfillDone / columns[].roundComplete。
    batchComplete: runs.every((run) => run.roundComplete),
    resumeHint: backfillDone
      ? '全量导入已完成；下一次调用执行增量回看（最近 3 页）。'
      : '全量导入未完成，继续调用本函数即可按页续跑（每次调用最多 10 次页面请求）。',
  };
}
