const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

// 运行真实解析器（构建产物）与真实教务导出样本；样例文件见 tests/fixtures/timetable/README.md。
const { parseWorkbook, parseSheetMatrix, parseWeekNotation, mergeSectionRanges, TimetableParseError } =
  require('../dist/cloudfunctions/timetable/parse.js');

const FIXTURE_DIR = path.resolve('tests/fixtures/timetable');
const STANDARD = '2026-2027学年第一学期班级课表.xls';
const SINGLE_NEWLINE = '2026-2027学年第一学期班级课表（单换行多课）.xls';
const BLANK_LINE = '2026-2027学年第一学期班级课表（多课同格）.xls';
const OTHER_CLASS = '26软件技术(专升本)1班.xls';
const ALL = [STANDARD, SINGLE_NEWLINE, BLANK_LINE, OTHER_CLASS];

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name));
}

function parseFixture(name) {
  return parseWorkbook(readFixture(name), name);
}

function sheetTexts(name) {
  const workbook = XLSX.read(readFixture(name));
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
    header: 1, defval: '', raw: false, blankrows: true,
  });
  // 只取（星期 × 大节）单元格，不含元信息行与表头行。
  return rows.slice(4).flatMap((row) => row.slice(2).map((cell) => String(cell ?? '')));
}

/** 合成一份表矩阵文件（xlsx），用于覆盖真实样本没有的异常版式。 */
function buildWorkbook(matrix) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), '数据表');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

