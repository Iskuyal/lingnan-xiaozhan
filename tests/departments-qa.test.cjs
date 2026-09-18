const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// 部门问答（Ticket 07）：服务层的纯函数与页面编排在这里验证。
// 云函数（模型调用、内容安全、失败分类）的行为在 Ticket 01 的测试里验证，本文件只断言
// 「事件按调用契约发出、失败按分类显示、模型输出经防幻觉复核」。
const qa = () => require('../dist/services/departments-qa.js');
const departmentsOf = () => require('../dist/services/departments.js').listDepartments();

const IDS = [
  'student-youth-league',
  'student-union',
  'student-club-management',
  'young-volunteers',
  'veteran-affairs-service',
];

const find = (id) => departmentsOf().find((item) => item.id === id);

function bubble(role, text, extra = {}) {
  return {
    id: `${role}-${text}`,
    role,
    text,
    source: '',
    isNotice: false,
    failureClass: '',
    replaced: false,
    ...extra,
  };
}

function resetStore(store) {
  for (const id of IDS) store.reset(id);
  store.setActive('');
}

function instantiate(options) {
  const page = { ...options, data: JSON.parse(JSON.stringify(options.data ?? {})) };
  page.setData = (patch) => Object.assign(page.data, patch);
  return page;
}

/** 页面测试：把构建产物里的页面定义装进 vm，wx 与云函数都换成桩。 */
function loadPage(route, wx, query) {
  globalThis.wx = wx;
  const filename = path.resolve(`dist/pages/${route}/index.js`);
  let page;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: (options) => { page = instantiate(options); },
    wx,
    getCurrentPages: () => [{}, {}],
    require: createRequire(filename),
    exports: {},
    console,
    setTimeout,
    clearTimeout,
  }, { filename });
  if (query !== undefined && typeof page.onLoad === 'function') page.onLoad(query);
  return page;
}

/** 云调用桩：把 wx.cloud.callFunction 的结果按预设脚本返回，并记录每次事件。 */
function cloudStub(reply) {
  const calls = [];
  const wx = {
    cloud: {
      callFunction(options) {
        calls.push(options.data);
        const result = typeof reply === 'function' ? reply(options.data) : reply;
        if (result instanceof Error) return Promise.reject(result);
        return Promise.resolve({ result });
      },
    },
    navigateTo: () => {},
  };
  return { wx, calls };
}

test('提示词把该部门的已核实资料整段交给模型，未公布字段写成官网未公布', () => {
  const { buildSystemPrompt } = qa();
  for (const department of departmentsOf()) {
    const prompt = buildSystemPrompt(department);
    assert.ok(prompt.includes(department.name), `${department.name}: 提示词缺组织名称`);
    assert.ok(prompt.includes(department.introduction), `${department.name}: 提示词缺组织介绍`);
    assert.ok(prompt.includes(department.units[0]), `${department.name}: 提示词缺下设部门`);
    assert.ok(prompt.includes('官网未公布'), `${department.name}: 提示词没有写明未公布时的回答`);
    assert.ok(!prompt.includes('你说'), `${department.name}: 提示词混入了对话内容`);
    if (department.contacts.length === 0) {
      assert.match(prompt, /- 联系方式：官网未公布/u, `${department.name}: 未公布联系方式时未如实标注`);
    }
  }
  // 有依据的字段要写依据，没有依据的字段不能凭空补全。
  assert.match(buildSystemPrompt(find('young-volunteers')), /- 所属校区：广州校区、清远校区/u);
  assert.match(buildSystemPrompt(find('student-union')), /- 所属校区：官网未公布/u);
  assert.match(buildSystemPrompt(find('veteran-affairs-service')), /- 成立时间：2022 年 5 月/u);
  assert.match(buildSystemPrompt(find('student-union')), /- 成立时间：官网未公布/u);
});

test('追问建议覆盖已公布与未公布字段，未公布的那条用于演示官网未公布', () => {
  const { suggestQuestions } = qa();
  const questions = suggestQuestions(find('student-union'));
  assert.equal(questions.length, 4);
  assert.match(questions[0], /下设哪些部门/u);
  assert.ok(questions.some((item) => item.includes('联系方式')), '缺少会触发「官网未公布」的追问');
  for (const item of questions) assert.ok(item.includes('校学生会'), `追问建议缺少组织名：${item}`);
});

