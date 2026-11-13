/**
 * 我的课表（Ticket 03）+ 课表 AI 助手（Ticket 06）。
 *
 * 数据来自 `timetable` 云函数（按微信身份隔离），页面每次显示都从云端重读，
 * 因此退出重进、换设备都能看到同一份课表。学校作息未核实，周课表只按节次展示。
 *
 * 助手：查阅只依据当前课表数据；任何增改都是「方案」，必须弹确认框、
 * 学生确认后才走 03 的写入入口；三类失败文案独立，课表展示不受助手失败影响。
 */
import { Course, CourseInput } from '../../services/timetable/types';
import {
  FILE_GUIDE,
  OFFLINE_NOTE,
  createCourse,
  deleteCourse,
  listCourses,
  messageOf,
  updateCourse,
  applyScopedCourse,
  undoScopedCourse,
} from '../../services/timetable/index';
import {
  CourseCard,
  WEEKDAY_SHORT,
  WeekView,
  buildGrid,
  buildWeekView,
  coursesForWeek,
  formatUpdatedAt,
  sectionLabelOf,
  semesterLabel,
  weekLabelOf,
} from '../../services/timetable/view';
import { courseColor } from '../../services/timetable/palette';
import { presentGrid } from '../../services/timetable/presentation';
import {
  LoadedSettings,
  TimetableSettings,
  currentSectionAt,
  emptySettings,
  loadSettings,
  minutesOfClock,
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

type Status = 'loading' | 'empty' | 'ready' | 'error';

/** 网格 / 列表两种视图：网格看「一眼」，列表看「读全」。 */
type ViewMode = 'grid' | 'list';

interface DatasetEvent {
  currentTarget: { dataset: { id?: string; name?: string; mode?: string; index?: number } };
}

interface PickerEvent {
  detail: { value: string | number };
}

interface InputEvent {
  detail: { value?: unknown };
}

/** 待确认的变更：`content` 是确认框要展示的「当前值 → 变更后」摘要。 */
interface PendingChange {
  action: 'add' | 'update';
  courseId: string;
  course: ProposedCourse;
  content: string;
}

/** 选择器变化时的通用取值：picker 的 value 是下标（字符串或数字）。 */
function pickerIndex(value: string | number): number {
  const index = Number(value);
  return Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0;
}

/**
 * 切周时的整块数据：网格与列表都由同一份课程算出来，避免两处口径分叉
 * （`view` 给列表与统计，`grid` 给周网格）。
 *
 * 时间相关的推导都集中在这里，而且**只在「显示的正好是本周」时才给今日标记**：
 * 入学日期与作息都来自用户自己填的设置，没填就没有日期、没有速查条，也不会假装知道现在上什么。
 */
interface WeekInputs {
  settings: TimetableSettings;
  /** 今天，'YYYY-MM-DD'（页面在 onLoad 里定下，测试可注入）。 */
  today: string;
  /** 现在几点（分钟数）。 */
  clockMinutes: number;
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

function weekPatch(courses: Course[], week: number, inputs: WeekInputs) {
  const config = { startDate: inputs.settings.startDate, totalWeeks: inputs.settings.totalWeeks };
  const todayWeek = weekIndexOf(config, inputs.today);
  const weekday = weekdayOf(inputs.today) ?? 0;
  const isThisWeek = todayWeek !== null && todayWeek === week;
  const hasTimes = hasSectionTimes(inputs.settings);
  const nowSection = isThisWeek && hasTimes ? currentSectionAt(inputs.settings, inputs.clockMinutes) : null;
  const grid = buildGrid(courses, week, {
    dateLabels: weekDateLabels(config, week),
    todayWeekday: isThisWeek ? weekday : 0,
    ...(nowSection === null ? {} : { nowSection }),
  });
  return {
    week,
    view: buildWeekView(courses, week, {
      // 列表里的某一天要能单独读懂，所以用完整日期，不用表头的「几号」。
      dateLabels: weekDateFullLabels(config, week),
      todayWeekday: isThisWeek ? weekday : 0,
    }),
    grid,
    gridUi: presentGrid(grid),
    gridExpanded: false,
    weekRange: formatWeekRange(config, week),
    todayBar:
      isThisWeek && hasTimes
        ? summarizeToday(todayItems(courses, week, weekday), inputs.settings, inputs.clockMinutes)
        : null,
  };
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
}

interface SheetMember {
  id: string;
  name: string;
  sectionLabel: string;
}

const SOURCE_LABELS: Record<Course['source'], string> = {
  manual: '手工新增',
  photo: '截图识别',
  excel: '导入（Excel）',
};

function toSheet(course: Course): SheetCourse {
  const color = courseColor(course.name, course.color ?? '');
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
  };
}

const ASSISTANT_WELCOME = '你好，我是课表助手。你可以问我课表问题，比如「周三第几节有课」，也可以让我帮你加课、改课——改动都会先给你确认，确认后才生效。';
const ASSISTANT_NOTE = '回答只依据你当前保存的课表；任何增改都会先给你确认，确认后才生效。';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地「今天」（'YYYY-MM-DD'）：只用于判断「显示的是不是本周」，不参与任何日期推算。 */
function localToday(): string {
  const at = new Date();
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function localMinutes(): number {
  const at = new Date();
  return at.getHours() * 60 + at.getMinutes();
}

/**
 * 页面 query 里的文本解码：`wx.navigateTo` 的 query 是原样的转义串，不会自动解码。
 * 解不开（文本里本来就有裸 `%`）就按原文返回——宁可显示原样，也不把学生的问题弄丢。
 */
function decodedText(raw: string): string {
  if (raw.indexOf('%') < 0) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * 退化态的说明（设计图 19）：没设置就说清「缺什么、点哪里补」，
 * 而不是让人对着一个没有日期、没有速查的课表页猜为什么。设置齐了返回空字符串。
 */
function setupHintFor(settings: TimetableSettings, hasTimes: boolean, loadError: string): string {
  if (loadError !== '') return `课表设置暂时读不到（${loadError}），先按节次展示。`;
  const missingDate = settings.startDate === '';
  if (missingDate && !hasTimes) return '还没设置开学日与作息时间。设置后才知道今天是第几周，也才能显示「正在上/下一节」。';
  if (missingDate) return '还没设置开学日。设置后才知道今天是第几周、本周是几月几号。';
  if (!hasTimes) return '还没填作息时间。填了才会显示具体时刻与「正在上/下一节」。';
  return '';
}

/**
 * 提案卡里的一行（设计图 02 的 `.change`）：`checked` 只存在页面内存里，
 * 与提案一起在「应用」前不出这个页面——**确认前绝不写入**。
 */
interface NoticeRow extends NoticeChange {
  requestId?: string;
  /** 提案内的序号（从 0 起），勾选回写时按它对回提案。 */
  index: number;
  checked: boolean;
}

/** 一份待确认的提案：只用内存，`checkedCount` 跟着勾选实时算给按钮用。 */
interface NoticeProposal {
  rows: NoticeRow[];
  checkedCount: number;
}

/** 应用后的提示条（设计图 02 的 `.toast`）：10 秒内可撤销。 */
interface NoticeToast {
  text: string;
  canUndo: boolean;
}

/** 学生贴进来的通知最长多少字；超过就让他分批贴，而不是悄悄截断。 */
const NOTICE_INPUT_MAX = 4000;

const NOTICE_HINT = '贴一段班群通知，我按当前课表找出要改的地方，逐条列给你确认；点「应用」之前不会动课表。';
const NOTICE_FOOTER = '每条都附原文依据；冲突项默认不勾选。确认前不写入课表，应用后 10 秒内可撤销。';

/** 按当前勾选重算按钮上的条数：阻塞的条目不计入（它们不会被写入）。 */
function noticeProposalOf(rows: NoticeRow[]): NoticeProposal {
  return { rows, checkedCount: rows.filter((row) => row.checked && row.blocked === '').length };
}

/** 提案行 → 纯提案（去掉勾选状态），交给 notice.ts 的写入计划。 */
function changeOf(row: NoticeRow): NoticeChange {
  const { index, checked, ...change } = row;
  return change;
}

Page({
  data: {
    savedPlanPanel: savedPlanView(null, [], emptySettings(), '') as SavedPlanView,
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
    gridUi: presentGrid(buildGrid([], 1)),
    gridExpanded: false,
    viewMode: 'grid' as ViewMode,
    weekRange: '',
    settings: emptySettings() as TimetableSettings,
    settingsError: '',
    setupHint: '',
    todayBar: null as TodaySummary | null,
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
    /** 贴通知：粘贴框开合、正在读取、原文、提案、应用提示条（都只在内存，确认前不写入）。 */
    noticeOpen: false,
    noticeInput: '',
    noticeReading: false,
    noticeError: '',
    noticeHint: NOTICE_HINT,
    noticeFooter: NOTICE_FOOTER,
    noticeProposal: null as NoticeProposal | null,
    noticeToast: null as NoticeToast | null,
    /** 「逐条修改」展开：把每条将写入的内容摊开，方便学生逐条核对。 */
    noticeDetailOpen: false,
  },
  /** 「今天」与「现在几点」在进入页面时定下：测试可用 `onLoad({ today, clock })` 注入。 */
  today: '',
  clockMinutes: 0,
  /** 学生自己翻过周次之后就不再自动跳到本周（否则每次 onShow 都把他拽回来）。 */
  weekPinned: false,
  requestedPlanDate: '',
  /** 已写入成功、还能撤销的那些（10 秒窗口内有效）；窗口过了就清空。 */
  undoStack: [] as AppliedChange[],
  /** 撤销提示条的定时器；页面卸载或重新应用时先清掉旧的。 */
  undoTimer: null as number | null,
  toggleGridExpansion() {
    const expanded = !this.data.gridExpanded;
    this.setData({ gridExpanded: expanded, gridUi: presentGrid(this.data.grid, expanded) });
  },
  onLoad(query: { today?: string; clock?: string; ask?: string; week?: string; planDate?: string }) {
    const injectedToday = typeof query.today === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(query.today) ? query.today : '';
    this.today = injectedToday === '' ? localToday() : injectedToday;
    const injectedClock = typeof query.clock === 'string' ? minutesOfClock(query.clock) : null;
    this.clockMinutes = injectedClock === null ? localMinutes() : injectedClock;
    this.requestedPlanDate = typeof query.planDate === 'string' && weekdayOf(query.planDate) !== null ? query.planDate : '';
    const selectedWeek = Number(query.week);
    if (Number.isInteger(selectedWeek) && selectedWeek >= 1 && selectedWeek <= 30) {
      this.weekPinned = true;
      this.setData({ week: selectedWeek, weekIndex: selectedWeek - 1 });
    }
    // 首页输入条把问题带到这一页（`?ask=`）：只把问题填进输入框、帮他打开助手，**不自动发送**——
    // 发不发、发之前要不要改措辞，都留给学生自己决定。
    //
    // `?ask=` 必须解码：首页用 `encodeURIComponent` 拼 URL（中文与「？」「&」都得转义，
    // 否则会被当成参数分隔符切断），而 `onLoad` 拿到的 query 是**原样的转义串**——
    // 2026-11-10 开发者工具实测：不解码时输入框里显示的是
    // `%E8%BF%99%E5%91%A8%E4%B8%89%E7%AC%AC%E5%87%A0%E8%8A%82%E6%9C%89%E8%AF%BE%EF%BC%9F`。
    // 解不开（例如文本里本来就有裸 `%`）就按原文用，绝不因为解码失败把问题丢掉。
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
    // 设置读不到（云函数未部署、集合还没建）不能把整页拖进错误态：课表照常看，只是没有日期与速查条。
    return Promise.all([listCourses(), loadSettings().catch(() => emptySettings() as LoadedSettings)])
      .then(([feed, loaded]) => {
        const courses = feed.courses;
        const settings: TimetableSettings = loaded;
        const options = Array.from({ length: weekSpanWithSemester(courses, settings) }, (_, index) => index + 1);
        // 设了开学日就落在「本周」——这是开学日的意义；学生自己翻过周就尊重他的选择。
        const todayWeek = weekIndexOf({ startDate: settings.startDate, totalWeeks: settings.totalWeeks }, this.today);
        const planWeek = this.requestedPlanDate === '' ? null : weekIndexOf(settings, this.requestedPlanDate);
        const preferred = this.weekPinned ? this.data.week : (planWeek ?? todayWeek ?? 1);
        const week = Math.min(Math.max(preferred, 1), options.length);
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
          ...weekPatch(courses, week, { settings, today: this.today, clockMinutes: this.clockMinutes }),
          status: courses.length === 0 ? 'empty' : 'ready',
          errorMessage: '',
          savedPlanPanel: savedPlanView(loadPlan(), courses, settings, this.today, true, week),
        });
      })
      .catch((error) => {
        // 读不到就如实说明并给重试入口，不静默显示旧内容。
        this.setData({ status: 'error', errorMessage: messageOf(error),
          savedPlanPanel: savedPlanView(loadPlan(), [], this.data.settings, this.today, false, this.data.week) });
      });
  },
  retry() {
    return this.load();
  },
  /** 切周时重算网格、日期区间与速查条（同一份课程，换的只是「看哪一周」）。 */
  patchWeek(week: number) {
    return { ...weekPatch(this.data.courses, week, {
      settings: this.data.settings,
      today: this.today,
      clockMinutes: this.clockMinutes,
    }), savedPlanPanel: savedPlanView(loadPlan(), this.data.courses, this.data.settings, this.today, true, week) };
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
  /** 网格 / 列表切换：只换渲染，不重新读云端，也不改数据。 */
  switchView(event: DatasetEvent) {
    const mode = event.currentTarget.dataset.mode;
    if (mode !== 'grid' && mode !== 'list') return;
    this.setData({ viewMode: mode });
  },
  openImport() {
    wx.navigateTo({ url: '/pages/timetable/import/index' });
  },
  openCreate() {
    wx.navigateTo({ url: `/pages/timetable/edit/index?scope=new&semester=${encodeURIComponent(this.data.semester)}` });
  },
  openSettings() {
    wx.navigateTo({ url: '/pages/timetable/settings/index' });
  },
  /** 进课程管理时带上正在看的周次，「本周在读」才与课表页一致。 */
  openManage() {
    wx.navigateTo({ url: `/pages/timetable/manage/index?week=${this.data.week}` });
  },
  openEdit(event: DatasetEvent) {
    const id = event.currentTarget.dataset.id;
    if (id === undefined || id === '') return;
    wx.navigateTo({ url: `/pages/timetable/edit/index?scope=saved&id=${encodeURIComponent(id)}` });
  },
  /** 点课程块或速查条：打开详情弹层（全量信息 + 修改/删除）。 */
  openSheet(event: DatasetEvent) {
    const id = event.currentTarget.dataset.id;
    if (id === undefined || id === '') return;
    this.showSheet(id);
  },
  showSheet(id: string) {
    const course = this.data.courses.find((item) => item.id === id);
    if (course === undefined) return;
    this.setData({ sheetOpen: true, sheetCourse: toSheet(course), sheetMembers: this.membersOf(id) });
  },
  closeSheet() {
    this.setData({ sheetOpen: false, sheetCourse: null, sheetMembers: [] });
  },
  /** 同格多门时列出全部成员；单门返回空数组（弹层不显示这一段）。 */
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
      content: `确定删除「${name}」吗？删除后需要重新导入或手工添加。`,
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
  /** 打开助手面板：欢迎语一次写入，之后状态原样保留。 */
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
  /**
   * 课表页上的「贴班群通知」直接入口：一次点开就同时打开助手与粘贴框。
   * 贴通知是本轮主打功能，藏在助手面板里要点两下才看得见，等于没做入口。
   */
  openNoticeEntry() {
    this.openAssistant();
    this.setData({ noticeOpen: true, noticeError: '' });
  },
  closeAssistant() {
    this.setData({ assistantOpen: false });
  },
  onAssistantInput(event: InputEvent) {
    const raw = event.detail === undefined ? '' : event.detail.value;
    this.setData({ assistantInput: typeof raw === 'string' ? raw : '' });
  },
  /** 发送提问：查阅只读；变更方案先弹确认；失败文案独立且不影响课表展示。 */
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
    // 课表全文进 system，历史按输入预算自剪：两者拼起来不能超过服务端的检测窗口。
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
        // 服务端内容安全没有真正执行（checked !== true）时在对话里明说，不把「跳过」读成「干净」。
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
            // 模型提出的字段与当前课表一致：不弹确认框，也不产生任何写入。
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
  /** 变更方案必须经学生确认；确认框展示「当前值 → 变更后」，取消不写任何数据。 */
  confirmChange() {
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
  /** 确认后的写入：走 03 的入口，成功后刷新课表。 */
  applyChange(change: PendingChange) {
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
    // 只应用这次真正指定的字段；修改时其余字段从当前课程原样带过来（buildChangeInput 内合并）。
    const input = buildChangeInput(change.course, current ?? null);
    const task = change.action === 'add'
      ? createCourse(input, this.data.semester)
      : updateCourse(change.courseId, input);
    return task
      .then(() => {
        this.setData({
          pendingChange: null,
          assistantMessages: this.data.assistantMessages.concat([{ role: 'assistant', text: '已按确认的内容更新课表。' }]),
        });
        return this.load();
      })
      .catch((error) => {
        this.setData({
          pendingChange: null,
          assistantMessages: this.data.assistantMessages.concat([{ role: 'assistant', text: '保存没有成功：' + messageOf(error) }]),
        });
      });
  },
  // —— 贴通知（设计图 02）：粘贴 → 提案 → 逐条勾选 → 应用 → 10 秒撤销 ——

  /** 开合粘贴区；收起时保留已读到的提案，方便学生再核对一遍。 */
  toggleNotice() {
    this.setData({ noticeOpen: !this.data.noticeOpen, noticeError: '' });
  },
  onNoticeInput(event: InputEvent) {
    this.setData({ noticeInput: String(event.detail.value ?? ''), noticeError: '' });
  },
  /** 「逐条修改」：展开/收起每条的「将写入」说明；真正改字段仍走手工编辑页，不在这里偷偷改。 */
  toggleNoticeDetail() {
    this.setData({ noticeDetailOpen: !this.data.noticeDetailOpen });
  },
  /** 读通知：只出提案，不写库。原文与提案都留在内存里，学生点「应用」才动课表。 */
  readNotice() {
    const text = this.data.noticeInput.trim();
    if (text === '' || this.data.noticeReading) return;
    if (text.length > NOTICE_INPUT_MAX) {
      this.setData({ noticeError: `这段字太多了（${text.length} 字），一次最多贴 ${NOTICE_INPUT_MAX} 字，可以分几次贴。` });
      return;
    }
    this.clearUndoTimer();
    this.undoStack = [];
    this.setData({ noticeReading: true, noticeError: '', noticeToast: null });
    const system = buildNoticePrompt(this.data.courses, this.data.semester, this.data.week, this.data.weekOptions.length);
    return callAi(chatEvent(NOTICE_FEATURE, system, chatMessages([{ role: 'user', text }], system)))
      .then((result) => {
        if (!result.ok) {
          this.setData({ noticeReading: false, noticeError: userMessage(result) });
          return;
        }
        const reply = parseNoticeReply(result.text, this.data.courses, this.data.weekOptions.length,
          weekIndexOf(this.data.settings, this.today) ?? 0);
        // 服务端内容安全没真正执行时也照实说一句，不把「跳过」读成「干净」。
        const safetyNote = safetyNoteFor(result.safety);
        if (reply.kind !== 'changes') {
          // 空通知 / 超范围 / 要澄清 / 解析不出来：都说清楚，绝不生成一条假提案。
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
          noticeProposal: noticeProposalOf(reply.changes.map((change, index) => ({ ...change, index, checked: change.defaultChecked }))),
        });
      })
      .catch((error) => {
        this.setData({ noticeReading: false, noticeError: transportMessage(error) });
      });
  },
  /** 勾/取消某一条：阻塞条目点了也不勾（它根本写不进去，勾了只会误导）。 */
  toggleNoticeRow(event: DatasetEvent) {
    const proposal = this.data.noticeProposal;
    if (proposal === null) return;
    const index = Number(event.currentTarget.dataset.index);
    const target = proposal.rows[index];
    if (target === undefined) return;
    if (target.blocked !== '') {
      this.setData({ noticeError: '这条没法直接应用：' + target.blocked });
      return;
    }
    const rows = proposal.rows.map((row) => (row.index === index ? { ...row, checked: !row.checked } : row));
    this.setData({ noticeProposal: noticeProposalOf(rows), noticeError: '' });
  },
  /** 部分勾选后一次性应用：逐条写，任一条失败都如实报「已应用 K 处」，不谎报全成功。 */
  applyNotice() {
    if (this.data.noticeReading) return;
    const proposal = this.data.noticeProposal;
    if (proposal === null) return;
    const picked = proposal.rows.filter((row) => row.checked && row.blocked === '');
    if (picked.length === 0) return;
    // 编号属于提案，同一提案重试不能换编号；原业务快照由解析器保留。
    for (const row of proposal.rows) {
      if (!row.requestId) row.requestId = `notice-${Date.now().toString(36)}-${row.index}-${Math.random().toString(36).slice(2, 12)}`;
    }
    // 先用最新课表重算一次写入计划：学生可能在别处删/改过课程，提案里的快照可能已经过期。
    // 没勾的条目按「阻塞」传进去，applyPlan 会跳过它们，而 `changeIndex` 仍能对回原提案。
    const changes = proposal.rows.map((row) => {
      const change = changeOf(row);
      return row.checked && row.blocked === '' ? change : { ...change, blocked: '未勾选' };
    });
    const steps = applyPlan(changes, this.data.courses, this.data.weekOptions.length);
    if (steps.length === 0) {
      this.setData({ noticeError: '这些变更对不上当前课表了，已取消应用。请重新读一次通知。' });
      return;
    }
    const previousApplied = this.undoStack.slice();
    this.clearUndoTimer();
    this.setData({ noticeReading: true, noticeError: '', noticeToast: null });
    const applied: AppliedChange[] = [];
    const remainingProposal = () => {
      const done = new Set(applied.map((item) => item.changeIndex));
      return noticeProposalOf(proposal.rows.map((row) => done.has(row.index)
        ? { ...row, checked: false, blocked: '这条已应用，请勿重复写入；需要还原时可点撤销。' }
        : row));
    };
    const write = (step: ApplyStep): Promise<Course | null> => {
      if (step.kind === 'create') return createCourse(step.input, this.data.semester);
      if (step.kind === 'scoped') return applyScopedCourse(step.courseId, step.input, step.before as CourseInput,
        proposal.rows[step.changeIndex].requestId as string).then(() => null);
      // update 必须先确认这条课程还在：找不到就当作这一步失败，绝不新建一条去「顶替」。
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
          if (courseId === '') {
            // 服务端没返回新课程的编号：这条当作没写成功，撤销时也不会去删错东西。
            return Promise.reject(new Error('服务端没有返回新课程的编号'));
          }
          applied.push({
            changeIndex: step.changeIndex,
            kind: step.kind,
            operationId: step.kind === 'scoped' ? proposal.rows[step.changeIndex].requestId : undefined,
            courseId,
            before: step.before,
            after: step.input,
            summary: step.summary,
          });
          return runStep(position + 1);
        });
    };
    return runStep(0)
      .then(() => {
        this.undoStack = previousApplied.concat(applied);
        this.armUndoTimer();
        const count = applied.length;
        this.setData({
          noticeReading: false,
          noticeProposal: remainingProposal(),
          noticeToast: { text: `已更新 ${count} 处，课表已同步`, canUndo: true },
        });
        return this.load();
      })
      .catch((error) => {
        // 中途失败：已经写进去的那几条保留，并如实报「已应用 K 处，第 J 处失败：原因」。
        const done = applied.length;
        const failedAt = done + 1;
        const reason = messageOf(error);
        this.undoStack = previousApplied.concat(applied);
        this.armUndoTimer();
        this.setData({
          noticeReading: false,
          noticeProposal: remainingProposal(),
          noticeError: done === 0
            ? steps.some((step) => step.kind === 'scoped')
              ? `第 ${failedAt} 处保存未确认：${reason}。请刷新或重试，同一提案重试不会重复拆课。`
              : `第 ${failedAt} 处失败：${reason}。课表没有变化。`
            : `已应用 ${done} 处，第 ${failedAt} 处失败：${reason}。前 ${done} 处已在课表里，可以先撤销，或逐条核对后再应用。`,
          noticeToast: this.undoStack.length === 0 ? null : { text: `已更新 ${this.undoStack.length} 处，还有 ${steps.length - done} 处没写进去`, canUndo: true },
        });
        return this.load();
      });
  },
  /** 撤销提示条只活 10 秒（与设计图一致）；窗口过了自己消失，之后就当普通的历史改动看。 */
  armUndoTimer() {
    this.clearUndoTimer();
    // 定时器在小程序里一定有；测试环境不一定注入，所以先判存在，避免在纯逻辑测试里 ReferenceError。
    if (typeof setTimeout !== 'function') return;
    this.undoTimer = setTimeout(() => {
      this.undoTimer = null;
      this.undoStack = [];
      this.setData({ noticeToast: null });
    }, NOTICE_UNDO_MS);
  },
  clearUndoTimer() {
    if (this.undoTimer === null) return;
    if (typeof clearTimeout === 'function') clearTimeout(this.undoTimer);
    this.undoTimer = null;
  },
  /** 10 秒内点「撤销」：按 invertPlan 反向逐条写回（新增的删掉、改动的还原成旧值）。 */
  undoNotice() {
    if (this.data.noticeReading) return;
    const dirty = this.undoStack.slice();
    if (dirty.length === 0) {
      this.setData({ noticeToast: null });
      return;
    }
    this.undoStack = [];
    this.clearUndoTimer();
    this.setData({ noticeReading: true, noticeToast: { text: '正在撤销…', canUndo: false } });
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
      // 逆操作有先后依赖，失败就停；重试只继续尚未成功的步骤。
      return task.then(() => { dirty.pop(); return runStep(); });
    };
    return runStep()
      .then(() => {
        this.setData({ noticeReading: false, noticeToast: { text: '已撤销，课表回到应用前', canUndo: false } });
        return this.load();
      })
      .catch((error) => {
        this.undoStack = dirty;
        this.setData({ noticeReading: false, noticeToast: { text: `撤销没做完，尚有 ${dirty.length} 处：` + messageOf(error), canUndo: dirty.length > 0 } });
        return this.load();
      });
  },
  /** 页面卸载：清掉撤销定时器，避免离开页面后还去 setData。 */
  onUnload() {
    this.clearUndoTimer();
    this.undoStack = [];
  },
  goHome() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/home/index' });
  },
});
