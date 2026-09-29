const { test } = require('node:test');
const assert = require('node:assert/strict');

// 校历与考试日期卡（Issue #91）：先用真实数据守住「每条都能追溯、没有日期就不编」，
// 再钉住按日期算出的状态文案。来源核验记录见 docs/exam-calendar-sources.md。
const calendar = require('../dist/services/calendar/index.js');
const dates = require('../dist/services/dates/index.js');

const TODAY = '2026-09-29';

function noon(dateText) {
  return dates.noonOf(dateText);
}

test('第一条不变量：随包的事件数据自身通过自检（来源、核查日、日期与年份一致）', () => {
  const problems = calendar.validateEvents(calendar.CALENDAR_EVENTS);
  assert.deepEqual(problems, []);
  assert.equal(calendar.CALENDAR_EVENTS.length >= 8, true, '首版至少覆盖四类来源');
});

test('自检能抓出坏数据：没来源、没核查日、没日期却写日期、年份对不上', () => {
  const base = {
    id: 'x', category: 'cet', title: '标题', date: '', timeText: '', registerText: '', scope: '2026 年下半年 · 全国',
    status: 'pending', sourceLabel: '主体', sourceUrl: 'https://example.edu.cn/a', publishedAt: '', verifiedAt: TODAY, note: '',
  };
  const problemsOf = (event) => calendar.validateEvents([event]).map((item) => item.problem);
  assert.deepEqual(problemsOf({ ...base, sourceUrl: 'http://insecure.example' }), ['原文 URL 必须是 https 链接']);
  assert.deepEqual(problemsOf({ ...base, sourceLabel: ' ' }), ['缺少发布主体']);
  assert.deepEqual(problemsOf({ ...base, verifiedAt: '2026-13-01' }), ['最后核查日不是合法日期']);
  assert.deepEqual(problemsOf({ ...base, date: '2026-12-12' }), ['没有确定日期的事件不得带日期']);
  assert.deepEqual(problemsOf({ ...base, id: '' }), ['id 为空或重复']);
  // 已公布但没有日期、或年份与适用范围不符，都要报出来
  assert.deepEqual(
    problemsOf({ ...base, status: 'published' }),
    ['已公布的事件必须有合法日期'],
  );
  assert.deepEqual(
    problemsOf({ ...base, status: 'published', date: '2025-12-13' }),
    ['适用年份 2026 与日期 2025-12-13 不一致'],
  );
});

test('已公布的考试才有倒计时；今天、过期、待公布、仅外链各自的文案都对', () => {
  const rows = new Map(calendar.groupEvents(calendar.CALENDAR_EVENTS, noon(TODAY))
    .flatMap((group) => group.rows)
    .map((row) => [row.id, row]));

  // 四级笔试 2026-12-12：还有 74 天（9 月 29 日 → 12 月 12 日）
  assert.equal(rows.get('cet-2026h2-cet4').stateLabel, '还有 74 天');
  assert.equal(rows.get('cet-2026h2-cet4').days, 74);
  assert.equal(rows.get('cet-2026h2-cet4').dateText, '2026-12-12 09:00–11:20');
  // 口试 11-21：还有 53 天
  assert.equal(rows.get('cet-2026h2-set4').stateLabel, '还有 53 天');
  // 已结束的批次：不显示倒计时，也不显示「还有」
  const ended = rows.get('ncre-2026-09');
  assert.equal(ended.days, null);
  assert.match(ended.stateLabel, /^已结束/);
  // 待公布 / 仅官方入口 / 以本校为准：三套独立文案
  assert.equal(rows.get('ncre-next').stateLabel, '待公布');
  assert.equal(rows.get('mandarin').stateLabel, '仅官方入口');
  assert.equal(rows.get('cet-2026h2-register').stateLabel, '以本校通知为准');
  assert.equal(rows.get('school-calendar').stateLabel, '仅官方入口');
  for (const id of ['ncre-next', 'mandarin', 'cet-2026h2-register', 'school-calendar']) {
    assert.equal(rows.get(id).dateText, '', `${id} 不该有日期文案`);
    assert.equal(rows.get(id).days, null, `${id} 不该有倒计时`);
  }
});

test('考试当天显示「就是今天」，过期后显示已结束多少天', () => {
  const exam = calendar.CALENDAR_EVENTS.find((event) => event.id === 'cet-2026h2-cet4');
  assert.equal(calendar.toRow(exam, noon('2026-12-12')).stateLabel, '就是今天');
  assert.equal(calendar.toRow(exam, noon('2026-12-12')).days, 0);
  assert.equal(calendar.toRow(exam, noon('2026-12-13')).stateLabel, '已结束 1 天');
  assert.equal(calendar.toRow(exam, noon('2026-12-13')).days, null);
  assert.equal(calendar.toRow(exam, noon('2026-12-11')).stateLabel, '还有 1 天');
});

test('分组按学校 → 四六级 → 计算机等级 → 普通话，组内有日期的排在前面', () => {
  const groups = calendar.groupEvents(calendar.CALENDAR_EVENTS, noon(TODAY));
  assert.deepEqual(groups.map((group) => group.category), ['school', 'cet', 'ncre', 'mandarin']);
  assert.deepEqual(groups.map((group) => group.label), ['学校校历', '四六级', '计算机等级', '普通话']);
  const cet = groups.find((group) => group.category === 'cet');
  assert.deepEqual(cet.rows.map((row) => row.id), [
    'cet-2026h2-set4', 'cet-2026h2-set6', 'cet-2026h2-cet4', 'cet-2026h2-cet6', 'cet-2026h2-register',
  ]);
  // 日期最早的口试排在最前，没有日期的报名排在最后
  assert.equal(cet.rows[0].date, '2026-11-21');
  assert.equal(cet.rows[cet.rows.length - 1].date, '');
});

test('报名与考试分开：报名条目只写「归谁定」，不冒充有日期', () => {
  const rows = calendar.loadCalendar(noon(TODAY)).groups.flatMap((group) => group.rows);
  const cet4 = rows.find((row) => row.id === 'cet-2026h2-cet4');
  const register = rows.find((row) => row.id === 'cet-2026h2-register');
  assert.match(cet4.registerText, /以本校教务处通知为准/);
  assert.match(register.registerText, /没有全国统一截止时间/);
  assert.equal(register.status, 'per-school');
  assert.equal(register.date, '');
  // 数据概况：4 条 CET 笔试/口试 + 0 条其他 = 4 条有官方日期
  const summary = calendar.loadCalendar(noon(TODAY)).summary;
  assert.equal(summary.published, 4);
  assert.equal(summary.total, calendar.CALENDAR_EVENTS.length);
  assert.equal(summary.verifiedAt, '2026-09-29');
});

test('四六级的日期与官方公告原文一致（改数据必须同步改来源）', () => {
  const byId = new Map(calendar.CALENDAR_EVENTS.map((event) => [event.id, event]));
  assert.equal(byId.get('cet-2026h2-cet4').date, '2026-12-12');
  assert.equal(byId.get('cet-2026h2-cet6').timeText, '15:00–17:25');
  assert.equal(byId.get('cet-2026h2-set4').date, '2026-11-21');
  assert.equal(byId.get('cet-2026h2-set6').date, '2026-11-22');
  for (const id of ['cet-2026h2-cet4', 'cet-2026h2-cet6', 'cet-2026h2-set4', 'cet-2026h2-set6']) {
    assert.equal(byId.get(id).sourceUrl, 'https://cet.neea.edu.cn/html1/report/2609/1-1.htm');
    assert.equal(byId.get(id).publishedAt, '2026-09-02');
  }
});