test('送到云函数的事件符合 Ticket 01 的调用契约', () => {
  const { buildQaRequest, AI_FUNCTION_NAME, QA_FEATURE } = qa();
  assert.equal(AI_FUNCTION_NAME, 'ai');
  assert.equal(QA_FEATURE, 'department-qa');
  const request = buildQaRequest(find('student-union'), [
    bubble('user', '学生会下设哪些部门？'),
    bubble('assistant', '设权益部、文娱部、器材部、体育部、学创部。'),
    bubble('assistant', 'AI 助手暂时不可用', { isNotice: true, failureClass: 'model_unavailable' }),
  ]);
  assert.equal(request.action, 'chat');
  assert.equal(request.feature, QA_FEATURE);
  assert.ok(String(request.system).includes('校学生会'));
  assert.deepEqual(request.messages, [
    { role: 'user', text: '学生会下设哪些部门？' },
    { role: 'assistant', text: '设权益部、文娱部、器材部、体育部、学创部。' },
  ]);
});

test('历史裁剪到 12 条以内、以 user 起头，失败提示不进模型上下文', () => {
  const { trimMessages, MAX_REQUEST_MESSAGES } = qa();
  const many = [];
  for (let index = 0; index < 9; index += 1) {
    many.push(bubble('user', `问 ${index}`));
    many.push(bubble('assistant', `答 ${index}`));
  }
  const trimmed = trimMessages(many);
  assert.equal(trimmed.length, MAX_REQUEST_MESSAGES);
  assert.equal(trimmed[0].role, 'user');
  assert.equal(trimmed[trimmed.length - 1].text, '答 8');
  // 裁剪后若首条是助手回答，必须继续丢弃，保证对话以 user 起头。
  assert.equal(trimMessages([bubble('assistant', '单独一条回答')]).length, 0);
  assert.equal(trimMessages([bubble('assistant', '旧回答'), bubble('user', '新问题')])[0].text, '新问题');
});

test('防幻觉守卫：资料里没有的联系方式、校区、成立时间、负责人、外链一律拦下', () => {
  const { guardAnswer, unsupportedAnswerText } = qa();
  const union = find('student-union');
  const unionFallback = unsupportedAnswerText(union);
  assert.ok(unionFallback.includes('官网未公布'), '替换文案必须明确说官网未公布');

  const fabricated = [
    ['校学生会的联系电话是 020-22305555，欢迎咨询。', 'contact'],
    ['可以发邮件到 xsh@example.edu.cn 联系。', 'contact'],
    ['负责人是张三，有问题找他。', 'role'],
    ['校学生会位于广州校区。', 'campus'],
    ['校学生会成立于 2019 年。', 'founded'],
    ['详见 https://example.com/student-union 的介绍。', 'link'],
    ['联系方式：微信公众号「岭南学生会」', 'contact-term'],
  ];
  for (const [answer, reason] of fabricated) {
    const result = guardAnswer(answer, union);
    assert.ok(result.replaced, `未拦下编造内容：${answer}`);
    assert.equal(result.text, unionFallback);
    assert.ok(result.reasons.includes(reason), `${answer} 的命中原因应为 ${reason}，实际 ${result.reasons}`);
  }
});

test('防幻觉守卫：资料支持的回答原样放行，不误伤', () => {
  const { guardAnswer } = qa();
  const union = find('student-union');
  const volunteers = find('young-volunteers');
  const veteran = find('veteran-affairs-service');
  const grounded = [
    [union, '校学生会设权益部、文娱部、器材部、体育部、学创部 5 个部门。'],
    [union, '官网未公布校学生会的联系方式，页面上只有来源链接可以核对。'],
    [union, '组织架构是「主席团+工作部门」模式，围绕思想引领和服务同学开展工作。'],
    [union, '校学生会的所属校区官网未公布。'],
    [volunteers, '青年志愿者联合会据活动报道在广州校区、清远校区都有志愿服务队。'],
    [veteran, '退役军人事务服务部成立于 2022 年 5 月，由退役大学生组成。'],
    [union, `资料来源：${union.sourceUrl}`],
  ];
  for (const [department, answer] of grounded) {
    const result = guardAnswer(answer, department);
    assert.equal(result.replaced, false, `误伤了如实回答：${answer}（${result.reasons}）`);
    assert.equal(result.text, answer);
  }
});

