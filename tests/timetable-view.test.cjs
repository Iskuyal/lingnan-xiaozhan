const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

// 纯视图与服务模块的产物：周次识别、节次文案、按周排布、表单校验、草稿存储。
const weeks = require('../dist/services/timetable/weeks.js');
const view = require('../dist/services/timetable/view.js');
const form = require('../dist/services/timetable/form.js');
const draftStore = require('../dist/services/timetable/draft.js');
const cloudParse = require('../dist/cloudfunctions/timetable/parse.js');

const FIXTURE_DIR = path.resolve('tests/fixtures/timetable');
const FIXTURES = fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.xls'));

function course(overrides) {
  return {
    id: 'tc_1',
    name: '高等数学',
    credits: '1.5',
    teacher: '林加燕',
    weekday: 1,
    startSection: 1,
    endSection: 2,
    sectionRanges: [{ start: 1, end: 2 }],
    weeks: [1, 2, 3, 4],
    weeksRecognized: true,
    weekText: '[1-4]周',
    location: '崇礼楼-306-计算机十九室',
    campus: '清远校区',
    siteNumber: '44',
    note: '',
    warnings: [],
    source: 'excel',
    semester: '2026-2027学年第一学期',
    rawText: '',
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
    ...overrides,
  };
}

test('节次文案只写节次，不出现具体时刻', () => {
  assert.equal(view.formatSectionText([{ start: 1, end: 2 }, { start: 5, end: 6 }]), '第 1-2 节、第 5-6 节');
  assert.equal(view.formatSectionText([{ start: 3, end: 3 }]), '第 3 节');
  assert.equal(view.sectionLabelOf(course({})), '第 1-2 节');
  assert.equal(view.sectionLabelOf(course({ sectionRanges: [], startSection: 5, endSection: 3 })), '原文 5-3 节（待核对）');
  assert.equal(view.sectionLabelOf(course({ sectionRanges: [], startSection: 0, endSection: 0 })), '节次待核对');
  const weekView = view.buildWeekView([course({})], 2);
  const labels = [
    ...view.BIG_SECTION_LABELS,
    ...weekView.rows.map((row) => row.sectionLabel),
    ...weekView.days.map((day) => day.label),
    weekView.weekLabel,
    ...weekView.days.flatMap((day) => day.items.flatMap((item) => [item.sectionLabel, item.weekLabel])),
  ];
  for (const label of labels) {
    assert.ok(!/[:：]/u.test(label), `课表里不应出现时刻：${label}`);
    assert.ok(!/\d{1,2}\s*[点時时]\s*\d{0,2}/u.test(label), `课表里不应出现「点/时」时刻：${label}`);
  }
});

test('周次文案：识别出的压缩显示，未识别的保留原文并标注待核对', () => {
  assert.equal(view.weekLabelOf(course({ weeks: [2, 3, 4, 5, 6, 8, 9], weeksRecognized: true })), '第 2-6、8-9 周');
  assert.equal(view.weekLabelOf(course({ weeks: [], weeksRecognized: true })), '每周');
  assert.equal(view.weekLabelOf(course({ weeks: [], weeksRecognized: false, weekText: '[单周]周' })), '原文 [单周]周（待核对）');
  assert.equal(weeks.condenseWeeks([3, 1, 2, 9]), '1-3、9');
});

test('按周次筛选课程：区间内外、每周与未识别三种情况', () => {
  const holiday = course({ id: 'tc_a', weeks: [2, 3, 4, 5, 6, 8, 9, 10], weeksRecognized: true });
  assert.equal(view.occursInWeek(holiday, 2), true);
  assert.equal(view.occursInWeek(holiday, 7), false, '第 7 周不在 [2-6,8-10] 内');
  assert.equal(view.occursInWeek(holiday, 9), true);
  assert.equal(view.occursInWeek(course({ weeks: [], weeksRecognized: true }), 12), true, '每周都出现');
  assert.equal(view.occursInWeek(course({ weeks: [], weeksRecognized: false }), 12), true, '未识别的按每周展示并保留待核对');
  assert.equal(view.weekSpan([holiday]), 20);
  assert.equal(view.weekSpan([course({ weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] })]), 23);
});

