const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
// 首页入口带的剩余天数只能按当前日历日现算（那条路径没有「现在」注入口），所以这里要用服务层。
const dates = require('../dist/services/dates/index.js');

// 目标日两个页面（Issue #90）的行为测试：与 tests/timetable-manage-page.test.cjs 同一套骨架——
// 用 vm 加载构建产物里的页面定义，把 wx 的本机存储与弹窗换成桩，只验证页面编排。
// 日期算法本身在 tests/goals.test.cjs 里对服务层验证。
function instantiate(options) {
  const page = { ...options, data: JSON.parse(JSON.stringify(options.data ?? {})) };
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

/** 本机存储 + 弹窗桩；`answer.confirm` 决定确认弹窗走「确定」还是「取消」。 */
function wxStub() {
  const store = new Map();
  const calls = { toast: [], modal: [], navigate: [], reLaunch: [] };
  const timers = [];
  const answer = { confirm: true };
  const wx = {
    getStorageSync: (key) => (store.has(key) ? store.get(key) : ''),
    setStorageSync: (key, value) => store.set(key, value),
    showToast: (options) => calls.toast.push(options.title),
    showModal: (options) => {
      calls.modal.push({ title: options.title, content: options.content });
      if (typeof options.success === 'function') options.success({ confirm: answer.confirm });
    },
    navigateTo: (options) => calls.navigate.push(options.url),
    navigateBack: () => calls.navigate.push('back'),
    reLaunch: (options) => calls.reLaunch.push(options.url),
  };
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
    // 保存后的返回是延时执行的：这里收集起来手动触发，测试不需要等真实计时器。
    setTimeout: (fn) => { stub.timers.push(fn); return stub.timers.length; },
    clearTimeout: () => {},
  }, { filename });
  return page;
}

/** 直接往本机存储里放数据，模拟「上次已经存过」。 */
function seed(stub, list) {
  stub.wx.setStorageSync('goal-days/v1', JSON.stringify(list));
}

function stored(stub) {
  const raw = stub.wx.getStorageSync('goal-days/v1');
  return raw === '' ? [] : JSON.parse(raw);
}

const TODAY = '2026-09-29';

test('目标日列表：没有数据时给空态，并且能进入新建页', () => {
  const stub = wxStub();
  const page = loadPage('goals', stub);
  page.onLoad({ today: TODAY });
  assert.equal(page.data.hasGoals, false);
  assert.equal(page.data.todayText, TODAY);
  assert.equal(page.data.groups.upcoming.length, 0);
  page.onCreate();
  assert.deepEqual(stub.calls.navigate, ['/pages/goals/edit/index']);
});

test('目标日列表：三组分开渲染，条数与徽标文案都对得上', () => {
  const stub = wxStub();
  seed(stub, [
    { id: 'a', name: '计算机二级考试', date: '2026-12-05', countToday: false, createdAt: 1, updatedAt: 1 },
    { id: 'b', name: '普通话报名截止', date: '2026-10-16', countToday: true, createdAt: 2, updatedAt: 2 },
    { id: 'c', name: '体测补测', date: TODAY, countToday: false, createdAt: 3, updatedAt: 3 },
    { id: 'd', name: '英语四级报名截止', date: '2026-09-25', countToday: false, createdAt: 4, updatedAt: 4 },
  ]);
  const page = loadPage('goals', stub);
  page.onLoad({ today: TODAY });
  assert.equal(page.data.hasGoals, true);
  assert.deepEqual([page.data.upcomingCount, page.data.todayCount, page.data.expiredCount], [2, 1, 1]);
  assert.deepEqual(page.data.groups.upcoming.map((row) => row.label), ['还有 18 天', '还有 67 天']);
  assert.equal(page.data.groups.upcoming[0].meta, '2026-10-16 · 计入当天');
  assert.deepEqual(page.data.groups.today.map((row) => row.label), ['就是今天']);
  assert.equal(page.data.groups.today[0].meta, TODAY);
  assert.deepEqual(page.data.groups.expired.map((row) => row.label), ['已过期 4 天']);
});

