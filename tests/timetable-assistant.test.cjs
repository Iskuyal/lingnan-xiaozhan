const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// Ticket 06 课表 AI 助手:课表数据组装、系统提示纪律、回复解析、变更校验与确认、页面编排。
// 云函数 ai 的 chat 管道在 tests/ai-flow.test.cjs 验证;这里验证课表侧与页面编排。
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

const assistant = () => loadCompiled('dist/services/timetable/assistant.js');
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
    showModal: (options) => {
      actions.push(`modal:${options.title}`);
      if (typeof options.success === 'function') options.success({ confirm: true, cancel: false });
    },
    actions,
    ...extra,
  };
}

const COURSES = [
  { id: 'tc_1', name: '高等数学', credits: '1.5', teacher: '林加燕', weekday: 1, startSection: 1, endSection: 2, sectionRanges: [{ start: 1, end: 2 }], weeks: [1, 2, 3, 4], weeksRecognized: true, weekText: '[1-4]周', location: '崇礼楼-306', campus: '清远校区', siteNumber: '44', note: '', warnings: [], source: 'excel', semester: '2026-2027学年第一学期', rawText: '', createdAt: '', updatedAt: '' },
  { id: 'tc_2', name: '体育一', credits: '1', teacher: '陈壮寿', weekday: 3, startSection: 7, endSection: 8, sectionRanges: [{ start: 7, end: 8 }], weeks: [6, 7], weeksRecognized: true, weekText: '[6-7]周', location: '篮球1号场', campus: '清远校区', siteNumber: '44', note: '', warnings: [], source: 'manual', semester: '2026-2027学年第一学期', rawText: '', createdAt: '', updatedAt: '' },
];

test('课表数据块:包含课程的关键字段,空课表如实说明', () => {
  const { buildTimetableText } = assistant();
  const text = buildTimetableText(COURSES, '2026-2027学年第一学期');
  assert.ok(text.includes('高等数学'));
  assert.ok(text.includes('林加燕'));
  assert.ok(text.includes('星期一'));
  assert.ok(text.includes('崇礼楼-306'));
  assert.match(buildTimetableText([], ''), /还没有/u);
});

test('系统提示词:携带课表数据,并要求只依据数据作答、不编造、改前确认、信息不足先追问、超范围不答', () => {
  const { buildSystemPrompt } = assistant();
  const system = buildSystemPrompt(COURSES, '2026-2027学年第一学期');
  assert.ok(system.includes('高等数学'), '提示词必须携带课表数据');
  assert.match(system, /编造|猜测/u);
  assert.match(system, /确认/u);
  assert.match(system, /澄清/u);
  assert.match(system, /能力范围/u);
  assert.match(system, /JSON/u);
});

test('回复解析:四种形态各归其位,变更只提方案并携带结构化课程', () => {
  const { parseAssistantReply } = assistant();
  assert.deepEqual(plain(parseAssistantReply(JSON.stringify({ kind: 'query', message: '周一第 1-2 节有高等数学。' }))), { kind: 'query', message: '周一第 1-2 节有高等数学。' });
  assert.deepEqual(plain(parseAssistantReply(JSON.stringify({ kind: 'clarify', message: '你说的是哪门课?' }))), { kind: 'clarify', message: '你说的是哪门课?' });
  assert.equal(parseAssistantReply(JSON.stringify({ kind: 'out_of_scope', message: '成绩查询不在我的能力范围内。' })).kind, 'out_of_scope');
  const change = parseAssistantReply(JSON.stringify({ kind: 'change', action: 'add', courseId: '', course: { name: '人工智能导论', teacher: '某某', weekday: 4, startSection: 3, endSection: 4, weekText: '1-16', location: '博雅楼-B101' }, message: '拟新增课程。' }));
  assert.equal(change.kind, 'change');
  assert.equal(change.action, 'add');
  assert.equal(change.course.name, '人工智能导论');
  assert.equal(change.course.weekday, 4);
});

test('回复解析:模型返回非 JSON 或变更字段非法时给出可理解回退,不当成变更', () => {
  const { parseAssistantReply } = assistant();
  const garbled = parseAssistantReply('好的,这就帮你查。');
  assert.equal(garbled.kind, 'invalid');
  assert.ok(garbled.message.length > 0);
  const badCourse = parseAssistantReply(JSON.stringify({ kind: 'change', action: 'add', courseId: '', course: { name: '缺信息课', teacher: '', weekday: 9, startSection: 3, endSection: 4, weekText: '', location: '' }, message: 'x' }));
  assert.equal(badCourse.kind, 'invalid', 'weekday 越界的变更必须拒绝');
  const fenced = parseAssistantReply('```json\n' + JSON.stringify({ kind: 'query', message: '周三第 7-8 节有体育一。' }) + '\n```');
  assert.equal(fenced.kind, 'query');
});

