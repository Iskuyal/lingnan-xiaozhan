/**
 * 我的课表（设计图 02 / 51 / 67 / 71）与课表助手 / 通知调课（08–10、39、70–73）。
 *
 * 数据来自 `timetable` 云函数（按微信身份隔离），页面每次显示都从云端重读；
 * 助手与通知都只产出**提案**，学生确认后才走既有写入入口。限定周次调课走服务端原子拆课，
 * 支持幂等重试与 10 秒整项撤销；任何失败都如实报出，不把部分成功说成全部成功。
 *
 * 页面只做编排：排布与几何在 `ui/timetable/present.ts`，业务规则在既有 `services/timetable/`。
 */
import { Course, CourseInput } from '../../services/timetable/types';
import {
  FILE_GUIDE,
  OFFLINE_NOTE,
  applyScopedCourse,
  createCourse,
  deleteCourse,
  listCourses,
  messageOf,
  undoScopedCourse,
  updateCourse,
} from '../../services/timetable/index';
import {
  WEEKDAY_SHORT,
  WeekView,
  buildGrid,
  buildWeekView,
  coursesForWeek,
  formatUpdatedAt,
  sectionLabelOf,
  semesterLabel,
  weekLabelOf,
  weekdayLabel,
} from '../../services/timetable/view';
import { courseColor } from '../../services/timetable/palette';
import {
  LoadedSettings,
  TimetableSettings,
  currentSectionAt,
  emptySettings,
  loadSettings,
  minutesOfClock,
  sectionTimeAt,
} from '../../services/timetable/settings';
import { TodayItem, TodaySummary, hasSectionTimes, summarizeToday } from '../../services/timetable/now';
import { formatWeekRange, weekDateFullLabels, weekDateLabels, weekIndexOf, weekSpanWithSemester, weekdayOf } from '../../services/timetable/semester';
import { ChatMessage, callAi, chatEvent, chatMessages, safetyNoteFor, transportMessage, userMessage } from '../../services/ai';
import {
  AssistantReply,
  ProposedCourse,
  buildChangeInput,
  buildSystemPrompt,
  parseAssistantReply,
  summarizeChange,
} from '../../services/timetable/assistant';
import {
  AppliedChange,
  ApplyStep,
  NOTICE_FEATURE,
  NOTICE_UNDO_MS,
  NoticeChange,
  applyPlan,
  buildNoticePrompt,
  invertPlan,
  parseNoticeReply,
} from '../../services/timetable/notice';
import { loadPlan } from '../../services/goals/plan';
import { SavedPlanView, savedPlanView } from '../../services/goals/saved';
import { TimetableIntent, consumeTimetableIntent, openUiTab } from '../../ui/navigation';
import {
  DayChip,
  DayView,
  dateTextOf,
  presentDayChips,
  presentDayView,
  presentWeekGrid,
  scrollLeftForWeekday,
} from '../../ui/timetable/present';

type Status = 'loading' | 'empty' | 'ready' | 'error';
/** 周课表 / 每日安排（设计图 02 的 seg）。旧测试的 grid/list 值仍被接受并映射过来。 */
type ViewMode = 'week' | 'day';

interface DatasetEvent {
  currentTarget: { dataset: { id?: string; name?: string; mode?: string; index?: number; weekday?: number; ask?: string } };
}

interface PickerEvent {
  detail: { value: string | number };
}

interface InputEvent {
  detail: { value?: unknown };
}

interface Query {
  today?: string;
  clock?: string;
  ask?: string;
  week?: string;
  planDate?: string;
}

/** 待确认的变更：`content` 是确认框要展示的「当前值 → 变更后」摘要。 */
interface PendingChange {
  action: 'add' | 'update';
  courseId: string;
  course: ProposedCourse;
  content: string;
}

interface WeekInputs {
  settings: TimetableSettings;
  today: string;
  clockMinutes: number;
}

/** 详情弹层要展示的一条课程：颜色来自色板，其余按既有口径算文案。 */
interface SheetCourse {
  id: string;
  name: string;
  solid: string;
  tint: string;
  sectionLabel: string;
  weekLabel: string;
  teacher: string;
  location: string;
  campus: string;
  siteNumber: string;
  note: string;
  sourceLabel: string;
  updatedAtText: string;
  rawText: string;
  needsReview: boolean;
  warningText: string;
  timeLabel: string;
  timeNote: string;
  dateText: string;
}

interface SheetMember {
  id: string;
  name: string;
  sectionLabel: string;
}

interface NoticeRow extends NoticeChange {
  requestId?: string;
  index: number;
  checked: boolean;
  status: 'saved' | 'failed' | 'pending' | 'skipped';
  statusLabel: string;
}

interface NoticeProposal {
  rows: NoticeRow[];
  checkedCount: number;
}

interface NoticeToast {
  text: string;
  canUndo: boolean;
}

/** 一批应用之后的逐条状态（设计图 39 / 73）。 */
interface NoticeBatch {
  total: number;
  saved: number;
  failed: number;
  pending: number;
  retried: boolean;
  rows: { index: number; courseName: string; title: string; status: string; statusLabel: string; detail: string }[];
}

/** 结果页（设计图 10 / 72 / 73）：调课已保存、已撤销、或本批完成。 */
interface NoticeResult {
  kind: 'changed' | 'undone' | 'batch';
  title: string;
  intro: string;
  week: number;
  courseName: string;
  afterLine: string;
  originalLine: string;
  locationLine: string;
  canUndo: boolean;
  rows: { name: string; status: string; summary: string }[];
}

const SOURCE_LABELS: Record<Course['source'], string> = {
  manual: '手工新增',
  photo: '截图识别',
  excel: '导入（Excel）',
};

