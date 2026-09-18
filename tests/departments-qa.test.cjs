const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// Ticket 07 部门 AI 问答:语料与提示词纪律、AI 服务封装、页面编排。
// 云函数 ai 本身的行为在 tests/ai-flow.test.cjs 里对真实入口验证,这里只验证部门侧。
function loadCompiled(relative) {
  const filename = path.resolve(relative);
  const compiled = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: compiled,
    exports: compiled.exports,
    require: createRequire(filename),
  }, { filename });
  return compiled.exports;
}

function loadPage(route, wx, stack = [{}, {}]) {
  const filename = path.resolve(`dist/pages/${route}/index.js`);
  let page;
  globalThis.wx = wx;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: (options) => { page = options; },
    wx,
    getCurrentPages: () => stack,
    require: createRequire(filename),
    exports: {},
  }, { filename });
  page.setData = (patch) => Object.assign(page.data, patch);
  return page;
}

const qa = () => loadCompiled('dist/pages/departments/qa.js');
const ai = () => loadCompiled('dist/services/ai.js');

const plain = (value) => JSON.parse(JSON.stringify(value));

function cloudStub(handlers) {
  const calls = [];
  return {
    calls,
    callFunction(options) {
      calls.push({ name: options.name, data: options.data });
      const handler = handlers[options.name] ?? handlers[options.data.action];
      if (handler === undefined) return Promise.reject(new Error(`未预设的调用:${options.name}/${options.data.action}`));
      const result = typeof handler === 'function' ? handler(options.data) : handler;
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve({ result });
    },
  };
}

function baseWx(cloud, extra = {}) {
  const actions = [];
  return {
    cloud,
    navigateTo: (options) => actions.push(`navigateTo:${options.url}`),
    navigateBack: () => actions.push('navigateBack'),
    reLaunch: (options) => actions.push(`reLaunch:${options.url}`),
    showToast: (options) => actions.push(`toast:${options.title}`),
    actions,
    ...extra,
  };
}

const ORG_NAMES = ['校学生团委', '校学生会', '校学生社团管理部', '青年志愿者联合会', '退役军人事务服务部'];

test('语料:包含 5 个组织的已核实事实、来源链接与核查日期,联系方式如实标注未公布', () => {
  const { buildCorpusText } = qa();
  const corpus = buildCorpusText();
  for (const name of ORG_NAMES) {
    assert.ok(corpus.includes(name), `语料缺少组织:${name}`);
  }
  assert.ok(corpus.includes('https://lnc.edu.cn/tw/sygk/xszz'), '语料必须带资料来源链接');
  assert.ok(corpus.includes('2026-09-18'), '语料必须带核查日期');
  assert.ok(corpus.includes('官网未公布联系方式'), '联系方式缺失必须如实写「官网未公布联系方式」');
  assert.ok(corpus.includes('校学生会'), '语料应含各组织简介等已核实事实');
  assert.ok(corpus.includes('权益部'), '语料应含下设部门事实');
});

test('系统提示词:只依据资料、没有必答「官网未公布」、绝不编造联系方式/负责人/校区、注明出处', () => {
  const { buildCorpusText, buildSystemPrompt } = qa();
  const system = buildSystemPrompt();
  assert.match(system, /官网未公布/u, '提示词必须包含「官网未公布」纪律');
  assert.match(system, /编造/u, '提示词必须包含不编造纪律');
  assert.match(system, /联系方式|负责人|所属校区/u, '提示词必须点名禁止编造的具体字段');
  assert.match(system, /来源|出处/u, '提示词必须要求回答可追溯出处');
  assert.ok(system.includes(buildCorpusText()), '系统提示词必须携带完整语料');
});

test('欢迎消息:AI 主动问「你想了解什么部门」并给出 5 个可点选项', () => {
  const { buildWelcome } = qa();
  const welcome = buildWelcome();
  assert.match(welcome.text, /你想了解什么部门/u);
  assert.equal(welcome.options.length, 5);
  assert.deepEqual(plain(welcome.options.map((option) => option.name)), ORG_NAMES);
  for (const option of welcome.options) {
    assert.ok(typeof option.id === 'string' && option.id.length > 0, '选项必须带详情页 id');
  }
});

test('多轮历史:映射成消息数组,只保留最近 20 条且不改变先后', () => {
  const { chatMessages } = qa();
  const history = [];
  for (let index = 0; index < 21; index += 1) {
    history.push({ role: index % 2 === 0 ? 'user' : 'assistant', text: `消息${index}` });
  }
  const messages = chatMessages(history);
  assert.equal(messages.length, 20);
  assert.deepEqual(plain(messages[0]), { role: 'assistant', text: '消息1' });
  assert.deepEqual(plain(messages[19]), { role: 'user', text: '消息20' });
  assert.deepEqual(plain(chatMessages([])), []);
});

test('AI 服务:五类失败文案各自独立,不合并成一句', () => {
  const { AI_MESSAGES, userMessage } = ai();
  const classes = ['model_unavailable', 'content_rejected', 'quota_exhausted', 'invalid_request', 'internal'];
  const texts = classes.map((failureClass) => userMessage({
    ok: false, failureClass, message: '', text: '', capWarning: '',
  }));
  for (const text of texts) assert.ok(text.length > 0, '每类失败都必须有文案');
  assert.equal(new Set(texts).size, classes.length, '五类文案必须互不相同');
  assert.match(AI_MESSAGES.model_unavailable, /稍后/u);
  assert.match(AI_MESSAGES.content_rejected, /安全/u);
  assert.match(AI_MESSAGES.quota_exhausted, /上限|额度/u);
});

