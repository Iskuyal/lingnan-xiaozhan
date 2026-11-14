/**
 * 新建 / 编辑一条目标日（岭南红 UI 第二轮 · C 分支，设计稿 13 编辑态）。
 *
 * 只有三个字段由学生决定：事项名称、目标日期、是否计入当天。**不预填任何学校日期**：
 * 日期默认取今天（北京时间）只为省一次翻日历，学生自己改。
 *
 * 设计稿 13 里的「备注（选填）」**本轮未落地**：`GoalDay`（`services/goals`）没有备注字段，
 * 本机 `goal-days/v1` 的结构是冻结区，不能为了对齐一张设计图在存储里加一个没有消费方的假字段。
 * 所以这一栏不渲染、不采集、不写库；要真加，先改存储结构与读取方，再回来补 UI。
 *
 * 删除走系统确认弹窗（设计稿 54 的确认内容原样搬进弹窗文案），不新开一页：
 * 新页面要注册进 `app.json`，而 `app.json` 不属本任务可改范围；系统弹窗也保留了原生的误触保护。
 *
 * 保存与删除都直接写本机存储（`services/goals`），失败时弹窗说明原因并留在本页，
 * 不悄悄把改动丢掉。
 *
 * 测试注入：`onLoad({ today: 'YYYY-MM-DD' })` 固定「今天」，预览文案不随真实日期漂移。
 */
import { MAX_NAME_LENGTH, addGoal, findGoal, isValidDate, parseDate, removeGoal, shanghaiToday, statusOf, updateGoal } from '../../../services/goals/index';
import { openUiTab } from '../../../ui/navigation';

interface InputEvent {
  detail: { value: string };
}

interface Query {
  id?: string;
  today?: string;
}

interface ModalResult {
  confirm?: boolean;
}

interface FormState {
  name: string;
  date: string;
  countToday: boolean;
}

interface Preview {
  name: string;
  label: string;
  meta: string;
}

/** 固定今天的注入值取北京时间正午，避免落在当天边界上被时区推前或推后一天。 */
function noonOf(dateText: string): number | null {
  const parts = parseDate(dateText);
  if (parts === null) return null;
  return Date.UTC(parts.year, parts.month - 1, parts.day) - 8 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000;
}

/**
 * 可展示的失败原因：本模块抛的都是带中文说明的 Error。
 * 不用 `instanceof Error`——页面代码与构建产物可能来自不同的 realm，跨 realm 的 Error 判不出类型。
 */
