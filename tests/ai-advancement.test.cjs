/**
 * 升学问答模型版的服务端约束测试（Issue #94，advancement-qa）。
 *
 * 这一层要证明的是「模型说的话有没有官方依据」由服务端把关，而不是靠提示词自觉：
 * 段落只能来自服务端语料、范围要与段落元信息一致、含日期/数字/条件的句子必须有出处标记，
 * 校验不过的回答**不返回给调用方**（降级由客户端做）。
 *
 * 运行真实编译产物与真实入口（tests/ai-harness.cjs），只桩掉网络/云 SDK/数据库。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHarness, openAiTextResponse } = require('./ai-harness.cjs');

const CORPUS_FILE = path.resolve('dist/cloudfunctions/ai/advancement-corpus.js');

const SCOPE = { category: 'ordinary_专升本', year: 2026, region: '广东省' };
const FEE = 'gd-zsb-2026#fee-deadline';
const REGISTER = 'gd-zsb-2026#register-time';

function wechatOk() {
  return {
    msgSecCheck: () => Promise.resolve({ errCode: 0 }),
    imgSecCheck: () => Promise.resolve({ errCode: 0 }),
  };
}

/** 夹具在 vm 里跑，跨 realm 的数组/对象不能用 deepStrictEqual 直接比（原型不同）。 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function advancementEvent(overrides = {}) {
  return {
    action: 'chat',
    feature: 'advancement-qa',
    system: '你是升学助手，只依据给出的段落回答。',
    messages: [{ role: 'user', text: '2026年广东普通专升本网上缴费什么时候截止？' }],
    scope: { ...SCOPE },
    passageIds: [FEE],
    ...overrides,
  };
}

/** 语料里的原始段落文本（从构建产物取，避免在测试里手抄原文）。 */
function passageText(id) {
  const corpus = require(CORPUS_FILE);
  for (const document of corpus.documents) {
    for (const passage of document.passages) if (passage.id === id) return passage.text;
  }
  throw new Error(`语料里没有段落 ${id}`);
}

// ---------- 语料与注入 ----------

test('升学语料随构建注入云函数目录，且只带原文与出处（不含检索用 context）', () => {
  const corpus = require(CORPUS_FILE);
  assert.equal(typeof corpus.version, 'string');
  assert.match(corpus.version, /^adv-corpus-[0-9a-f]{12}$/);
  assert.equal(corpus.documents.length, 4);
  const passages = corpus.documents.flatMap((document) => document.passages);
  assert.equal(passages.length, 25);
  for (const passage of passages) {
    assert.deepEqual(Object.keys(passage).sort(), ['id', 'text']);
    assert.ok(passage.text.length > 0);
  }
});

test('advancement-qa：注入可信段落（带出处编号与元信息），并把引用回传给调用方', async () => {
  const harness = createHarness({
    security: wechatOk(),
    respond: () => openAiTextResponse(`网上缴费截止时间为1月23日17:00[S1]。`),
  });
  const result = await harness.main(advancementEvent({ passageIds: [FEE, REGISTER] }));

  assert.equal(result.ok, true, result.detail);
  assert.equal(result.text, '网上缴费截止时间为1月23日17:00[S1]。');
  assert.equal(result.advancement.verified, true);
  assert.equal(result.advancement.refused, false);
  assert.deepEqual(plain(result.advancement.violations), []);
  assert.match(result.advancement.corpusVersion, /^adv-corpus-[0-9a-f]{12}$/);
  assert.deepEqual(plain(result.advancement.scope), SCOPE);
  assert.equal(result.advancement.sources.length, 2);
  assert.equal(result.advancement.sources[0].id, FEE);
  assert.equal(result.advancement.sources[0].quote, passageText(FEE));
  assert.equal(result.advancement.sources[0].sourceUrl.includes('eea.gd.gov.cn'), true);

  // 注入发生在输入检测之前：送进模型的 system 里必须带【升学资料检索结果】与 [S1] 标记。
  const body = JSON.parse(harness.http.at(-1).body);
  const system = body.messages.find((message) => message.role === 'system').content;
  assert.match(system, /【升学资料检索结果】/);
  assert.match(system, /\[S1\]/);
  assert.ok(system.includes(passageText(FEE)));
  // 检索用 context 不进提示词（它不是原文）。
  assert.equal(system.includes('报名开始 报名截止'), false);
});

test('advancement-qa：不是这个 feature 的 chat 不注入升学资料', async () => {
  const harness = createHarness({
    security: wechatOk(),
    respond: () => openAiTextResponse('普通回答'),
  });
  const result = await harness.main(advancementEvent({ feature: 'timetable-assistant' }));
  assert.equal(result.ok, true);
  assert.equal(result.advancement, null);
  const body = JSON.parse(harness.http.at(-1).body);
  const system = body.messages.find((message) => message.role === 'system').content;
  assert.equal(system.includes('【升学资料检索结果】'), false);
});