test('周课表按大节落格，连排课程同时出现在两个大节行', () => {
  const courses = [
    course({ id: 'tc_1', name: '使用JSP开发Web应用系统', weekday: 1, sectionRanges: [{ start: 1, end: 4 }], startSection: 1, endSection: 4 }),
    course({ id: 'tc_2', name: '体育三', weekday: 3, sectionRanges: [{ start: 11, end: 12 }], startSection: 11, endSection: 12, weeks: [2, 3] }),
    course({ id: 'tc_3', name: '只在第 5 周的课', weekday: 5, weeks: [5] }),
  ];
  const week2 = view.buildWeekView(courses, 2);
  const cellOf = (rowIndex, weekday) => week2.rows[rowIndex - 1].cells[weekday - 1].items.map((item) => item.name);
  assert.deepEqual(cellOf(1, 1), ['使用JSP开发Web应用系统']);
  assert.deepEqual(cellOf(2, 1), ['使用JSP开发Web应用系统'], '1-4 节横跨第一、第二个大节');
  assert.deepEqual(cellOf(6, 3), ['体育三']);
  assert.deepEqual(week2.days.map((day) => day.label), ['星期一', '星期三']);
  assert.equal(week2.total, 2);
  const week5 = view.buildWeekView(courses, 5);
  assert.equal(week5.total, 1, '第 5 周只有只在该周上课的那门课');
  assert.deepEqual(week5.rows[0].cells[4].items.map((item) => item.name), ['只在第 5 周的课']);
  assert.deepEqual(week5.days.map((day) => day.label), ['星期五']);
});

test('手工表单校验：必填项、节次顺序与周次写法', () => {
  const extras = { campus: '', siteNumber: '', note: '', rawText: '', warnings: [], source: 'manual' };
  const base = { ...form.EMPTY_FORM, name: '大学美育', weekdayIndex: 2, startIndex: 4, endIndex: 5, weeksText: '1-16' };
  const built = form.buildCourseInput(base, extras);
  assert.equal(built.ok, true);
  assert.equal(built.value.weekday, 3);
  assert.deepEqual(built.value.sectionRanges, [{ start: 5, end: 6 }]);
  assert.deepEqual(built.value.weeks, Array.from({ length: 16 }, (_, index) => index + 1));
  assert.equal(built.value.source, 'manual');

  assert.equal(form.buildCourseInput({ ...base, name: '  ' }, extras).ok, false);
  const inverted = form.buildCourseInput({ ...base, startIndex: 7, endIndex: 3 }, extras);
  assert.equal(inverted.ok, false);
  assert.match(inverted.error, /结束节/u);

  const unknownWeeks = form.buildCourseInput({ ...base, weeksText: '单周' }, extras);
  assert.equal(unknownWeeks.ok, true);
  assert.equal(unknownWeeks.value.weeksRecognized, false);
  assert.deepEqual(unknownWeeks.value.weeks, []);
  assert.equal(unknownWeeks.value.weekText, '单周', '写不认识的周次要保留原文');
  assert.match(unknownWeeks.value.warnings.join(' '), /周次写法未能识别/u);

  const everyWeek = form.buildCourseInput({ ...base, weeksText: '' }, extras);
  assert.equal(everyWeek.value.weeksRecognized, true);
  assert.deepEqual(everyWeek.value.weeks, []);
  assert.equal(view.weekLabelOf({ ...everyWeek.value }), '每周');

  const fromCourse = form.formFromCourse(course({ weeks: [2, 3, 4, 6], sectionRanges: [{ start: 5, end: 6 }] }));
  assert.equal(fromCourse.form.weeksText, '2-4、6');
  assert.equal(fromCourse.form.startIndex, 4);
  assert.equal(fromCourse.form.endIndex, 5);
  assert.equal(fromCourse.form.weekdayIndex, 0);
});

