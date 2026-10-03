const { test } = require('node:test');
const assert = require('node:assert/strict');
const product = require('../dist/services/advancement/index.js');
const model = require('../dist/services/advancement/model.js');
const verifier = require('../dist/cloudfunctions/ai/advancement.js');
const corpus = require('../dist/cloudfunctions/ai/advancement-corpus.js');
const { createHarness, openAiTextResponse } = require('./ai-harness.cjs');
const evaluator = require('../scripts/eval-advancement-model.cjs');

test('招生总量按原句主题检索，不能因发布文件归类为就业丢失依据', () => {
  for (const q of ['2026年广东普通专升本计划招生总量是多少万人？', '广东2026年专插本招生计划有多少人？']) {
    const result = product.ask(q);
    assert.equal(result.behavior, 'answer', result.note);
    assert.equal(result.citations[0].quote, '普通专升本计划招生6.5万人');
    const scope = verifier.resolveAdvancementScope(corpus, result.resolvedScope);
    assert.ok(scope.scope);
    assert.ok(verifier.resolveAdvancementSources(corpus, result.citations.map(c => c.passageId), scope.scope).sources);
  }
});

test('完整原句句号后紧随引用可上屏，但不能让段末引用覆盖前一句', async () => {
  for (const id of ['gd-segmented-2026#parts', 'gd-segmented-2026#quality-check', 'gd-zsb-2026#vocational-teacher']) {
    const document = corpus.documents.find(d => d.passages.some(p => p.id === id));
    const { sources } = verifier.resolveAdvancementSources(corpus, [id], { category: document.category, year: 2026, region: '广东省' });
    const sentences = sources[0].quote.split(/[。！？!?\n]+/u).filter(Boolean);
    const answer = sentences.map(s => `${s}。[S1]`).join('\n');
    assert.deepEqual(verifier.verifyAdvancementAnswer(answer, sources).violations, []);
    if (sentences.length > 1) assert.ok(verifier.verifyAdvancementAnswer(`${sources[0].quote}[S1]`, sources).violations.length > 0);
  }
});

test('问题范围不能被伪造scope覆盖：服务端与客户端均拒绝', async () => {
  const local = product.ask('2027年北京普通专升本网上缴费截止时间？', 2, { category: 'ordinary_专升本', year: 2026, region: '广东省' });
  assert.equal(local.behavior, 'refuse');
  const harness = createHarness({ security: { msgSecCheck: async () => ({ errCode: 0 }) }, respond: () => openAiTextResponse('网上缴费截止时间为1月23日17:00[S1]') });
  const safe = product.ask('2026年广东普通专升本网上缴费截止时间？');
  const event = model.advancementChatEvent('2027年北京普通专升本网上缴费截止时间？', safe.resolvedScope, safe.citations);
  const response = await harness.main(event);
  assert.equal(response.ok, false);
  assert.equal(response.failureClass, 'invalid_request');
  assert.equal(harness.http.length, 0);
});

test('服务端仍拒绝遗漏条件、反转否定、错误来源与新增数字', () => {
  const { sources } = verifier.resolveAdvancementSources(corpus, ['gd-segmented-2026#quality-check'], { category: 'segmented_三二分段专升本转段', year: 2026, region: '广东省' });
  for (const text of ['基本素质考核“不合格”的学生，可以报考。[S1]', '学生不得报考。[S1]', '基本素质考核“不合格”的学生，不得报考。[S2]', '基本素质考核“不合格”的学生，不得报考。[S1]\n报名费为100元。[S1]']) {
    assert.ok(verifier.verifyAdvancementAnswer(text, sources).violations.length > 0, text);
  }
});

test('真实调用留分步耗时，不能把serverElapsed当客户端端到端', async () => {
  const harness = createHarness({ security: { msgSecCheck: async () => ({ errCode: 0 }) }, respond: () => openAiTextResponse('网上缴费截止时间为1月23日17:00[S1]') });
  const local = product.ask('2026年广东普通专升本网上缴费截止时间？');
  const response = await harness.main(model.advancementChatEvent('2026年广东普通专升本网上缴费截止时间？', local.resolvedScope, local.citations));
  assert.equal(response.ok, true, response.detail);
  for (const key of ['inputSafetyMs','outputSafetyMs','modelMs','modelNetworkMs','preflightMs','accountingMs','citationMs']) assert.ok(response.timings[key] >= 0, key);
  const call = evaluator.summarizeCall({ invoked: true, result: response, elapsedMs: response.elapsedMs + 250 });
  assert.equal(call.clientElapsedMs, response.elapsedMs + 250);
});

test('只读日额度区分月度金额，不增加日计数', async () => {
  const harness = createHarness();
  const access = harness.load('access.js');
  const now = new Date('2026-10-03T04:00:00Z');
  const empty = await access.readUserDailyLimit(harness.db, 'test-admin-openid', now);
  assert.equal(empty.remaining, 30);
  await access.consumeUserLimits(harness.db, 'test-admin-openid', now);
  for (let i = 0; i < 2; i++) assert.equal((await access.readUserDailyLimit(harness.db, 'test-admin-openid', now)).remaining, 29);
  const counter = Object.keys(harness.monthly).find(key => key.startsWith('limit:day:'));
  harness.monthly[counter].count = 'bad';
  await assert.rejects(() => access.readUserDailyLimit(harness.db, 'test-admin-openid', now));
});

test('额度、审核配额与记账故障立即停止，预算缺失不能发真实请求', () => {
  for (const call of [{ failureClass: 'quota_exhausted' }, { warnings: ['用量记账失败'] }, { detail: '记账闸门被占用' }, { detail: '审核配额已耗尽' }]) assert.ok(evaluator.stopReason(call));
  assert.equal(evaluator.stopReason({ ok: true, warnings: [] }), '');
  assert.throws(() => evaluator.validateBudget('', 1));
});
