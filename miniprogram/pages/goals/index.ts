/**
 * 目标日列表（岭南红 UI 第二轮 · C 分支，设计稿 12 常规态 / 55 空态）。
 *
 * 数据只有一个来源：本机存储（`services/goals`）。**页面不自己算天数**，
 * 只把 `groupGoals` 的结果渲染出来，所以「今天」的判定与测试里钉住的口径完全一致，
 * 也不存在「页面算一次、服务算一次」两套结果。
 *
 * 设计稿 12 把最近一个目标提升成主卡：今天优先、其次最近的未到期；
 * 三组列表仍然完整保留（未到期 / 今天 / 已过期），已过期只给修改与删除，不给排计划。
 *
 * 设计稿 12 的第二块是「已保存的计划」：这里只**读**本机快照（`services/goals/plan` 的
 * `loadPlan`），不做任何写入，也不像计划页那样在线核对课表——那样会把两个页面的口径拉成两套。
 * 快照与目标日不一致时如实提示「保留保存时的安排」，不自动改写、不自动删除。
 *
 * 测试注入：`onLoad({ today: 'YYYY-MM-DD' })` 固定「今天」，列表文案不随真实日期漂移；
 * 真机不传这个参数，用本机当前时间。
 */
import { GoalDay, GoalGroups, GoalRow, groupGoals, loadGoals, parseDate, removeGoal, shanghaiToday } from '../../services/goals/index';
import { loadPlan } from '../../services/goals/plan';
import { openUiTab } from '../../ui/navigation';

interface TapEvent {
  currentTarget: { dataset: { id?: string } };
}

interface Query {
  today?: string;
}

interface ModalResult {
  confirm?: boolean;
}

/** 主卡上的一行：条本体 + 设计稿要的「12 月 19 日」短日期。 */
interface FeatureRow extends GoalRow {
  dateText: string;
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

/** 「2026-12-19」→「12 月 19 日」。只用于展示；日期本身仍是服务层给的 'YYYY-MM-DD'。 */
function monthDayOf(dateText: string): string {
  const parts = parseDate(dateText);
  if (parts === null) return dateText;
  return `${parts.month} 月 ${parts.day} 日`;
}

/** 计划快照的标题：写清是哪个目标哪一周，避免两条计划看起来一模一样。 */
function planTitleOf(goalName: string, weekLabel: string): string {
  const name = goalName.trim() === '' ? '目标日' : goalName.trim();
  return `${name} · ${weekLabel}计划`;
}

Page({
  data: {
    hasGoals: false,
    groups: EMPTY_GROUPS,
    upcomingCount: 0,
    todayCount: 0,
    expiredCount: 0,
    todayText: '',
    /** 主卡：今天优先，其次最近的未到期；只有已过期时为 null。 */
    feature: null as FeatureRow | null,
    /** 本机是否已有保存的计划快照；有才显示那张白卡（设计稿 12 的第二块）。 */
    hasSavedPlan: false,
    savedTitle: '',
    savedMeta: '',
    savedStale: false,
    savedStaleNote: '',
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
    const goals = loadGoals();
    const groups = groupGoals(goals, now);
    const nearest = groups.today.length > 0 ? groups.today[0] : groups.upcoming.length > 0 ? groups.upcoming[0] : null;
    const feature: FeatureRow | null = nearest === null ? null : { ...nearest, dateText: monthDayOf(nearest.date) };
    const saved = this.savedViewOf(goals);
    const hasGoals = groups.upcoming.length + groups.today.length + groups.expired.length > 0;
    this.setData({
      groups,
      hasGoals,
      upcomingCount: groups.upcoming.length,
      todayCount: groups.today.length,
      expiredCount: groups.expired.length,
      todayText: shanghaiToday(now),
      feature,
      ...saved,
    });
    // 设计稿 12 的 nav-title 是「目标日」，55 空态是「我的目标日」：同一条路由两种状态两个标题，
    // 只能运行时设置。没有这个 API 的环境（单元测试的 wx 桩）跳过，不影响页面。
    this.setNavigationTitle(hasGoals ? '目标日' : '我的目标日');
  },
  setNavigationTitle(title: string) {
    if (typeof wx.setNavigationBarTitle === 'function') wx.setNavigationBarTitle({ title });
  },
  /**
   * 只读本机计划快照。读失败、没有计划都当成「没有这张卡」，
   * 不能因为一张可选的白卡把目标日列表整页搞坏。
   */
  savedViewOf(goals: GoalDay[]) {
    let plan = null as ReturnType<typeof loadPlan>;
    try {
      plan = loadPlan();
    } catch (error) {
      console.error('读取本机计划快照失败，目标日列表按没有计划渲染：', error);
      plan = null;
    }
    if (plan === null) {
      return { hasSavedPlan: false, savedTitle: '', savedMeta: '', savedStale: false, savedStaleNote: '' };
    }
    const matched = plan.goalId !== ''
      ? goals.filter((goal) => goal.id === plan.goalId)
      : goals.filter((goal) => goal.name === plan.goalName && goal.date === plan.goalDate);
    const current = matched.length === 1 ? matched[0] : null;
    const changed = current !== null && (current.date !== plan.goalDate || current.name !== plan.goalName);
    return {
      hasSavedPlan: true,
      savedTitle: planTitleOf(plan.goalName, plan.weekLabel),
      savedMeta: `${plan.today} 生成 · ${plan.blocks.length} 段 / ${plan.totalMinutes} 分钟`,
      savedStale: current === null || changed,
      savedStaleNote: current === null
        ? '原目标日已删除，这份计划保留保存时的安排，不会自动改写。'
        : changed ? '目标日已被修改，这份计划保留保存时的安排，重新打开后可核对。' : '',
    };
  },
  onCreate() {
    wx.navigateTo({ url: '/pages/goals/edit/index' });
  },
  onEdit(event: TapEvent) {
    const id = event.currentTarget.dataset.id;
    if (id === undefined || id === '') return;
    wx.navigateTo({ url: `/pages/goals/edit/index?id=${encodeURIComponent(id)}` });
  },
  /**
   * 从目标日进「学习计划」：目标日已经有日期与名称，计划页拿到 id 就能直接倒排，
   * 不用再让人挑一次。
   */
  onPlan(event: TapEvent) {
    const id = event.currentTarget.dataset.id;
    if (id === undefined || id === '') return;
    wx.navigateTo({ url: `/pages/goals/plan/index?id=${encodeURIComponent(id)}` });
  },
  /** 空态与主卡上的「历史计划」入口：计划页自己决定展示快照还是引导新建。 */
  onViewSaved() {
    wx.navigateTo({ url: '/pages/goals/plan/index' });
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
  /**
   * 回「今天」主入口。目标日页是普通页面（从学习页进），栈里还有上一页时直接返回；
   * 只剩本页（例如从分享或重开回到这一页）时切到「今天」这个 tab。
   * switchTab 在个别环境不可用，失败时给一句可读提示，不留一个静默的按钮。
   */
  goHome() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
      return;
    }
    openUiTab('today').catch(() => {
      wx.showToast({ title: '暂时无法回到今天', icon: 'none' });
    });
  },
});
