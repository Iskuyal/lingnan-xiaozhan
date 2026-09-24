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
import * as cloudbase from '@cloudbase/node-sdk';
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
/**
 * 站点级状态文档的 `_id`：官网限速（WAF）冻结的是出口 IP，不区分栏目，
 * 冷却必须整站生效，因此单独一条文档记录「最近一次撞上限速的时间」。
 */
const SITE_STATE_ID = 'site';
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
 * 一个栏目最多记住多少条「已知没取到」的条目 URL（`sync_state.missing`）。
 * 这些条目不会被自动重访，计数与 URL 用于向维护者说明「还差几条、用 reset 补齐」。
 */
const MAX_MISSING_URLS = 200;
/** 跟随同站跳转的次数上限；每次跳转都算一次页面请求并同样按 1.3 秒节流。 */
const MAX_REDIRECTS = 3;
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

/**
 * 请求预算或本次调用的截止点已到：**不是失败**。
 * 在等够 1.3 秒之后、真正发请求之前才判定，因此不会出现「检查时还没到点、发出去时已经超时」。
 * 队列与游标都不动，下一次调用从原处续跑。
 */
class BudgetExhaustedError extends Error {}

type Phase = 'backfill' | 'incremental';
type Mode = Phase | 'auto';
/** 一轮同步的结果：整批成功 / 部分成功 / 全部失败 / 本轮没跑完 / 撞上限速；空字符串表示还没跑过。 */
type LastOutcome = 'ok' | 'partial' | 'failed' | 'running' | 'rate-limited' | '';
/** 调用来源：可信定时触发或被拒绝的手动调用。 */
type TriggerKind = 'timer' | 'manual';

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
  lastOutcome: LastOutcome;
  lastError: string;
  lastRequestAt: string;
  lastRunAtLocal: string;
  /** 历史状态可能记录手动调用；新版成功同步只来自定时触发。 */
  lastTrigger: TriggerKind | '';
  lastTriggerName: string;
  rateLimitedAt: string;
  /** 已知没取到的条目 URL（重试后仍失败）：不会被自动重访，需要 reset 重跑补齐。 */
  missing: string[];
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
  /** 本栏目已知没取到的条目数（`sync_state.missing` 的长度）。 */
  missing: number;
  lastSuccessAt: string;
  message: string;
}

/** 一次 HTTP GET 的结果：拿到正文，或者一个需要跟随的跳转。 */
type FetchOutcome = { kind: 'html'; html: string } | { kind: 'redirect'; location: string };

/**
 * 取一次官网页面。只接受 200；3xx 带 Location 时把跳转交回给调用方（由它按节流继续跟随）；
 * 403/429 视为限速并抛 RateLimitedError。
 */
function fetchOnce(url: string): Promise<FetchOutcome> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: REQUEST_TIMEOUT_MS, headers: REQUEST_HEADERS }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        resolve({ kind: 'redirect', location });
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
      response.on('end', () => resolve({ kind: 'html', html: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('timeout', () => request.destroy(new Error(`请求超时：${url}`)));
    request.on('error', reject);
  });
}

/**
 * 请求闸门：串行、限速、限额。
 *
 * - 与上一次请求保持 REQUEST_INTERVAL_MS 的间隔；上一次请求发生在别的调用里也能接着排
 *   （构造时传入落盘的 lastRequestAt），避免连续触发时把两次调用连成高频请求。
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

/**
 * 经闸门发起一次页面请求（列表页、正文与同站跳转都各算一次）。
 *
 * 判定顺序是刻意的：**先按 1.3 秒节流等待，再判断还能不能发**。
 * 等待本身可能把人推到本次调用的截止点之后，若在等待前判断，「检查通过、发出去时已超时」
 * 就会真的发生。跳转同样走这套闸门，因此同站跳转之间的间隔也不会短于 1.3 秒。
 */
