const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

function loadPage(name, wx, stack = [{}]) {
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
  const visited = [];
  const home = loadPage('home', { navigateTo: ({ url }) => visited.push(url) });
  home.openDepartments();
  home.openTimetable();
  assert.deepEqual(visited, ['/pages/departments/index', '/pages/timetable/index']);
  const app = JSON.parse(fs.readFileSync('dist/app.json', 'utf8'));
  for (const url of visited) {
    assert.ok(app.pages.includes(url.slice(1)));
    for (const ext of ['js', 'json', 'wxml', 'wxss']) {
      assert.ok(fs.existsSync(`dist${url}.${ext}`));
    }
  }
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

test('重新构建会移除不再属于源代码的旧产物', () => {
  const stale = 'dist/removed-page.js';
  fs.writeFileSync(stale, '// 模拟已删除页面留下的旧编译产物');
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(stale), false);
  assert.ok(fs.existsSync('dist/pages/home/index.js'));
});
