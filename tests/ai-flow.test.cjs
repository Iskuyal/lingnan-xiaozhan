/**
 * AI 云函数入口测试（Ticket 01）：三类失败、成本上限、用量记账、图片先检后送、探测动作。
 *
 * 运行真实编译产物与真实入口，只桩掉 https / wx-server-sdk / 数据库：
 * 不访问网络、不需要密钥、不接触云端。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, openAiTextResponse, currentMonth } = require('./ai-harness.cjs');

const KEY = 'test-key-000000000000';
const IMAGE = { base64: 'aGVsbG8=', mimeType: 'image/png' };
const SCREENSHOT = { fileID: 'cloud://example/lesson.png' };

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
  assert.ok(result.message.includes('41.5'), `查询返回应带告警文案：${result.message}`);
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

test('vision 支持云存储 fileID，并按扩展名推断图片格式', async () => {
  const harness = createHarness({
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

// ---------- 探测动作 ----------

test('探测动作：两个接口都可用时结论为可用，并给出可粘贴的记录', async () => {
  const harness = createHarness({ security: wechatOk(), env: { AI_BASE_URL: '', AI_API_KEY: '', AI_MODEL: '' } });
  const result = await harness.main({ action: 'probe' });
  assert.equal(result.ok, true, '未配置模型密钥也应能探测');
  assert.equal(result.probe.checks.length, 2);
  for (const check of result.probe.checks) {
    assert.equal(check.errCode, 0);
    assert.equal(check.verdict, 'pass');
  }
  assert.equal(result.probe.recommendedProvider, 'wechat');
  assert.ok(result.probe.conclusion.includes('可调用'));
  const pasted = JSON.parse(result.detail);
  assert.equal(pasted.checks.length, 2, '粘贴行应是完整记录的 JSON');
  assert.deepEqual(pasted.declaredOpenApi.slice().sort(), ['security.imgSecCheck', 'security.msgSecCheck']);
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
