const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// Ticket 06 课表 AI 助手:课表数据组装、系统提示纪律、回复解析、变更合并与确认、页面编排。
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
const aiService = () => loadCompiled('dist/services/ai.js');
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
  { id: 'tc_1', name: '高等数学', credits: '1.5', teacher: '林加燕', weekday: 1, startSection: 1, endSection: 2, sectionRanges: [{ start: 1, end: 2 }], weeks: [1, 2, 3, 4], weeksRecognized: true, weekText: '[1-4]周', location: '崇礼楼-306', campus: '清远校区', siteNumber: '44', note: '', warnings: [], source: 'excel', semester: '2026-2027学年第一学期', rawText: '高等数学 1.5 林加燕 [1-4]周 1-2节 崇礼楼-306 清远校区 44', createdAt: '', updatedAt: '' },
  { id: 'tc_2', name: '体育一', credits: '1', teacher: '陈壮寿', weekday: 3, startSection: 7, endSection: 8, sectionRanges: [{ start: 7, end: 8 }], weeks: [6, 7], weeksRecognized: true, weekText: '[6-7]周', location: '篮球1号场', campus: '清远校区', siteNumber: '44', note: '', warnings: ['节次已按原文核对'], source: 'manual', semester: '2026-2027学年第一学期', rawText: '', createdAt: '', updatedAt: '' },
];

/** 已真正检测过内容安全时的服务端结论。 */
const CHECKED_SAFETY = { provider: 'wechat', api: 'security.msgSecCheck', passed: true, checked: true, detail: '' };
/** 没有真正检测（AI_SAFETY_PROVIDER=off / fail-open / 长文本只检了一段）时的结论。 */
const UNCHECKED_SAFETY = { provider: 'off', api: '', passed: true, checked: false, detail: '内容安全适配器为 off,未检测' };

function aiOk(text, safety = CHECKED_SAFETY, capWarning = '') {
  return { ok: true, failureClass: '', message: '', text, capWarning, safety, warnings: [] };
}

function queryText(message) {
  return JSON.stringify({ kind: 'query', message });
}

function listHandler() {
  return { ok: true, count: COURSES.length, semester: COURSES[0].semester, updatedAt: '', courses: COURSES };
}

test('课表数据块:每门课带 id 与关键字段,按当前周标注,空课表如实说明', () => {
  const { buildTimetableText } = assistant();
  const text = buildTimetableText(COURSES, '2026-2027学年第一学期', 1);
  assert.ok(text.includes('高等数学'));
  assert.ok(text.includes('林加燕'));
  assert.ok(text.includes('星期一'));
  assert.ok(text.includes('崇礼楼-306'));
  // 修改分支要求模型回填 courseId,提示词里必须真的有 id(两轴复核修复)。
  assert.ok(text.includes('tc_1'), '课表文本必须带课程 id');
  assert.ok(text.includes('tc_2'));
  assert.match(text, /id:tc_1/u, 'id 要写成便于模型照抄的形态');
  // 当前周标注:第 1 周只有高等数学(1-4 周),体育一(6-7 周)不上。
  assert.match(text, /高等数学[^\n]*本周：上/u);
  assert.match(text, /体育一[^\n]*本周：不上/u);
  const week6 = buildTimetableText(COURSES, '2026-2027学年第一学期', 6);
  assert.match(week6, /高等数学[^\n]*本周：不上/u);
  assert.match(week6, /体育一[^\n]*本周：上/u);
  assert.match(buildTimetableText([], '', 1), /还没有/u);
});

test('系统提示词:携带课表数据、当前周与总周数,纪律齐全且写明不支持删除', () => {
  const { buildSystemPrompt } = assistant();
  const system = buildSystemPrompt(COURSES, '2026-2027学年第一学期', 6, 20);
  assert.ok(system.includes('高等数学'), '提示词必须携带课表数据');
  assert.match(system, /第 6 周/u, '提示词必须写明当前是第几周');
  assert.match(system, /20 周/u, '提示词必须写明可切换的总周数');
  assert.match(system, /本周：上|本周：不上/u, '课表文本要按当前周标注');
  assert.match(system, /编造|猜测/u);
  assert.match(system, /确认/u);
  assert.match(system, /澄清/u);
  assert.match(system, /能力范围/u);
  assert.match(system, /JSON/u);
  assert.match(system, /删除/u, '提示词要写明删除不支持、不得声称已删除');
  assert.match(system, /courseId/u);
});

