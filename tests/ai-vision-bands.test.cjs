/**
 * 课表截图识别的**分带并行**（Ticket 05 的模型环）：预算数学、分带范围、合并过滤、
 * 「内容安全只检一次」与部分失败降级。
 *
 * 与 ai-flow.test.cjs 同一套夹具：跑真实编译产物，只桩掉 https / wx-server-sdk / 数据库。
 * 模型画像来自 docs/evidence/p5-b/README.md「第三轮」的实测拟合，这里的数字是**算预算用**的，
 * 不是对模型性能的重新测量。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, openAiTextResponse, currentMonth } = require('./ai-harness.cjs');

const IMAGE = { base64: 'aGVsbG8=', mimeType: 'image/png' };

function wechatOk() {
  return {
    msgSecCheck: () => Promise.resolve({ errCode: 0 }),
    imgSecCheck: () => Promise.resolve({ errCode: 0 }),
  };
}

/** vm 上下文里的对象原型与主 realm 不同，深比较前先过一遍 JSON（与 ai-flow.test.cjs 同一做法）。 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 从模型请求里读回系统提示词里的节次区间——用来验证「分带指令确实发出去了」。 */
function bandOf(request) {
  const body = JSON.parse(request.body);
  const system = body.messages[0];
  assert.equal(system.role, 'system', '系统提示词应是第一条消息');
  const match = /startSection 在 (\d+) 到 (\d+) 之间/u.exec(String(system.content));
  assert.ok(match !== null, `系统提示词里应有节次区间：${String(system.content).slice(0, 120)}`);
  return { from: Number(match[1]), to: Number(match[2]), body };
}

/** 一带的标准返回：一门本带课 + 一门固定节次的课 + 一门节次识别不出的课。 */
function bandResponse(from, to) {
  return openAiTextResponse(JSON.stringify({
    semester: '2026-2027-1',
    school: '广东岭南职业技术学院',
    problems: ['截图右下角有遮挡'],
    courses: [
      { name: `本带课${from}`, weekday: 1, startSection: from, endSection: to, weekText: '[1-16]周' },
      { name: '越界课', weekday: 2, startSection: 8, endSection: 9, weekText: '[1-16]周' },
      { name: '无节次课', weekday: 3, startSection: 0, endSection: 0, weekText: '' },
    ],
  }));
}

function visionEvent(overrides = {}) {
  return {
    action: 'vision',
    feature: 'timetable-screenshot',
    system: '你是课表截图识别器。只输出 JSON。',
    messages: [{ role: 'user', text: '请识别这张课表截图' }],
    image: IMAGE,
    maxTokens: 2048,
    ...overrides,
  };
}

// ---------- 预算与分带计划（纯函数） ----------

