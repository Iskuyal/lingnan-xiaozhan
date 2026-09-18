/**
 * 我的课表（Ticket 03）。
 *
 * 数据来自 `timetable` 云函数（按微信身份隔离），页面每次显示都从云端重读，
 * 因此退出重进、换设备都能看到同一份课表。学校作息未核实，周课表只按节次展示。
 */
import { Course } from '../../services/timetable/types';
import { FILE_GUIDE, OFFLINE_NOTE, deleteCourse, listCourses, messageOf } from '../../services/timetable/index';
import { WEEKDAY_SHORT, WeekView, buildWeekView, formatUpdatedAt, semesterLabel, weekSpan } from '../../services/timetable/view';

type Status = 'loading' | 'empty' | 'ready' | 'error';

interface DatasetEvent {
  currentTarget: { dataset: { id?: string; name?: string } };
}

interface PickerEvent {
  detail: { value: string | number };
}

/** 选择器变化时的通用取值：picker 的 value 是下标（字符串或数字）。 */
function pickerIndex(value: string | number): number {
  const index = Number(value);
  return Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0;
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
    fileGuide: FILE_GUIDE,
    offlineNote: OFFLINE_NOTE,
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
  goHome() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/home/index' });
  },
});
