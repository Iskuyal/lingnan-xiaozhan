/**
 * AI 云函数入口测试（Ticket 01）：三类失败、成本上限、用量记账、图片先检后送、探测动作。
 *
 * 运行真实编译产物与真实入口，只桩掉 https / wx-server-sdk / 数据库：
 * 不访问网络、不需要密钥、不接触云端。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createHarness, openAiTextResponse, currentMonth } = require('./ai-harness.cjs');

const KEY = 'test-key-000000000000';
const IMAGE = { base64: 'aGVsbG8=', mimeType: 'image/png' };
const PHOTO_OWNER = 'photo-owner-openid';
const PHOTO_OWNER_HASH = crypto.createHash('sha256').update(PHOTO_OWNER).digest('hex').slice(0, 16);
const SCREENSHOT = { fileID: `cloud://example.bucket/timetable-imports/${PHOTO_OWNER_HASH}/mtest-12345678.png` };

function wechatOk(overrides = {}) {
  return {
    msgSecCheck: () => Promise.resolve({ errCode: 0 }),
    imgSecCheck: () => Promise.resolve({ errCode: 0 }),
    ...overrides,
  };
}

function chatEvent(overrides = {}) {
  return {
    action: 'chat',
    feature: 'timetable-assistant',
    system: '你是课表助手',
    messages: [{ role: 'user', text: '第三节有课吗' }],
    ...overrides,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------- 正常链路与记账 ----------

test('成功链路：输入检测 → 模型 → 输出检测，并记录耗时、token 与金额', async () => {
  const harness = createHarness({
    security: wechatOk(),
    respond: (request) => {
      assert.ok(request.url.endsWith('/chat/completions'));
      return openAiTextResponse('第三节没有课。', { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });
    },
  });
  const result = await harness.main(chatEvent());
  assert.equal(result.ok, true, `应成功：${result.message}`);
  assert.equal(result.text, '第三节没有课。');
  assert.equal(result.failureClass, '');
  assert.equal(result.message, '', '成功时没有用户提示文案');
  assert.equal(result.provider, 'openai');
  assert.equal(result.model, 'test-model');
  // 单价 1 元 / 4 元每百万 token：20*1/1e6 + 10*4/1e6 = 0.00006 元
  assert.equal(result.usage.costYuan, 0.00006);
  assert.equal(result.usage.estimated, false);

  // 三次检测/调用：输入文字检测、模型调用、输出文字检测。
  assert.equal(harness.cloud.msgSecCheck.length, 2, '输入与输出各检一次');
  assert.equal(harness.records.length, 3, '每次子调用一条记录');
  const model = harness.records.find((row) => row.kind === 'model');
  assert.ok(model !== undefined, '应有模型调用记录');
  assert.equal(model.ok, true);
  assert.equal(model.totalTokens, 30);
  assert.equal(model.feature, 'timetable-assistant');
  assert.ok(model.durationMs >= 0);
  assert.equal(harness.monthly[currentMonth()].calls, 3, '月度汇总按子调用累加');
  assert.equal(harness.monthly[currentMonth()].totalTokens, 30);
  assert.equal(harness.monthly[currentMonth()].costYuan, 0.00006);
});

test('调用记录字段与云函数声明的契约一致（避免字段悄悄改名）', async () => {
  const harness = createHarness({
    security: wechatOk(),
    respond: () => openAiTextResponse('好'),
  });
  await harness.main(chatEvent());
  const usage = harness.load('usage.js');
  const expected = plain(usage.USAGE_RECORD_FIELDS).slice().sort();
  for (const record of harness.records) {
    assert.deepEqual(Object.keys(record).filter((key) => key !== '_id').sort(), expected, '记录字段应与契约一致');
  }
  const monthDoc = harness.monthly[currentMonth()];
  assert.deepEqual(
    Object.keys(monthDoc).filter((key) => key !== '_id').sort(),
    plain(usage.USAGE_MONTH_FIELDS).slice().sort(),
    '月度汇总字段应与契约一致',
  );
});

test('服务端不给 usage 时按估算记账，避免成本被系统性低估', async () => {
  const harness = createHarness({
    security: wechatOk(),
    respond: () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: '没有用量字段的回答' } }] }) }),
  });
  const result = await harness.main(chatEvent());
  assert.equal(result.ok, true);
  assert.equal(result.usage.estimated, true);
  assert.ok(result.usage.totalTokens > 0, '估算的 token 必须大于 0');
  assert.ok(result.usage.costYuan > 0, '估算同样要计金额');
  const model = harness.records.find((row) => row.kind === 'model');
  assert.equal(model.estimated, true);
});

// ---------- 三类失败 ----------

test('三类失败可区分：模型不可用 / 内容被拒 / 额度用尽，文案各自独立', async () => {
  const modelDown = createHarness({
    security: wechatOk(),
    respond: () => ({ status: 503, body: 'relay down' }),
  });
  const modelResult = await modelDown.main(chatEvent());

  const rejected = createHarness({
    security: wechatOk({ msgSecCheck: () => Promise.resolve({ errCode: 0, result: { suggest: 'risky' } }) }),
    respond: () => openAiTextResponse('不该被调用'),
  });
  const rejectedResult = await rejected.main(chatEvent());

  const monthly = { [currentMonth()]: { month: currentMonth(), calls: 1, costYuan: 50, failures: 0 } };
  const overQuota = createHarness({ security: wechatOk(), monthly, respond: () => openAiTextResponse('不该被调用') });
  const quotaResult = await overQuota.main(chatEvent());
  const usageResult = await overQuota.main({ action: 'usage' });

  assert.equal(modelResult.failureClass, 'model_unavailable');
  assert.equal(rejectedResult.failureClass, 'content_rejected');
  assert.equal(quotaResult.failureClass, 'quota_exhausted');
  assert.equal(modelResult.ok, false);
  assert.equal(rejectedResult.ok, false);
  assert.equal(quotaResult.ok, false);
  assert.ok(usageResult.ok === true, '查用量不受上限影响');
  assert.equal(usageResult.failureClass, '');

  const messages = [modelResult.message, rejectedResult.message, quotaResult.message];
  assert.equal(new Set(messages).size, 3, `三类文案必须各不相同：${messages.join('｜')}`);
  for (const message of messages) {
    assert.ok(typeof message === 'string' && message.length > 0, '每类失败都要有用户可见文案');
  }
  assert.ok(modelResult.message.includes('模型'), '模型类文案要点明模型问题');
  assert.ok(rejectedResult.message.includes('安全检测'), '内容类文案要点明安全检测');
  assert.ok(quotaResult.message.includes('额度'), '额度类文案要点明额度');
  assert.ok(rejectedResult.message !== `${modelResult.message}${quotaResult.message}`, '不得把三类合并成一句');
});

test('内容违规时不调用模型：输入被拒即中止（先检后送）', async () => {
  const harness = createHarness({
    security: wechatOk({ msgSecCheck: () => Promise.resolve({ errCode: 87014, errMsg: 'risky' }) }),
    respond: () => openAiTextResponse('不该被调用'),
  });
  const result = await harness.main(chatEvent());
  assert.equal(result.failureClass, 'content_rejected');
  assert.equal(harness.http.length, 0, '输入违规时不应发起任何模型请求');
  assert.ok(result.detail.includes('87014'), '细节保留微信判定码');
});

test('模型输出违规时同样判为内容被拒（输入已通过）', async () => {
  let call = 0;
  const harness = createHarness({
    security: wechatOk({
      msgSecCheck: () => {
        call += 1;
        return Promise.resolve(call === 1 ? { errCode: 0 } : { errCode: 0, result: { suggest: 'risky' } });
      },
    }),
    respond: () => openAiTextResponse('模型生成的违规文本'),
  });
  const result = await harness.main(chatEvent());
  assert.equal(result.failureClass, 'content_rejected');
  assert.equal(harness.cloud.msgSecCheck.length, 2, '输入与输出都要检测');
});

test('中转不可用（网络错误）时调用方拿到可处理的错误，不是未捕获异常', async () => {
  const harness = createHarness({
    security: wechatOk(),
    respond: () => ({ error: new Error('ECONNREFUSED') }),
  });
  let thrown = null;
  let result = null;
  try {
    result = await harness.main(chatEvent());
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown, null, '入口不允许抛异常');
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'model_unavailable');
  assert.ok(result.detail.includes('ECONNREFUSED'));
});

test('模型返回空内容时给出可重试失败，并记录模型失败以便排查', async () => {
  const harness = createHarness({
    security: wechatOk(),
    respond: () => openAiTextResponse(''),
  });
  const result = await harness.main(chatEvent());

  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'model_unavailable');
  assert.match(result.message, /稍后|重试/u, '用户文案应说明稍后可以再试');
  assert.match(result.detail, /内容为空/u, '细节应保留空响应原因');
  const failed = harness.records.filter((record) => record.kind === 'model' && record.ok === false);
  assert.equal(failed.length, 1, '空响应应留下一条模型失败记录');
  assert.equal(failed[0].failureClass, 'model_unavailable');
  assert.equal(harness.monthly[currentMonth()].failures, 1, '失败计数应进入月度用量汇总');
});

test('中转不响应时在超时边界内返回「模型不可用或超时」，不无限挂起', async () => {
  const harness = createHarness({
    env: { AI_TIMEOUT_MS: '1000' },
    security: wechatOk(),
    respond: () => undefined, // 永不响应
  });
  const startedAt = Date.now();
  const result = await harness.main(chatEvent());
  const elapsed = Date.now() - startedAt;
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'model_unavailable');
  assert.ok(result.detail.includes('超时'), `细节应写明超时：${result.detail}`);
  assert.ok(elapsed < 4000, `应在边界内结束，实际 ${elapsed}ms`);
});

test('密钥不出现在返回值里（中转回显请求头也不泄露）', async () => {
  const harness = createHarness({
    security: wechatOk(),
    respond: () => ({ status: 500, body: `relay error, Authorization: Bearer ${KEY}` }),
  });
  const result = await harness.main(chatEvent());
  assert.equal(result.ok, false);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(KEY), '返回值里不得出现密钥');
  assert.ok(result.detail.includes('***'), '被回显的密钥应替换成掩码');
});

// ---------- 成本上限 ----------

test('月度上限来自环境变量：接近阈值告警但不拦，达到上限拒绝调用', async () => {
  const month = currentMonth();
  const warnHarness = createHarness({
    env: { AI_MONTHLY_CAP_YUAN: '1', AI_CAP_WARN_RATIO: '0.8' },
    security: wechatOk(),
    monthly: { [month]: { month, calls: 3, costYuan: 0.9, failures: 0 } },
    respond: () => openAiTextResponse('正常回答'),
  });
  const warned = await warnHarness.main(chatEvent());
  assert.equal(warned.ok, true, '接近阈值只告警，不拒绝');
  assert.ok(warned.capWarning.includes('0.9'), `告警文案要含当前成本：${warned.capWarning}`);
  assert.ok(warned.capWarning.includes('1'), '告警文案要含上限');
  assert.equal(warned.usageSummary.capYuan, 1, '上限来自环境变量');
  assert.equal(warned.usageSummary.warn, true, '记账后仍在告警区间：warn 为真');

  const blockedHarness = createHarness({
    env: { AI_MONTHLY_CAP_YUAN: '1' },
    security: wechatOk(),
    monthly: { [month]: { month, calls: 3, costYuan: 1, failures: 0 } },
    respond: () => openAiTextResponse('不该被调用'),
  });
  const blocked = await blockedHarness.main(chatEvent());
  assert.equal(blocked.failureClass, 'quota_exhausted');
  assert.equal(blockedHarness.http.length, 0, '超上限时不发起模型请求');
  assert.equal(blockedHarness.cloud.msgSecCheck.length, 0, '超上限时连内容检测都不做');
  assert.equal(blocked.usageSummary.costYuan, 1, '失败返回里保留当月累计，便于判断原因');
});

test('月度上限默认 50 元，查询接口给出上限、告警线与当前累计', async () => {
  const month = currentMonth();
  const harness = createHarness({
    security: wechatOk(),
    monthly: { [month]: { month, calls: 12, failures: 1, costYuan: 41.5, totalTokens: 1234 } },
  });
  const result = await harness.main({ action: 'usage' });
  assert.equal(result.ok, true);
  assert.equal(result.usageSummary.capYuan, 50, '默认上限 50 元');
  assert.equal(result.usageSummary.costYuan, 41.5);
  assert.equal(result.usageSummary.warnThresholdYuan, 40, '告警线 = 上限 × 0.8');
  assert.equal(result.usageSummary.warn, true);
  assert.equal(result.usageSummary.exceeded, false);
  assert.equal(result.message, '', 'message 的契约是「成功时为空串」，成功查用量不塞文案');
  assert.ok(result.capWarning.includes('41.5'), `告警走 capWarning 字段：${result.capWarning}`);
});

test('用量查询不可降级为零：数据库读失败时拒绝调用（fail closed）', async () => {
  const harness = createHarness({
    security: wechatOk(),
    monthlyReadError: new Error('network timeout'),
    respond: () => openAiTextResponse('不该被调用'),
  });
  const usage = await harness.main({ action: 'usage' });
  assert.equal(usage.ok, false);
  assert.equal(usage.failureClass, 'internal', '读不到用量时不能假装为零');
  assert.ok(usage.detail.includes('network timeout'));

  const chat = await harness.main(chatEvent());
  assert.equal(chat.failureClass, 'internal');
  assert.equal(harness.http.length, 0, '无法判断上限时不发起模型请求');
  // 只有「文档不存在」才算空汇总（当月首次调用）。
  const usageModule = harness.load('usage.js');
  assert.equal(usageModule.isMissingDocumentError(new Error('document.get:fail document does not exist')), true);
  assert.equal(usageModule.isMissingDocumentError(new Error('network timeout')), false);
});

// ---------- 月度累加的写入安全（Ticket 01 复核修复） ----------

/** 直接调 usage.recordSubCall 用的记录夹具（与云函数内部构造的形状一致）。 */
function subCallRecord(overrides = {}) {
  return {
    requestId: 'request-1',
    feature: 'timetable-assistant',
    action: 'chat',
    kind: 'model',
    provider: 'openai',
    model: 'test-model',
    ok: true,
    failureClass: '',
    durationMs: 12,
    usage: {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      estimated: false,
      usageUnknown: false,
      costYuan: 0.001,
      priceInputPerMillion: 1,
      priceOutputPerMillion: 4,
    },
    ...overrides,
  };
}

