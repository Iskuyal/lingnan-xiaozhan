/**
 * 课程管理（设计图 08）：统计 + 筛选 + 多选批量删除。
 *
 * 45 门课要能成批收拾：一屏看清总量与本周在读，按「待核对 / 手工 / 导入」筛出要点名的那些，
 * 勾选后一次删掉。删除走 `deleteCourse(id)` **逐个调用**——云函数按 openid 校验归属，
 * 一条失败不影响其余，结束时如实报出成功与失败的门数，不把部分失败说成成功。
 *
 * 与主页同一套语言：玻璃面板、琥珀只用于警告（待核对），品牌红只用于选中态与主要动作。
 * 学校作息未核实，这一页**不出现任何具体时刻**；课程色条的颜色与周网格同一口径
 * （显式指定优先，否则按课程名，见 services/timetable/palette.ts）。
 *
 * 「本周在读」的口径：按当前周次与 `occursInWeek` 算（未识别周次的课按每周展示）。
 * 当前周次来自入口参数 `?week=N`——主页知道自己正在看第几周，进来时带过来；
 * 直接打开（没有参数）时退回第 1 周。学期设置（开学日）落地后，这里改成
 * `weekIndexOf(config, 今天)` 优先即可，页面其余部分不用动。
 */
import { Course } from '../../../services/timetable/types';
import { deleteCourse, listCourses, messageOf } from '../../../services/timetable/index';
import { occursInWeek, sectionLabelOf, semesterLabel, weekdayLabel, weekLabelOf } from '../../../services/timetable/view';
import { courseColor } from '../../../services/timetable/palette';

type Status = 'loading' | 'empty' | 'ready' | 'error';
/** 四个筛选：全部 / 待核对 / 手工 / 导入。 */
type FilterKey = 'all' | 'review' | 'manual' | 'imported';

interface DatasetEvent {
  currentTarget: { dataset: { id?: string; key?: string } };
}

interface Query {
  week?: string;
}

/** 列表行：模板只负责画，副行文案与色条颜色都在这里算好。 */
interface ManageRow {
  id: string;
  name: string;
  /** 「星期 · 节次 · 周次 · 教师」，缺的字段不出现。 */
  sub: string;
  /** 课程色条实色（色板 solid）。 */
  solid: string;
  needsReview: boolean;
  manual: boolean;
  selected: boolean;
}

interface Stats {
  total: number;
  weekIn: number;
  review: number;
  manual: number;
  imported: number;
}

/** 筛选口径：待核对 = warnings 非空；导入 = 来源不是手工（含 Excel 与截图识别）。 */
function matchesFilter(course: Course, filter: FilterKey): boolean {
  if (filter === 'review') return course.warnings.length > 0;
  if (filter === 'manual') return course.source === 'manual';
  if (filter === 'imported') return course.source !== 'manual';
  return true;
}

/** 列表顺序：星期、首个节次、课程名（与主页列表同一口径，按星期找得到）。 */
function orderedCourses(courses: Course[]): Course[] {
  return [...courses].sort((a, b) => a.weekday - b.weekday
    || (a.sectionRanges[0]?.start ?? 99) - (b.sectionRanges[0]?.start ?? 99)
    || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

/** 副行：星期 · 节次 · 周次 · 教师；缺的字段不显示，也不补「未填」这类占位。 */
function subLineOf(course: Course): string {
  const parts = [weekdayLabel(course.weekday), sectionLabelOf(course), weekLabelOf(course)];
  const teacher = course.teacher.trim();
  if (teacher !== '') parts.push(teacher);
  return parts.filter((part) => part !== '').join(' · ');
}

/**
 * 色条颜色：与周网格同一口径（显式指定优先，否则按课程名）。
 * 两处若各取一套，学生会以为「同一门课在管理页换了颜色」。
 */
function colorOf(course: Course): string {
  const explicit = (course as Course & { color?: string }).color ?? '';
  return courseColor(course.name, explicit).solid;
}

function buildRows(courses: Course[], filter: FilterKey, selectedIds: string[]): ManageRow[] {
  return orderedCourses(courses.filter((course) => matchesFilter(course, filter))).map((course) => ({
    id: course.id,
    name: course.name,
    sub: subLineOf(course),
    solid: colorOf(course),
    needsReview: course.warnings.length > 0,
    manual: course.source === 'manual',
    selected: selectedIds.includes(course.id),
  }));
}

/** 统计口径：共 N 门 = 云端返回的条数；本周在读 = occursInWeek(当前周次)。 */
function statsOf(courses: Course[], week: number): Stats {
  let weekIn = 0;
  let review = 0;
  let manual = 0;
  for (const course of courses) {
    if (occursInWeek(course, week)) weekIn += 1;
    if (course.warnings.length > 0) review += 1;
    if (course.source === 'manual') manual += 1;
  }
  return { total: courses.length, weekIn, review, manual, imported: courses.length - manual };
}

/**
 * 列表派生数据：行、选中数、全选状态、动作条是否出现。
 * 筛选、勾选、重读云端都只经过这里，三处不会各算一套。
 */
function viewPatch(courses: Course[], selectedIds: string[], filter: FilterKey) {
  const rows = buildRows(courses, filter, selectedIds);
  const visibleIds = rows.map((row) => row.id);
  return {
    filter,
    rows,
    selectedIds,
    selectedCount: selectedIds.length,
    allSelected: visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id)),
    showActions: rows.length > 0 || selectedIds.length > 0,
  };
}

