const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 四个主入口的注册契约（岭南红定稿 · 基础分支）。
 *
 * 原生 tabBar 有三处必须同时成立：app.json 的 tabBar.list、pages 里的真实路由、
 * 以及每个 tab 页的四件套文件。少一处，开发者工具只报一句
 * "tabBar[0].pagePath 未在 pages 中注册"，而四个入口会整组失效。
 * 另外把 22 个旧路由钉住：基础分支只新增两个聚合入口，不允许顺手删旧页面。
 */

const ORIGINAL_ROUTES = [
  'pages/home/index',
  'pages/departments/index',
  'pages/departments/detail/index',
  'pages/timetable/index',
  'pages/timetable/import/index',
  'pages/timetable/edit/index',
  'pages/timetable/settings/index',
  'pages/timetable/manage/index',
  'pages/news/index',
  'pages/news/detail/index',
  'pages/lost-found/index',
  'pages/lost-found/publish/index',
  'pages/lost-found/detail/index',
  'pages/lost-found/claim/index',
  'pages/lost-found/mine/index',
  'pages/goals/index',
  'pages/goals/edit/index',
  'pages/goals/plan/index',
  'pages/calendar/index',
  'pages/fitness/index',
  'pages/advancement/index',
  'pages/defense/index',
];

const app = JSON.parse(fs.readFileSync('dist/app.json', 'utf8'));

test('四个 tab 与共享导航的 TAB_ROUTES 一致，顺序固定为今天/课表/学习/校园', () => {
  const { TAB_ROUTES } = require('../dist/ui/navigation.js');
  assert.equal(app.tabBar.list.length, 4);
  assert.deepEqual(
    app.tabBar.list.map((item) => item.pagePath),
    ['pages/home/index', 'pages/timetable/index', 'pages/study/index', 'pages/campus/index'],
  );
  assert.deepEqual(
    app.tabBar.list.map((item) => '/' + item.pagePath),
    ['today', 'timetable', 'study', 'campus'].map((tab) => TAB_ROUTES[tab]),
  );
  assert.deepEqual(app.tabBar.list.map((item) => item.text), ['今天', '课表', '学习', '校园']);
  assert.equal(app.tabBar.color, '#6b5d57');
  assert.equal(app.tabBar.selectedColor, '#c41c23');
});

test('每个 tab 都是已注册页面，四件套齐全', () => {
  for (const item of app.tabBar.list) {
    assert.ok(app.pages.includes(item.pagePath), `${item.pagePath} 未在 pages 注册`);
    for (const ext of ['js', 'json', 'wxml', 'wxss']) {
      assert.ok(fs.existsSync(`dist/${item.pagePath}.${ext}`), `${item.pagePath}.${ext} 缺失`);
    }
  }
});

test('tab 图标是本地 81×81 PNG，普通态与选中态各一份', () => {
  for (const item of app.tabBar.list) {
    for (const key of ['iconPath', 'selectedIconPath']) {
      const rel = item[key];
      assert.ok(rel.endsWith('.png'), `${rel} 必须是位图：原生 tabBar 不接受 svg`);
      const file = path.join('dist', rel);
      assert.ok(fs.existsSync(file), `${file} 不存在`);
      const buffer = fs.readFileSync(file);
      assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${rel} 不是 PNG`);
      assert.equal(buffer.readUInt32BE(16), 81, `${rel} 宽应为 81`);
      assert.equal(buffer.readUInt32BE(20), 81, `${rel} 高应为 81`);
      assert.ok(buffer.length < 40 * 1024, `${rel} 超过 tabBar 单图 40KB 限制`);
    }
  }
});

test('22 个旧路由一个不少，新增的只有学习与校园两个聚合入口', () => {
  for (const route of ORIGINAL_ROUTES) {
    assert.ok(app.pages.includes(route), `${route} 不应被移除`);
  }
  assert.deepEqual(app.pages.filter((route) => !ORIGINAL_ROUTES.includes(route)).sort(), [
    'pages/campus/index',
    'pages/study/index',
  ]);
});

test('不写自定义 tabbar：底栏由基础库渲染，页面不重复画一条假底栏', () => {
  assert.equal(fs.existsSync('miniprogram/custom-tab-bar'), false, '无需自定义 tabbar 组件');
  for (const item of app.tabBar.list) {
    const wxml = fs.readFileSync(path.join('miniprogram', item.pagePath + '.wxml'), 'utf8');
    assert.equal(/tabbar/i.test(wxml), false, `${item.pagePath} 里不该出现假底栏`);
  }
});

test('学习/校园两个入口只指向已注册页面', () => {
  // 路由既可能写在页面脚本里（wx.navigateTo），也可能写在 WXML 的 data-route 上，
  // 两边都收，只要出现 /pages/<x>/index 就必须是已注册页面。
  for (const page of ['study', 'campus']) {
    const sources = ['js', 'wxml'].map((ext) => fs.readFileSync(path.join('dist/pages', page, `index.${ext}`), 'utf8'));
    const routes = new Set();
    for (const source of sources) {
      for (const match of source.matchAll(/\/pages\/([a-z-]+(?:\/[a-z-]+)?)\/index/g)) {
        routes.add(`pages/${match[1]}/index`);
      }
    }
    assert.ok(routes.size > 0, `${page} 页应有真实入口`);
    for (const route of routes) {
      assert.ok(app.pages.includes(route), `${page} 页指向未注册的路由 ${route}`);
    }
  }
});