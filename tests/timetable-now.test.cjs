const { test } = require('node:test');
const assert = require('node:assert/strict');

// 今日速查（设计图 01 的速查条与 10 的三态）：只在用户填了作息时才有意义。
const now = require('../dist/services/timetable/now.js');
const settingsModule = require('../dist/services/timetable/settings.js');

/** 只填第 5、6 节的作息（13:00–13:40 / 13:45–14:25），够覆盖「正在上 / 下一节 / 上完」。 */
function filled() {
  const base = settingsModule.emptySettings();
  base.sectionTimes[4] = { start: '13:00', end: '13:40' };
  base.sectionTimes[5] = { start: '13:45', end: '14:25' };
  return base;
}

function item(overrides) {
  return { key: 'tc_1:5', courseId: 'tc_1', name: '高等数学', location: '崇礼楼 306', teacher: '林加燕', start: 5, end: 6, ...overrides };
}

test('用户填没填作息：只要有一节起止合法就算填了，只填一半不算', () => {
  assert.equal(now.hasSectionTimes(filled()), true);
  assert.equal(now.hasSectionTimes(settingsModule.emptySettings()), false);
  const half = settingsModule.emptySettings();
  half.sectionTimes[0] = { start: '08:15', end: '' };
  assert.equal(now.hasSectionTimes(half), false, '只有起始时刻不算填了');
});

test('正在上：此刻落在课的区间内', () => {
  const summary = now.summarizeToday([item({})], filled(), 13 * 60 + 10);
  assert.equal(summary.kind, 'current');
  assert.equal(summary.note, '正在上');
  assert.equal(summary.name, '高等数学');
  assert.equal(summary.sectionLabel, '第 5-6 节');
  assert.equal(summary.timeLabel, '13:00 – 14:25', '从第 5 节起始到第 6 节结束');
  assert.equal(summary.detail, '崇礼楼 306 · 林加燕');
});

test('下一节：还没到第一节课时，报下一节并给时刻', () => {
  const summary = now.summarizeToday([item({})], filled(), 12 * 60);
  assert.equal(summary.kind, 'next');
  assert.equal(summary.note, '下一节');
  assert.equal(summary.sectionLabel, '第 5-6 节');
  assert.equal(summary.timeLabel, '13:00 – 14:25');
});

test('今天上完了：所有课都已结束', () => {
  const summary = now.summarizeToday([item({})], filled(), 20 * 60);
  assert.equal(summary.kind, 'done');
  assert.equal(summary.note, '今天的课已经上完');
  assert.equal(summary.name, '');
});

test('今天没课：没有当天的课，不假装有安排', () => {
  const summary = now.summarizeToday([], filled(), 13 * 60 + 10);
  assert.equal(summary.kind, 'none');
  assert.equal(summary.note, '今天没有安排课程');
});

test('没填作息时不显示任何时刻（timeLabel 为空），状态仍可判定', () => {
  const summary = now.summarizeToday([item({})], settingsModule.emptySettings(), 13 * 60);
  assert.equal(summary.timeLabel, '', '没填作息就不许出现时刻');
  assert.ok(['next', 'done', 'none'].includes(summary.kind));
});

test('只填了一部分作息：缺时刻的那一节不显示时刻，也不影响别的节', () => {
  const partial = filled();
  partial.sectionTimes[5] = { start: '', end: '' };
  const summary = now.summarizeToday([item({})], partial, 13 * 60 + 10);
  assert.equal(summary.kind, 'current');
  assert.equal(summary.timeLabel, '', '起止任一缺失就不显示半截时刻');
});

test('同一门课一天两段：正在上的那一段才是结论，键区分到起始节', () => {
  const items = [
    item({ key: 'tc_1:5', start: 5, end: 6 }),
    item({ key: 'tc_1:11', start: 11, end: 12, name: '公共外语（英语）一' }),
  ];
  const base = filled();
  base.sectionTimes[10] = { start: '19:20', end: '20:00' };
  base.sectionTimes[11] = { start: '20:05', end: '20:45' };
  assert.equal(now.summarizeToday(items, base, 13 * 60 + 10).key, 'tc_1:5');
  const evening = now.summarizeToday(items, base, 19 * 60 + 30);
  assert.equal(evening.key, 'tc_1:11', '晚上那一段');
  assert.equal(evening.name, '公共外语（英语）一');
});

test('同格两门课：正在上时取起始节次靠前的那一门，同节次则按传入顺序', () => {
  const items = [
    item({ key: 'b:5', courseId: 'b', name: '形势与政策', start: 5, end: 6 }),
    item({ key: 'a:5', courseId: 'a', name: '习近平新时代中国特色社会主义思想概论', start: 5, end: 6 }),
  ];
  const summary = now.summarizeToday(items, filled(), 13 * 60 + 10);
  assert.equal(summary.name, '形势与政策', '同节次时按传入顺序取第一门（页面给的顺序是稳定的）');
});

test('detail 不补占位：缺地点或教师时不留分隔符', () => {
  assert.equal(now.summarizeToday([item({ location: '', teacher: '' })], filled(), 13 * 60 + 10).detail, '');
  assert.equal(now.summarizeToday([item({ location: '', teacher: '林加燕' })], filled(), 13 * 60 + 10).detail, '林加燕');
});