test('变更转提交数据:周次复用 parseWeekNotation,不认识保留原文待核对,留空按每周', () => {
  const { buildChangeInput } = assistant();
  const base = { name: '人工智能导论', teacher: '某某', weekday: 4, startSection: 3, endSection: 4, weekText: '', location: '博雅楼-B101' };
  const weekly = buildChangeInput(base);
  assert.equal(weekly.weeksRecognized, true);
  assert.deepEqual(plain(weekly.weeks), []);
  const ranged = buildChangeInput({ ...base, weekText: '2-6' });
  assert.deepEqual(plain(ranged.weeks), [2, 3, 4, 5, 6]);
  const unknown = buildChangeInput({ ...base, weekText: '第3-18周' });
  assert.equal(unknown.weeksRecognized, false);
  assert.ok(unknown.warnings.some((warning) => /周次/u.test(warning)));
  assert.equal(weekly.source, 'manual');
});

test('变更描述:确认弹窗文案讲清课程名、星期、节次与周次', () => {
  const { describeChange } = assistant();
  const text = describeChange({ name: '人工智能导论', teacher: '某某', weekday: 4, startSection: 3, endSection: 4, weekText: '1-16', location: '博雅楼-B101' }, 'add');
  assert.ok(text.includes('人工智能导论'));
  assert.ok(text.includes('星期四'));
  assert.ok(text.includes('第 3-4 节'));
  assert.ok(text.includes('1-16'));
});

test('课表页:查阅问题只读不写,请求携带课表数据,回答上屏', async () => {
  const cloud = cloudStub({
    list: () => ({ ok: true, count: COURSES.length, semester: COURSES[0].semester, updatedAt: '', courses: COURSES }),
    ai: () => ({ ok: true, failureClass: '', message: '', text: JSON.stringify({ kind: 'query', message: '周三第 7-8 节有体育一。' }), capWarning: '' }),
  });
  const wx = baseWx(cloud);
  const page = loadPage('timetable', wx);
  await page.onShow();
  page.openAssistant();
  page.onAssistantInput({ detail: { value: '周三第几节有课?' } });
  page.sendAssistant();
  await new Promise((resolve) => setImmediate(resolve));
  const call = cloud.calls.find((item) => item.name === 'ai' && item.data.action === 'chat');
  assert.ok(call, '必须调用 ai 云函数 chat 动作');
  assert.equal(call.data.feature, 'timetable-assistant');
  assert.ok(call.data.system.includes('高等数学'), '系统提示词必须携带当前课表数据');
  assert.ok(call.data.system.includes('体育一'));
  assert.match(page.data.assistantMessages[page.data.assistantMessages.length - 1].text, /体育一/u);
  assert.equal(cloud.calls.filter((item) => item.data.action === 'createCourse' || item.data.action === 'updateCourse').length, 0, '查阅不写库');
  delete globalThis.wx;
});

test('课表页:变更方案先弹确认,确认后新增入库并刷新,取消则不写', async () => {
  let listCalls = 0;
  const cloud = cloudStub({
    list: () => { listCalls += 1; return { ok: true, count: COURSES.length, semester: COURSES[0].semester, updatedAt: '', courses: COURSES }; },
    ai: () => ({ ok: true, failureClass: '', message: '', text: JSON.stringify({ kind: 'change', action: 'add', courseId: '', course: { name: '人工智能导论', teacher: '某某', weekday: 4, startSection: 3, endSection: 4, weekText: '2-6', location: '博雅楼-B101' }, message: '拟新增' }), capWarning: '' }),
    createCourse: (data) => ({ ok: true, course: { id: 'tc_new', ...data.course } }),
  });
  const confirmations = [];
  const wx = baseWx(cloud, {
    showModal: (options) => {
      confirmations.push(options);
      if (typeof options.success === 'function') options.success({ confirm: true, cancel: false });
    },
  });
  const page = loadPage('timetable', wx);
  await page.onShow();
  const listBefore = listCalls;
  page.openAssistant();
  page.onAssistantInput({ detail: { value: '周三加一节课' } });
  page.sendAssistant();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const modal = confirmations.find((item) => item.title === '确认课表变更');
  assert.ok(modal, '变更必须先弹确认框');
  assert.match(modal.content, /人工智能导论/u, '确认框要讲清改什么');
  const created = cloud.calls.find((item) => item.data.action === 'createCourse');
  assert.ok(created, '确认后调用新增');
  assert.equal(created.data.course.name, '人工智能导论');
  assert.deepEqual(plain(created.data.course.weeks), [2, 3, 4, 5, 6]);
  assert.equal(created.data.course.source, 'manual');
  assert.equal(created.data.semester, '2026-2027学年第一学期');
  assert.ok(listCalls > listBefore, '变更后刷新课表');
  assert.match(page.data.assistantMessages[page.data.assistantMessages.length - 1].text, /已/u);
  delete globalThis.wx;
});

