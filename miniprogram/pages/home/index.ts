import { school } from '../../services/school';
import { listNews, formatSyncTime, messageOf, RECENT_LIMIT, SOURCE_LABEL } from '../../services/news/index';
import { NewsListItem, NewsSourceMeta } from '../../services/news/types';
import { loadGoals, nearestGoal } from '../../services/goals/index';
import { shanghaiToday } from '../../services/dates/index';
import { Course } from '../../services/timetable/types';
import { TimetableSettings, emptySettings, loadSettings } from '../../services/timetable/settings';
import { listCourses } from '../../services/timetable/index';
import { TodayBrief, buildTodayBrief } from '../../services/timetable/brief';
import { openTimetable } from '../../ui/navigation';

/** 只声明页面用到的事件字段，避免依赖 typings 内部结构。 */
interface TapEvent {
  currentTarget: { dataset: { id?: string; text?: string } };
}

interface InputEvent {
  detail: { value: string };
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

const EMPTY_GOAL_STRIP: GoalStrip = {
  hasGoal: false,
  name: '还没有目标日',
  meta: '自己写一个日期，剩下多少天替你数',
  value: '去添加',
  unit: '',
};

/** 课表读不到时的简报：不给假的「今天没课」，说清是没读到。 */
function emptyBrief(settings: TimetableSettings, today: string, clockMinutes: number): TodayBrief {
  return {
    ...buildTodayBrief({ courses: [], settings, today, clockMinutes, goals: [] }),
    headline: '正在读取今日课表',
    sentences: ['读取完成后显示今天的课程与空闲时段。'],
    emptyMessage: '正在读取，请稍候。',
  };
}

/** 现在几点几分（设备本地时间，与课表页 localMinutes 同口径）。 */
function localClockMinutes(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

/** 发送给助手的问题：去掉首尾空白并截断，避免把超长粘贴塞进 URL。 */
const ASK_MAX_CHARS = 500;

Page({
  data: {
    school,
    brief: emptyBrief(emptySettings(), '2026-01-01', 0),
    askText: '',
    recentNews: [] as NewsListItem[],
    newsMeta: { label: SOURCE_LABEL, syncedAt: '', fromServer: true } as NewsSourceMeta,
    newsSyncedAtText: '',
    newsStatus: 'loading' as NewsStatus,
    newsError: '',
    goalStrip: { ...EMPTY_GOAL_STRIP } as GoalStrip,
  },
  /** 测试可注入固定时刻，避免「今天」随真实时钟漂移。 */
  fixedToday: '',
  fixedClock: -1,
  onLoad(query: { today?: string; clock?: string } = {}) {
    this.fixedToday = typeof query.today === 'string' ? query.today : '';
    const clock = Number(query.clock);
    this.fixedClock = typeof query.clock === 'string' && Number.isFinite(clock) ? clock : -1;
    this.loadRecentNews();
    return this.loadToday();
  },
  /**
   * 目标日与课表都存在本机/云端、随时会变，所以每次显示都重算简报：
   * 从目标日页返回就能看到倒计时更新，不用手动刷新。
   */
  onShow() {
    this.loadGoalStrip();
    return this.loadToday();
  },
  todayText(): string {
    return this.fixedToday !== '' ? this.fixedToday : shanghaiToday();
  },
  clockMinutes(): number {
    return this.fixedClock >= 0 ? this.fixedClock : localClockMinutes();
  },
  /**
   * 今日简报：课表读不到时降级成「只有目标日与日期」的版本，
   * 不把失败说成「今天没课」——没读到和没有是两件事。
   */
  loadToday() {
    const today = this.todayText();
    const clock = this.clockMinutes();
    return loadSettings()
      .then((settings) => listCourses().then((feed) => ({ settings, courses: feed.courses })))
      .then(({ settings, courses }) => {
        this.setData({
          brief: buildTodayBrief({ courses, settings, today, clockMinutes: clock, goals: loadGoals() }),
        });
      })
      .catch(() => {
        const fallback = buildTodayBrief({ courses: [], settings: emptySettings(), today, clockMinutes: clock, goals: loadGoals() });
        this.setData({ brief: {
          ...fallback,
          headline: '今日课表暂时没读到',
          sentences: ['暂时无法确认今天有哪些课，稍后返回首页会重新读取。', ...fallback.sentences.filter((line) => line.includes('距「') || line.includes('今天就是「'))],
          emptyMessage: '请检查网络，或进入我的课表重新读取。',
        } });
      });
  },
  loadGoalStrip() {
    const row = nearestGoal(loadGoals());
    if (row === null) {
      this.setData({ goalStrip: { ...EMPTY_GOAL_STRIP } });
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
  onAskInput(event: InputEvent) {
    this.setData({ askText: event.detail.value });
  },
  /** 建议 chip 只填进输入框，不直接发送：学生还能改几个字再发。 */
  useSuggestion(event: TapEvent) {
    const text = event.currentTarget.dataset.text;
    if (typeof text !== 'string' || text === '') return;
    this.setData({ askText: text });
  },
  /**
   * 把问题带到课表页的助手输入框。
   * 首页不自己发请求：助手要显示上下文、失败状态与安全说明，这些都在课表页已有实现里，
   * 首页复制一套会分裂成两份口径。课表现在是 tab，switchTab 不接受 query，
   * 所以文字通过 `ui/navigation` 的一次性意图交过去，**不自动发送**。
   */
  sendAsk() {
    const text = this.data.askText.trim().slice(0, ASK_MAX_CHARS);
    if (text === '') {
      wx.showToast({ title: '先写一句想问的', icon: 'none' });
      return;
    }
    return openTimetable({ kind: 'assistant', text }).catch(() => {
      wx.showToast({ title: '课表页暂时打不开，稍后再试', icon: 'none' });
    });
  },
  /** 拍照提问走课表导入页既有的截图识别（vision），不在首页另开一条上传链路。 */
  openPhotoAsk() {
    wx.navigateTo({ url: '/pages/timetable/import/index' });
  },
  /** 语音输入还没接入：如实说明，不做录音转写的假象。 */
  openVoiceAsk() {
    wx.showToast({ title: '语音输入暂未接入，先打字或拍照吧', icon: 'none' });
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
  /** 课表是 tab 页：只能用 switchTab 打开，navigateTo 会被基础库拒绝。 */
  openTimetable() {
    return openTimetable().catch(() => {
      wx.showToast({ title: '课表页暂时打不开，稍后再试', icon: 'none' });
    });
  },
  openAdvancement() {
    wx.navigateTo({ url: '/pages/advancement/index' });
  },
  openDefense() {
    wx.navigateTo({ url: '/pages/defense/index' });
  },
  copySource() {
    wx.setClipboardData({
      data: school.sourceUrl,
      success: () => wx.showToast({ title: '官网链接已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }),
    });
  },
});