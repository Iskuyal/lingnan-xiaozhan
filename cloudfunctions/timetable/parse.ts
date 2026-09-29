/**
 * 教务课表 Excel 的网格解析器（云函数侧）。
 *
 * 真实导出不是「一行一课」的平表，而是网格矩阵：
 * 元信息行 → 表头行「星期一 … 星期日」→ 大节行（行标「一~六」对应起始节次 1/3/5/7/9/11），
 * 每个（星期 × 大节）单元格里是若干条
 * `课程名 学分 教师 [周次]周 起-止节 楼-房间-用途 校区 场地编号`。
 *
 * 解析纪律（见 docs/product/spec.md「导入文件版式」）：**识别不出的只标记不猜**。
 * 周次写法不认识、节次倒置或越界时保留原值并写 warnings，交确认页由学生裁决；
 * 大节行标识别不出时不会按行序推断节次。
 *
 * 这个模块依赖 npm 的 `xlsx`，只被云函数引用；小程序包不引用它（见
 * tests/miniprogram-modules.test.cjs 的产物断言）。
 */
import * as XLSX from 'xlsx';
import { DraftCourse, DraftMeta, DraftStats, SectionRange, TimetableDraft, MAX_SECTION, MAX_WEEK } from './types';

/** 解析失败：文件不是可识别的课表矩阵，或根本无法按 Excel 读取。 */
export class TimetableParseError extends Error {}

const WEEKDAY_TEXT = /^星期([一二三四五六日天])$/u;
const WEEKDAY_BY_CHAR: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
/** 大节行标 → 起始节次。一 = 1-2 节 … 六 = 11-12 节（真实样本实测）。 */
const BIG_SECTION_START: Record<string, number> = {
  一: 1, 二: 3, 三: 5, 四: 7, 五: 9, 六: 11,
  '1': 1, '2': 3, '3': 5, '4': 7, '5': 9, '6': 11,
};
/**
 * 周次写法：`[2-6,8-17]周`、`[4]周`，方括号可有可无，内部是逗号（半角、全角或顿号）分隔的数字或区间。
 * 顿号也要接受：手工表单里的周次按 `4-5、7-8` 展示，编辑后需要能原样再解析。
 */
const WEEK_TOKEN = /^[\[［]?\s*(\d+(?:\s*-\s*\d+)?(?:\s*[,，、]\s*\d+(?:\s*-\s*\d+)?)*)\s*[\]］]?\s*周$/u;
/** 周次列表的分隔符。 */
const WEEK_SEPARATOR = /[,，、]/u;
/** 可能是周次、但写法不在已核实语法里的 token（如「单周」）；必须以「周」结尾才算候选。 */
const WEEK_LIKE_TOKEN = /^[\[［]?\s*(?:\d|单周|双周)/u;
const SECTION_RANGE = /第?\s*(\d{1,2})\s*[-—–~至]\s*(\d{1,2})\s*节/u;
const SECTION_SINGLE = /第?\s*(\d{1,2})\s*节/u;
const CAMPUS_TOKEN = /校区$/u;
const LABEL_VALUE = /^\s*([^：:]{1,12})[：:]\s*(.+)$/u;
const SCHOOL_TERM = /^(.*?)(\d{4}\s*-\s*\d{4}\s*学年\s*(?:第\s*[一二三四五六七八九十\d]{1,2})?\s*学期)/u;
const EXPORTED_AT = /(\d{4}\s*-\s*\d{1,2}\s*-\s*\d{1,2}\s+\d{1,2}:\d{2})/u;

interface EntryContext {
  weekday: number;
  weekdayLabel: string;
  rowLabel: string;
  /** 大节行标对应的起始节次；0 表示行标未识别。 */
  rowStartSection: number;
}

/** 单元格文本归一化：全角空格与制表符按空白处理，去掉行首尾空白。 */
function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\u3000/g, ' ').replace(/[\t\r]+/g, ' ').trim();
}