test('分带计划：按节次 1-12 等分，余数给前面几带，带数有上限', () => {
  const { splitSections, MAX_BANDS } = createHarness().load('vision.js');

  assert.deepEqual(plain(splitSections(1)), [{ from: 1, to: 12 }], '一带就是全表');
  assert.deepEqual(plain(splitSections(4)), [
    { from: 1, to: 3 }, { from: 4, to: 6 }, { from: 7, to: 9 }, { from: 10, to: 12 },
  ]);
  assert.deepEqual(plain(splitSections(5)), [
    { from: 1, to: 3 }, { from: 4, to: 6 }, { from: 7, to: 8 }, { from: 9, to: 10 }, { from: 11, to: 12 },
  ], '12 不能被 5 整除时，余数优先给前面的带');
  assert.equal(splitSections(6).length, 6);
  assert.equal(splitSections(99).length, MAX_BANDS, '带数不超过上限');
  assert.deepEqual(plain(splitSections(0)), [{ from: 1, to: 12 }], '非法带数退回一带');

  // 每带都要覆盖到、且不重叠：12 节一节不漏。
  const covered = plain(splitSections(5)).flatMap((band) => {
    const list = [];
    for (let section = band.from; section <= band.to; section += 1) list.push(section);
    return list;
  });
  assert.deepEqual(covered, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test('预算：按实测画像（固定 11 秒 + 86 token/秒 + 每门课 300 token）算带数', () => {
  const { predictSeconds, bandsForBudget, VISION_PROFILE } = createHarness().load('vision.js');

  assert.equal(VISION_PROFILE.fixedSeconds, 11);
  assert.equal(VISION_PROFILE.tokensPerSecond, 86);
  assert.equal(VISION_PROFILE.tokensPerCourse, 300);

  // 一门课：11 + 300/86 ≈ 14.5 秒；45 门课 ≈ 168 秒（正是「一次调用不成立」的那个数）。
  assert.ok(Math.abs(predictSeconds(1) - 14.49) < 0.05, `一门课约 14.5 秒，实际 ${predictSeconds(1)}`);
  assert.ok(predictSeconds(45) > 160, '45 门课外推在 160 秒以上');

  // 40 秒预算：能装 floor(29×86/300)=8 门课 → ceil(45/8)=6 带。
  assert.equal(bandsForBudget(40000).length, 6);
  // 60 秒预算：能装 floor(49×86/300)=14 门 → ceil(45/14)=4 带。
  assert.equal(bandsForBudget(60000).length, 4);
  // 预算连一次调用的固定开销（11 秒）都装不下：退回单带。
  // 装不下的预算切 6 带仍然是 6 次全超时，只是多花 6 倍调用与并发——
  // 默认 AI_TIMEOUT_MS=8000 正好落这一档，而客户端固定下发 'auto'。
  assert.equal(bandsForBudget(1000).length, 1, '预算过小时退回单带，不切到上限');
  assert.equal(bandsForBudget(0).length, 1);
  assert.equal(bandsForBudget(11000).length, 1, '刚好等于固定开销也不够（余量为 0）');
  assert.equal(bandsForBudget(12000).length, 1, '刚过固定开销：perBand=floor(1×86/300)=0，仍退回单带');
});

test('每带输出上限按本带课程数抬高，避免大带被截断', () => {
  const { bandMaxTokens } = createHarness().load('vision.js');

  // 整张表的上限（客户端给的 2048）装不下 8 门课的中位输出（8×300=2400）：
  // 直接沿用会被截断，截断的 JSON 解析不出来，那一带就变成「没有可用结果」。
  assert.ok(bandMaxTokens(6, 2048) > 2048, `6 带（每带 8 门）要抬高上限，实际 ${bandMaxTokens(6, 2048)}`);
  assert.ok(bandMaxTokens(6, 2048) >= 8 * 300, '至少要装得下本带课程的中位输出');
  assert.equal(bandMaxTokens(1, 2048), 2048, '单带不改动调用方给的上限');
  assert.equal(bandMaxTokens(6, 9000), 8192, '超过接口上限时被截到 8192');
  assert.ok(bandMaxTokens(2, 100) > 100, '调用方给的很小也按课程数抬到够用');
  assert.ok(bandMaxTokens(6, 8192) <= 8192, '不超过接口上限');
});

test('bands 字段：auto 按预算算，数字按数量算，缺省与非法值保持单带', () => {
  const { planBands } = createHarness().load('vision.js');

  assert.deepEqual(plain(planBands(undefined, 40000)), [{ from: 1, to: 12 }], '缺省 = 原路径');
  assert.deepEqual(plain(planBands(1, 40000)), [{ from: 1, to: 12 }], '显式 1 = 原路径');
  assert.deepEqual(plain(planBands('banana', 40000)), [{ from: 1, to: 12 }], '非法值不报错，退回单带');
  assert.deepEqual(plain(planBands(0, 40000)), [{ from: 1, to: 12 }]);
  assert.deepEqual(plain(planBands(-3, 40000)), [{ from: 1, to: 12 }], '负数退回单带');
  assert.deepEqual(plain(planBands('4', 40000)), [{ from: 1, to: 12 }], '数字字符串不接受（不猜），退回单带');
  assert.deepEqual(plain(planBands(null, 40000)), [{ from: 1, to: 12 }]);
  assert.equal(planBands(3, 40000).length, 3);
  assert.equal(planBands(3.7, 40000).length, 3, '小数按整数部分');
  assert.equal(planBands('auto', 40000).length, 6);
  assert.equal(planBands('auto', 60000).length, 4);
});

test('分带指令只加范围，不动调用方给的提示词', () => {
  const { bandedSystem, bandInstruction } = createHarness().load('vision.js');

  const system = bandedSystem('你是课表截图识别器。', { from: 4, to: 6 });
  assert.match(system, /你是课表截图识别器。/u, '原提示词要保留');
  assert.match(system, /startSection 在 4 到 6 之间/u);
  assert.match(system, /一律不要放进 courses/u);
  assert.equal(bandedSystem('', { from: 1, to: 3 }), bandInstruction({ from: 1, to: 3 }), '没有系统提示词时只留范围指令');
});

test('合并：按带过滤越界课程，节次未识别的只在第一带保留', () => {
  const { mergeBands } = createHarness().load('vision.js');

  const merged = mergeBands([
    { band: { from: 1, to: 3 }, ok: true, text: JSON.stringify({ courses: [{ name: '本带课1', startSection: 1 }, { name: '越界课', startSection: 8 }, { name: '无节次课', startSection: 0 }] }) },
    { band: { from: 4, to: 6 }, ok: true, text: JSON.stringify({ courses: [{ name: '本带课4', startSection: 4 }, { name: '越界课', startSection: 8 }] }) },
    { band: { from: 7, to: 12 }, ok: true, text: JSON.stringify({ courses: [{ name: '越界课', startSection: 8 }] }) },
  ]);

  const parsed = JSON.parse(merged.text);
  const names = parsed.courses.map((course) => course.name);
  assert.deepEqual(names, ['本带课1', '无节次课', '本带课4', '越界课'], '每门课只出现一次，且按带序排列');
  assert.equal(merged.succeeded, 3);
  assert.deepEqual(plain(merged.failed), []);
});

test('合并：第一带失败时，节次未识别的课程改由第一个**成功**的带保留', () => {
  const { mergeBands } = createHarness().load('vision.js');

  // 第一带调用失败（ok: false）——「只在第一带保留」不能按结果下标判，
  // 否则节次读不出的课会被第一带的失败连带丢掉，而且没有任何提示。
  const merged = mergeBands([
    { band: { from: 1, to: 4 }, ok: false, text: '' },
    { band: { from: 5, to: 8 }, ok: true, text: JSON.stringify({ courses: [{ name: '无节次课', startSection: 0 }, { name: '本带课5', startSection: 5 }] }) },
  ]);

  const parsed = JSON.parse(merged.text);
  const names = parsed.courses.map((course) => course.name);
  assert.ok(names.includes('无节次课'), `无节次的课不该被第一带的失败带走：${JSON.stringify(names)}`);
  assert.ok(names.includes('本带课5'));
  assert.equal(parsed.courses.length, 2, '每门课只留一份');
});

test('合并：轮不到保留的「节次未识别」课程必须计数上报，不静默丢', () => {
  const { mergeBands } = createHarness().load('vision.js');

  const merged = mergeBands([
    { band: { from: 1, to: 4 }, ok: true, text: JSON.stringify({ courses: [{ name: '第一带的无节次课', startSection: 0 }, { name: '本带课1', startSection: 1 }] }) },
    { band: { from: 5, to: 8 }, ok: true, text: JSON.stringify({ courses: [{ name: '第二带的无节次课', startSection: 0 }, { name: '本带课5', startSection: 5 }] }) },
  ]);

  const parsed = JSON.parse(merged.text);
  const names = parsed.courses.map((course) => course.name);
  assert.ok(!names.includes('第二带的无节次课'), '只有第一带保留，避免随带数翻倍');
  assert.ok(
    parsed.problems.some((item) => /有 1 门课的节次没有识别出来/u.test(item)),
    `丢掉的那门必须写进 problems：${JSON.stringify(parsed.problems)}`,
  );

  // 越界丢弃是设计（那门课属于它自己那一带），不该按「丢失」上报。
  const byDesign = mergeBands([
    { band: { from: 1, to: 4 }, ok: true, text: JSON.stringify({ courses: [{ name: '本带课1', startSection: 1 }, { name: '别人的课', startSection: 6 }] }) },
    { band: { from: 5, to: 8 }, ok: true, text: JSON.stringify({ courses: [{ name: '别人的课', startSection: 6 }] }) },
  ]);
  const byDesignNames = JSON.parse(byDesign.text).courses.map((course) => course.name);
  assert.deepEqual(byDesignNames, ['本带课1', '别人的课'], '越界的那门由它自己的带收录，恰好一次');
  assert.ok(
    !JSON.parse(byDesign.text).problems.some((item) => /没有识别出来/u.test(item)),
    '越界不是丢失，不该报「未能收录」',
  );
});

test('合并：problems 去重、学校学期取第一个非空、空带与坏带分别记问题', () => {  const { mergeBands } = createHarness().load('vision.js');

  const merged = mergeBands([
    { band: { from: 1, to: 3 }, ok: true, text: JSON.stringify({ semester: '2026-2027-1', school: '广东岭南职业技术学院', problems: ['截图右下角有遮挡'], courses: [{ name: 'A', startSection: 1 }] }) },
    { band: { from: 4, to: 6 }, ok: true, text: JSON.stringify({ semester: '', school: '', problems: ['截图右下角有遮挡'], courses: [] }) },
    { band: { from: 7, to: 9 }, ok: false, text: '' },
    { band: { from: 10, to: 12 }, ok: true, text: '模型返回了一段解释，没有 JSON' },
  ]);

  const parsed = JSON.parse(merged.text);
  assert.equal(parsed.semester, '2026-2027-1');
  assert.equal(parsed.school, '广东岭南职业技术学院');
  assert.deepEqual(
    parsed.problems.filter((item) => item === '截图右下角有遮挡'),
    ['截图右下角有遮挡'],
    '模型自己报的问题去重后只留一条',
  );
  assert.ok(
    parsed.problems.some((item) => /第 4-6 节没有识别出课程/u.test(item)),
    `空数组要说明这一段确实没课（同一原因的多带合成一条）：${JSON.stringify(parsed.problems)}`,
  );
  assert.ok(parsed.problems.some((item) => /第 7-9 节/u.test(item)), '调用失败的带要写明');
  assert.ok(parsed.problems.some((item) => /第 10-12 节/u.test(item)), '返回非 JSON 的带也要写明');
  assert.equal(merged.succeeded, 2, '空数组算成功，失败与坏 JSON 不算');
  assert.deepEqual(plain(merged.failed), [{ from: 7, to: 9 }, { from: 10, to: 12 }]);
});

test('模型输出裹在代码块或解释里也能取到 JSON', () => {
  const { extractJsonObject } = createHarness().load('vision.js');

  assert.deepEqual(plain(extractJsonObject('{"courses":[]}')), { courses: [] });
  assert.deepEqual(plain(extractJsonObject('```json\n{"courses":[{"name":"A"}]}\n```')), { courses: [{ name: 'A' }] });
  assert.deepEqual(plain(extractJsonObject('识别结果如下：{"courses":[]} 以上。')), { courses: [] });
  assert.equal(extractJsonObject('完全没有 JSON'), null);
  assert.equal(extractJsonObject('[1,2,3]'), null, '数组不是本函数的返回形状');
  assert.equal(extractJsonObject(''), null);
});

// ---------- 端到端（真实入口，只桩网络） ----------

test('分带识别：4 带并行调用，图片只上传/只过内容安全一次，用量累加', async () => {
  const seen = [];
  const harness = createHarness({
    security: wechatOk(),
    respond: (request) => {
      const band = bandOf(request);
      seen.push(band);
      return bandResponse(band.from, band.to);
    },
  });

  const result = await harness.main(visionEvent({ bands: 4 }));
  assert.equal(result.ok, true, `应成功：${result.message}`);

  assert.equal(seen.length, 4, '4 带 = 4 次模型调用');
  assert.deepEqual(seen.map((band) => `${band.from}-${band.to}`), ['1-3', '4-6', '7-9', '10-12']);
  for (const band of seen) {
    assert.match(JSON.stringify(band.body.messages), /data:image\/png;base64,aGVsbG8=/u, '每一带都要带上图片');
    // 客户端按整张表给的 2048 装不下「本带课程数 × 每门课完成 token」，沿用会被截断，
    // 而截断的 JSON 看起来像模型失败——所以分带时服务端要把上限抬起来。
    assert.ok(
      typeof band.body.max_tokens === 'number' && band.body.max_tokens > 2048,
      `分带的每带输出上限要按课程数抬高，实际 ${JSON.stringify(band.body.max_tokens)}`,
    );
  }

  // 内容安全的配额是硬约束：分带不能让图片检测次数按带数翻倍。
  assert.equal(harness.cloud.imgSecCheck.length, 1, '图片只过一次 imgSecCheck');
  assert.equal(harness.cloud.msgSecCheck.length, 2, '输入文字与合并后的输出各一次');

  const parsed = JSON.parse(result.text);
  assert.deepEqual(Object.keys(parsed).sort(), ['courses', 'problems', 'school', 'semester'], '形状与单次识别一致');
  const byName = new Map();
  for (const course of parsed.courses) byName.set(course.name, (byName.get(course.name) || 0) + 1);
  assert.equal(byName.get('本带课1'), 1);
  assert.equal(byName.get('越界课'), 1, '固定节次的课只保留在包含它的那一带');
  assert.equal(byName.get('无节次课'), 1, '节次未识别的课只在第一带保留');
  assert.equal(parsed.courses.length, 4 + 2, '4 门本带课 + 越界课 + 无节次课');

  // 用量是 4 次子调用的合计：每次 30 token / 0.00006 元。
  assert.equal(result.usage.totalTokens, 120);
  assert.equal(result.usage.costYuan, 0.00024);
  assert.equal(result.usage.estimated, false);
  const models = harness.records.filter((row) => row.kind === 'model');
  assert.equal(models.length, 4, '每次子调用一条模型记录');
  assert.equal(models[0].requestId, models[3].requestId, '同一次请求的子调用共用 requestId');
});

test('不分带时行为与 Ticket 01 验收时一致：一次模型调用', async () => {
  const harness = createHarness({
    security: wechatOk(),
    respond: (request) => {
      const body = JSON.parse(request.body);
      assert.equal(body.messages[0].role, 'system');
      assert.doesNotMatch(String(body.messages[0].content), /startSection 在/u, '单带不该出现分带指令');
      return bandResponse(1, 12);
    },
  });

  const result = await harness.main(visionEvent());
  assert.equal(result.ok, true, `应成功：${result.message}`);
  assert.equal(harness.http.length, 1, '单带只有一次模型调用');
  assert.equal(harness.cloud.imgSecCheck.length, 1);
});

test("bands: 'auto' 按云函数自身的超时预算算带数；预算过小退回单带", async () => {
  // 默认（总截止 15 秒、单次 8 秒）：预算连一次调用的固定开销（11 秒）都装不下 →
  // 退回单带。切 6 带也是 6 次全超时，只是多花 6 倍调用。
  const small = createHarness({
    security: wechatOk(),
    respond: (request) => {
      const body = JSON.parse(request.body);
      assert.doesNotMatch(String(body.messages[0].content), /startSection 在/u, '小预算不该出现分带指令');
      return bandResponse(1, 12);
    },
  });
  const smallResult = await small.main(visionEvent({ bands: 'auto' }));
  assert.equal(smallResult.ok, true, `应成功：${smallResult.message}`);
  assert.equal(small.http.length, 1, '预算装不下固定开销时只发一次调用');

  // 总截止 60 秒、单次 60 秒：每带装 13 门 → ceil(45/13) = 4 带。
  const large = createHarness({
    env: { AI_TOTAL_DEADLINE_MS: '60000', AI_TIMEOUT_MS: '60000' },
    security: wechatOk(),
    respond: (request) => {
      const band = bandOf(request);
      return bandResponse(band.from, band.to);
    },
  });
  const largeResult = await large.main(visionEvent({ bands: 'auto' }));
  assert.equal(largeResult.ok, true, `应成功：${largeResult.message}`);
  assert.equal(large.http.length, 4, '大预算少切几带');
});

test('一带失败不丢掉其余带：成功带照常返回，失败带写进 problems 与告警', async () => {
  const harness = createHarness({
    security: wechatOk(),
    respond: (request) => {
      const band = bandOf(request);
      if (band.from === 7) return { status: 500, body: 'upstream exploded' };
      return bandResponse(band.from, band.to);
    },
  });

  const result = await harness.main(visionEvent({ bands: 4 }));
  assert.equal(result.ok, true, `部分失败仍应返回草稿：${result.message}`);

  const parsed = JSON.parse(result.text);
  const names = parsed.courses.map((course) => course.name);
  assert.ok(names.includes('本带课1'), '成功带的结果要在');
  assert.ok(names.includes('本带课4'), '成功带的结果要在');
  assert.ok(!names.includes('本带课7'), '失败带没有结果');
  assert.ok(parsed.problems.some((item) => /第 7-9 节/u.test(item)), `problems 要写明失败带：${JSON.stringify(parsed.problems)}`);
  assert.ok(result.warnings.some((item) => /第 7-9 节这一段识别失败/u.test(item)), `告警要写明失败带：${JSON.stringify(result.warnings)}`);
  assert.ok(result.warnings.some((item) => /没有可用识别结果的节次：7-9/u.test(item)), '汇总告警要列出缺失节次');
});

test('各带全部失败时按失败分类返回，而不是空草稿', async () => {
  const harness = createHarness({
    security: wechatOk(),
    respond: () => ({ status: 503, body: 'relay down' }),
  });

  const result = await harness.main(visionEvent({ bands: 3 }));
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'model_unavailable');
  assert.equal(harness.http.length, 3, '每一带都试过');
  assert.equal(result.text, '');
  assert.equal(result.usage, null, '没有成功的模型调用就没有用量，不记 0 元');
});

test('分带也要走成本上限：超上限时不发任何模型请求', async () => {
  const harness = createHarness({
    env: { AI_MONTHLY_CAP_YUAN: '0.000001' },
    security: wechatOk(),
    respond: (request) => {
      const band = bandOf(request);
      return bandResponse(band.from, band.to);
    },
    monthly: {
      // 当月已用满：上限判定读 ai_usage_monthly，这里预置一份超限的累计。
      [currentMonth()]: { calls: 1, costYuan: 100, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    },
  });

  const result = await harness.main(visionEvent({ bands: 4 }));
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'quota_exhausted');
  assert.equal(harness.http.length, 0, '超上限时一次模型请求都不该发');
});

test('合并：多带都没课时只写一条提示，不按带刷屏', () => {
  const { mergeBands } = createHarness().load('vision.js');

  const merged = mergeBands([
    { band: { from: 1, to: 2 }, ok: true, text: JSON.stringify({ courses: [{ name: '本带课1', startSection: 1 }] }) },
    { band: { from: 3, to: 4 }, ok: true, text: JSON.stringify({ courses: [] }) },
    { band: { from: 5, to: 6 }, ok: true, text: JSON.stringify({ courses: [] }) },
    { band: { from: 7, to: 8 }, ok: true, text: JSON.stringify({ courses: [] }) },
  ]);

  const parsed = JSON.parse(merged.text);
  const empty = parsed.problems.filter((item) => /没有识别出课程/u.test(item));
  assert.equal(empty.length, 1, `同一原因的多带要合成一条：${JSON.stringify(parsed.problems)}`);
  assert.match(empty[0], /第 3-4 节、第 5-6 节、第 7-8 节/u, `要列出是哪几节：${empty[0]}`);
});
