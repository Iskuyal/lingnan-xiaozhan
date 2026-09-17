/**
 * 资讯客户端服务：页面只依赖这里的接口，不直接接触 HTML 或解析细节。
 *
 * 数据源通过 NewsDataSource 注入，方便替换：
 * 当前是随包内容快照（snapshot.ts，静态、未接入云端），
 * 云端可用后换成读取云函数/数据库的实现即可，页面无需改动。
 * 解析（parse.ts）将来在服务端运行，客户端不依赖它。
 */
import { NewsArticle, NewsListItem, NewsSourceMeta } from './types';
import { snapshotArticles, snapshotSource } from './snapshot';

export interface NewsDataSource {
  readonly meta: NewsSourceMeta;
  list(): NewsListItem[];
  findById(id: string): NewsArticle | null;
}

export interface NewsService {
  readonly meta: NewsSourceMeta;
  listNews(): NewsListItem[];
  /** 未知 id 与空 id 都返回 null，由页面显示缺失状态。 */
  getNewsDetail(id: string): NewsArticle | null;
}

export function createNewsService(source: NewsDataSource): NewsService {
  return {
    meta: source.meta,
    listNews: () => source.list(),
    getNewsDetail: (id: string) => (id === '' ? null : source.findById(id)),
  };
}

/** 把已解析的文章数组包装成数据源；列表字段由正文条目派生，避免两处不一致。 */
export function createArticleSource(articles: NewsArticle[], meta: NewsSourceMeta): NewsDataSource {
  const byId = new Map<string, NewsArticle>();
  for (const article of articles) byId.set(article.id, article);
  return {
    meta,
    list: () => articles.map(({ id, title, url, date }) => ({ id, title, url, date })),
    findById: (id: string) => byId.get(id) ?? null,
  };
}

/** 页面使用的默认服务：当前数据来自随包快照，未接入云端同步。 */
export const newsService = createNewsService(createArticleSource(snapshotArticles, snapshotSource));