test('回复解析:四种形态各归其位,变更只提方案并携带结构化课程', () => {
  const { parseAssistantReply } = assistant();
  assert.deepEqual(plain(parseAssistantReply(queryText('周一第 1-2 节有高等数学。'))), { kind: 'query', message: '周一第 1-2 节有高等数学。' });
  assert.deepEqual(plain(parseAssistantReply(JSON.stringify({ kind: 'clarify', message: '你说的是哪门课?' }))), { kind: 'clarify', message: '你说的是哪门课?' });
  assert.equal(parseAssistantReply(JSON.stringify({ kind: 'out_of_scope', message: '成绩查询不在我的能力范围内。' })).kind, 'out_of_scope');
  const change = parseAssistantReply(JSON.stringify({ kind: 'change', action: 'add', courseId: '', course: { name: '人工智能导论', teacher: '某某', weekday: 4, startSection: 3, endSection: 4, weekText: '1-16', location: '博雅楼-B101' }, message: '拟新增课程。' }));
  assert.deepEqual(plain(change), {
    kind: 'change',
    action: 'add',
    courseId: '',
    course: { name: '人工智能导论', teacher: '某某', weekday: 4, startSection: 3, endSection: 4, weekText: '1-16', location: '博雅楼-B101' },
  });
  // 模型把提示词里的 [id:…] 连壳抄回时,剥掉外壳再与当前课表比对。
  const bracketed = parseAssistantReply(JSON.stringify({ kind: 'change', action: 'update', courseId: '[id:tc_1]', course: { weekday: 5 }, message: 'x' }));
  assert.equal(bracketed.kind, 'change');
  assert.equal(bracketed.courseId, 'tc_1');
  assert.equal(bracketed.action, 'update');
});

test('回复解析:模型返回非 JSON 或变更字段非法时给出可理解回退,不当成变更', () => {
  const { parseAssistantReply } = assistant();
  const garbled = parseAssistantReply('好的,这就帮你查。');
  assert.equal(garbled.kind, 'invalid');
  assert.ok(garbled.message.length > 0);
  const badCourse = parseAssistantReply(JSON.stringify({ kind: 'change', action: 'add', courseId: '', course: { name: '缺信息课', teacher: '', weekday: 9, startSection: 3, endSection: 4, weekText: '', location: '' }, message: 'x' }));
  assert.equal(badCourse.kind, 'invalid', 'weekday 越界的变更必须拒绝');
  const noSections = parseAssistantReply(JSON.stringify({ kind: 'change', action: 'add', courseId: '', course: { name: '缺节次', weekday: 2, startSection: 0, endSection: 0 }, message: 'x' }));
  assert.equal(noSections.kind, 'invalid', '缺节次的新增必须拒绝');
  const updateNoId = parseAssistantReply(JSON.stringify({ kind: 'change', action: 'update', courseId: '', course: { weekday: 5 }, message: 'x' }));
  assert.equal(updateNoId.kind, 'invalid', '修改必须给出 courseId');
  const updateNothing = parseAssistantReply(JSON.stringify({ kind: 'change', action: 'update', courseId: 'tc_1', course: {}, message: 'x' }));
  assert.equal(updateNothing.kind, 'invalid', '没有说明要改什么的修改必须拒绝');
  const fenced = parseAssistantReply('```json\n' + queryText('周三第 7-8 节有体育一。') + '\n```');
  assert.equal(fenced.kind, 'query');
});

test('回复解析:删除或未知动作按「不在能力范围」处理,绝不当成新增', () => {
  const { parseAssistantReply, UNSUPPORTED_ACTION_MESSAGE } = assistant();
  for (const action of ['delete', 'remove', 'Delete', '']) {
    const reply = parseAssistantReply(JSON.stringify({
      kind: 'change',
      action,
      courseId: 'tc_2',
      course: { name: '', teacher: '', weekday: 0, startSection: 0, endSection: 0, weekText: '', location: '' },
      message: '好的,已删除体育一。',
    }));
    assert.equal(reply.kind, 'out_of_scope', `action=${action || '(空)'} 必须按能力范围外处理`);
    assert.equal(reply.message, UNSUPPORTED_ACTION_MESSAGE);
    assert.doesNotMatch(reply.message, /已删除|已经删除|好的/u, '不得把模型的「已删除」当成事实展示');
  }
});