const ASSISTANT_WELCOME = '你好，我是课表助手。你可以问我课表问题，比如「周三第几节有课」，也可以让我帮你加课、改课——改动都会先给你确认，确认后才生效。';
const ASSISTANT_NOTE = '回答只依据你当前保存的课表；任何增改都会先给你确认，确认后才生效。';
const NOTICE_INPUT_MAX = 4000;
const NOTICE_HINT = '贴一段班群通知，我按当前课表找出要改的地方，逐条列给你确认；点「应用」之前不会动课表。';
const NOTICE_FOOTER = '每条都附原文依据；冲突项默认不勾选。确认前不写入课表，应用后 10 秒内可撤销。';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function localToday(): string {
  const at = new Date();
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function localMinutes(): number {
  const at = new Date();
  return at.getHours() * 60 + at.getMinutes();
}

function decodedText(raw: string): string {
  if (raw.indexOf('%') < 0) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function pickerIndex(value: string | number): number {
  const index = Number(value);
  return Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0;
}

function setupHintFor(settings: TimetableSettings, hasTimes: boolean, loadError: string): string {
  if (loadError !== '') return `课表设置暂时读不到（${loadError}），先按节次展示。`;
  const missingDate = settings.startDate === '';
  if (missingDate && !hasTimes) return '还没设置开学日与作息时间。设置后才知道今天是第几周，也才能显示「正在上/下一节」。';
  if (missingDate) return '还没设置开学日。设置后才知道今天是第几周、本周是几月几号。';
  if (!hasTimes) return '还没填作息时间。填了才会显示具体时刻与「正在上/下一节」。';
  return '';
}

function todayItems(courses: Course[], week: number, weekday: number): TodayItem[] {
  if (weekday < 1 || weekday > 7) return [];
  const items: TodayItem[] = [];
  for (const course of coursesForWeek(courses, week)) {
    if (course.weekday !== weekday) continue;
    for (const range of course.sectionRanges) {
      if (range.start < 1 || range.end < range.start) continue;
      items.push({
        key: `${course.id}:${range.start}`,
        courseId: course.id,
        name: course.name,
        location: course.location,
        teacher: course.teacher,
        start: range.start,
        end: range.end,
      });
    }
  }
  return items;
}

function sectionTextOf(start: number, end: number): string {
  if (start < 1 || end < start) return '';
  return start === end ? `第 ${start} 节` : `第 ${start}-${end} 节`;
}

function rangeTextOf(input: CourseInput): string {
  const first = input.sectionRanges[0];
  if (first !== undefined) return sectionTextOf(first.start, first.end);
  return sectionTextOf(input.startSection, input.endSection);
}

function timeRangeTextOf(settings: TimetableSettings, input: CourseInput): string {
  const first = input.sectionRanges[0];
  if (first === undefined) return '';
  const from = sectionTimeAt(settings, first.start);
  const to = sectionTimeAt(settings, first.end);
  if (from === null || to === null) return '';
  return `${from.start} – ${to.end}`;
}

function courseInputText(input: CourseInput): string {
  return [weekdayLabel(input.weekday), rangeTextOf(input), input.location].filter((part) => part !== '').join(' · ');
}

/** 变化提示条只留「谁、哪天、第几节、哪」；完整前后对比在结果页里。 */
function shortChangeText(input: CourseInput): string {
  return [input.name, weekdayLabel(input.weekday), rangeTextOf(input), input.location]
    .filter((part) => part !== '').join(' · ');
}

function noticeProposalOf(rows: NoticeRow[]): NoticeProposal {
  return { rows, checkedCount: rows.filter((row) => row.checked && row.blocked === '').length };
}

function changeOf(row: NoticeRow): NoticeChange {
  const { index, checked, status, statusLabel, ...change } = row;
  return change;
}

/** 提案行的逐条状态：已保存/失败/待重试/未勾选，页面按此画设计图 39 的每项状态。 */
function withStatuses(
  rows: NoticeRow[],
  saved: Set<number>,
  failed: number | null,
  retried: boolean,
  previouslySaved: Set<number> = new Set<number>(),
): NoticeRow[] {
  return rows.map((row) => {
    if (saved.has(row.index)) {
      const status: NoticeRow['status'] = 'saved';
      const label = previouslySaved.has(row.index) ? '先前已保存' : retried ? '重试后已保存' : '已保存';
      return {
        ...row,
        status,
        statusLabel: label,
        checked: false,
        blocked: row.blocked === '' ? '这条已应用，请勿重复写入；需要还原时可点撤销。' : row.blocked,
      };
    }
    if (failed !== null && row.index === failed) {
      const status: NoticeRow['status'] = 'failed';
      return { ...row, status, statusLabel: '保存未完成' };
    }
    const status: NoticeRow['status'] = row.checked && row.blocked === '' ? 'pending' : 'skipped';
    return { ...row, status, statusLabel: status === 'pending' ? '待重试' : row.blocked !== '' ? '未应用' : '未勾选' };
  });
}

/** 通知应用后的批次汇总：已保存的行在重试时仍可见，失败/待重试标出具体改动。 */
function batchOf(rows: NoticeRow[], retried: boolean): NoticeBatch {
  const saved = rows.filter((row) => row.status === 'saved');
  const failed = rows.filter((row) => row.status === 'failed');
  const pending = rows.filter((row) => row.status === 'pending');
  return {
    total: rows.filter((row) => row.status !== 'skipped').length,
    saved: saved.length,
    failed: failed.length,
    pending: pending.length,
    retried,
    rows: rows.filter((row) => row.status !== 'skipped').map((row) => ({
      index: row.index,
      courseName: row.courseName,
      title: row.title,
      status: row.status,
      statusLabel: row.statusLabel,
      detail: row.detail,
    })),
  };
}

/** 从「当前课表里新出现的课程」定位限定周次调课拆出来的那一节，只用于打标记。 */
function findScopedIds(courses: Course[], beforeIds: Set<string>, input: CourseInput, week: number): string[] {
  const first = input.sectionRanges[0];
  return courses.filter((course) => !beforeIds.has(course.id)
    && course.name === input.name
    && course.weeks.length === 1 && course.weeks[0] === week
    && (first === undefined || course.sectionRanges.some((range) => range.start === first.start && range.end === first.end))
    && (input.location === '' || course.location === input.location)).map((course) => course.id);
}

function scopeWeekOf(rows: NoticeRow[], fallback: number): number {
  for (const row of rows) {
    if (row.weeks.length > 0 && row.weeks[0] >= 1) return row.weeks[0];
  }
  return fallback;
}

function toSheet(course: Course, settings: TimetableSettings, week: number): SheetCourse {
  const color = courseColor(course.name, course.color ?? '');
  const first = course.sectionRanges[0];
  const from = first === undefined ? null : sectionTimeAt(settings, first.start);
  const to = first === undefined ? null : sectionTimeAt(settings, first.end);
  const timeLabel = from === null || to === null ? '' : `${from.start} – ${to.end}`;
  return {
    id: course.id,
    name: course.name,
    solid: color.solid,
    tint: color.tint,
    sectionLabel: sectionLabelOf(course),
    weekLabel: weekLabelOf(course),
    teacher: course.teacher,
    location: course.location,
    campus: course.campus,
    siteNumber: course.siteNumber,
    note: course.note,
    sourceLabel: SOURCE_LABELS[course.source],
    updatedAtText: formatUpdatedAt(course.updatedAt),
    rawText: course.rawText,
    needsReview: course.warnings.length > 0,
    warningText: course.warnings.join('；'),
    timeLabel,
    timeNote: timeLabel === ''
      ? '具体时刻来自你填写的作息。未填作息时，只显示节次。'
      : '具体时刻来自你填写的作息。',
    dateText: dateTextOf(settings, week, course.weekday),
  };
}

Page({
  data: {
    savedPlanPanel: savedPlanView(null, [], emptySettings(), '', false) as SavedPlanView,
    status: 'loading' as Status,
    errorMessage: '',
    courses: [] as Course[],
    count: 0,
    semester: '',
    semesterText: '',
    weekdayShort: WEEKDAY_SHORT,
    updatedAtText: '',
    week: 1,
    weekOptions: [] as number[],
    weekIndex: 0,
    view: { week: 1, weekLabel: '第 1 周', rows: [], days: [], total: 0 } as WeekView,
    grid: buildGrid([], 1),
    gridUi: presentWeekGrid(buildGrid([], 1)),
    gridExpanded: false,
    viewMode: 'week' as ViewMode,
    selectedWeekday: 1,
    dayChips: [] as DayChip[],
    dayView: null as DayView | null,
    scrollLeft: 0,
    weekRange: '',
    settings: emptySettings() as TimetableSettings,
    settingsError: '',
    setupHint: '',
    todayBar: null as TodaySummary | null,
    intentNotice: '',
    changeStrip: null as { label: string; detail: string } | null,
    highlightIds: [] as string[],
    sheetOpen: false,
    sheetCourse: null as SheetCourse | null,
    sheetMembers: [] as SheetMember[],
    fileGuide: FILE_GUIDE,
    offlineNote: OFFLINE_NOTE,
    assistantOpen: false,
    assistantMessages: [] as ChatMessage[],
    assistantInput: '',
    assistantSending: false,
    assistantError: '',
    assistantCapWarning: '',
    assistantSafetyNote: '',
    assistantNote: ASSISTANT_NOTE,
    pendingChange: null as PendingChange | null,
    changeApplying: false,
    noticeOpen: false,
    noticeInput: '',
    noticeReading: false,
    noticeError: '',
    noticeHint: NOTICE_HINT,
    noticeFooter: NOTICE_FOOTER,
    noticeProposal: null as NoticeProposal | null,
    noticeToast: null as NoticeToast | null,
    noticeDetailOpen: false,
    noticeEditing: false,
    noticeDraft: '',
    noticeBatch: null as NoticeBatch | null,
    noticeResult: null as NoticeResult | null,
    noticeRetried: false,
    noticeApplying: false,
  },
  today: '',
  clockMinutes: 0,
  /** 学生自己翻过周次之后就不再自动跳到本周（否则每次 onShow 都把他拽回来）。 */
  weekPinned: false,
  /** 学生自己选过某一天后，切周也尊重这个选择；没选过时落在今天。 */
  dayPinned: false,
  /** 旧启动 query 只应用一次：之后的新导航只走公共导航意图。 */
  startupPlanDate: '',
  startupWeek: null as number | null,
  startupApplied: false,
  /** 已写入成功、还能撤销的那些（10 秒窗口内有效）。 */
  undoStack: [] as AppliedChange[],
  undoTimer: null as number | null,
  /** 本轮应用/撤销涉及的周次，用于返回对应周与标出变化。 */
  lastChangeWeek: 0,
  applyNoticeTargetWeek: 0,

  toggleGridExpansion() {
    const expanded = !this.data.gridExpanded;
    const gridUi = presentWeekGrid(this.data.grid, { expanded, highlightIds: this.data.highlightIds });
    this.setData({ gridExpanded: expanded, gridUi });
  },
  onLoad(query: Query) {
    const injectedToday = typeof query.today === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(query.today) ? query.today : '';
    this.today = injectedToday === '' ? localToday() : injectedToday;
    const injectedClock = typeof query.clock === 'string' ? minutesOfClock(query.clock) : null;
    this.clockMinutes = injectedClock === null ? localMinutes() : injectedClock;
    // 旧启动 query：有效则只在本页首次进入生效；之后由公共导航意图接管。
    this.startupPlanDate = typeof query.planDate === 'string' && weekdayOf(query.planDate) !== null ? query.planDate : '';
    const selectedWeek = Number(query.week);
    if (Number.isInteger(selectedWeek) && selectedWeek >= 1 && selectedWeek <= 30) {
      this.startupWeek = selectedWeek;
      this.weekPinned = true;
      this.setData({ week: selectedWeek, weekIndex: selectedWeek - 1 });
    }
    const rawAsk = typeof query.ask === 'string' ? query.ask : '';
    const ask = decodedText(rawAsk).trim().slice(0, NOTICE_INPUT_MAX);
    if (ask !== '') {
      this.openAssistant();
      this.setData({ assistantInput: ask });
    }
  },
  /** 从导入页或编辑页返回时也走这里，保证展示的是云端最新数据。 */
  onShow() {
    this.setData({ savedPlanPanel: savedPlanView(loadPlan(), this.data.courses, this.data.settings, this.today, false, this.data.week) });
    return this.load();
  },
  load() {
    if (this.data.count === 0) this.setData({ status: 'loading', errorMessage: '' });
    return Promise.all([listCourses(), loadSettings().catch(() => emptySettings() as LoadedSettings)])
      .then(([feed, loaded]) => {
        const courses = feed.courses;
        const settings: TimetableSettings = loaded;
        const options = Array.from({ length: weekSpanWithSemester(courses, settings) }, (_, index) => index + 1);
        const todayWeek = weekIndexOf({ startDate: settings.startDate, totalWeeks: settings.totalWeeks }, this.today);
        let week = this.data.week;
        let weekPinned = this.weekPinned;
        let intentNotice = '';

        // 旧启动 query 的学期日期映射：只应用一次；映射不了就说明，不强行落到第 1 周。
        if (!this.startupApplied) {
          this.startupApplied = true;
          if (this.startupWeek !== null) {
            if (this.startupWeek >= 1 && this.startupWeek <= options.length) {
              week = this.startupWeek;
              weekPinned = true;
            } else {
              intentNotice = `启动参数里的第 ${this.startupWeek} 周不在当前课表范围，已保留当前周。`;
            }
          }
          if (this.startupPlanDate !== '') {
            const mapped = weekIndexOf(settings, this.startupPlanDate);
            if (mapped === null) {
              intentNotice = settings.startDate === ''
                ? '还没设置开学日，无法按日期定位学习计划；设置第一周星期一后会按实际日历对应。'
                : `学习计划日期 ${this.startupPlanDate} 不在当前学期范围内，无法对应到某一周。`;
            } else {
              week = mapped;
              weekPinned = true;
              this.weekPinned = true;
            }
            this.startupPlanDate = '';
          }
        }

        // 公共导航意图：只在课程与设置读完以后消费一次；不自动调用模型、不写课表。
        const intent: TimetableIntent | null = consumeTimetableIntent();
        if (intent !== null) {
          if (intent.kind === 'assistant') {
            this.openAssistant();
            if (intent.text !== undefined && intent.text !== '') this.setData({ assistantInput: intent.text });
            intentNotice = '';
          } else if (intent.kind === 'week') {
            if (intent.week >= 1 && intent.week <= options.length) {
              week = intent.week;
              weekPinned = true;
              this.weekPinned = true;
              intentNotice = '';
            } else {
              intentNotice = `导航要打开第 ${intent.week} 周，但当前课表只有 ${options.length} 周；已保留当前周。`;
            }
          } else {
            const mapped = weekIndexOf(settings, intent.planDate);
            if (mapped === null) {
              intentNotice = settings.startDate === ''
                ? '还没设置开学日，无法按日期定位学习计划；请先在课表设置里填写第一周星期一。'
                : `学习计划日期 ${intent.planDate} 不在当前学期范围内，没有强行当作第 1 周。`;
            } else {
              week = mapped;
              weekPinned = true;
              this.weekPinned = true;
              intentNotice = '';
            }
          }
        }

        if (!weekPinned) week = todayWeek ?? 1;
        week = Math.min(Math.max(week, 1), options.length);
        const isThisWeek = todayWeek !== null && todayWeek === week;
        const todayWeekday = isThisWeek ? (weekdayOf(this.today) ?? 0) : 0;
        const patch = this.weekPatch(courses, week, { settings, today: this.today, clockMinutes: this.clockMinutes }, {
          todayWeekday,
          gridExpanded: this.data.gridExpanded,
          selectedWeekday: this.dayPinned ? this.data.selectedWeekday : (todayWeekday >= 1 ? todayWeekday : 1),
          highlightIds: this.data.highlightIds,
        });
        this.setData({
          courses,
          count: feed.count,
          semester: feed.semester,
          semesterText: semesterLabel(feed.semester),
          updatedAtText: formatUpdatedAt(feed.updatedAt),
          weekOptions: options,
          weekIndex: week - 1,
          settings,
          settingsError: loaded.loadError ?? '',
          setupHint: setupHintFor(settings, hasSectionTimes(settings), loaded.loadError ?? ''),
          ...patch,
          status: courses.length === 0 ? 'empty' : 'ready',
          errorMessage: '',
          intentNotice,
          savedPlanPanel: savedPlanView(loadPlan(), courses, settings, this.today, true, week),
        });
      })
      .catch((error) => {
        this.setData({
          status: 'error',
          errorMessage: messageOf(error),
          savedPlanPanel: savedPlanView(loadPlan(), [], this.data.settings, this.today, false, this.data.week),
        });
      });
  },
  retry() {
    return this.load();
  },
  /** 同一份课程，换的只是「看哪一周」；网格、日视图、日期区间与速查条一起重算。 */
  weekPatch(courses: Course[], week: number, inputs: WeekInputs, options: {
    todayWeekday: number;
    gridExpanded: boolean;
    selectedWeekday: number;
    highlightIds: string[];
  }) {
    const config = { startDate: inputs.settings.startDate, totalWeeks: inputs.settings.totalWeeks };
    const isThisWeek = options.todayWeekday >= 1 && options.todayWeekday <= 7;
    const hasTimes = hasSectionTimes(inputs.settings);
    const nowSection = isThisWeek && hasTimes ? currentSectionAt(inputs.settings, inputs.clockMinutes) : null;
    const grid = buildGrid(courses, week, {
      dateLabels: weekDateLabels(config, week),
      todayWeekday: isThisWeek ? options.todayWeekday : 0,
      ...(nowSection === null ? {} : { nowSection }),
    });
    const selectedWeekday = options.selectedWeekday >= 1 && options.selectedWeekday <= 7
      ? options.selectedWeekday
      : (isThisWeek ? options.todayWeekday : 1);
    return {
      week,
      view: buildWeekView(courses, week, {
        dateLabels: weekDateFullLabels(config, week),
        todayWeekday: isThisWeek ? options.todayWeekday : 0,
      }),
      grid,
      gridUi: presentWeekGrid(grid, { expanded: options.gridExpanded, highlightIds: options.highlightIds }),
      gridExpanded: options.gridExpanded,
      weekRange: formatWeekRange(config, week),
      selectedWeekday,
      dayChips: presentDayChips(courses, week, inputs.settings, isThisWeek ? options.todayWeekday : 0),
      dayView: presentDayView(courses, week, selectedWeekday, inputs.settings, {
        highlightIds: options.highlightIds,
        todayWeekday: isThisWeek ? options.todayWeekday : 0,
      }),
      todayBar: isThisWeek && hasTimes
        ? summarizeToday(todayItems(courses, week, options.todayWeekday), inputs.settings, inputs.clockMinutes)
        : null,
    };
  },
  patchWeek(week: number) {
    if (week < 1 || week > this.data.weekOptions.length) return {};
    const isThisWeek = weekIndexOf(this.data.settings, this.today) === week;
    const todayWeekday = isThisWeek ? (weekdayOf(this.today) ?? 0) : 0;
    return {
      ...this.weekPatch(this.data.courses, week, {
        settings: this.data.settings,
        today: this.today,
        clockMinutes: this.clockMinutes,
      }, {
        todayWeekday,
        gridExpanded: this.data.gridExpanded,
        selectedWeekday: this.dayPinned ? this.data.selectedWeekday : (todayWeekday >= 1 ? todayWeekday : 1),
        highlightIds: this.data.highlightIds,
      }),
      weekIndex: week - 1,
      savedPlanPanel: savedPlanView(loadPlan(), this.data.courses, this.data.settings, this.today, true, week),
    };
  },
  openSavedPlan() {
    wx.navigateTo({ url: '/pages/goals/plan/index' });
  },
  selectWeek(event: PickerEvent) {
    const index = pickerIndex(event.detail.value);
    const week = this.data.weekOptions[index];
    if (week === undefined) return;
    this.weekPinned = true;
    this.setData({ weekIndex: index, ...this.patchWeek(week) });
  },
  previousWeek() {
    return this.shiftWeek(-1);
  },
  nextWeek() {
    return this.shiftWeek(1);
  },
  shiftWeek(delta: number) {
    const index = this.data.weekIndex + delta;
    if (index < 0 || index >= this.data.weekOptions.length) return;
    const week = this.data.weekOptions[index];
    this.weekPinned = true;
    this.setData({ weekIndex: index, ...this.patchWeek(week) });
  },
  /** 周课表 / 每日安排切换：只换渲染，不重新读云端，也不改数据。 */
  switchView(event: DatasetEvent) {
    const raw = event.currentTarget.dataset.mode;
    const mode: ViewMode | null = raw === 'week' || raw === 'grid' ? 'week' : raw === 'day' || raw === 'list' ? 'day' : null;
    if (mode === null) return;
    this.setData({ viewMode: mode });
  },
  selectDay(event: DatasetEvent) {
    const weekday = Number(event.currentTarget.dataset.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return;
    const isThisWeek = weekIndexOf(this.data.settings, this.today) === this.data.week;
    this.dayPinned = true;
    this.setData({
      selectedWeekday: weekday,
      dayView: presentDayView(this.data.courses, this.data.week, weekday, this.data.settings, {
        highlightIds: this.data.highlightIds,
        todayWeekday: isThisWeek ? (weekdayOf(this.today) ?? 0) : 0,
      }),
    });
  },
  openImport() {
    this.weekPinned = true;
    wx.navigateTo({ url: '/pages/timetable/import/index' });
  },
  openCreate() {
    wx.navigateTo({ url: `/pages/timetable/edit/index?scope=new&semester=${encodeURIComponent(this.data.semester)}` });
  },
  openSettings() {
    wx.navigateTo({ url: '/pages/timetable/settings/index' });
  },
  openManage() {
    this.weekPinned = true;
    wx.navigateTo({ url: `/pages/timetable/manage/index?week=${this.data.week}` });
  },
  openEdit(event: DatasetEvent) {
    const id = event.currentTarget.dataset.id;
    if (id === undefined || id === '') return;
    this.weekPinned = true;
    wx.navigateTo({ url: `/pages/timetable/edit/index?scope=saved&id=${encodeURIComponent(id)}` });
  },
  openSheet(event: DatasetEvent) {
    const id = event.currentTarget.dataset.id;
    if (id === undefined || id === '') return;
    this.showSheet(id);
  },
  showSheet(id: string) {
    const course = this.data.courses.find((item) => item.id === id);
    if (course === undefined) return;
    this.setData({
      sheetOpen: true,
      sheetCourse: toSheet(course, this.data.settings, this.data.week),
      sheetMembers: this.membersOf(id),
    });
  },
  closeSheet() {
    this.setData({ sheetOpen: false, sheetCourse: null, sheetMembers: [] });
  },
  membersOf(courseId: string): SheetMember[] {
    for (const column of this.data.grid.columns) {
      for (const block of column.blocks) {
        if (block.ids.length < 2 || !block.ids.includes(courseId)) continue;
        return block.ids.map((id) => {
          const found = this.data.courses.find((course) => course.id === id);
          return {
            id,
            name: found === undefined ? '' : found.name,
            sectionLabel: block.start === block.end ? `第 ${block.start} 节` : `第 ${block.start}-${block.end} 节`,
          };
        });
      }
    }
    return [];
  },
  pickSheetMember(event: DatasetEvent) {
    const id = event.currentTarget.dataset.id;
    if (id === undefined || id === '') return;
    this.showSheet(id);
  },
  editSheetCourse() {
    const course = this.data.sheetCourse;
    if (course === null) return;
    this.weekPinned = true;
    wx.navigateTo({ url: `/pages/timetable/edit/index?scope=saved&id=${encodeURIComponent(course.id)}` });
  },
  removeSheetCourse() {
    const course = this.data.sheetCourse;
    if (course === null) return;
    this.confirmRemove(course.id, course.name);
  },
  removeCourse(event: DatasetEvent) {
    const id = event.currentTarget.dataset.id;
    const name = event.currentTarget.dataset.name ?? '';
    if (id === undefined || id === '') return;
    this.confirmRemove(id, name);
  },
  /** 删除一律先确认：确认框写清后果，取消不写任何数据。 */
  confirmRemove(id: string, name: string) {
    wx.showModal({
      title: '删除课程',
      content: `确定删除「${name}」吗？删除后需要重新导入或手工添加，不能从这里撤销。`,
      confirmText: '删除',
      success: (result) => {
        if (!result.confirm) return;
        deleteCourse(id)
          .then(() => {
            wx.showToast({ title: '已删除', icon: 'success' });
            this.setData({ sheetOpen: false, sheetCourse: null, sheetMembers: [] });
            return this.load();
          })
          .catch((error) => wx.showToast({ title: messageOf(error), icon: 'none' }));
      },
    });
  },
  openAssistant() {
    if (this.data.assistantOpen) return;
    this.setData({
      assistantOpen: true,
      assistantMessages: [{ role: 'assistant', text: ASSISTANT_WELCOME }],
      assistantError: '',
      assistantCapWarning: '',
      assistantSafetyNote: '',
    });
  },
  openNoticeEntry() {
    this.openAssistant();
    this.setData({ noticeOpen: true, noticeError: '', noticeResult: null, noticeBatch: null });
  },
  closeAssistant() {
    this.setData({ assistantOpen: false });
  },
  onAssistantInput(event: InputEvent) {
    const raw = event.detail === undefined ? '' : event.detail.value;
    this.setData({ assistantInput: typeof raw === 'string' ? raw : '' });
  },
  /** 示例问句只预填，不自动发送；学生可以改措辞再决定。 */
  pickPrompt(event: DatasetEvent) {
    const ask = event.currentTarget.dataset.ask ?? '';
    const text = typeof ask === 'string' ? ask : '';
    if (text !== '') this.setData({ assistantInput: text });
  },
  sendAssistant() {
    const text = this.data.assistantInput.trim();
    if (text === '' || this.data.assistantSending) return;
    const history: ChatMessage[] = this.data.assistantMessages.concat([{ role: 'user', text }]);
    this.setData({
      assistantMessages: history,
      assistantInput: '',
      assistantSending: true,
      assistantError: '',
      assistantSafetyNote: '',
    });
    const system = buildSystemPrompt(this.data.courses, this.data.semester, this.data.week, this.data.weekOptions.length);
    return callAi(chatEvent('timetable-assistant', system, chatMessages(history, system)))
      .then((result) => {
        if (!result.ok) {
          this.setData({
            assistantSending: false,
            assistantError: userMessage(result),
            assistantCapWarning: result.capWarning,
            assistantSafetyNote: '',
          });
          return;
        }
        const reply: AssistantReply = parseAssistantReply(result.text);
        const safetyNote = safetyNoteFor(result.safety);
        if (reply.kind === 'change') {
          const current = reply.action === 'update'
            ? this.data.courses.find((course) => course.id === reply.courseId)
            : null;
          if (reply.action === 'update' && current === undefined) {
            this.setData({
              assistantSending: false,
              assistantCapWarning: result.capWarning,
              assistantSafetyNote: safetyNote,
              assistantMessages: history.concat([{ role: 'assistant', text: '助手指向的课程不在当前课表里，已忽略这次改动，请换个说法。' }]),
            });
            return;
          }
          const summary = summarizeChange(reply.course, reply.action, current ?? null);
          if (!summary.changed) {
            this.setData({
              assistantSending: false,
              assistantCapWarning: result.capWarning,
              assistantSafetyNote: safetyNote,
              assistantMessages: history.concat([{ role: 'assistant', text: summary.text }]),
            });
            return;
          }
          this.setData({
            assistantSending: false,
            assistantCapWarning: result.capWarning,
            assistantSafetyNote: safetyNote,
            pendingChange: { action: reply.action, courseId: reply.courseId, course: reply.course, content: summary.text },
          });
          this.confirmChange();
          return;
        }
        this.setData({
          assistantSending: false,
          assistantCapWarning: result.capWarning,
          assistantSafetyNote: safetyNote,
          assistantMessages: history.concat([{ role: 'assistant', text: reply.message }]),
        });
      })
      .catch((error) => {
        this.setData({ assistantSending: false, assistantError: transportMessage(error) });
      });
  },
  confirmChange() {
    if (this.data.changeApplying) return;
    const pending = this.data.pendingChange;
    if (pending === null) return;
    const change = pending;
    wx.showModal({
      title: '确认课表变更',
      content: change.content,
      confirmText: change.action === 'add' ? '添加' : '修改',
      success: (result) => {
        if (result.confirm) return this.applyChange(change);
        this.setData({
          pendingChange: null,
          assistantMessages: this.data.assistantMessages.concat([{ role: 'assistant', text: '已取消这次改动，课表没有变化。' }]),
        });
      },
    });
  },
  applyChange(change: PendingChange) {
    if (this.data.changeApplying) return;
    const current = change.action === 'update'
      ? this.data.courses.find((course) => course.id === change.courseId)
      : null;
    if (change.action === 'update' && current === undefined) {
      this.setData({
        pendingChange: null,
        assistantMessages: this.data.assistantMessages.concat([{ role: 'assistant', text: '助手指向的课程不在当前课表里，已忽略这次改动，请换个说法。' }]),
      });
      return;
    }
    const input = buildChangeInput(change.course, current ?? null);
    this.setData({ changeApplying: true, pendingChange: null });
    const task = change.action === 'add'
      ? createCourse(input, this.data.semester)
      : updateCourse(change.courseId, input);
    return task
      .then((created) => {
        const createdId = change.action === 'add' && created !== undefined && typeof created.id === 'string'
          ? created.id
          : change.courseId;
        const targetWeek = input.weeks.length > 0 ? input.weeks[0] : this.data.week;
        this.weekPinned = true;
        this.setData({
          changeApplying: false,
          assistantMessages: this.data.assistantMessages.concat([{ role: 'assistant', text: '已按确认的内容更新课表。' }]),
          highlightIds: createdId === '' ? [] : [createdId],
          changeStrip: { label: '已保存 · 本次调整', detail: courseInputText(input) },
          week: targetWeek,
          weekIndex: Math.max(0, targetWeek - 1),
        });
        return this.load().then(() => {
          this.setData({ scrollLeft: scrollLeftForWeekday(input.weekday) });
        });
      })
      .catch((error) => {
        this.setData({
          changeApplying: false,
          assistantMessages: this.data.assistantMessages.concat([{ role: 'assistant', text: '保存没有成功：' + messageOf(error) }]),
        });
      });
  },

  // —— 贴通知：粘贴 → 提案 → 逐条勾选 → 应用 → 10 秒撤销（设计图 08–10、39、70–73） ——
  toggleNotice() {
    this.setData({ noticeOpen: !this.data.noticeOpen, noticeError: '' });
  },
  onNoticeInput(event: InputEvent) {
    this.setData({ noticeInput: String(event.detail.value ?? ''), noticeError: '' });
  },
  onNoticeDraftInput(event: InputEvent) {
    this.setData({ noticeDraft: String(event.detail.value ?? '') });
  },
  toggleNoticeDetail() {
    this.setData({ noticeDetailOpen: !this.data.noticeDetailOpen });
  },
  /** 设计图 70：原通知可改回再核对；原提案保留，改完取消不会丢。 */
  editNotice() {
    this.setData({ noticeEditing: true, noticeDraft: this.data.noticeInput, noticeError: '' });
  },
  keepProposal() {
    this.setData({ noticeEditing: false, noticeError: '' });
  },
  rereadNotice() {
    const text = this.data.noticeDraft.trim();
    this.setData({ noticeEditing: false, noticeInput: this.data.noticeDraft });
    return this.readNoticeText(text);
  },
  readNotice() {
    return this.readNoticeText(this.data.noticeInput.trim());
  },
  readNoticeText(text: string) {
    if (text === '' || this.data.noticeReading) return;
    if (text.length > NOTICE_INPUT_MAX) {
      this.setData({ noticeError: `这段字太多了（${text.length} 字），一次最多贴 ${NOTICE_INPUT_MAX} 字，可以分几次贴。` });
      return;
    }
    this.clearUndoTimer();
    this.undoStack = [];
    this.setData({
      noticeReading: true,
      noticeError: '',
      noticeToast: null,
      noticeResult: null,
      noticeBatch: null,
      noticeRetried: false,
      noticeInput: text,
      noticeDraft: text,
    });
    const system = buildNoticePrompt(this.data.courses, this.data.semester, this.data.week, this.data.weekOptions.length);
    return callAi(chatEvent(NOTICE_FEATURE, system, chatMessages([{ role: 'user', text }], system)))
      .then((result) => {
        if (!result.ok) {
          this.setData({ noticeReading: false, noticeError: userMessage(result) });
          return;
        }
        const reply = parseNoticeReply(result.text, this.data.courses, this.data.weekOptions.length,
          weekIndexOf(this.data.settings, this.today) ?? 0);
        const safetyNote = safetyNoteFor(result.safety);
        if (reply.kind !== 'changes') {
          this.setData({
            noticeReading: false,
            noticeProposal: null,
            noticeError: safetyNote === '' ? reply.message : `${reply.message}（${safetyNote}）`,
          });
          return;
        }
        this.setData({
          noticeReading: false,
          noticeError: safetyNote,
          noticeProposal: noticeProposalOf(reply.changes.map((change, index) => ({
            ...change,
            index,
            checked: change.defaultChecked,
            status: change.defaultChecked ? 'pending' : 'skipped',
            statusLabel: change.defaultChecked ? '待确认' : '未勾选',
          }))),
        });
      })
      .catch((error) => {
        this.setData({ noticeReading: false, noticeError: transportMessage(error) });
      });
  },
  toggleNoticeRow(event: DatasetEvent) {
    const proposal = this.data.noticeProposal;
    if (proposal === null || this.data.noticeApplying) return;
    const index = Number(event.currentTarget.dataset.index);
    const target = proposal.rows[index];
    if (target === undefined) return;
    if (target.blocked !== '') {
      this.setData({ noticeError: '这条没法直接应用：' + target.blocked });
      return;
    }
    if (target.status === 'saved' || target.status === 'failed') {
      this.setData({
        noticeError: target.status === 'saved'
          ? '这条已经保存，不需要重复勾选；需要还原可点撤销。'
          : '这条上次没有保存成功，重试按钮会只重试它。',
      });
      return;
    }
    const rows: NoticeRow[] = proposal.rows.map((row) => (row.index === index ? {
      ...row,
      checked: !row.checked,
      status: (!row.checked ? 'pending' : 'skipped') as NoticeRow['status'],
      statusLabel: !row.checked ? '待确认' : '未勾选',
    } : row));
    this.setData({ noticeProposal: noticeProposalOf(rows), noticeError: '' });
  },
  applyNotice() {
    if (this.data.noticeReading || this.data.noticeApplying) return;
    const proposal = this.data.noticeProposal;
    if (proposal === null) return;
    const picked = proposal.rows.filter((row) => row.checked && row.blocked === '' && row.status !== 'saved');
    if (picked.length === 0) return;
    for (const row of proposal.rows) {
      if (!row.requestId) row.requestId = `notice-${Date.now().toString(36)}-${row.index}-${Math.random().toString(36).slice(2, 12)}`;
    }
    const changes = proposal.rows.map((row) => {
      const change = changeOf(row);
      return row.checked && row.blocked === '' && row.status !== 'saved'
        ? change
        : { ...change, blocked: row.status === 'saved' ? '已保存' : '未勾选' };
    });
    const steps = applyPlan(changes, this.data.courses, this.data.weekOptions.length);
    if (steps.length === 0) {
      this.setData({ noticeError: '这些变更对不上当前课表了，已取消应用。请重新读一次通知。' });
      return;
    }
    const targetWeek = scopeWeekOf(picked, this.data.week);
    const previousApplied = this.undoStack.slice();
    const retried = this.data.noticeRetried;
    const beforeIds = new Set(this.data.courses.map((course) => course.id));
    this.clearUndoTimer();
    this.setData({ noticeReading: true, noticeApplying: true, noticeError: '', noticeToast: null, noticeResult: null, noticeBatch: null });
    this.applyNoticeTargetWeek = targetWeek;
    const applied: AppliedChange[] = [];
    const previouslySaved = new Set<number>(proposal.rows.filter((row) => row.status === 'saved').map((row) => row.index));
    const saved = new Set<number>(previouslySaved);
    let failedIndex: number | null = null;
    let failure = '';

    const write = (step: ApplyStep): Promise<Course | null> => {
      if (step.kind === 'create') return createCourse(step.input, this.data.semester);
      if (step.kind === 'scoped') {
        return applyScopedCourse(step.courseId, step.input, step.before as CourseInput,
          proposal.rows[step.changeIndex].requestId as string).then(() => null);
      }
      if (!this.data.courses.some((course) => course.id === step.courseId)) {
        return Promise.reject(new Error('这条课程已经不在课表里了'));
      }
      return updateCourse(step.courseId, step.input).then(() => null);
    };
    const runStep = (position: number): Promise<void> => {
      if (position >= steps.length) return Promise.resolve();
      const step = steps[position];
      return write(step)
        .then((created) => {
          const courseId = step.kind === 'create' ? String(created === null ? '' : created.id) : step.courseId;
          if (courseId === '') return Promise.reject(new Error('服务端没有返回新课程的编号'));
          applied.push({
            changeIndex: step.changeIndex,
            kind: step.kind,
            operationId: step.kind === 'scoped' ? proposal.rows[step.changeIndex].requestId : undefined,
            courseId,
            before: step.before,
            after: step.input,
            summary: step.summary,
          });
          saved.add(step.changeIndex);
          return runStep(position + 1);
        })
        .catch((error) => {
          // 内层的 catch 先拿到真正失败的那一步；外层 catch 只做透传，不能把下标改成第 1 步。
          if (failedIndex === null) {
            failedIndex = step.changeIndex;
            failure = messageOf(error);
          }
          throw error;
        });
    };

    return runStep(0)
      .then(() => {
        this.undoStack = previousApplied.concat(applied);
        this.armUndoTimer();
        this.setData({
          noticeReading: false,
          noticeApplying: false,
          noticeProposal: noticeProposalOf(withStatuses(proposal.rows, saved, null, retried, previouslySaved)),
          noticeToast: { text: `已更新 ${applied.length} 处，课表已同步`, canUndo: true },
        });
        return this.finishApply(applied, beforeIds, targetWeek, retried, null);
      })
      .catch((error) => {
        const reason = failure === '' ? messageOf(error) : failure;
        const done = applied.length;
        this.undoStack = previousApplied.concat(applied);
        this.armUndoTimer();
        this.setData({
          noticeReading: false,
          noticeApplying: false,
          noticeProposal: noticeProposalOf(withStatuses(proposal.rows, saved, failedIndex, retried, previouslySaved)),
          noticeError: done === 0
            ? (steps.some((step) => step.kind === 'scoped')
              ? `第 1 处保存未确认：${reason}。同一提案重试不会重复拆课。`
              : `第 1 处失败：${reason}。课表没有变化。`)
            : `已应用 ${done} 处，第 ${done + 1} 处失败：${reason}。已保存的不会重复执行，重试只处理未完成项。`,
          noticeToast: this.undoStack.length === 0 ? null : {
            text: `已更新 ${this.undoStack.length} 处，还有 ${steps.length - done} 处没写进去`,
            canUndo: true,
          },
        });
        return this.finishApply(applied, beforeIds, targetWeek, retried, reason ?? messageOf(error));
      });
  },
  /**
   * 应用后的收尾：重读课表、回到目标周、定位新拆出的课程并打标记。
   * 结果页只描述已成功的部分；失败项由 39 的逐条状态与重试入口继续处理。
   */
  async finishApply(applied: AppliedChange[], beforeIds: Set<string>, targetWeek: number, retried: boolean, reason: string | null) {
    this.weekPinned = true;
    this.lastChangeWeek = targetWeek;
    this.setData({ week: targetWeek, weekIndex: Math.max(0, targetWeek - 1) });
    await this.load();
    const highlight = new Set<string>();
    for (const item of applied) {
      if (item.kind === 'scoped') {
        for (const id of findScopedIds(this.data.courses, beforeIds, item.after, targetWeek)) highlight.add(id);
      } else if (item.kind === 'create') {
        if (!beforeIds.has(item.courseId)) highlight.add(item.courseId);
      } else {
        highlight.add(item.courseId);
      }
    }
    const firstScoped = applied.find((item) => item.kind === 'scoped');
    const first = firstScoped ?? applied[0];
    const proposal = this.data.noticeProposal;
    const rows = proposal === null ? [] : proposal.rows;
    const batch = batchOf(rows, retried);
    const allDone = reason === null && batch.failed === 0 && batch.pending === 0;
    const highlightIds = Array.from(highlight);
    const changeStrip = first === undefined ? null : {
      label: `已保存${first.kind === 'scoped' ? ' · 仅第 ' + targetWeek + ' 周' : ''}`,
      detail: first.kind === 'scoped' ? shortChangeText(first.after) : first.summary,
    };
    const resultKind: NoticeResult['kind'] = retried && batch.total > applied.length ? 'batch' : 'changed';
    const batchMode = resultKind === 'batch';
    const result: NoticeResult | null = allDone
      ? {
        kind: resultKind,
        title: batchMode ? `这次，${batch.saved} 项都完成了。` : (firstScoped === undefined ? '课表，已更新。' : `第 ${targetWeek} 周，已调整。`),
        intro: batchMode
          ? '已保存项没有重复执行；刚才待重试的修改已确认成功。'
          : (firstScoped === undefined ? '已按确认的内容写入课表。' : `${firstScoped.after.name} 的新安排已保存。`),
        week: targetWeek,
        courseName: batchMode ? '' : (firstScoped === undefined ? (first === undefined ? '' : first.after.name) : firstScoped.after.name),
        afterLine: batchMode || first === undefined ? '' : `${courseInputText(first.after)}${timeRangeTextOf(this.data.settings, first.after) === '' ? '' : ' · ' + timeRangeTextOf(this.data.settings, first.after)}`,
        originalLine: batchMode || first === undefined || first.before === null ? '' : courseInputText(first.before),
        locationLine: batchMode || first === undefined ? '' : first.after.location,
        canUndo: true,
        rows: batchMode ? batch.rows.map((row) => ({ name: row.courseName, status: row.statusLabel, summary: row.detail })) : [],
      }
      : null;
    this.setData({
      highlightIds,
      gridUi: presentWeekGrid(this.data.grid, { expanded: this.data.gridExpanded, highlightIds }),
      dayView: presentDayView(this.data.courses, this.data.week, this.data.selectedWeekday, this.data.settings, {
        highlightIds,
        todayWeekday: weekIndexOf(this.data.settings, this.today) === this.data.week ? (weekdayOf(this.today) ?? 0) : 0,
      }),
      changeStrip,
      noticeBatch: allDone ? null : batch,
      noticeResult: result,
      noticeRetried: retried,
      noticeToast: this.undoStack.length === 0 ? null : {
        text: reason === null
          ? `已更新 ${this.undoStack.length} 处，课表已同步`
          : `已更新 ${this.undoStack.length} 处，还有 ${batch.failed + batch.pending} 处没写进去`,
        canUndo: true,
      },
    });
    // 横向定位到本次调整的星期：目标课程初始可见（设计图 71）。
    const firstWeekday = first === undefined ? 0 : first.after.weekday;
    if (firstWeekday >= 1) this.setData({ scrollLeft: scrollLeftForWeekday(firstWeekday) });
  },
  retryNotice() {
    this.setData({ noticeRetried: true });
    return this.applyNotice();
  },
  armUndoTimer() {
    this.clearUndoTimer();
    if (typeof setTimeout !== 'function') return;
    this.undoTimer = setTimeout(() => {
      this.undoTimer = null;
      this.undoStack = [];
      this.setData({
        noticeToast: null,
        noticeResult: this.data.noticeResult === null ? null : { ...this.data.noticeResult, canUndo: false },
      });
    }, NOTICE_UNDO_MS);
  },
  clearUndoTimer() {
    if (this.undoTimer === null) return;
    if (typeof clearTimeout === 'function') clearTimeout(this.undoTimer);
    this.undoTimer = null;
  },
  undoNotice() {
    if (this.data.noticeReading || this.data.noticeApplying) return;
    const dirty = this.undoStack.slice();
    if (dirty.length === 0) {
      this.setData({ noticeToast: null });
      return;
    }
    const first = dirty[0];
    const restoredLine = first.before === null ? '' : courseInputText(first.before);
    this.undoStack = [];
    this.clearUndoTimer();
    this.setData({ noticeReading: true, noticeApplying: true, noticeToast: { text: '正在撤销…', canUndo: false } });
    const runStep = (): Promise<void> => {
      if (dirty.length === 0) return Promise.resolve();
      const step = invertPlan([dirty[dirty.length - 1]])[0];
      if (step === undefined) {
        dirty.pop();
        return runStep();
      }
      const task = step.kind === 'scoped' ? undoScopedCourse(step.operationId ?? '') : step.kind === 'delete'
        ? deleteCourse(step.courseId)
        : updateCourse(step.courseId, step.input as CourseInput);
      return task.then(() => { dirty.pop(); return runStep(); });
    };
    return runStep()
      .then(() => {
        this.setData({
          noticeReading: false,
          noticeApplying: false,
          assistantOpen: true,
          noticeToast: { text: '已撤销，课表回到应用前', canUndo: false },
          highlightIds: [],
          gridUi: presentWeekGrid(this.data.grid, { expanded: this.data.gridExpanded, highlightIds: [] }),
          changeStrip: null,
          noticeResult: {
            kind: 'undone',
            title: '这次调课已撤销。',
            intro: first.before === null ? '本次新增的课程已撤回。' : `${first.before.name} 已恢复原安排。`,
            week: this.lastChangeWeek,
            courseName: first.before === null ? first.after.name : first.before.name,
            afterLine: restoredLine,
            originalLine: courseInputText(first.after),
            locationLine: first.before === null ? '' : first.before.location,
            canUndo: false,
            rows: [],
          },
        });
        return this.load().then(() => {
          // 结果页在重读之后打开，确保撤销提示与恢复后的课表同时可见。
          this.setData({ assistantOpen: true });
        });
      })
      .catch((error) => {
        this.undoStack = dirty;
        this.setData({
          noticeReading: false,
          noticeApplying: false,
          noticeToast: { text: `撤销没做完，尚有 ${dirty.length} 处：` + messageOf(error), canUndo: dirty.length > 0 },
        });
        return this.load();
      });
  },
  viewChangedWeek() {
    const week = this.lastChangeWeek > 0 ? this.lastChangeWeek : this.data.week;
    this.weekPinned = true;
    this.setData({
      assistantOpen: false,
      noticeOpen: false,
      noticeResult: null,
      noticeBatch: null,
      viewMode: 'week',
      ...this.patchWeek(week),
    });
    const firstId = this.data.highlightIds[0];
    const course = firstId === undefined ? undefined : this.data.courses.find((item) => item.id === firstId);
    if (course !== undefined) {
      this.setData({ scrollLeft: scrollLeftForWeekday(course.weekday), selectedWeekday: course.weekday }, () => {
        // 让目标课程所在的大节进入视口：保存后不是只给一句 toast，而是直接把变化摆到眼前。
        if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ scrollTop: 330, duration: 200 });
      });
    }
  },
  continueAssistant() {
    this.setData({ noticeResult: null, noticeBatch: null, noticeOpen: true });
  },
  onUnload() {
    this.clearUndoTimer();
    this.undoStack = [];
  },
  goHome() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
      return;
    }
    if (typeof wx.switchTab === 'function') {
      openUiTab('today').catch(() => wx.reLaunch({ url: '/pages/home/index' }));
      return;
    }
    wx.reLaunch({ url: '/pages/home/index' });
  },
});