// ---------- 范围与段落校验（fail-closed） ----------

test('advancement-qa：缺 scope 或缺 passageIds 一律按参数错误拒绝，且不调用模型', async () => {
  const cases = [
    advancementEvent({ scope: undefined }),
    advancementEvent({ scope: { category: SCOPE.category, year: SCOPE.year } }),
    advancementEvent({ passageIds: undefined }),
    advancementEvent({ passageIds: [] }),
  ];
  for (const event of cases) {
    const harness = createHarness({ security: wechatOk(), respond: () => openAiTextResponse('不应到达') });
    const result = await harness.main(event);
    assert.equal(result.ok, false);
    assert.equal(result.failureClass, 'invalid_request');
    assert.equal(result.text, '');
    assert.equal(harness.http.length, 0, '参数校验未通过时不应发模型请求');
  }
});

test('advancement-qa：段落与声明范围不符时拒绝（类别 / 年份 / 地区 / 越权 id / 重复）', async () => {
  const cases = [
    { label: '类别不符', event: advancementEvent({ passageIds: ['gd-employment-2026#civil-servant'] }) },
    { label: '年份不符', event: advancementEvent({ scope: { ...SCOPE, year: 2027 } }) },
    { label: '地区不符', event: advancementEvent({ scope: { ...SCOPE, region: '北京市' } }) },
    { label: '目录外的段落 id', event: advancementEvent({ passageIds: ['gd-zsb-2026#not-exist'] }) },
    { label: '客户端自造的段落 id', event: advancementEvent({ passageIds: ['自己编的原文'] }) },
    { label: '同一段落重复', event: advancementEvent({ passageIds: [FEE, FEE] }) },
    { label: '超过上限', event: advancementEvent({ passageIds: Array.from({ length: 5 }, () => FEE) }) },
  ];
  for (const item of cases) {
    const harness = createHarness({ security: wechatOk(), respond: () => openAiTextResponse('不应到达') });
    const result = await harness.main(item.event);
    assert.equal(result.ok, false, item.label);
    assert.equal(result.failureClass, 'invalid_request', item.label);
    assert.equal(harness.http.length, 0, `${item.label}：不应发模型请求`);
  }
});

// ---------- 出处校验（回答上屏前的最后一道闸） ----------

test('advancement-qa：句中的日期/数字在语料里找不到 → citation_unverified，且不返回该回答', async () => {
  const harness = createHarness({
    security: wechatOk(),
    // 段落原文是 1月23日17:00，模型写成 1月30日 17:00：格式合法、数字没有出处。
    respond: () => openAiTextResponse('网上缴费截止时间为1月30日17:00[S1]。'),
  });
  const result = await harness.main(advancementEvent());
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'citation_unverified');
  assert.equal(result.text, '', '没通过出处校验的回答不上屏');
  assert.equal(result.message, '这条回答没能核对上官方原文的出处，已改为展示检索到的原文摘录。');
  assert.deepEqual(plain(result.advancement.violations), ['s1:unsupported_number(1月30日17:00)']);
  assert.equal(result.advancement.verified, false);
  // 引用仍在返回值里：调用方要能拿着它降级展示原文摘录。
  assert.equal(result.advancement.sources[0].id, FEE);
});

test('advancement-qa：含事实的句子没有出处标记 → citation_unverified', async () => {
  const harness = createHarness({
    security: wechatOk(),
    respond: () => openAiTextResponse('网上预报名时间以省教育考试院通知为准，请及时关注。'),
  });
  const result = await harness.main(advancementEvent());
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'citation_unverified');
  assert.deepEqual(plain(result.advancement.violations), ['s1:uncited_claim']);
});

test('advancement-qa：指向不存在段落的标记 → citation_unverified', async () => {
  const harness = createHarness({
    security: wechatOk(),
    // 只注入 1 段，模型却引用了 [S2]。
    respond: () => openAiTextResponse('网上缴费截止时间为1月23日17:00[S2]。'),
  });
  const result = await harness.main(advancementEvent());
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'citation_unverified');
  assert.deepEqual(plain(result.advancement.violations), ['s1:unknown_marker']);
});

test('advancement-qa：出处标记指向的段落不支持该数字 → citation_unverified', async () => {
  const harness = createHarness({
    security: wechatOk(),
    // 注入两段：缴费截止（1月23日17:00）与预报名（2026年1月12日09:00至19日18:00）。
    // 模型把预报名日期标成 [S1]（缴费段），S1 里没有 1月12日。
    respond: () => openAiTextResponse('网上预报名时间为1月12日09:00[S1]。'),
  });
  const result = await harness.main(advancementEvent({ passageIds: [FEE, REGISTER] }));
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'citation_unverified');
  assert.deepEqual(plain(result.advancement.violations), ['s1:unsupported_number(1月12日09:00)']);
});

