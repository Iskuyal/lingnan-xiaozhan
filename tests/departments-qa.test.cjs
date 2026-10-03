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
  const messages = chatMessages(history, '');
  assert.equal(messages.length, 20);
  assert.deepEqual(plain(messages[0]), { role: 'assistant', text: '消息1' });
  assert.deepEqual(plain(messages[19]), { role: 'user', text: '消息20' });
  assert.deepEqual(plain(chatMessages([], '')), []);
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
    // 小程序运行时有 setTimeout/clearTimeout；vm 的新上下文默认不带 Node 的定时器，
    // 而 services/ai.ts 的 callAi 会给云调用套一层客户端超时（AI_CALL_TIMEOUT_MS），
    // 因此这里必须把定时器显式注入沙箱，否则测的不是小程序的运行环境。
    const { callAi } = loadWithGlobals('dist/services/ai.js', { wx, setTimeout, clearTimeout });
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

// ---------------------------------------------------------------------------
// 以下为 PR #29 移植部分（防幻觉守卫、详情页问答面板、会话共享）的测试。
// 原作者 SU5114；守卫的联系方式一路与上面既有的记号扫描合并成一套。
// ---------------------------------------------------------------------------

const departmentsOf = () => loadCompiled('dist/services/departments.js').listDepartments();
const findDepartment = (id) => departmentsOf().find((item) => item.id === id);
/** 页面共用的会话是模块级状态：拿到页面 require 的同一份实例，用例之间先清空。 */
const sharedQa = () => createRequire(path.resolve('dist/pages/departments/index.js'))('./qa');

test('防幻觉守卫:未公布字段上的编造整条替换,并记下命中类别', () => {
  const { guardAnswer, unsupportedAnswerText } = qa();
  const union = findDepartment('student-union');
  const fallback = unsupportedAnswerText(union, [{ reason: '负责人表述', token: '负责人' }]);
  assert.ok(fallback.includes('官网未公布'), '替换文案必须明确说「官网未公布」');
  assert.ok(fallback.includes('校学生会'), '替换文案要点名是哪个部门');
  assert.ok(fallback.includes('负责人'), '替换文案要点出命中的类别');
  const fabricated = [
    ['校学生会的联系电话是 020-22305555，欢迎咨询。', '联系方式记号'],
    ['可以发邮件到 xsh@example.edu.cn 联系。', '联系方式记号'],
    ['负责人是张三，有问题找他。', '负责人表述'],
    ['校学生会位于广州校区。', '校区表述'],
    ['校学生会成立于 2019 年。', '成立时间'],
    ['详见 https://example.com/student-union 的介绍。', '资料外链接'],
    ['联系方式：微信公众号「岭南学生会」', '联系方式表述'],
    // 2026-09-19 两轴复核发现的两条绕过路径：校区名不只「广州 / 清远」，人员称谓也不只「负责人」。
    ['校学生会的办公室在增城校区。', '校区表述'],
    ['校学生会主席张三主持工作。', '负责人表述'],
    ['该组织的李四部长负责对接。', '负责人表述'],
    ['由王五会长牵头。', '负责人表述'],
    ['李明老师负责指导。', '负责人表述'],
  ];
  for (const [answer, reason] of fabricated) {
    const result = guardAnswer(answer, { department: union });
    assert.equal(result.replaced, true, `未拦下编造内容：${answer}`);
    assert.ok(result.reasons.includes(reason), `${answer} 的命中原因应为 ${reason}，实际 ${result.reasons}`);
    assert.ok(result.text.includes('官网未公布'), '替换后的文本必须是如实回答');
    assert.ok(result.text.includes('校学生会'), '替换文案点名是哪个部门的回答');
    assert.ok(result.note.length > 0, '命中后要有提示行说明这条回答被复核过');
  }
});

