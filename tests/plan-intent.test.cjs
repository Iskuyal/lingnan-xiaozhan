const { test } = require('node:test');
const assert = require('node:assert/strict');
const intent = require('../dist/services/goals/intent.js');
const text = '周二没空，周末上午有兼职，每次半小时，听力最弱，一周安排三回';
const sample = () => ({ kind: 'constraints', minutes: { value: 30, quote: '每次半小时' },
  sessions: { value: 3, quote: '一周安排三回' }, focus: { value: '听力', quote: '听力最弱' },
  excludedDays: [{ days: [2], quote: '周二没空' }],
  excludedPeriods: [{ days: [6, 7], period: 'morning', quote: '周末上午有兼职' }], unhandled: [] });

test('计划AI：无效数值、范围、原话依据或结构整份拒绝，不拿部分字段排程', () => {
  for (const mutation of [
    { minutes: { value: 5, quote: '每次半小时' } }, { minutes: { value: 181, quote: '每次半小时' } },
    { sessions: { value: 15, quote: '一周安排三回' } }, { sessions: { value: '3', quote: '一周安排三回' } },
    { focus: { value: '数学', quote: '听力最弱' } }, { minutes: { value: 30, quote: '凭空编造的原话' } },
    { excludedDays: [{ days: [8], quote: '周二没空' }] },
    { excludedPeriods: [{ days: [6, 7], period: 'night', quote: '周末上午有兼职' }] },
    { excludedDays: [] , hiddenConstraint: '未验证的字段' },
  ]) {
    const reply = intent.parsePlanIntent(JSON.stringify({ ...sample(), ...mutation }), text, '英语四级');
    assert.equal(reply.kind, 'invalid', JSON.stringify(mutation));
  }
});

test('计划AI：自然说法转换为可核对约束，排除星期和时段均保留原话', () => {
  const reply = intent.parsePlanIntent(JSON.stringify(sample()), text, '英语四级');
  assert.equal(reply.kind, 'constraints');
  assert.equal(reply.draft.readout.constraints.maxMinutesPerBlock, 30);
  assert.equal(reply.draft.readout.constraints.blocksPerWeek, 3);
  assert.deepEqual(reply.draft.readout.constraints.excludedWeekdays, [2]);
  assert.deepEqual(reply.draft.readout.constraints.blockedSections,
    [{ weekday: 6, start: 1, end: 4 }, { weekday: 7, start: 1, end: 4 }]);
  assert.ok(reply.draft.evidence.every((item) => text.includes(item.quote)));
});

test('计划AI：未提的参数标默认；未理解的情况与澄清不生成约束', () => {
  const defaults = intent.parsePlanIntent(JSON.stringify({ ...sample(), minutes: null, sessions: null }), text);
  assert.equal(defaults.kind, 'constraints');
  assert.equal(defaults.draft.readout.recognized.maxMinutesPerBlock, false);
  assert.ok(defaults.draft.readout.lines.some((line) => line.includes('默认')));
  const unknown = intent.parsePlanIntent(JSON.stringify({ ...sample(), unhandled: ['周二没空'] }), text);
  assert.equal(unknown.kind, 'clarify');
  assert.equal(intent.parsePlanIntent('{"kind":"clarify","message":"请说明是否晚上不排"}', text).kind, 'clarify');
  for (const bad of ['不是JSON', '{"kind":"save","success":true}', '[]', '{"kind":"clarify","message":""}']) {
    assert.equal(intent.parsePlanIntent(bad, text).kind, 'invalid');
  }
});

test('计划AI：只有目标与情况进模型事件，未携带课程、教师、地点或日期', () => {
  const event = intent.buildPlanIntentEvent('英语四级', text);
  assert.equal(event.feature, 'study-plan-intent');
  assert.equal(event.maxTokens, 900);
  assert.ok(JSON.stringify(event).includes('英语四级'));
  assert.equal('courses' in event, false); assert.equal('settings' in event, false);
  for (const invalid of ['', '课'.repeat(121)]) assert.throws(() => intent.buildPlanIntentEvent('英语四级', invalid));
});

test('计划AI：空输入不请求；三类失败分别保留；未审核成功结果不接受', async () => {
  let calls = 0;
  globalThis.wx = { cloud: { callFunction: async () => { calls += 1; throw new Error('不该调用'); } } };
  assert.equal((await intent.requestPlanIntent('英语四级', '')).kind, 'clarify');
  assert.equal(calls, 0);
  for (const failureClass of ['model_unavailable', 'content_rejected', 'quota_exhausted']) {
    globalThis.wx.cloud.callFunction = async () => ({ result: { ok: false, failureClass, message: failureClass } });
    const reply = await intent.requestPlanIntent('英语四级', text);
    assert.equal(reply.kind, 'unavailable'); assert.equal(reply.message, failureClass);
  }
  globalThis.wx.cloud.callFunction = async () => ({ result: { ok: true, text: JSON.stringify(sample()), safety: null } });
  assert.equal((await intent.requestPlanIntent('英语四级', text)).kind, 'invalid');
  delete globalThis.wx;
});
