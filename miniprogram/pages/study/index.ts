import { loadGoals, nearestGoal } from '../../services/goals/index';
import { loadPlan } from '../../services/goals/plan';

/**
 * 学习聚合页（设计图 11）：最近的目标日与本周计划在上，四个学习工具在下。
 *
 * 这里只做「读 + 跳转」：目标日与计划的增删改在既有页面，排程规则在 services/goals，
 * 聚合页不复制任何一套业务逻辑，也不写自己的存储 key。
 */
interface GoalHero {
  hasGoal: boolean;
  name: string;
  dateText: string;
  days: string;
  unit: string;
  footNote: string;
}

interface PlanLine {
  hasPlan: boolean;
  meta: string;
}

interface TapEvent {
  currentTarget: { dataset: { route?: string } };
}

const EMPTY_HERO: GoalHero = {
  hasGoal: false,
  name: '先写一个目标日',
  dateText: '',
  days: '',
  unit: '',
  footNote: '去添加目标日',
};

/** '2026-12-19' → '12月19日'；形态不对就原样退回，不编日期。 */
function dateTextOf(date: string): string {
  const parts = date.split('-');
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isInteger(month) || !Number.isInteger(day)) return date;
  return `${month}月${day}日`;
}

Page({
  data: {
    hero: { ...EMPTY_HERO } as GoalHero,
    plan: { hasPlan: false, meta: '' } as PlanLine,
  },
  /** 目标日与计划都在本机，每次显示都重算：从目标日页返回就能看到天数变化。 */
  onShow() {
    this.loadGoal();
    this.loadPlanLine();
  },
  loadGoal() {
    const row = nearestGoal(loadGoals());
    if (row === null) {
      this.setData({ hero: { ...EMPTY_HERO } });
      return;
    }
    this.setData({
      hero: {
        hasGoal: true,
        name: row.name,
        dateText: dateTextOf(row.date),
        days: row.kind === 'today' ? '今天' : String(row.days),
        unit: row.kind === 'today' ? '' : '天后',
        footNote: '继续查看本周计划',
      },
    });
  },
  loadPlanLine() {
    const plan = loadPlan();
    if (plan === null) {
      this.setData({ plan: { hasPlan: false, meta: '' } });
      return;
    }
    this.setData({
      plan: { hasPlan: true, meta: `本周 ${plan.blocks.length} 段安排` },
    });
  },
  /** 红色卡片：有目标日就进目标日页（那里才有计划入口），没有就给添加。 */
  openGoals() {
    wx.navigateTo({ url: '/pages/goals/index' });
  },
  openPlan() {
    wx.navigateTo({ url: '/pages/goals/plan/index' });
  },
  openHero() {
    if (this.data.plan.hasPlan) this.openPlan();
    else this.openGoals();
  },
  /** 工具条目只做既有页面的跳转，不在这里另造一套计划或排程逻辑。 */
  openTool(event: TapEvent) {
    const route = event.currentTarget.dataset.route;
    if (typeof route !== 'string' || route === '') return;
    wx.navigateTo({ url: route });
  },
});
