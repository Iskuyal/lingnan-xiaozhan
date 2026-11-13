import { school } from '../../services/school';
import { listNews, formatSyncTime, messageOf, RECENT_LIMIT, SOURCE_LABEL } from '../../services/news/index';
import { NewsListItem, NewsSourceMeta } from '../../services/news/types';

/**
 * 校园聚合页（设计图 19）：学校资料、两个资料入口、最近资讯与出处。
 *
 * 资讯来自云端已同步的条目（services/news 只读），读取失败保留可重试的错误态，
 * 不换成假新闻、不用 web-view 打开未授权页面。
 */
type NewsStatus = 'loading' | 'ready' | 'empty' | 'error';

interface TapEvent {
  currentTarget: { dataset: { id?: string; route?: string } };
}

Page({
  data: {
    school,
    newsStatus: 'loading' as NewsStatus,
    news: [] as NewsListItem[],
    sourceLabel: SOURCE_LABEL,
    syncedAtText: '',
    newsError: '',
  },
  onLoad() {
    return this.loadNews();
  },
  loadNews() {
    this.setData({ newsStatus: 'loading', newsError: '' });
    return listNews(RECENT_LIMIT)
      .then((feed: { items: NewsListItem[]; meta: NewsSourceMeta }) => {
        this.setData({
          news: feed.items,
          sourceLabel: feed.meta.label,
          syncedAtText: formatSyncTime(feed.meta.syncedAt),
          newsStatus: feed.items.length === 0 ? 'empty' : 'ready',
        });
      })
      .catch((error: unknown) => {
        this.setData({ newsStatus: 'error', newsError: messageOf(error) });
      });
  },
  retryNews() {
    return this.loadNews();
  },
  openRoute(event: TapEvent) {
    const route = event.currentTarget.dataset.route;
    if (typeof route !== 'string' || route === '') return;
    wx.navigateTo({ url: route });
  },
  openNews() {
    wx.navigateTo({ url: '/pages/news/index' });
  },
  openArticle(event: TapEvent) {
    const id = event.currentTarget.dataset.id;
    if (id === undefined || id === '') return;
    wx.navigateTo({ url: '/pages/news/detail/index?id=' + encodeURIComponent(id) });
  },
  copySource() {
    wx.setClipboardData({
      data: school.sourceUrl,
      success: () => wx.showToast({ title: '官网链接已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }),
    });
  },
});
