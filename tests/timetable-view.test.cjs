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
    weekView.weekLabel,
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
  assert.equal(week2.rows[0].cells[0].items[0].tint, week2.rows[1].cells[0].items[0].tint, '连排课程跨大节行应保持同一底色');
  assert.notEqual(week2.rows[0].cells[0].items[0].tint, week2.rows[5].cells[2].items[0].tint, '同周内相邻课程底色应交替');
  assert.equal(week2.total, 2);
  const week5 = view.buildWeekView(courses, 5);
  assert.equal(week5.total, 1, '第 5 周只有只在该周上课的那门课');
  assert.deepEqual(week5.rows[0].cells[4].items.map((item) => item.name), ['只在第 5 周的课']);
});

// 列表视图曾经是空的：模板一直在渲染 view.days，但 buildWeekView() 从不产出这个字段，
// 点「列表」只会得到一页空白。这条锁住列表真的有数据、且空白天不进列表。
test('列表视图：按星期分组给出行数据，空白天不进列表', () => {
  const courses = [
    course({ id: 'tc_1', name: '高等数学', weekday: 1, sectionRanges: [{ start: 5, end: 6 }], startSection: 5, endSection: 6 }),
    course({ id: 'tc_2', name: '低代码平台应用开发', weekday: 1, sectionRanges: [{ start: 1, end: 4 }], startSection: 1, endSection: 4 }),
    course({ id: 'tc_3', name: '体育三', weekday: 3, sectionRanges: [{ start: 7, end: 8 }], startSection: 7, endSection: 8 }),
    course({ id: 'tc_4', name: '只在第 9 周的课', weekday: 5, weeks: [9] }),
  ];
  const dates = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'];
  const week2 = view.buildWeekView(courses, 2, { dateLabels: dates, todayWeekday: 1 });

  assert.deepEqual(week2.days.map((day) => day.weekday), [1, 3], '只列出有课的天，并按星期排序');
  assert.equal(week2.total, 3, '第 9 周的课不算进本周');
  assert.deepEqual(week2.days[0].items.map((item) => item.name), ['低代码平台应用开发', '高等数学'], '同一天内按首个节次排');
  assert.equal(week2.days[0].label, '星期一');
  assert.equal(week2.days[0].dateLabel, '2026-09-21');
  assert.equal(week2.days[0].today, true);
  assert.equal(week2.days[1].dateLabel, '2026-09-23');
  assert.equal(week2.days[1].today, false);
  const first = week2.days[0].items[0];
  assert.equal(first.location, '崇礼楼-306-计算机十九室', '列表要读到完整地点，缩写只发生在网格里');
  assert.equal(first.teacher, '林加燕');
  assert.equal(typeof first.colorSolid, 'string', '列表行色条要有课程色');
  assert.notEqual(first.colorSolid, '', '课程色不能是空串');
  assert.deepEqual(view.buildWeekView([], 2).days, [], '空周不给分组');
});

// 真实地点是「楼栋-房间-房间名」三段，课块一行只放得下约 6 个字。
test('网格里的地点缩成「楼栋-房间」，完整地点留给列表与详情', () => {
  assert.equal(view.shortLocation('博雅楼-B604-前端H5创新应用中心'), '博雅楼-B604');
  assert.equal(view.shortLocation('40号楼-B310-服装工艺室（2）'), '40号楼-B310');
  assert.equal(view.shortLocation('崇礼楼-306'), '崇礼楼-306', '两段原样返回');
  assert.equal(view.shortLocation('篮球1号场'), '篮球1号场', '没有连字符原样返回');
  assert.equal(view.shortLocation('博雅楼 - B604 '), '博雅楼-B604', '顺带去掉分段周围空格');
  assert.equal(view.shortLocation(''), '');
  const grid = view.buildGrid([course({ sectionRanges: [{ start: 1, end: 4 }], startSection: 1, endSection: 4 })], 2);
  assert.equal(grid.columns[0].blocks[0].tier, 'full');
  assert.equal(grid.columns[0].blocks[0].meta, '崇礼楼-306', '网格课块显示缩写');
  assert.equal(view.toCard(course({})).location, '崇礼楼-306-计算机十九室', '卡片本身不缩写');
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

test('网络类传输失败映射成可读文案，不把平台原文递给用户', () => {
  const service = require('../dist/services/timetable/index.js');
  const aiService = require('../dist/services/ai.js');
  // 2026-10-08 开发者工具实测原文（开发机与云端之间一次瞬时连接失败，上传接口直接把它抛了出来）：
  // 「Client network socket disconnected before secure TLS connection was established」。
  // 这类英文网络错误学生读不懂，且带 cloud.uploadFile 这样的内部字样。
  const networkCases = [
    'cloud.uploadFile:fail undefined . uploadFile:fail Error: Client network socket disconnected before secure TLS connection was established',
    'cloud.downloadFile:fail Error: socket hang up',
    'request:fail net::ERR_CONNECTION_RESET',
    'request:fail errno:600001 system error: ETIMEDOUT',
    'cloud.callFunction:fail Error: read ECONNRESET',
  ];
  for (const raw of networkCases) {
    const mapped = service.messageOf({ errMsg: raw });
    assert.match(mapped, /网络|连接/u, `网络类失败应给出可读文案：${raw}`);
    assert.doesNotMatch(mapped, /cloud\.|uploadFile|ERR_|ECONNRESET|ETIMEDOUT|TLS|socket/iu, `不应泄漏平台原文：${mapped}`);
  }
  // AI 侧共用同一套规则：网络类失败也要落到可读文案，而不是英文原文。
  assert.match(aiService.transportMessage({ errMsg: networkCases[0] }), /网络|连接/u);
  // 非网络类的未知错误仍按各自兜底策略处理（课表原样透出业务提示、AI 换兜底句）。
  assert.equal(service.messageOf(new Error('未识别出课表矩阵')), '未识别出课表矩阵');
  assert.equal(service.messageOf(undefined), '未知错误');
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
