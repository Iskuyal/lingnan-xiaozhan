/**
 * C 分支：目标日首页与编辑页（设计 12 常规态 / 55 空态 / 13 编辑态 / 54 删除确认）。
 *
 * 与 tests/goal-pages.test.cjs 同一套骨架（vm 加载构建产物 + wx 桩 + 手动触发计时器），
 * 只补本轮的界面状态与导航：
 * - 首页：空态、三组分组与文案、最近目标主卡、已保存计划白卡（一致 / 目标被改 / 目标被删）；
 * - 编辑页：新建、编辑、删除三条路径，保存失败后 saving 复位；
 * - 导航：栈里有上一页时 navigateBack，只剩本页时 openUiTab('today') 走 switchTab。
 *
 * 主题规则（WXSS 不含中文、令牌必须带回退值）由 tests/wxss.test.cjs 统一守，这里不重复。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const TODAY = '2026-09-29';
const PLAN_KEY = 'study-plan/v1';

/** 只复制数据，保留可调用的方法（页面实例上的方法要能直接调）。 */
function instantiate(options) {
  const page = { ...options, data: JSON.parse(JSON.stringify(options.data ?? {})) };
  // 与 goal-pages.test.cjs 一致：支持 'form.name' 这类单层点号路径，其余按顶层键写入。
  page.setData = (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (key.includes('.')) {
        const parts = key.split('.');
        let target = page.data;
        for (let index = 0; index < parts.length - 1; index += 1) target = target[parts[index]];
        target[parts[parts.length - 1]] = value;
        continue;
      }
      page.data[key] = value;
    }
  };
  return page;
}

/**
 * 本机存储 + 弹窗 + 导航桩。
 * `tabs` 传 false 时不提供 switchTab，用来验证「切不了 tab 时给提示」这条兜底分支。
 */
function wxStub(options = {}) {
  const store = new Map();
  const calls = { toast: [], modal: [], navigate: [], reLaunch: [], switchTab: [], title: [] };
  const timers = [];
  const answer = { confirm: true };
  const wx = {
    getStorageSync: (key) => (store.has(key) ? store.get(key) : ''),
    setStorageSync: (key, value) => store.set(key, value),
    removeStorageSync: (key) => store.delete(key),
    showToast: (payload) => calls.toast.push(payload.title),
    showModal: (payload) => {
      calls.modal.push({ title: payload.title, content: payload.content });
      if (typeof payload.success === 'function') payload.success({ confirm: answer.confirm });
    },
    navigateTo: (payload) => calls.navigate.push(payload.url),
    navigateBack: () => calls.navigate.push('back'),
    reLaunch: (payload) => calls.reLaunch.push(payload.url),
    setNavigationBarTitle: (payload) => calls.title.push(payload.title),
  };
  if (options.tabs !== false) {
    wx.switchTab = (payload) => {
      calls.switchTab.push(payload.url);
      if (options.tabFails === true) payload.fail?.({ errMsg: 'switchTab:fail mocked' });
      else payload.success?.();
    };
  }
  return { store, calls, timers, answer, wx };
}

function loadPage(route, stub, stack = [{}, {}]) {
  globalThis.wx = stub.wx;
  const filename = path.resolve(`dist/pages/${route}/index.js`);
  let page;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: (options) => { page = instantiate(options); },
    wx: stub.wx,
    getCurrentPages: () => stack,
    require: createRequire(filename),
    exports: {},
    console,
    setTimeout: (fn) => { stub.timers.push(fn); return stub.timers.length; },
    clearTimeout: () => {},
  }, { filename });
  return page;
}

function seedGoals(stub, list) {
  stub.wx.setStorageSync('goal-days/v1', JSON.stringify(list));
}

function seedPlan(stub, plan) {
  stub.wx.setStorageSync(PLAN_KEY, JSON.stringify(plan));
}

function storedGoals(stub) {
  const raw = stub.wx.getStorageSync('goal-days/v1');
  return raw === '' ? [] : JSON.parse(raw);
}

function goal(extra = {}) {
  return { id: 'a', name: '计算机二级考试', date: '2026-12-05', countToday: false, createdAt: 1, updatedAt: 1, ...extra };
}