async function recordDirect(harness, record) {
  const usage = harness.load('usage.js');
  const config = harness.load('config.js').loadConfig(harness.env);
  await usage.recordSubCall(harness.db, record, config, new Date());
  return usage;
}

test('月度累加：update 失败不覆盖累计，只记为「可处理的记账失败」', async () => {
  const month = currentMonth();
  const seeded = { month, calls: 7, failures: 1, promptTokens: 900, completionTokens: 100, totalTokens: 1000, costYuan: 12.5, updatedAt: '2026-09-01T00:00:00.000Z' };
  // 写失败不是「文档不存在」：以前会被 catch 吞掉再 set，把 12.5 元覆盖成单次调用的数字。
  const harness = createHarness({
    security: wechatOk(),
    monthly: { [month]: { ...seeded } },
    monthlyUpdateError: new Error('collection.update:fail network timeout'),
    respond: () => openAiTextResponse('正常回答'),
  });
  const result = await harness.main(chatEvent());
  assert.equal(result.ok, true, '记账失败不推翻已经完成的模型调用');
  const doc = harness.monthly[month];
  assert.equal(doc.calls, 7, `累计调用次数必须原样保留：${doc.calls}`);
  assert.equal(doc.costYuan, 12.5, `累计金额必须原样保留：${doc.costYuan}`);
  assert.equal(doc.totalTokens, 1000, '累计 token 必须原样保留');
  assert.ok(
    result.warnings.some((warning) => warning.includes('用量记账失败')),
    `记账失败要在返回值里告警：${result.warnings.join('｜')}`,
  );
  assert.ok(result.warnings.some((warning) => warning.includes('network timeout')), '告警要带上原因');
  assert.ok(result.usage !== null, '本次主调用的用量仍然如实返回');
});

