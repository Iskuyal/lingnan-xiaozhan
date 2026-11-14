const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

/**
 * 跨 tab 导航契约（共享约定「跨tab意图」一节）。
 *
 * 这些断言守的是三方联调的那条窄接口：B 的课表页按 consumeTimetableIntent() 取值，
 * A 的首页与学习页按 openTimetable() 写值。接口一旦松动（多个 key、不过期、
 * 能被消费两次、切页失败还在 storage 里留纸条），表现是「点了一次却跳到上一页的旧意图」，
 * 这种错在模拟器里很难复现，只能靠这里钉死。
 */

const KEY = 'lingnan/ui-timetable-intent/v1';
const SOURCE = path.resolve('dist/ui/navigation.js');

/** 跨 realm 的对象原型不同，deepEqual 之前先变成普通 JSON。 */
const plain = (value) => (value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)));

/** 每个用例一套干净的 wx 与 storage；模块也重新加载，模块内的自增 id 才不会串。 */
function load(onSwitchTab) {
  const calls = [];
  const storage = new Map();
  const wx = {
    getStorageSync: (key) => {
      calls.push(['getStorageSync', key]);
      return storage.has(key) ? JSON.parse(JSON.stringify(storage.get(key))) : '';
    },
    setStorageSync: (key, value) => {
      calls.push(['setStorageSync', key]);
      storage.set(key, JSON.parse(JSON.stringify(value)));
    },
    removeStorageSync: (key) => {
      calls.push(['removeStorageSync', key]);
      storage.delete(key);
    },
    switchTab: (options) => {
      calls.push(['switchTab', options.url]);
      if (onSwitchTab) return onSwitchTab(options, storage);
      options.success?.();
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(SOURCE, 'utf8'), {
    wx,
    console,
    Date,
    Error,
    String,
    Number,
    Promise,
    Object,
    Array,
    JSON,
    setTimeout,
    require: createRequire(SOURCE),
    module,
    exports: module.exports,
  }, { filename: SOURCE });
  return { nav: module.exports, calls, storage, wx };
}

function stored(storage) {
  return storage.has(KEY) ? storage.get(KEY) : null;
}

const failSwitch = (options) => options.fail?.(new Error('tab 不可用'));

test('四个主入口路由固定，openUiTab 只切 tab 不改 query', async () => {
  const { nav, calls } = load();
  assert.deepEqual(plain(nav.TAB_ROUTES), {
    today: '/pages/home/index',
    timetable: '/pages/timetable/index',
    study: '/pages/study/index',
    campus: '/pages/campus/index',
  });
  for (const tab of ['today', 'timetable', 'study', 'campus']) {
    await nav.openUiTab(tab);
  }
  assert.deepEqual(
    calls.filter(([name]) => name === 'switchTab').map(([, url]) => url),
    ['/pages/home/index', '/pages/timetable/index', '/pages/study/index', '/pages/campus/index'],
  );
  await assert.rejects(() => nav.openUiTab('lostfound'), /未知的主入口/);
});

test('无意图直接打开课表：不写 storage', async () => {
  const { nav, calls, storage } = load();
  await nav.openTimetable();
  assert.equal(stored(storage), null);
  assert.deepEqual(calls, [['switchTab', '/pages/timetable/index']]);
});

test('助手意图：先写一次性纸条再切 tab，消费后立刻删除', async () => {
  const { nav, calls, storage } = load();
  await nav.openTimetable({ kind: 'assistant', text: '  这周三第几节有课？  ' });
  // 写的顺序必须在切 tab 之前：课表页 onShow 一定读得到。
  const setIndex = calls.findIndex(([name]) => name === 'setStorageSync');
  const switchIndex = calls.findIndex(([name]) => name === 'switchTab');
  assert.ok(setIndex !== -1 && switchIndex !== -1 && setIndex < switchIndex, '先写意图后切页');
  const row = stored(storage);
  assert.equal(row.intent.kind, 'assistant');
  assert.equal(row.intent.text, '这周三第几节有课？', '两侧空白清掉，问题本身一字不改');
  assert.equal(typeof row.id, 'string');
  assert.equal(typeof row.createdAt, 'number');

  assert.deepEqual(plain(nav.consumeTimetableIntent()), { kind: 'assistant', text: '这周三第几节有课？' });
  assert.equal(stored(storage), null, '消费即删除');
  assert.equal(nav.consumeTimetableIntent(), null, '同一张纸条不能读第二次');
});

test('助手意图允许只打开不预填', async () => {
  const { nav, storage } = load();
  await nav.openTimetable({ kind: 'assistant' });
  assert.deepEqual(plain(stored(storage).intent), { kind: 'assistant' });
  assert.deepEqual(plain(nav.consumeTimetableIntent()), { kind: 'assistant' });
});

test('周次与计划日期意图：合法值原样返回，不夹紧', async () => {
  const { nav, storage } = load();
  await nav.openTimetable({ kind: 'week', week: 11 });
  assert.deepEqual(plain(nav.consumeTimetableIntent()), { kind: 'week', week: 11 });

  await nav.openTimetable({ kind: 'plan-week', planDate: '2026-11-09' });
  assert.deepEqual(plain(nav.consumeTimetableIntent()), { kind: 'plan-week', planDate: '2026-11-09' });
  assert.equal(stored(storage), null);
});

test('非法意图一律不写入、不消费，也不把坏数据留在 storage', async () => {
  const { nav, calls, storage } = load();
  const bad = [
    { kind: 'week', week: 0 },
    { kind: 'week', week: -3 },
    { kind: 'week', week: 11.5 },
    { kind: 'week', week: '11' },
    { kind: 'plan-week', planDate: '2026-02-30' },
    { kind: 'plan-week', planDate: '2026/11/09' },
    { kind: 'nonsense' },
    { kind: 'assistant', text: 42 },
    null,
    'assistant',
  ];
  for (const intent of bad) {
    await assert.rejects(() => nav.openTimetable(intent), /课表意图不合法/, JSON.stringify(intent));
  }
  assert.deepEqual(calls.filter(([name]) => name === 'switchTab'), [], '非法意图不跳页');
  assert.equal(stored(storage), null);

  // 别人（或旧版本）写进来的坏数据：读的时候作废并清掉。
  for (const broken of [
    { id: 'legacy', createdAt: Date.now(), intent: { kind: 'week', week: 999 } },
    { id: '', createdAt: Date.now(), intent: { kind: 'week', week: 3 } },
    { id: 'x', createdAt: 'yesterday', intent: { kind: 'week', week: 3 } },
    'not-an-object',
  ]) {
    storage.set(KEY, broken);
    assert.equal(nav.consumeTimetableIntent(), null, JSON.stringify(broken));
    assert.equal(stored(storage), null, '坏数据不能常驻');
  }
});

test('超过五分钟的意图作废，不会被当成新指令执行', async () => {
  const { nav, storage } = load();
  await nav.openTimetable({ kind: 'week', week: 6 });
  const row = stored(storage);
  // 只把时间往前挪，不动结构：这条仍然是「结构合法但已过期」。
  storage.set(KEY, { ...row, createdAt: row.createdAt - (nav.INTENT_TTL_MS + 1000) });
  assert.equal(nav.consumeTimetableIntent(), null);
  assert.equal(stored(storage), null, '过期纸条同样清掉');
});

test('切页失败回滚自己写的那条，不留下会被误读的纸条', async () => {
  const { nav, storage } = load(failSwitch);
  await assert.rejects(() => nav.openTimetable({ kind: 'assistant', text: '明天的课' }), /tab 不可用/);
  assert.equal(stored(storage), null, '切页失败不能留下会误触发下一次的纸条');
});

test('切页失败时只删除同一个 id：期间别人写的新意图保持不动', async () => {
  let injected = null;
  // 模拟「我们的纸条被后来的点击覆盖」：切页那一刻 storage 里已经是别人的意图。
  const { nav, storage } = load((options) => {
    storage.set(KEY, injected);
    options.fail?.(new Error('tab 不可用'));
  });
  injected = { id: 'other-tab', createdAt: Date.now(), intent: { kind: 'week', week: 9 } };
  await assert.rejects(() => nav.openTimetable({ kind: 'assistant', text: '别删我' }), /tab 不可用/);
  assert.deepEqual(plain(stored(storage)), injected, '只回滚自己那个 id');
});

test('导航模块只碰临时导航 key：不发请求、不改课程、不写计划', async () => {
  const { nav, calls, storage } = load();
  await nav.openTimetable({ kind: 'assistant', text: '问一句' });
  nav.consumeTimetableIntent();
  assert.deepEqual([...storage.keys()], [], '消费之后 storage 不留东西');
  for (const [name] of calls) {
    assert.ok(
      ['getStorageSync', 'setStorageSync', 'removeStorageSync', 'switchTab'].includes(name),
      `只允许导航类调用，实际出现 ${name}`,
    );
  }
  const source = fs.readFileSync(SOURCE, 'utf8');
  for (const forbidden of ['callFunction', 'saveGoals', 'savePlan', 'saveCourses', 'http']) {
    assert.equal(source.includes(forbidden), false, `导航模块不应出现 ${forbidden}`);
  }
});

test('同一个模块连续写两次意图：后一次覆盖前一次，不会两条一起消费', async () => {
  const { nav, storage } = load();
  await nav.openTimetable({ kind: 'week', week: 3 });
  const first = stored(storage);
  await nav.openTimetable({ kind: 'week', week: 5 });
  const second = stored(storage);
  assert.notEqual(first.id, second.id, '每次点击有自己的 id');
  assert.deepEqual(plain(nav.consumeTimetableIntent()), { kind: 'week', week: 5 });
  assert.equal(nav.consumeTimetableIntent(), null, '旧意图没有被留成第二条');
});

test('意图无法写入时保留当前页面，不能把丢失意图的跳转报为成功', async () => {
  const { nav, wx, calls } = load();
  wx.setStorageSync = () => { throw new Error('storage full'); };
  await assert.rejects(() => nav.openTimetable({ kind: 'plan-week', planDate: '2026-11-16' }), /意图|保存/);
  assert.equal(calls.some(([name]) => name === 'switchTab'), false);
});

test('未来时间戳的意图无效，删除失败的意图不能被重复应用', async () => {
  const { nav, storage, wx } = load();
  storage.set(KEY, { id: 'future', createdAt: Date.now() + 60000, intent: { kind: 'week', week: 3 } });
  assert.equal(nav.consumeTimetableIntent(), null);
  await nav.openTimetable({ kind: 'week', week: 4 });
  wx.removeStorageSync = () => { throw new Error('storage unavailable'); };
  assert.equal(nav.consumeTimetableIntent(), null);
  assert.equal(nav.consumeTimetableIntent(), null);
});
