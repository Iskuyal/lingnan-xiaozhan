/**
 * 课程信息：手工新增、修改已保存课程、修正导入草稿里的条目，共用这一个表单。
 *
 * 手工录入入口独立于导入流程（Ticket 03 首版范围）；05、06 复用同一入口。
 * 表单只收「学生能确定的字段」，校区、场地编号、备注与原文等在编辑时原样保留。
 */
import { Course, CourseInput, DraftCourse } from '../../../services/timetable/types';
import { createCourse, deleteCourse, listCourses, messageOf, updateCourse } from '../../../services/timetable/index';
import { getDraft, removeCourseAt, replaceCourseAt } from '../../../services/timetable/draft';
import { CourseExtras, CourseForm, buildCourseInput, draftFromInput, emptyForm, extrasOf, formFromCourse, formFromDraft } from '../../../services/timetable/form';
import { WEEKDAY_LABELS } from '../../../services/timetable/view';

type Scope = 'draft' | 'saved' | 'new';
type Status = 'loading' | 'ready' | 'error';

interface InputEvent {
  detail: { value: string };
}

interface PickerEvent {
  detail: { value: string | number };
}

interface Query {
  scope?: string;
  id?: string;
  index?: string;
  semester?: string;
}

const SECTION_OPTIONS = Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 节`);

function toIndex(value: string | number, fallback: number): number {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : fallback;
}

Page({
  data: {
    status: 'loading' as Status,
    errorMessage: '',
    scope: 'new' as Scope,
    title: '新增课程',
    form: emptyForm(),
    weekdayOptions: WEEKDAY_LABELS,
    sectionOptions: SECTION_OPTIONS,
    rawText: '',
    warningText: '',
    saving: false,
    deletable: false,
    footnote: '',
  },
  courseId: '',
  draftIndex: -1,
  semester: '',
  extras: { campus: '', siteNumber: '', note: '', rawText: '', warnings: [], source: 'manual' } as CourseExtras,
  onLoad(query: Query) {
    const scope: Scope = query.scope === 'draft' || query.scope === 'saved' ? query.scope : 'new';
    this.semester = query.semester === undefined ? '' : decodeURIComponent(query.semester);
    if (scope === 'draft') return this.loadDraft(toIndex(query.index ?? '', -1));
    if (scope === 'saved') return this.loadSaved(query.id ?? '');
    this.applyForm('new', '新增课程', emptyForm(), { campus: '', siteNumber: '', note: '', rawText: '', warnings: [], source: 'manual' }, false, '', '');
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
    this.applyForm('draft', '修正课程', form, extras, true, course.rawText, course.warnings.join('；'));
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
        this.applyForm('saved', '修改课程', form, extras, true, course.rawText, course.warnings.join('；'));
        this.setData({ status: 'ready', footnote: course.source === 'manual' ? '手工添加的课程' : '来自导入的课程' });
      })
      .catch((error) => this.setData({ status: 'error', errorMessage: messageOf(error) }));
  },
  applyForm(scope: Scope, title: string, form: CourseForm, extras: CourseExtras, deletable: boolean, rawText: string, warningText: string) {
    this.extras = extras;
    this.setData({
      scope,
      title,
      form,
      deletable,
      rawText,
      warningText,
      errorMessage: '',
    });
  },
  onNameInput(event: InputEvent) {
    this.setData({ 'form.name': event.detail.value });
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
  onWeeksInput(event: InputEvent) {
    this.setData({ 'form.weeksText': event.detail.value });
  },
  onWeekdayChange(event: PickerEvent) {
    this.setData({ 'form.weekdayIndex': toIndex(event.detail.value, this.data.form.weekdayIndex) });
  },
  onStartChange(event: PickerEvent) {
    this.setData({ 'form.startIndex': toIndex(event.detail.value, this.data.form.startIndex) });
  },
  onEndChange(event: PickerEvent) {
    this.setData({ 'form.endIndex': toIndex(event.detail.value, this.data.form.endIndex) });
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