test('有调用记录未进入月度汇总时，下一次 AI 请求在模型调用前被挡住', async () => {
  const month = currentMonth();
  const harness = createHarness({
    security: wechatOk(),
    monthly: { [month]: { month, calls: 0, failures: 0, costYuan: 0 } },
    monthlyUpdateError: new Error('collection.update:fail network timeout'),
    respond: () => openAiTextResponse('正常回答'),
  });
  const first = await harness.main(chatEvent());
  assert.equal(first.ok, true, '第一次模型调用已发生，不能把它撤销');
  assert.equal(harness.monthly[month].calls, 0);
  const requestsBeforeRetry = harness.http.length;

  const second = await harness.main(chatEvent());
  assert.equal(second.ok, false, '用量账目不一致时必须暂停后续调用');
  assert.match(second.detail, /调用记录|月度汇总/u);
  assert.equal(harness.http.length, requestsBeforeRetry, '不得再发模型请求');
});

test('月度累加：确认文档不存在时才首次插入，用固定 _id 建文档', async () => {
  const month = currentMonth();
  const harness = createHarness({ security: wechatOk(), respond: () => openAiTextResponse('好') });
  const usage = await recordDirect(harness, subCallRecord());
  const doc = harness.monthly[month];
  assert.ok(doc !== undefined, '首次调用要建出当月文档');
  assert.equal(doc._id, month, '用月份作 _id：并发时靠唯一键保证只建一次');
  assert.equal(doc.calls, 1);
  assert.equal(doc.costYuan, 0.001);
  assert.deepEqual(
    Object.keys(doc).filter((key) => key !== '_id').sort(),
    JSON.parse(JSON.stringify(usage.USAGE_MONTH_FIELDS)).sort(),
    '首次插入的字段要与契约一致',
  );

  // 第二次调用走原子自增，累加而不是覆盖。
  await recordDirect(harness, subCallRecord({ requestId: 'request-2' }));
  assert.equal(harness.monthly[month].calls, 2);
  assert.equal(harness.monthly[month].costYuan, 0.002);
});

