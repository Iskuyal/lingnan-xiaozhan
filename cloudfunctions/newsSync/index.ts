/**
 * 官网资讯同步云函数（P3）。
 *
 * 职责：抓取官网「校园动态」列表 → 逐篇抓正文并用 parse.ts 解析 → 按原文 URL
 * upsert 进 `news_articles` → 更新 `sync_state`。写入只发生在这里，客户端对
 * `news_articles` 只有读权限（安全规则 {"read": true, "write": false}）。
 *
 * 运行环境：微信云开发云函数（Node.js）。此处使用 Node 内置的 https 而非全局
 * fetch，避免依赖运行时版本是否支持 fetch。
 *
 * 定时触发器尚未启用：首次同步范围与失败处理要先在真实环境验证，见
 * docs/cloud-development.md 的 P3 验收清单。
 */
import * as https from 'https';
import * as cloud from 'wx-server-sdk';
import { parseNewsList, parseNewsArticle } from './parse';
import { toArticleRecord } from './record';
import { NewsListItem } from './types';

// wx-server-sdk 4.0.2 的 d.ts 把 DYNAMIC_CURRENT_ENV 声明为 symbol，而 init 的 env 参数
// 类型未包含 symbol —— 属于类型声明滞后，运行时是官方推荐用法。若 SDK 后续修正类型，可去掉断言。
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV as unknown as string });

const db = cloud.database();
const NEWS_COLLECTION = 'news_articles';
const STATE_COLLECTION = 'sync_state';

const COLUMN_ID = 'xyxw-xydt';
const LIST_URL = 'https://lnc.edu.cn/xyxw/xydt';
const SOURCE_LABEL = '学校官网 · 校园动态';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
const REQUEST_TIMEOUT_MS = 10000;
/**
 * 请求头：官网对缺少浏览器特征的请求返回 403（实测云函数环境如此，本机 curl 正常）。
 * 这里用常见浏览器请求头读取公开页面，不携带 Cookie，也不涉及任何身份伪装。
 */
const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

/** 取官网页面 HTML。只接受 200；最多跟随 3 次跳转。 */
function fetchHtml(url: string, redirects = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: REQUEST_TIMEOUT_MS, headers: REQUEST_HEADERS }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location && redirects < 3) {
        response.resume();
        resolve(fetchHtml(new URL(location, url).toString(), redirects + 1));
        return;
      }
      if (status !== 200) {
        // 带上响应片段：403 之类的拒绝需要看到服务端返回了什么才能判断原因。
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const snippet = Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').slice(0, 200);
          reject(new Error(`HTTP ${status}：${url}｜响应片段：${snippet}`));
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

/** 合并写入同步状态：失败时保留 lastSuccessAt，不被清空。 */
async function saveSyncState(fields: Record<string, unknown>): Promise<void> {
  const collection = db.collection(STATE_COLLECTION);
  try {
    await collection.doc(COLUMN_ID).update({ data: fields });
  } catch (error) {
    await collection.doc(COLUMN_ID).set({ data: { column: COLUMN_ID, ...fields } });
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
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

async function findArticleByUrl(url: string): Promise<{ _id: string } | null> {
  const rows = await queryData<{ _id: string }>(db.collection(NEWS_COLLECTION).where({ url }).limit(1));
  return rows.length > 0 ? rows[0] : null;
}

async function latestArticleSummary(): Promise<{ id: string; title: string; date: string } | null> {
  const rows = await queryData<{ id: string; title: string; date: string }>(
    db.collection(NEWS_COLLECTION).orderBy('date', 'desc').limit(1),
  );
  return rows.length > 0 ? rows[0] : null;
}

function resolveLimit(event: { limit?: unknown }): number {
  const requested = Number(event === null || event === undefined ? undefined : event.limit);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(requested), MAX_LIMIT);
}

export async function main(event: { limit?: unknown } = {}) {
  const startedAt = Date.now();
  const attemptedAt = new Date().toISOString();
  const limit = resolveLimit(event);
  const capturedAt = today();

  try {
    const listHtml = await fetchHtml(LIST_URL);
    const items: NewsListItem[] = parseNewsList(listHtml, LIST_URL).slice(0, limit);
    if (items.length === 0) {
      throw new Error('列表页没有解析到任何条目，官网结构可能已变化');
    }

    let inserted = 0;
    let updated = 0;
    const failures: string[] = [];

    for (const item of items) {
      try {
        const articleHtml = await fetchHtml(item.url);
        const article = parseNewsArticle(articleHtml, item.url);
        const record = toArticleRecord(article, SOURCE_LABEL, capturedAt, attemptedAt);
        const existing = await findArticleByUrl(article.url);
        if (existing !== null) {
          await db.collection(NEWS_COLLECTION).doc(existing._id).update({ data: record });
          updated += 1;
        } else {
          await db.collection(NEWS_COLLECTION).add({ data: record });
          inserted += 1;
        }
      } catch (error) {
        failures.push(`${item.url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const elapsedMs = Date.now() - startedAt;
    const lastError = failures.length > 0 ? failures.join(' | ') : '';
    await saveSyncState({
      lastSuccessAt: attemptedAt,
      lastAttemptAt: attemptedAt,
      lastOutcome: failures.length === 0 ? 'ok' : 'partial',
      lastError,
      elapsedMs,
      inserted,
      updated,
    });

    const sample = await latestArticleSummary();
    return {
      ok: failures.length === 0,
      capturedAt,
      requested: limit,
      parsed: items.length,
      inserted,
      updated,
      failed: failures.length,
      failures: failures.slice(0, 3),
      elapsedMs,
      sample,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await saveSyncState({
      lastAttemptAt: attemptedAt,
      lastOutcome: 'failed',
      lastError: message,
      elapsedMs: Date.now() - startedAt,
    });
    return { ok: false, capturedAt, requested: limit, error: message, elapsedMs: Date.now() - startedAt };
  }
}