test('advancement-qa：逐字照抄段落、或省略年份前缀的合法写法都通过', async () => {
  const cases = [
    `网上缴费截止时间为1月23日17:00[S1]。`,
    // 预报名段落在本次注入里是 [S2]，原文写「2026年1月12日09:00至19日18:00」：模型省略年份也不算改数字。
    `网上预报名时间为1月12日09:00至19日18:00[S2]。`,
    // 无数字的过渡句不要求出处，也不当成事实断言。
    `下面依据官方原文回答。网上缴费截止时间为1月23日17:00[S1]。`,
  ];
  for (const text of cases) {
    const harness = createHarness({ security: wechatOk(), respond: () => openAiTextResponse(text) });
    const result = await harness.main(advancementEvent({ passageIds: [FEE, REGISTER] }));
    assert.equal(result.ok, true, `${text} → ${result.detail}`);
    assert.equal(result.advancement.verified, true);
  }
});

test('advancement-qa：数值等价写法（1.5万 ↔ 15000）算有出处，改动数字仍然拦下', async () => {
  const cases = [
    // 段落写「全省提供公务员岗位不少于1.5万个」，模型把单位展开成阿拉伯数字：同一个数。
    { passageId: 'gd-employment-2026#civil-servant', text: '全省提供公务员岗位不少于15000个[S1]。', ok: true },
    // 数量级写错：15000 → 150000 仍然拦下。
    { passageId: 'gd-employment-2026#civil-servant', text: '全省提供公务员岗位不少于150000个[S1]。', ok: false, violation: 's1:unsupported_number(150000)' },
    // 每科 40 元不能写成 30 元。
    { passageId: 'gd-segmented-2026#fee', text: '每科报考费为30元[S1]。', ok: false, violation: 's1:unsupported_number(30)' },
  ];
  for (const item of cases) {
    const harness = createHarness({ security: wechatOk(), respond: () => openAiTextResponse(item.text) });
    const result = await harness.main(advancementEvent({
      passageIds: [item.passageId],
      scope: { category: item.passageId.startsWith('gd-segmented') ? 'segmented_三二分段专升本转段' : 'internship_实习招聘', year: 2026, region: '广东省' },
    }));
    assert.equal(result.ok, item.ok, `${item.text} → ${result.detail}`);
    if (!item.ok) {
      assert.equal(result.failureClass, 'citation_unverified');
      assert.deepEqual(plain(result.advancement.violations), [item.violation]);
    }
  }
});

test('advancement-qa：问题里的年份可从材料标题/文号核对，写成别的年份仍被拦下', async () => {
  const cases = [
    // 段落原文里没有年份，但引用卡片的标题就是《广东省2026年…规定》，模型复述 2026 年算有出处。
    { text: '2026年网上缴费截止时间为1月23日17:00[S1]。', ok: true },
    // 2027 年在哪里都查不到：标题、文号、原文与发布日期里都没有 2027。
    { text: '2027年网上缴费截止时间为1月23日17:00[S1]。', ok: false, violation: 's1:unsupported_number(2027)' },
  ];
  for (const item of cases) {
    const harness = createHarness({ security: wechatOk(), respond: () => openAiTextResponse(item.text) });
    const result = await harness.main(advancementEvent({ passageIds: [FEE] }));
    assert.equal(result.ok, item.ok, `${item.text} → ${result.detail}`);
    if (!item.ok) {
      assert.equal(result.failureClass, 'citation_unverified');
      assert.deepEqual(plain(result.advancement.violations), [item.violation]);
    }
  }
});

test('advancement-qa：模型自己说「无法核实」时按拒答返回，不算校验失败', async () => {
  const harness = createHarness({
    security: wechatOk(),
    respond: () => openAiTextResponse('无法核实'),
  });
  const result = await harness.main(advancementEvent());
  assert.equal(result.ok, true);
  assert.equal(result.text, '无法核实');
  assert.equal(result.advancement.refused, true);
  assert.equal(result.advancement.verified, true);
  assert.deepEqual(plain(result.advancement.violations), []);
});

test('advancement-qa：模型返回空内容仍按模型不可用处理（不是出处问题）', async () => {
  const harness = createHarness({ security: wechatOk(), respond: () => openAiTextResponse('') });
  const result = await harness.main(advancementEvent());
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'model_unavailable');
});

// ---------- 语料缺失时 fail-closed ----------