test('月度累加：并发两次调用不丢计数（各自 set 一份的竞态已消除）', async () => {
  const month = currentMonth();
  const harness = createHarness({ security: wechatOk() });
  await Promise.all([
    recordDirect(harness, subCallRecord({ requestId: 'concurrent-1' })),
    recordDirect(harness, subCallRecord({ requestId: 'concurrent-2' })),
  ]);
  assert.equal(harness.monthly[month].calls, 2, '两次并发调用都要计入');
  assert.equal(Math.round(harness.monthly[month].costYuan * 1e6), 2000, '两次金额都要计入');
  assert.equal(harness.records.length, 2, '两次子调用各留一条记录');
});

test('月度累加：SDK 不回 updated 计数时读一次确认，不拿「读不到计数」当理由覆盖', async () => {
  const month = currentMonth();
  const seeded = { month, calls: 4, failures: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costYuan: 3, updatedAt: '2026-09-01T00:00:00.000Z' };
  const harness = createHarness({ security: wechatOk(), monthly: { [month]: { ...seeded } }, monthlyUpdateShape: 'none' });
  await recordDirect(harness, subCallRecord());
  assert.equal(harness.monthly[month].calls, 5, '文档存在时按自增累加');
  assert.equal(Math.round(harness.monthly[month].costYuan * 1e6), 3001000, '金额累加而不是覆盖');
});

test('月度累加：SDK 把缺失文档解析成 updated: 0 时，仍然会初始化当月文档', async () => {
  const month = currentMonth();
  const harness = createHarness({ security: wechatOk(), monthlyUpdateMissing: 'zero' });
  await recordDirect(harness, subCallRecord());
  assert.equal(harness.monthly[month].calls, 1, '缺计数不等于「不累加」：确认缺失后要初始化');
  assert.equal(harness.monthly[month].costYuan, 0.001);
});

// ---------- 外部调用的硬超时 ----------

test('微信内容安全调用不响应时在超时边界内返回可识别失败，不无限挂起', async () => {
  const harness = createHarness({
    env: { AI_SAFETY_TIMEOUT_MS: '1000' },
    security: wechatOk({ msgSecCheck: () => new Promise(() => {}) }), // 永不返回
    respond: () => openAiTextResponse('不该被调用'),
  });
  const startedAt = Date.now();
  const result = await harness.main(chatEvent());
  const elapsed = Date.now() - startedAt;
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'model_unavailable', '检测超时与模型超时同一分类（可重试）');
  assert.ok(result.detail.includes('超时'), `细节要写明超时：${result.detail}`);
  assert.ok(elapsed < 4000, `应在超时边界内结束，实际 ${elapsed}ms`);
  assert.equal(harness.http.length, 0, '检测没做完不得送模型');
});

test('云存储下载不响应时同样有硬超时：vision 不会无限挂起', async () => {
  const harness = createHarness({
    openid: PHOTO_OWNER,
    env: { AI_DOWNLOAD_TIMEOUT_MS: '1000' },
    security: wechatOk(),
    downloadFile: () => new Promise(() => {}), // 永不返回
    respond: () => openAiTextResponse('不该被调用'),
  });
  const startedAt = Date.now();
  const result = await harness.main({
    action: 'vision',
    feature: 'timetable-screenshot',
    messages: [{ role: 'user', text: '识别一下' }],
    image: SCREENSHOT,
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'model_unavailable');
  assert.ok(result.detail.includes('超时'), `细节要写明超时：${result.detail}`);
  assert.ok(result.detail.includes('AI_DOWNLOAD_TIMEOUT_MS'), '细节要指出可配置项');
  assert.ok(elapsed < 4000, `应在超时边界内结束，实际 ${elapsed}ms`);
  assert.equal(harness.http.length, 0);
});

test('探测动作也不会挂起：接口不响应时按「调用超时」记录结论', async () => {
  const harness = createHarness({
    security: wechatOk({ msgSecCheck: () => new Promise(() => {}) }),
  });
  const probe = harness.load('probe.js');
  const startedAt = Date.now();
  const result = await probe.runProbe({ wechat: { msgSecCheck: () => new Promise(() => {}), imgSecCheck: () => new Promise(() => {}) }, timeoutMs: 100 });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.ok, false);
  assert.ok(elapsed < 2000, `探测应在超时边界内结束，实际 ${elapsed}ms`);
  const text = result.record.checks.find((check) => check.api === 'security.msgSecCheck');
  assert.equal(text.verdict, 'error');
  assert.ok(text.errMsg.includes('超时'), `记录要写明超时：${text.errMsg}`);
  assert.ok(text.note.includes('超时'), `备注要写明超时：${text.note}`);
});

// ---------- 图片与多模态 ----------

test('vision：图片先过内容安全再送模型，图片以 base64 分块进请求', async () => {
  const harness = createHarness({
    security: wechatOk(),
    respond: (request) => {
      const body = JSON.parse(request.body);
      const userMessage = body.messages[body.messages.length - 1];
      assert.ok(JSON.stringify(userMessage).includes('data:image/png;base64,aGVsbG8='), '图片进模型请求');
      return openAiTextResponse('识别结果：周一 1-2 节 高等数学');
    },
  });
  const result = await harness.main({
    action: 'vision',
    feature: 'timetable-screenshot',
    messages: [{ role: 'user', text: '请识别这张课表截图' }],
    image: IMAGE,
  });
  assert.equal(result.ok, true, `应成功：${result.message}`);
  assert.equal(harness.cloud.imgSecCheck.length, 1, '图片必须过 imgSecCheck');
  assert.equal(harness.cloud.msgSecCheck.length, 2, '用户文字与模型输出仍要过文字检测');
  assert.equal(harness.http.length, 1);
  assert.equal(result.usage.estimated, false);
});

test('vision：图片被拒时不调用模型，返回内容被拒', async () => {
  const harness = createHarness({
    security: wechatOk({ imgSecCheck: () => Promise.reject({ errCode: 87014, errMsg: 'img risky' }) }),
    respond: () => openAiTextResponse('不该被调用'),
  });
  const result = await harness.main({
    action: 'vision',
    messages: [{ role: 'user', text: '识别一下' }],
    image: IMAGE,
  });
  assert.equal(result.failureClass, 'content_rejected');
  assert.equal(harness.http.length, 0, '图片被拒后不得调用模型');
});

