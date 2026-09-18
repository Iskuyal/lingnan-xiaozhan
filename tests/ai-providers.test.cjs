/**
 * 模型适配层测试（Ticket 01）：两种接口格式的请求/响应映射、超时与错误分类。
 *
 * 全部走桩：不访问网络、不需要密钥。被测对象是编译产物 dist/cloudfunctions/ai/providers.js。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./ai-harness.cjs');

const KEY = 'test-key-000000000000';

function target(format, overrides = {}) {
  return {
    format,
    baseUrl: 'https://relay.example.com/v1',
    apiKey: KEY,
    model: 'test-model',
    anthropicVersion: '2023-06-01',
    timeoutMs: 5000,
    maxTokens: 256,
    temperature: 0.2,
    extraBody: {},
    ...overrides,
  };
}

const IMAGE = { base64: 'aGVsbG8=', mimeType: 'image/png' };

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('OpenAI 兼容格式：system、文本与图片映射成 messages 与 data URL', () => {
  const providers = createHarness().load('providers.js');
  const request = providers.buildModelRequest(target('openai'), {
    system: '你是助手',
    messages: [
      { role: 'user', text: '这是课表' },
      { role: 'assistant', text: '收到' },
      { role: 'user', text: '第三节有课吗', image: IMAGE },
    ],
  });
  assert.equal(request.url, 'https://relay.example.com/v1/chat/completions', 'OpenAI 格式走 chat/completions');
  assert.equal(request.headers.Authorization, `Bearer ${KEY}`, '密钥走 Authorization 头');
  const body = JSON.parse(request.body);
  assert.equal(body.model, 'test-model');
  assert.equal(body.max_tokens, 256);
  assert.deepEqual(plain(body.messages[0]), { role: 'system', content: '你是助手' });
  assert.deepEqual(plain(body.messages[1]), { role: 'user', content: '这是课表' });
  assert.deepEqual(plain(body.messages[3]), {
    role: 'user',
    content: [
      { type: 'text', text: '第三节有课吗' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    ],
  }, '带图消息展开成 content 分块');
});

test('Anthropic 格式：system 提到顶层，相邻同角色消息合并，图片用 base64 source', () => {
  const providers = createHarness().load('providers.js');
  // Anthropic 的 baseUrl 是站点根（与官方一致），/v1/messages 由适配器补上。
  const request = providers.buildModelRequest(target('anthropic', { baseUrl: 'https://anthropic.example.com' }), {
    system: '你是助手',
    messages: [
      { role: 'user', text: '第一句' },
      { role: 'user', text: '第二句', image: IMAGE },
      { role: 'assistant', text: '好的' },
    ],
  });
  assert.equal(request.url, 'https://anthropic.example.com/v1/messages', 'Anthropic 格式走 /v1/messages');
  assert.equal(request.headers['x-api-key'], KEY, 'Anthropic 使用 x-api-key 头');
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(request.body);
  assert.equal(body.system, '你是助手', 'system 不在 messages 里');
  assert.equal(body.messages.length, 2, '相邻的 user 消息合并成一条');
  assert.deepEqual(plain(body.messages[0]), {
    role: 'user',
    content: [
      { type: 'text', text: '第一句\n\n第二句' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
    ],
  });
  assert.deepEqual(plain(body.messages[1]), { role: 'assistant', content: [{ type: 'text', text: '好的' }] });
});

test('厂商特有参数由 AI_EXTRA_BODY_JSON 追加，允许覆盖默认值', () => {
  const providers = createHarness().load('providers.js');
  const request = providers.buildModelRequest(
    target('openai', { extraBody: { chat_template_kwargs: { thinking: false }, temperature: 0.9 } }),
    { system: '', messages: [{ role: 'user', text: '你好' }] },
  );
  const body = JSON.parse(request.body);
  assert.deepEqual(plain(body.chat_template_kwargs), { thinking: false }, '追加参数进请求体');
  assert.equal(body.temperature, 0.9, '同名参数以追加的配置为准');
});

test('OpenAI 响应映射：字符串内容、分块内容与 usage', () => {
  const providers = createHarness().load('providers.js');
  const fromString = providers.parseModelResponse(target('openai'), {
    choices: [{ message: { content: '答案' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  });
  assert.equal(fromString.text, '答案');
  assert.deepEqual(
    plain(fromString.usage),
    { promptTokens: 7, completionTokens: 3, totalTokens: 10, estimated: false, usageUnknown: false },
  );
  assert.equal(fromString.finishReason, 'stop');

  const fromBlocks = providers.parseModelResponse(target('openai'), {
    choices: [{ message: { content: [{ type: 'text', text: '前' }, { type: 'text', text: '后' }] } }],
  });
  assert.equal(fromBlocks.text, '前后', '分块内容按顺序拼接');
  assert.equal(fromBlocks.usage, null, '没有 usage 时返回 null，由调用方估算');
});

test('Anthropic 响应映射：content 文本块与 input/output_tokens', () => {
  const providers = createHarness().load('providers.js');
  const parsed = providers.parseModelResponse(target('anthropic'), {
    content: [{ type: 'text', text: '结构' }, { type: 'thinking', thinking: '不应计入' }, { type: 'text', text: '化结果' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 40, output_tokens: 12 },
  });
  assert.equal(parsed.text, '结构化结果');
  assert.deepEqual(
    plain(parsed.usage),
    { promptTokens: 40, completionTokens: 12, totalTokens: 52, estimated: false, usageUnknown: false },
  );
  assert.equal(parsed.finishReason, 'end_turn');
});

test('返回空内容按「模型不可用」处理，不让调用方以为成功', () => {
  const providers = createHarness().load('providers.js');
  let failure = null;
  try {
    providers.parseModelResponse(target('openai'), { choices: [{ message: { content: '' } }] });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure !== null, '空内容必须抛错');
  assert.equal(failure.failureClass, 'model_unavailable');
});

test('状态码分类：402 归「额度用尽」，429 属瞬时限流归「模型不可用」，401/403/5xx 同理', () => {
  const providers = createHarness().load('providers.js');
  const limited = providers.classifyHttpStatus(target('openai'), 429, 'rate limited');
  assert.equal(limited.failureClass, 'model_unavailable', '429 是瞬时限流，重试即可，不能说要等下个月');
  assert.ok(limited.detail.includes('稍后重试'), `429 的细节要写明可重试：${limited.detail}`);
  const balance = providers.classifyHttpStatus(target('openai'), 402, 'insufficient balance');
  assert.equal(balance.failureClass, 'quota_exhausted', '402 才是真正的额度/余额用尽');
  assert.equal(providers.classifyHttpStatus(target('openai'), 401, 'unauthorized').failureClass, 'model_unavailable');
  assert.equal(providers.classifyHttpStatus(target('openai'), 500, 'boom').failureClass, 'model_unavailable');
});

test('429 的实际链路：返回「模型不可用或超时」文案，不是「额度用尽，请下月再试」', async () => {
  const harness = createHarness({
    security: {
      msgSecCheck: () => Promise.resolve({ errCode: 0 }),
      imgSecCheck: () => Promise.resolve({ errCode: 0 }),
    },
    respond: () => ({ status: 429, body: '{"error":"rate limited"}' }),
  });
  const result = await harness.main({
    action: 'chat',
    messages: [{ role: 'user', text: '第三节有课吗' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'model_unavailable');
  assert.ok(!result.message.includes('下月'), `瞬时限流不得说成「请下月再试」：${result.message}`);
  assert.ok(result.detail.includes('429'));
});

test('错误细节里不出现密钥（中转回显也不会泄露）', async () => {
  const harness = createHarness({
    respond: () => ({ status: 500, body: `bad relay, echo Authorization: Bearer ${KEY}` }),
  });
  const providers = harness.load('providers.js');
  let failure = null;
  try {
    await providers.callModel(target('openai'), { system: '', messages: [{ role: 'user', text: '你好' }] });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure !== null, 'HTTP 500 必须抛分类失败');
  assert.equal(failure.failureClass, 'model_unavailable');
  assert.ok(!failure.detail.includes(KEY), `细节里不应出现密钥：${failure.detail}`);
  assert.ok(failure.detail.includes('***'), '密钥出现的位置应被替换成 ***');
});

test('单次调用有超时边界：中转不响应时返回「模型不可用」而不是挂起', async () => {
  const harness = createHarness({ respond: () => undefined }); // 永不响应
  const providers = harness.load('providers.js');
  const startedAt = Date.now();
  let failure = null;
  try {
    await providers.callModel(
      target('openai', { timeoutMs: 60 }),
      { system: '', messages: [{ role: 'user', text: '你好' }], timeoutMs: 60 },
    );
  } catch (error) {
    failure = error;
  }
  const elapsed = Date.now() - startedAt;
  assert.ok(failure !== null, '超时必须抛出可识别的失败');
  assert.equal(failure.failureClass, 'model_unavailable');
  assert.ok(failure.detail.includes('超时'), `细节应写明超时：${failure.detail}`);
  assert.ok(elapsed < 2000, `应在超时边界内结束，实际 ${elapsed}ms`);
  assert.equal(harness.http[0].timedOut, true, '请求应被主动 destroy，不留悬挂连接');
});

test('网络错误（中转不可用）归入模型不可用', async () => {
  const harness = createHarness({ respond: () => ({ error: new Error('ECONNREFUSED 127.0.0.1:443') }) });
  const providers = harness.load('providers.js');
  let failure = null;
  try {
    await providers.callModel(target('openai'), { system: '', messages: [{ role: 'user', text: '你好' }] });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure !== null);
  assert.equal(failure.failureClass, 'model_unavailable');
  assert.ok(failure.detail.includes('ECONNREFUSED'), '细节保留网络错误原因');
});

test('token 估算：中文字符按 1 token、英文按 4 字符 1 token，缺 usage 时兜底记账', () => {
  const usage = createHarness().load('usage.js');
  assert.equal(usage.estimateTokens('你好世界'), 4);
  assert.equal(usage.estimateTokens('abcd'), 1);
  assert.equal(usage.estimateTokens('你a'), 2);
  const providers = createHarness().load('providers.js');
  const estimated = providers.estimateUsage(
    { system: '你是助手', messages: [{ role: 'user', text: '你好', image: IMAGE }] },
    '回答',
  );
  assert.equal(estimated.estimated, true, '估算值必须标记 estimated，避免被当成精确账单');
  assert.ok(estimated.promptTokens >= 800, '带图请求至少计上图片的固定估算开销');
});
