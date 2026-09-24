/**
 * 课程信息：手工新增、修改已保存课程、修正导入草稿里的条目，共用这一个表单。
 *
 * 版式照 `docs/design/timetable/06-course-edit.html`（1rpx = 0.52px）：金杠小标题分四组 ——
 * 基本信息 / 上课时间 / 颜色 / 迷你课表预览，底部「保存 · 删除这节课 · 取消」。
 *
 * 三条贯穿全页的纪律：
 * 1. **不出现具体时刻**：学校作息未核实，页面只按节次编排，没有也不该有时间输入。
 * 2. **原文永不丢失**：导入来的原文与待核对项列在琥珀提示条里，原文行只读；
 *    周次编辑器改的是「周次集合」，合并写法（如 4-5、7-16）由 `weeks-editor.ts` 生成，
 *    不覆盖任何原文，也不替学生改已经识别出来的值。
 * 3. **预览只示意**：迷你网格 7 列 × 6 行（每行两节）只画正在编辑的这一节课，
 *    落位与块高由当前表单值算出，别的课、别的周都不画。
 *
 * `scope` 三态与云函数写入沿用上一版：new 走 createCourse、saved 走 updateCourse、
 * draft 只改内存草稿（确认保存后才写库）；缺课程名不提交。
 */
import { Course, CourseInput, DraftCourse, SectionRange } from '../../../services/timetable/types';
import { createCourse, deleteCourse, listCourses, messageOf, updateCourse } from '../../../services/timetable/index';
import { getDraft, removeCourseAt, replaceCourseAt } from '../../../services/timetable/draft';
import { CourseExtras, CourseForm, buildCourseInput, draftFromInput, emptyForm, formFromCourse, formFromDraft } from '../../../services/timetable/form';
import { COURSE_COLORS, CourseColor, colorAt, colorIndexFor, colorIndexFromKey } from '../../../services/timetable/palette';
import { SECTION_COUNT, WEEKDAY_SHORT } from '../../../services/timetable/view';
import { MAX_WEEK, parseWeekNotation } from '../../../services/timetable/weeks';
import {
  WEEKS_MODES,
  WeeksEditorState,
  WeeksMode,
  clearGrid,
  editorFromWeeks,
  gridCells,
  modePills,
  setMode,
  setRange,
  toggleGridWeek,
  weeksTextOf,
} from '../../../services/timetable/weeks-editor';

type Scope = 'draft' | 'saved' | 'new';
type Status = 'loading' | 'ready' | 'error';
type ColorMode = 'auto' | 'manual';
type SectionField = 'startIndex' | 'endIndex';

interface InputEvent {
  detail: { value: string };
}

interface PickerEvent {
  detail: { value: string | number };
}

interface TapEvent {
  currentTarget: { dataset: Record<string, unknown> };
}

interface Query {
  scope?: string;
  id?: string;
  index?: string;
  semester?: string;
}

interface MiniCell {
  key: string;
  block: boolean;
  /** 内联样式：块高与课程色的三个槽（无块时空串，模板照抄即可）。 */
  style: string;
}

interface MiniColumn {
  key: string;
  label: string;
  cells: MiniCell[];
}

interface Swatch {
  key: string;
  name: string;
  solid: string;
  on: boolean;
}

/** 原文与来源位置：只读展示，不参与编辑。 */
interface OriginalInfo {
  rawText: string;
  warnings: string[];
  sectionOriginal: string;
  weekOriginal: string;
  weekRecognized: boolean;
  /** 记录里的周次；未识别时为空数组（编辑器从空开始，原文留在提示条里）。 */
  weeks: number[];
}

interface EditorOverrides {
  weeksText?: string;
  startText?: string;
  endText?: string;
}

/** 迷你预览：7 列 × 6 行，每行两节（只示意，不追求 12 节精度）。 */
const MINI_ROWS = 6;
const MINI_SECTIONS_PER_ROW = SECTION_COUNT / MINI_ROWS;
const MINI_CELL_RPX = 30;
const MINI_GAP_RPX = 4;
/** 起止周填错时的琥珀提示（提示只说明现状，不替用户改数）。 */
const RANGE_ERROR = '起止周要填两个 1-30 之间的周数，且起始不大于结束；当前区间不完整或已倒置，已按「未选周次」处理';
const CALLOUT_EMPHASIS = '原文已保留';