function statsPatch(stats: Stats) {
  return {
    total: stats.total,
    weekInCount: stats.weekIn,
    reviewCount: stats.review,
    manualCount: stats.manual,
    importedCount: stats.imported,
  };
}

Page({
  data: {
    status: 'loading' as Status,
    errorMessage: '',
    semesterText: '',
    courses: [] as Course[],
    filter: 'all' as FilterKey,
    rows: [] as ManageRow[],
    selectedIds: [] as string[],
    selectedCount: 0,
    allSelected: false,
    showActions: false,
    deleting: false,
    total: 0,
    weekInCount: 0,
    reviewCount: 0,
    manualCount: 0,
    importedCount: 0,
  },
  /** 当前周次：只用于「本周在读」的口径，界面上不显示。 */
  week: 1,
  onLoad(query: Query) {
    const week = Number(query.week ?? '');
    this.week = Number.isInteger(week) && week >= 1 ? week : 1;
  },
  /** 每次显示都重读云端：从删除、编辑或导入返回时看到的都是最新数据。 */
  onShow() {
    return this.load();
  },
  load() {
    if (this.data.courses.length === 0) this.setData({ status: 'loading', errorMessage: '' });
    return listCourses()
      .then((feed) => {
        const courses = feed.courses;
        const stats = statsOf(courses, this.week);
        // 云端已经不存在的课程要从选中集里去掉，否则「删除所选 N 门」会把已删掉的算进去。
        const selectedIds = this.data.selectedIds.filter((id) => courses.some((course) => course.id === id));
        this.setData({
          courses,
          semesterText: semesterLabel(feed.semester),
          ...statsPatch(stats),
          ...viewPatch(courses, selectedIds, this.data.filter),
          status: courses.length === 0 ? 'empty' : 'ready',
          errorMessage: '',
          deleting: false,
        });
      })
      .catch((error) => {
        // 读不到就如实说明并给重试入口，不静默显示旧内容。
        this.setData({ status: 'error', errorMessage: messageOf(error), deleting: false });
      });
  },
  retry() {
    return this.load();
  },
  /** 切筛选：只换看得到的行，课程数据、统计与选中态都不动。 */
  selectFilter(event: DatasetEvent) {
    const key = event.currentTarget.dataset.key;
    if (key !== 'all' && key !== 'review' && key !== 'manual' && key !== 'imported') return;
    this.setData(viewPatch(this.data.courses, this.data.selectedIds, key));
  },
  /** 筛选后为空时的一键出口。 */
  resetFilter() {
    this.setData(viewPatch(this.data.courses, this.data.selectedIds, 'all'));
  },
  toggleRow(event: DatasetEvent) {
    const id = event.currentTarget.dataset.id;
    // 删除进行中不再接受勾选：那批 id 已经定下，中途改动只会让人以为改动生效了。
    if (id === undefined || id === '' || this.data.deleting) return;
    const selected = this.data.selectedIds;
    const next = selected.includes(id) ? selected.filter((item) => item !== id) : selected.concat([id]);
    this.setData(viewPatch(this.data.courses, next, this.data.filter));
  },
  /** 全选 / 取消全选只作用于**当前筛选下看得见的行**（勾选顺序即删除顺序）。 */
  toggleSelectAll() {
    const visible = this.data.rows.map((row) => row.id);
    if (visible.length === 0 || this.data.deleting) return;
    const selected = this.data.selectedIds;
    const next = visible.every((id) => selected.includes(id))
      ? selected.filter((id) => !visible.includes(id))
      : selected.concat(visible.filter((id) => !selected.includes(id)));
    this.setData(viewPatch(this.data.courses, next, this.data.filter));
  },
  /** 批量删除：先二次确认（文案里带门数），取消不写任何数据。 */
  deleteSelected() {
    const ids = this.data.selectedIds.slice();
    if (ids.length === 0 || this.data.deleting) return Promise.resolve();
    return new Promise<void>((resolve) => {
      wx.showModal({
        title: '删除所选课程',
        content: `确定删除所选的 ${ids.length} 门课程吗？删除会连同这些课的全部分段一起删掉，无法撤销。`,
        confirmText: '删除',
        success: (result) => {
          if (result.confirm !== true) {
            resolve();
            return;
          }
          resolve(this.removeSelected(ids));
        },
      });
    });
  },
  /**
   * 逐个调用 `deleteCourse`（云函数按 openid 校验归属）：一条失败不影响其余，
   * 结束后无论成败都以云端为准重读列表并清空选中，再如实报出成功与失败的门数。
   */
  async removeSelected(ids: string[]) {
    this.setData({ deleting: true });
    let succeeded = 0;
    const failed: string[] = [];
    let firstError = '';
    for (const id of ids) {
      try {
        await deleteCourse(id);
        succeeded += 1;
      } catch (error) {
        failed.push(id);
        if (firstError === '') firstError = messageOf(error);
      }
    }
    this.setData({ selectedIds: [] });
    await this.load();
    if (failed.length === 0) {
      wx.showToast({ title: `已删除 ${succeeded} 门课程`, icon: 'success' });
      return;
    }
    wx.showModal({
      title: failed.length === ids.length ? '删除没有完成' : '部分课程没有删掉',
      content: `${succeeded} 门成功、${failed.length} 门失败：${firstError}`,
      showCancel: false,
      confirmText: '知道了',
    });
  },
  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/timetable/index' });
  },
});
