/** 已保存计划的只读视图：按生成时的日历日期定位，不随新学期的“第N周”错位。 */
import { StudyPlan, blockDescribe } from './plan';
import { Course } from '../timetable/types';
import { TimetableSettings } from '../timetable/settings';
import { addDays, weekDates, weekIndexOf, weekdayOf } from '../timetable/semester';
import { occursInWeek } from '../timetable/view';
import { diffDays } from '../dates/index';

export interface SavedPlanRow {
  id: string; label: string; date: string;
  status: 'saved' | 'past' | 'conflict' | 'unknown'; note: string;
}
export interface SavedPlanView {
  hasPlan: boolean; title: string; goalName: string; range: string; summary: string;
  rows: SavedPlanRow[]; notice: string; matchingWeek: number | null;
}
export function savedPlanView(
  plan: StudyPlan | null, courses: Course[], settings: TimetableSettings, today: string,
  coursesKnown = true, displayedWeek?: number,
): SavedPlanView {
  const empty: SavedPlanView = { hasPlan: false, title: '', goalName: '', range: '', summary: '', rows: [], notice: '', matchingWeek: null };
  if (plan === null) return empty;
  const weekday = weekdayOf(plan.today);
  const monday = weekday === null ? '' : addDays(plan.today, 1 - weekday);
  const matchingWeek = weekIndexOf(settings, monday);
  const dates = displayedWeek === undefined ? null : weekDates(settings, displayedWeek);
  const matches = displayedWeek === undefined || dates?.start === monday;
  const rows: SavedPlanRow[] = plan.blocks.map((block) => {
    const date = addDays(monday, (block.week - plan.week) * 7 + block.weekday - 1);
    const past = (diffDays(date, today) ?? 0) > 0;
    const beyondGoal = (diffDays(plan.goalDate, date) ?? 0) > 0;
    const week = weekIndexOf(settings, date);
    const conflicts = coursesKnown ? courses.filter((course) => course.weekday === block.weekday
      && (week === null || occursInWeek(course, week))
      && (course.sectionRanges.length > 0 ? course.sectionRanges : [{ start: course.startSection, end: course.endSection }])
        .some((range) => range.start <= block.endSection && block.startSection <= range.end)).map((course) => course.name) : [];
    return { id: block.id, label: blockDescribe(block), date,
      status: past ? 'past' : beyondGoal || conflicts.length > 0 ? 'conflict' : coursesKnown ? 'saved' : 'unknown',
      note: past ? '这段安排的日期已过去' : beyondGoal ? '这段旧安排超出目标日期，请重新生成后核对' : conflicts.length > 0 ? `与「${[...new Set(conflicts)].join('」「')}」时段重叠，请重新生成后核对`
        : coursesKnown ? '' : '课表暂未读取，尚未核对当前课程冲突' };
  });
  const expired = (diffDays(plan.goalDate, today) ?? 0) > 0;
  const notice = !matches ? (matchingWeek === null
    ? '已保存计划的日期无法对应当前学期，请先核对开学日；仍可打开原计划查看。'
    : `这份计划对应第${matchingWeek}周（${monday}起），当前周不展开；仍可打开查看。`) : expired ? '目标日期已过去，以下保留保存时的安排，不会自动删除。'
    : '这是保存时的安排，课程或目标日变化后请重新生成；不会自动改写。';
  return { hasPlan: true, title: expired ? '已保存的历史计划' : '已保存的本周计划', goalName: plan.goalName,
    range: `${monday} — ${addDays(monday, 6)}`, summary: `${plan.today}生成 · ${plan.blocks.length}段 / ${plan.totalMinutes}分钟`,
    rows: matches ? rows.filter((row) => displayedWeek === undefined || (dates !== null && row.date >= dates.start && row.date <= dates.end)) : [], notice, matchingWeek };
}