function toIndex(value: unknown, fallback: number): number {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : fallback;
}

/** 起止周输入框的文本 → 周数；不是 1-30 的整数一律 null（不钳、不猜）。 */
function weekInput(text: string): number | null {
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 && value <= MAX_WEEK ? value : null;
}

/** 当前生效的色：手动指定优先，不认识的 key 静默回落到按课程名取色（与 palette.ts 同口径）。 */
function resolvedColorIndex(name: string, mode: ColorMode, key: string): number {
  if (mode === 'manual') {
    const explicit = colorIndexFromKey(key);
    if (explicit >= 0) return explicit;
  }
  return colorIndexFor(name);
}

function swatchesOf(index: number): Swatch[] {
  return COURSE_COLORS.map((color, position) => ({
    key: color.key,
    name: color.name,
    solid: color.solid,
    on: position === index,
  }));
}

/**
 * 迷你网格：7 列 × 6 行，块只落在正在编辑的这一天。
 * 6 行对上 12 节，每行两节；块高按跨行数算，颜色取当前色。
 */
function miniColumnsOf(weekdayIndex: number, startIndex: number, endIndex: number, color: CourseColor): MiniColumn[] {
  const weekday = weekdayIndex + 1;
  const start = startIndex + 1;
  const end = endIndex + 1;
  const placed = start >= 1 && end <= SECTION_COUNT && end >= start;
  return WEEKDAY_SHORT.map((label, position) => {
    const cells: MiniCell[] = [];
    const isTargetDay = placed && position + 1 === weekday;
    if (!isTargetDay) {
      for (let row = 1; row <= MINI_ROWS; row += 1) cells.push({ key: `r${row}`, block: false, style: '' });
      return { key: String(position + 1), label, cells };
    }
    const firstRow = Math.ceil(start / MINI_SECTIONS_PER_ROW);
    const lastRow = Math.ceil(end / MINI_SECTIONS_PER_ROW);
    for (let row = 1; row <= MINI_ROWS; row += 1) {
      if (row !== firstRow) {
        cells.push({ key: `r${row}`, block: false, style: '' });
        continue;
      }
      const span = lastRow - firstRow + 1;
      const height = span * MINI_CELL_RPX + (span - 1) * MINI_GAP_RPX;
      cells.push({
        key: `r${row}`,
        block: true,
        style: `height:${height}rpx;--blk-tint:${color.tint};--blk-line:${color.line};--blk-solid:${color.solid}`,
      });
      row = lastRow;
    }
    return { key: String(position + 1), label, cells };
  });
}

/** 节次原文：优先用识别出的区间，其次是原文里的起止节；都没有则留空（问题在待核对提示里说）。 */
function sectionOriginalOf(source: { sectionRanges: SectionRange[]; startSection: number; endSection: number }): string {
  const first = source.sectionRanges[0];
  if (first !== undefined) return first.start === first.end ? `${first.start}` : `${first.start}-${first.end}`;
  if (source.startSection > 0 && source.endSection >= source.startSection) {
    return source.startSection === source.endSection
      ? `${source.startSection}`
      : `${source.startSection}-${source.endSection}`;
  }
  return '';
}

/**
 * 琥珀提示条：把识别出来的原文摆出来让用户核对。
 *
 * 只复述原文与识别结果，不做任何修正——「原文永不丢失、不确定的只标记不猜」。
 */
function calloutOf(sectionOriginal: string, weekOriginal: string): { calloutText: string; calloutLead: string } {
  const parts: string[] = [];
  if (sectionOriginal !== '') parts.push(`节次原文 ${sectionOriginal}`);
  if (weekOriginal !== '') parts.push(`周次原文 ${weekOriginal}`);
  if (parts.length === 0) return { calloutText: '', calloutLead: '' };
  const calloutLead = `${parts.join('，')} —— `;
  return { calloutText: `${calloutLead}${CALLOUT_EMPHASIS}，保存前请确认`, calloutLead };
}

