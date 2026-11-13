import { loadGoals, nearestGoal } from '../../services/goals/index';

/** 学习聚合页（设计图 11）：目标日一眼可见，四个学习工具指向既有页面。 */
interface GoalStrip {
  hasGoal: boolean;
  name: string;
  meta: string;
  days: string;
  unit: string;
}

const EMPTY_GOAL: GoalStrip = {
  hasGoal: false,
  name: '还没有目标日',
  meta: '自己写一个日期，剩下多少天替你数',
  days: '',
  unit: '',
};

interface TapEvent {
  currentTarget: { dataset: { route?: string } };
}

Page({
  data: {
    goal: { ...EMPTY_GOAL } as GoalStrip,
  },
  /** 目标日存在本机，每次显示都重算：从目标日页返回就能看到天数变化。 */
  onShow() {
    this.loadGoal();
  },
  loadGoal() {
    const row = nearestGoal(loadGoals());
    if (row === null) {
      this.setData({ goal: { ...EMPTY_GOAL } });
      return;
    }
    this.setData({
      goal: {
        hasGoal: true,
        name: row.name,
        meta: row.meta,
        days: row.kind === 'today' ? '今天' : String(row.days),
        unit: row.kind === 'today' ? '' : '天后',
      },
    });
  },
  openGoals() {
    wx.navigateTo({ url: '/pages/goals/index' });
  },
  /** 工具条目只做既有的页面跳转，不在这里另造一套计划或排程逻辑。 */
  openTool(event: TapEvent) {
    const route = event.currentTarget.dataset.route;
    if (typeof route !== 'string' || route === '') return;
    wx.navigateTo({ url: route });
  },
});
