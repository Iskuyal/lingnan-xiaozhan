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

/**
 * 栏目模板标识：决定用哪一套列表/正文解析规则。
 * - `xyxw`：校园动态，`ul.list.list-intro` + `a.tit` / `h1.title` + `div.article-content`。
 * - `newsList`：团委通知公告，`ul.newsList` + 直挂 `span.date` 与 `<a title>` / `h2.title` + `div.property` + `div.printArea`。
 * 两套模板实测不同构，依据见 docs/news-sources.md 的「模板与校园动态不同构」。
 */
export type NewsTemplate = 'xyxw' | 'newsList';

/** 一个同步栏目：列表入口、模板与已实测的历史页数。 */
export interface NewsColumn {
  /** 栏目标识，同时是 `sync_state` 文档的 `_id`，如 xyxw-xydt。 */
  id: string;
  /** 来源栏目名，写入每条记录并由页面展示。 */
  label: string;
  /** 列表第 1 页 URL；第 N 页为 `${listUrl}_${N}`。 */
  listUrl: string;
  template: NewsTemplate;
  /** 历史总页数（实测页脚「共 N 条信息 / 共 M 页」），决定全量导入的页范围。 */
  totalPages: number;
}