test('内容被拒的文案按输入类型区分：图片说「换一张」，文字说「修改后重试」', async () => {
  // 同一类失败（content_rejected），图片与文字的默认文案必须各自成句。
  const imageHarness = createHarness({
    security: wechatOk({ imgSecCheck: () => Promise.reject({ errCode: 87014, errMsg: 'img risky' }) }),
    respond: () => openAiTextResponse('不该被调用'),
  });
  const imageRejected = await imageHarness.main({
    action: 'vision',
    messages: [{ role: 'user', text: '识别一下' }],
    image: IMAGE,
  });
  assert.equal(imageRejected.failureClass, 'content_rejected');
  assert.match(imageRejected.message, /图片/u);
  assert.match(imageRejected.message, /换一张/u);
  assert.doesNotMatch(imageRejected.message, /修改后重试/u, '图片没有「修改」的余地');

  const textHarness = createHarness({
    security: wechatOk({ msgSecCheck: () => Promise.resolve({ errCode: 87014, errMsg: 'risky' }) }),
    respond: () => openAiTextResponse('不该被调用'),
  });
  const textRejected = await textHarness.main(chatEvent());
  assert.equal(textRejected.failureClass, 'content_rejected');
  assert.match(textRejected.message, /修改后重试/u);
  assert.notEqual(textRejected.message, imageRejected.message, '两种输入的文案不得合并成一句');

  // moderateImage 动作同样走图片文案。
  const moderateHarness = createHarness({
    security: wechatOk({ imgSecCheck: () => Promise.reject({ errCode: 87014, errMsg: 'img risky' }) }),
    respond: () => openAiTextResponse('不该被调用'),
  });
  const moderateRejected = await moderateHarness.main({ action: 'moderateImage', image: IMAGE });
  assert.equal(moderateRejected.failureClass, 'content_rejected');
  assert.match(moderateRejected.message, /换一张/u);

  // 图片专属文案可被环境变量覆盖（改措辞不用改代码）。
  const overridden = createHarness({
    env: { AI_MSG_CONTENT_REJECTED_IMAGE: '这张图不行，请换一张（测试覆盖）' },
    security: wechatOk({ imgSecCheck: () => Promise.reject({ errCode: 87014 }) }),
    respond: () => openAiTextResponse('不该被调用'),
  });
  const overriddenResult = await overridden.main({
    action: 'vision',
    messages: [{ role: 'user', text: '识别一下' }],
    image: IMAGE,
  });
  assert.equal(overriddenResult.message, '这张图不行，请换一张（测试覆盖）');
});

test('vision 支持云存储 fileID，并按扩展名推断图片格式', async () => {
  const harness = createHarness({
    openid: PHOTO_OWNER,
    security: wechatOk(),
    downloadFile: (params) => {
      assert.equal(params.fileID, SCREENSHOT.fileID);
      return { fileContent: Buffer.from('fake-image-bytes') };
    },
    respond: () => openAiTextResponse('识别结果'),
  });
  const result = await harness.main({
    action: 'vision',
    messages: [{ role: 'user', text: '识别一下' }],
    image: SCREENSHOT,
  });
  assert.equal(result.ok, true, `应成功：${result.message}`);
  assert.equal(harness.cloud.downloadFile.length, 1);
  assert.equal(harness.cloud.imgSecCheck[0].media.contentType, 'image/png');
});

test('图片参数错误（缺图、格式不支持、超过大小上限）都按参数错误处理', async () => {
  const harness = createHarness({ security: wechatOk(), respond: () => openAiTextResponse('不该被调用') });
  const missing = await harness.main({ action: 'vision', messages: [{ role: 'user', text: '识别' }] });
  assert.equal(missing.failureClass, 'invalid_request');

  const badMime = await harness.main({
    action: 'vision',
    messages: [{ role: 'user', text: '识别' }],
    image: { base64: 'aGVsbG8=', mimeType: 'image/gif' },
  });
  assert.equal(badMime.failureClass, 'invalid_request');

  const tooBig = await harness.main({
    action: 'vision',
    messages: [{ role: 'user', text: '识别' }],
    image: { base64: 'A'.repeat(2 * 1024 * 1024), mimeType: 'image/png' },
  });
  assert.equal(tooBig.failureClass, 'invalid_request');
  assert.ok(tooBig.detail.includes('AI_MAX_IMAGE_BYTES'), `细节要指出可配置的上限：${tooBig.detail}`);

  const chatWithImage = await harness.main(chatEvent({ image: IMAGE }));
  assert.equal(chatWithImage.failureClass, 'invalid_request');
  assert.equal(harness.http.length, 0);
});

// ---------- 内容安全适配器切换 ----------

test('切第三方审核后不再依赖微信接口：微信云调用不可用时调用仍可完成', async () => {
  const harness = createHarness({
    env: { AI_SAFETY_PROVIDER: 'openai' },
    respond: (request) => {
      const body = JSON.parse(request.body);
      if (JSON.stringify(body).includes('内容安全审核员')) {
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: '{"allowed": true}' } }] }) };
      }
      return openAiTextResponse('已由第三方审核通过后生成的回答');
    },
  });
  const result = await harness.main(chatEvent());
  assert.equal(result.ok, true, `应成功：${result.message}`);
  assert.equal(harness.cloud.msgSecCheck.length, 0, '第三方模式下不调用微信接口');
});

test('微信检测不可用且 fail closed：拒绝调用并说明原因，不假装已检测', async () => {
  const harness = createHarness({
    security: wechatOk({ msgSecCheck: () => Promise.reject({ errCode: 48001, errMsg: 'api unauthorized' }) }),
    respond: () => openAiTextResponse('不该被调用'),
  });
  const result = await harness.main(chatEvent());
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'internal', '检测不可用是内部错误，不是内容被拒');
  assert.ok(result.detail.includes('48001'));
  assert.equal(harness.http.length, 0);
});

// ---------- 「有没有真的检测」：checked 标志 ----------