/** 单元格拆条目：一行一条。空行分隔（`\n \n`）与单换行分隔两种变体都因此得到同一种处理。 */
export function splitCellEntries(text: string): string[] {
  return String(text)
    .split('\n')
    .map((line) => normalizeText(line))
    .filter((line) => line !== '');
}

/**
 * 展开周次写法；不认识的写法返回 recognized=false，由调用方标警告。
 *
 * 上限与小程序侧 `miniprogram/services/timetable/weeks.ts` 保持一致：越界（小于 1、
 * 大于 MAX_WEEK）与倒置区间都算「不认识」，保留原文交学生裁决——若这里放行，
 * 保存时的整批校验会拒绝，学生只看到一句「保存失败」却无从下手。
 */
export function parseWeekNotation(token: string): { weeks: number[]; recognized: boolean } {
  const match = WEEK_TOKEN.exec(normalizeText(token));
  if (match === null) return { weeks: [], recognized: false };
  const weeks: number[] = [];
  for (const part of match[1].split(WEEK_SEPARATOR)) {
    const bounds = part.split('-');
    const start = Number(bounds[0]);
    const end = bounds.length > 1 ? Number(bounds[1]) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { weeks: [], recognized: false };
    if (start < 1 || end > MAX_WEEK || end < start) return { weeks: [], recognized: false };
    for (let week = start; week <= end; week += 1) weeks.push(week);
  }
  if (weeks.length === 0) return { weeks: [], recognized: false };
  return { weeks: [...new Set(weeks)].sort((a, b) => a - b), recognized: true };
}

/**
 * 周次 token 是纯数字写法、但超出 1-MAX_WEEK 或区间倒置：用来把提示写得具体，
 * 而不是笼统说「写法未能识别」。非数字写法（如「单周」）返回 false。
 */
export function weekTokenOutOfRange(token: string): boolean {
  const match = WEEK_TOKEN.exec(normalizeText(token));
  if (match === null) return false;
  return match[1].split(WEEK_SEPARATOR).some((part) => {
    const bounds = part.split('-');
    const start = Number(bounds[0]);
    const end = bounds.length > 1 ? Number(bounds[1]) : start;
    return Number.isFinite(start) && Number.isFinite(end) && (start < 1 || end > MAX_WEEK || end < start);
  });
}

/** 合并节次区间：去重、按起始节排序，相邻或重叠的区间合并成一段。 */
export function mergeSectionRanges(ranges: SectionRange[]): SectionRange[] {
  const sorted = [...ranges].filter((item) => item.start >= 1 && item.end >= item.start).sort((a, b) => a.start - b.start);
  const merged: SectionRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
      continue;
    }
    merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

/**
 * 姓名形态：2-4 个汉字，不含数字、字母与标点。
 * 只用于「原文没有学分」时的兜底拆分；它是形态判断而非确定结论，必须留下待核对提示。
 */
function isTeacherLike(token: string): boolean {
  return /^[\u4e00-\u9fff]{2,4}$/u.test(token);
}

/**
 * 解析一条课程串。识别不出的部分保留原值并写进 warnings，不替学生填。
 * 返回的 rawText 永远是单元格里的原文。
 */
