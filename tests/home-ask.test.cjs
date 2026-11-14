const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

/**
 * 首页「问课表」入口（设计图 01 的快捷入口，定稿取代了旧的常驻输入条）。
 *
 * 这一下点击决定两件事：会不会跳到错误的地方、会不会顺手替学生发问。
 * 课表升为 tab 之后 switchTab 不接受 query，问题文本改由 ui/navigation 的一次性意图带过去；
 * 首页仍然只负责「打开 + 预填」，真正调用模型要等学生在课表页自己点发送。
 */
function loadPage(name, wx, stack = [{}]) {
  // 课表 tab 的跳转经 ui/navigation 完成，它读平台全局 wx；与页面用同一份 mock。
  globalThis.wx = wx;
  const filename = path.resolve('dist/pages/' + name + '/index.js');
  let page;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: (definition) => { page = definition; },
    wx,
    getCurrentPages: () => stack,
    require: createRequire(filename),
    module: { exports: {} },
    exports: {},
  }, { filename });
  page.setData = (patch) => { Object.assign(page.data, patch); };
  return page;
}

/** 记录每一次跳转、写入的意图与每一句 toast：入口的行为全部体现在这三个通道里。 */
function recorder(options = {}) {
  const visited = [];
  const toasts = [];
  const storage = new Map();
  return {
    visited,
    toasts,
    storage,
    wx: {
      navigateTo: ({ url }) => visited.push(url),
      switchTab: ({ url, success, fail }) => {
        visited.push(url);
        (options.failSwitchTab ? fail : success)?.();
      },
      getStorageSync: (key) => (storage.has(key) ? storage.get(key) : ''),
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: (key) => storage.delete(key),
      showToast: ({ title }) => toasts.push(title),
    },
  };
}

/** 课表页真正会用的读法：同一个 key 上那张一次性纸条。 */
function intentOf(storage) {
  const row = storage.get('lingnan/ui-timetable-intent/v1');
  return row === undefined ? null : row.intent;
}

test('首页问课表：只切到课表 tab 并留下「打开助手」意图，不预填也不发问', async () => {
  const rec = recorder();
  const home = loadPage('home', rec.wx);
  await home.askTimetable();
  assert.deepEqual(rec.visited, ['/pages/timetable/index'], '只切一次课表 tab');
  assert.deepEqual(intentOf(rec.storage), { kind: 'assistant' }, '只带类型，不带问题文本');
  assert.deepEqual(rec.toasts, [], '成功打开不弹提示');
});

test('首页问课表：课表 tab 打不开时提示一句，不留纸条', async () => {
  const rec = recorder({ failSwitchTab: true });
  const home = loadPage('home', rec.wx);
  await home.askTimetable();
  assert.deepEqual(rec.toasts, ['课表页暂时打不开，稍后再试']);
  assert.equal(rec.storage.size, 0, '失败的跳转把纸条也收回去了');
});

test('首页不自己发请求：助手与模型都在课表页', () => {
  const source = fs.readFileSync('dist/pages/home/index.js', 'utf8');
  assert.ok(source.includes('ui/navigation'), '首页经共享导航桥写意图');
  assert.ok(source.includes("kind: 'assistant'"), '带的是助手意图');
  assert.equal(
    source.includes('callFunction') || source.includes('callAi'),
    false,
    '首页不自己调云函数或模型',
  );
});

test('首页时间线点课程：带课程 id 进编辑页，空白 key 不跳转', () => {
  const rec = recorder();
  const home = loadPage('home', rec.wx);
  home.openCourse({ currentTarget: { dataset: { id: 'tc_abc:3' } } });
  home.openCourse({ currentTarget: { dataset: {} } });
  home.openCourse({ currentTarget: { dataset: { id: ':3' } } });
  home.openCourse({ currentTarget: { dataset: { id: 'free:600:660' } } });
  assert.deepEqual(rec.visited, ['/pages/timetable/edit/index?id=tc_abc']);
});