/** 一份结构合法的计划快照：内容按 services/goals/plan.ts 的 normalizePlan 要求填。 */
function plan(extra = {}) {
  return {
    goalId: 'exam',
    goalName: '英语四级',
    goalDate: '2026-12-13',
    today: TODAY,
    remainingDays: 75,
    week: 11,
    weekKnown: true,
    weekLabel: '第 11 周',
    blocks: [
      { id: 'b1', weekday: 1, startSection: 1, endSection: 2, minutes: 45, topic: '听力', week: 11 },
      { id: 'b2', weekday: 3, startSection: 3, endSection: 4, minutes: 45, topic: '阅读', week: 11 },
    ],
    totalMinutes: 90,
    weeklyCount: 2,
    headline: '',
    rationale: [],
    constraintLines: [],
    dropped: [],
    createdAt: 1,
    ...extra,
  };
}

/** 等一轮事件循环：openUiTab 的失败分支在 promise 的 catch 里，断言前要先让它跑完。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ── 首页：空态 ────────────────────────────────────────────────────────────

test('目标日首页：没有目标日时给空态，两个入口分别进新建页与历史计划', () => {
  const stub = wxStub();
  const page = loadPage('goals', stub);
  page.onLoad({ today: TODAY });
  assert.equal(page.data.hasGoals, false);
  assert.equal(page.data.feature, null);
  assert.equal(page.data.hasSavedPlan, false);
  assert.equal(page.data.todayText, TODAY);
  assert.deepEqual(
    [page.data.upcomingCount, page.data.todayCount, page.data.expiredCount],
    [0, 0, 0],
  );
  // 运行时标题按状态切换（设计 12「目标日」/ 55「我的目标日」）。
  assert.deepEqual(stub.calls.title, ['我的目标日']);

  page.onCreate();
  page.onViewSaved();
  assert.deepEqual(stub.calls.navigate, ['/pages/goals/edit/index', '/pages/goals/plan/index']);
});

test('目标日首页：空态文案与两个入口都渲染在模板里，已过期组不给排计划', () => {
  const wxml = fs.readFileSync('miniprogram/pages/goals/index.wxml', 'utf8');
  assert.match(wxml, /下一个目标，是什么？/u);
  assert.match(wxml, /id="goal-new-empty"/u);
  assert.match(wxml, /id="goal-history"/u);
  assert.match(wxml, /查看保留的历史计划/u);
  // 主卡与两组列表各一个「排学习计划」，已过期组没有（入口数量由 goal-pages 测试钉住总数）。
  const expiredStart = wxml.indexOf('goal-item-expired');
  assert.ok(expiredStart > 0);
  assert.equal(wxml.slice(expiredStart).includes('goal-plan-'), false);
});

// ── 首页：三组分组、主卡与文案 ────────────────────────────────────────────

test('目标日首页：三组分开渲染，主卡优先「今天」，日期按设计稿写成「9 月 29 日」', () => {
  const stub = wxStub();
  seedGoals(stub, [
    { id: 'a', name: '计算机二级考试', date: '2026-12-05', countToday: false, createdAt: 1, updatedAt: 1 },
    { id: 'b', name: '普通话报名截止', date: '2026-10-16', countToday: true, createdAt: 2, updatedAt: 2 },
    { id: 'c', name: '体测补测', date: TODAY, countToday: false, createdAt: 3, updatedAt: 3 },
    { id: 'd', name: '英语四级报名截止', date: '2026-09-25', countToday: false, createdAt: 4, updatedAt: 4 },
  ]);
  const page = loadPage('goals', stub);
  page.onLoad({ today: TODAY });
  assert.equal(page.data.hasGoals, true);
  assert.deepEqual(
    [page.data.upcomingCount, page.data.todayCount, page.data.expiredCount],
    [2, 1, 1],
  );
  assert.deepEqual(page.data.groups.upcoming.map((row) => row.label), ['还有 18 天', '还有 67 天']);
  assert.equal(page.data.groups.upcoming[0].meta, '2026-10-16 · 计入当天');
  assert.deepEqual(page.data.groups.expired.map((row) => row.label), ['已过期 4 天']);
  // 主卡：今天优先，且名称与短日期都来自同一条记录。
  assert.equal(page.data.feature.id, 'c');
  assert.equal(page.data.feature.kind, 'today');
  assert.equal(page.data.feature.name, '体测补测');
  assert.equal(page.data.feature.dateText, '9 月 29 日');
  assert.deepEqual(stub.calls.title, ['目标日']);
});

test('目标日首页：没有今天的目标时主卡取最近的未到期，只有已过期时不给主卡', () => {
  const upcoming = wxStub();
  seedGoals(upcoming, [
    { id: 'far', name: '计算机二级考试', date: '2026-12-05', countToday: false, createdAt: 1, updatedAt: 1 },
    { id: 'near', name: '普通话报名截止', date: '2026-10-16', countToday: true, createdAt: 2, updatedAt: 2 },
  ]);
  const first = loadPage('goals', upcoming);
  first.onLoad({ today: TODAY });
  assert.equal(first.data.feature.id, 'near');
  assert.equal(first.data.feature.kind, 'upcoming');
  // 计入当天：diff 17 → 还有 18 天。
  assert.equal(first.data.feature.days, 18);
  assert.equal(first.data.feature.dateText, '10 月 16 日');

  const expired = wxStub();
  seedGoals(expired, [
    { id: 'old', name: '英语四级报名截止', date: '2026-09-25', countToday: false, createdAt: 1, updatedAt: 1 },
  ]);
  const second = loadPage('goals', expired);
  second.onLoad({ today: TODAY });
  assert.equal(second.data.hasGoals, true);
  assert.equal(second.data.expiredCount, 1);
  assert.equal(second.data.feature, null, '过期的事不当「下一个目标」');
});

// ── 首页：已保存计划白卡 ──────────────────────────────────────────────────

test('目标日首页：计划与目标日一致时显示「已保存」，带生成日期与段数', () => {
  const stub = wxStub();
  seedGoals(stub, [{ id: 'exam', name: '英语四级', date: '2026-12-13', countToday: false, createdAt: 1, updatedAt: 1 }]);
  seedPlan(stub, plan());
  const page = loadPage('goals', stub);
  page.onLoad({ today: TODAY });
  assert.equal(page.data.hasSavedPlan, true);
  assert.equal(page.data.savedTitle, '英语四级 · 第 11 周计划');
  assert.equal(page.data.savedMeta, '2026-09-29 生成 · 2 段 / 90 分钟');
  assert.equal(page.data.savedStale, false);
  assert.equal(page.data.savedStaleNote, '');

  page.onViewSaved();
  assert.deepEqual(stub.calls.navigate, ['/pages/goals/plan/index']);
});

test('目标日首页：目标日被改或被删时计划标「待核对」，并说明保留原快照', () => {
  const changed = wxStub();
  seedGoals(changed, [{ id: 'exam', name: '英语四级', date: '2026-12-20', countToday: false, createdAt: 1, updatedAt: 1 }]);
  seedPlan(changed, plan());
  const first = loadPage('goals', changed);
  first.onLoad({ today: TODAY });
  assert.equal(first.data.savedStale, true);
  assert.match(first.data.savedStaleNote, /目标日已被修改/u);
  assert.match(first.data.savedStaleNote, /保留保存时的安排/u);

  const removed = wxStub();
  seedGoals(removed, [{ id: 'other', name: '体测补测', date: TODAY, countToday: false, createdAt: 1, updatedAt: 1 }]);
  seedPlan(removed, plan());
  const second = loadPage('goals', removed);
  second.onLoad({ today: TODAY });
  assert.equal(second.data.savedStale, true);
  assert.match(second.data.savedStaleNote, /原目标日已删除/u);
  assert.match(second.data.savedStaleNote, /不会自动改写/u);
});

test('目标日首页：本机计划数据坏掉时不显示卡片，目标日列表照常可用', () => {
  const stub = wxStub();
  seedGoals(stub, [goal()]);
  stub.wx.setStorageSync(PLAN_KEY, '{"blocks":"不是数组"}');
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  let page;
  try {
    page = loadPage('goals', stub);
    page.onLoad({ today: TODAY });
  } finally {
    console.error = originalError;
  }
  assert.equal(page.data.hasSavedPlan, false);
  assert.equal(page.data.hasGoals, true, '一张可选的白卡坏掉不能把列表整页搞坏');
  assert.ok(errors.some((line) => line.includes('备考计划')), '坏数据要留一条可排查的日志');
});

// ── 首页：回「今天」的导航 ────────────────────────────────────────────────

test('目标日首页：栈里有上一页时直接返回，不动 tab', () => {
  const stub = wxStub();
  const page = loadPage('goals', stub, [{}, {}]);
  page.onLoad({ today: TODAY });
  page.goHome();
  assert.deepEqual(stub.calls.navigate, ['back']);
  assert.deepEqual(stub.calls.switchTab, []);
});

test('目标日首页：只剩本页时用 openUiTab 切到「今天」tab', async () => {
  const stub = wxStub();
  const page = loadPage('goals', stub, [{}]);
  page.onLoad({ today: TODAY });
  page.goHome();
  await flush();
  assert.deepEqual(stub.calls.navigate, [], '没有上一页就不该 navigateBack');
  assert.deepEqual(stub.calls.switchTab, ['/pages/home/index']);
  assert.deepEqual(stub.calls.toast, []);
});

test('目标日首页：环境不支持 switchTab 时给一句提示，不留静默按钮', async () => {
  const stub = wxStub({ tabs: false });
  const page = loadPage('goals', stub, [{}]);
  page.onLoad({ today: TODAY });
  page.goHome();
  await flush();
  assert.deepEqual(stub.calls.toast, ['暂时无法回到今天']);
});

test('目标日首页：源码从 ui/navigation 取 openUiTab，不自己拼 tab 路由', () => {
  const source = fs.readFileSync('miniprogram/pages/goals/index.ts', 'utf8');
  assert.match(source, /from '\.\.\/\.\.\/ui\/navigation'/u);
  assert.match(source, /openUiTab\('today'\)/u);
});

// ── 编辑页：新建 / 编辑 / 删除三条路径 ────────────────────────────────────

test('编辑页新建：默认今天，导航栏标题随之切换，保存后写库并延时返回', () => {
  const stub = wxStub();
  const page = loadPage('goals/edit', stub);
  page.onLoad({ today: TODAY });
  assert.equal(page.data.mode, 'create');
  assert.equal(page.data.title, '新建目标日');
  assert.equal(page.data.form.date, TODAY);
  assert.equal(page.data.preview.label, '就是今天');
  assert.deepEqual(stub.calls.title, ['新建目标日'], '新建态的 nav-title 不写死编辑');

  page.onNameInput({ detail: { value: '计算机二级考试' } });
  page.onDateChange({ detail: { value: '2026-12-05' } });
  assert.equal(page.data.preview.label, '还有 67 天');
  page.onCountTodayChange();
  assert.equal(page.data.preview.label, '还有 68 天');
  page.save();
  const saved = storedGoals(stub);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, '计算机二级考试');
  assert.deepEqual(stub.calls.toast, ['已添加']);
  stub.timers.forEach((fn) => fn());
  assert.deepEqual(stub.calls.navigate, ['back']);
});

test('编辑页编辑：回填已有记录、标题为编辑态，保存只改这一条', () => {
  const stub = wxStub();
  seedGoals(stub, [
    { id: 'one', name: '体测补测', date: TODAY, countToday: false, createdAt: 1, updatedAt: 1 },
    { id: 'two', name: '四级报名截止', date: '2026-09-25', countToday: false, createdAt: 2, updatedAt: 2 },
  ]);
  const page = loadPage('goals/edit', stub);
  page.onLoad({ id: 'one', today: TODAY });
  assert.equal(page.data.mode, 'edit');
  assert.equal(page.data.title, '编辑目标日');
  assert.deepEqual(stub.calls.title, ['编辑目标日']);
  assert.equal(page.data.form.name, '体测补测');
  assert.equal(page.data.preview.label, '就是今天');

  page.onNameInput({ detail: { value: '体测补测（改）' } });
  page.onDateChange({ detail: { value: '2026-10-01' } });
  page.save();
  const saved = storedGoals(stub);
  assert.deepEqual(saved.map((item) => item.id), ['one', 'two']);
  assert.equal(saved[0].name, '体测补测（改）');
  assert.equal(saved[1].name, '四级报名截止');
  assert.deepEqual(stub.calls.toast, ['已保存']);
});

test('编辑页删除：确认文案带快照说明；取消保留，确认后删除并返回', () => {
  const stub = wxStub();
  seedGoals(stub, [{ id: 'one', name: '体测补测', date: TODAY, countToday: false, createdAt: 1, updatedAt: 1 }]);
  const page = loadPage('goals/edit', stub);
  page.onLoad({ id: 'one', today: TODAY });

  stub.answer.confirm = false;
  page.remove();
  assert.equal(stub.calls.modal.length, 1);
  assert.equal(stub.calls.modal[0].title, '删除这个目标日？');
  // 设计稿 54：删掉目标日不再出现在列表，已保存的计划保留原快照并提示。
  assert.match(stub.calls.modal[0].content, /无法恢复/u);
  assert.match(stub.calls.modal[0].content, /体测补测 · 2026-09-29/u);
  assert.match(stub.calls.modal[0].content, /保留原快照/u);
  assert.equal(storedGoals(stub).length, 1, '取消不能动数据');

  stub.answer.confirm = true;
  page.remove();
  assert.deepEqual(storedGoals(stub), []);
  assert.deepEqual(stub.calls.toast, ['已删除']);
  stub.timers.forEach((fn) => fn());
  assert.deepEqual(stub.calls.navigate, ['back']);
});

test('编辑页删除：新建态调 remove 不弹窗也不动数据', () => {
  const stub = wxStub();
  const page = loadPage('goals/edit', stub);
  page.onLoad({ today: TODAY });
  page.remove();
  assert.deepEqual(stub.calls.modal, []);
  assert.deepEqual(storedGoals(stub), []);
});

// ── 编辑页：失败路径与 saving 复位 ────────────────────────────────────────

test('编辑页保存失败：名称为空与存储写失败都弹可读原因，saving 复位后可重试', () => {
  const stub = wxStub();
  const page = loadPage('goals/edit', stub);
  page.onLoad({ today: TODAY });
  page.save();
  assert.equal(stub.calls.modal.length, 1);
  assert.equal(stub.calls.modal[0].title, '保存失败');
  assert.equal(stub.calls.modal[0].content, '请填写事项名称');
  assert.equal(page.data.saving, false, '失败后必须解锁，否则按钮永远停在禁用态');
  assert.equal(page.data.mode, 'create', '失败后留在新建态，不误判为编辑');

  // 存储写失败：错误要说人话，且同样解锁。
  stub.wx.setStorageSync = () => { throw new Error('quota exceeded'); };
  page.onNameInput({ detail: { value: '体测补测' } });
  page.save();
  assert.equal(stub.calls.modal.length, 2);
  assert.equal(stub.calls.modal[1].content, '保存失败：本机存储不可写');
  assert.equal(page.data.saving, false);
});

test('编辑页保存成功：连点保存只写一条、只返回一次', () => {
  const stub = wxStub();
  const page = loadPage('goals/edit', stub);
  page.onLoad({ today: TODAY });
  page.onNameInput({ detail: { value: '目标' } });
  page.save();
  page.save();
  assert.equal(storedGoals(stub).length, 1);
  stub.timers.forEach((fn) => fn());
  assert.deepEqual(stub.calls.navigate, ['back']);
});

test('编辑页：记录已被删掉时给缺失态，不显示空表单也不写库', () => {
  const stub = wxStub();
  const page = loadPage('goals/edit', stub);
  page.onLoad({ id: 'gone', today: TODAY });
  assert.equal(page.data.status, 'missing');
  assert.equal(page.data.mode, 'create');
  page.save();
  assert.deepEqual(storedGoals(stub), []);
});

test('编辑页：栈里只剩本页时保存后切「今天」tab，而不是退到一个空栈', async () => {
  const stub = wxStub();
  const page = loadPage('goals/edit', stub, [{}]);
  page.onLoad({ today: TODAY });
  page.onNameInput({ detail: { value: '体测补测' } });
  page.save();
  assert.deepEqual(stub.calls.navigate, [], '没有上一页就不该 navigateBack');
  stub.timers.forEach((fn) => fn());
  await flush();
  assert.deepEqual(stub.calls.switchTab, ['/pages/home/index']);
  assert.deepEqual(stub.calls.reLaunch, [], 'switchTab 能用时不必退回列表页');
});

// ── 本轮未落地项：备注字段不写库 ──────────────────────────────────────────

test('编辑页：GoalDay 没有备注字段，模板里不出现假输入框，存储也不多写键', () => {
  const wxml = fs.readFileSync('miniprogram/pages/goals/edit/index.wxml', 'utf8');
  // 设计稿 13 的「备注（选填）」本轮不落地：存储结构冻结，不能加没有消费方的字段。
  assert.equal(wxml.includes('备注'), false);
  const stub = wxStub();
  const page = loadPage('goals/edit', stub);
  page.onLoad({ today: TODAY });
  page.onNameInput({ detail: { value: '体测补测' } });
  page.save();
  const saved = storedGoals(stub)[0];
  assert.deepEqual(Object.keys(saved).sort(), ['countToday', 'createdAt', 'date', 'id', 'name', 'updatedAt']);
});
