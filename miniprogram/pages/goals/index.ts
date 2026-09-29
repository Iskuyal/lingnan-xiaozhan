/**
 * 目标日列表：学生自己填的日期，按未到期 / 今天 / 已过期分组。
 *
 * 数据只有一个来源：本机存储（`services/goals`）。**页面不自己算天数**，
 * 只把 `groupGoals` 的结果渲染出来，所以「今天」的判定与测试里钉住的口径完全一致，
 * 也不存在「页面算一次、服务算一次」两套结果。
 *
 * 测试注入：`onLoad({ today: 'YYYY-MM-DD' })` 固定「今天」，列表文案不随真实日期漂移；
 * 真机不传这个参数，用本机当前时间。
 */
import { GoalGroups, GoalRow, groupGoals, loadGoals, parseDate, removeGoal, shanghaiToday } from '../../services/goals/index';

interface TapEvent {
  currentTarget: { dataset: { id?: string } };
}

interface Query {
  today?: string;
}

interface ModalResult {
  confirm?: boolean;
}

/** 空分组：模板里直接读 `groups.upcoming`，不用每处判空。 */
const EMPTY_GROUPS: GoalGroups = { upcoming: [], today: [], expired: [] };

/** 删除失败的提示：本模块抛的都是带中文说明的 Error，跨 realm 时 `instanceof` 不可靠。 */
function problemOf(error: unknown): string {
  if (error !== null && error !== undefined && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return '删除失败';
}

/** 固定今天的注入值取北京时间正午，避免落在当天边界上被时区推前或推后一天。 */
function noonOf(dateText: string): number | null {
  const parts = parseDate(dateText);
  if (parts === null) return null;
  return Date.UTC(parts.year, parts.month - 1, parts.day) - 8 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000;
}

Page({
  data: {
    hasGoals: false,
    groups: EMPTY_GROUPS,
    upcomingCount: 0,
    todayCount: 0,
    expiredCount: 0,
    todayText: '',
  },
  /** 测试注入的「现在」；null 表示用真实时间。 */
  fixedNow: null as number | null,
  onLoad(query: Query) {
    const noon = query !== null && typeof query.today === 'string' ? noonOf(query.today) : null;
    if (noon !== null) this.fixedNow = noon;
    this.reload();
  },
  /** 从编辑页返回时要立刻看到结果，所以刷新放在 onShow 而不是 onLoad。 */
  onShow() {
    this.reload();
  },
  now(): number {
    return this.fixedNow === null ? Date.now() : this.fixedNow;
  },
  reload() {
    const now = this.now();
    const groups = groupGoals(loadGoals(), now);
    this.setData({
      groups,
      hasGoals: groups.upcoming.length + groups.today.length + groups.expired.length > 0,
      upcomingCount: groups.upcoming.length,
      todayCount: groups.today.length,
      expiredCount: groups.expired.length,
      todayText: shanghaiToday(now),
    });
  },
  onCreate() {
    wx.navigateTo({ url: '/pages/goals/edit/index' });
  },
  onEdit(event: TapEvent) {
    const id = event.currentTarget.dataset.id;
    if (id === undefined || id === '') return;
    wx.navigateTo({ url: `/pages/goals/edit/index?id=${encodeURIComponent(id)}` });
  },
  /** 删除要确认：本机数据删掉就没有第二份，误删无法恢复。 */
  onDelete(event: TapEvent) {
    const id = event.currentTarget.dataset.id;
    if (id === undefined || id === '') return;
    const goal = this.rowOf(id);
    if (goal === null) {
      wx.showToast({ title: '这条目标日已经不在了', icon: 'none' });
      this.reload();
      return;
    }
    wx.showModal({
      title: '删除这个目标日？',
      content: `删除后无法恢复，目标日只存在本机。\n${goal.name} · ${goal.date}`,
      confirmText: '删除',
      success: (result: ModalResult) => {
        if (result.confirm !== true) return;
        try {
          removeGoal(id);
          wx.showToast({ title: '已删除', icon: 'success' });
        } catch (error) {
          wx.showToast({ title: problemOf(error), icon: 'none' });
        }
        this.reload();
      },
    });
  },
  /** 在已算好的分组里找一条，不再读一次存储。 */
  rowOf(id: string): GoalRow | null {
    const groups: GoalGroups = this.data.groups;
    for (const row of [...groups.upcoming, ...groups.today, ...groups.expired]) {
      if (row.id === id) return row;
    }
    return null;
  },
  goHome() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/home/index' });
  },
});