test('AI 服务:成功时 userMessage 为空;传输失败映射为可读文案', () => {
  const { userMessage, transportMessage } = ai();
  assert.equal(userMessage({ ok: true, failureClass: '', message: '', text: '', capWarning: '' }), '');
  assert.match(transportMessage(new Error('FunctionName parameter could not be found')), /未部署|不可用/u);
  assert.match(transportMessage(new Error('request timeout')), /超时/u);
});

test('部门页:打开对话框出现欢迎语与 5 个选项,点选项进入对应详情,返回后对话还在', async () => {
  const cloud = cloudStub({});
  const wx = baseWx(cloud);
  const page = loadPage('departments', wx);
  assert.equal(page.data.view.items.length, 5, '部门列表与对话框互不影响');
  assert.equal(page.data.qaOpen, false);
  page.openQa();
  assert.equal(page.data.qaOpen, true);
  assert.equal(page.data.qaMessages.length, 1);
  assert.match(page.data.qaMessages[0].text, /你想了解什么部门/u);
  assert.equal(page.data.qaOptions.length, 5);
  page.pickDepartment({ currentTarget: { dataset: { id: 'student-union' } } });
  assert.ok(wx.actions.includes('navigateTo:/pages/departments/detail/index?id=student-union'));
  // 从详情返回后同一页面实例仍在,对话状态保留(openQa 不会重置消息)。
  page.openQa();
  assert.equal(page.data.qaMessages.length, 1);
});

test('部门页:追问成功后回答上屏,请求携带系统提示词(含语料)与历史', async () => {
  const cloud = cloudStub({
    chat: (data) => ({
      ok: true,
      failureClass: '',
      message: '',
      text: '校学生会设权益部、文娱部、器材部、体育部、学创部 5 大部门。',
      capWarning: '',
    }),
  });
  const wx = baseWx(cloud, {});
  const page = loadPage('departments', wx);
  page.openQa();
  page.onQaInput({ detail: { value: '校学生会下设哪些部门?' } });
  page.sendQuestion();
  await new Promise((resolve) => setImmediate(resolve));
  const call = cloud.calls.find((item) => item.name === 'ai' && item.data.action === 'chat');
  assert.ok(call, '追问必须调用 ai 云函数 chat 动作');
  assert.equal(call.data.feature, 'department-qa');
  assert.ok(call.data.system.includes('校学生团委'), '系统提示词必须携带语料');
  assert.ok(call.data.system.includes('官网未公布'), '系统提示词必须携带不编造纪律');
  assert.equal(call.data.messages.length, 2, '历史 = 欢迎语(助手) + 本轮提问(用户)');
  assert.equal(call.data.messages[1].text, '校学生会下设哪些部门?');
  assert.equal(page.data.qaMessages.length, 3, '成功 = 欢迎语 + 提问 + 回答');
  assert.equal(page.data.qaMessages[1].role, 'user');
  assert.match(page.data.qaMessages[2].text, /权益部/u);
  assert.equal(page.data.qaError, '');
  assert.equal(page.data.qaSending, false);
});

test('部门页:模型不可用时明确告知且文案独立,列表与选项仍可用', async () => {
  const cloud = cloudStub({
    chat: () => ({ ok: false, failureClass: 'model_unavailable', message: '', text: '', capWarning: '' }),
  });
  const wx = baseWx(cloud);
  const page = loadPage('departments', wx);
  page.openQa();
  page.onQaInput({ detail: { value: '校学生会是什么?' } });
  page.sendQuestion();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page.data.qaError, /暂时不可用/u);
  assert.doesNotMatch(page.data.qaError, /安全/u, '模型不可用的文案不得与内容被拒混淆');
  assert.equal(page.data.qaMessages.length, 2, '失败保留用户提问,但不产生假回答');
  assert.equal(page.data.qaMessages[1].role, 'user', '失败后不得追加助手回答');
  assert.equal(page.data.view.items.length, 5, '部门列表不受影响');
  assert.equal(page.data.qaOptions.length, 5, '选项仍可点');
});

test('部门页:内容被拒与额度用尽走各自的独立文案,额度告警透传', async () => {
  const cloud = cloudStub({
    chat: (data) => (data.messages[data.messages.length - 1].text === '触发额度'
      ? { ok: false, failureClass: 'quota_exhausted', message: '', text: '', capWarning: '' }
      : { ok: false, failureClass: 'content_rejected', message: '', text: '', capWarning: '本月用量已接近上限' }),
  });
  const wx = baseWx(cloud);
  const page = loadPage('departments', wx);
  page.openQa();
  page.onQaInput({ detail: { value: '违规内容' } });
  page.sendQuestion();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page.data.qaError, /安全/u);
  assert.equal(page.data.qaCapWarning, '本月用量已接近上限');
  page.onQaInput({ detail: { value: '触发额度' } });
  page.sendQuestion();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page.data.qaError, /上限|额度/u);
});

test('部门页:发送中不可重复发送,空输入不发起调用', async () => {
  const cloud = cloudStub({ chat: () => ({ ok: true, failureClass: '', message: '', text: '回答', capWarning: '' }) });
  const wx = baseWx(cloud);
  const page = loadPage('departments', wx);
  page.openQa();
  page.sendQuestion();
  assert.equal(cloud.calls.length, 0, '空输入不得调用云函数');
  page.onQaInput({ detail: { value: '   ' } });
  page.sendQuestion();
  assert.equal(cloud.calls.length, 0, '空白输入不得调用云函数');
});
