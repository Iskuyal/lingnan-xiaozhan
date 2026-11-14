/**
 * 备考计划页（岭南红 UI 第二轮 · C 分支）：一个页面承载九种界面状态。
 *
 * 设计稿对应关系（docs/design/lingnan-red-2026-11-11/）：
 * - 14-plan-input      → screen 'input'       说说情况
 * - 49-basic-rules     → screen 'rules'       基础规则五组控件
 * - 15-constraints     → screen 'draft'       AI 约束草稿逐条核对
 * - 64-constraint-clarify → screen 'clarify'  有一句还要确认 / 未理解的限制
 * - 43-ai-unavailable  → screen 'unavailable' AI 暂时不可用
 * - 16-preview         → screen 'preview'     规则预览未保存
 * - 17-saved           → screen 'saved'       已保存快照
 * - 18-conflict        → screen 'conflict'    已保存计划与新课程冲突
 * - 40-expired-plan    → screen 'expired'     历史快照 / 目标已删
 *
 * 状态模型：`screen` 是**判别字段**，由既有真实状态（status / plan / savedView /
 * aiDraftReady / aiOutcome / rulesOpen）推导，绝不替代它们——
 * 既有测试断言的是原字段，而且原字段才是业务真相。`refreshScreen()` 只读不写这些真相。
 *
 * 三条边界写死在这里，改代码前先看：
 * 1. AI 只解释约束，用户确认后仍由纯排程器检查；规则模式不请求模型。
 * 2. **课表从云端读、计划只写本机**。「保存这份计划」= `savePlan`，不往云端课表写任何记录。
 * 3. **排不下就说排不下**。空档不够时 `plan.blocks` 是空的，页面照实显示原因，不硬塞。
 *
 * 迟到响应保护（unloaded / intentRequest 快照 / goalStillValid / 文本未变）在
 * `understandAi` / `confirmAiPlan` / `runGenerate` 里原样保留——这是既有 AI 链路的安全底线。
 *
 * 测试注入：`onLoad({ today })` 固定「今天」；`courses` / `settings` 由 `loadTimetable`
 * 填写，测试直接赋值就能不连云端把整页跑通（见 tests/goals-plan.test.cjs）。
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
  ConstraintReadout,
  DEFAULT_SECTION_MINUTES,
  GRID_WEEKDAYS,
  PlanConstraints,
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
import { Course, SectionRange } from '../../../services/timetable/types';
import { TimetableSettings, emptySettings, loadSettings } from '../../../services/timetable/settings';
import { listCourses } from '../../../services/timetable/index';
import { addDays, weekIndexOf, weekdayOf } from '../../../services/timetable/semester';
import { WEEKDAY_SHORT, occursInWeek } from '../../../services/timetable/view';
import { shanghaiToday, parseDate } from '../../../services/dates/index';
import { SavedPlanRow, savedPlanView } from '../../../services/goals/saved';
import { AiConstraintDraft, requestPlanIntent } from '../../../services/goals/intent';
import { openTimetable } from '../../../ui/navigation';

/** 行标：与 `services/goals/plan` 的 GRID_PAIR_LABELS 同一套节次对，模板按行取用。 */
const GRID_ROW_LABELS = ['1–2', '3–4', '5–6', '7–8', '9–10', '11–12'];
const STEP_TEXTS = ['① 选目标', '② 说情况', '③ 看计划', '④ 保存'];

/** 设计稿 14/15/16 的三步条（比数据里的四步少一个「选目标」，那是入口不是步骤）。 */
const STEP_BAR_TEXTS = ['说说情况', '核对约束', '预览计划'];

/** 每种界面状态的设计稿导航标题。 */
const NAV_TITLES: Record<string, string> = {
  loading: '安排学习计划',
  pick: '安排学习计划',
  missing: '安排学习计划',
  input: '安排学习计划',
  rules: '基础规则设置',
  draft: '核对学习约束',
  clarify: '有一句还需确认',
  unavailable: '约束暂时没整理好',
  preview: '预览学习计划',
  saved: '本周学习计划',
  conflict: '计划需要核对',
  expired: '历史学习计划',
};

/** 基础规则页的可选项：只给常用值，都是 PlanConstraints 的合法取值。 */
const RULE_MINUTE_OPTIONS = [30, 45, 60, 90];
const RULE_BLOCK_OPTIONS = [2, 3, 4, 5, 6];
const RULE_MINUTES = 60;
const RULE_BLOCKS = 4;
const RULE_WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
/** 三个时段 → 节次区间（与 services/goals/intent.ts 的映射一致：上午 1–4 / 下午 5–8 / 晚间 9–12）。 */
const RULE_PERIODS = [
  { key: 'morning', label: '上午', start: 1, end: 4 },
  { key: 'afternoon', label: '下午', start: 5, end: 8 },
  { key: 'evening', label: '晚间', start: 9, end: 12 },
];
/** 设计稿 49 的两行日期：周六、周日。工作日时段用单独一个「晚间不排」开关表达。 */
const RULE_PERIOD_DAYS = [6, 7];

type Screen =
  | 'loading'
  | 'pick'
  | 'missing'
  | 'input'
  | 'rules'
  | 'draft'
  | 'clarify'
  | 'unavailable'
  | 'preview'
  | 'saved'
  | 'conflict'
  | 'expired';

