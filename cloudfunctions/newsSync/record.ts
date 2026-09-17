/**
 * 入库记录的形状：云函数写进 `news_articles` 的字段，就是小程序读到的字段。
 *
 * 单独成文件且保持纯函数（不引入 wx-server-sdk），是为了能在 Node 测试里直接执行——
 * 云函数入口 `index.ts` 需要 wx-server-sdk，无法在本地测试中加载。
 */
import { NewsArticle } from './types';

export interface NewsArticleRecord {
  /** 文章标识，取自 URL 末段，小程序用它做页面间传参。 */
  id: string;
  /** 原文绝对 URL，唯一索引字段，去重键。 */
  url: string;
  title: string;
  /** YYYY-MM-DD，取自原文；原文没有日期时为空字符串。 */
  date: string;
  paragraphs: string[];
  /** 来源栏目，页面必须如实展示。 */
  sourceLabel: string;
  /** 本条内容的抓取日期（YYYY-MM-DD）。 */
  capturedAt: string;
  /** 本条记录最后写入时间（ISO 8601），同时是小程序展示「更新时间」的依据。 */
  updatedAt: string;
}

/** 契约字段列表：与小程序读取侧约定的字段集合，改名会被测试拦下。 */
export const ARTICLE_RECORD_FIELDS: string[] = [
  'id',
  'url',
  'title',
  'date',
  'paragraphs',
  'sourceLabel',
  'capturedAt',
  'updatedAt',
];

export function toArticleRecord(
  article: NewsArticle,
  sourceLabel: string,
  capturedAt: string,
  updatedAt: string,
): NewsArticleRecord {
  return {
    id: article.id,
    url: article.url,
    title: article.title,
    date: article.date,
    paragraphs: article.paragraphs,
    sourceLabel,
    capturedAt,
    updatedAt,
  };
}