export function parseCourseEntry(rawText: string, ctx: EntryContext, index: number): DraftCourse {
  const text = normalizeText(rawText);
  const warnings: string[] = [];
  const tokens = text.split(/\s+/).filter((token) => token !== '');

  // 1. 周次锚点：找第一个「像周次」的 token，用它把课程名/学分/教师与后面的节次地点分开。
  const weekIndex = tokens.findIndex((token) => token.endsWith('周') && (WEEK_LIKE_TOKEN.test(token) || WEEK_TOKEN.test(token)));
  let weekText = '';
  let weeks: number[] = [];
  let weeksRecognized = false;
  let before = tokens;
  let after = '';
  if (weekIndex < 0) {
    warnings.push('未找到周次信息，请核对原文');
    before = tokens;
  } else {
    weekText = tokens[weekIndex];
    const parsed = parseWeekNotation(weekText);
    weeks = parsed.weeks;
    weeksRecognized = parsed.recognized;
    if (!parsed.recognized) {
      warnings.push(weekTokenOutOfRange(weekText)
        ? `周次超出 1-${MAX_WEEK} 周范围或区间倒置（原文：${weekText}），请核对`
        : `周次写法未能识别（原文：${weekText}），已保留原文`);
    }
    before = tokens.slice(0, weekIndex);
    after = tokens.slice(weekIndex + 1).join(' ');
  }

  // 2. 课程名 / 学分 / 教师：学分是第一个纯数字 token，它之前是课程名（课程名可能含空格），之后是教师。
  //    真机实测有**不写学分**的版式（原文只有「课程名 教师 [周次]周 …」）：此时按最后一段的姓名形态
  //    兜底拆分，并留下待核对提示——学分缺失是原文事实，不猜一个学分出来；拆错了也能在确认页修正。
  let name = '';
  let credits = '';
  let teacher = '';
  const creditIndex = before.findIndex((token) => /^\d+(\.\d+)?$/u.test(token));
  if (creditIndex > 0) {
    name = before.slice(0, creditIndex).join(' ');
    credits = before[creditIndex];
    teacher = before.slice(creditIndex + 1).join(' ');
  } else if (creditIndex === 0) {
    credits = before[0];
    teacher = before.slice(1).join(' ');
    warnings.push('未能识别课程名，请核对原文');
  } else if (before.length > 1 && isTeacherLike(before[before.length - 1])) {
    teacher = before[before.length - 1];
    name = before.slice(0, before.length - 1).join(' ');
    warnings.push('原文没有学分；已按「课程名 … 教师」拆分（最后一段当作教师），请核对');
  } else if (before.length > 0) {
    name = before.join(' ');
    warnings.push('原文没有学分，也没有可识别的教师；课程名按整段保留，请核对');
  }
  if (credits === '' && before.length > 0) warnings.push('未解析到学分');
  if (teacher === '') warnings.push('未解析到教师');

  // 3. 节次：单元格原文优先；原文缺失时用大节行标的起始节次，行标也不认就什么都不填。
  let startSection = 0;
  let endSection = 0;
  let sectionFromText = false;
  const rangeMatch = SECTION_RANGE.exec(after);
  if (rangeMatch !== null) {
    startSection = Number(rangeMatch[1]);
    endSection = Number(rangeMatch[2]);
    sectionFromText = true;
  } else {
    const singleMatch = SECTION_SINGLE.exec(after);
    if (singleMatch !== null) {
      startSection = Number(singleMatch[1]);
      endSection = startSection;
      sectionFromText = true;
    }
  }
  const tailText = rangeMatch !== null
    ? `${after.slice(0, rangeMatch.index)} ${after.slice(rangeMatch.index + rangeMatch[0].length)}`
    : after;

  let sectionRanges: SectionRange[] = [];
  if (sectionFromText) {
    if (startSection < 1 || endSection > MAX_SECTION) {
      warnings.push(`节次超出 1-${MAX_SECTION} 节范围（原文：${startSection}-${endSection} 节），已保留原值`);
    } else if (endSection < startSection) {
      warnings.push(`节次起止倒置（原文：${startSection}-${endSection} 节），已保留原值`);
    } else {
      sectionRanges = [{ start: startSection, end: endSection }];
    }
  } else if (ctx.rowStartSection > 0) {
    startSection = ctx.rowStartSection;
    endSection = Math.min(ctx.rowStartSection + 1, MAX_SECTION);
    sectionRanges = [{ start: startSection, end: endSection }];
    warnings.push(`原文未给出节次，节次取自大节行标（第 ${startSection}-${endSection} 节），请核对`);
  } else {
    warnings.push('节次与大节行标都未能识别，请补全后再保存');
  }

  // 4. 地点：节次之后的 token 里，含短横线的是「楼-房间-用途」，纯数字是场地编号，以「校区」结尾的是校区，
  //    其余（教学班「1班」、方向「农民画」）作为备注保留。
  const tailTokens = tailText.split(/\s+/).filter((token) => token !== '');
  const campus = tailTokens.find((token) => CAMPUS_TOKEN.test(token)) ?? '';
  const numberTokens = tailTokens.filter((token) => /^\d+$/u.test(token));
  const siteNumber = numberTokens.length > 0 ? numberTokens[numberTokens.length - 1] : '';
  const rest = tailTokens.filter((token) => token !== campus && !numberTokens.includes(token));
  const dashed = rest.find((token) => /[-—–]/u.test(token));
  let location = '';
  let note = '';
  if (dashed !== undefined) {
    location = dashed;
    note = rest.filter((token) => token !== dashed).join(' ');
  } else if (rest.length > 0) {
    location = rest[rest.length - 1];
    note = rest.slice(0, -1).join(' ');
  }
  if (numberTokens.length > 1) note = `${note} ${numberTokens.slice(0, -1).join(' ')}`.trim();
  if (location === '') warnings.push('未解析到上课地点');

  return {
    draftId: `d${index}`,
    name,
    credits,
    teacher,
    weekday: ctx.weekday,
    startSection,
    endSection,
    sectionRanges,
    weeks,
    weeksRecognized,
    weekText,
    location,
    campus,
    siteNumber,
    note,
    rawText: text,
    sourceRowLabel: ctx.rowLabel,
    sourceWeekdayLabel: ctx.weekdayLabel,
    warnings,
    source: 'excel',
  };
}

