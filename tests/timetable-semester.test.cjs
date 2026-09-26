const { test } = require('node:test');
const assert = require('node:assert/strict');

// 教学周的日期推算（设计图 01 的头部与表头依据）。
// 不碰存储、不碰小程序运行时：只吃「第一周的星期一 + 总周数 + 今天」。
const semester = require('../dist/services/timetable/semester.js');

const CONFIG = { startDate: '2026-08-31', totalWeeks: 20 };

test('开学日合法性：必须是 YYYY-MM-DD 且是真实日期', () => {
  assert.equal(semester.isValidStartDate('2026-08-31'), true);
  assert.equal(semester.isValidStartDate(''), false);
  assert.equal(semester.isValidStartDate('2026-8-31'), false);
  assert.equal(semester.isValidStartDate('2026-02-30'), false);
  assert.equal(semester.isValidStartDate('2026-13-01'), false);
  assert.equal(semester.isValidStartDate('20260831'), false);
});

test('开学日是星期一：非周一要能判出来（设置页据此提示）', () => {
  assert.equal(semester.isMonday('2026-08-31'), true);
  assert.equal(semester.isMonday('2026-09-01'), false);
  assert.equal(semester.isMonday('不是日期'), false);
});

test('日期加减：跨月跨年都正确，不因时区偏移一天', () => {
  assert.equal(semester.addDays('2026-08-31', 0), '2026-08-31');
  assert.equal(semester.addDays('2026-08-31', 7), '2026-09-07');
  assert.equal(semester.addDays('2026-08-31', 21), '2026-09-21');
  assert.equal(semester.addDays('2026-12-28', 7), '2027-01-04');
  assert.equal(semester.addDays('2027-01-01', -1), '2026-12-31');
});

test('星期几：1 是星期一、7 是星期日', () => {
  assert.equal(semester.weekdayOf('2026-08-31'), 1);
  assert.equal(semester.weekdayOf('2026-09-06'), 7);
  assert.equal(semester.weekdayOf('2026-09-21'), 1);
  assert.equal(semester.weekdayOf('nope'), null);
});

test('第几周：学期内按 7 天一段，学期外返回 null（不猜、不钳）', () => {
  assert.equal(semester.weekIndexOf(CONFIG, '2026-08-31'), 1, '开学当天是第 1 周');
  assert.equal(semester.weekIndexOf(CONFIG, '2026-09-06'), 1, '第 1 周星期日');
  assert.equal(semester.weekIndexOf(CONFIG, '2026-09-07'), 2);
  assert.equal(semester.weekIndexOf(CONFIG, '2026-09-21'), 4);
  assert.equal(semester.weekIndexOf(CONFIG, '2026-08-30'), null, '开学前一天不在学期内');
  assert.equal(semester.weekIndexOf(CONFIG, '2027-01-18'), null, '超出总周数不当作学期内（第 21 周）');
  assert.equal(semester.weekIndexOf(CONFIG, '2027-01-17'), 20, '第 20 周最后一天');
});

test('总周数越界不崩：0 周或非数字时按默认跨度，且不返回负周', () => {
  assert.equal(semester.normalizeTotalWeeks(0), semester.DEFAULT_TOTAL_WEEKS);
  assert.equal(semester.normalizeTotalWeeks(-3), semester.DEFAULT_TOTAL_WEEKS);
  assert.equal(semester.normalizeTotalWeeks(99), semester.MAX_TOTAL_WEEKS, '与云端 MAX_WEEK 对齐');
  assert.equal(semester.normalizeTotalWeeks(18), 18);
  assert.equal(semester.normalizeTotalWeeks('20'), semester.DEFAULT_TOTAL_WEEKS, '字符串不悄悄当数字用');
});

test('某一周的日期区间：周一到周日，第 4 周就是 9/21–9/27', () => {
  assert.deepEqual(semester.weekDates(CONFIG, 1), { start: '2026-08-31', end: '2026-09-06' });
  assert.deepEqual(semester.weekDates(CONFIG, 4), { start: '2026-09-21', end: '2026-09-27' });
  assert.deepEqual(semester.weekDates(CONFIG, 20), { start: '2027-01-11', end: '2027-01-17' });
});

test('翻周到学期外只算日期、不报错（允许看第 21 周是因为列表里有更长的课）', () => {
  const beyond = semester.weekDates(CONFIG, 24);
  assert.deepEqual(beyond, { start: '2027-02-08', end: '2027-02-14' });
  assert.deepEqual(semester.weekDates(CONFIG, 0), { start: '2026-08-24', end: '2026-08-30' });
  assert.equal(semester.weekDates(CONFIG, 1.5), null, '非整数周不猜');
});

test('表头日期数字：7 个「几号」，缺配置时返回空数组（表头就不显示日期）', () => {
  assert.deepEqual(semester.weekDateLabels(CONFIG, 4), ['21', '22', '23', '24', '25', '26', '27']);
  assert.deepEqual(semester.weekDateLabels(CONFIG, 1), ['31', '1', '2', '3', '4', '5', '6'], '跨月照给，月份交给区间文案');
});

test('列表日期：7 个完整日期，同一天在列表里能单独读懂', () => {
  assert.deepEqual(semester.weekDateFullLabels(CONFIG, 4), [
    '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27',
  ]);
  assert.deepEqual(semester.weekDateFullLabels(CONFIG, 1)[0], '2026-08-31', '跨月也给完整日期');
});

test('头部文案：9/21 – 9/27，跨月跨年也读得懂', () => {
  assert.equal(semester.formatWeekRange(CONFIG, 4), '9/21 – 9/27');
  assert.equal(semester.formatWeekRange(CONFIG, 1), '8/31 – 9/6');
  assert.equal(semester.formatWeekRange(CONFIG, 20), '1/11 – 1/17');
});

test('没设开学日时全部退化为「没有日期」，不抛异常', () => {
  const empty = { startDate: '', totalWeeks: 20 };
  assert.equal(semester.weekIndexOf(empty, '2026-09-21'), null);
  assert.equal(semester.weekDates(empty, 4), null);
  assert.deepEqual(semester.weekDateLabels(empty, 4), []);
  assert.equal(semester.formatWeekRange(empty, 4), '');
});