test('草稿存储：删除与替换只影响内存草稿，放弃后为空', () => {
  const draft = {
    meta: { sheetName: '数据表', fileName: 'a.xls', school: '某校', semester: '2026-2027学年第一学期', exportedAt: '', department: '', grade: '', major: '', className: '' },
    courses: [
      { draftId: 'd0', name: 'A', source: 'excel' },
      { draftId: 'd1', name: 'B', source: 'excel' },
    ],
    problems: [],
    stats: { sheets: 1, cells: 1, entries: 2, courses: 2, duplicates: 0, warnings: 0 },
  };
  draftStore.setDraft(draft);
  assert.equal(draftStore.hasDraft(), true);
  assert.equal(draftStore.removeCourseAt(0), true);
  assert.deepEqual(draftStore.getDraft().courses.map((item) => item.name), ['B']);
  assert.equal(draftStore.replaceCourseAt(0, { draftId: 'd1', name: 'B2', source: 'excel' }), true);
  assert.equal(draftStore.getDraft().courses[0].name, 'B2');
  assert.equal(draftStore.removeCourseAt(5), false);
  draftStore.clearDraft();
  assert.equal(draftStore.hasDraft(), false);
  assert.equal(draftStore.getDraft(), null);
});

test('小程序侧与云函数侧的周次识别对真实样本的写法结果一致', () => {
  const tokens = new Set();
  for (const name of FIXTURES) {
    const parsed = cloudParse.parseWorkbook(fs.readFileSync(path.join(FIXTURE_DIR, name)), name);
    for (const item of parsed.courses) {
      if (item.weekText !== '') tokens.add(item.weekText);
    }
  }
  assert.ok(tokens.size >= 20, `样本里的周次写法应有多种，实际 ${tokens.size} 种`);
  for (const token of tokens) {
    const client = weeks.parseWeekNotation(token);
    const server = cloudParse.parseWeekNotation(token);
    assert.equal(client.recognized, server.recognized, token);
    assert.deepEqual(client.weeks, server.weeks, token);
  }
});

test('云调用的技术性错误映射成可理解的文案', () => {
  const service = require('../dist/services/timetable/index.js');
  assert.match(service.messageOf({ errMsg: 'cloud.callFunction:fail errCode: -501000  FunctionName parameter could not be found' }), /课表服务暂时不可用/u);
  assert.match(service.messageOf({ errMsg: 'errCode: -501023 permission denied' }), /没有权限/u);
  assert.match(service.messageOf({ errMsg: 'errCode: -504003 Invoking task timed out' }), /超时/u);
  assert.equal(service.messageOf(new Error('未识别出课表矩阵')), '未识别出课表矩阵');
  assert.equal(service.messageOf(undefined), '未知错误');
});

test('云函数返回的技术性错误不原样展示给学生', () => {
  const service = require('../dist/services/timetable/index.js');
  // 集合不存在时云函数的真实返回（2026-09-19 实测）：带错误码与文档链接，学生看不懂。
  const dbError = '课表操作失败：collection.get:fail -502005 database collection not exists. [ResourceNotFound] '
    + 'Db or Table not exist: timetable_courses. Please check your request, but if the problem cannot be solved, '
    + 'contact us. 更多错误信息请访问：https://docs.cloudbase.net/error-code/basic/DATABASE_COLLECTION_NOT_EXIST';
  const mapped = service.readableCloudError(dbError);
  assert.equal(mapped.technical, true, '数据库错误应被判为技术性');
  assert.match(mapped.text, /课表服务暂时不可用/u);
  assert.ok(!/docs\.cloudbase\.net/u.test(mapped.text), '改写后的文案里不应带文档链接');
  // 业务性错误原样透出（学生看得懂，且指向具体该怎么改）。
  const business = service.readableCloudError('只支持教务系统导出的 .xls 或 .xlsx 课表文件');
  assert.equal(business.technical, false);
  assert.equal(business.text, '只支持教务系统导出的 .xls 或 .xlsx 课表文件');
});

test('上传前的本地校验：格式与大小', () => {
  const service = require('../dist/services/timetable/index.js');
  assert.equal(service.checkChosenFile({ name: '2026-2027学年第一学期班级课表.xls', size: 2048 }), '');
  assert.equal(service.checkChosenFile({ name: '课表.XLSX', size: 2048 }), '');
  assert.match(service.checkChosenFile({ name: '课表.pdf', size: 2048 }), /只支持/u);
  assert.match(service.checkChosenFile({ name: '课表.xls', size: 20 * 1024 * 1024 }), /超过/u);
});