test('防幻觉守卫:资料支持的如实回答原样放行,不误伤', () => {
  const { guardAnswer } = qa();
  const union = findDepartment('student-union');
  const volunteers = findDepartment('young-volunteers');
  const veteran = findDepartment('veteran-affairs-service');
  const grounded = [
    [union, '校学生会设权益部、文娱部、器材部、体育部、学创部 5 个部门。'],
    [union, '官网未公布校学生会的联系方式，页面上只有来源链接可以核对。'],
    [union, '组织架构是「主席团+工作部门」模式，围绕思想引领和服务同学开展工作。'],
    [union, '校学生会的所属校区官网未公布。'],
    [union, '资料里没有该组织的负责人信息，可以打开来源链接自行核对。'],
    [volunteers, '青年志愿者联合会据活动报道在广州校区、清远校区都有志愿服务队。'],
    [veteran, '退役军人事务服务部成立于 2022 年 5 月，由退役大学生组成。'],
    [union, `资料来源：${union.sourceUrl}`],
    [union, '活动动态里有「对话榜样」这篇报道（2026-06-30）。'],
    // 「主席团」是语料原文（「主席团+工作部门」），不能因为出现「主席」二字就拦。
    [union, '组织架构为「主席团+工作部门」模式，设 5 大部门。'],
    // 语料里有「广清两校区」的写法（校区依据说明），指同两处校区，不算编造。
    [volunteers, '据 2026-03-10 的活动报道，广清两校区的青年志愿者联合会都有志愿服务队。'],
  ];
  for (const [department, answer] of grounded) {
    const result = guardAnswer(answer, { department });
    assert.equal(result.replaced, false, `误伤了如实回答：${answer}（${result.reasons}）`);
    assert.equal(result.text, answer);
    assert.equal(result.note, '');
  }
});

test('防幻觉守卫:问的是未公布字段时,含糊拒答也要换成官网未公布', () => {
  const { guardAnswer } = qa();
  const union = findDepartment('student-union');
  const volunteers = findDepartment('young-volunteers');
  const veteran = findDepartment('veteran-affairs-service');
  // 回避式回答不算回答了「官网未公布」：验收要求这类信息明确说出来（2026-09-19 两轴复核补）。
  const vague = ['我不清楚，建议你问问学校。', '抱歉，这个问题我无法回答。', '可以到学校官网自行查找。'];
  for (const answer of vague) {
    const result = guardAnswer(answer, { department: union, question: '校学生会的联系方式是什么？' });
    assert.equal(result.replaced, true, `含糊拒答未纠正：${answer}`);
    assert.ok(result.reasons.includes('含糊作答'), `命中原因应为含糊作答，实际 ${result.reasons}`);
    assert.ok(result.text.includes('官网未公布'), '替换后必须明确回答官网未公布');
  }
  // 如实回答（含否定表述）照常放行。
  const honest = ['官网未公布该组织的联系方式。', '资料里没有收录联系方式，无法提供。', '暂无公开的联系方式。'];
  for (const answer of honest) {
    const result = guardAnswer(answer, { department: union, question: '校学生会的联系方式是什么？' });
    assert.equal(result.replaced, false, `误伤了如实回答：${answer}（${result.reasons}）`);
  }
  // 问的是已公布字段、或该字段在本部门已公布时不强制：不能因为没说「官网未公布」就替换。
  assert.equal(
    guardAnswer('设权益部、文娱部、器材部、体育部、学创部。', { department: union, question: '下设哪些部门？' }).replaced,
    false,
  );
  assert.equal(
    guardAnswer('在广州校区、清远校区都有志愿服务队。', { department: volunteers, question: '属于哪个校区？' }).replaced,
    false,
  );
  assert.equal(
    guardAnswer('成立于 2022 年 5 月。', { department: veteran, question: '什么时候成立的？' }).replaced,
    false,
  );
  // 没有部门上下文时不强制（列表页的自由提问认不出是哪个部门）。
  assert.equal(guardAnswer('我不清楚。', { question: '校学生会的联系方式是什么？' }).replaced, false);
});

