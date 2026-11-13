/**
 * 备考计划页：选目标日 → 说约束 → 规则排入本周空闲格 → 保存到本机。
 *
 * 三条边界写死在这里，改代码前先看：
 * 1. AI只解释约束，用户确认后仍由纯排程器检查；规则模式不请求模型。
 * 2. **课表从云端读、计划只写本机**。「加入课表（作为计划）」= `savePlan`，不往云端课表写任何记录
 *    ——云函数的 `source` 只认 excel/manual/photo，写一条「计划课」会污染学生的真实课表。
 * 3. **排不下就说排不下**。空档不够时 `plan.blocks` 是空的，页面照实显示原因，不硬塞。
 *
 * 测试注入：`onLoad({ today })` 固定「今天」；`courses` / `settings` 这两个实例字段由
 * `loadTimetable` 填写，测试直接赋值就能不连云端把整页跑通（见 tests/goals-plan.test.cjs）。
 */
import {
  GoalDay,
  GoalRow,
  findGoal,
  groupGoals,
  loadGoals,
  statusOf,
} from '../../../services/goals/index';
import {
  DEFAULT_SECTION_MINUTES,
  PlanConstraints,
  ConstraintReadout,
  PlanEvidence,
  StudyPlan,
  blockDescribe,
  buildPlan,
  hoursLabel,
  loadPlan,
  planGrid,
  readConstraints,
  removePlan,
  savePlan,
} from '../../../services/goals/plan';
import { Course } from '../../../services/timetable/types';
import { TimetableSettings, emptySettings, loadSettings } from '../../../services/timetable/settings';
import { listCourses } from '../../../services/timetable/index';
import { shanghaiToday, parseDate } from '../../../services/dates/index';
import { SavedPlanRow, savedPlanView } from '../../../services/goals/saved';
import { AiConstraintDraft, requestPlanIntent } from '../../../services/goals/intent';

/** 行标：与 `services/goals/plan` 的 GRID_PAIR_LABELS 同一套节次对，模板按行取用。 */
const GRID_ROW_LABELS = ['1–2', '3–4', '5–6', '7–8', '9–10', '11–12'];
const STEP_TEXTS = ['① 选目标', '② 说情况', '③ 看计划', '④ 保存'];

interface InputEvent {
  detail: { value: string };
}

interface TapEvent {
  currentTarget: { dataset: { id?: string } };
}

interface Query {
  id?: string;
  today?: string;
}

interface StepView {
  text: string;
  /** on = 当前这步；done = 已经做完；空 = 还没到。 */
  state: 'on' | 'done' | '';
}

interface GridCellView {
  kind: 'busy' | 'busy2' | 'free' | 'plan';
  label: string;
  /** 内联定位：WXSS 写不出「按数据算第几行第几列」，由页面算好交给模板。 */
  style: string;
}

interface GridRowView {
  label: string;
  labelStyle: string;
  cells: GridCellView[];
}

/** 「今天」的注入值取北京时间正午，避免落在日界线上被时区推前或推后一天。 */
function noonOf(dateText: string): number | null {
  const parts = parseDate(dateText);
  if (parts === null) return null;
  return Date.UTC(parts.year, parts.month - 1, parts.day) - 8 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000;
}

/**
 * 可展示的失败原因：本模块抛的都是带中文说明的 Error。
 * 不用 `instanceof Error`——页面代码与构建产物可能来自不同 realm。
 */