test('升学语料缺失/损坏时 advancement-qa 按 internal 拒绝，其它落点不受影响', () => {
  // 语料在函数加载时读取，而夹具会缓存已读过的模块源码（tests/ai-harness.cjs 的 sourceCache），
  // 同进程里改文件不会生效——因此这条放在**子进程**里跑：把语料换成一个空壳（相当于构建产物损坏），
  // 断言 fail-closed，再改回来。用「损坏」而不是「删文件」：夹具读不到文件会重试 20 秒。
  const { spawnSync } = require('node:child_process');
  const script = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { createHarness, openAiTextResponse } = require('./tests/ai-harness.cjs');",
    "const file = path.resolve('dist/cloudfunctions/ai/advancement-corpus.js');",
    "const backup = file + '.test-backup';",
    "fs.copyFileSync(file, backup);",
    "fs.writeFileSync(file, 'module.exports = { version: String(), documents: [] };');",
    'function restore() { fs.renameSync(backup, file); }',
    'const security = { msgSecCheck: () => Promise.resolve({ errCode: 0 }), imgSecCheck: () => Promise.resolve({ errCode: 0 }) };',
    "const advancementHarness = createHarness({ security, respond: () => openAiTextResponse('不应到达') });",
    "const departmentHarness = createHarness({ security, respond: () => openAiTextResponse('部门回答') });",
    'const advancement = advancementHarness.main({',
    "  action: 'chat', feature: 'advancement-qa', system: '你是升学助手',",
    "  messages: [{ role: 'user', text: '2026年广东普通专升本网上缴费什么时候截止？' }],",
    "  scope: { category: 'ordinary_专升本', year: 2026, region: '广东省' },",
    "  passageIds: ['gd-zsb-2026#fee-deadline'],",
    '});',
    'const department = departmentHarness.main({',
    "  action: 'chat', feature: 'department-qa', system: '你是部门助手',",
    "  messages: [{ role: 'user', text: '校学生会最近有什么动态' }],",
    '});',
    'Promise.all([advancement, department]).then(([a, d]) => {',
    '  restore();',
    '  console.log(JSON.stringify({',
    '    ok: a.ok, failureClass: a.failureClass, detail: a.detail, advancement: a.advancement,',
    '    modelCalls: advancementHarness.http.length, departmentOk: d.ok, departmentAdvancement: d.advancement,',
    '  }));',
    '}).catch((error) => { restore(); console.error(String(error)); process.exitCode = 3; });',
  ].join(String.fromCharCode(10));
  const child = spawnSync(process.execPath, ['-e', script], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout.trim().split(String.fromCharCode(10)).at(-1));
  assert.equal(report.ok, false);
  assert.equal(report.failureClass, 'internal');
  assert.match(report.detail, /升学语料/);
  assert.equal(report.advancement, null);
  assert.equal(report.modelCalls, 0, '没有可信语料时不应发模型请求');
  // fail-closed 只作用于 advancement-qa：部门问答照常可答。
  assert.equal(report.departmentOk, true);
  assert.equal(report.departmentAdvancement, null);
  // 子进程把文件改回来了：这里仍能读到完整语料。
  assert.equal(require(CORPUS_FILE).documents.length, 4);
});

test('语料形状校验：缺字段、空段落、空文档一律判为不可用', () => {
  const { isAdvancementCorpus } = require(path.resolve('dist/cloudfunctions/ai/advancement.js'));
  const valid = {
    version: 'adv-corpus-abcdef012345',
    collectedAt: '2026-09-29',
    documents: [{
      id: 'd', category: 'c', title: 't', documentNumber: '', issuer: 'i', publishedAt: '2026-01-01',
      applicableYear: 2026, applicableRegion: '广东省', applicableAudience: '', sourceUrl: 'https://x', collectedAt: '2026-09-29',
      passages: [{ id: 'p', text: '原文' }],
    }],
  };
  assert.equal(isAdvancementCorpus(valid), true);
  assert.equal(isAdvancementCorpus({ ...valid, version: '' }), false);
  assert.equal(isAdvancementCorpus({ ...valid, documents: [] }), false);
  assert.equal(isAdvancementCorpus({
    ...valid,
    documents: [{ ...valid.documents[0], passages: [{ id: 'p', text: '  ' }] }],
  }), false);
  assert.equal(isAdvancementCorpus({ ...valid, documents: [{ ...valid.documents[0], applicableYear: '2026' }] }), false);
});

// ---------- 其它落点不受影响 ----------

test('部门问答与升学注入互不干扰：department-qa 仍走自己的检索字段', async () => {
  const harness = createHarness({
    security: wechatOk(),
    respond: () => openAiTextResponse('部门回答'),
  });
  const result = await harness.main({
    action: 'chat',
    feature: 'department-qa',
    system: '你是部门助手',
    messages: [{ role: 'user', text: '校学生会最近有什么动态' }],
  });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.advancement, null);
  assert.ok(Array.isArray(result.citations));
});
