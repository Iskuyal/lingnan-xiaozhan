/**
 * 校历与考试日期卡（Issue #91）。
 *
 * 页面只做两件事：把 `services/calendar` 算好的行渲染出来，以及把原文链接复制给学生核对。
 * 不抓取、不推断：没有官方日期的事项显示「待公布 / 仅官方入口 / 以本校通知为准」，并给官方入口。
 *
 * 数据自检（`validateEvents`）不通过时**页面显式提示**而不是静默照常显示——宁可看起来丑，
 * 也不能把没有来源的日期当成可追溯的日期。
 *
 * 测试注入：`onLoad({ today: 'YYYY-MM-DD' })` 固定「今天」，倒计时文案不随真实日期漂移。
 */
import { CalendarGroup, DataProblem, VERIFIED_AT, groupEvents, dataSummary, validateEvents, CALENDAR_EVENTS } from '../../services/calendar/index';
import { noonOf } from '../../services/dates/index';

interface TapEvent {
  currentTarget: { dataset: { url?: string; id?: string } };
}

interface Query {
  today?: string;
}

interface Summary {
  published: number;
  total: number;
  verifiedAt: string;
}

Page({
  data: {
    groups: [] as CalendarGroup[],
    summary: { published: 0, total: 0, verifiedAt: VERIFIED_AT } as Summary,
    problems: [] as DataProblem[],
    hasProblems: false,
  },
  /** 测试注入的「现在」；null 表示用真实时间。 */
  fixedNow: null as number | null,
  onLoad(query: Query) {
    const noon = query !== null && typeof query.today === 'string' ? noonOf(query.today) : null;
    if (noon !== null) this.fixedNow = noon;
    this.reload();
  },
  now(): number {
    return this.fixedNow === null ? Date.now() : this.fixedNow;
  },
  reload() {
    const problems = validateEvents(CALENDAR_EVENTS);
    this.setData({
      groups: groupEvents(CALENDAR_EVENTS, this.now()),
      summary: dataSummary(CALENDAR_EVENTS),
      problems,
      hasProblems: problems.length > 0,
    });
  },
  /** 复制官方原文链接：与首页「复制官网链接」同一套反馈文案。 */
  onCopySource(event: TapEvent) {
    const url = event.currentTarget.dataset.url;
    if (url === undefined || url === '') return;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '原文链接已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }),
    });
  },
  goHome() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/home/index' });
  },
});
