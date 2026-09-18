/**
 * 课表的数据契约（云函数侧）。
 *
 * 解析跑在云函数里：客户端把文件上传到本人云存储路径，云函数下载后解析成「草稿」返回，
 * 学生确认后才写库（见 docs/development-spec.md 的「课表导入」一节）。
 * 小程序侧的类型在 `miniprogram/services/timetable/types.ts`，字段名是两侧的契约，改名要同步。
 */

/** 星期列的表头文案，索引 0 对应星期一。 */
export const WEEKDAY_LABELS = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
/** 一天最多 12 节：真实样本的大节行标「一~六」对应 1-2 … 11-12 节。 */
export const MAX_SECTION = 12;
/** 教学周上限：真实样本最大 19 周；超过 30 按越界标记，不擅自截断。 */
export const MAX_WEEK = 30;
/** 导入草稿在云存储里的路径前缀；每个用户的路径带自己的 openid 哈希。 */
export const UPLOAD_ROOT = 'timetable-imports';

export interface SectionRange {
  /** 起始节（含），1-12。 */
  start: number;
  /** 结束节（含），不小于 start。 */
  end: number;
}

/** 一条课程记录的业务字段，导入与手工录入共用。 */
export interface CourseFields {
  name: string;
  /** 学分原样保留（样本里有 0.25 这类小数），未识别时为空字符串。 */
  credits: string;
  teacher: string;
  /** 1-7 对应星期一至星期日；0 表示未识别。 */
  weekday: number;
  /** 节次原文解析出的起始节；越界或倒置时保留原值，同时 sectionRanges 为空并给 warning。 */
  startSection: number;
  /** 节次原文解析出的结束节；未识别时为 0。 */
  endSection: number;
  /** 节次区间；识别的节次倒置或越界时为空数组，并在 warnings 里说明。 */
  sectionRanges: SectionRange[];
  /** 周次展开后的教学周；空数组表示未识别或「每周」。 */
  weeks: number[];
  /** 周次是否被识别；false 时 weeks 为空，原文保留在 weekText。 */
  weeksRecognized: boolean;
  /** 周次原文，如 `[2-6,8-17]周`。 */
  weekText: string;
  location: string;
  campus: string;
  siteNumber: string;
  /** 单元格里的附加信息，如教学班「1班」、方向「农民画」。 */
  note: string;
  /** 待核对提示；空数组表示解析无疑点。 */
  warnings: string[];
  /** 记录来源：导入或手工录入。 */
  source: 'excel' | 'manual';
}

/** 解析出来的草稿课程：业务字段 + 原文与来源位置，供确认页展示与裁决。 */
export interface DraftCourse extends CourseFields {
  /** 草稿内标识，仅用于确认页定位，不写入数据库。 */
  draftId: string;
  /** 单元格条目原文，学生在确认页据此核对。 */
  rawText: string;
  /** 大节行标原文（如「一」）；未识别时为空字符串。 */
  sourceRowLabel: string;
  /** 星期列原文（如「星期一」）。 */
  sourceWeekdayLabel: string;
  source: 'excel';
}

/** 课表文件的元信息，取自文件头几行。 */
export interface DraftMeta {
  /** 工作表名。 */
  sheetName: string;
  fileName: string;
  /** 学校名称，取自文件首行。 */
  school: string;
  /** 学年学期，如「2026-2027学年第一学期」。 */
  semester: string;
  /** 文件导出时间原文，可能为空。 */
  exportedAt: string;
  department: string;
  grade: string;
  major: string;
  className: string;
}

export interface DraftStats {
  /** 参与解析的工作表数量。 */
  sheets: number;
  /** 有内容的（星期 × 大节）单元格数。 */
  cells: number;
  /** 单元格里的课程条目数（未去重）。 */
  entries: number;
  /** 去重后课程数。 */
  courses: number;
  /** 因跨大节重复而合并掉的条目数。 */
  duplicates: number;
  /** 带待核对提示的课程数。 */
  warnings: number;
}

export interface TimetableDraft {
  meta: DraftMeta;
  courses: DraftCourse[];
  /** 整份文件层面的问题，如跳过的工作表。 */
  problems: string[];
  stats: DraftStats;
}

/** 数据库记录：业务字段 + 归属与时间戳。`owner` 只来自云函数调用上下文，不接受客户端传入。 */
export interface StoredCourse extends CourseFields {
  id: string;
  owner: string;
  semester: string;
  rawText: string;
  createdAt: string;
  updatedAt: string;
}