test('防幻觉守卫:联系方式只用一套规则,与 findUnverifiedContacts 同源', () => {  const { buildCorpusText, contactWarningFor, findUnverifiedContacts, guardAnswer } = qa();
  const corpus = buildCorpusText();
  const answer = '可以打 13800138000，座机 020-12345678，QQ：123456789，微信：lingnan_helper，邮箱 help@example.com。';
  const tokens = Array.from(findUnverifiedContacts(answer, corpus));
  assert.equal(tokens.length, 5, '五类记号都要找出来');
  const result = guardAnswer(answer, { corpus });
  assert.equal(result.replaced, true, '语料外的联系方式要触发整条替换');
  const hits = Array.from(result.hits)
    .filter((hit) => hit.reason === '联系方式记号')
    .map((hit) => hit.token)
    .sort();
  assert.deepEqual(hits, tokens.slice().sort(), '守卫与记号清单必须出自同一套规则');
  for (const token of tokens) {
    assert.ok(result.text.includes(token), `替换文案要点出命中的记号：${token}`);
  }
  assert.equal(result.note, contactWarningFor(answer, corpus), '联系方式命中的提示行沿用既有的记号级措辞');
  // 语料里确实有的联系方式不算编造（同一套规则的另一面）。
  const withContacts = corpus + '\n\n【示例组织】联系方式：办公室：0763-1234567；邮箱：tw@lnc.edu.cn';
  assert.deepEqual(
    Array.from(findUnverifiedContacts('可拨打 0763-1234567 或发邮件 tw@lnc.edu.cn。', withContacts)),
    [],
  );
  assert.equal(
    guardAnswer('可拨打 0763-1234567 或发邮件 tw@lnc.edu.cn。', { corpus: withContacts }).replaced,
    false,
    '语料里有的联系方式不得触发替换',
  );
});

test('防幻觉守卫:拦不下什么必须如实写在测试里（裸姓名、招新时间）', () => {
  const { guardAnswer } = qa();
  const union = findDepartment('student-union');
  // 这些是守卫的已知盲区：命中只认关键词与记号，裸内容管不了。文档口径与这里一致，
  // 评估时不得因为「加了守卫」就放宽防幻觉判定。
  const blind = [
    '张三负责日常值班，有问题可以找他。',
    '招新时间是 9 月 1 日到 9 月 10 日。',
    '报名截止到 2026 年 9 月 30 日，请留意通知。',
  ];
  for (const answer of blind) {
    const result = guardAnswer(answer, { department: union });
    assert.equal(result.replaced, false, `这条本就不该被守卫命中（是已知盲区，不是回归）：${answer}`);
    assert.deepEqual(Array.from(result.reasons), []);
  }
});

test('防幻觉守卫:校区检查按「回答在讲哪个部门」判定，列表页也能认出唯一组织', () => {
  const { guardAnswer } = qa();
  const union = findDepartment('student-union');
  const campusLine = '校学生会位于广州校区。';
  // 有部门上下文：该部门资料写明未标注校区 → 任何校区名都是编造。
  assert.equal(guardAnswer(campusLine, { department: union }).replaced, true);
  // 列表页没给部门，但回答里只提到一个组织 → 按那个组织判定（编造校区多是「安上别的组织的校区」）。
  assert.equal(guardAnswer(campusLine).replaced, true, '认得出是校学生会就该按校学生会判定');
  // 语料里有校区依据的组织：资料写明的校区不算编造。
  assert.equal(
    guardAnswer('青年志愿者联合会据活动报道在广州校区、清远校区都有志愿服务队。').replaced,
    false,
  );
  // 一个组织都认不出来时退回语料级判定：语料里出现过的校区名放行（已知弱点，文档有写）。
  assert.equal(guardAnswer('这个组织在广州校区有活动。').replaced, false);
});

