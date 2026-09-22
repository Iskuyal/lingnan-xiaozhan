/**
 * 课表数据模型（小程序侧）。
 *
 * 与 `cloudfunctions/timetable/types.ts` 保持一致：微信云函数按目录整体部署，没有跨目录
 * 共享模块的机制，因此两份类型各自存在。字段名是云函数与小程序之间的数据契约，改名要同步。
 *
 * 客户端**不直连数据库**：读取与写入都经 `wx.cloud.callFunction({ name: 'timetable' })`，
 * 由云函数按调用上下文的 openid 过滤（见 docs/development-spec.md 的「存储与隔离」）。
 */

export interface SectionRange {
  /** 起始节（含），1-12。 */
  start: number;
  /** 结束节（含），不小于 start。 */
  end: number;
}

/** 一条已保存的课程（云端记录去掉 owner）。 */
export interface Course {
  /** 服务端生成的稳定标识，页面间传参用它。 */
  id: string;
  name: string;
  credits: string;
  teacher: string;
  /** 1-7 对应星期一至星期日。 */
  weekday: number;
  /** 节次原文解析出的起止节；倒置或越界时保留原值，sectionRanges 为空。 */
  startSection: number;
  endSection: number;
  /** 有效节次区间；空数组表示节次待补全。 */
  sectionRanges: SectionRange[];
  /** 展开后的教学周；空数组表示「每周」或未识别（看 weeksRecognized）。 */
  weeks: number[];
  /** 周次是否被识别；false 时 weeks 为空，原文保留在 weekText。 */
  weeksRecognized: boolean;
  weekText: string;
  location: string;
  campus: string;
  siteNumber: string;
  note: string;
  /** 待核对提示；空数组表示解析无疑点。 */
  warnings: string[];
  source: 'excel' | 'manual' | 'photo';
  /** 学期标注，如「2026-2027学年第一学期」；空字符串表示未标注。 */
  semester: string;
  /** 导入时的单元格原文；手工录入为空。 */
  rawText: string;
  /** 手动指定的课程色：`palette.ts` 的 key（如 `c4`）；空字符串或缺失表示按课程名自动取色。 */
  color?: string;
  createdAt: string;
  updatedAt: string;
}

/** 导入草稿里的课程：已保存课程去掉标识与学期，加上草稿定位与来源位置。 */
export interface DraftCourse {
  draftId: string;
  name: string;
  credits: string;
  teacher: string;
  weekday: number;
  startSection: number;
  endSection: number;
  sectionRanges: SectionRange[];
  weeks: number[];
  weeksRecognized: boolean;
  weekText: string;
  location: string;
  campus: string;
  siteNumber: string;
  note: string;
  warnings: string[];
  source: 'excel' | 'photo';
  rawText: string;
  sourceRowLabel: string;
  sourceWeekdayLabel: string;
  /** 手动指定的课程色 key；空字符串或缺失表示按课程名自动取色。 */
  color?: string;
}

export interface DraftMeta {
  sheetName: string;
  fileName: string;
  /** 草稿来源：文件解析或截图识别。仅客户端组装（截图识别走 05）时使用，云解析不返回该字段。 */
  origin?: 'excel' | 'photo';
  school: string;
  semester: string;
  exportedAt: string;
  department: string;
  grade: string;
  major: string;
  className: string;
}

export interface DraftStats {
  sheets: number;
  cells: number;
  entries: number;
  courses: number;
  duplicates: number;
  warnings: number;
}

export interface TimetableDraft {
  meta: DraftMeta;
  courses: DraftCourse[];
  problems: string[];
  stats: DraftStats;
}

/** 手工表单或编辑后的提交内容；服务端会再校验一次。 */
export interface CourseInput {
  name: string;
  credits: string;
  teacher: string;
  weekday: number;
  startSection: number;
  endSection: number;
  sectionRanges: SectionRange[];
  weeks: number[];
  weeksRecognized: boolean;
  weekText: string;
  location: string;
  campus: string;
  siteNumber: string;
  note: string;
  warnings: string[];
  source: 'excel' | 'manual' | 'photo';
  /**
   * 手动指定的课程色：`palette.ts` 的 key（如 `c4`）。
   * 空字符串或缺失表示按课程名自动取色（同名课程恒定同色，见 `palette.ts`）；
   * 云函数侧只接受 8 个合法 key 或空，其余一律归为空（静默回落到按名取色，不改写记录）。
   */
  color?: string;
}
