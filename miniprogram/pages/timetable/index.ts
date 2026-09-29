/**
 * 我的课表（Ticket 03）+ 课表 AI 助手（Ticket 06）。
 *
 * 数据来自 `timetable` 云函数（按微信身份隔离），页面每次显示都从云端重读，
 * 因此退出重进、换设备都能看到同一份课表。学校作息未核实，周课表只按节次展示。
 *
 * 助手：查阅只依据当前课表数据；任何增改都是「方案」，必须弹确认框、
 * 学生确认后才走 03 的写入入口；三类失败文案独立，课表展示不受助手失败影响。
 */
import { Course } from '../../services/timetable/types';
import {
  FILE_GUIDE,
  OFFLINE_NOTE,
  createCourse,
  deleteCourse,
  listCourses,
  messageOf,
  updateCourse,
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

type Status = 'loading' | 'empty' | 'ready' | 'error';

/** 网格 / 列表两种视图：网格看「一眼」，列表看「读全」。 */
type ViewMode = 'grid' | 'list';

interface DatasetEvent {
  currentTarget: { dataset: { id?: string; name?: string; mode?: string } };
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

Page({
  data: {
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
  },
  /** 「今天」与「现在几点」在进入页面时定下：测试可用 `onLoad({ today, clock })` 注入。 */
  today: '',
  clockMinutes: 0,
  /** 学生自己翻过周次之后就不再自动跳到本周（否则每次 onShow 都把他拽回来）。 */
  weekPinned: false,
  onLoad(query: { today?: string; clock?: string }) {
    const injectedToday = typeof query.today === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(query.today) ? query.today : '';
    this.today = injectedToday === '' ? localToday() : injectedToday;
    const injectedClock = typeof query.clock === 'string' ? minutesOfClock(query.clock) : null;
    this.clockMinutes = injectedClock === null ? localMinutes() : injectedClock;
  },
  /** 从导入页或编辑页返回时也走这里，保证展示的是云端最新数据。 */
  onShow() {
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
        const preferred = this.weekPinned ? this.data.week : (todayWeek ?? 1);
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
        });
      })
      .catch((error) => {
        // 读不到就如实说明并给重试入口，不静默显示旧内容。
        this.setData({ status: 'error', errorMessage: messageOf(error) });
      });
  },
  retry() {
    return this.load();
  },
  /** 切周时重算网格、日期区间与速查条（同一份课程，换的只是「看哪一周」）。 */
  patchWeek(week: number) {
    return weekPatch(this.data.courses, week, {
      settings: this.data.settings,
      today: this.today,
      clockMinutes: this.clockMinutes,
    });
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
  goHome() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/home/index' });
  },
});
