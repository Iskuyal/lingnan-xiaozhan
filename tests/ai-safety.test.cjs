/**
 * 内容安全适配层测试（Ticket 01）：微信官方为主 + 第三方 OpenAI / Anthropic 格式，
 * 文字与图片分开，违规与「检测不可用」分开。
 *
 * 全部走桩：微信云调用与第三方审核接口都是桩，不发真实请求、不需要密钥。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./ai-harness.cjs');

const TEXT = '图书馆开放时间是什么？';
const IMAGE = { base64: 'aGVsbG8=', mimeType: 'image/png' };

function catchFailure(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

async function catchAsyncFailure(run) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return null;
}

function loadConfigFor(harness, env) {
  const config = harness.load('config.js');
  const merged = { ...harness.env, ...env };
  return { config: config.loadConfig(merged), module: config };
}

// ---------- 微信官方适配器 ----------

test('微信文字检测：无 openid 走 v1 形态，有 openid 走 v2 并带上 scene', async () => {
  const harness = createHarness();
  const safety = harness.load('safety.js');
  const { config } = loadConfigFor(harness, { AI_SAFETY_PROVIDER: 'wechat' });

  let v1Params = null;
  const v1 = await safety.checkText(config, {
    text: TEXT,
    wechat: {
      msgSecCheck: (params) => {
        v1Params = params;
        return Promise.resolve({ errCode: 0 });
      },
      imgSecCheck: () => Promise.resolve({ errCode: 0 }),
    },
  });
  assert.equal(v1.report.passed, true);
  assert.equal(v1.report.provider, 'wechat');
  assert.equal(v1.report.api, 'security.msgSecCheck');
  assert.deepEqual(Object.keys(v1Params).sort(), ['content'], '没有 openid 时不带 version/scene');

  let v2Params = null;
  await safety.checkText(config, {
    text: TEXT,
    openid: 'openid-test',
    wechat: {
      msgSecCheck: (params) => {
        v2Params = params;
        return Promise.resolve({ errCode: 0, result: { suggest: 'pass', label: 100 } });
      },
      imgSecCheck: () => Promise.resolve({ errCode: 0 }),
    },
  });
  assert.equal(v2Params.version, 2, '有 openid 时使用 v2');
  assert.equal(v2Params.scene, 1, 'scene 默认 1（资料）');
  assert.equal(v2Params.openid, 'openid-test');
});

test('微信文字检测：suggest=risky 与 errcode 87014 都判为违规，不是「调用失败」', async () => {
  const harness = createHarness();
  const safety = harness.load('safety.js');
  const { config } = loadConfigFor(harness, {});

  const risky = await safety.checkText(config, {
    text: TEXT,
    openid: 'openid-test',
    wechat: {
      msgSecCheck: () => Promise.resolve({ errCode: 0, result: { suggest: 'risky', label: 20002 } }),
      imgSecCheck: () => Promise.resolve({ errCode: 0 }),
    },
  });
  assert.equal(risky.rejected, true);
  assert.equal(risky.report.passed, false);
  assert.ok(risky.report.detail.includes('risky'), `判定细节应含 suggest：${risky.report.detail}`);

  const thrown = await safety.checkText(config, {
    text: TEXT,
    wechat: {
      msgSecCheck: () => Promise.reject({ errCode: 87014, errMsg: 'risky content' }),
      imgSecCheck: () => Promise.resolve({ errCode: 0 }),
    },
  });
  assert.equal(thrown.rejected, true, '违规以 reject 形式返回时同样判为违规');
  assert.ok(thrown.report.detail.includes('87014'));
});

test('微信文字检测：suggest=review 默认按拒绝处理，可用 AI_SAFETY_REVIEW_AS=pass 放行', async () => {
  const harness = createHarness();
  const safety = harness.load('safety.js');
  const wechat = {
    msgSecCheck: () => Promise.resolve({ errCode: 0, result: { suggest: 'review' } }),
    imgSecCheck: () => Promise.resolve({ errCode: 0 }),
  };
  const strict = await safety.checkText(loadConfigFor(harness, {}).config, { text: TEXT, wechat });
  assert.equal(strict.rejected, true, '默认 fail closed：review 按拒绝');

  const lenient = await safety.checkText(loadConfigFor(harness, { AI_SAFETY_REVIEW_AS: 'pass' }).config, { text: TEXT, wechat });
  assert.equal(lenient.rejected, false);
  assert.equal(lenient.report.passed, true);
  assert.ok(lenient.report.detail.includes('review 按放行'), `细节要写明处置方式：${lenient.report.detail}`);
});

test('微信图片检测：与文字分开入口，图片走 media 字段；87014 判违规', async () => {
  const harness = createHarness();
  const safety = harness.load('safety.js');
  const { config } = loadConfigFor(harness, {});
  const calls = { text: 0, image: 0 };
  let media = null;
  const wechat = {
    msgSecCheck: () => {
      calls.text += 1;
      return Promise.resolve({ errCode: 0 });
    },
    imgSecCheck: (params) => {
      calls.image += 1;
      media = params.media;
      return Promise.resolve({ errCode: 87014 });
    },
  };
  const outcome = await safety.checkImage(config, { image: IMAGE, wechat });
  assert.equal(calls.image, 1, '图片检测只调用 imgSecCheck');
  assert.equal(calls.text, 0, '图片检测不应触发文字检测');
  assert.equal(media.contentType, 'image/png');
  assert.ok(Buffer.isBuffer(media.value), '图片以二进制上传');
  assert.equal(outcome.rejected, true);
  assert.equal(outcome.report.api, 'security.imgSecCheck');
});

test('微信接口不可用（48001 未认证）：默认拒绝调用，AI_SAFETY_FAIL_MODE=open 时放行但写明未检测', async () => {
  const harness = createHarness();
  const safety = harness.load('safety.js');
  const wechat = {
    msgSecCheck: () => Promise.reject({ errCode: 48001, errMsg: 'api unauthorized' }),
    imgSecCheck: () => Promise.resolve({ errCode: 0 }),
  };
  const failure = await catchAsyncFailure(() => safety.checkText(loadConfigFor(harness, {}).config, { text: TEXT, wechat }));
  assert.ok(failure !== null, '默认 fail closed：检测不可用时必须拒绝调用');
  assert.equal(failure.failureClass, 'internal', '配置/权限类的检测不可用属于内部错误，不是「内容被拒」');
  assert.ok(failure.detail.includes('48001'), `细节保留 errcode：${failure.detail}`);

  const passed = await safety.checkText(loadConfigFor(harness, { AI_SAFETY_FAIL_MODE: 'open' }).config, { text: TEXT, wechat });
  assert.equal(passed.report.passed, true);
  assert.equal(passed.report.checked, false, '放行的是「没检过的内容」，必须标出来');
  assert.ok(passed.report.detail.includes('未检测'), `放行时必须写明未检测：${passed.report.detail}`);
});

test('检测调用超时：归入「模型不可用或超时」（可重试），不是笼统的内部错误', async () => {
  const harness = createHarness();
  const safety = harness.load('safety.js');
  const config = loadConfigFor(harness, { AI_SAFETY_TIMEOUT_MS: '1000' }).config;
  const failure = await catchAsyncFailure(() => safety.checkText(config, {
    text: TEXT,
    wechat: {
      msgSecCheck: () => new Promise(() => {}), // 永不返回
      imgSecCheck: () => Promise.resolve({ errCode: 0 }),
    },
  }));
  assert.ok(failure !== null, '超时必须结束，不能挂住');
  assert.equal(failure.failureClass, 'model_unavailable');
  assert.equal(failure.timedOut, true, '要能被识别成超时');
  assert.ok(failure.detail.includes('超时'), `细节要写明超时：${failure.detail}`);
});

test('第三方审核超时同样归入「模型不可用或超时」，并且不会挂起', async () => {
  const harness = createHarness({
    env: { AI_SAFETY_PROVIDER: 'openai', AI_SAFETY_TIMEOUT_MS: '1000' },
    respond: () => undefined, // 永不响应
  });
  const safety = harness.load('safety.js');
  const config = loadConfigFor(harness, { AI_SAFETY_PROVIDER: 'openai', AI_SAFETY_TIMEOUT_MS: '1000' }).config;
  const startedAt = Date.now();
  const failure = await catchAsyncFailure(() => safety.checkText(config, { text: TEXT }));
  const elapsed = Date.now() - startedAt;
  assert.ok(failure !== null);
  assert.equal(failure.failureClass, 'model_unavailable');
  assert.ok(failure.detail.includes('超时'), `细节要写明超时：${failure.detail}`);
  assert.ok(elapsed < 4000, `应在超时边界内结束，实际 ${elapsed}ms`);
});

test('AI_SAFETY_PROVIDER=off：跳过检测，但 checked=false 且写明这是仅开发/排障的逃生口', async () => {
  const harness = createHarness();
  const safety = harness.load('safety.js');
  const { config } = loadConfigFor(harness, { AI_SAFETY_PROVIDER: 'off' });
  const outcome = await safety.checkText(config, { text: TEXT });
  assert.equal(outcome.report.passed, true, 'off 的语义是放行');
  assert.equal(outcome.report.checked, false, '没有被检测过，就不能只是 passed=true');
  assert.equal(outcome.report.provider, 'off');
  assert.ok(outcome.report.detail.includes('已关闭'));
  assert.ok(outcome.report.detail.includes('生产不得使用'), `要写明这是逃生口：${outcome.report.detail}`);

  const image = await safety.checkImage(config, { image: IMAGE });
  assert.equal(image.report.checked, false);
});

// ---------- 第三方审核适配器 ----------

test('第三方（OpenAI 格式）：审核走 chat 接口，不被微信适配器影响', async () => {
  const harness = createHarness({
    env: { AI_SAFETY_PROVIDER: 'openai' },
    respond: (request) => {
      const body = JSON.parse(request.body);
      assert.ok(request.url.endsWith('/chat/completions'), `第三方审核走 chat/completions：${request.url}`);
      assert.ok(JSON.stringify(body).includes(TEXT), '待检文本进入请求体');
      assert.ok(JSON.stringify(body).includes('内容安全审核员'), '请求带审核提示词');
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: '{"allowed": true, "reason": "正常"}' } }], usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 } }) };
    },
  });
  const safety = harness.load('safety.js');
  const { config } = loadConfigFor(harness, { AI_SAFETY_PROVIDER: 'openai' });
  const outcome = await safety.checkText(config, { text: TEXT });
  assert.equal(outcome.report.provider, 'openai');
  assert.equal(outcome.report.passed, true);
  assert.equal(outcome.usage.promptTokens, 30, '第三方审核的用量要回传给记账');
  assert.equal(harness.cloud.msgSecCheck.length, 0, '切第三方后不调用微信接口');
});

test('第三方（OpenAI 格式）：allowed=false 判为违规；不可解析的判定按内部错误处理', async () => {
  const rejectedHarness = createHarness({
    respond: () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: '{"allowed": false, "reason": "广告引流"}' } }] }) }),
  });
  const rejectedSafety = rejectedHarness.load('safety.js');
  const rejected = await rejectedSafety.checkText(loadConfigFor(rejectedHarness, { AI_SAFETY_PROVIDER: 'openai' }).config, { text: TEXT });
  assert.equal(rejected.rejected, true);
  assert.ok(rejected.report.detail.includes('广告引流'), '判定理由要写进报告');

  const brokenHarness = createHarness({ respond: () => ({ status: 200, body: '这不是 JSON' }) });
  const brokenSafety = brokenHarness.load('safety.js');
  const failure = await catchAsyncFailure(() => brokenSafety.checkText(
    loadConfigFor(brokenHarness, { AI_SAFETY_PROVIDER: 'openai' }).config,
    { text: TEXT },
  ));
  assert.ok(failure !== null, '判定解析不了必须 fail closed');
  assert.equal(failure.failureClass, 'internal');
});

test('第三方（OpenAI /moderations 模式）：带图检测走 moderations 接口并读 flagged', async () => {
  const harness = createHarness({
    respond: (request) => {
      assert.ok(request.url.endsWith('/moderations'), `走 /moderations：${request.url}`);
      const body = JSON.parse(request.body);
      assert.ok(Array.isArray(body.input), '带图时 input 用分块数组');
      return {
        status: 200,
        body: JSON.stringify({ results: [{ flagged: true, categories: { violence: true, harassment: false } }] }),
      };
    },
  });
  const safety = harness.load('safety.js');
  const { config } = loadConfigFor(harness, {
    AI_SAFETY_PROVIDER: 'openai',
    AI_SAFETY_OPENAI_MODE: 'moderations',
  });
  const outcome = await safety.checkImage(config, { image: IMAGE });
  assert.equal(outcome.rejected, true);
  assert.equal(outcome.report.checked, true, '真的调用了审核接口：checked 为真');
  assert.ok(outcome.report.detail.includes('violence'), '命中的分类要写进报告');
});

test('第三方（OpenAI /moderations 模式）：接口不返回 token 用量时标记 usageUnknown', async () => {
  const harness = createHarness({
    respond: () => ({ status: 200, body: JSON.stringify({ results: [{ flagged: false }] }) }),
  });
  const safety = harness.load('safety.js');
  const { config } = loadConfigFor(harness, { AI_SAFETY_PROVIDER: 'openai', AI_SAFETY_OPENAI_MODE: 'moderations' });
  const outcome = await safety.checkText(config, { text: TEXT });
  assert.equal(outcome.usage, null, '接口没给用量就是没有，不猜一个数');
  assert.equal(outcome.usageUnknown, true, '要显式标记「用量未知」，记账时不得静默记 0 元');
});

test('第三方（Anthropic 格式）：审核走 /v1/messages，文本判定映射一致', async () => {
  const harness = createHarness({
    respond: (request) => {
      assert.ok(request.url.endsWith('/v1/messages'), `走 /v1/messages：${request.url}`);
      assert.equal(request.headers['x-api-key'], harness.env.AI_API_KEY);
      return { status: 200, body: JSON.stringify({ content: [{ type: 'text', text: '{"allowed": false, "reason": "辱骂"}' }], usage: { input_tokens: 12, output_tokens: 4 } }) };
    },
  });
  const safety = harness.load('safety.js');
  const { config } = loadConfigFor(harness, { AI_SAFETY_PROVIDER: 'anthropic' });
  const outcome = await safety.checkText(config, { text: TEXT });
  assert.equal(outcome.report.provider, 'anthropic', '接口格式由适配器选择决定，没有单独的 AI_SAFETY_FORMAT 开关');
  assert.equal(outcome.rejected, true);
  assert.equal(outcome.usage.completionTokens, 4, '第三方审核的用量按接口格式各自的字段映射');
});

test('第三方审核的地址与模型可单独配置（默认复用模型配置，改环境变量即切换）', async () => {
  const harness = createHarness({
    respond: (request) => {
      assert.equal(request.url, 'https://safety.example.com/chat/completions', '审核走单独配置的地址');
      const body = JSON.parse(request.body);
      assert.equal(body.model, 'safety-model', '审核走单独配置的模型');
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: '{"allowed": true}' } }] }) };
    },
  });
  const safety = harness.load('safety.js');
  const { config } = loadConfigFor(harness, {
    AI_SAFETY_PROVIDER: 'openai',
    AI_SAFETY_BASE_URL: 'https://safety.example.com',
    AI_SAFETY_MODEL: 'safety-model',
  });
  const outcome = await safety.checkText(config, { text: TEXT });
  assert.equal(outcome.report.passed, true);
});

test('第三方审核未配置完整时按 fail closed 处理，并指明缺哪几个环境变量', async () => {
  const harness = createHarness();
  const safety = harness.load('safety.js');
  const { config } = loadConfigFor(harness, {
    AI_SAFETY_PROVIDER: 'openai',
    // 审核配置默认复用模型配置，因此两边都清空才构成「未配置完整」。
    AI_BASE_URL: '',
    AI_API_KEY: '',
    AI_MODEL: '',
    AI_SAFETY_BASE_URL: '',
    AI_SAFETY_API_KEY: '',
    AI_SAFETY_MODEL: '',
  });
  const failure = await catchAsyncFailure(() => safety.checkText(config, { text: TEXT }));
  assert.ok(failure !== null);
  assert.equal(failure.failureClass, 'internal');
  assert.ok(failure.detail.includes('AI_SAFETY_BASE_URL'), `细节要指出缺失项：${failure.detail}`);
});

test('微信错误码表覆盖探测与排查用到的关键码', async () => {
  const safety = createHarness().load('safety.js');
  for (const code of [0, 87014, 48001, 48002, 61010, 40001]) {
    assert.equal(typeof safety.WECHAT_ERRCODE_NOTES[String(code)], 'string', `错误码 ${code} 应有说明`);
  }
  assert.ok(safety.WECHAT_ERRCODE_NOTES['48001'].includes('未认证'), '48001 的说明要指出未认证这一常见原因');
});