interface SheetParseResult {
  courses: DraftCourse[];
  meta: DraftMeta;
  problems: string[];
  stats: DraftStats;
}

function cellAt(matrix: unknown[][], row: number, column: number): string {
  const line = matrix[row];
  if (line === undefined) return '';
  return normalizeText(line[column]);
}

/** 找出表头行与星期列；找不到返回 null（说明这张表不是课表矩阵）。 */
function findHeaderRow(matrix: unknown[][]): { row: number; columns: Map<number, number> } | null {
  for (let row = 0; row < matrix.length; row += 1) {
    const columns = new Map<number, number>();
    const line = matrix[row] ?? [];
    for (let column = 0; column < line.length; column += 1) {
      const match = WEEKDAY_TEXT.exec(cellAt(matrix, row, column));
      if (match !== null && !columns.has(column)) columns.set(column, WEEKDAY_BY_CHAR[match[1]]);
    }
    if (columns.size >= 5) return { row, columns };
  }
  return null;
}

/** 找大节行标列：星期列左侧、命中行标最多的列；都没有时返回 -1（不按行序猜节次）。 */
function findLabelColumn(matrix: unknown[][], headerRow: number, firstWeekdayColumn: number): number {
  let best = -1;
  let bestHits = 0;
  for (let column = 0; column < firstWeekdayColumn; column += 1) {
    let hits = 0;
    for (let row = headerRow + 1; row < matrix.length; row += 1) {
      if (BIG_SECTION_START[cellAt(matrix, row, column)] !== undefined) hits += 1;
    }
    // 取命中更多的列；命中数相同时取更靠近星期列的那一列（大节行标紧邻星期列）。
    if (hits > 0 && hits >= bestHits) {
      best = column;
      bestHits = hits;
    }
  }
  return best;
}

