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
    for (const [entry, route, title] of [
      ['#departments-entry', 'pages/departments/index', '部门资料整理中'],
      ['#timetable-entry', 'pages/timetable/index', '课表接入中'],
    ]) {
      const current = await mini.currentPage();
      await (await current.$(entry)).tap();
      const target = await waitForPage(route);
      await target.waitFor(800);
      assert.equal(target.path, route);
      assert.equal(await (await target.$('.status-title')).text(), title);
      await mini.screenshot({ path: path.join(output, `${route.split('/')[1]}.png`) });
      await (await target.$('#back-home')).tap();
      await waitForPage('pages/home/index');
    }
    await mini.callWxMethod('reLaunch', { url: '/pages/timetable/index' });
    const direct = await waitForPage('pages/timetable/index');
    await direct.waitFor(800);
    await (await direct.$('#back-home')).tap();
    await waitForPage('pages/home/index');
    const system = await mini.systemInfo();
    const report = { verifiedAt: new Date().toISOString(), platform: system.platform,
      model: system.model, SDKVersion: system.SDKVersion,
      checks: ['学校名称', '部门入口及返回', '课表入口及返回', '直接进入状态页后返回首页'],
      result: 'passed', realDevice: false };
    writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { mini.disconnect(); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