const HEADER = ['', '', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

test('四份真实教务导出都能解析出课程，且带出元信息', () => {
  for (const name of ALL) {
    const draft = parseFixture(name);
    assert.ok(draft.courses.length >= 10, `${name}: 解析出的课程太少（${draft.courses.length}）`);
    assert.equal(draft.meta.school, '广东岭南职业技术学院', `${name}: 学校名称`);
    assert.equal(draft.meta.semester, '2026-2027学年第一学期', `${name}: 学年学期`);
    assert.match(draft.meta.exportedAt, /^2026-09-\d{2} \d{2}:\d{2}$/u, `${name}: 导出时间`);
    assert.ok(draft.meta.department.includes('人工智能学院'), `${name}: 院系`);
    assert.ok(draft.meta.className.endsWith('班'), `${name}: 班级`);
    assert.ok(draft.meta.grade.length > 0 && draft.meta.major.length > 0, `${name}: 年级与专业`);
    for (const course of draft.courses) {
      assert.ok(course.name.length > 0, `${name}: 出现没有课程名的条目：${course.rawText}`);
      assert.ok(course.weekday >= 1 && course.weekday <= 7, `${name}: 星期越界：${course.rawText}`);
      assert.ok(course.sectionRanges.length > 0, `${name}: 缺少节次：${course.rawText}`);
      for (const range of course.sectionRanges) {
        assert.ok(range.start >= 1 && range.end <= 12 && range.end >= range.start, `${name}: 节次越界：${course.rawText}`);
      }
      assert.ok(course.weeksRecognized, `${name}: 真实样本的周次都应识别：${course.weekText}`);
      assert.ok(course.weeks.length > 0, `${name}: 缺少教学周：${course.rawText}`);
      assert.ok(course.teacher.length > 0, `${name}: 缺少教师：${course.rawText}`);
      assert.ok(course.campus.endsWith('校区'), `${name}: 缺少校区：${course.rawText}`);
    }
  }
});

test('标准版式：字段逐项对应原文，跨大节的同一门课去重', () => {
  const draft = parseFixture(STANDARD);
  const jsp = draft.courses.filter((course) => course.name === '使用JSP开发Web应用系统');
  // 周一 1-2 节与 3-4 节的同周次课程合并成一条，并集节次为 1-2、3-4；[2-3]周 那条是不同的周次，单独保留。
  const full = jsp.find((course) => course.weekText === '[2-6,8-17]周');
  // 1-2 节与 3-4 节相邻，合并成一段连排；两种写法对学生等同。
  assert.deepEqual(full.sectionRanges, [{ start: 1, end: 4 }]);
  assert.equal(full.weekday, 2, '周二的 1-2 节与 3-4 节是同一条');
  assert.equal(jsp.length, 2, '周次不同的两条应各自保留，不因同名合并');
  assert.equal(full.credits, '4');
  assert.equal(full.teacher, '黄比悉');
  assert.equal(full.location, '博雅楼-B602-互联网+创新实验室');
  assert.equal(full.campus, '清远校区');
  assert.equal(full.siteNumber, '38');
  assert.equal(full.weeks.length, 15);
  assert.ok(full.weeks.includes(8) && !full.weeks.includes(7), '周次区间应按原文展开');
  const short = jsp.find((course) => course.weekText === '[2-3]周');
  assert.equal(short.weekday, 1);
  assert.deepEqual(short.sectionRanges, [{ start: 3, end: 4 }]);
  assert.deepEqual(short.weeks, [2, 3]);
  assert.ok(draft.stats.duplicates > 0, '标准版式里也有跨大节重复的课程，应该被去重计数');
  assert.equal(draft.stats.courses, draft.courses.length);
});

test('单换行多课的单元格逐条解析，方向等信息进备注而不是丢进地点', () => {
  const draft = parseFixture(SINGLE_NEWLINE);
  const mondayRows = draft.courses.filter((course) => course.weekday === 1);
  assert.ok(mondayRows.some((course) => course.name === '劳动教育（一）'), '单换行分隔的第一条');
  assert.ok(mondayRows.some((course) => course.name === '信息技术与人工智能应用'), '单换行分隔的第二条');
  const art = draft.courses.find((course) => course.name === '大学美育' && course.note === '农民画');
  assert.ok(art, '方向「农民画」应保留在备注里');
  assert.equal(art.location, '40号楼-B207-多功能课室');
  assert.equal(art.teacher, '谭永念');
  const japanese = draft.courses.find((course) => course.note === '1班');
  assert.equal(japanese.name, '公共外语（日语）一');
  assert.equal(japanese.location, '39号楼-406-多功能课室');
  assert.ok(draft.courses.some((course) => course.location.startsWith('线上教室')), '线上教室这类无短横线的地点也要解析出来');
});

test('多课同格版式：空行分隔的多条课程都解析出来，缺地点的只标记不猜', () => {
  const draft = parseFixture(BLANK_LINE);
  const marked = draft.courses.filter((course) => course.warnings.length > 0);
  assert.equal(marked.length, 1, `只有原文没有地点的条目应带提示：${JSON.stringify(marked.map((c) => c.rawText))}`);
  assert.match(marked[0].warnings.join(' '), /未解析到上课地点/u);
  assert.equal(marked[0].name, '大学美育');
  assert.equal(marked[0].weekText, '[6-15]周');
  assert.equal(marked[0].location, '');
  assert.ok(draft.courses.some((course) => course.name === '开学典礼'), '空行分隔的第一条');
  assert.ok(draft.courses.some((course) => course.name === '高等数学'), '空行分隔的第二条');
});

test('另一种班级样本：4 节连排与单节次都能解析', () => {
  const draft = parseFixture(OTHER_CLASS);
  assert.equal(draft.meta.className, '26软件技术(专升本)1班');
  const lab = draft.courses.find((course) => course.sectionRanges.some((range) => range.start === 9 && range.end === 12));
  assert.ok(lab, '9-12 节的连排课程应解析出来');
  assert.ok(
    draft.courses.some((course) => course.note === '农民画' && course.location.startsWith('40号楼-')),
    '方向信息进备注，教室仍在地点里',
  );
});

test('单节次写法（如「第 3 节」）也能解析', () => {
  const matrix = [
    ['某某职业技术学院2026-2027学年第一学期班级课表'],
    HEADER,
    ['', '一', '单元课程 2 张三 [1-8]周 第 3 节 教学楼-A101-教室 清远校区 40'],
  ];
  const result = parseSheetMatrix(matrix, '数据表');
  assert.deepEqual(result.courses[0].sectionRanges, [{ start: 3, end: 3 }]);
});

test('两种一格多课的变体都真实存在于样本中（避免测试空转）', () => {
  const singleLine = sheetTexts(SINGLE_NEWLINE).filter((cell) => /\n/u.test(cell) && !/\n\s*\n/u.test(cell));
  const blankLine = sheetTexts(BLANK_LINE).filter((cell) => /\n\s*\n/u.test(cell));
  assert.ok(singleLine.length > 0, '样本里应有单换行分隔的单元格');
  assert.ok(blankLine.length > 0, '样本里应有空行分隔的单元格');
});

test('行标识别不出时不按行序推断节次', () => {
  const matrix = [
    ['某某职业技术学院2026-2027学年第一学期班级课表'],
    [],
    HEADER,
    ['', '甲', '普通课程 2 张三 [1-8]周 1-2节 教学楼-A101-教室 清远校区 40'],
    ['', '乙', '没有节次的课程 2 李四 [1-8]周 教学楼-A102-教室 清远校区 40'],
  ];
  const result = parseSheetMatrix(matrix, '数据表');
  assert.ok(result, '表头行在，应能解析');
  assert.equal(result.courses.length, 2);
  assert.deepEqual(result.courses[0].sectionRanges, [{ start: 1, end: 2 }], '单元格原文有节次时照用');
  assert.equal(result.courses[1].sectionRanges.length, 0, '行标不认、原文也没有节次时不得按行序补节次');
  assert.match(result.courses[1].warnings.join(' '), /行标/u);
  assert.ok(result.problems.some((problem) => problem.includes('行标')), '整表层面也要给出提示');
});

test('节次倒置与越界只标记并保留原值，不擅自修复', () => {
  const matrix = [
    ['某某职业技术学院2026-2027学年第一学期班级课表'],
    HEADER,
    ['', '一', '倒置课程 2 张三 [1-8]周 5-3节 教学楼-A101-教室 清远校区 40'],
    ['', '二', '越界课程 2 李四 [1-8]周 13-14节 教学楼-A102-教室 清远校区 40'],
  ];
  const result = parseSheetMatrix(matrix, '数据表');
  const inverted = result.courses.find((course) => course.name === '倒置课程');
  assert.equal(inverted.startSection, 5);
  assert.equal(inverted.endSection, 3);
  assert.deepEqual(inverted.sectionRanges, [], '倒置的节次不进网格，等学生裁决');
  assert.match(inverted.warnings.join(' '), /倒置/u);
  const overflow = result.courses.find((course) => course.name === '越界课程');
  assert.equal(overflow.startSection, 13);
  assert.equal(overflow.endSection, 14);
  assert.deepEqual(overflow.sectionRanges, []);
  assert.match(overflow.warnings.join(' '), /超出/u);
});

test('周次写法不认识时保留原文并标记，不猜周次', () => {
  const matrix = [
    ['某某职业技术学院2026-2027学年第一学期班级课表'],
    HEADER,
    ['', '一', '单双周课程 2 张三 [1-16单周]周 1-2节 教学楼-A101-教室 清远校区 40'],
    ['', '二', '无周次课程 2 李四 1-2节 教学楼-A102-教室 清远校区 40'],
  ];
  const result = parseSheetMatrix(matrix, '数据表');
  const biweekly = result.courses.find((course) => course.name === '单双周课程');
  assert.equal(biweekly.weeksRecognized, false);
  assert.deepEqual(biweekly.weeks, []);
  assert.equal(biweekly.weekText, '[1-16单周]周');
  assert.match(biweekly.warnings.join(' '), /周次写法未能识别/u);
  const missing = result.courses.find((course) => course.name === '无周次课程');
  assert.equal(missing.weeksRecognized, false);
  assert.match(missing.warnings.join(' '), /未找到周次/u);
});

test('越界与倒置的周次按「不认识」处理，且与小程序侧判断一致', () => {
  const matrix = [
    ['某某职业技术学院2026-2027学年第一学期班级课表'],
    HEADER,
    ['', '一', '越界课程 2 张三 [31-32]周 1-2节 教学楼-A101-教室 清远校区 40'],
    ['', '二', '倒置课程 2 李四 [17-2]周 1-2节 教学楼-A102-教室 清远校区 40'],
  ];
  const result = parseSheetMatrix(matrix, '数据表');
  const overflow = result.courses.find((course) => course.name === '越界课程');
  assert.equal(overflow.weeksRecognized, false, '越界周次不得当成识别成功');
  assert.deepEqual(overflow.weeks, [], '越界周次不得进周课表');
  assert.equal(overflow.weekText, '[31-32]周', '原文保留');
  assert.match(overflow.warnings.join(' '), /超出 1-30 周范围或区间倒置/u);
  const inverted = result.courses.find((course) => course.name === '倒置课程');
  assert.equal(inverted.weeksRecognized, false);
  assert.deepEqual(inverted.weeks, []);

  // 两侧（云函数解析 / 小程序手工表单）对同一写法的判断必须一致，否则手工改过的课程会保存失败。
  const clientWeeks = require('../dist/services/timetable/weeks.js');
  for (const token of ['[31-32]周', '[17-2]周', '[0]周', '[1-16,31]周', '[1-16,8-17]周', '4周']) {
    const client = clientWeeks.parseWeekNotation(token);
    const server = parseWeekNotation(token);
    assert.equal(client.recognized, server.recognized, token);
    assert.deepEqual(client.weeks, server.weeks, token);
  }
});

test('一份文件里有多张课表工作表时只取第一张，不做静默并表', () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['某某职业技术学院2026-2027学年第一学期班级课表'],
    HEADER,
    ['', '一', '第一张的课 2 张三 [1-8]周 1-2节 教学楼-A101-教室 清远校区 40'],
  ]), '第一个班');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['某某职业技术学院2026-2027学年第一学期班级课表'],
    HEADER,
    ['', '二', '第二个班的课 2 李四 [1-8]周 3-4节 教学楼-A102-教室 清远校区 41'],
  ]), '第二个班');
  const draft = parseWorkbook(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), '两个班.xlsx');
  assert.deepEqual(draft.courses.map((course) => course.name), ['第一张的课']);
  assert.equal(draft.stats.sheets, 1);
  assert.ok(
    draft.problems.some((problem) => problem.includes('第二个班') && problem.includes('跳过')),
    `应明确写出跳过了哪张工作表：${JSON.stringify(draft.problems)}`,
  );
});