interface InputEvent {
  detail: { value: string };
}

interface TapEvent {
  currentTarget: { dataset: { id?: string; value?: string; weekday?: number; start?: number; end?: number } };
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

interface StepBarView {
  num: number;
  label: string;
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

/** 计划统计三格（设计 16/17 的 plan-stat）：次数 / 分钟 / 已知冲突。 */
interface StatCellView {
  value: string;
  unit: string;
  caption: string;
}

/** 一条计划段在页面上的呈现：日期块 + 题目 + 「节次窗口」与「学习分钟数」两件事分开写。 */
interface PlanItemView {
  id: string;
  weekday: string;
  /** 日期块只显示日：「13」；跨月时靠 `date` 全量值说清。 */
  day: string;
  /** 完整 ISO 日期，给「原计划日期」这类摘要用。 */
  date: string;
  title: string;
  /** 节次窗口（不是钟点）：第 1–2 节内。 */
  window: string;
  /** 学习分钟数：学习 30 分钟。 */
  minutes: string;
}

/** 设计 18 的冲突卡：原计划时段 + 撞上的课程。 */
interface ConflictItemView {
  id: string;
  title: string;
  original: string;
  course: string;
  when: string;
  /** 提示条里那一行：「周五第 1–2 节与新课程冲突」。 */
  noteTitle: string;
}

interface KvRowView {
  key: string;
  value: string;
}

interface RuleOptionView {
  key: number;
  label: string;
  on: boolean;
}

interface RulePeriodOptionView {
  key: string;
  label: string;
  start: number;
  end: number;
  on: boolean;
}

interface RulePeriodRowView {
  weekday: number;
  label: string;
  options: RulePeriodOptionView[];
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

/** 「13」：计划段左侧日期块只用日。 */
function dayText(dateText: string): string {
  const parts = parseDate(dateText);
  return parts === null ? '' : String(parts.day);
}

/** 从一句提示里取出被引起来的原话（澄清态要把「哪一句」摆出来，而不是只说「有一句」）。 */
function quoteOf(message: string): string {
  const matched = message.match(/「([^」]+)」/);
  return matched === null ? '' : matched[1];
}

function mondayOf(dateText: string): string {
  const weekday = weekdayOf(dateText);
  return weekday === null ? '' : addDays(dateText, 1 - weekday);
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
    /** 界面判别字段：由下面这些真实状态推导，见文件头的状态模型说明。 */
    screen: 'loading' as Screen,
    navTitle: '安排学习计划',
    eyebrow: '备考计划',
    headline: '先选一个目标日，再说一句自己的情况',
    /** 设计稿的 h1 与导语（与 headline 分开：headline 是业务说明，heroTitle 是版式标题）。 */
    heroTitle: '这一周，你想怎么学？',
    heroLead: '',
    steps: STEP_TEXTS.map((text, index) => ({ text, state: index === 0 ? 'on' : '' })) as StepView[],
    stepBar: [] as StepBarView[],
    goals: [] as GoalRow[],
    goalId: '',
    goalName: '',
    goalDate: '',
    goalPickerOpen: false,
    plan: null as StudyPlan | null,
    constraintText: '',
    weekTitle: '',
    hoursText: '',
    gridRows: [] as GridRowView[],
    gridWeekdays: GRID_WEEKDAYS,
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
    /** 快照已过期（目标日期已过，或原目标日已删除）：设计 40 的历史快照。 */
    savedExpired: false,
    busy: false,
    aiBusy: false,
    aiDraftReady: false,
    aiDefaults: [] as string[],
    aiEvidence: [] as (PlanEvidence & { key: number })[],
    aiMessage: '',
    /** AI 这一次的结论：clarify（还要确认）/ unavailable（暂时不可用）。空 = 没有失败。 */
    aiOutcome: '' as '' | 'clarify' | 'unavailable',
    clarifyQuote: '',
    clarifyReason: '',
    error: '',
    /* ── 推导出来的展示数据：只给模板用，不是业务真相 ── */
    statCells: [] as StatCellView[],
    planItems: [] as PlanItemView[],
    planRangeText: '',
    /** 预览提示里那句「每次学习 X 分钟」：取计划段的实际分钟数，读不到就留空。 */
    planMinutesText: '',
    conflictItems: [] as ConflictItemView[],
    conflictRestTitle: '',
    conflictRestNote: '',
    evidenceRows: [] as KvRowView[],
    savedSourceNote: '',
    /* ── 基础规则（设计 49）：五组控件直接映射 PlanConstraints ── */
    rulesOpen: false,
    ruleMinutes: RULE_MINUTES,
    ruleBlocks: RULE_BLOCKS,
    ruleFocus: '',
    ruleNoEvening: false,
    ruleMinuteOptions: [] as RuleOptionView[],
    ruleBlockOptions: [] as RuleOptionView[],
    ruleWeekdays: [] as RuleOptionView[],
    rulePeriodRows: [] as RulePeriodRowView[],
  },
  /** 测试注入「今天」用；null 表示取真实时间。 */
  fixedNow: null as number | null,
  /** 上一次 `ruleConstraints()` 算出的不可用时段文案（给约束回显用，不参与判断）。 */
  rulePeriodLabels: [] as string[],
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
        this.setData({ status: 'missing', headline: '这个目标日已经不在了', goalPickerOpen: false });
        this.refreshScreen();
        return;
      }
      this.pickGoal(goal);
      return;
    }
    if (goals.length === 0) {
      this.setData({ status: 'pick', headline: '还没有目标日，先建一个再排计划', goalPickerOpen: false });
      this.refreshSteps();
      this.refreshScreen();
      return;
    }
    this.setData({ status: 'ready', goalPickerOpen: this.data.goalId === '' });
    this.refreshSteps();
    this.refreshScreen();
  },

  /** 重开先展示本机快照；在线核对失败也不能把保存结果清空。 */
  onShow() {
    if (!this.data.savedView) return;
    const saved = loadPlan();
    if (saved === null) {
      this.setData({ savedView: false, hasSaved: false, plan: null, savedExpired: false });
      this.refreshScreen();
      return;
    }
    this.showSavedPlan(saved);
    const createdAt = saved.createdAt;
    return this.loadTimetable().then(() => {
      if (this.data.savedView && this.data.plan?.createdAt === createdAt) this.showSavedPlan(saved);
    }).catch(() => {
      this.coursesKnown = false;
      if (this.data.savedView && this.data.plan?.createdAt === createdAt) this.showSavedPlan(saved);
    });
  },

  /**
   * 页面退出：把在途的 AI 请求与回调一起作废。
   * `intentRequest += 1` 让 understandAi / confirmAiPlan / runGenerate 里那几处
   * `request !== this.intentRequest` 判定全部失效——迟到的响应不会再上屏、也不会写库。
   */
  onUnload() {
    this.unloaded = true;
    this.intentRequest += 1;
    this.aiDraft = null;
  },

  showSavedPlan(plan: StudyPlan) {
    this.invalidateAi();
    const goals = loadGoals();
    const matches = plan.goalId ? goals.filter((goal) => goal.id === plan.goalId)
      : goals.filter((goal) => goal.name === plan.goalName && goal.date === plan.goalDate);
    const goal = matches.length === 1 ? matches[0] : null;
    const view = savedPlanView(plan, this.courses, this.settings, this.todayText(), this.coursesKnown);
    const changed = goal !== null && (goal.date !== plan.goalDate || goal.name !== plan.goalName);
    // 设计 40：目标日已删（或无法对应）与目标日期已过去都是「历史快照」，只供回看。
    const expired = goal === null || view.title === '已保存的历史计划';
    this.setData({
      status: 'ready', savedView: true, hasSaved: true, plan,
      goalId: goal?.id ?? '', goalName: plan.goalName, goalDate: plan.goalDate,
      eyebrow: `目标日 · ${plan.goalName} · ${monthDayText(plan.goalDate)}`,
      headline: view.title, savedRows: view.rows, savedRange: view.range, savedSummary: view.summary,
      savedTargetWeek: view.matchingWeek, savedGoalMissing: goal === null, savedExpired: expired,
      savedNotice: goal === null ? `原目标日已删除或无法对应，仍可查看这份计划。${view.notice}`
        : changed ? `原目标日已修改，以下保留旧安排；重新生成会使用当前目标日。${view.notice}` : view.notice,
      constraintText: plan.constraintText ?? '', error: '', goalPickerOpen: false,
      weekTitle: plan.weekLabel,
      hoursText: hoursLabel(plan.totalMinutes),
      rationale: plan.rationale, constraintLines: plan.constraintLines, dropped: plan.dropped,
      defaultNote: '', weekendLines: plan.blocks.filter((block) => block.weekday >= 6).map((block) => blockDescribe(block)),
      gridRows: toGridRows(planGrid(plan, this.courses, this.settings, plan.week)),
      steps: STEP_TEXTS.map((text) => ({ text, state: 'done' })),
    });
    this.refreshSteps();
    this.refreshScreen();
  },

  onViewSaved() {
    const saved = loadPlan();
    if (saved !== null) this.showSavedPlan(saved);
  },

  /**
   * 去课表看本周：课表是 tab 页，必须走公共意图桥（`openTimetable`），
   * 用 `plan-week` 带上计划生成时那一天，让课表自己算周次——不能拿旧学期的第 N 周去套新学期。
   * 运行环境没有 switchTab（例如只跑页面逻辑的测试宿主）时退回到 navigateTo，
   * 这条降级路径同时保留了旧课表页的入口。
   */
  onViewWeek() {
    const date = this.data.plan?.today ?? '';
    const url = `/pages/timetable/index${date === '' ? '' : `?planDate=${encodeURIComponent(date)}`}`;
    const fallback = () => { wx.navigateTo({ url }); };
    if (typeof wx === 'undefined' || typeof wx.switchTab !== 'function') { fallback(); return; }
    if (date === '') { openTimetable().catch(fallback); return; }
    openTimetable({ kind: 'plan-week', planDate: date }).catch(fallback);
  },

  onRegenerate() {
    const goal = this.data.goalId === '' ? null : findGoal(this.data.goalId);
    if (goal === null) { this.onOpenGoals(); return; }
    this.pickGoal(goal);
  },

  /** 设计 18 的「先保留这份计划」：只回一句，不改存储、不重排。 */
  onKeepSaved() {
    wx.showToast({ title: '保留原计划，未做改动', icon: 'none' });
    this.scrollToResult();
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
      savedExpired: false,
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
      goalPickerOpen: false,
      headline: `还剩 ${status.days} 天，说一句自己的情况就能排`,
    });
    this.refreshSteps();
    this.refreshScreen();
  },

  onPickGoal(event: TapEvent) {
    const id = event.currentTarget.dataset.id;
    if (id === undefined || id === '') return;
    const goal = findGoal(id);
    if (goal === null) return;
    this.pickGoal(goal);
  },

  /** 多目标时允许换一个；只有一个目标时也可以展开看一下日期。 */
  onToggleGoalPicker() {
    this.setData({ goalPickerOpen: !this.data.goalPickerOpen });
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
      weekendLines: [], constraintLines: [], dropped: [], error: '', aiOutcome: '',
      clarifyQuote: '', clarifyReason: '' });
    this.refreshScreen();
  },

  invalidateAi() {
    this.intentRequest += 1;
    this.aiDraft = null;
    this.aiConfirmed = false;
    this.setData({ aiBusy: false, aiDraftReady: false, aiDefaults: [], aiEvidence: [], aiMessage: '',
      aiOutcome: '', clarifyQuote: '', clarifyReason: '' });
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
    if (!this.goalStillValid()) { this.refreshScreen(); return; }
    const text = this.data.constraintText.trim();
    if (text === '') { this.setData({ aiMessage: '先写一句情况，或直接选择基础规则排程' }); this.scrollToResult('#plan-ai-message'); this.refreshScreen(); return; }
    this.invalidateAi();
    const request = this.intentRequest;
    const id = this.data.goalId;
    this.setData({ aiBusy: true, aiMessage: '', error: '', plan: null, gridRows: [], rationale: [] });
    this.refreshScreen();
    try {
      await this.loadTimetable();
      if (this.unloaded || request !== this.intentRequest || id !== this.data.goalId) return;
      if (!this.goalStillValid()) { this.refreshScreen(); return; }
      const reply = await requestPlanIntent(this.data.goalName, text);
      if (this.unloaded || request !== this.intentRequest || id !== this.data.goalId || text !== this.data.constraintText.trim()) return;
      if (!this.goalStillValid()) { this.refreshScreen(); return; }
      if (reply.kind !== 'constraints') {
        // 设计 43 / 64：AI 这次没整理出来，就把结论与「哪一句没听懂」摆到界面上，不静默吞掉。
        this.setData({
          aiMessage: reply.message,
          aiOutcome: reply.kind === 'clarify' ? 'clarify' : 'unavailable',
          clarifyQuote: reply.kind === 'clarify' ? quoteOf(reply.message) : '',
          clarifyReason: reply.message,
        });
        this.refreshScreen();
        this.scrollToResult('#plan-ai-message');
        return;
      }
      this.aiDraft = reply.draft;
      this.setData({ aiDraftReady: true, aiOutcome: '', clarifyQuote: '', clarifyReason: '',
        aiDefaults: reply.draft.readout.lines.filter((line) => line.startsWith('默认：')),
        aiEvidence: reply.draft.evidence.map((item, key) => ({ ...item, key })) });
      this.refreshScreen();
      this.scrollToResult('#plan-ai-draft');
    } catch (error) {
      if (!this.unloaded && request === this.intentRequest) {
        this.setData({ aiMessage: `读不到课表，先确认网络再试：${problemOf(error)}` });
        this.scrollToResult('#plan-ai-message');
        this.refreshScreen();
      }
    } finally {
      if (!this.unloaded && request === this.intentRequest) { this.setData({ aiBusy: false }); this.refreshScreen(); }
    }
  },

  async confirmAiPlan() {
    const draft = this.aiDraft;
    if (draft === null || this.data.aiBusy || this.data.busy) return;
    if (!this.goalStillValid() || draft.sourceText !== this.data.constraintText.trim() || draft.goalName !== this.data.goalName) {
      this.refreshScreen();
      return;
    }
    const request = this.intentRequest;
    this.setData({ busy: true, error: '' });
    this.refreshScreen();
    try {
      await this.loadTimetable();
      if (this.unloaded || request !== this.intentRequest || !this.goalStillValid()) { this.refreshScreen(); return; }
      this.aiConfirmed = true;
      this.variant = 0;
      this.showPlan(draft.sourceText, draft.readout);
      this.setData({ aiDraftReady: false });
    } catch (error) {
      if (!this.unloaded && request === this.intentRequest) this.setData({ error: `读不到课表，暂不生成：${problemOf(error)}` });
    } finally {
      if (!this.unloaded && request === this.intentRequest) { this.setData({ busy: false }); this.refreshScreen(); }
    }
  },

  editAiInput() {
    this.invalidateAi();
    this.setData({ plan: null, error: '', rulesOpen: false });
    this.refreshSteps();
    this.refreshScreen();
    this.scrollToResult('#plan-constraint');
  },

  /* ------------------------------------------------------------------ *
   * 基础规则（设计 49）：五组控件全部映射到同一个 PlanConstraints，不新增存储字段。
   * ------------------------------------------------------------------ */

  showRules() {
    this.setData({ rulesOpen: true, error: '', goalPickerOpen: false });
    this.refreshRules();
    this.refreshScreen();
  },

  hideRules() {
    this.setData({ rulesOpen: false });
    this.refreshScreen();
  },

  /** 从「AI 不可用 / 有一句还要确认」进基础规则：这也是设计 43/64 的合法出路。 */
  onRulesFromAi() {
    this.showRules();
  },

  refreshRules() {
    const excluded = this.ruleExcludedWeekdays();
    const blockedKeys = this.ruleBlockedKeys();
    this.setData({
      ruleMinuteOptions: RULE_MINUTE_OPTIONS.map((value) => ({ key: value, label: `${value} 分钟`, on: value === this.data.ruleMinutes })),
      ruleBlockOptions: RULE_BLOCK_OPTIONS.map((value) => ({ key: value, label: `${value} 次`, on: value === this.data.ruleBlocks })),
      ruleWeekdays: RULE_WEEKDAY_LABELS.map((label, index) => ({
        key: index + 1, label, on: excluded.includes(index + 1),
      })),
      rulePeriodRows: RULE_PERIOD_DAYS.map((weekday) => ({
        weekday,
        label: `周${WEEKDAY_SHORT[weekday - 1] ?? ''}`,
        options: RULE_PERIODS.map((period) => ({
          key: `${weekday}-${period.key}`,
          label: period.label,
          start: period.start,
          end: period.end,
          on: blockedKeys.includes(`${weekday}-${period.start}-${period.end}`),
        })),
      })),
    });
  },

  /** 当前规则里选中的不可用星期（唯一真相存在 ruleWeekdays 的 on 上）。 */
  ruleExcludedWeekdays(): number[] {
    const picked: number[] = [];
    for (const option of this.data.ruleWeekdays) {
      if (option.on) picked.push(option.key);
    }
    // 首次渲染前规则数组还是空的，返回空值兜底——不猜用户选了什么。
    return picked.sort((a: number, b: number) => a - b);
  },

  ruleBlockedKeys(): string[] {
    const keys: string[] = [];
    for (const row of this.data.rulePeriodRows) {
      for (const option of row.options) {
        if (option.on) keys.push(`${row.weekday}-${option.start}-${option.end}`);
      }
    }
    return keys;
  },

  onRuleMinutes(event: TapEvent) {
    const value = Number(event.currentTarget.dataset.value);
    if (!RULE_MINUTE_OPTIONS.includes(value)) return;
    this.setData({ ruleMinutes: value });
    this.refreshRules();
  },

  onRuleBlocks(event: TapEvent) {
    const value = Number(event.currentTarget.dataset.value);
    if (!RULE_BLOCK_OPTIONS.includes(value)) return;
    this.setData({ ruleBlocks: value });
    this.refreshRules();
  },

  onRuleFocusInput(event: InputEvent) {
    // 弱项名与 AI 侧同一约束（focus 最长 12 字），超长直接截断而不是让排程器报错。
    this.setData({ ruleFocus: event.detail.value.slice(0, 12) });
  },

  onRuleWeekday(event: TapEvent) {
    const weekday = Number(event.currentTarget.dataset.value);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return;
    const excluded = this.ruleExcludedWeekdays();
    const next = excluded.includes(weekday)
      ? excluded.filter((day: number) => day !== weekday)
      : [...excluded, weekday].sort((a: number, b: number) => a - b);
    this.setData({ ruleWeekdays: RULE_WEEKDAY_LABELS.map((label, index) => ({ key: index + 1, label, on: next.includes(index + 1) })) });
  },

  onRulePeriod(event: TapEvent) {
    const dataset = event.currentTarget.dataset;
    const weekday = Number(dataset.weekday);
    const start = Number(dataset.start);
    const end = Number(dataset.end);
    if (!Number.isInteger(weekday) || !Number.isInteger(start) || !Number.isInteger(end)) return;
    const key = `${weekday}-${start}-${end}`;
    const current = this.ruleBlockedKeys();
    const next = key === '' || current.includes(key)
      ? current.filter((item: string) => item !== key)
      : [...current, key];
    this.setData({
      rulePeriodRows: RULE_PERIOD_DAYS.map((day) => ({
        weekday: day,
        label: `周${WEEKDAY_SHORT[day - 1] ?? ''}`,
        options: RULE_PERIODS.map((period) => ({
          key: `${day}-${period.key}`,
          label: period.label,
          start: period.start,
          end: period.end,
          on: next.includes(`${day}-${period.start}-${period.end}`),
        })),
      })),
    });
  },

  onRuleNoEvening() {
    this.setData({ ruleNoEvening: !this.data.ruleNoEvening });
  },

  /** 周末上午两天都选了 → 用 PlanConstraints 的 noWeekendMorning（与逐条 blockedSections 等价）。 */
  ruleWeekendMorning(): boolean {
    return this.ruleBlockedKeys().includes('6-1-4') && this.ruleBlockedKeys().includes('7-1-4');
  },

  /** 五组控件 → PlanConstraints：只填既有字段，不新增任何存储结构。 */
  ruleConstraints(): PlanConstraints {
    const excluded = this.ruleExcludedWeekdays();
    const constraints: PlanConstraints = {
      maxMinutesPerBlock: this.data.ruleMinutes,
      blocksPerWeek: this.data.ruleBlocks,
      focus: this.data.ruleFocus.trim(),
      noWeekendMorning: this.ruleWeekendMorning(),
      noEvening: this.data.ruleNoEvening,
    };
    const blocked: { weekday: number; start: number; end: number }[] = [];
    const periodLabels: string[] = [];
    for (const row of this.data.rulePeriodRows) {
      for (const option of row.options) {
        if (!option.on) continue;
        blocked.push({ weekday: row.weekday, start: option.start, end: option.end });
        periodLabels.push(`${row.label}${option.label}`);
      }
    }
    if (excluded.length > 0) constraints.excludedWeekdays = excluded;
    if (blocked.length > 0) constraints.blockedSections = blocked;
    constraints.focus = constraints.focus === '' ? '' : constraints.focus;
    this.rulePeriodLabels = periodLabels;
    return constraints;
  },

  ruleLines(): string[] {
    const constraints = this.ruleConstraints();
    const lines: string[] = [`每段不超过 ${constraints.maxMinutesPerBlock} 分钟`, `每周 ${constraints.blocksPerWeek} 段`];
    if (constraints.focus !== '') lines.push(`最弱的是${constraints.focus}`);
    if (constraints.excludedWeekdays !== undefined && constraints.excludedWeekdays.length > 0) {
      lines.push(`周${constraints.excludedWeekdays.map((day: number) => WEEKDAY_SHORT[day - 1]).join('、周')}不排`);
    }
    for (const label of this.rulePeriodLabels) lines.push(`${label}不排`);
    if (constraints.noWeekendMorning) lines.push('周末上午一律不排');
    if (constraints.noEvening) lines.push('晚上一律不排');
    return lines;
  },

  /** 规则模式交给 buildPlan 的 readout：全部是「学生亲手选的」，所以 recognized 全为 true。 */
  ruleReadout(): ConstraintReadout {
    const constraints = this.ruleConstraints();
    return {
      constraints,
      lines: this.ruleLines(),
      dropped: [],
      problems: [],
      recognized: {
        maxMinutesPerBlock: true,
        noWeekendMorning: constraints.noWeekendMorning,
        noEvening: constraints.noEvening,
        blocksPerWeek: true,
        focus: constraints.focus !== '',
      },
    };
  },

  /** 规则页的原话回显：保存进计划的 constraintText 就是这句话，重开时读得懂。 */
  ruleText(): string {
    return this.ruleLines().join('，');
  },

  /** 设计 49 的「按这些规则生成预览」：同样先读课表，再走纯规则排程，不请求模型。 */
  generateRules() {
    return this.runGenerate(this.ruleText(), this.ruleReadout());
  },

  /** 生成计划前先读课表：读不到就不排——没有真实课表时算出来的「空档」是假的。 */
  async generate() {
    return this.runGenerate(this.data.constraintText);
  },

  async runGenerate(text: string, readout?: ConstraintReadout) {
    if (this.data.busy || this.data.aiBusy) return;
    if (this.data.goalId === '') {
      this.setData({ error: '先选一个目标日' });
      this.refreshScreen();
      return;
    }
    this.invalidateAi();
    const request = this.intentRequest;
    if (!this.goalStillValid()) { this.refreshScreen(); return; }
    this.setData({ busy: true, error: '' });
    this.refreshScreen();
    try {
      await this.loadTimetable();
    } catch (error) {
      if (!this.unloaded && request === this.intentRequest) {
        this.setData({ busy: false, error: `读不到课表，先确认网络再试：${problemOf(error)}` });
        this.refreshScreen();
      }
      return;
    }
    if (this.unloaded) return;
    if (request !== this.intentRequest || !this.goalStillValid()) { this.setData({ busy: false }); this.refreshScreen(); return; }
    this.variant = 0;
    this.showPlan(text, readout);
    this.setData({ busy: false });
    this.refreshScreen();
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
      // 设计 64：有没听懂/读不通的限制就停在澄清态，把原话与原因交出来，绝不静默按默认排。
      const reason = plan.rationale.join('；');
      const quote = readout.dropped.length > 0 ? quoteOf(readout.dropped[0]) : '';
      this.setData({ plan: null, gridRows: [], rationale: plan.rationale, dropped: readout.dropped,
        defaultNote: '', error: reason,
        aiOutcome: 'clarify', clarifyQuote: quote, clarifyReason: reason });
      this.refreshSteps();
      this.refreshScreen();
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
      error: '', savedView: false, savedExpired: false, rulesOpen: false,
      aiOutcome: '', clarifyQuote: '', clarifyReason: '',
    });
    this.refreshSteps();
    this.refreshScreen();
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

  /** 「换一个安排」：换一个起点重算，结果不同但同样合法。**不写本机存储、不请求模型**。 */
  onVariant() {
    if (this.data.plan === null) return;
    const before = JSON.stringify(this.data.plan.blocks);
    this.variant += 1;
    this.showPlan(this.data.constraintText, this.aiConfirmed ? this.aiDraft?.readout : undefined);
    if (JSON.stringify(this.data.plan?.blocks) === before) wx.showToast({ title: '这次排法相同，可调整情况再试', icon: 'none' });
  },

  /** 「保存这份计划」：只存本机计划，不动云端课表，也不请求模型。 */
  onSave() {
    const plan = this.data.plan;
    if (plan === null) return;
    if (plan.blocks.length === 0) {
      this.setData({ error: '这份计划里没有能排的时段，先不加入' });
      this.refreshScreen();
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
      savedExpired: false,
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
    this.refreshScreen();
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

  /* ------------------------------------------------------------------ *
   * 三、推导层：只读真实状态，算屏幕判别与展示数据
   * ------------------------------------------------------------------ */

  /**
   * 由真实状态推导 `screen` 与各屏展示数据。
   * 优先级即状态机：保存快照 > 基础规则 > AI 草稿 > 预览 > 澄清/不可用 > 输入。
   */
  refreshScreen() {
    this.refreshRules();
    const data = this.data;
    const plan = data.plan;
    const scan = plan === null ? null : this.scanConflicts(plan);
    const conflicts = scan === null ? 0 : scan.items.length;
    let screen: Screen;
    if (data.status === 'loading') screen = 'loading';
    else if (data.status === 'pick') screen = 'pick';
    else if (data.status === 'missing') screen = 'missing';
    else if (data.savedView) screen = data.savedExpired ? 'expired' : conflicts > 0 ? 'conflict' : 'saved';
    else if (data.rulesOpen) screen = 'rules';
    else if (data.aiDraftReady) screen = 'draft';
    else if (plan !== null) screen = 'preview';
    else if (data.aiOutcome === 'clarify') screen = 'clarify';
    else if (data.aiOutcome === 'unavailable') screen = 'unavailable';
    else screen = 'input';

    const stepStates: StepBarView['state'][] = data.savedView
      ? ['done', 'done', 'done']
      : plan !== null
        ? ['done', 'done', 'on']
        : data.aiDraftReady || screen === 'clarify'
          ? ['done', 'on', '']
          : screen === 'unavailable'
            ? ['on', '', '']
            : ['on', '', ''];
    const stepBar = STEP_BAR_TEXTS.map((label, index) => ({
      num: index + 1, label, state: stepStates[index],
    })) as StepBarView[];
    const rangeText = plan === null ? '' : this.rangeTextOf(plan);
    const focus = plan === null ? '' : this.focusOf(plan);
    this.setData({
      screen,
      navTitle: NAV_TITLES[screen],
      heroTitle: this.heroTitleOf(screen, focus),
      heroLead: this.heroLeadOf(screen, rangeText, plan),
      stepBar,
      statCells: plan === null ? [] : [
        { value: String(plan.blocks.length), unit: '次', caption: '本周安排' },
        { value: String(plan.totalMinutes), unit: '分钟', caption: '总学习时长' },
        { value: String(conflicts), unit: '', caption: '已知冲突' },
      ],
      planItems: plan === null ? [] : this.planItemsOf(plan),
      planRangeText: rangeText,
      planMinutesText: plan === null || plan.blocks.length === 0 ? '' : this.minutesTextOf(plan),
      conflictItems: scan === null ? [] : scan.items,
      conflictRestTitle: scan === null ? '' : scan.restTitle,
      conflictRestNote: scan === null ? '' : scan.restNote,
      evidenceRows: plan === null ? [] : this.basisRowsOf(plan),
      savedSourceNote: data.savedView
        ? `按保存时的课表检查 · 重新打开会提示新发现的冲突${this.coursesKnown ? '' : '（当前课表未读到，暂未核对）'}`
        : '',
    });
    if (typeof wx !== 'undefined' && typeof wx.setNavigationBarTitle === 'function') {
      wx.setNavigationBarTitle({ title: NAV_TITLES[screen] });
    }
  },

  heroTitleOf(screen: Screen, focus: string): string {
    switch (screen) {
      case 'input': return '这一周，你想怎么学？';
      case 'rules': return '自己定，也能安排清楚。';
      case 'draft': return '这是你的意思吗？';
      case 'clarify': return '有一句，还需要说具体一点。';
      case 'unavailable': return '这次先手动安排。';
      case 'preview': return '这一周，这样安排。';
      case 'saved': return focus === '' ? '这一周，留好时间。' : `给${focus}，留好时间。`;
      case 'conflict': return '有一处时间撞上了。';
      case 'expired': return '计划还在，时间已经过去了。';
      case 'pick': return '还没有目标日';
      case 'missing': return '这个目标日已经不在了';
      default: return '安排学习计划';
    }
  },

  heroLeadOf(screen: Screen, rangeText: string, plan: StudyPlan | null): string {
    switch (screen) {
      case 'input': return '说说空闲时间和薄弱项。AI 整理后，你先核对，我们再安排时段。';
      case 'rules': return `${this.data.goalName === '' ? '当前目标日' : this.data.goalName} · 本周规则设置`;
      case 'draft': return '每条都附上你的原话。核对后，再结合课表安排本周时段。';
      case 'clarify': return '先确认这句的意思，避免安排超出你的时间。';
      case 'unavailable': return '';
      case 'preview':
      case 'saved': return rangeText;
      case 'conflict': return '原计划仍在，没有自动改动。';
      case 'expired': return plan === null ? '' : `保存于 ${rangeText}，对应的目标日已删除或已过去。`;
      default: return '';
    }
  },

  /** 计划段的展示数据：日期块 + 题目 + 节次窗口 + 学习分钟数（窗口与分钟数分开写）。 */
  planItemsOf(plan: StudyPlan): PlanItemView[] {
    const monday = mondayOf(plan.today);
    return plan.blocks.map((block) => {
      const date = monday === '' ? '' : addDays(monday, (block.week - plan.week) * 7 + block.weekday - 1);
      return {
        id: block.id,
        weekday: `周${WEEKDAY_SHORT[block.weekday - 1] ?? ''}`,
        day: date === '' ? '' : dayText(date),
        date,
        title: block.topic,
        window: `第 ${block.startSection}–${block.endSection} 节内`,
        minutes: `学习 ${block.minutes} 分钟`,
      };
    });
  },

  /** 「30」或「30/45」：计划段实际分钟数，用于预览提示里那句「每次学习 X 分钟」。 */
  minutesTextOf(plan: StudyPlan): string {
    const minutes = [...new Set(plan.blocks.map((block) => block.minutes))].sort((a: number, b: number) => a - b);
    return minutes.length === 0 ? '' : minutes.join('/');
  },

  /** 「11 月 9 日 — 15 日」：与设计 16/17 的 intro 同一写法。 */
  rangeTextOf(plan: StudyPlan): string {
    const monday = mondayOf(plan.today);
    if (monday === '') return monthDayText(plan.today);
    const sunday = addDays(monday, 6);
    return `${monthDayText(monday)} — ${dayText(sunday)} 日`;
  },

  /** 计划里能读出来的弱项（用于设计 17 的 h1「给听力，留好时间。」），读不到就返回空串。 */
  focusOf(plan: StudyPlan): string {
    for (const line of plan.constraintLines) {
      const focus = line.match(/(?:最弱的是|重点练)([^\s，。；]+)/);
      if (focus !== null && focus[1] !== '') return focus[1].slice(0, 12);
    }
    return '';
  },

  /**
   * 用当前课表核对已排的每一段：撞上的课程单独列出（设计 18），没撞上的汇总成「另外 N 次练习」。
   * 课表没读到（离线）时不假装核对过——`coursesKnown` 为 false 时一律返回空。
   */
  scanConflicts(plan: StudyPlan): { items: ConflictItemView[]; restTitle: string; restNote: string } {
    const today = this.todayText();
    const monday = mondayOf(plan.today);
    const items: ConflictItemView[] = [];
    const rest: string[] = [];
    for (const block of plan.blocks) {
      const date = monday === '' ? '' : addDays(monday, (block.week - plan.week) * 7 + block.weekday - 1);
      const week = date === '' ? null : weekIndexOf(this.settings, date);
      const courses: Course[] = this.courses ?? [];
      const overlapping: Course[] = this.coursesKnown ? courses.filter((course: Course) => course.weekday === block.weekday
        && (week === null || occursInWeek(course, week))
        && (course.sectionRanges.length > 0 ? course.sectionRanges : [{ start: course.startSection, end: course.endSection }])
          .some((range: SectionRange) => range.start <= block.endSection && block.startSection <= range.end)) : [];
      const span = `周${WEEKDAY_SHORT[block.weekday - 1] ?? ''}第 ${block.startSection}–${block.endSection} 节`;
      if (overlapping.length === 0) { rest.push(span); continue; }
      items.push({
        id: block.id,
        title: block.topic,
        original: `${span} · ${block.minutes} 分钟`,
        course: overlapping.map((course: Course) => `${course.name} · 第 ${course.startSection}–${course.endSection} 节`).join('；'),
        when: `${monthDayText(today)} · 当前课表检查结果`,
        noteTitle: `${span}与新课程冲突`,
      });
    }
    return {
      items,
      restTitle: rest.length === 0 ? '' : `另外 ${rest.length} 次练习`,
      restNote: rest.length === 0 ? '' : `${rest.join('、')} · 未发现已知课程冲突`,
    };
  },

  /** 设计 17 的「这份计划的依据」：只写能用计划数据核对的事。 */
  basisRowsOf(plan: StudyPlan): KvRowView[] {
    const minutes = [...new Set(plan.blocks.map((block) => block.minutes))].sort((a, b) => a - b);
    const rows: KvRowView[] = [
      { key: '约束来源', value: plan.origin === 'ai-constraints' ? 'AI 整理，经你确认' : '基础规则，未请求 AI' },
      { key: '每次 / 每周', value: `${minutes.length === 0 ? '0' : minutes.join('/')} 分钟 / ${plan.weeklyCount} 次` },
    ];
    const avoid = plan.constraintLines.filter((line) => /不排|避开/.test(line));
    rows.push({ key: '避开', value: avoid.length === 0 ? '没有额外限制' : avoid.join('、') });
    const dates = this.planItemsOf(plan).map((item: PlanItemView) => (item.date === '' ? item.weekday : monthDayText(item.date)));
    rows.push({ key: '原计划日期', value: dates.join('、') });
    return rows;
  },
});