test('送进模型的历史保留模型原话,守卫只替换上屏的回答', async () => {
  const cloud = cloudStub({ chat: () => okAnswer('校学生会的联系电话是 020-22305555。') });
  const wx = baseWx(cloud, {});
  const page = loadPage('departments', wx);
  page.openQa();
  page.onQaInput({ detail: { value: '怎么联系校学生会？' } });
  page.sendQuestion();
  await new Promise((resolve) => setImmediate(resolve));
  const shown = page.data.qaMessages[2];
  assert.equal(shown.replaced, true, '命中守卫的回答要标记成已替换');
  assert.equal(shown.modelText, '校学生会的联系电话是 020-22305555。', '模型原话要留在轮次里');
  assert.ok(shown.text.includes('官网未公布'), '上屏的是如实回答');
  assert.ok(shown.text.includes('020-22305555'), '替换文案点出命中的记号（main 既有提示口径）');
  assert.match(shown.warning, /资料里没有的联系方式/u);
  // 第二轮：送进模型的历史是模型原话，不是替换后的上屏文本。
  page.onQaInput({ detail: { value: '那邮箱呢？' } });
  page.sendQuestion();
  await new Promise((resolve) => setImmediate(resolve));
  const sent = cloud.calls[1].data.messages.filter((message) => message.role === 'assistant');
  assert.ok(
    sent.some((message) => message.text.includes('020-22305555')),
    '历史里要保留模型原话，才不算改写模型的上下文',
  );
  assert.ok(
    sent.every((message) => !message.text.includes('已按「官网未公布」处理')),
    '替换文案不得混进送进模型的历史',
  );
});

test('详情页:进入自动展开一次、可收起且关过不再弹,追问建议与输入框可用', async () => {
  sharedQa().resetAllConversations();
  // 回答要如实说明「官网未公布」：这条追问问的是未公布字段，含糊回答会被守卫替换
  // （见「问的是未公布字段时,含糊拒答也要换成官网未公布」），所以这里按真实模型的正常回答来铺。
  const cloud = cloudStub({ chat: () => okAnswer('校学生会的联系方式官网未公布；下设权益部、文娱部、器材部、体育部、学创部 5 个部门。') });
  const storage = storageStub();
  const wx = baseWx(cloud, storage);
  const page = loadPage('departments/detail', wx);
  page.onLoad({ id: 'student-union' });
  page.onShow();
  assert.equal(page.data.qaOpen, true, '进入详情页自动展开一次');
  assert.match(page.data.qaPrompt, /关于校学生会/u, '详情页提示要把范围收到这个部门');
  assert.match(page.data.qaPrompt, /官网未公布/u, '提示要说明资料里没有的会答什么');
  assert.equal(page.data.qaSuggestionList.length, 4, '追问建议 4 条');
  assert.equal(page.data.qaMessages.length, 1, '开场只有提示语');
  page.onShow();
  assert.equal(page.data.qaMessages.length, 1, '再次显示不重置对话');
  // 点追问建议 = 填入并发送。
  await page.askSuggestion({ currentTarget: { dataset: { text: '校学生会的联系方式是什么？' } } });
  assert.equal(cloud.calls.length, 1);
  assert.equal(cloud.calls[0].data.action, 'chat');
  assert.equal(cloud.calls[0].data.feature, 'department-qa');
  assert.equal(cloud.calls[0].data.messages[1].text, '校学生会的联系方式是什么？');
  assert.equal(page.data.qaMessages.length, 3);
  assert.match(page.data.qaMessages[2].text, /权益部/u);
  assert.equal(page.data.qaMessages[2].warning, undefined, '干净回答不加标记');
  assert.equal(page.data.qaInput, '');
  assert.equal(page.data.qaError, '');
  // 收起 → 关过不再弹；用户主动打开仍可用。
  page.closeQa();
  assert.equal(page.data.qaOpen, false);
  assert.equal(storage.store['departments-qa-dismissed'], true, '关闭要留下同一条持久标记');
  const again = loadPage('departments/detail', baseWx(cloudStub({}), storage));
  again.onLoad({ id: 'student-union' });
  again.onShow();
  assert.equal(again.data.qaOpen, false, '关过之后不再自动弹');
  again.openQa();
  assert.equal(again.data.qaOpen, true, '用户主动打开仍然可用');
});

