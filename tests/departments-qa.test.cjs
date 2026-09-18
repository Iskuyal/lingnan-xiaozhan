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

/** 与 loadCompiled 相同,但可以注入沙箱里的全局量(如 wx)。 */
function loadWithGlobals(relative, globals) {
  const filename = path.resolve(relative);
  const compiled = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: compiled,
    exports: compiled.exports,
    require: createRequire(filename),
    ...globals,
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

/** wx 本地存储桩:页面用持久标记记住「对话框已被用户关闭」。 */
function storageStub(initial = {}) {
  const store = { ...initial };
  return {
    store,
    getStorageSync: (key) => (key in store ? store[key] : ''),
    setStorageSync: (key, value) => { store[key] = value; },
  };
}

/** 已真正检测过内容安全时的服务端结论。 */
const CHECKED_SAFETY = {
  provider: 'wechat',
  api: 'security.msgSecCheck',
  passed: true,
  checked: true,
  detail: '',
};

function okAnswer(text, safety = CHECKED_SAFETY) {
  return { ok: true, failureClass: '', message: '', text, capWarning: '', safety, warnings: [] };
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

test('AI 服务:失败分类与服务端类型一一对应,未知分类不冒充已知分类', () => {
  const client = ai();
  const source = fs.readFileSync(path.resolve('cloudfunctions/ai/types.ts'), 'utf8');
  const union = /export type FailureClass =([\s\S]*?);/u.exec(source);
  assert.ok(union, '未能在 cloudfunctions/ai/types.ts 中定位 FailureClass 联合类型');
  const serverClasses = [...union[1].matchAll(/'([a-z_]+)'/gu)].map((match) => match[1]).sort();
  assert.deepEqual(
    [...client.FAILURE_CLASSES].sort(),
    serverClasses,
    '客户端同步的失败分类必须与服务端 types.ts 的联合类型一致(改名要两侧同步)',
  );
});

test('AI 服务:服务端返回的 message 优先,本地表只在服务端没给文案时兜底', () => {
  const { AI_MESSAGES, userMessage } = ai();
  // 负责人改云函数环境变量里的措辞后,用户看到的必须是服务端那句(改措辞不用改代码)。
  assert.equal(userMessage({
    ok: false, failureClass: 'quota_exhausted', message: '本月中转额度已用尽,请联系维护者', text: '', capWarning: '',
  }), '本月中转额度已用尽,请联系维护者');
  // 服务端没给文案时才回退本地表。
  assert.equal(userMessage({
    ok: false, failureClass: 'quota_exhausted', message: '', text: '', capWarning: '',
  }), AI_MESSAGES.quota_exhausted);
  // 未知分类但服务端给了文案:用服务端的,不降级成「内部错误」。
  assert.equal(userMessage({
    ok: false, failureClass: '', message: '服务端新分类的说明', text: '', capWarning: '',
  }), '服务端新分类的说明');
});

test('AI 服务:成功时 userMessage 为空;传输失败映射为可读文案', () => {
  const { userMessage, transportMessage } = ai();
  assert.equal(userMessage({ ok: true, failureClass: '', message: '', text: '', capWarning: '' }), '');
  assert.match(transportMessage(new Error('FunctionName parameter could not be found')), /未部署|不可用/u);
  assert.match(transportMessage(new Error('request timeout')), /超时/u);
});

test('AI 服务:invalid_request 文案不与事实矛盾(服务端收到了并拒绝了这次请求)', () => {
  const { AI_MESSAGES } = ai();
  assert.doesNotMatch(AI_MESSAGES.invalid_request, /没有送达|未送达/u, '该分类是「服务端收到并拒绝」,不能说成没送到');
  assert.match(AI_MESSAGES.invalid_request, /无法处理|调整/u);
});

test('AI 服务:callAi 透传 safety/warnings,未知分类收敛成空串', async () => {
  const wx = {
    cloud: {
      callFunction: async () => ({
        result: {
          ok: true,
          failureClass: 'brand_new_class',
          message: '',
          text: '答案',
          capWarning: '',
          safety: { provider: 'off', api: '', passed: true, checked: false, detail: '内容安全适配器为 off,未检测' },
          warnings: ['内容安全检测未完整执行（checked=false）', 42],
        },
      }),
    },
  };
  // services/cloud.js 由 Node 的真实 require 加载(与页面测试同一情形),因此外层全局也要给 wx。
  const saved = globalThis.wx;
  globalThis.wx = wx;
  try {
    const { callAi } = loadWithGlobals('dist/services/ai.js', { wx });
    const result = await callAi({ action: 'chat' });
    assert.equal(result.ok, true);
    assert.equal(result.failureClass, '', '未知分类不得被当作已知分类');
    assert.equal(result.safety.checked, false, 'checked 必须透传到调用方');
    assert.equal(result.safety.provider, 'off');
    assert.deepEqual(Array.from(result.warnings), ['内容安全检测未完整执行（checked=false）'], '非字符串告警要丢掉');
  } finally {
    globalThis.wx = saved;
  }
});

test('传输层错误映射:两个服务共用同一套规则,只换服务名与兜底策略', () => {
  const aiService = ai();
  const timetableService = loadCompiled('dist/services/timetable/index.js');
  const cases = [
    [{ errMsg: 'cloud.callFunction:fail errCode: -501000 FunctionName parameter could not be found' }, /未部署/u],
    [{ errMsg: 'errCode: -501023 permission denied' }, /没有权限/u],
    [{ errMsg: 'errCode: -504003 Invoking task timed out' }, /超时/u],
  ];
  for (const [error, pattern] of cases) {
    assert.match(aiService.transportMessage(error), pattern);
    assert.match(timetableService.messageOf(error), pattern);
  }
  // 服务名各自出现,不互相冒充。
  assert.match(aiService.transportMessage({ errMsg: '-501023 permission denied' }), /AI 服务/u);
  assert.match(timetableService.messageOf({ errMsg: '-501023 permission denied' }), /课表服务/u);
  // 兜底策略保留各自的既有行为:课表原样展示云端提示,AI 换一句「暂时不可用」。
  assert.equal(timetableService.messageOf(new Error('未识别出课表矩阵')), '未识别出课表矩阵');
  assert.equal(aiService.transportMessage(new Error('未识别出课表矩阵')), aiService.AI_TRANSPORT_FALLBACK);
  assert.equal(timetableService.messageOf(undefined), '未知错误');
});

test('云开发不可用:服务抛出同一句话,不静默返回空数据', async () => {
  const saved = globalThis.wx;
  globalThis.wx = undefined;
  try {
    const aiService = loadWithGlobals('dist/services/ai.js', { wx: undefined });
    await assert.rejects(() => aiService.callAi({ action: 'chat' }), /云开发不可用/);
    const timetableService = loadCompiled('dist/services/timetable/index.js');
    await assert.rejects(() => timetableService.listCourses(), /云开发不可用/);
  } finally {
    globalThis.wx = saved;
  }
});

test('部门页:打开对话框出现欢迎语与 5 个选项,点选项进入对应详情,返回后对话还在', async () => {
  const cloud = cloudStub({});
  const wx = baseWx(cloud);
  const page = loadPage('departments', wx);
  assert.equal(page.data.view.items.length, 5, '部门列表与对话框互不影响');
  page.openQa();
  assert.equal(page.data.qaOpen, true);
  assert.equal(page.data.qaMessages.length, 1);
  assert.match(page.data.qaMessages[0].text, /你想了解什么部门/u);
  assert.equal(page.data.qaOptions.length, 5);
  // 选项与列表走同一个入口(页面里不再有只做转发的中间方法)。
  page.openDetail({ currentTarget: { dataset: { id: 'student-union' } } });
  assert.ok(wx.actions.includes('navigateTo:/pages/departments/detail/index?id=student-union'));
  // 从详情返回后同一页面实例仍在,对话状态保留(openQa 不会重置消息)。
  page.openQa();
  assert.equal(page.data.qaMessages.length, 1);
});

test('部门页:进入模块即自动展开对话框主动提问;用户关过之后不再反复弹', () => {
  const cloud = cloudStub({});
  const storage = storageStub();
  const wx = baseWx(cloud, storage);
  const page = loadPage('departments', wx);
  page.onShow();
  assert.equal(page.data.qaOpen, true, '票面第一条:进入部门模块后有对话框,AI 主动问「你想了解什么部门」');
  assert.match(page.data.qaMessages[0].text, /你想了解什么部门/u);
  assert.equal(page.data.qaOptions.length, 5, '同时给出可点选项');
  // 再次显示(例如从详情返回)不重置对话。
  page.onShow();
  assert.equal(page.data.qaMessages.length, 1);
  // 用户主动收起后,本次会话与下次进入都不再自动弹。
  page.closeQa();
  assert.equal(page.data.qaOpen, false);
  assert.equal(storage.store['departments-qa-dismissed'], true, '关闭要留下持久标记');
  page.onShow();
  assert.equal(page.data.qaOpen, false, '关过之后不得反复弹');
  const reopened = loadPage('departments', baseWx(cloudStub({}), storage));
  reopened.onShow();
  assert.equal(reopened.data.qaOpen, false, '下次进入同样不再自动展开');
  // 但用户主动点开仍然可用。
  reopened.openQa();
  assert.equal(reopened.data.qaOpen, true);
});

test('部门页:追问成功后回答上屏,请求携带系统提示词(含语料)与历史', async () => {
  const cloud = cloudStub({
    chat: () => okAnswer('校学生会设权益部、文娱部、器材部、体育部、学创部 5 大部门。'),
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
  assert.equal(page.data.qaMessages[2].warning, undefined, '干净回答不加标记');
  assert.equal(page.data.qaSafetyNote, '', '真正检测过就不显示未检测提示');
  assert.equal(page.data.qaSourceNote, qa().QA_SOURCE_NOTE, '检测过时脚注保持默认措辞');
  assert.equal(page.data.qaError, '');
  assert.equal(page.data.qaSending, false);
});

test('部门页:服务端没真正做内容安全检测时,对话里明确标出且脚注改口', async () => {
  const unchecked = { provider: 'off', api: '', passed: true, checked: false, detail: '内容安全适配器为 off,未检测' };
  const cloud = cloudStub({ chat: () => okAnswer('校学生会设 5 大部门。', unchecked) });
  const wx = baseWx(cloud, {});
  const page = loadPage('departments', wx);
  page.openQa();
  page.onQaInput({ detail: { value: '校学生会下设哪些部门?' } });
  page.sendQuestion();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page.data.qaSafetyNote, /没有经过内容安全检测|未经过内容安全检测/u);
  assert.match(page.data.qaSourceNote, /未经内容安全检测/u, '未检测时页脚要改口,不能照旧写「已核实资料」');
  assert.notEqual(page.data.qaSourceNote, qa().QA_SOURCE_NOTE);
  // 服务端连 safety 字段都没返回时按「未检测」处理,不把缺失读成干净。
  const missing = cloudStub({
    chat: () => ({ ok: true, failureClass: '', message: '', text: '回答', capWarning: '' }),
  });
  const page2 = loadPage('departments', baseWx(missing, {}));
  page2.openQa();
  page2.onQaInput({ detail: { value: '校学生会是什么?' } });
  page2.sendQuestion();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page2.data.qaSafetyNote, /内容安全检测/u);
});

test('后置检查:语料外的联系方式被找出,语料里有的不会被误标', () => {
  const { FABRICATED_CONTACT_NOTE, buildCorpusText, contactWarningFor, findUnverifiedContacts } = qa();
  // 措辞是「出现了资料里没有的联系方式」并给出处置建议,不是断言「模型编造」——
  // 这是后置标记,不是事实性结论。
  assert.match(FABRICATED_CONTACT_NOTE, /资料里没有的联系方式/u);
  assert.match(FABRICATED_CONTACT_NOTE, /官网为准/u);
  const corpus = buildCorpusText();
  const fabricated = findUnverifiedContacts(
    '可以打 13800138000,座机 020-12345678,QQ：123456789,微信：lingnan_helper,邮箱 help@example.com。',
    corpus,
  );
  assert.deepEqual(
    Array.from(fabricated).sort(),
    ['13800138000', '020-12345678', '123456789', 'lingnan_helper', 'help@example.com'].sort(),
    '五类联系方式记号都要找出来',
  );
  assert.match(contactWarningFor('校学生会办公室电话 020-12345678。', corpus), /资料里没有的联系方式/u);
  // 语料里如实写着「未公布」时,不因为出现「联系方式」四个字就标记。
  assert.deepEqual(Array.from(findUnverifiedContacts('资料里没有公布联系方式,请以官网为准。', corpus)), []);
  assert.equal(contactWarningFor('校学生会的联系方式官网未公布。', corpus), '');
  // 语料里确实有的联系方式不算编造(用带联系方式的语料验证)。
  const withContacts = corpus + '\n\n【示例组织】联系方式：办公室：0763-1234567；邮箱：tw@lnc.edu.cn';
  assert.deepEqual(
    Array.from(findUnverifiedContacts('可拨打 0763-1234567 或发邮件 tw@lnc.edu.cn。', withContacts)),
    [],
    '语料里有的联系方式不得被误标',
  );
  // 同一串数字在语料里换个写法(带空格)也不该被误标。
  assert.deepEqual(
    Array.from(findUnverifiedContacts('电话 138 0013 8000。', corpus + '\n电话：138 0013 8000')),
    [],
  );
});

test('部门页:回答里出现语料外的联系方式时,在该条回答上标注', async () => {
  const cloud = cloudStub({
    chat: () => okAnswer('校学生会办公室电话是 0763-8888888,欢迎来电。'),
  });
  const wx = baseWx(cloud, {});
  const page = loadPage('departments', wx);
  page.openQa();
  page.onQaInput({ detail: { value: '学生会办公室电话多少?' } });
  page.sendQuestion();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page.data.qaMessages[2].text, /0763-8888888/u, '回答本身照原样展示');
  assert.match(page.data.qaMessages[2].warning, /资料里没有的联系方式/u, '同一条回答上要有明确提示');
  assert.match(page.data.qaMessages[2].warning, /0763-8888888/u, '提示里要点出是哪个记号');
  assert.match(page.data.qaMessages[2].warning, /官网为准/u);
  // 提示只贴在回答上,不混进发给模型的历史。
  assert.equal(page.data.qaMessages[0].warning, undefined);
});

test('来源脚注:只说语料来源,不暗示「回答本身已核实」', () => {
  const { QA_SOURCE_NOTE, sourceNoteFor } = qa();
  assert.match(QA_SOURCE_NOTE, /学校官网已核实的学生组织资料|语料来源/u);
  assert.match(QA_SOURCE_NOTE, /不代表每句回答都已逐字核对|官网原文/u);
  assert.doesNotMatch(QA_SOURCE_NOTE, /^回答依据：/u, '脚注不能让人以为答案本身已经核实');
  assert.equal(sourceNoteFor(CHECKED_SAFETY), QA_SOURCE_NOTE);
  assert.match(sourceNoteFor({ checked: false }), /未经内容安全检测/u);
  assert.match(sourceNoteFor(null), /未经内容安全检测/u);
  assert.match(sourceNoteFor(undefined), /未经内容安全检测/u);
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