test('目标日列表：删除先确认；取消不动数据，确认后从列表消失', () => {
  const stub = wxStub();
  seed(stub, [
    { id: 'keep', name: '体测补测', date: TODAY, countToday: false, createdAt: 1, updatedAt: 1 },
    { id: 'drop', name: '英语四级报名截止', date: '2026-09-25', countToday: false, createdAt: 2, updatedAt: 2 },
  ]);
  const page = loadPage('goals', stub);
  page.onLoad({ today: TODAY });

  stub.answer.confirm = false;
  page.onDelete({ currentTarget: { dataset: { id: 'drop' } } });
  assert.equal(stub.calls.modal.length, 1);
  assert.equal(stub.calls.modal[0].title, '删除这个目标日？');
  assert.match(stub.calls.modal[0].content, /无法恢复/);
  assert.match(stub.calls.modal[0].content, /英语四级报名截止 · 2026-09-25/);
  assert.deepEqual(stored(stub).map((item) => item.id), ['keep', 'drop']);

  stub.answer.confirm = true;
  page.onDelete({ currentTarget: { dataset: { id: 'drop' } } });
  assert.deepEqual(stored(stub).map((item) => item.id), ['keep']);
  assert.equal(page.data.hasGoals, true);
  assert.equal(page.data.expiredCount, 0);
  assert.deepEqual(stub.calls.toast, ['已删除']);
});

test('目标日列表：修改带着 id 进入编辑页，没有 id 的点击被忽略', () => {
  const stub = wxStub();
  seed(stub, [{ id: 'abc', name: '体测补测', date: TODAY, countToday: false, createdAt: 1, updatedAt: 1 }]);
  const page = loadPage('goals', stub);
  page.onLoad({ today: TODAY });
  page.onEdit({ currentTarget: { dataset: { id: 'abc' } } });
  page.onEdit({ currentTarget: { dataset: {} } });
  assert.deepEqual(stub.calls.navigate, ['/pages/goals/edit/index?id=abc']);
});

test('编辑页：新建默认今天，保存后列表能读回同一条', () => {
  const stub = wxStub();
  const page = loadPage('goals/edit', stub);
  page.onLoad({ today: TODAY });
  assert.equal(page.data.mode, 'create');
  assert.equal(page.data.title, '新建目标日');
  assert.equal(page.data.form.date, TODAY);
  assert.equal(page.data.preview.label, '就是今天');

  page.onNameInput({ detail: { value: '计算机二级考试' } });
  page.onDateChange({ detail: { value: '2026-12-05' } });
  assert.equal(page.data.preview.label, '还有 67 天');
  assert.equal(page.data.preview.meta, '2026-12-05 · 不计入当天 · 今天（北京时间）2026-09-29');
  page.onCountTodayChange();
  assert.equal(page.data.form.countToday, true);
  assert.equal(page.data.preview.label, '还有 68 天');

  page.save();
  const saved = stored(stub);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, '计算机二级考试');
  assert.equal(saved[0].date, '2026-12-05');
  assert.equal(saved[0].countToday, true);
  assert.deepEqual(stub.calls.toast, ['已添加']);
  assert.deepEqual(stub.calls.navigate, []);
  // 保存后延时返回：手动触发收集到的计时器。
  stub.timers.forEach((fn) => fn());
  assert.deepEqual(stub.calls.navigate, ['back']);

  // 列表页重新读一遍就是刚存下的那条。
  const list = loadPage('goals', stub);
  list.onLoad({ today: TODAY });
  assert.equal(list.data.upcomingCount, 1);
  assert.equal(list.data.groups.upcoming[0].name, '计算机二级考试');
});

test('编辑页：名称空或日期非法都不写库，弹出可读原因', () => {
  const stub = wxStub();
  const page = loadPage('goals/edit', stub);
  page.onLoad({ today: TODAY });
  page.onDateChange({ detail: { value: '2026-12-05' } });
  page.save();
  assert.deepEqual(stored(stub), []);
  assert.equal(stub.calls.modal.length, 1);
  assert.equal(stub.calls.modal[0].title, '保存失败');
  assert.equal(stub.calls.modal[0].content, '请填写事项名称');

  // 日期被清空（picker 理论上不会给空值，但页面不能因此写坏数据）。
  page.onNameInput({ detail: { value: '体测补测' } });
  page.onDateChange({ detail: { value: '' } });
  assert.equal(page.data.preview.label, '日期还没选');
  page.save();
  assert.deepEqual(stored(stub), []);
  assert.equal(stub.calls.modal[1].content, '请选择目标日期');
});

