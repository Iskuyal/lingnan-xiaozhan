/**
 * C 分支的跨 tab 回归（合入 NAV_SHA 后补齐，共享约定「跨tab意图」一节）。
 *
 * 这一支不重复 A 的 `tests/ui-navigation.test.cjs`（那里守的是导航模块自身的
 * 过期 / 一次性 / 失败回滚），也不重复 A 的 `tests/ui-v2-a-tabbar.test.cjs`（守 app.json 注册）。
 * 这里守的是**C 的五个模块页面真正接上公共导航之后**才会暴露的错：
 *
 * 1. 学习工具三页的「回学习」都走 `openUiTab('study')`，且**没有 switchTab 时退回 reLaunch**——
 *    退回路径必须落到已注册的 tab 路由上，不能写成 `/pages/study`（少一段就白屏）。
 * 2. 计划页「去课表看本周」走 `openTimetable({kind:'plan-week'})`，写到公共 key
 *    `lingnan/ui-timetable-intent/v1`，切的是课表 tab；宿主没有 switchTab 时退回带 `planDate`
 *    的旧路由。**C 自己的页面不许另写一份意图 key**——两份 key 会让 B 的课表页读不到。
 * 3. 目标日页 / 编辑页的「回到今天」在栈里还有上一页时 navigateBack，只有本页时切「今天」tab。
 * 4. 跨 tab 之后**不能顺手动别人的数据**：导航类动作不发云请求、不写课程、不清目标与计划。
 * 5. 所有 `wx.reLaunch` / `switchTab` / 意图里的路由，都必须在 `dist/app.json` 的 pages 里注册。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const INTENT_KEY = 'lingnan/ui-timetable-intent/v1';
const PLAN_KEY = 'study-plan/v1';
const GOALS_KEY = 'goal-days/v1';
const app = JSON.parse(fs.readFileSync(path.resolve(ROOT, 'dist/app.json'), 'utf8'));
const pageFile = (route) => path.resolve(ROOT, 'dist', 'pages', route, 'index.js');

/** 跨 realm 的对象原型不同，deepEqual 之前先变成普通 JSON。 */
const plain = (value) => (value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)));

function instantiate(options) {
  const page = { ...options, data: JSON.parse(JSON.stringify(options.data ?? {})) };
  page.setData = (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      const copy = value === undefined ? undefined : JSON.parse(JSON.stringify({ value })).value;
      if (!key.includes('.')) {
        page.data[key] = copy;
        continue;
      }
      const parts = key.split('.');
      let target = page.data;
      for (let index = 0; index < parts.length - 1; index += 1) target = target[parts[index]];
      target[parts[parts.length - 1]] = copy;
    }
  };
  return page;
}

/**
 * 页面桩。`tabs: false` 模拟没有 switchTab 的宿主（老基础库 / 只跑页面逻辑的测试环境），
 * 用来验证页面的降级路径不是死按钮。
 */
function wxStub(options = {}) {
  const store = new Map();
  const calls = {
    navigate: [], back: [], reLaunch: [], switchTab: [], toast: [], modal: [], title: [], scroll: [], cloud: [],
  };
  const wx = {
    getStorageSync: (key) => (store.has(key) ? store.get(key) : ''),
    setStorageSync: (key, value) => store.set(key, value),
    removeStorageSync: (key) => store.delete(key),
    navigateTo: (payload) => calls.navigate.push(payload.url),
    redirectTo: (payload) => calls.navigate.push(payload.url),
    navigateBack: () => calls.back.push(true),
    reLaunch: (payload) => calls.reLaunch.push(payload.url),
    showToast: (payload) => calls.toast.push(payload.title),
    showModal: (payload) => calls.modal.push(payload.title),
    setNavigationBarTitle: (payload) => calls.title.push(payload.title),
    pageScrollTo: (payload) => calls.scroll.push(payload.scrollTop),
    getSystemInfoSync: () => ({ windowWidth: 390, windowHeight: 844, safeArea: { bottom: 810 } }),
    cloud: {
      callFunction: async (payload) => {
        calls.cloud.push(payload?.name ?? '');
        throw new Error('跨 tab 回归不该请求云端');
      },
    },
  };
  if (options.tabs !== false) {
    wx.switchTab = (payload) => {
      calls.switchTab.push(payload.url);
      payload.success?.();
    };
  }
  return { wx, store, calls };
}

