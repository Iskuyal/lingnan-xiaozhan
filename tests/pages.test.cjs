const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

function loadPage(name, wx, stack = [{}]) {
  // 页面经 ui/navigation 走 tab 跳转；那个模块读的是小程序里的全局 wx，
  // 与页面代码看到的是同一个对象。这里同步挂上，避免只 mock 了页面那一层。
  globalThis.wx = wx;
  const filename = path.resolve(`dist/pages/${name}/index.js`);
  let page;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: (options) => { page = options; },
    wx,
    getCurrentPages: () => stack,
    require: createRequire(filename),
    exports: {},
  }, { filename });
  return page;
}

test('首页入口：课表走 tab、其余走普通页面，目标均是已注册页面', () => {
  // 课表在 2026-11-13 的定稿里升为四个 tab 之一：tab 页只能用 switchTab 打开，
  // navigateTo 会被基础库拒绝（errMsg: can not navigateTo a tabbar page）。
  // 其余入口仍是普通页面，继续用 navigateTo。两条通道一起断言，防止哪天又被改回去。
  const visited = [];
  const switched = [];
  const home = loadPage('home', {
    navigateTo: ({ url }) => visited.push(url),
    switchTab: ({ url, success }) => { switched.push(url); success?.(); },
    setStorageSync: () => {},
    getStorageSync: () => '',
    removeStorageSync: () => {},
  });
  home.openImport();
  home.openGoals();
  home.openNews();
  home.openTimetable();
  assert.deepEqual(visited, [
    '/pages/timetable/import/index',
    '/pages/goals/index',
    '/pages/news/index',
  ]);
  assert.deepEqual(switched, ['/pages/timetable/index']);
  const app = JSON.parse(fs.readFileSync('dist/app.json', 'utf8'));
  for (const url of [...visited, ...switched]) {
    assert.ok(app.pages.includes(url.slice(1)), `${url} 未注册`);
    for (const ext of ['js', 'json', 'wxml', 'wxss']) {
      assert.ok(fs.existsSync(`dist${url}.${ext}`), `${url}.${ext} 缺失`);
    }
  }
});

test('首页首屏＝日期角标、下一课卡片、四个快捷入口与今日时间线', () => {
  // 设计图 01 / 53 / 36：全模块入口墙与常驻输入条被移除，改为下一节课 + 四个快捷入口。
  // 这里锁住新结构，同时守住「不出现失物招领入口」这条历史决定。
  const wxml = fs.readFileSync('dist/pages/home/index.wxml', 'utf8');
  const wxss = fs.readFileSync('dist/pages/home/index.wxss', 'utf8');

  assert.equal(wxml.includes('id="lost-found-entry"'), false, '定稿首页没有失物招领快捷入口');
  for (const id of ['hero-card', 'hero-unknown-times', 'hero-error', 'hero-empty', 'today-retry', 'today-timeline', 'week-link']) {
    assert.ok(wxml.includes(`id="${id}"`), `首页缺少 ${id}`);
  }
  for (const id of ['ask-entry', 'import-entry', 'goal-entry', 'news-entry']) {
    assert.ok(wxml.includes(`id="${id}"`), `快捷入口 ${id} 保留`);
  }
  assert.match(wxml, /wx:for="\{\{brief\.rows\}\}"/);
  assert.match(wxml, /\{\{brief\.dateLine\}\}/);
  assert.match(wxml, /\{\{hero\.timeRange\}\}/);
  assert.equal(/tabbar/i.test(wxml), false, '底栏由原生 tabBar 渲染，页面不画假底栏');
  assert.match(wxss, /\.home-hero\s*\{/);
  assert.match(wxss, /\.home-notice\s*\{/);
});

test('校园页来源复制成功和失败都有正确反馈', () => {
  // 学校简介与出处按设计图 19 从首页移到校园聚合页，复制官网链接的行为随之一并搬过来。
  for (const success of [true, false]) {
    const notices = [];
    const page = loadPage('campus', {
      setClipboardData: (options) => {
        assert.equal(options.data, 'https://lnc.edu.cn/xyjj/xyjj1');
        (success ? options.success : options.fail)();
      },
      showToast: (options) => notices.push(options.title),
    });
    page.copySource();
    assert.deepEqual(notices, [success ? '官网链接已复制' : '复制失败，请重试']);
  }
});

test('从入口进入的状态页返回上页，直接打开状态页返回首页', () => {
  for (const name of ['departments', 'timetable']) {
    for (const stack of [[{}, {}], [{}]]) {
      const actions = [];
      const page = loadPage(name, {
        navigateBack: () => actions.push('back'),
        reLaunch: ({ url }) => actions.push(url),
      }, stack);
      page.goHome();
      assert.deepEqual(actions, [stack.length > 1 ? 'back' : '/pages/home/index']);
    }
  }
});

// 注意：这个测试会重建 dist，并发的其它测试文件可能短暂读不到产物，
// 因此 `npm test` 用 --test-concurrency=1 串行执行。
test('重新构建会移除不再属于源代码的旧产物', () => {
  const stale = 'dist/removed-page.js';
  fs.writeFileSync(stale, '// 模拟已删除页面留下的旧编译产物');
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(stale), false);
  assert.ok(fs.existsSync('dist/pages/home/index.js'));
});