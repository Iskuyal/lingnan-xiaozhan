const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function loadCompiled(relative) {
  const filename = path.resolve(relative);
  const compiled = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: compiled,
    exports: compiled.exports,
    require: createRequire(filename),
  }, { filename });
  return compiled.exports;
}

function loadPage(route, wx, stack = [{}]) {
  const filename = path.resolve(`dist/pages/${route}/index.js`);
  let page;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: (options) => { page = options; },
    wx,
    getCurrentPages: () => stack,
    require: createRequire(filename),
    exports: {},
  }, { filename });
  // 页面里的 setData 在真实小程序中由框架提供，这里用等价的内存写入代替。
  page.setData = (patch) => Object.assign(page.data, patch);
  return page;
}

const service = () => loadCompiled('dist/services/departments.js');

// vm 中加载的模块属于另一个 realm，数组原型的引用不同，
// 结构化比较前先转成本 realm 的普通对象。
const plain = (value) => JSON.parse(JSON.stringify(value));

test('本地内容服务返回 5 个已核实的学生组织，来源与核查日期随数据提供', () => {
  const { listDepartments, departmentsSource } = service();
  const departments = listDepartments();
  assert.deepEqual(plain(departments.map((item) => item.name)), [
    '校学生团委',
    '校学生会',
    '校学生社团管理部',
    '青年志愿者联合会',
    '退役军人事务服务部',
  ]);
  assert.equal(departmentsSource.verifiedAt, '2026-09-18');
  assert.equal(departmentsSource.sourceUrl, 'https://lnc.edu.cn/tw/sygk/xszz');
  for (const item of departments) {
    assert.ok(item.id, `${item.name} 缺少 id`);
    assert.ok(item.introduction.length > 20, `${item.name} 介绍过短`);
    assert.equal(item.sourceUrl, departmentsSource.sourceUrl);
    // 官网没有公布联系方式，服务层不得填入任何电话或邮箱。
    assert.deepEqual(plain(item.contacts), [], `${item.name} 不应有编造的联系方式`);
  }
});

test('列表视图显示组织名称与所属校区，缺失时给出缺失文案', () => {
  const { buildDepartmentList, MISSING_CAMPUS_TEXT } = service();
  const view = buildDepartmentList();
  assert.equal(view.isEmpty, false);
  assert.equal(view.items.length, 5);
  for (const item of view.items) {
    assert.ok(item.name);
    assert.equal(item.campusMissing, item.campusLabel === MISSING_CAMPUS_TEXT);
    assert.ok(item.campusLabel, '校区栏不能为空，缺失时也要有文案');
  }
  const withCampus = view.items.find((item) => !item.campusMissing);
  assert.ok(withCampus, '至少应有一个组织的校区有官网依据');
  assert.ok(withCampus.campusLabel.includes('校区'));
});

test('列表为空时返回空态视图，不抛异常也不留空字段', () => {
  const { buildDepartmentList } = service();
  const view = buildDepartmentList([]);
  assert.equal(view.isEmpty, true);
  assert.deepEqual(plain(view.items), []);
  assert.ok(view.emptyTitle.length > 0);
  assert.ok(view.emptyCopy.length > 0);
});

test('列表页点击条目进入详情页并带上部门 id，详情页已在 app.json 注册', () => {
  const visited = [];
  const list = loadPage('departments', { navigateTo: ({ url }) => visited.push(url) });
  list.openDetail({ currentTarget: { dataset: { id: 'student-union' } } });
  assert.deepEqual(visited, ['/pages/departments/detail/index?id=student-union']);
  const app = JSON.parse(fs.readFileSync('dist/app.json', 'utf8'));
  for (const route of ['pages/departments/index', 'pages/departments/detail/index']) {
    assert.ok(app.pages.includes(route), `${route} 未在 app.json 注册`);
    for (const ext of ['js', 'json', 'wxml', 'wxss']) {
      assert.ok(fs.existsSync(`dist/${route}.${ext}`), `缺少 ${route}.${ext}`);
    }
  }
});

test('详情视图包含介绍、下设部门与来源，缺失联系方式如实显示', () => {
  const { buildDepartmentDetail, MISSING_CONTACT_TEXT } = service();
  const detail = buildDepartmentDetail('student-union');
  assert.equal(detail.name, '校学生会');
  assert.ok(detail.introduction.includes('全心全意为同学服务'));
  assert.deepEqual(plain(detail.units), ['权益部', '文娱部', '器材部', '体育部', '学创部']);
  assert.equal(detail.unitNote.length > 0, true);
  assert.equal(detail.contactMissing, true);
  assert.deepEqual(plain(detail.contactItems), []);
  assert.equal(detail.contactMissingText, MISSING_CONTACT_TEXT);
  assert.equal(detail.sourceUrl, 'https://lnc.edu.cn/tw/sygk/xszz');
  assert.equal(detail.verifiedAt, '2026-09-18');
});

