/**
 * 资讯服务：数据来自云数据库 `news_articles`，由 `newsSync` 云函数同步写入。
 *
 * 客户端只读（安全规则 {"read": true, "write": false}），不在这里做任何写操作。
 * 云开发需要在 app.ts 中完成初始化（wx.cloud.init），失败时本模块会抛错，
 * 由页面显示可重试的错误状态，不静默降级。
 */
import { NewsArticle, NewsListItem, NewsSourceMeta } from './types';

const COLLECTION = 'news_articles';
/**
 * 列表聚合多个栏目（校园动态、团委通知公告）时的来源名：这些内容都来自学校官网，
 * 具体栏目由每条记录的 `sourceLabel` 给出，详情页按它展示，列表不冒充单一栏目。
 */
export const SOURCE_LABEL = '学校官网';
/** 每页读取条数：列表页逐页加载每次读取这么多。 */
export const LIST_LIMIT = 20;
/** 首页「最近资讯」展示条数。 */
export const RECENT_LIMIT = 3;

export interface NewsFeed {
  items: NewsListItem[];
  meta: NewsSourceMeta;
}

interface ArticleRow {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  date?: unknown;
  paragraphs?: unknown;
  sourceLabel?: unknown;
  updatedAt?: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 记录的来源栏目名；老记录缺字段时退回列表用的通用来源名，不显示空白。 */
function sourceLabelOf(row: ArticleRow): string {
  const label = asString(row.sourceLabel);
  return label === '' ? SOURCE_LABEL : label;
}

function toListItem(row: ArticleRow): NewsListItem {
  return {
    id: asString(row.id),
    title: asString(row.title),
    url: asString(row.url),
    date: asString(row.date),
  };
}

function toArticle(row: ArticleRow): NewsArticle {
  const paragraphs = Array.isArray(row.paragraphs) ? row.paragraphs : [];
  return {
    ...toListItem(row),
    paragraphs: paragraphs.filter((line): line is string => typeof line === 'string'),
  };
}

/**
 * 更新时间取这批记录里最新的 updatedAt，表示所展示文章最近一次成功写入的时间。
 * 部分成功时有效文章仍会更新；这不是整批成功时间（后者记录在私有 sync_state 中）。
 */
function latestSyncTime(rows: ArticleRow[]): string {
  let latest = '';
  for (const row of rows) {
    const value = asString(row.updatedAt);
    if (value > latest) latest = value;
  }
  return latest;
}

function database() {
  if (typeof wx === 'undefined' || wx.cloud === undefined) {
    throw new Error('云开发不可用：请确认基础库版本与 app.ts 中的 wx.cloud.init');
  }
  return wx.cloud.database();
}

/** 把同步时间格式化为本地时间文本；空值或非法值返回空字符串，页面据此隐藏该行。 */
export function formatSyncTime(iso: string): string {
  if (iso === '') return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * 取错误的可读文案，供页面直接展示。
 * 云调用失败时抛出的往往是带 errMsg 的普通对象而非 Error 实例，因此不依赖 instanceof。
 */
export function messageOf(error: unknown): string {
  if (error !== null && error !== undefined && typeof error === 'object') {
    const candidate = error as { message?: unknown; errMsg?: unknown };
    if (typeof candidate.message === 'string' && candidate.message !== '') return candidate.message;
    if (typeof candidate.errMsg === 'string' && candidate.errMsg !== '') return candidate.errMsg;
  }
  return error === null || error === undefined ? '未知错误' : String(error);
}

/**
 * 读取资讯列表（按发布日期倒序，skip 决定页起点）。
 * 同日期条目按 id 倒序补一个确定性次序：字符串序不代表官网发布先后，
 * 但能保证逐页加载不重复、不遗漏；不依赖它表达时间语义。
 */
export async function listNews(limit: number = LIST_LIMIT, skip: number = 0): Promise<NewsFeed> {
  const result = await database()
    .collection(COLLECTION)
    .field({ id: true, title: true, url: true, date: true, updatedAt: true })
    .orderBy('date', 'desc')
    .orderBy('id', 'desc')
    .skip(skip)
    .limit(limit)
    .get();
  const rows = (result.data || []) as ArticleRow[];
  return {
    items: rows.map(toListItem),
    meta: { label: SOURCE_LABEL, syncedAt: latestSyncTime(rows), fromServer: true },
  };
}

/** 按 id 读取单篇；未知 id 返回 null，由页面显示缺失状态。 */
export async function getNewsDetail(id: string): Promise<{ article: NewsArticle; meta: NewsSourceMeta } | null> {
  if (id === '') return null;
  const result = await database().collection(COLLECTION).where({ id }).limit(1).get();
  const rows = (result.data || []) as ArticleRow[];
  if (rows.length === 0) return null;
  const label = sourceLabelOf(rows[0]);
  return {
    article: toArticle(rows[0]),
    meta: { label, syncedAt: latestSyncTime(rows), fromServer: true },
  };
}