test('详情页:未知部门不给对话框,模型不可用时给降级说明且资料照常展示', async () => {
  sharedQa().resetAllConversations();
  const missing = loadPage('departments/detail', baseWx(cloudStub({})));
  missing.onLoad({ id: 'not-a-department' });
  assert.equal(missing.data.notFound, true);
  assert.equal(missing.data.qaOpen, false, '未找到部门不自动展开对话框');
  missing.onShow();
  assert.equal(missing.data.qaOpen, false);

  const cloud = cloudStub({
    chat: () => ({ ok: false, failureClass: 'model_unavailable', message: '', text: '', capWarning: '' }),
  });
  const page = loadPage('departments/detail', baseWx(cloud));
  page.onLoad({ id: 'student-union' });
  page.onShow();
  page.onQaInput({ detail: { value: '校学生会是什么？' } });
  page.sendQuestion();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page.data.qaError, /暂时不可用/u);
  assert.doesNotMatch(page.data.qaError, /安全/u, '模型不可用的文案不得与内容被拒混淆');
  assert.match(page.data.qaOfflineNote, /仍可正常查看/u, '降级时要说明部门资料仍可查看');
  assert.equal(page.data.qaMessages.length, 2, '失败保留提问，但不产生假回答');
  assert.equal(page.data.detail.name, '校学生会', 'AI 失败不影响部门资料');
  // 收起再打开不重置详情页的对话（列表页是重置，详情页是接着问）。
  page.closeQa();
  page.openQa();
  assert.equal(page.data.qaMessages.length, 2);
  // 「重新开始对话」才清空。
  page.restartConversation();
  assert.equal(page.data.qaMessages.length, 1);
});

test('部门问答会话:详情页追问后返回列表，对话不丢且可在列表页接着问', async () => {
  sharedQa().resetAllConversations();
  const cloud = cloudStub({ chat: () => okAnswer('设权益部、文娱部、器材部、体育部、学创部 5 个部门。') });
  const list = loadPage('departments', baseWx(cloud));
  list.onShow();
  assert.equal(list.data.qaMessages.length, 1);
  // 点选项进入该部门：对话跟着人去那个部门。
  list.openDetail({ currentTarget: { dataset: { id: 'student-union' } } });
  assert.equal(list.data.qaDepartmentId, 'student-union');

  const detail = loadPage('departments/detail', baseWx(cloud));
  detail.onLoad({ id: 'student-union' });
  detail.onShow();
  await detail.askSuggestion({ currentTarget: { dataset: { text: '校学生会下设哪些部门？' } } });

  // 返回列表：onShow 重新读共享会话，问答还在。
  list.onShow();
  assert.equal(list.data.qaMessages.length, 3, '返回列表后对话不丢');
  assert.equal(list.data.qaMessages[1].role, 'user');
  assert.match(list.data.qaMessages[2].text, /权益部/u);
  assert.equal(list.data.qaMessages[0].warning, undefined, '提示行只贴在回答上');
  // 列表页接着问：同一份会话，历史里带着上一轮。
  list.onQaInput({ detail: { value: '这个部门的联系方式呢？' } });
  list.sendQuestion();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cloud.calls.length, 2);
  assert.equal(cloud.calls[1].data.messages.length, 4, '历史 = 开场 + 上一轮 + 本轮');
  assert.equal(cloud.calls[1].data.messages[3].text, '这个部门的联系方式呢？');
  assert.equal(list.data.qaMessages.length, 5);
  // 不同部门的对话分开存放，不互相污染。
  const other = loadPage('departments/detail', baseWx(cloudStub({})));
  other.onLoad({ id: 'young-volunteers' });
  other.onShow();
  assert.equal(other.data.qaMessages.length, 1, '另一个部门从开场白开始');
  assert.match(other.data.qaPrompt, /关于青年志愿者联合会/u);
});

