/**
 * 资讯数据模型（小程序侧）。
 *
 * 与 `cloudfunctions/newsSync/types.ts` 保持一致：微信云函数按目录整体部署，没有跨目录
 * 共享模块的机制，因此两份类型各自存在。字段名是云函数与小程序之间的数据契约，
 * 改名时两侧必须同步——`tests/newsSync.test.cjs` 锁住了入库记录的字段列表。
 */

/** 列表条目：列表页需要的最小字段。 */
export interface NewsListItem {
  /** 原文 URL 最后一段路径，例如 content_32118，用作页面间传参。 */
  id: string;
  title: string;
  /** 原文绝对 URL。 */
  url: string;
  /** YYYY-MM-DD；官网条目缺失日期时为空字符串。 */
  date: string;
}

/** 文章详情：列表条目加上正文段落。 */
export interface NewsArticle extends NewsListItem {
  /** 正文段落；无正文时为空数组。 */
  paragraphs: string[];
}

/** 数据来源说明，页面必须如实展示，不能让用户以为内容是实时的。 */
export interface NewsSourceMeta {
  /** 来源栏目名称。 */
  label: string;
  /** 最近一次成功同步时间（ISO 8601）；没有数据时为空字符串。 */
  syncedAt: string;
  /** 数据是否来自服务端同步。客户端只读云数据库，恒为 true。 */
  fromServer: boolean;
}