/** 装载一页编译产物。stack 长度决定页面认为「自己在栈里的第几层」。 */
function loadPage(route, stub, stack = [{}]) {
  globalThis.wx = stub.wx;
  const filename = pageFile(route);
  let page;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: (options) => {
      page = instantiate(options);
    },
    wx: stub.wx,
    getCurrentPages: () => stack,
    require: createRequire(filename),
    exports: {},
    console,
    setTimeout: (fn) => {
      fn();
      return 0;
    },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  }, { filename });
  return page;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** 断言一个路由已注册（少一段就会白屏，模拟器里只报一句「页面不存在」）。 */
function assertRegistered(url, label) {
  const route = url.split('?')[0].replace(/^\//, '');
  assert.ok(app.pages.includes(route), `${label} 指向未注册的路由 ${url}`);
}

// ---------- 学习工具三页：回「学习」tab ----------

test('体测「回学习工具」切学习 tab；没有 switchTab 的宿主退回已注册的 reLaunch 路由', async () => {
  const tabStub = wxStub();
  const tabbed = loadPage('fitness', tabStub);
  tabbed.onLoad({ today: '2026-11-10' });
  tabbed.goStudy();
  await flush();
  assert.deepEqual(tabStub.calls.switchTab, ['/pages/study/index'], '学习是 tab 页，必须 switchTab');
  assert.deepEqual(tabStub.calls.reLaunch, [], '有 tab 能力时不该 reLaunch');

  const legacyStub = wxStub({ tabs: false });
  const legacy = loadPage('fitness', legacyStub);
  legacy.onLoad({ today: '2026-11-10' });
  legacy.goStudy();
  await flush();
  assert.deepEqual(legacyStub.calls.reLaunch, ['/pages/study/index'], '降级路径要落到真实路由');
  assertRegistered(legacyStub.calls.reLaunch[0], '体测降级返回');
  delete globalThis.wx;
});

test('校历 / 体测 / 升学的「回到今天」在栈底时切今天 tab，不是死按钮', async () => {
  for (const route of ['calendar', 'fitness', 'advancement']) {
    const stub = wxStub();
    const page = loadPage(route, stub, [{}]);
    page.onLoad({ today: '2026-11-10' });
    page.goHome();
    await flush();
    assert.deepEqual(stub.calls.switchTab, ['/pages/home/index'], `${route} 应切「今天」tab`);
  }
  delete globalThis.wx;
});

test('校历 / 体测 / 升学在栈里还有上一页时「回到今天」只返回，不切 tab', async () => {
  for (const route of ['calendar', 'fitness', 'advancement']) {
    const stub = wxStub();
    const page = loadPage(route, stub, [{}, {}]);
    page.onLoad({ today: '2026-11-10' });
    page.goHome();
    await flush();
    assert.deepEqual(stub.calls.back, [true], `${route} 应 navigateBack`);
    assert.deepEqual(stub.calls.switchTab, [], `${route} 不该再切 tab`);
  }
  delete globalThis.wx;
});

// ---------- 目标日两页：回到今天 ----------

test('目标日页与编辑页：栈底切今天 tab，栈中有上一页时返回', async () => {
  // 首页的入口叫 goHome，编辑页保留原有名字 goBack（两条语义相同：先退栈，栈底才切 tab）。
  for (const entry of [{ route: 'goals', method: 'goHome' }, { route: 'goals/edit', method: 'goBack' }]) {
    const deepStub = wxStub();
    const deep = loadPage(entry.route, deepStub, [{}, {}]);
    deep.onLoad({});
    deep[entry.method]();
    await flush();
    assert.deepEqual(deepStub.calls.back, [true], `${entry.route} 栈中有上一页时应返回`);

    const rootStub = wxStub();
    const root = loadPage(entry.route, rootStub, [{}]);
    root.onLoad({});
    root[entry.method]();
    await flush();
    assert.deepEqual(rootStub.calls.switchTab, ['/pages/home/index'], `${entry.route} 栈底时应切今天 tab`);
  }
  delete globalThis.wx;
});

// ---------- 计划页：去课表看本周 ----------

test('计划页「去课表」写公共意图 key 并切课表 tab，意图带计划生成那天', async () => {
  const stub = wxStub();
  const page = loadPage('goals/plan', stub);
  page.onLoad({ id: 'g1', today: '2026-11-11' });
  // 只要页面认得出「这一周是哪一周」，不依赖真实生成的计划内容。
  page.data.plan = { today: '2026-11-10' };
  page.onViewWeek();
  await flush();
  assert.deepEqual(stub.calls.switchTab, ['/pages/timetable/index'], '课表是 tab 页，必须 switchTab');
  const row = plain(stub.store.get(INTENT_KEY));
  assert.ok(row !== null && row !== undefined, '必须写公共意图 key');
  assert.deepEqual(row.intent, { kind: 'plan-week', planDate: '2026-11-10' });
  assert.equal(typeof row.id, 'string');
  assert.equal(typeof row.createdAt, 'number');
  delete globalThis.wx;
});

test('计划页「去课表」在无 switchTab 的宿主退回带 planDate 的旧路由，且该路由已注册', async () => {
  const stub = wxStub({ tabs: false });
  const page = loadPage('goals/plan', stub);
  page.onLoad({ id: 'g1', today: '2026-11-11' });
  page.data.plan = { today: '2026-11-10' };
  page.onViewWeek();
  await flush();
  assert.deepEqual(stub.calls.navigate, ['/pages/timetable/index?planDate=2026-11-10']);
  assertRegistered(stub.calls.navigate[0], '计划页降级去课表');
  assert.equal(stub.calls.switchTab.length, 0, '没有 tab 能力时不该凭空调用 switchTab');
  delete globalThis.wx;
});

// ---------- 只碰公共接口，不另造 key ----------

test('C 的页面不另造跨 tab 意图 key，只走公共导航模块', () => {
  const forbidden = ['lingnan/', 'timetable-intent', 'TIMETABLE_INTENT'];
  const routes = ['goals', 'goals/edit', 'goals/plan', 'calendar', 'fitness', 'advancement', 'defense'];
  for (const route of routes) {
    for (const ext of ['ts', 'wxml']) {
      const file = path.resolve(ROOT, 'miniprogram', 'pages', route, `index.${ext}`);
      if (!fs.existsSync(file)) continue;
      const source = fs.readFileSync(file, 'utf8');
      for (const needle of forbidden) {
        assert.equal(
          source.includes(needle),
          false,
          `${route}/index.${ext} 不该自己写意图 key（${needle}）：只能通过 ui/navigation 的接口`,
        );
      }
    }
  }
});

test('C 的页面导出的导航只经 ui/navigation，不直接 wx.switchTab 绕开意图桥', () => {
  // switchTab 直接调用本身不算错，但「切课表」必须带意图，否则 B 读不到 plan-week。
  // 这里只钉课表这一条：C 里任何指向课表的跳转都必须由 openTimetable 发起。
  const routes = ['goals', 'goals/edit', 'goals/plan', 'calendar', 'fitness', 'advancement', 'defense'];
  for (const route of routes) {
    const file = path.resolve(ROOT, 'dist', 'pages', route, 'index.js');
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const direct = /switchTab\s*\(\s*\{[^}]*pages\/timetable/.test(source);
    assert.equal(direct, false, `${route} 直接 switchTab 到课表，会丢掉 plan-week 意图`);
  }
});

// ---------- 导航不动数据 ----------

test('跨 tab 导航不发云请求、不写课程与目标：只动公共导航 key', async () => {
  const stub = wxStub();
  const goalsJson = JSON.stringify([
    { id: 'g1', name: '英语四级', date: '2026-12-13', countToday: false, createdAt: 1, updatedAt: 1 },
  ]);
  const planJson = JSON.stringify({ sentinel: 'plan' });
  stub.store.set(GOALS_KEY, goalsJson);
  stub.store.set(PLAN_KEY, planJson);
  const page = loadPage('goals/plan', stub);
  page.onLoad({ id: 'g1', today: '2026-11-11' });
  page.data.plan = { today: '2026-11-10' };
  page.onViewWeek();
  await flush();
  assert.deepEqual(stub.calls.cloud, [], '导航不该请求云端');
  assert.equal(stub.store.get(GOALS_KEY), goalsJson, '目标日不能被导航改写');
  assert.equal(stub.store.get(PLAN_KEY), planJson, '已保存计划不能被导航改写');
  delete globalThis.wx;
});
