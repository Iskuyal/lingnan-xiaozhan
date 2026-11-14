/**
 * 校历与考试（Issue #91；岭南红 UI 第二轮 C 分支按设计稿 25 重做）。
 *
 * 页面只做三件事：把 `services/calendar` 算好的行渲染出来、把「为什么没有日期」说清楚、
 * 把官方原文链接复制给学生核对。不抓取、不推断、不沿用往年。
 *
 * 数据诚实性（本页最容易被审的地方）：
 * - 有日期的 5 条只来自 `events.ts` 里已核对的官方公告，页面不改写、不补日期；
 * - 没有官方日期的事项用**文字 + 颜色**同时表达不确定：大字写「日期待公布 / 日期以本校为准 /
 *   暂无官方日期」，标签用中性色或警示色，并在卡片内写明为什么不给日期；
 * - 自检（`validateEvents`）不通过时页面显式提示，而不是静默照常显示。
 *
 * 测试注入：`onLoad({ today: 'YYYY-MM-DD' })` 固定「今天」，倒计时文案不随真实日期漂移。
 */
import {
  CalendarEventStatus,
  CalendarGroup,
  CalendarRow,
  DataProblem,
  VERIFIED_AT,
  groupEvents,
  dataSummary,
  validateEvents,
  CALENDAR_EVENTS,
} from '../../services/calendar/index';
import { noonOf } from '../../services/dates/index';
import { openUiTab } from '../../ui/navigation';

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

/** 状态色调：只是在文案之外再给一层视觉提示，文字本身已经说清楚。 */
export type ToolsCalendarTone = 'live' | 'warn' | 'plain';

/** 页面渲染用的行：服务层字段 + 三处只影响展示的派生文案。 */
export interface ToolsCalendarRow extends CalendarRow {
  /** 没有官方日期时的大字提示；有确定日期时为空字符串。 */
  dateHint: string;
  /** 为什么没有日期 / 这个状态怎么读；有确定日期且未结束时为空字符串。 */
  guard: string;
  tone: ToolsCalendarTone;
}

export interface ToolsCalendarGroup {
  category: CalendarGroup['category'];
  label: string;
  rows: ToolsCalendarRow[];
}

const TONE: Record<CalendarEventStatus, ToolsCalendarTone> = {
  published: 'live',
  pending: 'warn',
  'per-school': 'warn',
  ended: 'plain',
  'link-only': 'plain',
};

/** 没有日期时的大字：三类不确定语义分别说清，不用「待定」这类含糊词。 */
const DATE_HINT: Record<CalendarEventStatus, string> = {
  published: '',
  ended: '',
  pending: '日期待公布',
  'per-school': '日期以本校为准',
  'link-only': '暂无官方日期',
};

/** 状态说明：与 events.ts 的字段含义一一对应，不添加数据里没有的结论。 */
const GUARD: Record<CalendarEventStatus, string> = {
  published: '',
  ended: '',
  pending: '尚无可核实的官方日期；不沿用往年安排。',
  'per-school': '报名时间由各考点自行规定，本页不给全国统一截止日期。',
  'link-only': '这里只给官方入口，没有可核对的日期。',
};

function decorate(groups: CalendarGroup[]): ToolsCalendarGroup[] {
  return groups.map((group) => ({
    category: group.category,
    label: group.label,
    rows: group.rows.map((row) => ({
      ...row,
      dateHint: DATE_HINT[row.status],
      guard: GUARD[row.status],
      tone: TONE[row.status],
    })),
  }));
}

Page({
  data: {
    groups: [] as ToolsCalendarGroup[],
    summary: { published: 0, total: 0, verifiedAt: VERIFIED_AT } as Summary,
    problems: [] as DataProblem[],
    hasProblems: false,
  },
  /** 测试注入的「现在」；null 表示用真实时间。 */
  fixedNow: null as number | null,
  onLoad(query?: Query) {
    const today = query !== undefined && query !== null ? query.today : undefined;
    const noon = typeof today === 'string' ? noonOf(today) : null;
    if (noon !== null) this.fixedNow = noon;
    this.reload();
  },
  now(): number {
    return this.fixedNow === null ? Date.now() : this.fixedNow;
  },
  reload() {
    const problems = validateEvents(CALENDAR_EVENTS);
    this.setData({
      groups: decorate(groupEvents(CALENDAR_EVENTS, this.now())),
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
  /**
   * 回「今天」主入口。栈里还有上一页就直接返回（保留配图与滚动位置给上一页）；
   * 只剩本页时走公共导航切「今天」tab，让底栏高亮跟着变——reLaunch 到 tab 页虽然也能显示，
   * 但那不是 tab 切换语义。宿主没有 switchTab 时退回 reLaunch，两条路都不是死按钮。
   */
  goHome() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
      return;
    }
    openUiTab('today').catch(() => {
      wx.reLaunch({ url: '/pages/home/index' });
    });
  },
});