function problemOf(error: unknown): string {
  if (error !== null && error !== undefined && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return error === null || error === undefined ? '未知错误' : String(error);
}

/** 「12 月 13 日」：顶部一句话要读得出是哪天，不是 ISO 串。 */
function monthDayText(dateText: string): string {
  const parts = parseDate(dateText);
  if (parts === null) return dateText;
  return `${parts.month} 月 ${parts.day} 日`;
}

/**
 * 把 `planGrid` 的二维数据摊成模板能直接渲染的行。
 *
 * 合并格（跨节次的课）用内联 `grid-row:span N`；被它盖住的下一行里那一格 `rowSpan` 为 0，
 * 这里直接丢掉不渲染——留着会挤掉后面的列。
 */
function toGridRows(
  grid: { kind: 'busy' | 'busy2' | 'free' | 'plan'; label: string; rowSpan: number }[][],
): GridRowView[] {
  const rows: GridRowView[] = [];
  grid.forEach((cells, rowIndex) => {
    const rowNumber = rowIndex + 2; // 第 1 行是「一 二 三 四 五」表头
    rows.push({
      label: GRID_ROW_LABELS[rowIndex] ?? '',
      labelStyle: `grid-column:1;grid-row:${rowNumber}/${rowNumber + 1}`,
      cells: cells
        .map((cell, cellIndex) => ({ cell, column: cellIndex + 2 }))
        .filter((item) => item.cell.rowSpan > 0)
        .map(({ cell, column }) => ({
          kind: cell.kind,
          label: cell.label,
          style: `grid-column:${column};grid-row:${rowNumber}/span ${cell.rowSpan}`,
        })),
    });
  });
  return rows;
}

/** 目标日列表的一行：`GoalDay` 加算好的「还有 N 天」，页面直接显示。未到期在前，过期的排最后。 */
function goalRows(goals: GoalDay[], now: number): GoalRow[] {
  const groups = groupGoals(goals, now);
  return groups.upcoming.concat(groups.today).concat(groups.expired);
}

Page({
  data: {
    /** loading：正在读课表；pick：还没选目标；ready：可以排计划；missing：带进来的目标日已经不在了。 */
    status: 'loading' as 'loading' | 'pick' | 'ready' | 'missing',
    eyebrow: '备考计划',
    headline: '先选一个目标日，再说一句自己的情况',
    steps: STEP_TEXTS.map((text, index) => ({ text, state: index === 0 ? 'on' : '' })) as StepView[],
    goals: [] as GoalRow[],
    goalId: '',
    goalName: '',
    goalDate: '',
    plan: null as StudyPlan | null,
    constraintText: '',
    weekTitle: '',
    hoursText: '',
    gridRows: [] as GridRowView[],
    gridWeekdays: ['一', '二', '三', '四', '五'],
    /** 落在周六、周日的段画不进 5 列网格，单独列一行，不让它凭空消失。 */
    weekendLines: [] as string[],
    rationale: [] as string[],
    constraintLines: [] as string[],
    dropped: [] as string[],
    /** 约束回显的小字：哪几条按默认、哪几条没听懂。 */
    defaultNote: '',
    /** 本机已经存过的计划（只有一份）：给「撤回」用，不进云端。 */
    hasSaved: false,
    savedView: false,
    savedRows: [] as SavedPlanRow[],
    savedRange: '',
    savedSummary: '',
    savedNotice: '',
    savedGoalMissing: false,
    savedTargetWeek: null as number | null,
    savedNote: '',
    busy: false,
    aiBusy: false,
    aiDraftReady: false,
    aiDefaults: [] as string[],
    aiEvidence: [] as (PlanEvidence & { key: number })[],
    aiMessage: '',
    error: '',
  },
  /** 测试注入「今天」用；null 表示取真实时间。 */
  fixedNow: null as number | null,
  /** 从云端读到的课表与作息；读失败时保持空值，并由 `timetableError` 说明。 */
  courses: [] as Course[],
  settings: emptySettings() as TimetableSettings,
  /** 作息没读到不影响排计划（按每节 45 分钟估），但要如实告诉学生。 */
  timetableError: '',
  /** 「换一种排法」的计数：只换起点重算，不写库。 */
  variant: 0,
  coursesKnown: false,
  aiDraft: null as AiConstraintDraft | null,
  aiConfirmed: false,
  intentRequest: 0,
  unloaded: false,

  onLoad(query: Query) {
    this.unloaded = false;
    const noon = query !== null && typeof query.today === 'string' ? noonOf(query.today) : null;
    if (noon !== null) this.fixedNow = noon;
    const goals = loadGoals();
    const now = this.now();
    // 本机只留一份计划：重新排一次会覆盖它，所以先把「已经存过」如实说出来。
    const saved = loadPlan();
    this.setData({
      goals: goalRows(goals, now),
      hasSaved: saved !== null,
      savedNote: saved === null
        ? ''
        : `本机已存一份计划（${saved.weekLabel} · 共 ${saved.totalMinutes} 分钟），重新保存会覆盖它`,
    });

    const wanted = query !== null && typeof query.id === 'string' ? query.id : '';
    if (saved !== null && (wanted === '' || saved.goalId === wanted
      || (!saved.goalId && goals.filter((goal) => goal.name === saved.goalName && goal.date === saved.goalDate).length === 1
        && goals.some((goal) => goal.id === wanted && goal.name === saved.goalName && goal.date === saved.goalDate)))) {
      this.showSavedPlan(saved);
      return;
    }
    if (wanted !== '') {
      const goal = findGoal(wanted);
      if (goal === null) {
        this.setData({ status: 'missing', headline: '这个目标日已经不在了' });
        return;
      }
      this.pickGoal(goal);
      return;
    }
    if (goals.length === 0) {
      this.setData({ status: 'pick', headline: '还没有目标日，先建一个再排计划' });
      this.refreshSteps();
      return;
    }
    this.setData({ status: 'ready' });
    this.refreshSteps();
  },

  /** 重开先展示本机快照；在线核对失败也不能把保存结果清空。 */
  onShow() {
    if (!this.data.savedView) return;
    const saved = loadPlan();
    if (saved === null) { this.setData({ savedView: false, hasSaved: false, plan: null }); return; }
    this.showSavedPlan(saved);
    const createdAt = saved.createdAt;
    return this.loadTimetable().then(() => {
      if (this.data.savedView && this.data.plan?.createdAt === createdAt) this.showSavedPlan(saved);
    }).catch(() => {
      this.coursesKnown = false;
      if (this.data.savedView && this.data.plan?.createdAt === createdAt) this.showSavedPlan(saved);
    });
  },

  showSavedPlan(plan: StudyPlan) {
    this.invalidateAi();
    const goals = loadGoals();
    const matches = plan.goalId ? goals.filter((goal) => goal.id === plan.goalId)
      : goals.filter((goal) => goal.name === plan.goalName && goal.date === plan.goalDate);
    const goal = matches.length === 1 ? matches[0] : null;
    const view = savedPlanView(plan, this.courses, this.settings, this.todayText(), this.coursesKnown);
    const changed = goal !== null && (goal.date !== plan.goalDate || goal.name !== plan.goalName);
    this.setData({ status: 'ready', savedView: true, hasSaved: true, plan,
      goalId: goal?.id ?? '', goalName: plan.goalName, goalDate: plan.goalDate,
      eyebrow: `目标日 · ${plan.goalName} · ${monthDayText(plan.goalDate)}`,
      headline: view.title, savedRows: view.rows, savedRange: view.range, savedSummary: view.summary,
      savedTargetWeek: view.matchingWeek, savedGoalMissing: goal === null,
      savedNotice: goal === null ? `原目标日已删除或无法对应，仍可查看这份计划。${view.notice}`
        : changed ? `原目标日已修改，以下保留旧安排；重新生成会使用当前目标日。${view.notice}` : view.notice,
      constraintText: plan.constraintText ?? '', error: '',
      steps: STEP_TEXTS.map((text) => ({ text, state: 'done' })) });
  },

  onViewSaved() {
    const saved = loadPlan();
    if (saved !== null) this.showSavedPlan(saved);
  },

  onViewWeek() {
    // 传日历日期，让课表用刚读到的设置算周次；不能拿旧学期的第N周去套新学期。
    const date = this.data.plan?.today;
    wx.navigateTo({ url: `/pages/timetable/index${date ? `?planDate=${encodeURIComponent(date)}` : ''}` });
  },

  onRegenerate() {
    const goal = this.data.goalId === '' ? null : findGoal(this.data.goalId);
    if (goal === null) { this.onOpenGoals(); return; }
    this.pickGoal(goal);
  },

  now(): number {
    return this.fixedNow === null ? Date.now() : this.fixedNow;
  },

  todayText(): string {
    return shanghaiToday(this.now());
  },

  /** 选一个目标日：顶部一句话与步骤条都随之更新；已有计划作废（换目标就得重排）。 */
  pickGoal(goal: GoalDay) {
    this.invalidateAi();
    const status = statusOf(goal, this.now());
    this.setData({
      status: 'ready',
      savedView: false,
      goalId: goal.id,
      goalName: goal.name,
      goalDate: goal.date,
      eyebrow: `目标日 · ${goal.name} · ${monthDayText(goal.date)}`,
      plan: null,
      weekTitle: '',
      hoursText: '',
      gridRows: [],
      rationale: [],
      weekendLines: [],
      constraintLines: [],
      dropped: [],
      defaultNote: '',
      error: '',
      headline: `还剩 ${status.days} 天，说一句自己的情况就能排`,
    });
    this.refreshSteps();
  },

  onPickGoal(event: TapEvent) {
    const id = event.currentTarget.dataset.id;
    if (id === undefined || id === '') return;
    const goal = findGoal(id);
    if (goal === null) return;
    this.pickGoal(goal);
  },

  /**
   * 步骤条：选了目标 → ①done ②on；排出计划 → ①②done ③on。
   * 「④ 加入」要等学生真的点了保存才变 done，而保存后会直接返回上一页，所以这里始终留空。
   */
  refreshSteps() {
    const hasGoal = this.data.goalId !== '';
    const hasPlan = this.data.plan !== null;
    const states: StepView['state'][] = hasPlan
      ? ['done', 'done', 'on', '']
      : hasGoal
        ? ['done', 'on', '', '']
        : ['on', '', '', ''];
    this.setData({ steps: STEP_TEXTS.map((text, index) => ({ text, state: states[index] })) as StepView[] });
  },

  onConstraintInput(event: InputEvent) {
    this.invalidateAi();
    this.setData({ constraintText: event.detail.value, plan: null, gridRows: [], rationale: [],
      weekendLines: [], constraintLines: [], dropped: [], error: '' });
  },

  invalidateAi() {
    this.intentRequest += 1;
    this.aiDraft = null;
    this.aiConfirmed = false;
    this.setData({ aiBusy: false, aiDraftReady: false, aiDefaults: [], aiEvidence: [], aiMessage: '' });
  },

  scrollToResult(selector?: string) {
    if (typeof wx.nextTick !== 'function' || typeof wx.pageScrollTo !== 'function') return;
    wx.nextTick(() => {
      if (this.unloaded) return;
      wx.pageScrollTo(selector ? { selector, duration: 200 } : { scrollTop: 0, duration: 200 });
    });
  },

  goalStillValid(): boolean {
    const goal = this.data.goalId === '' ? null : findGoal(this.data.goalId);
    if (goal === null || goal.name !== this.data.goalName || goal.date !== this.data.goalDate) {
      this.setData({ error: '目标日已变化，请重新选择目标再生成', goals: goalRows(loadGoals(), this.now()) });
      return false;
    }
    if (statusOf(goal, this.now()).kind === 'expired') {
      this.setData({ error: '目标日期已过去，请调整日期或选择其他目标' });
      return false;
    }
    return true;
  },

  async understandAi() {
    if (this.data.aiBusy || this.data.busy) return;
    if (!this.goalStillValid()) return;
    const text = this.data.constraintText.trim();
    if (text === '') { this.setData({ aiMessage: '先写一句情况，或直接选择基础规则排程' }); this.scrollToResult('#plan-ai-message'); return; }
    this.invalidateAi();
    const request = this.intentRequest;
    const id = this.data.goalId;
    this.setData({ aiBusy: true, aiMessage: '', error: '', plan: null, gridRows: [], rationale: [] });
    try {
      await this.loadTimetable();
      if (this.unloaded || request !== this.intentRequest || id !== this.data.goalId) return;
      if (!this.goalStillValid()) return;
      const reply = await requestPlanIntent(this.data.goalName, text);
      if (this.unloaded || request !== this.intentRequest || id !== this.data.goalId || text !== this.data.constraintText.trim()) return;
      if (!this.goalStillValid()) return;
      if (reply.kind !== 'constraints') { this.setData({ aiMessage: reply.message }); this.scrollToResult('#plan-ai-message'); return; }
      this.aiDraft = reply.draft;
      this.setData({ aiDraftReady: true, aiDefaults: reply.draft.readout.lines.filter((line) => line.startsWith('默认：')),
        aiEvidence: reply.draft.evidence.map((item, key) => ({ ...item, key })) });
      this.scrollToResult('#plan-ai-draft');
    } catch (error) {
      if (!this.unloaded && request === this.intentRequest) {
        this.setData({ aiMessage: `读不到课表，先确认网络再试：${problemOf(error)}` });
        this.scrollToResult('#plan-ai-message');
      }
    } finally {
      if (!this.unloaded && request === this.intentRequest) this.setData({ aiBusy: false });
    }
  },

  async confirmAiPlan() {
    const draft = this.aiDraft;
    if (draft === null || this.data.aiBusy || this.data.busy) return;
    if (!this.goalStillValid() || draft.sourceText !== this.data.constraintText.trim() || draft.goalName !== this.data.goalName) return;
    const request = this.intentRequest;
    this.setData({ busy: true, error: '' });
    try {
      await this.loadTimetable();
      if (this.unloaded || request !== this.intentRequest || !this.goalStillValid()) return;
      this.aiConfirmed = true;
      this.variant = 0;
      this.showPlan(draft.sourceText, draft.readout);
      this.setData({ aiDraftReady: false });
    } catch (error) {
      if (!this.unloaded && request === this.intentRequest) this.setData({ error: `读不到课表，暂不生成：${problemOf(error)}` });
    } finally {
      if (!this.unloaded && request === this.intentRequest) this.setData({ busy: false });
    }
  },

  editAiInput() {
    this.invalidateAi();
    this.setData({ plan: null, error: '' });
    this.scrollToResult('#plan-constraint');
  },

  /** 生成计划前先读课表：读不到就不排——没有真实课表时算出来的「空档」是假的。 */
  async generate() {
    if (this.data.busy || this.data.aiBusy) return;
    if (this.data.goalId === '') {
      this.setData({ error: '先选一个目标日' });
      return;
    }
    this.invalidateAi();
    const request = this.intentRequest;
    const text = this.data.constraintText;
    if (!this.goalStillValid()) return;
    this.setData({ busy: true, error: '' });
    try {
      await this.loadTimetable();
    } catch (error) {
      if (!this.unloaded && request === this.intentRequest) this.setData({ busy: false, error: `读不到课表，先确认网络再试：${problemOf(error)}` });
      return;
    }
    if (this.unloaded) return;
    if (request !== this.intentRequest || !this.goalStillValid()) { this.setData({ busy: false }); return; }
    this.variant = 0;
    this.showPlan(text);
    this.setData({ busy: false });
  },

  /**
   * 读本人课表与作息。**不缓存到本机**：课表以云端为准，每次排计划都现读，
   * 免得学生刚改完课表、计划却按旧课表排。
   */
  async loadTimetable() {
    const list = await listCourses();
    this.courses = Array.isArray(list.courses) ? list.courses : [];
    const settings = await loadSettings();
    this.settings = settings;
    this.coursesKnown = true;
    this.timetableError = typeof settings.loadError === 'string'
      ? `作息时间没读到，按每节 ${DEFAULT_SECTION_MINUTES} 分钟估`
      : '';
  },

  /** 用已读到的课表算一份计划并铺到页面上（纯计算，测试可直接调用）。 */
  showPlan(text: string, interpreted?: ConstraintReadout) {
    const readout = interpreted ?? readConstraints(text);
    const plan = buildPlan({
      goalName: this.data.goalName,
      goalId: this.data.goalId,
      goalDate: this.data.goalDate,
      today: this.todayText(),
      courses: this.courses,
      settings: this.settings,
      constraints: readout.constraints,
      readout,
      constraintText: text,
      variant: this.variant,
      now: this.now(),
      clockMinutes: (() => {
        const clock = new Date(this.now() + 8 * 60 * 60 * 1000);
        return clock.getUTCHours() * 60 + clock.getUTCMinutes();
      })(),
    });
    plan.origin = interpreted !== undefined && this.aiConfirmed ? 'ai-constraints' : 'rules';
    plan.aiEvidence = plan.origin === 'ai-constraints' && this.aiDraft !== null ? this.aiDraft.evidence.slice() : [];
    if ((readout.problems?.length ?? 0) > 0 || readout.dropped.length > 0) {
      this.setData({ plan: null, gridRows: [], rationale: plan.rationale, dropped: readout.dropped,
        defaultNote: '', error: plan.rationale.join('；') });
      this.refreshSteps();
      this.scrollToResult('.gp-error');
      return;
    }
    const grid = planGrid(plan, this.courses, this.settings, plan.week);
    const weekend = plan.blocks.filter((block) => block.weekday >= 6);
    const skipped = plan.weeklyCount - plan.blocks.length;

    this.setData({
      plan,
      headline: plan.headline,
      weekTitle: plan.origin === 'ai-constraints' ? `${plan.weekLabel} · 已核对AI约束` : `${plan.weekLabel} · 按规则安排空闲时段`,
      hoursText: hoursLabel(plan.totalMinutes),
      gridRows: toGridRows(grid),
      weekendLines: weekend.map((block) => blockDescribe(block)),
      rationale: plan.rationale,
      constraintLines: plan.constraintLines,
      dropped: plan.dropped,
      defaultNote: this.noteOf(readout.constraints, readout.recognized, skipped, plan.blocks.length > 0),
      error: '',
    });
    this.refreshSteps();
    this.scrollToResult(plan.blocks.length > 0 ? '.gp-card' : undefined);
  },

  /** 小字说明：哪些按默认、哪些没听懂、以及为什么没按你要的段数排满。 */
  noteOf(
    constraints: PlanConstraints,
    recognized: {
      maxMinutesPerBlock: boolean;
      noWeekendMorning: boolean;
      noEvening: boolean;
      blocksPerWeek: boolean;
      focus: boolean;
    },
    skipped: number,
    hasBlocks: boolean,
  ): string {
    const notes: string[] = [];
    if (this.timetableError !== '') notes.push(this.timetableError);
    const missing: string[] = [];
    if (!recognized.maxMinutesPerBlock) missing.push(`每段 ${constraints.maxMinutesPerBlock} 分钟`);
    if (!recognized.blocksPerWeek) missing.push(`每周 ${constraints.blocksPerWeek} 段`);
    if (missing.length > 0) notes.push(`没提到的按默认：${missing.join('、')}`);
    // 一段都排不下时 headline 已经说了，这里不再重复「少了 4 段」。
    if (skipped > 0 && hasBlocks) notes.push(`空档不够，比你要的少了 ${skipped} 段`);
    return notes.join('；');
  },

  /** 「换一种排法」：换一个起点重算，结果不同但同样合法。**不写本机存储**。 */
  onVariant() {
    if (this.data.plan === null) return;
    const before = JSON.stringify(this.data.plan.blocks);
    this.variant += 1;
    this.showPlan(this.data.constraintText, this.aiConfirmed ? this.aiDraft?.readout : undefined);
    if (JSON.stringify(this.data.plan?.blocks) === before) wx.showToast({ title: '这次排法相同，可调整情况再试', icon: 'none' });
  },

  /** 「加入课表（作为计划）」：只存本机计划，不动云端课表。 */
  onSave() {
    const plan = this.data.plan;
    if (plan === null) return;
    if (plan.blocks.length === 0) {
      this.setData({ error: '这份计划里没有能排的时段，先不加入' });
      return;
    }
    try {
      savePlan(plan);
    } catch (error) {
      wx.showModal({ title: '加入失败', content: problemOf(error), showCancel: false });
      return;
    }
    wx.showToast({ title: '已保存到本机', icon: 'success' });
    this.setData({
      hasSaved: true,
      savedNote: `本机已存一份计划（${plan.weekLabel} · 共 ${plan.totalMinutes} 分钟）`,
    });
    this.showSavedPlan(plan);
    this.scrollToResult();
  },

  /** 已经存过计划时给学生的撤销键：只删本机计划，不改课表。 */
  onRemove() {
    try {
      removePlan();
    } catch (error) {
      wx.showModal({ title: '撤回失败', content: problemOf(error), showCancel: false });
      return;
    }
    this.setData({
      plan: null,
      gridRows: [],
      rationale: [],
      weekendLines: [],
      weekTitle: '',
      hoursText: '',
      hasSaved: false,
      savedView: false,
      savedRows: [],
      savedNotice: '',
      status: loadGoals().length === 0 ? 'pick' : 'ready',
      goalId: '',
      goalName: '',
      goalDate: '',
      headline: '已撤回保存的计划，先选目标日再排',
      error: '',
      savedNote: '',
    });
    this.refreshSteps();
    wx.showToast({ title: '已撤回', icon: 'none' });
  },

  onOpenGoals() {
    wx.navigateTo({ url: '/pages/goals/index' });
  },

  onCreateGoal() {
    wx.navigateTo({ url: '/pages/goals/edit/index' });
  },

  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/goals/index' });
  },
  onUnload() {
    this.unloaded = true;
    this.intentRequest += 1;
    this.aiDraft = null;
  },
});