/** 解析元信息行（表头行之前的行）：学校、学年学期、导出时间、院系/年级/专业/班级。 */
function parseMeta(matrix: unknown[][], headerRow: number, sheetName: string, fileName: string): { meta: DraftMeta; problems: string[] } {
  const meta: DraftMeta = {
    sheetName,
    fileName,
    school: '',
    semester: '',
    exportedAt: '',
    department: '',
    grade: '',
    major: '',
    className: '',
  };
  const problems: string[] = [];
  for (let row = 0; row < headerRow; row += 1) {
    const line = matrix[row] ?? [];
    for (let column = 0; column < line.length; column += 1) {
      const text = cellAt(matrix, row, column);
      if (text === '') continue;
      if (meta.school === '' && /课表/u.test(text)) {
        const match = SCHOOL_TERM.exec(text);
        if (match !== null) {
          meta.school = normalizeText(match[1]);
          meta.semester = normalizeText(match[2]);
        }
        const exported = EXPORTED_AT.exec(text);
        if (exported !== null && meta.exportedAt === '') meta.exportedAt = normalizeText(exported[1]);
        continue;
      }
      const labelled = LABEL_VALUE.exec(text);
      if (labelled === null) continue;
      const label = labelled[1].replace(/\s+/g, '');
      const value = normalizeText(labelled[2]);
      if (/^院[（(]?系[)）]?[\/／]?部$/u.test(label)) meta.department = value;
      else if (label === '年级') meta.grade = value;
      else if (label === '专业' || label === '专业名称') meta.major = value;
      else if (label === '班级') meta.className = value.replace(/[\[［]\d+[\]］]$/u, '').trim();
      else if (label === '学校') meta.school = value;
      else if (label === '学年学期' || label === '学期') meta.semester = value;
    }
  }
  if (meta.school === '') {
    meta.school = '';
    problems.push('未识别学校名称');
  }
  if (meta.semester === '') problems.push('未识别学年学期');
  return { meta, problems };
}

/**
 * 解析一张工作表的矩阵。找不到表头行时返回 null；表头行找到但一条课程都没有时返回空课程的
 * 结果并给出 problem，由调用方决定是「非课表矩阵」还是「空课表」。
 */
export function parseSheetMatrix(matrix: unknown[][], sheetName: string, fileName = ''): SheetParseResult | null {
  const header = findHeaderRow(matrix);
  if (header === null) return null;
  const firstWeekdayColumn = Math.min(...header.columns.keys());
  const labelColumn = findLabelColumn(matrix, header.row, firstWeekdayColumn);
  const { meta, problems } = parseMeta(matrix, header.row, sheetName, fileName);

  const courses: DraftCourse[] = [];
  const rowProblems: string[] = [];
  let cells = 0;
  let entries = 0;
  let unrecognizedRows = 0;
  for (let row = header.row + 1; row < matrix.length; row += 1) {
    const rowLabel = labelColumn >= 0 ? cellAt(matrix, row, labelColumn) : '';
    const rowStartSection = BIG_SECTION_START[rowLabel] ?? 0;
    if (labelColumn >= 0 && rowLabel !== '' && rowStartSection === 0) unrecognizedRows += 1;
    let rowHasCourse = false;
    for (const [column, weekday] of header.columns) {
      const text = cellAt(matrix, row, column);
      if (text === '') continue;
      const lines = splitCellEntries(text);
      if (lines.length === 0) continue;
      rowHasCourse = true;
      cells += 1;
      const weekdayLabel = `星期${['一', '二', '三', '四', '五', '六', '日'][weekday - 1]}`;
      for (const line of lines) {
        entries += 1;
        courses.push(parseCourseEntry(line, { weekday, weekdayLabel, rowLabel, rowStartSection }, courses.length));
      }
    }
    if (rowHasCourse && labelColumn < 0) {
      rowProblems.push(`第 ${row + 1} 行未识别到大节行标，该行节次只能取自单元格原文`);
    }
  }
  if (unrecognizedRows > 0) {
    rowProblems.push(`有 ${unrecognizedRows} 行的行标不是「一~六 / 1-6」，不做节次推断`);
  }

  // 跨大节重复的同一门课去重：真实样本里同一门课会在它横跨的多个大节行各出现一次。
  const merged: DraftCourse[] = [];
  const byKey = new Map<string, DraftCourse>();
  let duplicates = 0;
  for (const course of courses) {
    const key = [course.weekday, course.name, course.credits, course.teacher, course.location, course.campus, course.note, course.weekText].join('|');
    const existing = course.name === '' ? undefined : byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, course);
      merged.push(course);
      continue;
    }
    duplicates += 1;
    existing.sectionRanges = mergeSectionRanges([...existing.sectionRanges, ...course.sectionRanges]);
    existing.warnings = [...new Set([...existing.warnings, ...course.warnings])];
  }
  merged.sort((a, b) => a.weekday - b.weekday
    || (a.sectionRanges[0]?.start ?? 99) - (b.sectionRanges[0]?.start ?? 99)
    || a.name.localeCompare(b.name, 'zh-Hans-CN'));

  return {
    courses: merged,
    meta,
    problems: [
      ...(merged.length === 0 ? [`工作表「${sheetName}」有课表表头但没有解析到课程单元格`] : []),
      ...rowProblems,
      ...problems,
    ],
    stats: {
      sheets: 1,
      cells,
      entries,
      courses: merged.length,
      duplicates,
      warnings: merged.filter((course) => course.warnings.length > 0).length,
    },
  };
}