test('课表页:变更方案被用户取消时不写库,并告知已取消', async () => {
  const cloud = cloudStub({
    list: () => ({ ok: true, count: COURSES.length, semester: COURSES[0].semester, updatedAt: '', courses: COURSES }),
    ai: () => ({ ok: true, failureClass: '', message: '', text: JSON.stringify({ kind: 'change', action: 'add', courseId: '', course: { name: '人工智能导论', teacher: '', weekday: 4, startSection: 3, endSection: 4, weekText: '', location: '' }, message: '拟新增' }), capWarning: '' }),
  });
  const wx = baseWx(cloud, {
    showModal: (options) => {
      if (typeof options.success === 'function') options.success({ confirm: false, cancel: true });
    },
  });
  const page = loadPage('timetable', wx);
  await page.onShow();
  page.openAssistant();
  page.onAssistantInput({ detail: { value: '加一节课' } });
  page.sendAssistant();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cloud.calls.filter((item) => item.data.action === 'createCourse').length, 0, '取消不写库');
  assert.match(page.data.assistantMessages[page.data.assistantMessages.length - 1].text, /取消/u);
  delete globalThis.wx;
});

test('课表页:澄清与超范围都不弹确认不写库,原话上屏', async () => {
  let reply = JSON.stringify({ kind: 'clarify', message: '你说的「那节课」是指哪一门?' });
  const cloud = cloudStub({
    list: () => ({ ok: true, count: COURSES.length, semester: COURSES[0].semester, updatedAt: '', courses: COURSES }),
    ai: () => ({ ok: true, failureClass: '', message: '', text: reply, capWarning: '' }),
  });
  const modals = [];
  const wx = baseWx(cloud, {
    showModal: (options) => { modals.push(options); if (typeof options.success === 'function') options.success({ confirm: true, cancel: false }); },
  });
  const page = loadPage('timetable', wx);
  await page.onShow();
  page.openAssistant();
  page.onAssistantInput({ detail: { value: '那节课在哪上?' } });
  page.sendAssistant();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page.data.assistantMessages[page.data.assistantMessages.length - 1].text, /哪一门/u);
  assert.equal(modals.length, 0, '澄清不弹变更确认框');
  reply = JSON.stringify({ kind: 'out_of_scope', message: '成绩查询不在我的能力范围内。' });
  page.onAssistantInput({ detail: { value: '我的高数成绩多少?' } });
  page.sendAssistant();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page.data.assistantMessages[page.data.assistantMessages.length - 1].text, /能力范围/u);
  assert.equal(cloud.calls.filter((item) => item.data.action === 'createCourse' || item.data.action === 'updateCourse').length, 0);
  delete globalThis.wx;
});

test('课表页:模型不可用与内容被拒各走独立文案,课表数据不受影响', async () => {
  let failure = 'model_unavailable';
  const cloud = cloudStub({
    list: () => ({ ok: true, count: COURSES.length, semester: COURSES[0].semester, updatedAt: '', courses: COURSES }),
    ai: () => ({ ok: false, failureClass: failure, message: '', text: '', capWarning: '' }),
  });
  const wx = baseWx(cloud);
  const page = loadPage('timetable', wx);
  await page.onShow();
  assert.equal(page.data.status, 'ready');
  page.openAssistant();
  page.onAssistantInput({ detail: { value: '周三有课吗?' } });
  page.sendAssistant();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page.data.assistantError, /暂时不可用/u);
  assert.doesNotMatch(page.data.assistantError, /安全/u);
  assert.equal(page.data.status, 'ready', '课表展示不受助手失败影响');
  assert.equal(page.data.count, 2);
  failure = 'content_rejected';
  page.onAssistantInput({ detail: { value: '周三有课吗?' } });
  page.sendAssistant();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page.data.assistantError, /安全/u);
  delete globalThis.wx;
});