test('成功链路的检测报告带 checked=true：确实检过才叫通过', async () => {
  const harness = createHarness({ security: wechatOk(), respond: () => openAiTextResponse('正常回答') });
  const result = await harness.main(chatEvent());
  assert.equal(result.ok, true);
  assert.equal(result.safety.passed, true);
  assert.equal(result.safety.checked, true, '真的检测过：checked 为真');
  assert.equal(result.warnings.length, 0, '正常链路不该有「未完整检测」告警');
});

test('AI_SAFETY_PROVIDER=off：请求继续但明确标记「未检测」，不能读成「已通过」', async () => {
  const harness = createHarness({
    env: { AI_SAFETY_PROVIDER: 'off' },
    security: wechatOk(),
    respond: () => openAiTextResponse('未过检的回答'),
  });
  const result = await harness.main(chatEvent());
  assert.equal(result.ok, true, 'off 是逃生口：不拦调用');
  assert.equal(result.safety.passed, true);
  assert.equal(result.safety.checked, false, '没检过就必须是 false');
  assert.ok(result.safety.detail.includes('生产不得使用'), `报告要写明这只是开发/排障逃生口：${result.safety.detail}`);
  assert.ok(
    result.warnings.some((warning) => warning.includes('checked=false')),
    `未检测要进 warnings，不能只藏在 detail 里：${result.warnings.join('｜')}`,
  );
  assert.equal(harness.cloud.msgSecCheck.length, 0, 'off 确实不调用微信检测');
  assert.equal(harness.http.length, 1, '模型调用照常发生');
});

test('AI_SAFETY_FAIL_MODE=open：检测不可用时放行，但 checked=false 并留告警', async () => {
  const harness = createHarness({
    env: { AI_SAFETY_FAIL_MODE: 'open' },
    security: wechatOk({ msgSecCheck: () => Promise.reject({ errCode: 48001, errMsg: 'api unauthorized' }) }),
    respond: () => openAiTextResponse('放行后的回答'),
  });
  const result = await harness.main(chatEvent());
  assert.equal(result.ok, true, 'fail-open 的语义是放行，不是失败');
  assert.equal(result.safety.checked, false);
  assert.ok(result.safety.detail.includes('未检测'), `要写明未检测：${result.safety.detail}`);
  assert.ok(result.warnings.some((warning) => warning.includes('checked=false')), '同样要进告警');
});

// ---------- 输入检测的覆盖面 ----------

test('输入检测覆盖全部消息角色：system 提示词与 assistant 历史都在送检文本里', async () => {
  const seen = [];
  const harness = createHarness({
    security: wechatOk({
      msgSecCheck: (params) => {
        seen.push(params.content);
        return Promise.resolve({ errCode: 0 });
      },
    }),
    respond: () => openAiTextResponse('回答'),
  });
  const result = await harness.main(chatEvent({
    system: '你是课表助手，只依据课表回答',
    messages: [
      { role: 'user', text: '第三节有课吗' },
      { role: 'assistant', text: '上一轮的回答内容' },
      { role: 'system', text: '补充：不要编造' },
    ],
  }));
  assert.equal(result.ok, true, `应成功：${result.message}`);
  const first = seen[0];
  assert.ok(first.includes('你是课表助手'), '事件顶层 system 要过检');
  assert.ok(first.includes('第三节有课吗'), 'user 消息要过检');
  assert.ok(first.includes('上一轮的回答内容'), 'assistant 历史要过检');
  assert.ok(first.includes('补充：不要编造'), '消息里的 system 要过检');
});

test('历史消息里的违规内容同样被拒，不再只检 user 一条', async () => {
  const harness = createHarness({
    security: wechatOk({ msgSecCheck: () => Promise.resolve({ errCode: 0, result: { suggest: 'risky' } }) }),
    respond: () => openAiTextResponse('不该被调用'),
  });
  const result = await harness.main(chatEvent({
    messages: [
      { role: 'user', text: '你好' },
      { role: 'assistant', text: '这段历史里有违规内容' },
    ],
  }));
  assert.equal(result.failureClass, 'content_rejected');
  assert.equal(harness.http.length, 0, '输入被拒即中止');
});

// ---------- 长文本：逐段检测，检不全就标出来 ----------

test('长文本按窗口逐段送检：违规出现在第二段同样被拒', async () => {
  let call = 0;
  const harness = createHarness({
    security: wechatOk({
      msgSecCheck: () => {
        call += 1;
        return Promise.resolve(call === 1 ? { errCode: 0 } : { errCode: 0, result: { suggest: 'risky' } });
      },
    }),
  });
  const result = await harness.main({ action: 'moderateText', text: `${'好'.repeat(2500)}违规词` });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'content_rejected');
  assert.equal(harness.cloud.msgSecCheck.length, 2, '两段都要送检，不能只检第一段');
});

test('超过分片上限的长文本：检查过的部分通过，但标 checked=false 并写明范围', async () => {
  const harness = createHarness({ security: wechatOk(), respond: () => openAiTextResponse('回答') });
  const long = '好'.repeat(8000);
  const result = await harness.main(chatEvent({
    messages: [0, 1, 2, 3].map(() => ({ role: 'user', text: long })),
  }));
  assert.equal(result.ok, true, '前 2 万字没发现问题就不拦，但不能说「全检过了」');
  assert.equal(result.safety.checked, false, '没检全必须标记');
  assert.ok(result.safety.detail.includes('仅检测了前 20000 字'), `要写明检测范围：${result.safety.detail}`);
  assert.ok(result.safety.detail.includes('未检测'), '要写明未检测的部分');
  assert.ok(result.warnings.some((warning) => warning.includes('checked=false')), '要进 warnings');
  assert.equal(harness.cloud.msgSecCheck.length, 11, '10 段输入 + 1 段输出');
});

// ---------- 用量未知的审核调用 ----------