test('会话：提问进历史、回答带依据、失败分类可区分且仍可继续提问', async () => {
  const { createQaStore, FAILURE_TEXT } = qa();
  const texts = Object.values(FAILURE_TEXT);
  assert.equal(new Set(texts).size, texts.length, '三类失败的本地文案必须各自独立');

  const { wx, calls } = cloudStub({ ok: true, text: '校学生会设 5 个部门：权益部、文娱部、器材部、体育部、学创部。' });
  globalThis.wx = wx;
  const store = createQaStore();
  resetStore(store);

  const first = await store.ask('student-union', '下设哪些部门？');
  assert.equal(first.ok, true);
  assert.equal(first.replaced, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].feature, 'department-qa');
  const bubbles = store.messagesOf('student-union');
  assert.equal(bubbles.length, 2);
  assert.equal(bubbles[0].role, 'user');
  assert.match(bubbles[1].source, /依据：.*核查于 2026-09-18/u);
  assert.equal(store.activeId, 'student-union');

  // 第二次提问把上文一起发出去，问题在最后一条。
  await store.ask('student-union', '最近有什么动态？');
  assert.equal(calls[1].messages.length, 3);
  assert.equal(calls[1].messages[2].role, 'user');
  assert.equal(calls[1].messages[2].text, '最近有什么动态？');

  // 三类失败各自成句，且不覆盖用户可见的回答位置以外的东西。
  const failing = [
    ['model_unavailable', '模型暂时不可用'],
    ['content_rejected', '内容未通过安全检测'],
    ['quota_exhausted', '额度已用尽'],
  ];
  for (const [failureClass, message] of failing) {
    const stub = cloudStub({ ok: false, failureClass, message });
    globalThis.wx = stub.wx;
    const isolated = createQaStore();
    resetStore(isolated);
    const result = await isolated.ask('student-union', '问题？');
    assert.equal(result.ok, false);
    assert.equal(result.failureClass, failureClass);
    assert.equal(result.message, message);
    const last = isolated.messagesOf('student-union').slice(-1)[0];
    assert.equal(last.isNotice, true, '失败提示要标记成提示而不是回答');
    assert.equal(last.failureClass, failureClass);
    assert.equal(last.source, '', '失败提示不应带来源行');
  }

  // 云函数没给文案时用本地兜底，且与另外两类不同句。
  const bare = cloudStub({ ok: false, failureClass: 'quota_exhausted' });
  globalThis.wx = bare.wx;
  const local = createQaStore();
  resetStore(local);
  assert.equal((await local.ask('student-union', '问题？')).message, FAILURE_TEXT.quota_exhausted);
  delete globalThis.wx;
});

test('模型不可用：调用没到云函数时也要给出可区分的提示，并说明资料仍可浏览', async () => {
  const { createQaStore } = qa();
  const cases = [
    [new Error('cloud.callFunction:fail Error: errCode: -501000 | errMsg: FunctionName parameter could not be found'), /云函数尚未部署/u],
    [new Error('errCode: -501023 permission denied'), /调用权限未配置/u],
    [new Error('errCode: -504003 timeout'), /响应超时/u],
  ];
  for (const [error, pattern] of cases) {
    const stub = cloudStub(error);
    globalThis.wx = stub.wx;
    const store = createQaStore();
    resetStore(store);
    const result = await store.ask('student-union', '下设哪些部门？');
    assert.equal(result.ok, false);
    assert.match(result.message, pattern);
    assert.match(result.message, /部门资料仍可正常浏览/u);
    assert.equal(store.pending, false);
  }
  delete globalThis.wx;
});

test('模型输出被守卫拦下时，上屏的是如实回答并标记 replaced', async () => {
  const { createQaStore } = qa();
  const stub = cloudStub({ ok: true, text: '校学生会的联系电话是 020-22305555。' });
  globalThis.wx = stub.wx;
  const store = createQaStore();
  resetStore(store);
  const result = await store.ask('student-union', '怎么联系？');
  assert.equal(result.ok, true);
  assert.equal(result.replaced, true);
  const answer = store.messagesOf('student-union').slice(-1)[0];
  assert.equal(answer.replaced, true);
  assert.ok(answer.text.includes('官网未公布'));
  assert.ok(!answer.text.includes('22305555'), '编造的号码不得出现在上屏内容里');
  delete globalThis.wx;
});

test('参数不合规的提问不发请求，直接按时提示', async () => {
  const { createQaStore, MAX_QUESTION_LENGTH } = qa();
  const stub = cloudStub({ ok: true, text: '不该被调用' });
  globalThis.wx = stub.wx;
  const store = createQaStore();
  resetStore(store);
  for (const question of ['', '   ', '啊'.repeat(MAX_QUESTION_LENGTH + 1)]) {
    const result = await store.ask('student-union', question);
    assert.equal(result.failureClass, 'invalid_request');
  }
  assert.equal(stub.calls.length, 0, '参数不合规时不应调用云函数');
  const unknown = await store.ask('not-a-department', '在吗');
  assert.equal(unknown.failureClass, 'invalid_request');
  assert.equal(stub.calls.length, 0);
  delete globalThis.wx;
});