/** 读取工作簿并把每一行转成字符串矩阵；`raw:false` 取格式化后的文本（日期等按显示值）。 */
function sheetMatrix(sheet: XLSX.WorkSheet): unknown[][] {
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false, blankrows: true });
}

/**
 * 解析一份课表文件。失败时抛 TimetableParseError，消息面向学生，可直接展示。
 * 成功时返回草稿；**不写任何数据库记录**，临时文件的删除由调用方负责。
 */
export function parseWorkbook(buffer: Buffer, fileName = ''): TimetableDraft {
  if (buffer === null || buffer === undefined || buffer.length === 0) {
    throw new TimetableParseError('文件是空的，请确认从教务系统导出的课表文件有内容');
  }
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TimetableParseError(`文件无法按 Excel 格式读取：${message}。请确认是教务系统导出的 .xls 或 .xlsx 课表文件`);
  }
  if (workbook.SheetNames.length === 0) {
    throw new TimetableParseError('Excel 文件里没有工作表，请重新导出课表文件');
  }

  const problems: string[] = [];
  let chosen: SheetParseResult | null = null;
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (sheet === undefined) continue;
    const result = parseSheetMatrix(sheetMatrix(sheet), sheetName, fileName);
    if (result === null) {
      problems.push(`工作表「${sheetName}」没有「星期一 … 星期日」表头行，已跳过`);
      continue;
    }
    if (result.courses.length === 0) {
      problems.push(...result.problems);
      continue;
    }
    if (chosen === null) {
      chosen = result;
      continue;
    }
    // 一份文件里有多张都能解析的表（例如另一个班的课表）：只取第一张，不把别人的课混进草稿。
    // 「不猜」在这里同样适用——并表是替学生做了选择。
    problems.push(`工作表「${sheetName}」也像课表，但一份课表只取一张，已跳过；若选错了工作表请重新导出`);
  }

  if (chosen === null) {
    throw new TimetableParseError(
      `未识别出课表矩阵：文件里没有找到「星期一 … 星期日」表头行与可解析的课程单元格。已检查工作表：${workbook.SheetNames.join('、')}`,
    );
  }
  return {
    meta: chosen.meta,
    courses: chosen.courses.map((course, index) => ({ ...course, draftId: `d${index}` })),
    problems,
    stats: {
      ...chosen.stats,
      courses: chosen.courses.length,
      warnings: chosen.courses.filter((course) => course.warnings.length > 0).length,
    },
  };
}