async function fetchWithGate(gate: RequestGate, url: string): Promise<string> {
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await gate.waitTurn();
    if (!gate.canRequest()) throw new BudgetExhaustedError(`请求预算或时间已用完：${target}`);
    gate.markRequest();
    const outcome = await fetchOnce(target);
    if (outcome.kind === 'html') return outcome.html;
    const next = new URL(outcome.location, target).toString();
    if (isOffsiteUrl(next)) throw new OffsiteBodyError(`页面跳转到官网之外（${next}），正文不入库`);
    target = next;
  }
  throw new Error(`跳转次数过多（超过 ${MAX_REDIRECTS} 次）：${url}`);
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
function shanghaiStamp(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 3600 * 1000);
  return `${shifted.toISOString().slice(0, 19).replace('T', ' ')} +08:00`;
}

/** 东八区日期（YYYY-MM-DD）。定时任务在 06:00（UTC 前一天 22:00）运行，不能用 UTC 日期。 */
function shanghaiDate(date: Date): string {
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 取较晚的一个 ISO 时间字符串（忽略空值）。 */
function laterIso(a: string, b: string): string {
  if (a === '') return b;
  if (b === '') return a;
  return a >= b ? a : b;
}

/**
 * 调用者可伪造 event.Type/TriggerName，因此它们只能与平台来源同时核对。
 * getCloudbaseContext(context) 优先读取本次调用的 context，避免实例复用时读取残留环境变量。
 * 当前只接受 newsSyncDaily 定时器；控制台/客户端手动调用不执行同步。
 */
function trustedTimer(event: { Type?: unknown; TriggerName?: unknown }, invocationContext: unknown): boolean {
  if (event.Type !== 'Timer' || event.TriggerName !== 'newsSyncDaily') return false;
  if (invocationContext === null || typeof invocationContext !== 'object') return false;
  const current = invocationContext as { environment?: unknown; environ?: unknown };
  if (typeof current.environment !== 'string' && typeof current.environ !== 'string') return false;
  try {
    const runtime = cloudbase.getCloudbaseContext(invocationContext as Parameters<typeof cloudbase.getCloudbaseContext>[0]);
    const wechat = cloud.getWXContext() as { SOURCE?: unknown } | undefined;
    return runtime.TRIGGER_SRC === 'timer' && wechat?.SOURCE === 'wx_trigger';
  } catch {
    return false;
  }
}

/** 正文是否不在官网：外链条目（如 mp.weixin.qq.com）只存标题、日期与原文链接。 */
function isOffsiteUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !(host === 'lnc.edu.cn' || host.endsWith('.lnc.edu.cn'));
  } catch {
    return true;
  }
}

/**
 * 限速冷却的截止时间（毫秒时间戳）。没有记录或时间非法时返回 0，表示没有冷却。
 * 传入多个来源时取最晚的一个：站点级记录与栏目自己的记录都要算，
 * 这样升级前写下的栏目级 `rateLimitedAt` 仍然生效。
 */
function cooldownDeadline(...stamps: string[]): number {
  let until = 0;
  for (const stamp of stamps) {
    if (stamp === '') continue;
    const parsed = Date.parse(stamp);
    if (Number.isNaN(parsed)) continue;
    until = Math.max(until, parsed + RATE_LIMIT_COOLDOWN_MS);
  }
  return until;
}

/** 冷却提示文案（栏目级与站点级记录取更早的那个时间作为「何时撞上的」）。 */
function cooldownNotice(until: number, startedAt: number, ...stamps: string[]): string {
  const since = stamps.filter((stamp) => stamp !== '').sort()[0] ?? '';
  const minutes = Math.ceil((until - startedAt) / 60000);
  return `限速冷却中：${since} 触发了官网限速 403，约 ${minutes} 分钟后可再试。本次未发起任何请求。`;
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
    missing: [],
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
  for (const key of ['lockUntil', 'lastAttemptAt', 'lastSuccessAt', 'lastError', 'lastRequestAt', 'lastRunAtLocal', 'lastTriggerName', 'rateLimitedAt'] as const) {
    if (typeof source[key] === 'string') state[key] = source[key] as string;
  }
  state.lastOutcome = normalizeOutcome(source.lastOutcome);
  state.lastTrigger = source.lastTrigger === 'timer' || source.lastTrigger === 'manual' ? source.lastTrigger : '';
  state.missing = Array.isArray(source.missing) ? source.missing.filter((url) => typeof url === 'string') : [];
  if (typeof source.elapsedMs === 'number' && Number.isFinite(source.elapsedMs)) state.elapsedMs = source.elapsedMs;
  return state;
}

