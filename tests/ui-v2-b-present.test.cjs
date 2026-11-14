const { test } = require('node:test');
const assert = require('node:assert/strict');

// B 的展示层：设计图 02 / 51 / 67 的几何与时刻口径。
// 这里只验证纯函数，不把「class 字符串存在」当成视觉验收。
const view = require('../dist/services/timetable/view.js');
const present = require('../dist/ui/timetable/present.js');

function course(overrides) {
  return {
    id: 'tc_1',
    name: '高等数学',
    credits: '',
    teacher: '林加燕',
    weekday: 1,
    startSection: 3,
    endSection: 4,
    sectionRanges: [{ start: 3, end: 4 }],
    weeks: [10],
    weeksRecognized: true,
    weekText: '[10]周',
    location: '崇礼楼-306-计算机十九室',
    campus: '清远校区',
    siteNumber: '44',
    note: '',
    warnings: [],
    source: 'excel',
    semester: '2026-2027学年第一学期',
    rawText: '',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

test('紧凑窗口默认 3–8 节，但不把 1–2 / 11–12 节的实际课程藏起来', () => {
  const plain = present.presentWeekGrid(view.buildGrid([course()], 10));
  assert.equal(plain.windowStart, 3);
  assert.equal(plain.windowEnd, 8);
  assert.deepEqual(plain.axisRows.map((row) => row.label), ['3–4', '5–6', '7–8']);
  assert.equal(plain.axisRows[0].heightPx, 112, '每个大节 112px');

  const early = present.presentWeekGrid(view.buildGrid([course({ sectionRanges: [{ start: 1, end: 2 }] })], 10));
  assert.equal(early.windowStart, 1, '有 1–2 节的课时窗口必须扩到第 1 节');
  assert.equal(early.windowEnd, 8);

  const late = present.presentWeekGrid(view.buildGrid([course({ sectionRanges: [{ start: 11, end: 12 }] })], 10));
  assert.equal(late.windowStart, 3);
  assert.equal(late.windowEnd, 12, '有 11–12 节的课时窗口必须扩到第 12 节');
  assert.deepEqual(late.axisRows.map((row) => row.label), ['3–4', '5–6', '7–8', '9–10', '11–12']);

  const both = present.presentWeekGrid(view.buildGrid([
    course({ id: 'a', weekday: 1, sectionRanges: [{ start: 1, end: 2 }] }),
    course({ id: 'b', weekday: 6, sectionRanges: [{ start: 11, end: 12 }] }),
  ], 10));
  assert.equal(both.windowStart, 1);
  assert.equal(both.windowEnd, 12);
});

test('完整 12 节入口：展开后是 1–12，七天等宽 74px，总宽 518px', () => {
  const grid = view.buildGrid([course()], 10);
  const compact = present.presentWeekGrid(grid, { expanded: false });
  assert.equal(compact.widthPx, 7 * 74);
  assert.equal(compact.columns.length, 7);
  assert.equal(compact.canExpand, true);

  const full = present.presentWeekGrid(grid, { expanded: true });
  assert.equal(full.windowStart, 1);
  assert.equal(full.windowEnd, 12);
  assert.deepEqual(full.axisRows.map((row) => row.label), ['1–2', '3–4', '5–6', '7–8', '9–10', '11–12']);
  assert.equal(full.gridHeightPx, 6 * 112);
  assert.equal(full.totalHeightPx, 44 + 6 * 112);
  assert.equal(full.canExpand, false);
});

test('多课同段：部分重叠保留两条泳道，同格多门仍是一块带门数', () => {
  const overlap = present.presentWeekGrid(view.buildGrid([
    course({ id: 'a', name: '甲', sectionRanges: [{ start: 5, end: 6 }] }),
    course({ id: 'b', name: '乙', sectionRanges: [{ start: 6, end: 7 }] }),
  ], 10));
  const blocks = overlap.columns[0].blocks;
  assert.equal(blocks.length, 2);
  assert.notEqual(blocks[0].laneLeftPercent, blocks[1].laneLeftPercent);
  assert.ok(blocks[0].laneWidthPercent < 100);

  const same = present.presentWeekGrid(view.buildGrid([
    course({ id: 'a', name: '甲', sectionRanges: [{ start: 5, end: 6 }] }),
    course({ id: 'b', name: '乙', sectionRanges: [{ start: 5, end: 6 }] }),
  ], 10));
  assert.equal(same.columns[0].blocks.length, 1);
  assert.equal(same.columns[0].blocks[0].count, 2);
});

test('变化标记：本次调整的课程块有独立 flag，不靠颜色暗示', () => {
  const grid = view.buildGrid([course({ id: 'tc_changed' })], 10);
  const plain = present.presentWeekGrid(grid, { highlightIds: [] });
  assert.equal(plain.columns[0].blocks[0].changed, false);
  assert.equal(plain.columns[0].blocks[0].flag, '');

  const marked = present.presentWeekGrid(grid, { highlightIds: ['tc_changed'] });
  assert.equal(marked.columns[0].blocks[0].changed, true);
  assert.equal(marked.columns[0].blocks[0].flag, '本次调整');
});

test('每日安排：时刻只来自用户填写的作息；没填就只显示节次', () => {
  const sectionTimes = Array.from({ length: 12 }, () => ({ start: '', end: '' }));
  sectionTimes[2] = { start: '10:10', end: '10:55' };
  sectionTimes[3] = { start: '11:00', end: '11:45' };
  const settings = { semesterName: '', startDate: '2026-09-07', totalWeeks: 18, sectionTimes };
  const courses = [course({ weekday: 3, sectionRanges: [{ start: 3, end: 4 }] })];

  const day = present.presentDayView(courses, 10, 3, settings);
  assert.equal(day.rows.length, 1);
  assert.equal(day.rows[0].timeLabel, '10:10 – 11:45');
  assert.equal(day.rows[0].sectionLabel, '第 3-4 节');
  assert.match(day.timeHint, /作息/u);

  const noTimes = present.presentDayView(courses, 10, 3, { ...settings, sectionTimes: Array.from({ length: 12 }, () => ({ start: '', end: '' })) });
  assert.equal(noTimes.rows[0].timeLabel, '');
  assert.doesNotMatch(noTimes.timeHint, /10:10/u);
  assert.match(noTimes.timeHint, /只显示节次/u);

  const empty = present.presentDayView(courses, 10, 4, settings);
  assert.equal(empty.rows.length, 0);
  assert.match(empty.emptyText, /这一天没有安排课程/u);
});

test('日期条：周末也在，日期来自学期设置；没有开学日时不编造日期', () => {
  const settings = { semesterName: '', startDate: '2026-09-07', totalWeeks: 18, sectionTimes: [] };
  const chips = present.presentDayChips([course({ weekday: 6 })], 10, settings, 6);
  assert.equal(chips.length, 7);
  assert.equal(chips[5].label, '周六');
  assert.ok(chips[5].dateLabel !== '');
  assert.equal(chips[5].today, true);
  assert.equal(chips[5].hasCourse, true);

  const bare = present.presentDayChips([course()], 10, { ...settings, startDate: '' }, 0);
  assert.deepEqual(bare.map((chip) => chip.dateLabel), ['', '', '', '', '', '', '']);
});

test('横向定位：周五等靠后的列能滚进可视区，且不越过最大滚动量', () => {
  assert.equal(present.scrollLeftForWeekday(1, 300), 0);
  assert.ok(present.scrollLeftForWeekday(5, 300) > 0);
  assert.ok(present.scrollLeftForWeekday(7, 300) <= 7 * 74 - 300);
  assert.equal(present.scrollLeftForWeekday(7, 518), 0);
});
