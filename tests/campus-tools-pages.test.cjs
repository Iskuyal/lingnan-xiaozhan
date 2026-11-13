const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// 校历与考试（Issue #91）与体测估算（Issue #92）两个页面的行为测试。
// 骨架与 tests/goal-pages.test.cjs 相同：用 vm 加载构建产物，把 wx 换成桩，只验证页面编排；
// 数据与算法本身在 tests/calendar.test.cjs、tests/fitness.test.cjs 里对服务层验证。
const PAGE_DIR = path.resolve('miniprogram/pages');

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

function wxStub() {
  const calls = { toast: [], modal: [], navigate: [], clipboard: [], scroll: [] };
  const store = new Map();
  const wx = {
    navigateTo: (options) => calls.navigate.push(options.url),
    navigateBack: () => calls.navigate.push('back'),
    reLaunch: (options) => calls.navigate.push(options.url),
    setClipboardData: (options) => { calls.clipboard.push(options.data); if (options.success) options.success(); },
    showToast: (options) => calls.toast.push(options.title),
    pageScrollTo: (options) => calls.scroll.push(options.scrollTop),
    getStorageSync: (key) => (store.has(key) ? store.get(key) : ''),
    setStorageSync: (key, value) => store.set(key, value),
  };
  return { calls, store, wx };
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
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
  }, { filename });
  return page;
}

const TODAY = '2026-09-29';

test('校历与考试页：按类别分组渲染，日期、报名与来源都在，且自检通过', () => {
  const stub = wxStub();
  const page = loadPage('calendar', stub);
  page.onLoad({ today: TODAY });
  assert.equal(page.data.hasProblems, false);
  assert.deepEqual(page.data.groups.map((group) => group.category), ['school', 'cet', 'ncre', 'mandarin']);
  const cet = page.data.groups.find((group) => group.category === 'cet');
  const cet4 = cet.rows.find((row) => row.id === 'cet-2026h2-cet4');
  assert.equal(cet4.dateText, '2026-12-12 09:00–11:20');
  assert.equal(cet4.stateLabel, '还有 74 天');
  assert.equal(cet4.sourceUrl, 'https://cet.neea.edu.cn/html1/report/2609/1-1.htm');
  assert.equal(cet4.verifiedAt, '2026-09-29');
  assert.match(cet4.registerText, /以本校教务处通知为准/);
  // 没有官方日期的三类：不显示日期，也不显示倒计时
  const pending = page.data.groups.flatMap((group) => group.rows).filter((row) => row.date === '');
  assert.ok(pending.length >= 3);
  for (const row of pending) {
    assert.equal(row.dateText, '');
    assert.equal(row.days, null);
    assert.notEqual(row.stateLabel, '');
  }
});

test('校历与考试页：复制来源链接成功与失败都有反馈', () => {
  const stub = wxStub();
  const page = loadPage('calendar', stub);
  page.onLoad({ today: TODAY });
  page.onCopySource({ currentTarget: { dataset: { url: 'https://cet.neea.edu.cn/html1/report/2609/1-1.htm' } } });
  assert.deepEqual(stub.calls.clipboard, ['https://cet.neea.edu.cn/html1/report/2609/1-1.htm']);
  assert.deepEqual(stub.calls.toast, ['原文链接已复制']);
  // 没有 url 的点击不做事
  page.onCopySource({ currentTarget: { dataset: {} } });
  assert.equal(stub.calls.clipboard.length, 1);

  const failing = wxStub();
  failing.wx.setClipboardData = (options) => { if (options.fail) options.fail(); };
  const failingPage = loadPage('calendar', failing);
  failingPage.onLoad({ today: TODAY });
  failingPage.onCopySource({ currentTarget: { dataset: { url: 'https://example.edu.cn/a' } } });
  assert.deepEqual(failing.calls.toast, ['复制失败，请重试']);
});

test('校历与考试页：返回首页的两种路径', async () => {
  // 栈里还有上一页 → navigateBack；只剩本页 → 走公共导航切「今天」tab（设计定稿后底栏才算
  // 真的在 tab 之间切换），没有 switchTab 的宿主退回 reLaunch。两条路都不留在空栈上。
  for (const stack of [[{}, {}], [{}]]) {
    const stub = wxStub();
    const page = loadPage('calendar', stub, stack);
    page.onLoad({ today: TODAY });
    page.goHome();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(stub.calls.navigate, [stack.length > 1 ? 'back' : '/pages/home/index']);
  }

  // 有 tab 能力时走 switchTab，不 reLaunch：底栏高亮才会跟着变。
  const tabStub = wxStub();
  tabStub.wx.switchTab = (options) => tabStub.calls.navigate.push(options.url);
  const tabPage = loadPage('calendar', tabStub, [{}]);
  tabPage.onLoad({ today: TODAY });
  tabPage.goHome();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(tabStub.calls.navigate, ['/pages/home/index']);
});

