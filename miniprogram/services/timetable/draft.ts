/**
 * 导入草稿的临时存放（内存，仅本次导入会话有效）。
 *
 * 草稿只在内存里：关闭小程序或放弃导入后即丢失，而**解析阶段本来就没有写任何数据**，
 * 因此「放弃导入不写入任何数据」不依赖清理逻辑。确认页与编辑页之间用它传递草稿。
 */
import { DraftCourse, TimetableDraft } from './types';

let current: TimetableDraft | null = null;

export function setDraft(draft: TimetableDraft): void {
  current = draft;
}

export function getDraft(): TimetableDraft | null {
  return current;
}

export function hasDraft(): boolean {
  return current !== null && current.courses.length > 0;
}

export function clearDraft(): void {
  current = null;
}

/** 删除草稿里的一条课程；下标越界或没有草稿时返回 false。 */
export function removeCourseAt(index: number): boolean {
  if (current === null || index < 0 || index >= current.courses.length) return false;
  current.courses.splice(index, 1);
  current.stats.courses = current.courses.length;
  return true;
}

/** 用编辑结果替换草稿里的一条课程。 */
export function replaceCourseAt(index: number, course: DraftCourse): boolean {
  if (current === null || index < 0 || index >= current.courses.length) return false;
  current.courses[index] = course;
  return true;
}
