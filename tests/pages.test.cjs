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

test('首页两个入口分别进入部门和课表，目标均是已注册页面', () => {
  // 课表在 2026-11-13 的定稿里升为四个 tab 之一：tab 页只能用 switchTab 打开，
  // navigateTo 会被基础库拒绝（errMsg: can not navigateTo a tabbar page）。
  // 部门仍是普通页面，继续用 navigateTo。两条通道一起断言，防止哪天又被改回去。
  const visited = [];
  const switched = [];
  const home = loadPage('home', {
    navigateTo: ({ url }) => visited.push(url),
    switchTab: ({ url, success }) => { switched.push(url); success?.(); },
    setStorageSync: () => {},
    getStorageSync: () => '',
    removeStorageSync: () => {},
  });
  home.openDepartments();
  home.openTimetable();
  assert.deepEqual(visited, ['/pages/departments/index']);
  assert.deepEqual(switched, ['/pages/timetable/index']);
  const app = JSON.parse(fs.readFileSync('dist/app.json', 'utf8'));
  for (const url of [...visited, ...switched]) {
    assert.ok(app.pages.includes(url.slice(1)));
    for (const ext of ['js', 'json', 'wxml', 'wxss']) {
      assert.ok(fs.existsSync(`dist${url}.${ext}`));
    }
  }
});

test('首页保持已确认的校园服务入口与资讯，不显示失物招领入口', () => {
  const wxml = fs.readFileSync('dist/pages/home/index.wxml', 'utf8');
  const wxss = fs.readFileSync('dist/pages/home/index.wxss', 'utf8');

  assert.equal(wxml.includes('id="lost-found-entry"'), false, '定稿首页没有失物招领快捷入口');
  assert.match(wxml, /src="\/assets\/lingnan-logo-official.png"/);
  assert.match(wxml, /id="timetable-entry"[\s\S]*?class="home-primary"/);
  assert.match(wxml, /class="entry-pair"/);
  assert.match(wxml, /id="departments-entry"/);
  assert.match(wxml, /id="news-entry"/);
  for (const id of ['calendar-entry', 'goal-days-entry', 'fitness-entry', 'advancement-entry', 'defense-entry', 'news-retry']) {
    assert.ok(wxml.includes(`id="${id}"`), `${id} 保留可到达入口`);
  }
  assert.match(wxml, /wx:for="\{\{recentNews\}\}"/);
  assert.match(wxss, /\.home-primary\s*\{/);
  assert.match(wxss, /\.recent-news-item\s*\{/);
});

test('首页来源复制成功和失败都有正确反馈', () => {
  for (const success of [true, false]) {
    const notices = [];
    const home = loadPage('home', {
      setClipboardData: (options) => {
        assert.equal(options.data, 'https://lnc.edu.cn/xyjj/xyjj1');
        (success ? options.success : options.fail)();
      },
      showToast: (options) => notices.push(options.title),
    });
    home.copySource();
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