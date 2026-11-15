const { test } = require('node:test');
const assert = require('node:assert/strict');

// 今日简报（设计图 01 首页「今天」）：纯函数，不调模型。
const brief = require('../dist/services/timetable/brief.js');
const settingsModule = require('../dist/services/timetable/settings.js');

const SEMESTER = { startDate: '2026-09-21', totalWeeks: 20 };
// 2026-11-10 是第 8 周星期二（开学 9-21 是星期一）。
const TODAY = '2026-11-10';
const TUESDAY = 2;

const CLOCKS = {
  1: ['08:15', '08:55'],
  2: ['09:00', '09:40'],
  3: ['10:00', '10:40'],
  4: ['10:45', '11:25'],
  9: ['19:00', '19:40'],
  10: ['19:45', '20:25'],
};

/** 填满 1-4、9-10 节作息；其余留空（更接近真实：只填需要的）。 */
function filled() {
  const base = settingsModule.emptySettings();
  Object.assign(base, SEMESTER);
  for (const [section, [start, end]] of Object.entries(CLOCKS)) {
    base.sectionTimes[Number(section) - 1] = { start, end };
  }
  return base;
}

function course(overrides) {
  return {
    id: 'tc_1',
    name: '高等数学',
    credits: '',
    teacher: '林加燕',
    weekday: TUESDAY,
    startSection: 1,
    endSection: 2,
    sectionRanges: [{ start: 1, end: 2 }],
    weeks: [],
    weeksRecognized: false,
    weekText: '',
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

function input(overrides) {
  return {
    courses: [],
    settings: filled(),
    today: TODAY,
    clockMinutes: 8 * 60,
    goals: [],
    ...overrides,
  };
}

test('时长与问候语：说人话，不出现「0 分钟」这种毛刺', () => {
  assert.equal(brief.durationLabel(45), '45 分钟');
  assert.equal(brief.durationLabel(60), '1 小时');
  assert.equal(brief.durationLabel(140), '2 小时 20 分');
  assert.equal(brief.durationLabel(0), '0 分钟');

  assert.equal(brief.greetingOf(7 * 60), '早上好');
  assert.equal(brief.greetingOf(11 * 60), '中午好');
  assert.equal(brief.greetingOf(15 * 60), '下午好');
  assert.equal(brief.greetingOf(20 * 60), '晚上好');
});

test('抬头：日期 + 星期 + 周次；没设开学日就不带周次', () => {
  const withSemester = brief.buildTodayBrief(input({}));
  assert.equal(withSemester.dateLine, '11月10日 星期二 · 第 8 周');

  const noSemester = settingsModule.emptySettings();
  const briefNoSemester = brief.buildTodayBrief(input({ settings: noSemester }));
  assert.equal(briefNoSemester.dateLine, '11月10日 星期二');
  assert.equal(briefNoSemester.week, null);
});

test('今天没课：不假装有安排，也不编简报', () => {
  const result = brief.buildTodayBrief(input({}));
  assert.equal(result.headline, '今天没有课');
  assert.equal(result.hasCourses, false);
  assert.equal(result.blockCount, 0);
  assert.deepEqual(result.rows, []);
  assert.equal(result.sentences[0], '今天没有安排课程。');
  assert.deepEqual(result.sources, ['作息设置'], '没课就不该声称读过「已保存课表」');
});

test('下一节：给时刻、地点与「离现在多久」，第一节课说「第一节课」', () => {
  const result = brief.buildTodayBrief(input({
    courses: [course({})],
    clockMinutes: 7 * 60 + 52,
  }));
  assert.equal(result.headline, '今天 2 节课'.replace('2', '1'));
  assert.equal(result.sentences[0], '第一节课 08:15 在 崇礼楼-306，离现在 23 分钟。');
  assert.equal(result.rows[0].timeText, '08:15');
  assert.equal(result.rows[0].sectionText, '第 1-2 节');
  assert.equal(result.rows[0].isNext, true);
  assert.equal(result.rows[0].isNow, false);
});

test('正在上：标 isNow 不标 isNext，简报说「现在在上」', () => {
  const result = brief.buildTodayBrief(input({
    courses: [course({})],
    clockMinutes: 8 * 60 + 30,
  }));
  assert.equal(result.rows[0].isNow, true);
  assert.equal(result.rows[0].isNext, false);
  assert.equal(result.sentences[0], '现在在上「高等数学」第 1-2 节，在 崇礼楼-306。');
});

test('上完了：说明今天结束，不再给下一节时刻', () => {
  const result = brief.buildTodayBrief(input({
    courses: [course({})],
    clockMinutes: 21 * 60,
  }));
  assert.equal(result.rows[0].isNow, false);
  assert.equal(result.rows[0].isNext, false);
  assert.equal(result.sentences[0], '今天的课已经上完，剩下的时间自己安排。');
});

test('「下一节」全表最多一个，正在上时一个都没有', () => {
  const courses = [
    course({ id: 'a', sectionRanges: [{ start: 1, end: 2 }] }),
    course({ id: 'b', name: '大学英语', sectionRanges: [{ start: 3, end: 4 }] }),
    course({ id: 'c', name: '网页设计与制作', sectionRanges: [{ start: 9, end: 10 }] }),
  ];
  const idle = brief.buildTodayBrief(input({ courses, clockMinutes: 6 * 60 }));
  assert.equal(idle.rows.filter((row) => row.isNext).length, 1, '下一节只能有一个');
  assert.equal(idle.rows.find((row) => row.isNext).title, '高等数学');

  const running = brief.buildTodayBrief(input({ courses, clockMinutes: 8 * 60 + 30 }));
  assert.equal(running.rows.filter((row) => row.isNext).length, 0);
  assert.equal(running.rows.filter((row) => row.isNow).length, 1);
});

test('空闲段：只插入两端时刻齐全且不短于 45 分钟的间隙', () => {
  const courses = [
    course({ id: 'a', sectionRanges: [{ start: 1, end: 2 }] }),
    course({ id: 'b', name: '大学英语', sectionRanges: [{ start: 3, end: 4 }] }),
    course({ id: 'c', name: '网页设计与制作', sectionRanges: [{ start: 9, end: 10 }] }),
  ];
  const result = brief.buildTodayBrief(input({ courses, clockMinutes: 7 * 60 }));
  const free = result.rows.filter((row) => row.kind === 'free');
  assert.equal(free.length, 1, '1-2 节与 3-4 节之间只有 5 分钟，不该单独列一行');
  assert.equal(free[0].timeText, '11:25');
  assert.equal(free[0].sectionText, '空闲 7 小时 35 分');
  // 空闲行排在它后面那节课之前
  const freeIndex = result.rows.findIndex((row) => row.kind === 'free');
  assert.equal(result.rows[freeIndex + 1].title, '网页设计与制作');});

test('空闲段并列进简报正文：取最长的一段，报起止时刻', () => {
  const courses = [
    course({ id: 'a', sectionRanges: [{ start: 1, end: 2 }] }),
    course({ id: 'b', name: '网页设计与制作', sectionRanges: [{ start: 9, end: 10 }] }),
  ];
  const result = brief.buildTodayBrief(input({ courses, clockMinutes: 7 * 60, goals: [{ name: '英语四级', date: '2026-12-13' }] }));
  assert.equal(result.sentences[1], '今天 09:40–19:00 空出 9 小时 20 分。');
  assert.equal(result.sentences[2], '距「英语四级」还有 33 天。');
  assert.deepEqual(result.sources, ['已保存课表', '目标日', '作息设置']);
});

test('没填作息：整套不出现任何具体时刻，并说明填了才看得到', () => {
  const result = brief.buildTodayBrief(input({
    courses: [course({})],
    settings: settingsModule.emptySettings(),
    clockMinutes: 8 * 60,
  }));
  for (const row of result.rows) {
    assert.equal(row.timeText, '', '没填作息不许出现时刻');
    assert.equal(row.kind, 'course', '没有时刻就不该硬插空闲行');
  }
  assert.equal(result.hasTimes, false);
  assert.ok(result.sentences.includes('填好作息时间，就能看到几点上课、哪一段空着。'));
  assert.equal(result.sources.includes('作息设置'), false);
});

test('没填作息时不许说「今天的课已经上完」——早上七点半打开首页也不能这么写', () => {
  // 真机路径实测踩到：作息全空 → 不知道该上第几节 → 旧逻辑落进 done，
  // 早上 07:50 的首页写着「今天的课已经上完，剩下的时间自己安排」。
  const result = brief.buildTodayBrief(input({
    courses: [course({})],
    settings: settingsModule.emptySettings(),
    clockMinutes: 7 * 60 + 50,
  }));
  assert.equal(result.hasTimes, false);
  assert.equal(
    result.sentences.includes('今天的课已经上完，剩下的时间自己安排。'),
    false,
    '没填作息就不知道现在几点该上什么，不能断言「上完了」',
  );
  assert.equal(result.sentences[0], '今天的课从第 1-2 节开始，在 崇礼楼-306。');
});

test('同一门课同一时段被断周拆成两条记录时，只显示一次', () => {
  // 实测云端数据：低代码平台应用开发第 1-4 节有两条，周次分别是 4-16 与 17 周。
  // 没设开学日时周次未知，两条都命中，首页会把同一节课印两遍。
  const courses = [
    course({ id: 'tc_a', name: '低代码平台应用开发', sectionRanges: [{ start: 1, end: 4 }], weeks: [4, 5, 6, 7, 8], weeksRecognized: true }),
    course({ id: 'tc_b', name: '低代码平台应用开发', sectionRanges: [{ start: 1, end: 4 }], weeks: [17], weeksRecognized: true }),
  ];
  const noSemester = settingsModule.emptySettings();
  const result = brief.buildTodayBrief(input({ courses, settings: noSemester }));
  assert.equal(result.rows.length, 1, '同一节同一门课只该占一行');
  assert.equal(result.blockCount, 1);
});

test('同名但不同节次或不同地点仍是两节，不能合并', () => {
  const courses = [
    course({ id: 'tc_a', name: '大学美育', sectionRanges: [{ start: 1, end: 2 }], location: '博雅楼-A507' }),
    course({ id: 'tc_b', name: '大学美育', sectionRanges: [{ start: 9, end: 10 }], location: '博雅楼-A507' }),
    course({ id: 'tc_c', name: '大学美育', sectionRanges: [{ start: 1, end: 2 }], location: '博雅楼-B604' }),
  ];
  const noSemester = settingsModule.emptySettings();
  const result = brief.buildTodayBrief(input({ courses, settings: noSemester }));
  assert.equal(result.rows.length, 3, '节次或地点不同的同名课是不同的一节');
});

test('只填一半作息：缺时刻的那一节不显示时刻，也不拿它凑空闲段', () => {
  const partial = filled();
  partial.sectionTimes[2] = { start: '', end: '' }; // 第 3 节只有结束时刻
  const courses = [
    course({ id: 'a', sectionRanges: [{ start: 1, end: 2 }] }),
    course({ id: 'b', name: '大学英语', sectionRanges: [{ start: 3, end: 4 }] }),
  ];
  const result = brief.buildTodayBrief(input({ courses, settings: partial, clockMinutes: 7 * 60 }));
  assert.equal(result.rows.filter((row) => row.kind === 'free').length, 0);
  assert.equal(result.rows[1].timeText, '');
});

test('没设开学日时按星期过滤而不是把今天的课藏起来', () => {
  const noSemester = settingsModule.emptySettings();
  const courses = [course({ weeks: [3], weeksRecognized: true, weekText: '3' })];
  const result = brief.buildTodayBrief(input({ courses, settings: noSemester }));
  assert.equal(result.rows.length, 1, '不知道周次时应显示当天的课，不能因为周次对不上就消失');
});

test('周次明确的课不在本周时不出现', () => {
  const courses = [
    course({ id: 'a', weeks: [8], weeksRecognized: true, weekText: '8' }),
    course({ id: 'b', name: '只在第 9 周', weeks: [9], weeksRecognized: true, weekText: '9' }),
  ];
  const result = brief.buildTodayBrief(input({ courses }));
  assert.deepEqual(result.rows.map((row) => row.title), ['高等数学']);
});

test('同一门课一天两段：算两节课，各自一行', () => {
  const twice = course({
    id: 'tc_x',
    name: '公共外语（英语）一',
    sectionRanges: [{ start: 1, end: 2 }, { start: 9, end: 10 }],
    startSection: 1,
    endSection: 10,
  });
  const result = brief.buildTodayBrief(input({ courses: [twice], clockMinutes: 7 * 60 }));
  assert.equal(result.blockCount, 2);
  assert.equal(result.headline, '今天 2 节课');
  // 两段之间这段长空档会插一行「空闲」，所以只看课程行。
  assert.deepEqual(
    result.rows.filter((row) => row.kind === 'course').map((row) => row.sectionText),
    ['第 1-2 节', '第 9-10 节'],
  );
});

test('目标日：已过期的不倒计时，今天就说「就是今天」', () => {
  const past = brief.buildTodayBrief(input({ goals: [{ name: '已过去的日子', date: '2026-11-01' }] }));
  assert.equal(past.sentences.some((line) => line.includes('已过去的日子')), false);

  const todayGoal = brief.buildTodayBrief(input({ goals: [{ name: '英语四级', date: TODAY }] }));
  assert.ok(todayGoal.sentences.includes('今天就是「英语四级」的日子。'));

  const future = brief.buildTodayBrief(input({
    goals: [{ name: '远的', date: '2026-12-31' }, { name: '近的', date: '2026-11-20' }],
  }));
  assert.ok(future.sentences.includes('距「近的」还有 10 天。'), '取最近的一条');
});

test('建议问题与依据条：建议固定三条，依据只写真实用到的', () => {
  const result = brief.buildTodayBrief(input({}));
  assert.equal(result.suggestions.length, 3);
  const bare = settingsModule.emptySettings();
  const empty = brief.buildTodayBrief(input({ settings: bare }));
  assert.deepEqual(empty.sources, [], '没课、没目标日、没作息就没有依据可写');
});

test('buildTimeline 与简报用同一份判定：行数与 isNext 都来自同一次 summarizeToday', () => {
  const courses = [
    course({ id: 'a', sectionRanges: [{ start: 1, end: 2 }] }),
    course({ id: 'b', name: '大学英语', sectionRanges: [{ start: 9, end: 10 }] }),
  ];
  const fixed = input({ courses, clockMinutes: 8 * 60 + 30 });
  const result = brief.buildTodayBrief(fixed);
  const timeline = brief.buildTimeline(fixed);
  assert.deepEqual(timeline.map((row) => row.key), result.rows.map((row) => row.key));
  assert.deepEqual(timeline.map((row) => row.isNow), result.rows.map((row) => row.isNow));
});