/** 周次那行说明：当前合并写法 / 未选 / 原文没能识别，说清保存后会发生什么。 */
function weeksHintOf(editor: WeeksEditorState, weekRecognized: boolean, weekText: string): string {
  const text = weeksTextOf(editor);
  if (text !== '') return `已选 ${editor.weeks.length} 周：${text}（合并写法由系统按你选的格子生成）`;
  if (editor.dirty) return '已清空周次：保存后按「每周」显示（不限教学周）';
  if (!weekRecognized && weekText !== '') {
    return `周次原文「${weekText}」没能识别成具体周次；原文已保留，确认前按「每周」显示并标注待核对`;
  }
  return '未选择周次：保存后按「每周」显示（不限教学周）';
}

const EMPTY_EDITOR = editorFromWeeks([]);

Page({
  data: {
    status: 'loading' as Status,
    errorMessage: '',
    scope: 'new' as Scope,
    title: '新增课程',
    form: emptyForm(),
    weekdayLabels: WEEKDAY_SHORT,
    sectionStartText: '1',
    sectionEndText: '2',
    weeksEditor: EMPTY_EDITOR,
    weeksGrid: gridCells(EMPTY_EDITOR),
    weeksPills: modePills(EMPTY_EDITOR),
    weeksStartText: '',
    weeksEndText: '',
    weeksHint: weeksHintOf(EMPTY_EDITOR, true, ''),
    weeksError: '',
    colorMode: 'auto' as ColorMode,
    colorKey: '',
    colorIndex: 0,
    colorName: COURSE_COLORS[0].name,
    colorSwatches: swatchesOf(0),
    miniColumns: miniColumnsOf(0, 0, 1, COURSE_COLORS[0]),
    rawText: '',
    warningText: '',
    hasOriginal: false,
    calloutText: '',
    calloutLead: '',
    saving: false,
    deletable: false,
    footnote: '',
  },
  courseId: '',
  draftIndex: -1,
  semester: '',
  extras: { campus: '', siteNumber: '', rawText: '', warnings: [], source: 'manual' } as CourseExtras,
  origin: { rawText: '', warnings: [], sectionOriginal: '', weekOriginal: '', weekRecognized: true, weeks: [] } as OriginalInfo,
  onLoad(query: Query) {
    const scope: Scope = query.scope === 'draft' || query.scope === 'saved' ? query.scope : 'new';
    this.semester = query.semester === undefined ? '' : decodeURIComponent(query.semester);
    if (scope === 'draft') return this.loadDraft(toIndex(query.index ?? '', -1));
    if (scope === 'saved') return this.loadSaved(query.id ?? '');
    const form = emptyForm();
    this.applyForm('new', '新增课程', form, { campus: '', siteNumber: '', rawText: '', warnings: [], source: 'manual' }, false, {
      rawText: '', warnings: [], sectionOriginal: '', weekOriginal: '', weekRecognized: true, weeks: [],
    });
    this.setData({ status: 'ready' });
  },
  loadDraft(index: number) {
    const draft = getDraft();
    const course: DraftCourse | undefined = draft === null ? undefined : draft.courses[index];
    if (course === undefined) {
      this.setData({ status: 'error', errorMessage: '草稿里找不到这门课程，可能已在确认页删除。' });
      return;
    }
    const { form, extras } = formFromDraft(course);
    this.draftIndex = index;
    this.applyForm('draft', '修正课程', form, extras, true, this.originOf(course));
    this.setData({ status: 'ready', footnote: '修正只改这次的导入草稿，确认保存后才写入课表。' });
  },
  loadSaved(id: string) {
    if (id === '') {
      this.setData({ status: 'error', errorMessage: '缺少课程标识，无法打开。' });
      return;
    }
    this.courseId = id;
    return listCourses()
      .then((feed) => {
        const course: Course | undefined = feed.courses.find((item) => item.id === id);
        if (course === undefined) {
          this.setData({ status: 'error', errorMessage: '这门课程不在已保存的课表里，可能已被删除。' });
          return;
        }
        const { form, extras } = formFromCourse(course);
        this.semester = course.semester;
        this.applyForm('saved', '修改课程', form, extras, true, this.originOf(course));
        this.setData({ status: 'ready', footnote: course.source === 'manual' ? '手工添加的课程' : '来自导入的课程' });
      })
      .catch((error) => this.setData({ status: 'error', errorMessage: messageOf(error) }));
  },
  originOf(course: Course | DraftCourse): OriginalInfo {
    return {
      rawText: course.rawText,
      warnings: course.warnings,
      sectionOriginal: sectionOriginalOf(course),
      weekOriginal: course.weekText,
      weekRecognized: course.weeksRecognized,
      weeks: course.weeks,
    };
  },
  applyForm(scope: Scope, title: string, form: CourseForm, extras: CourseExtras, deletable: boolean, origin: OriginalInfo) {
    this.extras = extras;
    this.origin = origin;
    const callout = calloutOf(origin.sectionOriginal, origin.weekOriginal);
    const warningText = origin.warnings.join('；');
    this.setData({
      scope,
      title,
      form,
      deletable,
      rawText: origin.rawText,
      warningText,
      hasOriginal: callout.calloutText !== '' || origin.rawText !== '' || warningText !== '',
      calloutText: callout.calloutText,
      calloutLead: callout.calloutLead,
      sectionStartText: String(form.startIndex + 1),
      sectionEndText: String(form.endIndex + 1),
      errorMessage: '',
    });
    const editor = editorFromWeeks(origin.weekRecognized ? origin.weeks : []);
    this.applyEditor(editor);
    this.refreshColor();
  },
  /** 编辑状态 → 页面：网格、pill、起止周输入框、提示语，以及落到表单里的合并写法。 */
  applyEditor(editor: WeeksEditorState, overrides: EditorOverrides = {}) {
    const text = weeksTextOf(editor);
    const patch: Record<string, unknown> = {
      weeksEditor: editor,
      weeksGrid: gridCells(editor),
      weeksPills: modePills(editor),
      weeksStartText: overrides.startText === undefined ? (editor.start === null ? '' : String(editor.start)) : overrides.startText,
      weeksEndText: overrides.endText === undefined ? (editor.end === null ? '' : String(editor.end)) : overrides.endText,
      weeksHint: weeksHintOf(editor, this.origin.weekRecognized, this.origin.weekOriginal),
      weeksError: editor.rangeInvalid ? RANGE_ERROR : '',
    };
    // 合并写法（或用户键入的原文）落到表单字段：保存时 buildCourseInput 再解析一次，
    // 认不出来的写法仍按「保留原文 + 标待核对」处理，这里不做判断。
    if (overrides.weeksText !== undefined) patch['form.weeksText'] = overrides.weeksText;
    else if (text !== '') patch['form.weeksText'] = text;
    else if (editor.dirty) patch['form.weeksText'] = '';
    this.setData(patch);
  },
  /** 颜色数据与迷你预览同源（预览用当前色），一起刷新。 */
  refreshColor() {
    const index = resolvedColorIndex(this.data.form.name, this.data.colorMode, this.data.colorKey);
    const color = colorAt(index);
    this.setData({
      colorIndex: index,
      colorName: color.name,
      colorSwatches: swatchesOf(index),
      'form.color': this.data.colorMode === 'manual' ? this.data.colorKey : '',
      miniColumns: miniColumnsOf(this.data.form.weekdayIndex, this.data.form.startIndex, this.data.form.endIndex, color),
    });
  },
  onNameInput(event: InputEvent) {
    this.setData({ 'form.name': event.detail.value });
    this.refreshColor();
  },
  onTeacherInput(event: InputEvent) {
    this.setData({ 'form.teacher': event.detail.value });
  },
  onLocationInput(event: InputEvent) {
    this.setData({ 'form.location': event.detail.value });
  },
  onCreditsInput(event: InputEvent) {
    this.setData({ 'form.credits': event.detail.value });
  },
  onNoteInput(event: InputEvent) {
    this.setData({ 'form.note': event.detail.value });
  },
  onWeekdayTap(event: TapEvent) {
    this.setData({ 'form.weekdayIndex': toIndex(event.currentTarget.dataset.index, this.data.form.weekdayIndex) });
    this.refreshColor();
  },
  /** 星期选择器（旧版 picker 的入口）保留：行为与点 pill 一致。 */
  onWeekdayChange(event: PickerEvent) {
    this.setData({ 'form.weekdayIndex': toIndex(event.detail.value, this.data.form.weekdayIndex) });
    this.refreshColor();
  },
  /** 节次输入：合法值立即生效；失焦时把越界值改回当前值并回显，不静默改。 */
  setSection(field: SectionField, text: string, clampToCurrent: boolean) {
    const current = (field === 'startIndex' ? this.data.form.startIndex : this.data.form.endIndex) + 1;
    const parsed = Number(text);
    const filled = Number.isInteger(parsed) && parsed >= 1 && parsed <= SECTION_COUNT;
    if (!filled && !clampToCurrent) return;
    const next = filled ? parsed : current;
    if (field === 'startIndex') this.setData({ 'form.startIndex': next - 1, sectionStartText: String(next) });
    else this.setData({ 'form.endIndex': next - 1, sectionEndText: String(next) });
    this.refreshColor();
  },
  onStartInput(event: InputEvent) {
    this.setSection('startIndex', event.detail.value, false);
  },
  onStartCommit(event: InputEvent) {
    this.setSection('startIndex', event.detail.value, true);
  },
  onEndInput(event: InputEvent) {
    this.setSection('endIndex', event.detail.value, false);
  },
  onEndCommit(event: InputEvent) {
    this.setSection('endIndex', event.detail.value, true);
  },
  /** 节次选择器（旧版 picker 的入口）保留：0 起下标。 */
  onStartChange(event: PickerEvent) {
    this.setSection('startIndex', String(Number(event.detail.value) + 1), true);
  },
  onEndChange(event: PickerEvent) {
    this.setSection('endIndex', String(Number(event.detail.value) + 1), true);
  },
  /**
   * 文本式设置周次（`1-16`、`2-6,8-17`）。
   *
   * 06 的表单里周次由编辑器改，页面上没有文本框；这个方法保留为程序化入口，行为与旧版一致：
   * 能识别的写进编辑器并把原文本落到表单，不认识的只保留原文、等用户自己看。
   */
  onWeeksInput(event: InputEvent) {
    const text = event.detail.value;
    const parsed = parseWeekNotation(text);
    const editor = parsed.recognized
      ? { ...editorFromWeeks(parsed.weeks), dirty: true }
      : this.data.weeksEditor;
    this.applyEditor(editor, { weeksText: text });
  },
  /** 起止周：输入时只改文本，失焦 / 回车才落到周次集合上（避免打一半就把网格清空）。 */
  onWeeksStartInput(event: InputEvent) {
    this.setData({ weeksStartText: event.detail.value });
  },
  onWeeksEndInput(event: InputEvent) {
    this.setData({ weeksEndText: event.detail.value });
  },
  commitWeeksRange(which: 'start' | 'end', text: string) {
    const editor = this.data.weeksEditor;
    const value = weekInput(text);
    const start = which === 'start' ? value : editor.start;
    const end = which === 'end' ? value : editor.end;
    const overrides: EditorOverrides = {};
    if (which === 'start') overrides.startText = text;
    else overrides.endText = text;
    this.applyEditor(setRange(editor, start, end), overrides);
  },
  onWeeksStartCommit(event: InputEvent) {
    this.commitWeeksRange('start', event.detail.value);
  },
  onWeeksEndCommit(event: InputEvent) {
    this.commitWeeksRange('end', event.detail.value);
  },
  /** 快捷改法：全学期 / 单周 / 双周 / 自选（自选只是「接下来手改」，保留已选）。 */
  onWeeksMode(event: TapEvent) {
    const key = String(event.currentTarget.dataset.mode ?? '');
    const mode: WeeksMode = WEEKS_MODES.find((item) => item.key === key)?.key ?? 'custom';
    this.applyEditor(setMode(this.data.weeksEditor, mode));
  },
  onWeeksGridTap(event: TapEvent) {
    this.applyEditor(toggleGridWeek(this.data.weeksEditor, Number(event.currentTarget.dataset.week)));
  },
  onWeeksAll() {
    this.applyEditor(setMode(this.data.weeksEditor, 'all'));
  },
  onWeeksNone() {
    this.applyEditor(clearGrid(this.data.weeksEditor));
  },
  onWeeksOdd() {
    this.applyEditor(setMode(this.data.weeksEditor, 'odd'));
  },
  onWeeksEven() {
    this.applyEditor(setMode(this.data.weeksEditor, 'even'));
  },
  onColorAuto() {
    this.setData({ colorMode: 'auto' });
    this.refreshColor();
  },
  /** 手动指定：从当前色起步（不是清零），用户再点色块调整。 */
  onColorManual() {
    const index = resolvedColorIndex(this.data.form.name, this.data.colorMode, this.data.colorKey);
    this.setData({ colorMode: 'manual', colorKey: colorAt(index).key });
    this.refreshColor();
  },
  onColorPick(event: TapEvent) {
    const key = String(event.currentTarget.dataset.key ?? '');
    this.setData({ colorMode: 'manual', colorKey: colorIndexFromKey(key) >= 0 ? key : this.data.colorKey });
    this.refreshColor();
  },
  save() {
    if (this.data.saving) return;
    const built = buildCourseInput(this.data.form, this.extras);
    if (!built.ok) {
      wx.showToast({ title: built.error, icon: 'none' });
      return;
    }
    const input: CourseInput = built.value;
    const scope = this.data.scope;
    if (scope === 'draft') return this.saveDraftItem(input);
    if (scope === 'saved') return this.saveExisting(input);
    return this.createNew(input);
  },
  saveDraftItem(input: CourseInput) {
    const draft = getDraft();
    const course: DraftCourse | undefined = draft === null ? undefined : draft.courses[this.draftIndex];
    if (course === undefined || !replaceCourseAt(this.draftIndex, draftFromInput(course, input))) {
      wx.showToast({ title: '草稿已失效，请返回确认页重新导入', icon: 'none' });
      return;
    }
    wx.showToast({ title: '已更新草稿', icon: 'success' });
    setTimeout(() => this.goBack(), 400);
  },
  saveExisting(input: CourseInput) {
    this.setData({ saving: true });
    updateCourse(this.courseId, input)
      .then(() => {
        wx.showToast({ title: '已保存', icon: 'success' });
        setTimeout(() => this.goBack(), 400);
      })
      .catch((error) => {
        this.setData({ saving: false });
        wx.showModal({ title: '保存失败', content: messageOf(error), showCancel: false });
      });
  },
  createNew(input: CourseInput) {
    this.setData({ saving: true });
    createCourse(input, this.semester)
      .then(() => {
        wx.showToast({ title: '已添加', icon: 'success' });
        setTimeout(() => this.goBack(), 400);
      })
      .catch((error) => {
        this.setData({ saving: false });
        wx.showModal({ title: '添加失败', content: messageOf(error), showCancel: false });
      });
  },
  remove() {
    if (this.data.scope === 'draft') {
      removeCourseAt(this.draftIndex);
      wx.showToast({ title: '已从草稿中删除', icon: 'none' });
      setTimeout(() => this.goBack(), 300);
      return;
    }
    if (this.data.scope !== 'saved') return;
    wx.showModal({
      title: '删除课程',
      content: `确定删除「${this.data.form.name}」吗？`,
      confirmText: '删除',
      success: (result) => {
        if (!result.confirm) return;
        deleteCourse(this.courseId)
          .then(() => {
            wx.showToast({ title: '已删除', icon: 'success' });
            setTimeout(() => this.goBack(), 400);
          })
          .catch((error) => wx.showToast({ title: messageOf(error), icon: 'none' }));
      },
    });
  },
  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/timetable/index' });
  },
});
