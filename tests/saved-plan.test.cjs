const { test } = require('node:test');
const assert = require('node:assert/strict');
const { savedPlanView } = require('../dist/services/goals/saved.js');
const { emptySettings } = require('../dist/services/timetable/settings.js');
const { normalizePlan } = require('../dist/services/goals/plan.js');
const plain = (value) => JSON.parse(JSON.stringify(value));
const settings = { ...emptySettings(), startDate: '2026-09-21', totalWeeks: 20 };
const plan = { goalName: '四级', goalId: 'goal-a', goalDate: '2026-12-13', today: '2026-11-10',
  week: 8, weekKnown: true, blocks: [
    { id: 'wed', weekday: 3, startSection: 5, endSection: 6, minutes: 45, topic: '听力', week: 8 },
    { id: 'sun', weekday: 7, startSection: 5, endSection: 6, minutes: 45, topic: '词汇', week: 8 },
  ], totalMinutes: 90, weeklyCount: 2, remainingDays: 33, createdAt: 1,
  headline: '', rationale: [], constraintLines: [], dropped: [] };

test('已存计划：按实际日历周匹配；换学期的第8周不能显示旧第8周', () => {
  const current = savedPlanView(plan, [], settings, '2026-11-10', true, 8);
  assert.equal(current.rows.length, 2);
  assert.deepEqual(current.rows.map((row) => row.date), ['2026-11-11', '2026-11-15']);
  assert.equal(savedPlanView(plan, [], settings, '2026-11-10', true, 9).rows.length, 0);
  const nextSemester = { ...settings, startDate: '2027-09-20' };
  const mismatched = savedPlanView(plan, [], nextSemester, '2027-11-10', true, 8);
  assert.equal(mismatched.rows.length, 0);
  assert.match(mismatched.notice, /无法对应/u);
  assert.equal(mismatched.hasPlan, true, '无法匹配时仍能打开原快照');
});

test('已存计划：没设置开学日不塞进第1周；离线完整快照仍可查看', () => {
  const panel = savedPlanView(plan, [], emptySettings(), '2026-11-10', false, 1);
  assert.equal(panel.rows.length, 0); assert.match(panel.notice, /开学日/u);
  const offline = savedPlanView(plan, [], emptySettings(), '2026-11-10', false);
  assert.equal(offline.rows.length, 2);
  assert.ok(offline.rows.every((row) => row.status === 'unknown'));
});

test('已存计划：课程后改占用计划时段时显示冲突；不改课程或原计划', () => {
  const course = { id: 'new-course', name: '数学', weekday: 3, startSection: 5, endSection: 6,
    sectionRanges: [{ start: 5, end: 6 }], weeks: [8], weeksRecognized: true };
  const snapshot = plain(plan);
  const view = savedPlanView(plan, [course], settings, '2026-11-10', true, 8);
  assert.equal(view.rows[0].status, 'conflict'); assert.match(view.rows[0].note, /数学/u);
  assert.equal(view.rows[1].status, 'saved'); assert.deepEqual(plan, snapshot);
  assert.equal(savedPlanView(plan, [{ ...course, weeks: [9] }], settings, '2026-11-10', true, 8).rows[0].status, 'saved');
});

test('已存计划：过去的日期保留、标记，不冒充新的待执行安排', () => {
  const past = savedPlanView(plan, [], settings, '2026-12-20');
  assert.ok(past.rows.every((row) => row.status === 'past'));
  assert.match(past.title, /历史/u); assert.match(past.notice, /已过去/u);
});

test('计划脏数据：非法日期、零分钟与超长安排不能被恢复成可用计划', () => {
  for (const dirty of [{ ...plan, today: '2026-02-30' }, { ...plan, goalDate: '错误日期' },
    { ...plan, blocks: [{ ...plan.blocks[0], minutes: 0.1 }] },
    { ...plan, blocks: [{ ...plan.blocks[0], minutes: 181 }] }]) {
    assert.equal(normalizePlan(dirty), null);
  }
});

test('AI来源计划必须保留与原输入对应的依据，不能恢复空白或伪造的AI来源', () => {
  const ai = { ...plan, origin: 'ai-constraints', constraintText: '听力最弱',
    aiEvidence: [{ label: '重点练习', value: '重点练听力', quote: '听力最弱' }] };
  assert.equal(normalizePlan(ai).origin, 'ai-constraints');
  for (const invalid of [{ ...ai, aiEvidence: [] }, { ...ai, constraintText: '别的输入' },
    { ...ai, aiEvidence: [{ label: '', value: '听力', quote: '听力最弱' }] }]) {
    assert.equal(normalizePlan(invalid), null);
  }
});