test('编辑页：打开已有记录回填，保存只改这一条', () => {
  const stub = wxStub();
  seed(stub, [
    { id: 'one', name: '体测补测', date: TODAY, countToday: false, createdAt: 1, updatedAt: 1 },
    { id: 'two', name: '四级报名截止', date: '2026-09-25', countToday: false, createdAt: 2, updatedAt: 2 },
  ]);
  const page = loadPage('goals/edit', stub);
  page.onLoad({ id: 'one', today: TODAY });
  assert.equal(page.data.mode, 'edit');
  assert.equal(page.data.title, '编辑目标日');
  assert.equal(page.data.form.name, '体测补测');
  assert.equal(page.data.preview.label, '就是今天');

  page.onNameInput({ detail: { value: '体测补测（改）' } });
  page.onDateChange({ detail: { value: '2026-10-01' } });
  page.save();
  const saved = stored(stub);
  assert.deepEqual(saved.map((item) => item.id), ['one', 'two']);
  assert.equal(saved[0].name, '体测补测（改）');
  assert.equal(saved[0].date, '2026-10-01');
  assert.equal(saved[1].name, '四级报名截止');
  assert.deepEqual(stub.calls.toast, ['已保存']);
});

test('编辑页：记录已被删掉时给缺失状态，不显示空表单', () => {
  const stub = wxStub();
  const page = loadPage('goals/edit', stub);
  page.onLoad({ id: 'gone', today: TODAY });
  assert.equal(page.data.status, 'missing');
  assert.equal(page.data.mode, 'create');
  page.save();
  assert.deepEqual(stored(stub), []);
});

test('编辑页：删除要确认，确认后本机不再有这条', () => {
  const stub = wxStub();
  seed(stub, [{ id: 'one', name: '体测补测', date: TODAY, countToday: false, createdAt: 1, updatedAt: 1 }]);
  const page = loadPage('goals/edit', stub);
  page.onLoad({ id: 'one', today: TODAY });

  stub.answer.confirm = false;
  page.remove();
  assert.deepEqual(stored(stub).length, 1);

  stub.answer.confirm = true;
  page.remove();
  assert.deepEqual(stored(stub), []);
  assert.deepEqual(stub.calls.toast, ['已删除']);
  stub.timers.forEach((fn) => fn());
  assert.deepEqual(stub.calls.navigate, ['back']);
});

test('首页入口带：显示最近一条目标日与剩余天数，没有时提示去添加', () => {
  const stub = wxStub();
  const home = loadPage('home', stub);
  home.onShow();
  // vm 里造出来的对象与主 realm 的原型不同，比较前先拷成主 realm 的普通对象。
  assert.deepEqual({ ...home.data.goalStrip }, {
    hasGoal: false,
    name: '还没有目标日',
    meta: '自己写一个日期，剩下多少天替你数',
    value: '去添加',
    unit: '',
  });

  seed(stub, [
    { id: 'a', name: '英语四级报名截止', date: '2026-09-25', countToday: false, createdAt: 1, updatedAt: 1 },
    { id: 'b', name: '计算机二级考试', date: '2099-12-05', countToday: false, createdAt: 2, updatedAt: 2 },
  ]);
  home.onShow();
  assert.equal(home.data.goalStrip.hasGoal, true);
  assert.equal(home.data.goalStrip.name, '计算机二级考试');
  // 期望值按当前上海日历日现算：`onShow()` 不接参数，页面走的是真实的 `Date.now()`，
  // 写死某个日期会让这条断言只在写入当天通过。日历日算法本身由 tests/goals.test.cjs 钉住。
  assert.equal(home.data.goalStrip.value, String(dates.diffDays(dates.shanghaiToday(), '2099-12-05')));
  assert.equal(home.data.goalStrip.unit, '天后');
  home.openGoals();
  assert.deepEqual(stub.calls.navigate, ['/pages/goals/index']);
});

test('目标日两个页面都已注册，构建产物四件套齐全', () => {
  const app = JSON.parse(fs.readFileSync('dist/app.json', 'utf8'));
  for (const route of ['pages/goals/index', 'pages/goals/edit/index']) {
    assert.ok(app.pages.includes(route), `${route} 应当注册在 app.json`);
    for (const ext of ['js', 'json', 'wxml', 'wxss']) {
      assert.ok(fs.existsSync(`dist/${route}.${ext}`), `dist/${route}.${ext} 应当存在`);
    }
  }
});
