/**
 * 校历与考试（Issue #91）与体测估算（Issue #92）的开发者工具验收。
 *
 * 跑法（工具须已用 `cli.bat auto --project <仓库>/dist --auto-port 9420` 拉起）：
 *   node scripts/verify-campus-tools.cjs
 *
 * 两条边界与 `verify-goals.cjs` 相同：
 * 1. 断言里出现的日期都按**脚本自己独立算一遍**（不读页面数据），避免「页面写错、脚本也跟着错」；
 * 2. 剪贴板用 `wx.getClipboardData` 读回，证明确实把官方原文链接放进了剪贴板。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { connectMini } = require('./lib/mini-connect.cjs');

const output = path.resolve('docs/evidence/campus-tools');

/** 与实现独立的日期计算：北京时间今天与某天的天数差。 */
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
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const mini = await connectMini();
  const checks = [];
  const shots = [];
  const today = shanghaiToday();

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
    await mini.screenshot({ path: path.join(output, `${name}.png`) });
    shots.push(`${name}.png`);
  }

  try {
    // ---- 校历与考试 ----
    await mini.reLaunch('/pages/calendar/index');
    const calendar = await waitForPage('pages/calendar/index');
    await calendar.waitFor(800);

    const groupTitles = await Promise.all((await calendar.$$('.cal-group .section-title')).map((node) => node.text()));
    assert.deepEqual(groupTitles, ['学校校历', '四六级', '计算机等级', '普通话'], `分组标题不对：${groupTitles.join('、')}`);
    checks.push('校历与考试页按「学校校历 / 四六级 / 计算机等级 / 普通话」分组渲染');

    // 四级笔试卡：日期与倒计时都要与脚本独立算的一致
    const cardTexts = await Promise.all((await calendar.$$('.cal-card')).map(async (node) => ({
      title: await (await node.$('.cal-title-item')).text(),
      state: await (await node.$('.cal-state')).text(),
      lines: await Promise.all((await node.$$('.cal-val')).map((line) => line.text())),
    })));
    const cet4 = cardTexts.find((card) => card.title.includes('大学英语四级笔试'));
    assert.ok(cet4, '没有找到四级笔试卡片');
    const expectedDays = diffDays(today, '2026-12-12');
    assert.equal(cet4.state, `还有 ${expectedDays} 天`, `四级笔试倒计时不对：${cet4.state}`);
    assert.ok(cet4.lines.includes('2026-12-12 09:00–11:20'), `四级笔试缺考试日期：${cet4.lines.join(' | ')}`);
    assert.ok(
      cet4.lines.some((line) => line.includes('以本校教务处通知为准')),
      '四级笔试卡应当写明报名以本校通知为准',
    );
    checks.push(`四级笔试卡：考试 2026-12-12 09:00–11:20、倒计时「还有 ${expectedDays} 天」、报名行写「以本校教务处通知为准」`);
    await shot('01-calendar-list');

    // 没有官方日期的三类：不显示日期行，也不显示倒计时
    const pending = cardTexts.find((card) => card.title.includes('下一批'));
    assert.ok(pending, '没有找到计算机等级下一批卡片');
    assert.equal(pending.state, '待公布');
    assert.ok(!pending.lines.some((line) => /\d{4}-\d{2}-\d{2}/.test(line)), `待公布卡片不该有日期：${pending.lines.join(' | ')}`);
    const mandarin = cardTexts.find((card) => card.title.includes('普通话'));
    assert.equal(mandarin.state, '仅官方入口');
    const school = cardTexts.find((card) => card.title.includes('学校校历'));
    assert.equal(school.state, '仅官方入口');
    checks.push('待公布与仅官方入口的卡片都没有日期行，也没有倒计时');

    // 复制官方原文链接：读回剪贴板确认
    await (await calendar.$('#copy-source-cet-2026h2-cet4')).tap();
    const readClipboard = () => mini.evaluate(() => new Promise((resolve) => {
      wx.getClipboardData({ success: (result) => resolve(result.data), fail: () => resolve('') });
    }));
    // 写剪贴板与截图/点击在同一帧里可能还没落盘：读一次为空就再等一轮，最多三轮。
    let clipboard = '';
    for (let attempt = 0; attempt < 3 && clipboard === ''; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      clipboard = await readClipboard();
    }
    assert.equal(clipboard, 'https://cet.neea.edu.cn/html1/report/2609/1-1.htm', `剪贴板里不是官方公告链接：${clipboard}`);
    checks.push('复制原文链接把官方公告地址写进了剪贴板');

    await mini.pageScrollTo({ scrollTop: 100000 });
    await calendar.waitFor(400);
    await shot('02-calendar-pending');

    // ---- 体测估算 ----
    await mini.reLaunch('/pages/fitness/index');
    const fitness = await waitForPage('pages/fitness/index');
    await fitness.waitFor(800);

    const fill = async (selector, value) => {
      await (await fitness.$(selector)).input(String(value));
      await fitness.waitFor(120);
    };
    await fill('#fit-height', 175);
    await fill('#fit-weight', 61.3);
    await fill('#fit-vital', 5040);
    await fill('#fit-sprint', 6.7);
    await fill('#fit-sit', 24.9);
    await fill('#fit-jump', 273);
    await fill('#fit-strength', 19);
    await fill('#fit-run', '3′17″');

    // 长跑提示在 setData 之后才出现：轮询等它（改 WXML 后模拟器要重启才认新 id，这里不依赖 id）
    let runHint = '';
    const hintDeadline = Date.now() + 8000;
    while (Date.now() < hintDeadline && !runHint.includes('按')) {
      const hints = await fitness.$$('.fit-hint');
      for (const node of hints) {
        const text = await node.text();
        if (text.includes('按')) { runHint = text; break; }
      }
      if (!runHint.includes('按')) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.match(runHint, /按 3 分 17 秒（197 秒）计算/, `长跑换算提示不对：${runHint}`);
    await shot('03-fitness-input');

    await (await fitness.$('#fit-calc')).tap();
    await fitness.waitFor(600);
    assert.equal(await (await fitness.$('.fit-total')).text(), '100', '七项 100 分档应得总分 100');
    assert.equal(await (await fitness.$('.fit-grade')).text(), '优秀');
    const itemRows = await fitness.$$('.fit-table-row');
    assert.equal(itemRows.length, 7, `明细行数应为 7，实际 ${itemRows.length}`);
    checks.push('体测估算：七项齐全时给出总分 100、等级「优秀」与 7 行明细');
    await shot('04-fitness-result');

    // 改成超重（BMI 26.1）与缺项：不给总分与等级，缺项说明可见
    await mini.pageScrollTo({ scrollTop: 0 });
    await fitness.waitFor(300);
    await fill('#fit-weight', 80);
    await (await fitness.$('#fit-calc')).tap();
    await fitness.waitFor(600);
    assert.ok(await fitness.$('.fit-warn'), '超重时应当有琥珀提示条');
    const warnText = await (await fitness.$('.fit-warn')).text();
    assert.match(warnText, /没有给出学年总分与等级/, `提示条文案不对：${warnText}`);
    // BMI 那一行要写清「原表未给分」，这是本票最要紧的一句说明（它是明细表的第一行）
    const bmiNote = await (await fitness.$('.fit-item-note')).text();
    assert.ok(
      bmiNote.includes('没有给出单项得分'),
      `BMI 行没有写明「原表未给分」：${bmiNote}`,
    );
    assert.equal((await fitness.$$('.fit-total')).length, 0, '不完整时不该出现总分大数字');
    const partial = await (await fitness.$('.fit-total-partial')).text();
    assert.match(partial, /^\d/, `加权标准分应当是数字：${partial}`);
    const missing = await (await fitness.$('.fit-missing, .fit-notes')).text();
    assert.ok(missing.length > 0, '缺少说明文字');
    checks.push(`体测估算：BMI 超重（26.1）时不给总分与等级，改为显示加权标准分 ${partial} 并说明原因`);

    await mini.pageScrollTo({ scrollTop: 100000 });
    await fitness.waitFor(400);
    await shot('05-fitness-incomplete');

    const system = await mini.systemInfo();
    const report = {
      verifiedAt: new Date().toISOString(),
      platform: system.platform,
      model: system.model,
      SDKVersion: system.SDKVersion,
      checks,
      boundaries: [
        '脚本自己独立算一遍日期与分数，不读页面数据，避免「页面写错脚本也跟着错」',
        '长跑输入用元素 input 填 3′17″，换算提示由页面给出',
      ],
      screenshots: shots,
      result: 'passed',
      realDevice: false,
    };
    writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    mini.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