test('非课表矩阵与空文件给出可理解的失败信息', () => {
  const grades = buildWorkbook([
    ['成绩表'],
    ['学号', '姓名', '成绩'],
    ['1001', '张三', '90'],
  ]);
  assert.throws(() => parseWorkbook(grades, '成绩表.xlsx'), (error) => {
    assert.ok(error instanceof TimetableParseError);
    assert.match(error.message, /未识别出课表矩阵/u);
    return true;
  });
  assert.throws(() => parseWorkbook(Buffer.alloc(0), '空.xls'), /文件是空的/u);
  assert.throws(() => parseWorkbook(Buffer.from('PK这不是压缩包'), '假的.xls'), /无法按 Excel 格式读取/u);
  // 纯文本文件会被当成 CSV 读进来，此时按「不是课表矩阵」拒绝，同样给出可理解的提示。
  assert.throws(() => parseWorkbook(Buffer.from('这不是 Excel 文件'), '假的.xls'), /未识别出课表矩阵/u);
});

test('周次写法与节次合并的纯函数行为', () => {
  assert.deepEqual(parseWeekNotation('[2-6,8-17]周'), { weeks: [2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], recognized: true });
  assert.deepEqual(parseWeekNotation('4周'), { weeks: [4], recognized: true });
  assert.deepEqual(parseWeekNotation('[3]周'), { weeks: [3], recognized: true });
  assert.equal(parseWeekNotation('[单周]周').recognized, false);
  assert.equal(parseWeekNotation('1-2节').recognized, false);
  assert.deepEqual(mergeSectionRanges([{ start: 3, end: 4 }, { start: 1, end: 2 }]), [{ start: 1, end: 4 }]);
  assert.deepEqual(mergeSectionRanges([{ start: 1, end: 2 }, { start: 5, end: 6 }]), [{ start: 1, end: 2 }, { start: 5, end: 6 }]);
});
