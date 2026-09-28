import { school } from '../../services/school';
import { listNews, formatSyncTime, messageOf, RECENT_LIMIT, SOURCE_LABEL } from '../../services/news/index';
import { NewsListItem, NewsSourceMeta } from '../../services/news/types';

/** 只声明页面用到的事件字段，避免依赖 typings 内部结构。 */
interface TapEvent {
  currentTarget: { dataset: { id?: string } };
}

/** 最近资讯只有加载中、有数据、读取失败三态；完整列表的空态与分页在资讯页处理。 */
type NewsStatus = 'loading' | 'ready' | 'error';

Page({
  data: {
    school,
    recentNews: [] as NewsListItem[],
    newsMeta: { label: SOURCE_LABEL, syncedAt: '', fromServer: true } as NewsSourceMeta,
    newsSyncedAtText: '',
    newsStatus: 'loading' as NewsStatus,
    newsError: '',
  },
  onLoad() {
    return this.loadRecentNews();
  },
  /** 最近资讯读取失败时本区块显示可重试的错误状态；不影响静态入口与简介。 */
  loadRecentNews() {
    this.setData({ newsStatus: 'loading', newsError: '' });
    return listNews(RECENT_LIMIT)
      .then((feed) => {
        this.setData({
          recentNews: feed.items,
          newsMeta: feed.meta,
          newsSyncedAtText: formatSyncTime(feed.meta.syncedAt),
          newsStatus: 'ready',
        });
      })
      .catch((error) => {
        this.setData({ newsStatus: 'error', newsError: messageOf(error) });
      });
  },
  retryNews() {
    return this.loadRecentNews();
  },
  openNews() {
    wx.navigateTo({ url: '/pages/news/index' });
  },
  openNewsDetail(event: TapEvent) {
    const id = event.currentTarget.dataset.id;
    if (id === undefined || id === '') return;
    wx.navigateTo({ url: `/pages/news/detail/index?id=${encodeURIComponent(id)}` });
  },
  openDepartments() {
    wx.navigateTo({ url: '/pages/departments/index' });
  },
  openLostFound() {
    wx.navigateTo({ url: '/pages/lost-found/index' });
  },
  openTimetable() {
    wx.navigateTo({ url: '/pages/timetable/index' });
  },
  copySource() {
    wx.setClipboardData({
      data: school.sourceUrl,
      success: () => wx.showToast({ title: '官网链接已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }),
    });
  },
});