test('对话按部门分开保存，返回列表后继续对话不丢上下文', async () => {
  const { createQaStore } = qa();
  const { wx } = cloudStub({ ok: true, text: '这是依据资料的回答。' });
  globalThis.wx = wx;
  const store = createQaStore();
  resetStore(store);
  await store.ask('student-union', '校学生会的问题');
  await store.ask('young-volunteers', '青志联的问题');
  assert.equal(store.messagesOf('student-union').length, 2);
  assert.equal(store.messagesOf('young-volunteers').length, 2);
  assert.equal(store.activeId, 'young-volunteers');
  assert.equal(store.messagesOf('veteran-affairs-service').length, 0);
  store.setActive('student-union');
  assert.equal(store.messagesOf('student-union')[0].text, '校学生会的问题');
  store.reset('student-union');
  assert.equal(store.messagesOf('student-union').length, 0);
  assert.equal(store.messagesOf('young-volunteers').length, 2, '清空一个部门不应影响另一个');
  delete globalThis.wx;
});

test('对话轮数超出上限时丢弃最早一轮并标记省略', async () => {
  const { createQaStore, MAX_TURNS } = qa();
  const { wx } = cloudStub({ ok: true, text: '回答' });
  globalThis.wx = wx;
  const store = createQaStore();
  resetStore(store);
  for (let index = 0; index < MAX_TURNS + 2; index += 1) {
    await store.ask('student-union', `第 ${index} 问`);
  }
  assert.equal(store.messagesOf('student-union').length, MAX_TURNS * 2);
  assert.equal(store.isTruncated('student-union'), true);
  assert.equal(store.isTruncated('young-volunteers'), false);
  delete globalThis.wx;
});

test('对话框视图：列表页给提示与 5 个可点选项，详情页给追问建议与依据', () => {
  const { buildQaPanel, createQaStore, NOT_PUBLISHED_TEXT } = qa();
  const store = createQaStore();
  resetStore(store);
  const list = buildQaPanel({ scope: 'list', store });
  assert.match(list.prompt, /你想了解什么部门/u);
  assert.ok(list.prompt.includes(NOT_PUBLISHED_TEXT), '开场提示要说明资料没有的会说官网未公布');
  assert.equal(list.options.length, 5);
  assert.equal(list.showOptions, true);
  assert.equal(list.hasActive, false);
  assert.deepEqual(list.options.map((item) => item.id), IDS);
  store.setActive('student-union');
  const resumed = buildQaPanel({ scope: 'list', store });
  assert.equal(resumed.hasActive, true);
  assert.equal(resumed.activeName, '校学生会');
  assert.equal(resumed.options.find((item) => item.id === 'student-union').active, true);
  assert.match(resumed.placeholder, /继续问校学生会/u);

  const detail = buildQaPanel({ scope: 'detail', store, departmentId: 'student-union' });
  assert.match(detail.prompt, /关于校学生会/u);
  assert.equal(detail.showSuggestions, true);
  assert.equal(detail.showOptions, false, '详情页不需要再列一遍部门选项');
  assert.equal(detail.canSend, false);
  const typed = buildQaPanel({ scope: 'detail', store, departmentId: 'student-union', draft: '下设哪些部门？' });
  assert.equal(typed.canSend, true);
  assert.equal(buildQaPanel({ scope: 'detail', store, departmentId: 'nope' }), null);
});

test('部门列表页：AI 提示与选项可点，点选项切到该部门并进入它的页面', () => {
  const visited = [];
  const { wx } = cloudStub({ ok: true, text: '回答' });
  wx.navigateTo = ({ url }) => visited.push(url);
  const page = loadPage('departments', wx);
  page.onShow();
  assert.match(page.data.qa.prompt, /你想了解什么部门/u);
  assert.equal(page.data.qa.options.length, 5);

  page.openOption({ currentTarget: { dataset: { id: 'student-club-management' } } });
  assert.deepEqual(visited, ['/pages/departments/detail/index?id=student-club-management']);
  assert.equal(page.data.qa.activeId, 'student-club-management');
  assert.equal(page.data.qa.hasActive, true);

  // 名录里的条目仍然照常进入详情（两条入口并存）。
  page.openDetail({ currentTarget: { dataset: { id: 'student-union' } } });
  assert.equal(visited[1], '/pages/departments/detail/index?id=student-union');
  // 未知 id 不跳转。
  page.openOption({ currentTarget: { dataset: { id: 'nope' } } });
  assert.equal(visited.length, 2);
  delete globalThis.wx;
});