test('变更转提交数据(新增):周次复用 parseWeekNotation,不认识保留原文待核对,留空按每周', () => {
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
  const everyWeek = buildChangeInput({ ...base, weekText: '每周' });
  assert.equal(everyWeek.weeksRecognized, true);
  assert.deepEqual(plain(everyWeek.weeks), []);
  assert.equal(weekly.source, 'manual');
  assert.equal(weekly.credits, '');
  assert.equal(weekly.campus, '');
  assert.equal(weekly.note, '');
});

test('变更转提交数据(修改):只应用这次指定的字段,教师/地点/学分/周次/来源原样保留', () => {
  const { buildChangeInput } = assistant();
  const current = COURSES[0];
  // 「把高等数学改到周五第 5-6 节」:模型只给出时间,其它字段留空。
  const timeOnly = buildChangeInput({
    name: '',
    teacher: '',
    weekday: 5,
    startSection: 5,
    endSection: 6,
    weekText: '',
    location: '',
  }, current);
  assert.equal(timeOnly.weekday, 5);
  assert.deepEqual(plain(timeOnly.sectionRanges), [{ start: 5, end: 6 }]);
  assert.equal(timeOnly.name, '高等数学', '未指定的课程名保留');
  assert.equal(timeOnly.teacher, '林加燕', '未指定的教师保留');
  assert.equal(timeOnly.location, '崇礼楼-306', '未指定的地点保留');
  assert.equal(timeOnly.credits, '1.5', '未指定的学分保留');
  assert.deepEqual(plain(timeOnly.weeks), [1, 2, 3, 4], '未指定的周次保留');
  assert.equal(timeOnly.weekText, '[1-4]周');
  assert.equal(timeOnly.weeksRecognized, true);
  assert.equal(timeOnly.campus, '清远校区');
  assert.equal(timeOnly.siteNumber, '44');
  assert.equal(timeOnly.source, 'excel', '修改不得把来源打回 manual');
  assert.deepEqual(plain(timeOnly.warnings), []);

  // 明确改周次:周次换新,教师/地点/学分照旧。
  const reweek = buildChangeInput({
    name: '', teacher: '', weekday: 0, startSection: 0, endSection: 0, weekText: '5-8', location: '',
  }, current);
  assert.deepEqual(plain(reweek.weeks), [5, 6, 7, 8]);
  assert.equal(reweek.weekText, '5-8');
  assert.equal(reweek.teacher, '林加燕');
  assert.equal(reweek.credits, '1.5');

  // 明确改成每周。
  const everyWeek = buildChangeInput({
    name: '', teacher: '', weekday: 0, startSection: 0, endSection: 0, weekText: '每周', location: '',
  }, current);
  assert.equal(everyWeek.weeksRecognized, true);
  assert.deepEqual(plain(everyWeek.weeks), []);
  assert.equal(everyWeek.weekText, '');
  assert.equal(everyWeek.teacher, '林加燕');

  // 改周次且写法不认识:旧周次提示被替换,其它待核对提示保留(与手工表单 extrasOf 同口径)。
  const withWarnings = { ...COURSES[1], warnings: ['周次写法未能识别（原文：xx），已保留原文，请核对', '节次已按原文核对'] };
  const unknownWeek = buildChangeInput({
    name: '', teacher: '', weekday: 0, startSection: 0, endSection: 0, weekText: '第3-18周', location: '',
  }, withWarnings);
  assert.equal(unknownWeek.weeksRecognized, false);
  assert.equal(unknownWeek.warnings.filter((warning) => /周次/u.test(warning)).length, 1, '旧的周次提示要被替换');
  assert.ok(unknownWeek.warnings.includes('节次已按原文核对'), '非周次提示保留');
  assert.equal(unknownWeek.source, 'manual');
  assert.deepEqual(plain(unknownWeek.weeks), []);

  // 指定教师/地点时按指定值覆盖;多段节次在未指定节次时原样保留。
  const multi = { ...COURSES[0], sectionRanges: [{ start: 1, end: 2 }, { start: 5, end: 6 }] };
  const teacherChange = buildChangeInput({
    name: '', teacher: '新教师', weekday: 0, startSection: 0, endSection: 0, weekText: '', location: '',
  }, multi);
  assert.equal(teacherChange.teacher, '新教师');
  assert.deepEqual(plain(teacherChange.sectionRanges), [{ start: 1, end: 2 }, { start: 5, end: 6 }]);
  assert.equal(teacherChange.weekday, 1);
});

