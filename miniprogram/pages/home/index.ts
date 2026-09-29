import { school } from '../../services/school';
import { listNews, formatSyncTime, messageOf, RECENT_LIMIT, SOURCE_LABEL } from '../../services/news/index';
import { NewsListItem, NewsSourceMeta } from '../../services/news/types';
import { loadGoals, nearestGoal } from '../../services/goals/index';

/** 只声明页面用到的事件字段，避免依赖 typings 内部结构。 */
interface TapEvent {
  currentTarget: { dataset: { id?: string } };
}

/** 最近资讯只有加载中、有数据、读取失败三态；完整列表的空态与分页在资讯页处理。 */
type NewsStatus = 'loading' | 'ready' | 'error';

/**
 * 首页的目标日入口带：只显示最近一条（今天优先，其次最近的未到期）。
 * 没有可展示的目标日时给出「去添加」，不拿已过期的事当「最近的安排」。
 */
interface GoalStrip {
  hasGoal: boolean;
  name: string;
  meta: string;
  value: string;
  unit: string;
}

Page({
  data: {
    school,
    recentNews: [] as NewsListItem[],
    newsMeta: { label: SOURCE_LABEL, syncedAt: '', fromServer: true } as NewsSourceMeta,
    newsSyncedAtText: '',
    newsStatus: 'loading' as NewsStatus,
    newsError: '',
    goalStrip: { hasGoal: false, name: '还没有目标日', meta: '自己写一个日期，剩下多少天替你数', value: '去添加', unit: '' } as GoalStrip,
  },
  onLoad() {
    return this.loadRecentNews();
  },
  /** 目标日存在本机、随时会变，所以在 onShow 重新读，从目标日页返回就能看到最新一条。 */
  onShow() {
    this.loadGoalStrip();
  },
  loadGoalStrip() {
    const row = nearestGoal(loadGoals());
    if (row === null) {
      this.setData({ goalStrip: { hasGoal: false, name: '还没有目标日', meta: '自己写一个日期，剩下多少天替你数', value: '去添加', unit: '' } });
      return;
    }
    this.setData({
      goalStrip: {
        hasGoal: true,
        name: row.name,
        meta: row.meta,
        value: row.kind === 'today' ? row.label : String(row.days),
        unit: row.kind === 'today' ? '' : '天后',
      },
    });
  },
  openGoals() {
    wx.navigateTo({ url: '/pages/goals/index' });
  },
  openCalendar() {
    wx.navigateTo({ url: '/pages/calendar/index' });
  },
  openFitness() {
    wx.navigateTo({ url: '/pages/fitness/index' });
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