function problemOf(error: unknown): string {
  if (error !== null && error !== undefined && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return error === null || error === undefined ? '未知错误' : String(error);
}

Page({
  data: {
    /** missing：带着一个已经被删掉的 id 进来，给一条说明和返回键，不显示表单。 */
    status: 'ready' as 'ready' | 'missing',
    mode: 'create' as 'create' | 'edit',
    title: '新建目标日',
    form: { name: '', date: '', countToday: false } as FormState,
    preview: { name: '', label: '', meta: '' } as Preview,
    nameLength: 0,
    maxName: MAX_NAME_LENGTH,
    todayText: '',
    saving: false,
  },
  fixedNow: null as number | null,
  goalId: '',
  onLoad(query: Query) {
    const noon = query !== null && typeof query.today === 'string' ? noonOf(query.today) : null;
    if (noon !== null) this.fixedNow = noon;
    const now = this.now();
    const id = query !== null && typeof query.id === 'string' ? query.id : '';
    if (id === '') {
      this.setData({
        mode: 'create',
        title: '新建目标日',
        form: { name: '', date: shanghaiToday(now), countToday: false },
        todayText: shanghaiToday(now),
      });
      this.setNavigationTitle('新建目标日');
      this.refreshPreview();
      return;
    }
    const goal = findGoal(id);
    if (goal === null) {
      this.setData({ status: 'missing' });
      return;
    }
    this.goalId = goal.id;
    this.setData({
      mode: 'edit',
      title: '编辑目标日',
      form: { name: goal.name, date: goal.date, countToday: goal.countToday },
      todayText: shanghaiToday(now),
    });
    this.setNavigationTitle('编辑目标日');
    this.refreshPreview();
  },
  /**
   * 导航栏标题跟着「新建 / 编辑」走（设计稿 13 的 nav-title 是「编辑目标日」）。
   * 运行时没有这个 API（例如单元测试的 wx 桩）就跳过，不能为了标题把页面打挂。
   */
  setNavigationTitle(title: string) {
    if (typeof wx.setNavigationBarTitle === 'function') wx.setNavigationBarTitle({ title });
  },
  now(): number {
    return this.fixedNow === null ? Date.now() : this.fixedNow;
  },
  onNameInput(event: InputEvent) {
    this.setData({ 'form.name': event.detail.value });
    this.refreshPreview();
  },
  onDateChange(event: InputEvent) {
    this.setData({ 'form.date': event.detail.value });
    this.refreshPreview();
  },
  onCountTodayChange() {
    this.setData({ 'form.countToday': this.data.form.countToday !== true });
    this.refreshPreview();
  },
  /** 预览：编辑期就显示这条目标日将来在列表里的文案，避免保存后再回来改。 */
  refreshPreview() {
    const form: FormState = this.data.form;
    const now = this.now();
    const name = form.name.trim() === '' ? '（还没填名称）' : form.name.trim();
    const date = isValidDate(form.date) ? form.date : '';
    let preview: Preview;
    if (date === '') {
      preview = { name, label: '日期还没选', meta: '选一个日期后，这里显示剩余天数' };
    } else {
      const status = statusOf({ date, countToday: form.countToday }, now);
      const toggleText = status.kind === 'today' ? '' : form.countToday ? ' · 计入当天' : ' · 不计入当天';
      preview = {
        name,
        label: status.label,
        meta: `${date}${toggleText} · 今天（北京时间）${shanghaiToday(now)}`,
      };
    }
    this.setData({ preview, nameLength: form.name.trim().length });
  },
  save() {
    if (this.data.saving) return;
    const form: FormState = this.data.form;
    const input = { name: form.name.trim(), date: form.date, countToday: form.countToday === true };
    this.setData({ saving: true });
    let saved = false;
    try {
      if (this.data.mode === 'edit') updateGoal(this.goalId, input);
      else addGoal(input);
      saved = true;
    } catch (error) {
      wx.showModal({ title: '保存失败', content: problemOf(error), showCancel: false });
    }
    if (!saved) {
      this.setData({ saving: false });
      return;
    }
    wx.showToast({ title: this.data.mode === 'edit' ? '已保存' : '已添加', icon: 'success' });
    setTimeout(() => this.goBack(), 400);
  },
  remove() {
    if (this.data.mode !== 'edit') return;
    const form: FormState = this.data.form;
    wx.showModal({
      title: '删除这个目标日？',
      content: `删除后无法恢复，目标日只存在本机。\n${form.name} · ${form.date}\n已保存的学习计划保留原快照，并提示目标已删除。`,
      confirmText: '删除',
      success: (result: ModalResult) => {
        if (result.confirm !== true) return;
        try {
          removeGoal(this.goalId);
          wx.showToast({ title: '已删除', icon: 'success' });
        } catch (error) {
          wx.showModal({ title: '删除失败', content: problemOf(error), showCancel: false });
          return;
        }
        setTimeout(() => this.goBack(), 400);
      },
    });
  },
  /**
   * 返回：栈里有上一页就退回去；只剩本页时（从分享或重开直接落在编辑页）切到「今天」tab，
   * 切不过去再退到目标日列表——两条路都比停在一个空栈页面上强。
   */
  goBack() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
      return;
    }
    openUiTab('today').catch(() => {
      wx.reLaunch({ url: '/pages/goals/index' });
    });
  },
});