test('变更描述(新增):确认框讲清课程名、星期、节次与周次', () => {
  const { describeChange } = assistant();
  const text = describeChange({ name: '人工智能导论', teacher: '某某', weekday: 4, startSection: 3, endSection: 4, weekText: '1-16', location: '博雅楼-B101' }, 'add');
  assert.ok(text.includes('人工智能导论'));
  assert.ok(text.includes('星期四'));
  assert.ok(text.includes('第 3-4 节'));
  assert.ok(text.includes('1-16'));
});

test('变更描述(修改):逐条展示当前值 → 变更后,未变化的字段不展示', () => {
  const { summarizeChange } = assistant();
  const current = COURSES[0];
  const summary = summarizeChange({
    name: '', teacher: '', weekday: 5, startSection: 5, endSection: 6, weekText: '', location: '',
  }, 'update', current);
  assert.equal(summary.changed, true);
  assert.deepEqual(plain(summary.lines), ['时间：星期一 第 1-2 节 → 星期五 第 5-6 节']);
  assert.match(summary.text, /星期一 第 1-2 节 → 星期五 第 5-6 节/u);
  assert.match(summary.text, /其余字段保持不变/u, '确认框要讲明没列出的字段会被保留');
  assert.doesNotMatch(summary.text, /教师|地点|学分/u, '没变化的字段不展示');

  const renamed = summarizeChange({
    name: '高等数学（下）', teacher: '', weekday: 0, startSection: 0, endSection: 0, weekText: '', location: '',
  }, 'update', current);
  assert.deepEqual(plain(renamed.lines), ['课程名：高等数学 → 高等数学（下）']);

  const weekly = summarizeChange({
    name: '', teacher: '', weekday: 0, startSection: 0, endSection: 0, weekText: '每周', location: '',
  }, 'update', current);
  assert.deepEqual(plain(weekly.lines), ['周次：第 1-4 周 → 每周']);

  // 和当前一模一样:没有可展示的变更,页面据此不弹确认框、不写库。
  const same = summarizeChange({
    name: '高等数学', teacher: '', weekday: 1, startSection: 1, endSection: 2, weekText: '', location: '',
  }, 'update', current);
  assert.equal(same.changed, false);
  assert.deepEqual(plain(same.lines), []);
  assert.match(same.text, /没有需要修改的内容/u);
});

