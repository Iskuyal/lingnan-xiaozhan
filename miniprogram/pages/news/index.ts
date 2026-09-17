import { listNews, formatSyncTime, messageOf, LIST_LIMIT } from '../../services/news/index';
import { NewsListItem, NewsSourceMeta } from '../../services/news/types';

/** 只声明页面用到的事件字段，避免依赖 typings 内部结构。 */
interface TapEvent {
  currentTarget: { dataset: { id?: string } };
}

type Status = 'loading' | 'ready' | 'empty' | 'error';

const SOURCE_LABEL = '学校官网 · 校园动态';

Page({
  data: {
    status: 'loading' as Status,
    items: [] as NewsListItem[],
    source: { label: SOURCE_LABEL, syncedAt: '', fromServer: true } as NewsSourceMeta,
    syncedAtText: '',
    errorMessage: '',
  },
  onLoad() {
    return this.load();
  },
  /** 读取云端已同步的资讯；失败时页面显示可重试的错误状态，不静默降级为旧内容。 */
  load() {
    this.setData({ status: 'loading', errorMessage: '' });
    return listNews(LIST_LIMIT)
      .then((feed) => {
        this.setData({
          items: feed.items,
          source: feed.meta,
          syncedAtText: formatSyncTime(feed.meta.syncedAt),
          status: feed.items.length === 0 ? 'empty' : 'ready',
        });
      })
      .catch((error) => {
        this.setData({ status: 'error', errorMessage: messageOf(error) });
      });
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