test('两个部门页面共用一份问答模板与样式，产物里带上这两个文件', () => {
  const listWxml = fs.readFileSync('miniprogram/pages/departments/index.wxml', 'utf8');
  const detailWxml = fs.readFileSync('miniprogram/pages/departments/detail/index.wxml', 'utf8');
  assert.match(listWxml, /<import src="\.\/qa\.wxml"/u);
  assert.match(detailWxml, /<import src="\.\.\/qa\.wxml"/u);
  for (const content of [listWxml, detailWxml]) {
    assert.match(content, /<template\s+is="department-qa"/u);
  }
  assert.match(fs.readFileSync('miniprogram/pages/departments/index.wxss', 'utf8'), /@import "\.\/qa\.wxss"/u);
  assert.match(fs.readFileSync('miniprogram/pages/departments/detail/index.wxss', 'utf8'), /@import "\.\.\/qa\.wxss"/u);
  for (const file of ['qa.wxml', 'qa.wxss']) {
    assert.ok(fs.existsSync(`dist/pages/departments/${file}`), `构建产物缺少 ${file}`);
  }
  // 开发者工具验收按这些 id 找元素，模板里必须留着。
  const template = fs.readFileSync('miniprogram/pages/departments/qa.wxml', 'utf8');
  for (const id of ['qa-prompt', 'qa-option-{{item.id}}', 'qa-input', 'qa-send',
    'qa-suggestion-{{index}}', 'qa-transcript', 'qa-restart', 'qa-offline']) {
    assert.ok(template.includes(id), `问答模板缺少 ${id}`);
  }
  // 验收脚本靠 .qa-answer 数「回答/提示」气泡（排除开场提示与「正在回答」），锁住这个标记。
  assert.match(
    template,
    /class="qa-row qa-row-\{\{item\.role\}\} \{\{item\.role === 'assistant' \? 'qa-answer' : ''\}\}"/u,
    '助手气泡缺少 qa-answer 标记，验收脚本会数错气泡',
  );
  // 降级说明必须是「模型不可用」这条路径上渲染的（脚本按 #qa-offline 判定）。
  const offlineLine = template.split('\n').find((line) => line.includes('id="qa-offline"'));
  assert.ok(offlineLine !== undefined && offlineLine.includes('qaError'), '降级说明要绑定在失败状态上');
});

test('对话框视图:列表页给提示语与 5 个可点选项,详情页给追问建议与离线说明', () => {
  const qaModule = qa();
  const welcome = qaModule.buildWelcome('student-union');
  assert.match(welcome.text, /你想了解什么部门/u);
  assert.match(welcome.text, /官网未公布/u, '开场提示要说明资料里没有的会答什么');
  assert.equal(welcome.options.length, 5);
  assert.equal(welcome.options.find((option) => option.id === 'student-union').active, true);
  assert.ok(welcome.options.every((option) => option.campusLabel.length > 0), '选项要带校区说明');

  const list = qaModule.qaPanelPatch({ departmentId: '', withOptions: true });
  assert.equal(list.qaOptions.length, 5);
  assert.equal(list.qaSuggestionList.length, 0, '列表页不显示追问建议');
  assert.equal(list.qaMessages.length, 1);
  assert.match(list.qaMessages[0].text, /你想了解什么部门/u);

  const detail = qaModule.qaPanelPatch({ departmentId: 'student-union' });
  assert.equal(detail.qaOptions.length, 0, '详情页不再列一遍部门选项');
  assert.equal(detail.qaSuggestionList.length, 4);
  assert.match(detail.qaPrompt, /关于校学生会/u);
  assert.match(detail.qaOfflineNote, /仍可正常查看/u);
  assert.equal(detail.qaOfflineNote, qaModule.QA_OFFLINE_NOTE);
  assert.deepEqual(
    Array.from(qaModule.qaPanelPatch({ departmentId: 'not-a-department' }).qaSuggestionList),
    [],
  );
});

test('历史映射:被替换的回答用模型原话,裁剪与字段收窄仍由 services/ai.ts 负责', () => {
  const { MAX_HISTORY, historyMessages } = qa();
  const history = [
    { role: 'assistant', text: '开场' },
    { role: 'user', text: '问题' },
    { role: 'assistant', text: '替换后的如实回答', modelText: '模型原话（编造的号码 020-22305555）', replaced: true, warning: '提示行' },
  ];
  assert.deepEqual(plain(historyMessages(history, '')), [
    { role: 'assistant', text: '开场' },
    { role: 'user', text: '问题' },
    { role: 'assistant', text: '模型原话（编造的号码 020-22305555）' },
  ], '替换文案与标记都不进历史');
  const many = [];
  for (let index = 0; index < MAX_HISTORY + 4; index += 1) {
    many.push({ role: index % 2 === 0 ? 'user' : 'assistant', text: `消息${index}` });
  }
  assert.equal(historyMessages(many, '').length, MAX_HISTORY);
});
