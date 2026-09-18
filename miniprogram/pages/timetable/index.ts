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
import { WEEKDAY_SHORT, WeekView, buildWeekView, formatUpdatedAt, semesterLabel, weekSpan } from '../../services/timetable/view';
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

interface DatasetEvent {
  currentTarget: { dataset: { id?: string; name?: string } };
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

const ASSISTANT_WELCOME = '你好，我是课表助手。你可以问我课表问题，比如「周三第几节有课」，也可以让我帮你加课、改课——改动都会先给你确认，确认后才生效。';
const ASSISTANT_NOTE = '回答只依据你当前保存的课表；任何增改都会先给你确认，确认后才生效。';

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
  /** 从导入页或编辑页返回时也走这里，保证展示的是云端最新数据。 */
  onShow() {
    return this.load();
  },
  load() {
    if (this.data.count === 0) this.setData({ status: 'loading', errorMessage: '' });
    return listCourses()
      .then((feed) => {
        const courses = feed.courses;
        const options = Array.from({ length: weekSpan(courses) }, (_, index) => index + 1);
        const week = Math.min(Math.max(this.data.week, 1), options.length);
        this.setData({
          courses,
          count: feed.count,
          semester: feed.semester,
          semesterText: semesterLabel(feed.semester),
          updatedAtText: formatUpdatedAt(feed.updatedAt),
          weekOptions: options,
          weekIndex: week - 1,
          week,
          view: buildWeekView(courses, week),
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
  selectWeek(event: PickerEvent) {
    const index = pickerIndex(event.detail.value);
    const week = this.data.weekOptions[index];
    if (week === undefined) return;
    this.setData({ week, weekIndex: index, view: buildWeekView(this.data.courses, week) });
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
    this.setData({ week, weekIndex: index, view: buildWeekView(this.data.courses, week) });
  },
  openImport() {
    wx.navigateTo({ url: '/pages/timetable/import/index' });
  },
  openCreate() {
    wx.navigateTo({ url: `/pages/timetable/edit/index?scope=new&semester=${encodeURIComponent(this.data.semester)}` });
  },
  openEdit(event: DatasetEvent) {
    const id = event.currentTarget.dataset.id;
    if (id === undefined || id === '') return;
    wx.navigateTo({ url: `/pages/timetable/edit/index?scope=saved&id=${encodeURIComponent(id)}` });
  },
  removeCourse(event: DatasetEvent) {
    const id = event.currentTarget.dataset.id;
    const name = event.currentTarget.dataset.name ?? '';
    if (id === undefined || id === '') return;
    wx.showModal({
      title: '删除课程',
      content: `确定删除「${name}」吗？删除后需要重新导入或手工添加。`,
      confirmText: '删除',
      success: (result) => {
        if (!result.confirm) return;
        deleteCourse(id)
          .then(() => {
            wx.showToast({ title: '已删除', icon: 'success' });
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
    return callAi(chatEvent(
      'timetable-assistant',
      buildSystemPrompt(this.data.courses, this.data.semester, this.data.week, this.data.weekOptions.length),
      chatMessages(history),
    ))
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
