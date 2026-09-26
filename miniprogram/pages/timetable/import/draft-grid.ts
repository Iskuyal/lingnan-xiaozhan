/**
 * 导入草稿 → 周网格（设计图 13 的「课表」视图）。
 *
 * 落位规则**不在本文件里重新实现**：复用主页的 `buildGrid`（services/timetable/view.ts），
 * 于是自适应列宽、连堂合并、同格折叠、分级信息、泳道与主页逐条一致。这里只补网格不认识的三件事：
 *
 * 1. **草稿没有 id**：用 `draftId` 当临时 id（没有 draftId 时按序编号），网格的块 id、
 *    同格折叠的成员表与 WXML 的 `wx:key` 都用它；
 * 2. **不筛周次**：这张网格回答的是「每门课落在星期几第几节」，不是「第 N 周有什么课」，
 *    所以映射时统一按「每周」（`weeks: []` / `weeksRecognized: true`）。真实周次以列表视图为准；
 * 3. **不猜位置**：节次缺失、星期越界或节次超出 1-12 节的草稿交给 `buildGrid` 同样画不出来，
 *    它们不落格，由页面用「N 条待补全，切到列表可以修正」说明去向——本模块把这类条数算好给页面。
 *
 * 颜色也沿用主页：`buildGrid` 按课程名取色（services/timetable/palette.ts），
 * 所以草稿卡与草稿块同名同色，不需要在这里传色。
 */
import { Course, DraftCourse, TimetableDraft } from '../../../services/timetable/types';
import { GridLayout, blockingReason, buildGrid } from '../../../services/timetable/view';

/** 课程名缺失时的占位名：与列表视图同一句，避免同一条草稿在两种视图里两种叫法。 */
export const UNKNOWN_COURSE_NAME = '课程名未识别';

/**
 * 交给 `buildGrid` 的教学周序号。映射后的草稿都是「每周」，所以这个值只影响返回里的
 * `week` / `weekLabel`，页面不展示它们（导入页没有周次切换）。
 */
const PLACEMENT_WEEK = 1;

/** 草稿课程 → `Course` 形状的临时对象（网格只认 Course）。 */
export function toCourse(course: DraftCourse, index: number, semester: string): Course {
  return {
    id: course.draftId === '' ? `draft-${index}` : course.draftId,
    name: course.name.trim() === '' ? UNKNOWN_COURSE_NAME : course.name,
    credits: course.credits,
    teacher: course.teacher,
    weekday: course.weekday,
    startSection: course.startSection,
    endSection: course.endSection,
    sectionRanges: course.sectionRanges,
    // 「每周」：导入页的网格不筛周次，见文件头第 2 条。
    weeks: [],
    weeksRecognized: true,
    weekText: course.weekText,
    location: course.location,
    campus: course.campus,
    siteNumber: course.siteNumber,
    note: course.note,
    warnings: course.warnings,
    source: course.source,
    semester,
    rawText: course.rawText,
    createdAt: '',
    updatedAt: '',
  };
}

export interface DraftGridResult {
  layout: GridLayout;
  /** 画不进网格的条数：缺节次、星期越界或节次超出 1-12 节。 */
  unplaced: number;
  /**
   * 其中属于「待补全」口径（`blockingReason` 非空）的条数。页面据此避免同一件事说两遍：
   * 这些条目由「N 条待补全」那句负责说明，只有剩下的（字段齐全但节次越界）才另说一句。
   */
  unplacedBlocked: number;
}

export function buildDraftGrid(draft: TimetableDraft): DraftGridResult {
  const courses = draft.courses.map((course, index) => toCourse(course, index, draft.meta.semester));
  const layout = buildGrid(courses, PLACEMENT_WEEK);

  // 落没落格以网格自己的结果为准（块里出现的 id 就是落格了的），不在这里重算一遍放置规则——
  // 重算就多了一处会与 view.ts 漂移的判断。
  const placedIds = new Set<string>();
  for (const column of layout.columns) {
    for (const block of column.blocks) for (const id of block.ids) placedIds.add(id);
  }
  const unplacedCourses = courses.filter((course) => !placedIds.has(course.id));
  return {
    layout,
    unplaced: unplacedCourses.length,
    unplacedBlocked: unplacedCourses.filter((course) => blockingReason(course) !== '').length,
  };
}