test('/moderations 不返回用量：标记 usageUnknown，不静默记 0 元', async () => {
  const harness = createHarness({
    env: { AI_SAFETY_PROVIDER: 'openai', AI_SAFETY_OPENAI_MODE: 'moderations' },
    respond: (request) => (request.url.endsWith('/moderations')
      ? { status: 200, body: JSON.stringify({ results: [{ flagged: false }] }) }
      : openAiTextResponse('回答')),
  });
  const result = await harness.main(chatEvent());
  assert.equal(result.ok, true, `应成功：${result.message}`);
  const moderation = harness.records.find((row) => row.kind === 'moderation');
  assert.equal(moderation.usageUnknown, true, '用量未知要带标记');
  assert.equal(moderation.totalTokens, 0);
  assert.equal(moderation.costYuan, 0, '默认不编一个金额');
  assert.ok(
    result.warnings.some((warning) => warning.includes('usageUnknown')),
    `必须留告警说明这次没有用量：${result.warnings.join('｜')}`,
  );
});

test('/moderations 可按「每次审核固定价」计入成本，告警里写明计价方式', async () => {
  const harness = createHarness({
    env: {
      AI_SAFETY_PROVIDER: 'openai',
      AI_SAFETY_OPENAI_MODE: 'moderations',
      AI_SAFETY_CALL_PRICE_YUAN: '0.002',
    },
    respond: (request) => (request.url.endsWith('/moderations')
      ? { status: 200, body: JSON.stringify({ results: [{ flagged: false }] }) }
      : openAiTextResponse('回答')),
  });
  const result = await harness.main(chatEvent());
  assert.equal(result.ok, true, `应成功：${result.message}`);
  const moderation = harness.records.find((row) => row.kind === 'moderation');
  assert.equal(moderation.costYuan, 0.002, '按固定价计入，而不是 0');
  assert.equal(moderation.usageUnknown, true);
  assert.ok(
    result.warnings.some((warning) => warning.includes('固定价 0.002 元/次')),
    `告警要写明计价方式：${result.warnings.join('｜')}`,
  );
  // 一次 chat 有两次审核调用（输入文字 + 输出文字），每次 0.002 元，加模型调用 0.00006 元。
  const moderationCalls = harness.records.filter((row) => row.kind === 'moderation').length;
  assert.equal(moderationCalls, 2);
  assert.equal(harness.monthly[currentMonth()].costYuan, 0.00006 + 0.002 * moderationCalls, '固定价进月度累计');
});

// ---------- 探测动作 ----------

test('探测动作：两个接口都可用时结论为可用，并给出可粘贴的记录', async () => {
  const harness = createHarness({ security: wechatOk(), env: { AI_BASE_URL: '', AI_API_KEY: '', AI_MODEL: '' } });
  const result = await harness.main({ action: 'probe' });
  assert.equal(result.ok, true, '未配置模型密钥也应能探测');
  assert.equal(result.probe.valid, true, '从小程序端触发才算有效测量');
  assert.equal(result.probe.invalidReason, '');
  assert.equal(result.probe.checks.length, 2);
  for (const check of result.probe.checks) {
    assert.equal(check.errCode, 0);
    assert.equal(check.verdict, 'pass');
  }
  assert.equal(result.probe.recommendedProvider, 'wechat');
  assert.ok(result.probe.conclusion.includes('可调用'));
  const pasted = JSON.parse(result.detail);
  assert.equal(pasted.checks.length, 2, '粘贴行应是完整记录的 JSON');
  assert.equal(pasted.valid, true, '粘贴行要带上有效性');
  assert.deepEqual(pasted.declaredOpenApi.slice().sort(), ['security.imgSecCheck', 'security.msgSecCheck']);
});

test('探测动作：控制台触发拿到 -501001 时标为无效测量，不得据此切第三方', async () => {
  // CloudBase 口径：-501001 = 云调用鉴权失败，未从小程序端触发使用云调用的云函数。
  // 这种结果只说明触发方式不对，不是「微信接口不可用」——2026-09-18 真机上就是这么误报的。
  const harness = createHarness({
    security: wechatOk({
      msgSecCheck: () => Promise.reject({ errCode: -501001, errMsg: 'invalid wx openapi access_token' }),
      imgSecCheck: () => Promise.reject({ errCode: -501001, errMsg: 'invalid wx openapi access_token' }),
    }),
    env: { AI_BASE_URL: '', AI_API_KEY: '', AI_MODEL: '' },
  });
  const result = await harness.main({ action: 'probe' });
  assert.equal(result.ok, false, '没测出可用就是没测出');
  assert.equal(result.probe.valid, false, '必须标成无效测量');
  assert.equal(result.failureClass, '', '探测本身不是失败');
  assert.equal(result.probe.valid, false);
  assert.ok(result.probe.invalidReason.includes('小程序端'), `要写明正确触发方式：${result.probe.invalidReason}`);
  assert.equal(result.probe.recommendedProvider, 'wechat', '无效测量不得改变默认适配器');
  assert.ok(result.probe.conclusion.startsWith('本次探测无效'), `结论先讲无效：${result.probe.conclusion}`);
  assert.ok(!result.probe.conclusion.includes('切第三方'), '不得据无效测量建议切第三方');
  assert.equal(result.message, result.probe.conclusion, '控制台看到的 message 要带上无效说明');
  const text = result.probe.checks.find((check) => check.api === 'security.msgSecCheck');
  assert.equal(text.errCode, -501001);
  assert.ok(text.note.includes('本次探测无效'), `错误码说明要点出无效：${text.note}`);
  assert.ok(text.note.includes('npm run probe:wechat'), '说明里要给出小程序端的跑法');
  assert.equal(JSON.parse(result.detail).valid, false, '粘贴行要带上有效性，回填文档时不会漏');
});

test('探测动作：missing wxCloudApiToken（-501007）同样按无效测量处理', async () => {
  const harness = createHarness({
    security: wechatOk({
      msgSecCheck: () => Promise.reject({ errCode: -501007, errMsg: 'missing wxCloudApiToken' }),
      imgSecCheck: () => Promise.reject({ errCode: -501007, errMsg: 'missing wxCloudApiToken' }),
    }),
    env: { AI_BASE_URL: '', AI_API_KEY: '', AI_MODEL: '' },
  });
  const result = await harness.main({ action: 'probe' });
  assert.equal(result.probe.valid, false);
  assert.equal(result.probe.recommendedProvider, 'wechat');
  assert.ok(result.probe.conclusion.startsWith('本次探测无效'));
});

