/**
 * 资讯数据模型。
 *
 * 这些类型同时被「服务端解析模块」（parse.ts）和「客户端服务模块」（index.ts）使用；
 * 单独成文件是为了让解析模块不依赖客户端代码，将来可直接放进云函数。
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

/** 数据来源说明，页面必须如实展示，避免把快照说成实时同步。 */
export interface NewsSourceMeta {
  /** 来源栏目列表 URL。 */
  listUrl: string;
  label: string;
  /** 内容快照的抓取日期（YYYY-MM-DD）。 */
  capturedAt: string;
  /** 是否来自服务端同步；随包快照恒为 false。 */
  syncedFromServer: boolean;
}