/** 只接受已知的结果取值；旧文档或人工改坏的值退回「还没跑过」。 */
function normalizeOutcome(raw: unknown): LastOutcome {
  return raw === 'ok' || raw === 'partial' || raw === 'failed' || raw === 'running' || raw === 'rate-limited' ? raw : '';
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
    missing: state.missing,
    elapsedMs: state.elapsedMs,
  };
}

/** 状态文档字段集合（与 stateFields 一致），测试据此锁定同步状态的形状。 */
export const SYNC_STATE_FIELDS: string[] = [
  'column', 'backfillDone', 'backfillPage', 'pending', 'pendingKind', 'round', 'lockUntil',
  'lastAttemptAt', 'lastSuccessAt', 'lastOutcome', 'lastError', 'lastRequestAt', 'lastRunAtLocal',
  'lastTrigger', 'lastTriggerName', 'rateLimitedAt', 'missing', 'elapsedMs',
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

interface SiteState {
  /** 最近一次撞上官网限速 403 的时间（ISO）；没有记录时为空字符串。 */
  rateLimitedAt: string;
}

/**
 * 站点级冷却记录。
 *
 * 官网 WAF 冻结的是出口 IP 而不是某个栏目，所以冷却必须整站生效：任一栏目撞上 403，
 * 之后 30 分钟内任何栏目都不再发起请求。文档不存在或读失败都按「没有冷却」处理
 * （栏目自己的 `rateLimitedAt` 仍会兜住同一个调用链）。
 */
async function readSiteState(): Promise<SiteState> {
  try {
    const result = (await db.collection(STATE_COLLECTION).doc(SITE_STATE_ID).get()) as { data?: unknown };
    const data = result === null || result === undefined ? null : result.data;
    if (data === null || data === undefined || typeof data !== 'object') return { rateLimitedAt: '' };
    const value = (data as { rateLimitedAt?: unknown }).rateLimitedAt;
    return { rateLimitedAt: typeof value === 'string' ? value : '' };
  } catch {
    return { rateLimitedAt: '' };
  }
}

async function saveSiteRateLimit(at: string): Promise<void> {
  await db.collection(STATE_COLLECTION).doc(SITE_STATE_ID).set({ data: { column: SITE_STATE_ID, rateLimitedAt: at } });
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
  // 列表页缺日期时没有可比信息，只比标题：否则这类条目会因为「记录有日期、列表页没有」
  // 每天都被判定成变化而重抓一次。
  const dateMatches = item.date === ''
    || (typeof existing.date === 'string' && existing.date === item.date);
  return paragraphs.length > 0
    && typeof existing.title === 'string' && existing.title === item.title
    && dateMatches;
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

/**
 * 记下「重试后仍没取到」的条目。这些条目不会被自动重访（列表游标已经越过它们所在的页），
 * 因此必须留在状态里，让维护者知道还差几条、用 `reset` 重跑补齐。
 */
function noteMissing(state: ColumnState, url: string): void {
  if (state.missing.includes(url) || state.missing.length >= MAX_MISSING_URLS) return;
  state.missing.push(url);
}

/** 条目成功写入（或确认无需写入）后，把它从缺失清单里摘掉：清单只表示「现在仍然缺」。 */
function clearMissing(state: ColumnState, url: string): void {
  const index = state.missing.indexOf(url);
  if (index !== -1) state.missing.splice(index, 1);
}

/** 缺失条目的提示文案；没有缺失时返回空字符串。 */
function missingHint(state: ColumnState): string {
  if (state.missing.length === 0) return '';
  return `｜还差 ${state.missing.length} 条未取到，修复原因后加 {"reset":true} 重跑补齐（按原文 URL 幂等，不会产生重复条目）`;
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
 * 结束当前轮：只有整轮没有任何失败（含外链条目）才算「整批成功」，失败与部分成功都不推进
 * lastSuccessAt。**全量导入同理：有失败就不算完成**——没取到的条目不会再被访问，
 * 状态与 resumeHint 要如实说明「还差 N 条、用 reset 补齐」，不能对外宣称已完成。
 * 空跑的一轮（游标已越过末页、没有任何处理量）不改写结果，避免用「什么都没做」冒充一次成功同步。
 */
function finishRound(state: ColumnState, complete: boolean, nowIso: string): void {
  const round = state.round;
  if (complete) {
    const succeeded = round.inserted + round.updated + round.skipped + round.offsite;
    round.active = false;
    if (succeeded + round.failed === 0) return;
    state.lastOutcome = round.failed === 0 ? 'ok' : succeeded > 0 ? 'partial' : 'failed';
    if (round.failed === 0) {
      if (round.phase === 'backfill') state.backfillDone = true;
      state.lastSuccessAt = nowIso;
      state.lastError = '';
    } else {
      // 全量导入有失败：保持未完成，并把「还差几条」写进状态，避免误判进度。
      state.lastError = summarizeFailures(round.failures) + missingHint(state);
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
    missing: state.missing.length,
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
  run.missing = state.missing.length;
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
  // 文章页偶尔没有「发布时间」：新解析出的日期为空时保留旧值，否则旧记录里正确的日期
  // 会被清空，之后每次增量回看都因日期不一致而重抓同一篇（也永远无法判定「内容未变」）。
  const keepDate = article.date === '' && existing !== null && typeof existing.date === 'string' && existing.date !== '';
  const record = toArticleRecord(
    keepDate ? { ...article, date: existing.date as string } : article,
    column.label,
    context.capturedAt,
    context.nowIso,
  );
  if (existing === null) {
    await insertArticle(record);
    return 'inserted';
  }
  await updateArticle(existing._id, record as unknown as Record<string, unknown>);
  return 'updated';
}

/** 本轮计数的可读摘要。 */
function countSummary(state: ColumnState): string {
  const round = state.round;
  return `插入 ${round.inserted}、更新 ${round.updated}、跳过 ${round.skipped}、外链 ${round.offsite}、失败 ${round.failed}`;
}

/**
 * 全量导入收尾文案。**有失败时不能宣称完成**：那些条目不会再被自动重访，
 * 必须让维护者看到「还差几条」与补齐方式。
 */
function backfillSummary(state: ColumnState, lastPage: number): string {
  if (state.backfillDone) return `全量导入完成：共 ${lastPage} 页，${countSummary(state)}`;
  if (state.missing.length > 0) {
    return `全量列表已读完（共 ${lastPage} 页）但尚未完成：${missingHint(state).replace('｜', '')}；本轮 ${countSummary(state)}`;
  }
  return `全量列表已读完（共 ${lastPage} 页）但尚未完成：本批没有处理任何页（游标已在第 ${lastPage + 1} 页）；加 {"reset":true} 可重跑补齐。`;
}

/** 增量回看收尾文案。 */
function incrementalSummary(state: ColumnState, lastPage: number): string {
  const suffix = state.missing.length > 0 ? `；另有 ${state.missing.length} 条早前失败的条目未取到，可用 {"reset":true} 重跑补齐` : '';
  return `增量同步完成：回看最近 ${lastPage} 页，更新 ${state.round.updated}、跳过 ${state.round.skipped}、外链 ${state.round.offsite}、失败 ${state.round.failed}${suffix}`;
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
        let succeeded = false;
        try {
          const outcome = await processPendingItem(column, item, { state, gate, context });
          if (outcome === 'inserted') state.round.inserted += 1;
          else if (outcome === 'updated') state.round.updated += 1;
          else if (outcome === 'skipped') state.round.skipped += 1;
          else state.round.offsite += 1;
          succeeded = true;
        } catch (error) {
          // 限速 403 与预算用尽：条目留在队列里，本轮停止，下一次调用从原处续跑（不重试）。
          if (error instanceof RateLimitedError || error instanceof BudgetExhaustedError) throw error;
          pushFailure(state.round, `${item.url}：${describeError(error)}`);
          // 同一轮内给每篇一次重试机会（放回队尾）：首次全量有 1500 多次请求，偶发 HTTP 抖动
          // 不该在库里留下永久空洞。重试仍会失败的话，下一次走到它时不再重试。
          retry = !state.round.retried.includes(item.url) && state.round.retried.length < MAX_ROUND_RETRIES;
          if (retry) state.round.retried.push(item.url);
          else noteMissing(state, item.url);
        }
        if (succeeded) clearMissing(state, item.url);
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
        run.message = isBackfill ? backfillSummary(state, lastPage) : incrementalSummary(state, lastPage);
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
    } else if (error instanceof BudgetExhaustedError) {
      // 预算或截止点用尽：不是失败，本轮未结束，进度已随每次请求落盘。
      state.lastOutcome = 'running';
      run.message = '本次调用已用完请求配额或到时间上限，进度已保存，继续调用即可续跑。';
    } else {
      // 第 3 步（列表页）或状态读写失败：本轮中断但游标保留，重跑即续。
      state.lastOutcome = 'running';
      pushFailure(state.round, note);
      state.lastError = summarizeFailures(state.round.failures) + missingHint(state);
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

export async function main(event: { mode?: unknown; column?: unknown; maxRequests?: unknown; limit?: unknown; reset?: unknown; Type?: unknown; TriggerName?: unknown } = {}, invocationContext?: unknown) {
  const startedAt = Date.now();
  const nowIso = new Date(startedAt).toISOString();
  const runAtLocal = shanghaiStamp(new Date(startedAt));
  const context: SyncContext = { capturedAt: shanghaiDate(new Date(startedAt)), nowIso };
  const trigger = trustedTimer(event, invocationContext) ? 'timer' : 'manual';
  const triggerName = trigger === 'timer' ? 'newsSyncDaily' : '';
  const runs: ColumnRun[] = [];

  if (trigger !== 'timer') {
    return {
      ok: false, trigger, triggerName, runAt: runAtLocal, timeZone: TIME_ZONE,
      error: '仅允许平台定时触发同步；手动调用来源已拒绝', columns: runs,
      elapsedMs: Date.now() - startedAt,
    };
  }

  try {
    const mode = resolveMode(event);
    const columns = selectColumns(event.column);
    const budget = resolveBudget(event);
    const quotas = allocateBudget(budget, columns.length);
    const deadline = startedAt + WORK_DEADLINE_MS;
    // 冷却按站点读一次：官网 WAF 冻结的是出口 IP，栏目之间不隔离。
    const site = await readSiteState();
    let pacingFrom = '';

    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index];
      const state = await readState(column);
      state.lastAttemptAt = nowIso;
      state.lastRunAtLocal = runAtLocal;
      state.lastTrigger = trigger;
      state.lastTriggerName = triggerName;

      // 冷却：站点级记录与栏目自己的记录取更晚的一个（升级前写下的栏目级记录仍然生效）。
      // 冷却期内本栏目不发任何请求——继续重试只会延长官网的冻结。
      const until = cooldownDeadline(site.rateLimitedAt, state.rateLimitedAt);
      if (until > 0 && startedAt < until) {
        runs.push(skippedRun(column, state, cooldownNotice(until, startedAt, site.rateLimitedAt, state.rateLimitedAt)));
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

      if (result.run.rateLimited) {
        // 撞上限速立刻结束本轮：所有栏目共用同一个出口 IP，后面的栏目一个请求都不能再发。
        await saveSiteRateLimit(nowIso);
        for (const rest of columns.slice(index + 1)) {
          const restState = await readState(rest);
          runs.push(skippedRun(rest, restState, '前一个栏目返回限速 403，本轮立即结束（共用出口 IP，冷却期内不再请求官网）。'));
        }
        break;
      }
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
  const missing = runs.reduce((sum, run) => sum + run.missing, 0);
  const resetHint = '按栏目加 {"reset":true} 重跑补齐（按原文 URL 幂等，不会产生重复条目）';

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
    missing,
    // `ok` 只说明「本次调用没有失败」，不代表整批导入完成：分批进行时单批成功也会返回 true。
    // 是否跑完整批看 batchComplete / backfillDone / columns[].roundComplete。
    batchComplete: runs.every((run) => run.roundComplete),
    resumeHint: backfillDone
      ? (missing > 0
        ? `全量导入已完成；仍有 ${missing} 条早前失败的条目未取到（见 sync_state.missing），需要时 ${resetHint}。下一次调用执行增量回看（最近 3 页）。`
        : '全量导入已完成；下一次调用执行增量回看（最近 3 页）。')
      : (missing > 0
        ? `全量导入还差 ${missing} 条未取到：${resetHint}。`
        : '全量导入未完成，继续调用本函数即可按页续跑（每次调用最多 10 次页面请求）。'),
  };
}