test('探测动作：未认证导致 48001 时记录错误码并建议切第三方', async () => {
  const harness = createHarness({
    security: wechatOk({
      msgSecCheck: () => Promise.reject({ errCode: 48001, errMsg: 'api unauthorized' }),
      imgSecCheck: () => Promise.reject({ errCode: 48001, errMsg: 'api unauthorized' }),
    }),
  });
  const result = await harness.main({ action: 'probe' });
  assert.equal(result.ok, false, '接口不可用时探测结论为不可用');
  assert.equal(result.probe.valid, true, '48001 是微信接口的真实答复，属于有效测量');
  assert.equal(result.failureClass, '', '探测本身不是失败');
  assert.equal(result.probe.recommendedProvider, 'openai');
  assert.ok(result.probe.conclusion.includes('第三方'), `结论应给出切换建议：${result.probe.conclusion}`);
  const text = result.probe.checks.find((check) => check.api === 'security.msgSecCheck');
  assert.equal(text.errCode, 48001);
  assert.ok(text.note.includes('未认证'), '错误码说明要指出未认证这一常见原因');
});

test('探测动作：部分可用（文字可用、图片不可用）时建议切第三方覆盖两条路径', async () => {
  const harness = createHarness({
    security: wechatOk({ imgSecCheck: () => Promise.reject({ errCode: 48002, errMsg: 'api forbidden' }) }),
  });
  const result = await harness.main({ action: 'probe' });
  assert.equal(result.ok, false);
  assert.equal(result.probe.recommendedProvider, 'openai');
  assert.ok(result.probe.conclusion.includes('部分可用'), `结论要写清部分可用：${result.probe.conclusion}`);
});

// ---------- 参数防御 ----------

test('未知动作与空事件都返回参数错误，不抛异常', async () => {
  const harness = createHarness({ security: wechatOk() });
  const unknown = await harness.main({ action: '写作业' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.failureClass, 'invalid_request');
  assert.ok(unknown.detail.includes('写作业'));
  const empty = await harness.main();
  assert.equal(empty.ok, false);
  assert.equal(empty.failureClass, 'invalid_request');
  const badMessages = await harness.main({ action: 'chat', messages: [] });
  assert.equal(badMessages.failureClass, 'invalid_request');
  const tooMany = await harness.main({
    action: 'chat',
    messages: Array.from({ length: 30 }, () => ({ role: 'user', text: '你好' })),
  });
  assert.equal(tooMany.failureClass, 'invalid_request');
});

test('图片路径不可信时拒绝，即使调用方显式指定 MIME 也不能绕过归属校验', async () => {
  const harness = createHarness({
    security: wechatOk(),
    downloadFile: () => ({ fileContent: Buffer.from('not-an-image') }),
    respond: () => openAiTextResponse('不该被调用'),
  });
  const unknownExtension = await harness.main({
    action: 'vision',
    messages: [{ role: 'user', text: '识别' }],
    image: { fileID: 'cloud://example/upload-without-extension' },
  });
  assert.equal(unknownExtension.failureClass, 'invalid_request');
  assert.equal(harness.cloud.downloadFile.length, 0, '路径不可信不应下载');

  const unsupported = await harness.main({
    action: 'vision',
    messages: [{ role: 'user', text: '识别' }],
    image: { fileID: 'cloud://example/shot.gif' },
  });
  assert.equal(unsupported.failureClass, 'invalid_request', '认不出的扩展名同样拒绝，不猜成 PNG');

  const noMime = await harness.main({
    action: 'vision',
    messages: [{ role: 'user', text: '识别' }],
    image: { base64: 'aGVsbG8=' },
  });
  assert.equal(noMime.failureClass, 'invalid_request');
  assert.ok(noMime.detail.includes('mimeType'), `base64 缺 mimeType 也要说清楚：${noMime.detail}`);
  assert.equal(harness.cloud.imgSecCheck.length, 0, '参数不合法不得进入检测');
});

test('messages 的 role 缺失或写错都按参数错误处理，不默认成 user', async () => {
  const harness = createHarness({ security: wechatOk(), respond: () => openAiTextResponse('不该被调用') });
  const missing = await harness.main({ action: 'chat', messages: [{ text: '你好' }] });
  assert.equal(missing.failureClass, 'invalid_request');
  assert.ok(missing.detail.includes('role'), `细节要指出 role：${missing.detail}`);

  const unknown = await harness.main({ action: 'chat', messages: [{ role: 'robot', text: '你好' }] });
  assert.equal(unknown.failureClass, 'invalid_request');
  assert.ok(unknown.detail.includes('robot'), '读得懂的错误里要带上传来的值');
  assert.equal(harness.http.length, 0);
});

test('仅做内容安全检测的动作：文字与图片分开，被拒时用同一类失败但走各自接口', async () => {
  const harness = createHarness({ security: wechatOk() });
  const textOk = await harness.main({ action: 'moderateText', text: '图书馆在哪里' });
  assert.equal(textOk.ok, true);
  assert.equal(textOk.safety.provider, 'wechat');
  assert.equal(textOk.safety.api, 'security.msgSecCheck');

  const imageOk = await harness.main({ action: 'moderateImage', image: IMAGE });
  assert.equal(imageOk.ok, true);
  assert.equal(imageOk.safety.api, 'security.imgSecCheck');

  const rejectedHarness = createHarness({
    security: wechatOk({ imgSecCheck: () => Promise.reject({ errCode: 87014 }) }),
  });
  const rejected = await rejectedHarness.main({ action: 'moderateImage', image: IMAGE });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.failureClass, 'content_rejected');
  assert.equal(rejected.safety.passed, false);
});

test('失败的模型调用也记账，便于排查与成本核对', async () => {
  const harness = createHarness({ security: wechatOk(), respond: () => ({ status: 500, body: 'boom' }) });
  await harness.main(chatEvent());
  const failed = harness.records.filter((row) => row.ok === false);
  assert.equal(failed.length, 1, '失败调用要留下记录');
  assert.equal(failed[0].failureClass, 'model_unavailable');
  assert.equal(failed[0].kind, 'model');
  assert.equal(harness.monthly[currentMonth()].failures, 1, '失败计数进月度汇总');
});
