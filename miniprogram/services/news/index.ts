/**
 * 资讯服务：数据来自云数据库 `news_articles`，由 `newsSync` 云函数同步写入。
 *
 * 客户端只读（安全规则 {"read": true, "write": false}），不在这里做任何写操作。
 * 云开发需要在 app.ts 中完成初始化（wx.cloud.init），失败时本模块会抛错，
 * 由页面显示可重试的错误状态，不静默降级。
 */
import { NewsArticle, NewsListItem, NewsSourceMeta } from './types';

const COLLECTION = 'news_articles';
const SOURCE_LABEL = '学校官网 · 校园动态';
/** 单次读取条数：列表页一次展示这么多，逐页加载属 P3-2。 */
export const LIST_LIMIT = 20;

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
  updatedAt?: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
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
 * 更新时间取这批记录里最新的 updatedAt：云函数每次成功同步都会刷新抓取到的那批文章，
 * 因此页面看到的最近时间即「数据最后更新时间」。失败时云函数不写入，这个时间自然保持不变。
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

/** 读取资讯列表（按发布日期倒序）。 */
export async function listNews(limit: number = LIST_LIMIT): Promise<NewsFeed> {
  const result = await database()
    .collection(COLLECTION)
    .field({ id: true, title: true, url: true, date: true, updatedAt: true })
    .orderBy('date', 'desc')
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
  return {
    article: toArticle(rows[0]),
    meta: { label: SOURCE_LABEL, syncedAt: latestSyncTime(rows), fromServer: true },
  };
}
