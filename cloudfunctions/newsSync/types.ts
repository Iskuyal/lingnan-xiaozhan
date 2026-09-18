/**
 * 资讯数据模型（云函数侧）。
 *
 * 与 `miniprogram/services/news/types.ts` 保持一致：微信云函数按目录整体部署，
 * 没有跨目录共享模块的机制，因此这两份类型各自存在。字段名是云函数与小程序
 * 之间的数据契约，改名时两侧必须同步——`tests/newsSync.test.cjs` 会锁住入库记录的字段列表。
 */

/** 列表条目：官网列表页能提取到的最小字段。 */
export interface NewsListItem {
  /** 原文 URL 最后一段路径，例如 content_32118，用作页面间传参。 */
  id: string;
  title: string;
  /** 原文绝对 URL，同时是跨页去重键。 */
  url: string;
  /** YYYY-MM-DD；官网条目缺失日期时为空字符串。 */
  date: string;
}

/** 文章详情：列表条目加上清理后的正文。 */
export interface NewsArticle extends NewsListItem {
  /** 清理后的正文段落；无正文时为空数组。 */
  paragraphs: string[];
}