test('课表页:查阅问题只读不写,请求携带课表数据、当前周与 id,回答上屏', async () => {
  const cloud = cloudStub({
    list: listHandler,
    ai: () => aiOk(queryText('周三第 7-8 节有体育一。')),
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
  assert.ok(call.data.system.includes('tc_1'), '系统提示词必须带课程 id(修改分支要用)');
  assert.match(call.data.system, /第 1 周/u, '系统提示词必须带当前周');
  assert.match(page.data.assistantMessages[page.data.assistantMessages.length - 1].text, /体育一/u);
  assert.equal(page.data.assistantSafetyNote, '', '真正检测过就不显示未检测提示');
  assert.equal(cloud.calls.filter((item) => item.data.action === 'createCourse' || item.data.action === 'updateCourse').length, 0, '查阅不写库');
  delete globalThis.wx;
});

test('课表页:新增方案先弹确认,确认后新增入库并刷新,取消则不写', async () => {
  let listCalls = 0;
  const cloud = cloudStub({
    list: () => { listCalls += 1; return listHandler(); },
    ai: () => aiOk(JSON.stringify({ kind: 'change', action: 'add', courseId: '', course: { name: '人工智能导论', teacher: '某某', weekday: 4, startSection: 3, endSection: 4, weekText: '2-6', location: '博雅楼-B101' }, message: '拟新增' })),
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

test('课表页:修改方案真正走通——model 回填 id,确认后只改指定字段', async () => {
  const cloud = cloudStub({
    list: listHandler,
    ai: () => aiOk(JSON.stringify({
      kind: 'change',
      action: 'update',
      courseId: 'tc_1',
      course: { name: '', teacher: '', weekday: 5, startSection: 5, endSection: 6, weekText: '', location: '' },
      message: '把高等数学改到周五第 5-6 节。',
    })),
    updateCourse: (data) => ({ ok: true, id: data.id }),
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
  page.openAssistant();
  page.onAssistantInput({ detail: { value: '把高等数学改到周五第 5-6 节' } });
  page.sendAssistant();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const prompt = cloud.calls.find((item) => item.name === 'ai').data.system;
  assert.ok(prompt.includes('tc_1'), '提示词里必须先有 id,模型才可能回填');
  const modal = confirmations.find((item) => item.title === '确认课表变更');
  assert.ok(modal, '修改必须弹确认框');
  assert.match(modal.content, /星期一 第 1-2 节 → 星期五 第 5-6 节/u, '确认框要展示当前值 → 变更后');
  assert.match(modal.content, /其余字段保持不变/u, '确认框要讲明没列出的字段会被保留');
  assert.doesNotMatch(modal.content, /教师|地点|学分/u, '没变化的字段不展示');

  const updated = cloud.calls.find((item) => item.data.action === 'updateCourse');
  assert.ok(updated, '确认后必须调用 updateCourse');
  assert.equal(updated.data.id, 'tc_1');
  assert.equal(updated.data.course.weekday, 5);
  assert.deepEqual(plain(updated.data.course.sectionRanges), [{ start: 5, end: 6 }]);
  // 只改时间,其余字段原样带过来,没有静默清空。
  assert.equal(updated.data.course.name, '高等数学');
  assert.equal(updated.data.course.teacher, '林加燕');
  assert.equal(updated.data.course.location, '崇礼楼-306');
  assert.equal(updated.data.course.credits, '1.5');
  assert.deepEqual(plain(updated.data.course.weeks), [1, 2, 3, 4]);
  assert.equal(updated.data.course.weekText, '[1-4]周');
  assert.equal(updated.data.course.campus, '清远校区');
  assert.equal(updated.data.course.siteNumber, '44');
  assert.equal(updated.data.course.source, 'excel');
  assert.match(page.data.assistantMessages[page.data.assistantMessages.length - 1].text, /已按确认的内容更新课表/u);
  delete globalThis.wx;
});

test('课表页:update 指向不存在的课程或与当前一致时都不写库', async () => {
  let reply = JSON.stringify({
    kind: 'change', action: 'update', courseId: 'tc_missing',
    course: { name: '', teacher: '', weekday: 5, startSection: 5, endSection: 6, weekText: '', location: '' },
    message: 'x',
  });
  const cloud = cloudStub({
    list: listHandler,
    ai: () => aiOk(reply),
  });
  const modals = [];
  const wx = baseWx(cloud, {
    showModal: (options) => { modals.push(options); if (typeof options.success === 'function') options.success({ confirm: true, cancel: false }); },
  });
  const page = loadPage('timetable', wx);
  await page.onShow();
  page.openAssistant();
  page.onAssistantInput({ detail: { value: '把不存在的课改一下' } });
  page.sendAssistant();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page.data.assistantMessages[page.data.assistantMessages.length - 1].text, /不在当前课表里/u);
  assert.equal(modals.length, 0, '未知 id 不弹确认框');
  assert.equal(cloud.calls.filter((item) => item.data.action === 'updateCourse').length, 0);

  // 与当前完全一致的 update:不弹框、不写库,如实说明没有需要修改的内容。
  reply = JSON.stringify({
    kind: 'change', action: 'update', courseId: 'tc_1',
    course: { name: '高等数学', teacher: '', weekday: 1, startSection: 1, endSection: 2, weekText: '', location: '' },
    message: 'x',
  });
  page.onAssistantInput({ detail: { value: '把高等数学保持在周一第 1-2 节' } });
  page.sendAssistant();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page.data.assistantMessages[page.data.assistantMessages.length - 1].text, /没有需要修改的内容/u);
  assert.equal(modals.length, 0, '没有实际变化不弹确认框');
  assert.equal(cloud.calls.filter((item) => item.data.action === 'updateCourse').length, 0, '没有实际变化不写库');
  delete globalThis.wx;
});

test('课表页:删除动作按能力范围告知,不弹框不写库,也不展示模型的「已删除」', async () => {
  const cloud = cloudStub({
    list: listHandler,
    ai: () => aiOk(JSON.stringify({
      kind: 'change', action: 'delete', courseId: 'tc_2',
      course: { name: '', teacher: '', weekday: 0, startSection: 0, endSection: 0, weekText: '', location: '' },
      message: '好的,已删除体育一。',
    })),
  });
  const modals = [];
  const wx = baseWx(cloud, {
    showModal: (options) => { modals.push(options); if (typeof options.success === 'function') options.success({ confirm: true, cancel: false }); },
  });
  const page = loadPage('timetable', wx);
  await page.onShow();
  page.openAssistant();
  page.onAssistantInput({ detail: { value: '帮我删掉体育一' } });
  page.sendAssistant();
  await new Promise((resolve) => setImmediate(resolve));
  const last = page.data.assistantMessages[page.data.assistantMessages.length - 1].text;
  assert.match(last, /不在我的能力范围/u);
  assert.match(last, /课表列表/u, '要指路手工删除入口');
  assert.doesNotMatch(last, /已删除|已经删除|好的/u, '不得把模型的「已删除」当成事实展示');
  assert.equal(modals.length, 0, '删除不弹变更确认框');
  assert.equal(cloud.calls.filter((item) => item.data.action === 'createCourse' || item.data.action === 'updateCourse').length, 0, '删除请求不得产生任何写入');
  delete globalThis.wx;
});

test('课表页:变更方案被用户取消时不写库,并告知已取消', async () => {
  const cloud = cloudStub({
    list: listHandler,
    ai: () => aiOk(JSON.stringify({ kind: 'change', action: 'add', courseId: '', course: { name: '人工智能导论', teacher: '', weekday: 4, startSection: 3, endSection: 4, weekText: '', location: '' }, message: '拟新增' })),
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
    list: listHandler,
    ai: () => aiOk(reply),
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

test('课表页:三类失败文案各自独立,额度告警透传,课表数据不受影响', async () => {
  let failure = 'model_unavailable';
  let capWarning = '';
  const cloud = cloudStub({
    list: listHandler,
    ai: () => ({ ok: false, failureClass: failure, message: '', text: '', capWarning }),
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
  capWarning = '本月用量已接近上限';
  page.onAssistantInput({ detail: { value: '周三有课吗?' } });
  page.sendAssistant();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page.data.assistantError, /安全/u);
  assert.doesNotMatch(page.data.assistantError, /额度|上限/u, '内容被拒的文案不与额度告警混淆');
  assert.equal(page.data.assistantCapWarning, '本月用量已接近上限', '额度告警要透传给页面');

  failure = 'quota_exhausted';
  capWarning = '';
  page.onAssistantInput({ detail: { value: '周三有课吗?' } });
  page.sendAssistant();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page.data.assistantError, /上限|额度/u);
  assert.doesNotMatch(page.data.assistantError, /安全/u, '额度用尽不得与内容被拒混淆');
  delete globalThis.wx;
});

test('课表页:成功回答里额度告警同样透传,未真正检测内容安全时在对话里标出', async () => {
  let safety = CHECKED_SAFETY;
  const cloud = cloudStub({
    list: listHandler,
    ai: () => aiOk(queryText('第 1 周有 1 门课,高等数学。'), safety, '本月用量已接近上限'),
  });
  const wx = baseWx(cloud);
  const page = loadPage('timetable', wx);
  await page.onShow();
  page.openAssistant();
  page.onAssistantInput({ detail: { value: '这周有几门课?' } });
  page.sendAssistant();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.data.assistantCapWarning, '本月用量已接近上限');
  assert.equal(page.data.assistantSafetyNote, '', '检测过时没有提示行');

  // 服务端明确回 checked:false(off / fail-open / 长文本只检了一段):必须明说。
  safety = UNCHECKED_SAFETY;
  page.onAssistantInput({ detail: { value: '这周有几门课?' } });
  page.sendAssistant();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page.data.assistantSafetyNote, /没有经过内容安全检测|未经过内容安全检测/u);

  // 服务端连 safety 字段都没返回:按「未检测」处理,不把缺失读成干净。
  const missing = cloudStub({ list: listHandler, ai: () => ({ ok: true, failureClass: '', message: '', text: queryText('回答'), capWarning: '' }) });
  const page2 = loadPage('timetable', baseWx(missing));
  await page2.onShow();
  page2.openAssistant();
  page2.onAssistantInput({ detail: { value: '这周有几门课?' } });
  page2.sendAssistant();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page2.data.assistantSafetyNote, /内容安全检测/u);

  // 修改方案同样要带未检测提示(确认框里的字段也是模型给的)。
  const changeCloud = cloudStub({
    list: listHandler,
    ai: () => aiOk(JSON.stringify({ kind: 'change', action: 'add', courseId: '', course: { name: '人工智能导论', teacher: '', weekday: 4, startSection: 3, endSection: 4, weekText: '', location: '' }, message: '拟新增' }), UNCHECKED_SAFETY),
    createCourse: (data) => ({ ok: true, course: { id: 'tc_new', ...data.course } }),
  });
  const page3 = loadPage('timetable', baseWx(changeCloud));
  await page3.onShow();
  page3.openAssistant();
  page3.onAssistantInput({ detail: { value: '周三加一节课' } });
  page3.sendAssistant();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page3.data.assistantSafetyNote, /内容安全检测/u, '变更方案的模型输出同样要标出未检测');
  delete globalThis.wx;
});

test('课表页模板:未检测提示与额度告警都有展示位', () => {
  const wxml = fs.readFileSync(path.resolve('miniprogram/pages/timetable/index.wxml'), 'utf8');
  assert.match(wxml, /assistantSafetyNote/u, '未检测提示行必须绑定到模板');
  assert.match(wxml, /assistantCapWarning/u, '额度告警必须绑定到模板');
});

test('课表页模板:助手回答带 qa-answer 标记（与部门问答同一套验收约定）', () => {
  const wxml = fs.readFileSync(path.resolve('miniprogram/pages/timetable/index.wxml'), 'utf8');
  assert.match(
    wxml,
    /item\.role === 'assistant' \? 'qa-answer' : ''/u,
    '开发者工具验收靠 .qa-answer 数助手气泡，标记不能丢',
  );
});

test('AI 服务:未检测提示与判定对 06/07 是同一份(共用 services/ai.ts)', () => {
  const ai = aiService();
  assert.equal(ai.safetyNoteFor(CHECKED_SAFETY), '');
  assert.equal(ai.safetyNoteFor(UNCHECKED_SAFETY), ai.UNCHECKED_SAFETY_NOTE);
  assert.equal(ai.safetyNoteFor(null), ai.UNCHECKED_SAFETY_NOTE);
  assert.equal(ai.safetyNoteFor(undefined), ai.UNCHECKED_SAFETY_NOTE);
  assert.equal(ai.MAX_HISTORY, 20);
  const history = [];
  for (let index = 0; index < 21; index += 1) history.push({ role: index % 2 === 0 ? 'user' : 'assistant', text: `消息${index}` });
  const messages = ai.chatMessages(history, '');
  assert.equal(messages.length, 20);
  assert.deepEqual(plain(messages[0]), { role: 'assistant', text: '消息1' });
});

test('AI 服务:历史按检测窗口自剪,最后一条提问永远不会被剪掉', () => {
  const ai = aiService();
  // 两个数必须与服务端一致：服务端按 MAX_INPUT_CHARS 拒绝超窗输入，客户端按更小的预算自剪。
  assert.equal(ai.MAX_INPUT_CHARS, 20000, '要与 ai 云函数 MAX_INPUT_CHARS（2000 字 × 10 片）对齐');
  assert.equal(
    ai.HISTORY_INPUT_BUDGET,
    ai.MAX_INPUT_CHARS - 4000,
    '客户端预算由服务端上限推导，留白给分隔符与服务端注入的部门动态语料',
  );
  const history = [];
  for (let index = 0; index < 20; index += 1) {
    history.push({ role: index % 2 === 0 ? 'user' : 'assistant', text: '好'.repeat(3000) });
  }
  const system = '你是课表助手';
  const kept = ai.chatMessages(history, system);
  assert.ok(kept.length < 20, `超出预算的历史要被剪掉，实际保留 ${kept.length} 条`);
  const total = [system, ...kept.map((message) => message.text)].join('\n').length;
  assert.ok(total <= ai.HISTORY_INPUT_BUDGET, `剪完必须落在预算内，实际 ${total} 字`);
  assert.deepEqual(
    plain(kept[kept.length - 1]),
    plain(history[history.length - 1]),
    '最后一条是本轮提问，必须保留',
  );
});
