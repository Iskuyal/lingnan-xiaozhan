/**
 * 目标日（Issue #90）的开发者工具验收：创建 → 修改 → 删除 → 退出重进，
 * 并把每一步的截图与结果写进 `artifacts/verify/goals/`（可用 WECHAT_VERIFY_OUTPUT 指定归档目录）。
 *
 * 跑法（工具须已用 `cli.bat auto --project <仓库>/dist --auto-port 9420` 拉起）：
 *   node scripts/verify-goals.cjs
 *
 * 两条与图不走同一条路、必须写清的边界：
 * 1. **原生日期选择器无法自动化**（它是系统滚轮，不在小程序的元素树里），
 *    所以「选日期」这一步用 `page.callMethod('onDateChange', { detail: { value } })`
 *    触发与选择器**同形状**的事件载荷，页面处理逻辑与真实点击走的是同一条分支。
 * 2. 「退出重进」用 `mini.reLaunch` 重新加载页面并重新读本机存储来代表——
 *    本票要证的是「数据来自本机存储而不是内存」；真正的杀进程重启属人工步骤。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const { connectMini } = require('./lib/mini-connect.cjs');
const { installOfflineUiSession, restoreOfflineUiSession } = require('./lib/offline-ui-session.cjs');

const STORAGE_KEY = 'goal-days/v1';
const output = path.resolve(process.env.WECHAT_VERIFY_OUTPUT || 'artifacts/verify/goals');

/** 北京时间某一天相对今天的天数；与小程序侧的算法独立，用来交叉核对页面上的数字。 */
function shanghaiToday(now = Date.now()) {
  const shifted = new Date(now + 8 * 3600 * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

function diffDays(fromText, toText) {
  const [fy, fm, fd] = fromText.split('-').map(Number);
  const [ty, tm, td] = toText.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

async function run() {
  mkdirSync(output, { recursive: true });
  const mini = await connectMini();
  await mini.evaluate(installOfflineUiSession);
  const checks = [];
  const shots = [];
  let mockedModal = false;
  const beforeGoals = await mini.callWxMethod('getStorageSync', STORAGE_KEY);

  async function waitForPage(route, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await mini.currentPage();
      if (current && current.path === route) return current;
      if (Date.now() >= deadline) throw new Error(`等待页面超时：${route}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async function shot(name) {
    const file = path.join(output, `${name}.png`);
    await mini.screenshot({ path: file });
    shots.push(`${name}.png`);
  }

  /** 本机存储里当前的目标日（直接问小程序运行时，不经过页面）。 */
  async function storedGoals() {
    const raw = await mini.evaluate((key) => {
      const value = wx.getStorageSync(key);
      return typeof value === 'string' ? value : JSON.stringify(value || []);
    }, STORAGE_KEY);
    return raw === '' ? [] : JSON.parse(raw);
  }

  /** 点开列表里某一组的某一条的「修改 / 删除」键。 */
  async function tapAction(page, groupClass, index, which) {
    // 岭南红 UI 给两个键各加了修饰类（-edit / -warn），不再靠 DOM 顺序猜：
    // 未到期与今天两组现在有「排学习计划 / 修改 / 删除」三个键，按 .goal-action 取第 0 个会点到排计划。
    const items = await page.$$(`${groupClass} .goal-action-${which === 'delete' ? 'warn' : 'edit'}`);
    assert.ok(items.length > index, `${groupClass} 里没有第 ${index + 1} 个${which === 'delete' ? '删除' : '修改'}键`);
    await items[index].tap();
  }

  try {
    // 0) 干净起点：上一次运行留下的目标日会干扰断言。
    await mini.evaluate((key) => wx.removeStorageSync(key), STORAGE_KEY);

    // 最近目标已迁到学习tab，按完整集成版本验入口与天数。
    await mini.reLaunch('/pages/study/index');
    const home = await waitForPage('pages/study/index');
    await home.waitFor(800);
    // 首页入口带在岭南红 UI 里改成「标题 + 一句说明」的入口卡：没有目标日时说明位
    // 落一句主动语（不是状态口号），也不再显示「去添加」这样的伪按钮文本。
    assert.ok(await home.$('#study-hero'), '学习页缺少目标日入口');
    assert.equal(await home.data('hero.hasGoal'), false);
    assert.equal(await home.$('.study-hero-count'), null, '没有目标日时不该出现剩余天数');
    checks.push('学习页无目标时显示空态，不编造倒计时');
    await shot('01-home-no-goal');

    // 2) 空态。
    await home.callMethod('openGoals');
    const emptyPage = await waitForPage('pages/goals/index');
    await emptyPage.waitFor(500);
    // 空态标题已按设计稿 55 改写；`.goal-empty` / `.goal-empty-title` 作为语义钩子保留。
    assert.ok(await emptyPage.$('.goal-empty'), '目标日页没有空态');
    assert.equal(await (await emptyPage.$('.goal-empty-title')).text(), '下一个目标，是什么？');
    checks.push('没有数据时目标日页显示空态「下一个目标，是什么？」与新建入口');
    await shot('02-goals-empty');

    // 3) 新建一条未到期目标日：名称用真实输入框，日期用选择器同形状的事件载荷。
    await (await emptyPage.$('#goal-new')).tap();
    const edit = await waitForPage('pages/goals/edit/index');
    await edit.waitFor(500);
    await (await edit.$('#goal-name')).input('计算机二级考试');
    await edit.callMethod('onDateChange', { detail: { value: '2026-12-05' } });
    const previewLabel = await (await edit.$('.ge-preview-state')).text();
    const previewMeta = await (await edit.$('.ge-preview-meta')).text();
    const expectedFar = diffDays(shanghaiToday(), '2026-12-05');
    assert.equal(previewLabel, `还有 ${expectedFar} 天`, `预览天数不对：${previewLabel}`);
    assert.match(previewMeta, /2026-12-05 · 不计入当天 · 今天（北京时间）\d{4}-\d{2}-\d{2}/);
    checks.push(`新建页实时预览正确：距 2026-12-05 还有 ${expectedFar} 天，且标明不计入当天`);
    await shot('03-goals-edit-new');

    await (await edit.$('#goal-save')).tap();
    const listAfterCreate = await waitForPage('pages/goals/index');
    await listAfterCreate.waitFor(600);
    const firstRow = await listAfterCreate.$('.goal-item-upcoming');
    assert.ok(firstRow, '保存后列表里没有未到期条目');
    assert.equal(await (await firstRow.$('.goal-name')).text(), '计算机二级考试');
    assert.equal(await (await firstRow.$('.goal-state')).text(), `还有 ${expectedFar} 天`);
    assert.equal((await storedGoals()).length, 1);
    checks.push('新建后回到列表：条目落进「未到期」组，文案与本机存储一致');
    await shot('04-goals-list-one');

    // 4) 再建一条「今天」的目标日（默认日期就是今天）。
    await (await listAfterCreate.$('#goal-new')).tap();
    const editToday = await waitForPage('pages/goals/edit/index');
    await editToday.waitFor(500);
    await (await editToday.$('#goal-name')).input('体测补测');
    assert.equal((await editToday.data()).preview.label, '就是今天', '新建页默认日期应当是今天');
    await (await editToday.$('#goal-save')).tap();
    const listTwo = await waitForPage('pages/goals/index');
    await listTwo.waitFor(600);
    const todayRow = await listTwo.$('.goal-item-today');
    assert.ok(todayRow, '今天的目标日没有落进「今天」组');
    assert.equal(await (await todayRow.$('.goal-state')).text(), '就是今天');
    assert.equal((await storedGoals()).length, 2);
    checks.push('默认日期为今天：保存后落进「今天」组并显示「就是今天」');
    await shot('05-goals-today-group');

    // 5) 退出重进：重新加载页面后仍从本机存储读回两条。
    await mini.reLaunch('/pages/goals/index');
    const reopened = await waitForPage('pages/goals/index');
    await reopened.waitFor(600);
    assert.equal((await reopened.$$('.goal-item')).length, 2, '重进后条目数不对');
    assert.equal((await storedGoals()).length, 2);
    checks.push('退出重进（重新加载页面）后两条目标日仍在，数据来自本机存储');
    await shot('06-goals-reopen');

    // 6) 修改：「计入当天」打开后剩余天数 +1，保存后列表同步。
    await tapAction(reopened, '.goal-item-upcoming', 0, 'edit');
    const editExisting = await waitForPage('pages/goals/edit/index');
    await editExisting.waitFor(500);
    assert.equal(await (await editExisting.$('#goal-name')).value(), '计算机二级考试');
    await (await editExisting.$('#goal-count-today')).tap();
    // setData 是异步的：点完立刻读元素会读到上一帧，这里给渲染一点时间。
    await editExisting.waitFor(400);
    assert.equal(
      await (await editExisting.$('.ge-preview-state')).text(),
      `还有 ${expectedFar + 1} 天`,
      '打开「计入当天」后剩余天数应当加一',
    );
    await (await editExisting.$('#goal-save')).tap();
    const listAfterEdit = await waitForPage('pages/goals/index');
    listAfterEdit.waitFor(600);
    assert.equal(await (await listAfterEdit.$('.goal-item-upcoming .goal-state')).text(), `还有 ${expectedFar + 1} 天`);
    const edited = (await storedGoals()).find((item) => item.name === '计算机二级考试');
    assert.equal(edited.countToday, true, '「计入当天」没有写进本机存储');
    checks.push('修改生效：「计入当天」打开后剩余天数加一，列表与本机存储一致');
    await shot('07-goals-list-edited');

    // 7) 删除：「今天」那条 → 确认后消失，另一条不动。
    await mini.mockWxMethod('showModal', { confirm: true });
    mockedModal = true;
    await tapAction(listAfterEdit, '.goal-item-today', 0, 'delete');
    await listAfterEdit.waitFor(800);
    assert.equal((await listAfterEdit.$$('.goal-item')).length, 1, '删除后还剩 ' + (await listAfterEdit.$$('.goal-item')).length + ' 条');
    assert.equal((await listAfterEdit.$$('.goal-item-today')).length, 0, '「今天」组没有被清掉');
    const rest = await storedGoals();
    assert.deepEqual(rest.map((item) => item.name), ['计算机二级考试']);
    checks.push('删除经确认后生效：只剩另一条，本机存储同步');
    await shot('08-goals-after-delete');

    // 8) 首页入口带显示最近一条目标日。
    await mini.reLaunch('/pages/study/index');
    const homeAgain = await waitForPage('pages/study/index');
    await homeAgain.waitFor(800);
    assert.equal(await homeAgain.data('hero.name'), '计算机二级考试');
    // 岭南红 UI 把天数与单位合成同一段文本（不再有独立的 `.goal-strip-unit` 节点）。
    assert.equal(await homeAgain.data('hero.days'), String(expectedFar + 1));
    assert.equal(await homeAgain.data('hero.unit'), '天后');
    checks.push('学习页显示最近一条目标日与正确剩余天数');
    await shot('09-home-with-goal');

    const system = await mini.systemInfo();
    const report = {
      verifiedAt: new Date().toISOString(),
      platform: system.platform,
      model: system.model,
      SDKVersion: system.SDKVersion,
      checks,
      boundaries: [
        '请求、剪贴板和本机存储先接管为内存夹具，不触碰真实目标或计划',
        '原生日期选择器（系统滚轮）不在小程序元素树里，选日期用 page.callMethod("onDateChange") 触发同形状载荷',
        '「退出重进」以 mini.reLaunch 重新加载页面代表；杀进程重启仍是人工步骤',
      ],
      screenshots: shots,
      result: 'passed',
      realDevice: false,
    };
    writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await mini.callWxMethod('setStorageSync', STORAGE_KEY, beforeGoals).catch(() => {});
    if (mockedModal) {
      try {
        await mini.restoreWxMethod('showModal');
      } catch (error) {
        console.log(`撤掉 showModal 的替身失败：${error && error.message ? error.message : error}`);
      }
    }
    await mini.evaluate(restoreOfflineUiSession).catch(() => {});
    mini.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
