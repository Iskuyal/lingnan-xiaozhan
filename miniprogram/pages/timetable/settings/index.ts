/**
 * 课表设置：学期（名称 / 第一周的星期一 / 总周数）与作息时间（12 节，全部由学生自填）。
 *
 * 设计图 16。两条纪律落在这个页面上：
 * - **不预置任何默认时刻**：学校作息表尚未核实，12 节的时刻框一开始全是空的，
 *   填了才会在课表上显示时刻与「正在上 / 下一节」；没填就留空，不画「--:--」这类占位；
 * - 作息按上午 / 下午 / 晚上折叠；全空时先展开上午组，有已填时刻的组自动展开；
 * - **没开学日也不显示假日期**：预览行只说「还没设置开学日，课表按第 1 周显示」。
 *
 * 读设置失败（云函数未部署、集合未建、断网）**不白屏**：`loadSettings` 会降级为空设置，
 * 页面照常可用，只在顶部一行说明「读不到已保存的设置」。保存失败分两类文案：
 * 「填写有误」（服务端业务校验拒绝）与「暂时存不到云端」（云函数/集合未就绪）。
 *
 * 测试注入：`onLoad({ today: 'YYYY-MM-DD' })` 可以固定「今天」，预览文案因此不随真实日期漂移；
 * 真机不传这个参数，用本地日期。
 */
import { SECTION_COUNT, SectionTime, SettingsFailure, TimetableSettings, emptySettings, failureOf, loadSettings, minutesOfClock, saveSettings, validateSettings } from '../../../services/timetable/settings';
import { DEFAULT_TOTAL_WEEKS, isMonday, normalizeTotalWeeks, weekIndexOf, weekdayOf } from '../../../services/timetable/semester';

type Status = 'loading' | 'ready';

interface InputEvent {
  detail: { value: string };
}

interface PickerEvent {
  detail: { value: string };
}

interface SectionTimeEvent {
  currentTarget: { dataset: { section?: unknown; field?: unknown } };
  detail: { value: string };
}

interface WeeksEvent {
  currentTarget: { dataset: { weeks?: unknown } };
}

interface Query {
  today?: string;
}

interface SectionRow {
  section: number;
  label: string;
  start: string;
  end: string;
  last: boolean;
}

interface SectionGroup {
  label: string;
  rows: SectionRow[];
  open: boolean;
  toggleLabel: string;
}

interface GroupToggleEvent {
  currentTarget: { dataset: { index?: string | number } };
}

/** 分组的依据是学校的作息节律（上午 / 下午 / 晚上），与设计图 16 一致。 */
const GROUP_DEFS = [
  { label: '上午 第 1-4 节', from: 1, to: 4 },
  { label: '下午 第 5-10 节', from: 5, to: 10 },
  { label: '晚上 第 11-12 节', from: 11, to: 12 },
];

/** 总周数的快捷选项；当前值等于其中一项时那颗 pill 高亮。 */
const WEEK_OPTIONS = [18, 20, 22];

const WEEKDAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const BLANK = emptySettings();