test('每个组织都有 2025-2026 年的官网动态，标题、日期与来源可逐条核对', () => {
  const { buildDepartmentDetail } = service();
  for (const id of ['student-youth-league', 'student-union', 'student-club-management',
    'young-volunteers', 'veteran-affairs-service']) {
    const detail = buildDepartmentDetail(id);
    assert.ok(detail.activities.length >= 1, `${id} 应至少有一条官网动态`);
    assert.equal(detail.activityMissing, false);
    for (const activity of detail.activities) {
      assert.ok(activity.title, `${id} 动态缺标题`);
      assert.match(activity.publishedAt, /^202[56]-/, `${id} 动态日期应落在 2025-2026`);
      assert.match(activity.sourceUrl, /^https:\/\/lnc\.edu\.cn\/tw\//);
    }
  }
});

test('没有公开动态的组织返回动态缺失文案', () => {
  const { buildDepartmentDetail, listDepartments, MISSING_ACTIVITY_TEXT } = service();
  const withoutActivities = listDepartments().map((item) => ({ ...item, activities: [] }));
  const detail = buildDepartmentDetail('student-union', withoutActivities);
  assert.deepEqual(plain(detail.activities), []);
  assert.equal(detail.activityMissing, true);
  assert.equal(detail.activityMissingText, MISSING_ACTIVITY_TEXT);
});

test('未知部门 id 返回 null，详情页显示未找到状态且能返回列表', () => {
  const { buildDepartmentDetail } = service();
  for (const id of ['not-a-department', '', undefined, null, 42]) {
    assert.equal(buildDepartmentDetail(id), null, `id=${String(id)} 应返回 null`);
  }
  for (const stack of [[{}, {}], [{}]]) {
    const actions = [];
    const page = loadPage('departments/detail', {
      navigateBack: () => actions.push('back'),
      reLaunch: ({ url }) => actions.push(url),
    }, stack);
    page.onLoad({ id: 'not-a-department' });
    assert.equal(page.data.detail, null);
    assert.equal(page.data.notFound, true);
    assert.ok(page.data.notFoundTitle.length > 0);
    page.goBackToList();
    assert.deepEqual(actions, [stack.length > 1 ? 'back' : '/pages/departments/index']);
  }
});

test('详情页加载已知部门，直接打开时也能取到数据', () => {
  const page = loadPage('departments/detail', {});
  page.onLoad({ id: 'young-volunteers' });
  assert.equal(page.data.notFound, false);
  assert.equal(page.data.detail.name, '青年志愿者联合会');
  assert.ok(page.data.detail.units.includes('青枢部'));
  assert.equal(page.data.detail.campusMissing, false);
  assert.ok(page.data.detail.campusLabel.includes('广州校区'));
  assert.ok(page.data.detail.campusSourceUrl.startsWith('https://lnc.edu.cn/tw/'));
});

test('详情页复制来源链接成功与失败都有反馈', () => {
  for (const success of [true, false]) {
    const notices = [];
    const page = loadPage('departments/detail', {
      setClipboardData: (options) => {
        assert.equal(options.data, 'https://lnc.edu.cn/tw/sygk/xszz');
        (success ? options.success : options.fail)();
      },
      showToast: (options) => notices.push(options.title),
    });
    page.onLoad({ id: 'student-union' });
    page.copySource();
    assert.deepEqual(notices, [success ? '来源链接已复制' : '复制失败，请重试']);
  }
});

test('页面模板展示列表与详情字段，并包含空态、缺失与未找到分支', () => {
  const list = fs.readFileSync('dist/pages/departments/index.wxml', 'utf8');
  assert.match(list, /id="departments-list"/);
  assert.match(list, /class="department-item"/);
  assert.match(list, /item\.name/);
  assert.match(list, /item\.campusLabel/);
  assert.match(list, /view\.isEmpty/);
  assert.match(list, /emptyTitle/);
  const detail = fs.readFileSync('dist/pages/departments/detail/index.wxml', 'utf8');
  for (const binding of ['detail.introduction', 'detail.units', 'detail.contactMissingText',
    'detail.activityMissingText', 'detail.campusLabel', 'name', 'activities']) {
    assert.ok(detail.includes(binding), `详情模板未绑定 ${binding}`);
  }
  assert.match(detail, /id="back-to-list"/);
  assert.match(detail, /notFound/);
});