test('部门详情页：可就该部门追问，成功后清空输入、失败保留原文', async () => {
  let reply = { ok: true, text: '设权益部、文娱部、器材部、体育部、学创部 5 个部门。' };
  const stub = cloudStub(() => reply);
  const page = loadPage('departments/detail', stub.wx, { id: 'student-union' });
  assert.equal(page.data.notFound, false);
  assert.equal(page.data.qa.showSuggestions, true);
  assert.equal(page.data.qa.suggestions.length, 4);
  assert.match(page.data.qa.placeholder, /校学生会/u);

  page.onDraftInput({ detail: { value: '下设哪些部门？' } });
  assert.equal(page.data.qa.canSend, true);
  await page.sendQuestion();
  assert.equal(page.data.draft, '');
  assert.equal(page.data.qa.bubbles.length, 2);
  assert.match(page.data.qa.bubbles[1].text, /权益部/u);
  assert.match(page.data.qa.bubbles[1].source, /依据：/u);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].feature, 'department-qa');

  // 失败：气泡是提示、输入框保留原文，部门资料照常展示。
  reply = { ok: false, failureClass: 'model_unavailable', message: 'AI 模型暂时不可用或响应超时，请稍后重试。' };
  page.onDraftInput({ detail: { value: '最近有什么动态？' } });
  await page.sendQuestion();
  assert.equal(page.data.draft, '最近有什么动态？');
  const last = page.data.qa.bubbles.slice(-1)[0];
  assert.equal(last.isNotice, true);
  assert.equal(page.data.qa.showOffline, true);
  assert.ok(page.data.detail !== null, 'AI 失败不应影响部门资料展示');
  assert.equal(page.data.notFound, false);

  // 点追问建议等价于填入并发送。
  reply = { ok: true, text: '官网未公布该组织的联系方式。' };
  await page.askSuggestion({ currentTarget: { dataset: { text: '校学生会的联系方式是什么？' } } });
  assert.equal(stub.calls.slice(-1)[0].messages.slice(-1)[0].text, '校学生会的联系方式是什么？');
  assert.equal(page.data.draft, '');

  page.restartConversation();
  assert.equal(page.data.qa.bubbles.length, 0);
  delete globalThis.wx;
});

test('详情页遇到未知部门时不给对话框，页面显示未找到状态', () => {
  const { wx } = cloudStub({ ok: true, text: '回答' });
  const page = loadPage('departments/detail', wx, { id: 'not-a-department' });
  assert.equal(page.data.notFound, true);
  assert.equal(page.data.qa, null);
  delete globalThis.wx;
});

test('两个部门页面都引用同一份问答模板与样式，产物里带上了这两个文件', () => {
  const listWxml = fs.readFileSync('miniprogram/pages/departments/index.wxml', 'utf8');
  const detailWxml = fs.readFileSync('miniprogram/pages/departments/detail/index.wxml', 'utf8');
  assert.match(listWxml, /<import src="\.\/qa\.wxml"/u);
  assert.match(detailWxml, /<import src="\.\.\/qa\.wxml"/u);
  for (const content of [listWxml, detailWxml]) {
    assert.match(content, /<template is="department-qa" data="\{\{\.\.\.qa\}\}" \/>/u);
  }
  assert.match(fs.readFileSync('miniprogram/pages/departments/index.wxss', 'utf8'), /@import "\.\/qa\.wxss"/u);
  assert.match(fs.readFileSync('miniprogram/pages/departments/detail/index.wxss', 'utf8'), /@import "\.\.\/qa\.wxss"/u);
  for (const file of ['qa.wxml', 'qa.wxss']) {
    assert.ok(fs.existsSync(`dist/pages/departments/${file}`), `构建产物缺少 ${file}`);
  }
  // 对话框的交互入口都要在模板里，开发者工具验收按这些 id 找元素。
  const template = fs.readFileSync('miniprogram/pages/departments/qa.wxml', 'utf8');
  for (const id of ['qa-prompt', 'qa-option-{{item.id}}', 'qa-input', 'qa-send', 'qa-suggestion-{{index}}', 'qa-pending', 'qa-restart']) {
    assert.ok(template.includes(id), `问答模板缺少 ${id}`);
  }
  // 验收脚本靠 .qa-answer 数「回答/提示」气泡（排除开场提示与「正在回答」），锁住这个标记。
  assert.match(
    template,
    /class="qa-row qa-row-\{\{item\.role\}\} \{\{item\.role === 'assistant' \? 'qa-answer' : ''\}\}"/u,
    '助手气泡缺少 qa-answer 标记，验收脚本会数错气泡',
  );
});