/** 本地日期 'YYYY-MM-DD'；用本地时区而不是 toISOString（后者会差一天）。 */
function localToday(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 取第 index 条作息；缺失或不是文本时按空处理（页面对脏数据不崩）。 */
function timeAt(sectionTimes: SectionTime[], index: number): SectionTime {
  const raw: SectionTime | undefined = Array.isArray(sectionTimes) ? sectionTimes[index] : undefined;
  if (raw === null || raw === undefined || typeof raw.start !== 'string' || typeof raw.end !== 'string') {
    return { start: '', end: '' };
  }
  return { start: raw.start, end: raw.end };
}

/** 12 节按上午 / 下午 / 晚上分组；每行已填就显示、没填就空。 */
function buildGroups(sectionTimes: SectionTime[], openGroupIndexes: number[]): SectionGroup[] {
  return GROUP_DEFS.map((group, index) => {
    const rows: SectionRow[] = [];
    for (let section = group.from; section <= group.to; section += 1) {
      const time = timeAt(sectionTimes, section - 1);
      rows.push({
        section,
        label: `第 ${section} 节`,
        start: time.start,
        end: time.end,
        last: section === SECTION_COUNT,
      });
    }
    const open = openGroupIndexes.includes(index);
    return { label: group.label, rows, open, toggleLabel: open ? '收起' : `${rows.length} 节 · 展开` };
  });
}

/** 有已填时刻的分组展开；全空时先展开上午，让人知道这张表怎么填。 */
function openGroupsFor(sectionTimes: SectionTime[]): number[] {
  const open: number[] = [];
  GROUP_DEFS.forEach((group, index) => {
    const hasTime = sectionTimes
      .slice(group.from - 1, group.to)
      .some((time) => time.start !== '' || time.end !== '');
    if (hasTime) open.push(index);
  });
  return open.length > 0 ? open : [0];
}

/** 非周一时的提示：开学日就是「第一周的星期一」，其它日期会把周次整体挪位。 */
function mondayHint(startDate: string): string {
  if (startDate === '' || isMonday(startDate)) return '';
  const weekday = weekdayOf(startDate);
  const name = weekday === null ? '' : WEEKDAY_NAMES[weekday - 1];
  return `所选日期是星期${name}，不是星期一：课表会从这一天起算、每 7 天为一周，建议改成当周的星期一。`;
}

/** 实时预览：设了开学日才算得出今天是第几周；没设就说清「按第 1 周显示」。 */
function previewText(startDate: string, totalWeeks: number, today: string): string {
  if (startDate === '') return '还没设置开学日，课表按第 1 周显示';
  const week = weekIndexOf({ startDate, totalWeeks }, today);
  if (week === null) return '今天不在本学期范围内，课表按第 1 周显示';
  return `今天是第 ${week} 周`;
}

/** 保存失败的两类文案：填写有误 vs 暂时存不到云端。 */
function failureText(failure: SettingsFailure): string {
  return failure.kind === 'invalid' ? `填写有误：${failure.text}` : `暂时存不到云端：${failure.text}`;
}

Page({
  data: {
    status: 'loading' as Status,
    loadNote: '',
    saveError: '',
    saving: false,
    semesterName: '',
    startDate: '',
    startDateHint: '',
    totalWeeksText: String(DEFAULT_TOTAL_WEEKS),
    totalWeeks: DEFAULT_TOTAL_WEEKS,
    weekOptions: WEEK_OPTIONS,
    sectionTimes: BLANK.sectionTimes,
    openGroupIndexes: [0],
    groups: buildGroups(BLANK.sectionTimes, [0]),
    preview: '',
  },
  /** 预览与「第几周」用的今天；测试可经 onLoad 注入，真机取本地日期。 */
  today: '',
  onLoad(query: Query) {
    const injected = query !== null && query !== undefined && typeof query.today === 'string' ? query.today : '';
    this.today = DATE_PATTERN.test(injected) ? injected : localToday();
    return this.reload();
  },
  /** 读设置；`loadSettings` 不会 reject（读失败会降级为空设置并把原因放在 loadError 上）。 */
  async reload() {
    this.setData({ status: 'loading', loadNote: '', saveError: '' });
    const settings = await loadSettings();
    this.applySettings(settings);
    const loadNote = settings.loadError === undefined
      ? ''
      : `读不到已保存的设置（${settings.loadError}），先按未设置显示；填好保存即可。`;
    this.setData({ status: 'ready', loadNote });
  },
  applySettings(settings: TimetableSettings) {
    const sectionTimes = settings.sectionTimes.map((time) => ({ start: time.start, end: time.end }));
    const openGroupIndexes = openGroupsFor(sectionTimes);
    this.setData({
      semesterName: settings.semesterName,
      startDate: settings.startDate,
      totalWeeksText: String(settings.totalWeeks),
      totalWeeks: settings.totalWeeks,
      sectionTimes,
      openGroupIndexes,
      groups: buildGroups(sectionTimes, openGroupIndexes),
      startDateHint: mondayHint(settings.startDate),
      preview: previewText(settings.startDate, settings.totalWeeks, this.today),
    });
  },
  /** 总周数输入框里的文本 → 周数；空或写坏都按 `normalizeTotalWeeks` 的默认跨度处理。 */
  totalWeeksValue(text?: string): number {
    const source = text === undefined ? this.data.totalWeeksText : text;
    return normalizeTotalWeeks(Number(source));
  },
  hints(startDate: string, totalWeeks: number) {
    return {
      startDateHint: mondayHint(startDate),
      preview: previewText(startDate, totalWeeks, this.today),
    };
  },
  onSemesterNameInput(event: InputEvent) {
    this.setData({ semesterName: event.detail.value, saveError: '' });
  },
  onStartDateChange(event: PickerEvent) {
    const startDate = typeof event.detail.value === 'string' ? event.detail.value : '';
    this.setData({ startDate, saveError: '', ...this.hints(startDate, this.totalWeeksValue()) });
  },
  onTotalWeeksInput(event: InputEvent) {
    // 只留数字：总周数是 1-30 的整数，别的字符连输入都不该进到框里。
    const text = String(event.detail.value).replace(/[^0-9]/gu, '').slice(0, 2);
    const totalWeeks = this.totalWeeksValue(text);
    this.setData({ totalWeeksText: text, totalWeeks, saveError: '', ...this.hints(this.data.startDate, totalWeeks) });
  },
  chooseWeeks(event: WeeksEvent) {
    const weeks = Number(event.currentTarget.dataset.weeks);
    if (!Number.isInteger(weeks)) return;
    const text = String(normalizeTotalWeeks(weeks));
    this.setData({ totalWeeksText: text, totalWeeks: Number(text), saveError: '', ...this.hints(this.data.startDate, Number(text)) });
  },
  /** 某一节的起始或结束时刻变化；只接受 HH:MM（时间选择器给的就是这个形状）。 */
  onSectionTimeChange(event: SectionTimeEvent) {
    const section = Number(event.currentTarget.dataset.section);
    const field = event.currentTarget.dataset.field === 'end' ? 'end' : 'start';
    const value = typeof event.detail.value === 'string' ? event.detail.value.trim() : '';
    if (!Number.isInteger(section) || section < 1 || section > SECTION_COUNT) return;
    if (minutesOfClock(value) === null) return;
    const sectionTimes = this.data.sectionTimes.map((time, index) => {
      if (index !== section - 1) return { start: time.start, end: time.end };
      const next: SectionTime = { start: time.start, end: time.end };
      if (field === 'end') next.end = value;
      else next.start = value;
      return next;
    });
    this.setData({ sectionTimes, groups: buildGroups(sectionTimes, this.data.openGroupIndexes), saveError: '' });
  },
  toggleGroup(event: GroupToggleEvent) {
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index) || index < 0 || index >= GROUP_DEFS.length) return;
    const open = new Set(this.data.openGroupIndexes);
    if (open.has(index)) open.delete(index);
    else open.add(index);
    const openGroupIndexes = Array.from(open).sort((a, b) => a - b);
    this.setData({ openGroupIndexes, groups: buildGroups(this.data.sectionTimes, openGroupIndexes) });
  },
  clearTimes() {
    wx.showModal({
      title: '清空作息',
      content: '清空后 12 节的时刻都变成未填，课表上不再显示时刻与「正在上/下一节」；课程数据不受影响。',
      confirmText: '清空',
      success: (result) => {
        if (!result.confirm) return;
        const sectionTimes = emptySettings().sectionTimes;
        const openGroupIndexes = [0];
        this.setData({ sectionTimes, openGroupIndexes, groups: buildGroups(sectionTimes, openGroupIndexes), saveError: '' });
        wx.showToast({ title: '已清空，记得保存', icon: 'none' });
      },
    });
  },
  collect(): TimetableSettings {
    return {
      semesterName: this.data.semesterName.trim(),
      startDate: this.data.startDate,
      totalWeeks: this.totalWeeksValue(),
      sectionTimes: this.data.sectionTimes.map((time) => ({ start: time.start, end: time.end })),
    };
  },
  async save() {
    if (this.data.saving === true) return;
    const next = this.collect();
    // 本地先挡一次：填错了不必等一次往返，文案与云端拒绝时同一口径。
    const problem = validateSettings(next);
    if (problem !== '') {
      this.setData({ saveError: `填写有误：${problem}` });
      wx.showToast({ title: '填写有误，请检查设置', icon: 'none' });
      return;
    }
    this.setData({ saving: true, saveError: '' });
    try {
      await saveSettings(next);
      this.setData({ saving: false });
      wx.showToast({ title: '设置已保存', icon: 'success' });
      setTimeout(() => this.goBack(), 400);
    } catch (error) {
      const failure = failureOf(error);
      this.setData({ saving: false, saveError: failureText(failure) });
      wx.showToast({
        title: failure.kind === 'invalid' ? '填写有误，请检查设置' : '保存失败，云端暂不可用',
        icon: 'none',
      });
    }
  },
  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/timetable/index' });
  },
});