test('体测估算页：长跑输入三种写法都换算成秒，非法写法给提示', () => {
  const stub = wxStub();
  const page = loadPage('fitness', stub);
  page.onLoad();
  // 3′42″（222 秒）
  page.onInput({ currentTarget: { dataset: { value: 'distanceRun' } }, detail: { value: '3′42″' } });
  assert.equal(page.data.runHint, '按 3 分 42 秒（222 秒）计算');
  page.onInput({ currentTarget: { dataset: { value: 'distanceRun' } }, detail: { value: '222' } });
  assert.equal(page.data.runHint, '按 3 分 42 秒（222 秒）计算');
  page.onInput({ currentTarget: { dataset: { value: 'distanceRun' } }, detail: { value: '3:42' } });
  assert.equal(page.data.runHint, '按 3 分 42 秒（222 秒）计算');
  page.onInput({ currentTarget: { dataset: { value: 'distanceRun' } }, detail: { value: '三分四十二' } });
  assert.match(page.data.runHint, /可以写/);
});

test('体测估算页：估算后给标准分与等级，性别与年级组切换会带上结果一起重算', () => {
  const stub = wxStub();
  const page = loadPage('fitness', stub);
  page.onLoad();
  const fill = (field, value) => page.onInput({ currentTarget: { dataset: { value: field } }, detail: { value } });
  fill('height', '175');
  fill('weight', '61.3');
  fill('vitalCapacity', '5040');
  fill('sprint50', '6.7');
  fill('sitAndReach', '24.9');
  fill('standingLongJump', '273');
  fill('strength', '19');
  fill('distanceRun', '3′17″');
  page.calculate();
  assert.equal(page.data.hasResult, true);
  assert.equal(page.data.result.total, 100);
  assert.equal(page.data.result.grade, '优秀');
  assert.equal(page.data.result.items.length, 7);

  // 换成大三大四：同样成绩整体降一档（100 分标准更高），BMI 仍是 100 分
  // 标准分 = (100×15 + 95×15 + 95×20 + 95×10 + 95×10 + 95×10 + 95×20) / 100 = 95.75 → 95.8
  page.onBandTap({ currentTarget: { dataset: { value: 'senior' } } });
  assert.equal(page.data.bandLabel, '大学三、四年级');
  assert.equal(page.data.result.standardScore, 95.8);
  assert.equal(page.data.result.total, 95.8);
  assert.equal(page.data.result.grade, '优秀');
  // 换成女生：项目名变成 1 分钟仰卧起坐，且没有引体向上的加分
  page.onSexTap({ currentTarget: { dataset: { value: 'female' } } });
  assert.equal(page.data.sexLabel, '女');
  assert.ok(page.data.result.items.some((item) => item.label.includes('仰卧起坐')));
});

test('体测估算页：BMI 超重正常计分，其他缺项仍不给总分与等级', () => {
  const stub = wxStub();
  const page = loadPage('fitness', stub);
  page.onLoad();
  const fill = (field, value) => page.onInput({ currentTarget: { dataset: { value: field } }, detail: { value } });
  fill('height', '175');
  fill('weight', '80'); // BMI 26.1 → 超重，按原表计 80 分
  fill('sprint50', '7.0');
  page.calculate();
  assert.equal(page.data.result.total, null);
  assert.equal(page.data.result.grade, null);
  assert.equal(page.data.result.missing.some((text) => text.includes('BMI')), false);
  assert.ok(page.data.result.missing.length >= 2, `缺项应当列出来：${page.data.result.missing.join('、')}`);
  assert.equal(page.data.result.standardScore, 29, 'BMI 权重 15% 贡献 12，50 米跑权重 20% 贡献 17');
});

test('体测估算页：「改一个数字重算」回到输入区，输入不写本机存储', () => {
  const stub = wxStub();
  const page = loadPage('fitness', stub);
  page.onLoad();
  page.onInput({ currentTarget: { dataset: { value: 'vitalCapacity' } }, detail: { value: '4300' } });
  page.calculate();
  page.focusForm();
  assert.deepEqual(stub.calls.scroll, [0]);
  // 本机存储里不该出现任何体测输入（票面要求：不长期保存身高体重等个人数据）
  assert.deepEqual(Array.from(stub.store.keys()), []);
});

test('首页新增两个入口，目标页面都已注册且产物齐全', () => {
  const stub = wxStub();
  const home = loadPage('home', stub);
  home.openCalendar();
  home.openFitness();
  assert.deepEqual(stub.calls.navigate, ['/pages/calendar/index', '/pages/fitness/index']);
  const app = JSON.parse(fs.readFileSync('dist/app.json', 'utf8'));
  for (const route of ['pages/calendar/index', 'pages/fitness/index']) {
    assert.ok(app.pages.includes(route), `${route} 应当注册在 app.json`);
    for (const ext of ['js', 'json', 'wxml', 'wxss']) {
      assert.ok(fs.existsSync(`dist/${route}.${ext}`), `dist/${route}.${ext} 应当存在`);
    }
  }
});
