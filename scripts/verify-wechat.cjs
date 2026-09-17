// 先用微信开发者工具 CLI auto --project <dist绝对路径> --auto-port 9420 打开项目。
const automator = require('miniprogram-automator');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

async function run() {
  const output = path.resolve('artifacts/p1');
  mkdirSync(output, { recursive: true });
  const mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  async function waitForPage(route) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const page = await mini.currentPage();
      if (page && page.path === route) return page;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`等待页面超时：${route}`);
  }
  try {
    await mini.callWxMethod('reLaunch', { url: '/pages/home/index' });
    const home = await waitForPage('pages/home/index');
    await home.waitFor(1200);
    assert.equal(await (await home.$('.school-name')).text(), '广东岭南职业技术学院');
    await mini.screenshot({ path: path.join(output, 'home.png') });

    // 学生部门：首页入口 → 列表 → 详情 → 返回列表 → 返回首页
    await (await home.$('#departments-entry')).tap();
    const list = await waitForPage('pages/departments/index');
    await list.waitFor(800);
    assert.ok(await list.$('#departments-list'), '部门列表未渲染');
    const firstItem = await list.$('.department-item');
    assert.ok(firstItem, '部门列表没有条目');
    const firstName = await (await firstItem.$('.department-name')).text();
    assert.ok(firstName, '部门条目缺少组织名称');
    assert.ok(await (await firstItem.$('.department-campus')).text(), '部门条目缺少所属校区或缺失文案');
    await mini.screenshot({ path: path.join(output, 'departments.png') });
    await firstItem.tap();
    const detail = await waitForPage('pages/departments/detail/index');
    await detail.waitFor(800);
    assert.ok(await detail.$('#department-detail'), '部门详情未渲染');
    assert.equal(await (await detail.$('.department-name')).text(), firstName);
    assert.ok(await detail.$('#department-contact'), '部门详情缺少联系方式区块');
    assert.ok(await detail.$('#department-activities'), '部门详情缺少动态区块');
    await mini.screenshot({ path: path.join(output, 'departments-detail.png') });
    await (await detail.$('#back-to-list')).tap();
    const listAgain = await waitForPage('pages/departments/index');
    await listAgain.waitFor(600);
    await (await listAgain.$('#back-home')).tap();
    await waitForPage('pages/home/index');

    // 课表：状态页仍为未接入状态
    const homeAgain = await mini.currentPage();
    await (await homeAgain.$('#timetable-entry')).tap();
    const timetable = await waitForPage('pages/timetable/index');
    await timetable.waitFor(800);
    assert.equal(await (await timetable.$('.status-title')).text(), '课表接入中');
    await mini.screenshot({ path: path.join(output, 'timetable.png') });
    await (await timetable.$('#back-home')).tap();
    await waitForPage('pages/home/index');

    // 直接打开部门详情：已知 id 显示组织，未知 id 显示未找到状态
    await mini.callWxMethod('reLaunch', { url: '/pages/departments/detail/index?id=student-union' });
    const directDetail = await waitForPage('pages/departments/detail/index');
    await directDetail.waitFor(800);
    assert.equal(await (await directDetail.$('.department-name')).text(), '校学生会');
    await (await directDetail.$('#back-to-list')).tap();
    await waitForPage('pages/departments/index');
    await mini.callWxMethod('reLaunch', { url: '/pages/departments/detail/index?id=not-a-department' });
    const missing = await waitForPage('pages/departments/detail/index');
    await missing.waitFor(800);
    assert.ok(await missing.$('#department-not-found'), '未知部门未显示未找到状态');

    // 直接打开部门列表页后返回首页
    await (await missing.$('#not-found-back')).tap();
    const directList = await waitForPage('pages/departments/index');
    await directList.waitFor(600);
    await (await directList.$('#back-home')).tap();
    await waitForPage('pages/home/index');

    // 直接打开课表状态页后返回首页
    await mini.callWxMethod('reLaunch', { url: '/pages/timetable/index' });
    const directTimetable = await waitForPage('pages/timetable/index');
    await directTimetable.waitFor(800);
    await (await directTimetable.$('#back-home')).tap();
    await waitForPage('pages/home/index');

    const system = await mini.systemInfo();
    const report = { verifiedAt: new Date().toISOString(), platform: system.platform,
      model: system.model, SDKVersion: system.SDKVersion,
      checks: ['学校名称', '学生部门入口与返回', '部门列表显示组织名称与校区',
        '部门详情显示介绍、联系方式或缺失、动态或缺失', '未知部门 id 显示未找到状态',
        '课表入口与返回', '直接进入部门列表后返回首页', '直接进入课表状态页后返回首页'],
      result: 'passed', realDevice: false };
    writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { mini.disconnect(); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
