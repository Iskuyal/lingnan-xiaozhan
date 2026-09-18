import { listNews, formatSyncTime, messageOf, LIST_LIMIT, SOURCE_LABEL } from '../../services/news/index';
import { NewsListItem, NewsSourceMeta } from '../../services/news/types';

/** 只声明页面用到的事件字段，避免依赖 typings 内部结构。 */
interface TapEvent {
  currentTarget: { dataset: { id?: string } };
}

type Status = 'loading' | 'ready' | 'empty' | 'error';
/** 页脚状态：加载更多只在 ready 时出现，与整页四态分开。 */
type MoreState = 'idle' | 'loading' | 'error';

Page({
  data: {
    status: 'loading' as Status,
    items: [] as NewsListItem[],
    source: { label: SOURCE_LABEL, syncedAt: '', fromServer: true } as NewsSourceMeta,
    syncedAtText: '',
    errorMessage: '',
    hasMore: false,
    moreState: 'idle' as MoreState,
  },
  /** 已向云端读取的条数，作为下一页的 skip；与界面条数分开，失败重试时页起点不漂移。 */
  fetched: 0,
  onLoad() {
    return this.load();
  },
  /** 读取云端已同步的资讯；失败时页面显示可重试的错误状态，不静默降级为旧内容。 */
  load() {
    this.fetched = 0;
    this.setData({ status: 'loading', errorMessage: '', items: [], hasMore: false, moreState: 'idle' });
    return listNews(LIST_LIMIT, 0)
      .then((feed) => {
        this.fetched = feed.items.length;
        this.setData({
          items: feed.items,
          source: feed.meta,
          syncedAtText: formatSyncTime(feed.meta.syncedAt),
          status: feed.items.length === 0 ? 'empty' : 'ready',
          hasMore: feed.items.length >= LIST_LIMIT,
        });
      })
      .catch((error) => {
        this.setData({ status: 'error', errorMessage: messageOf(error) });
      });
  },
  /** 追加下一页；失败保留已有条目并进入可重试的页脚状态，重叠条目按 id 去重。 */
  loadMore() {
    if (this.data.status !== 'ready' || !this.data.hasMore || this.data.moreState === 'loading') return;
    this.setData({ moreState: 'loading', errorMessage: '' });
    return listNews(LIST_LIMIT, this.fetched)
      .then((feed) => {
        const known = new Set(this.data.items.map((item) => item.id));
        const fresh = feed.items.filter((item) => !known.has(item.id));
        this.fetched += feed.items.length;
        this.setData({
          items: this.data.items.concat(fresh),
          hasMore: feed.items.length >= LIST_LIMIT,
          moreState: 'idle',
        });
      })
      .catch((error) => {
        this.setData({ moreState: 'error', errorMessage: messageOf(error) });
      });
  },
  retryMore() {
    return this.loadMore();
  },
  onReachBottom() {
    return this.loadMore();
  },
  retry() {
    return this.load();
  },
  openDetail(event: TapEvent) {
    const id = event.currentTarget.dataset.id;
    if (id === undefined || id === '') return;
    wx.navigateTo({ url: `/pages/news/detail/index?id=${encodeURIComponent(id)}` });
  },
  goHome() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/home/index' });
  },
});
