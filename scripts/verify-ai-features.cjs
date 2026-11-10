/**
 * 本轮 AI 创新点（A 通知一键调课 / B 首页「今天」/ C 目标倒排计划 / D 问 AI 输入条）
 * 的开发者工具验收。
 *
 * 跑法（工具须已用 `cli.bat auto --project <仓库>/dist --auto-port 9420` 拉起）：
 *   node scripts/verify-ai-features.cjs          （或 npm run verify:ai-features）
 *
 * ## 三条必须写清的边界（不写清就等于谎报）
 *
 * 1. **A 的「识别」走真实模型**，但模型可能这次给 `changes`、下次给 `clarify`。
 *    所以「解析出提案」这一项按真实返回如实记录（`modelReply` 字段）；
 *    而「应用 → 写入 → 撤销」这段写入链路，在模型没给出可安全写入的 `add` 补课时
 *    改用**确定性载荷**注入提案，与 `parseNoticeReply` 的输出**同形状**。
 *    注入只替换「哪几条提案」，勾选 / 应用 / 撤销 / 写库 / 回滚全部走真实页面代码。
 *
 * 2. **只应用 `add`（补课）类变更**。它是唯一「新增一条、可整条删回」的变更；
 *    `cancel` / `relocate` / `move` 会改真实课程字段，验收不拿学生真实课表当试验田。
 *    应用前把 51 门课的完整快照存进 `artifacts/verify/ai-features/`，撤销后核对课程数复原。
 *
 * 3. **`realDevice: false`**。这是开发者工具模拟器（platform=devtools），不是真机；
 *    真机预览二维码由 `cli preview` 单独生成，扫码上手机属人工步骤。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const { connectMini } = require('./lib/mini-connect.cjs');

const output = path.resolve(process.env.WECHAT_VERIFY_OUTPUT || 'artifacts/verify/ai-features');
/** 补课变更要落到这些课里挑一门真实存在的，写入后撤销才干净。 */
const SEED_COURSE = { name: '高等数学', weekday: 1, startSection: 5, endSection: 6, location: '崇礼楼-306-计算机十九室' };

async function run() {
  mkdirSync(output, { recursive: true });
  const mini = await connectMini();
  const checks = [];
  const shots = [];
  const notes = [];
  const report = {
    modelReply: null,
    proposal: null,
    baseline: null,
  };
  let mockedModal = false;

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
    return file;
  }

  /**
   * 把某个元素滚进视野再截图。
   *
   * automator 的 screenshot 拍的是当前视口，不是整页；课表/计划这类长页面
   * 直接拍会全是顶部导航，评审看到的「证据」就变成空白表格（2026-11-10 踩过）。
   * 用 mini.evaluate 在页面里滚动，滚完再拍。
   */
  async function shotAt(name, selector) {
    await mini.evaluate((sel) => {
      const query = wx.createSelectorQuery();
      query.select(sel).boundingClientRect();
      query.selectViewport().scrollOffset();
      query.exec((res) => {
        const rect = res && res[0];
        const scroll = res && res[1];
        if (!rect || !scroll) return;
        // 往上留 80px，让标题和上一条内容露一点，比贴着屏幕顶端好读。
        const top = rect.top + (scroll.scrollTop || 0) - 80;
        wx.pageScrollTo({ scrollTop: Math.max(0, top), duration: 0 });
      });
    }, selector);
    // 滚动是异步渲染，等一帧再拍。
    await mini.evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)));
    return shot(name);
  }

  /** 读云端课表的完整快照（含 id），用于写入前后核对与失败兜底。 */
  async function liveCourses() {
    const feed = await mini.evaluate(() => new Promise((resolve) => {
      wx.cloud.callFunction({ name: 'timetable', data: { action: 'list' } }).then(
        (res) => resolve({ ok: true, result: res.result || {} }),
        (error) => resolve({ ok: false, error: String((error && (error.errMsg || error.message)) || error) }),
      );
    }));
    if (!feed.ok) throw new Error(`读不到真实课表：${feed.error}`);
    const courses = Array.isArray(feed.result.courses) ? feed.result.courses : [];
    return { courses, semester: feed.result.semester || '', count: feed.result.count };
  }

  /** 点元素；元素不存在时给出可读失败原因，而不是 undefined.tap() 的堆栈。 */
  async function tap(page, selector, label) {
    const node = await page.$(selector);
    assert.ok(node !== null, `找不到${label || selector}`);
    await node.tap();
    return node;
  }

  /** textarea / input 输入：优先真实输入，automator 不支持时退回同形状事件载荷（并记一条 note）。 */
  async function typeInto(page, selector, value, methodName, label) {
    const node = await page.$(selector);
    assert.ok(node !== null, `找不到${label || selector}`);
    try {
      await node.input(value);
      return 'input';
    } catch (error) {
      await page.callMethod(methodName, { detail: { value } });
      notes.push(`${label || selector}：automator 的 input 不可用，改用 callMethod('${methodName}') 同形状事件载荷`);
      return 'callMethod';
    }
  }

  try {
    // ────────────────────────── 基线：真实课表快照 ──────────────────────────
    const before = await liveCourses();
    report.baseline = { count: before.courses.length, semester: before.semester };
    writeFileSync(path.join(output, 'courses-before.json'), JSON.stringify(before, null, 2));
    assert.ok(before.courses.length > 0, '真实课表是空的，A 的写入链路无法验证');
    checks.push(`写入前基线：云端课表 ${before.courses.length} 门（已存档 courses-before.json）`);

    // ────────────────────────── B：首页改「今天」 ──────────────────────────
    // 注入固定「今天」与「现在 07:50」，避免简报内容随真实时钟漂移。
    await mini.reLaunch('/pages/home/index?today=2026-11-10&clock=470');
    const home = await waitForPage('pages/home/index');
    await home.waitFor(1200);

    const dateLine = await (await home.$('.masthead-date')).text();
    const greet = await (await home.$('.masthead-greet')).text();
    assert.match(dateLine, /^11月10日 星期二/u, `抬头日期不对：${dateLine}`);
    assert.match(greet, /^(早上好|中午好|下午好|晚上好)，/u, `抬头问候不对：${greet}`);
    // 本机 settings.startDate 为空 → 简报必须**不写周次**，而不是瞎写「第 N 周」。
    assert.equal(/第 \d+ 周/u.test(dateLine), false, `没设开学日却写死了周次：「${dateLine}」`);
    checks.push(`首页抬头：「${dateLine}」/「${greet}」；未设开学日时如实不写周次`);

    const briefLines = await Promise.all((await home.$$('.brief-line')).map((node) => node.text()));
    assert.ok(briefLines.length > 0, '今日简报没有正文');
    const sourceChips = await Promise.all((await home.$$('.ai-src-item')).map((node) => node.text()));
    assert.ok(sourceChips.length > 0, '今日简报没有「依据」条');
    assert.equal(sourceChips.every((text) => text.startsWith('依据 · ')), true, `依据条文案不对：${sourceChips.join('|')}`);
    checks.push(`今日简报 ${briefLines.length} 句，依据 ${sourceChips.length} 条（${sourceChips.join('、')}）`);

    const rows = await home.$$('.tl');
    assert.ok(rows.length > 0, '星期二有真实课程，时间线却是空的');
    const rowKinds = await Promise.all(rows.map((node) => node.attribute('class')));
    const coursesRows = rowKinds.filter((text) => text.includes('tl-course')).length;
    // 本机作息时刻全空 → hasTimes=false → 不允许出现钟点与空闲段（半截时刻比没有更糟）。
    assert.equal(coursesRows > 0, true, '时间线里没有课程行');
    assert.equal(rowKinds.some((text) => text.includes('tl-free')), false, '没填作息却插了空闲段');
    const clocks = await home.$$('.tl-clock');
    assert.equal(clocks.length, 0, `没填作息却显示了钟点（${clocks.length} 个）`);
    const sections = await home.$$('.tl-section');
    assert.ok(sections.length > 0, '时间线既没有钟点也没有节次，学生看不到什么时候上课');
    checks.push(`今日时间线 ${rows.length} 行（课程 ${coursesRows} 行）；作息全空时只给节次、不编钟点也不插空闲段`);
    await shot('01-home-today');

    // 「没有作息」这句要真的说出来，不能只体现在缺元素上。
    const briefNote = await (await home.$('.brief-note')).text();
    assert.match(briefNote, /没填作息|来自课表与目标日/u, `简报说明文案不对：${briefNote}`);
    checks.push(`简报说明：「${briefNote}」`);

    // ────────────────────────── D：问 AI 输入条 ──────────────────────────
    const askText = '这周三第几节有课？';
    const typeMode = await typeInto(home, '#ask-input', askText, 'onAskInput', '首页问 AI 输入框');
    await home.waitFor(300);
    assert.equal(await home.data('askText'), askText, '输入没有落到 askText');

    // 建议 chip：只填输入框，不许直接发送/跳转。
    await tap(home, '.suggest-chip', '建议 chip');
    await home.waitFor(300);
    const filled = await home.data('askText');
    assert.notEqual(filled, '', '点建议 chip 后输入框是空的');
    assert.equal(filled, '明天几点出门？', `第一个建议 chip 文案与设计图不一致：${filled}`);
    checks.push(`问 AI 输入条：${typeMode} 输入生效；建议 chip「${filled}」只填入输入框`);

    // 语音按钮：未接入 → 必须给可见的诚实提示，不产生录音/跳转。
    // 用一层记录器包住 wx.showToast：既不改页面逻辑，又能抓到提示原文。
    // 上一层可能还留着上一次跑批的包裹（开发者工具进程不会随脚本退出），先还原再包。
    await mini.evaluate(() => {
      if (globalThis.__aiFeatureToastPatched) {
        wx.showToast = globalThis.__aiFeatureToastOriginal;
        globalThis.__aiFeatureToastPatched = false;
      }
      globalThis.__aiFeatureToastOriginal = wx.showToast;
      globalThis.__aiFeatureToasts = [];
      wx.showToast = (options) => {
        globalThis.__aiFeatureToasts.push(String((options && options.title) || ''));
        return globalThis.__aiFeatureToastOriginal.call(wx, options);
      };
      globalThis.__aiFeatureToastPatched = true;
    });
    await tap(home, '#ask-voice', '语音按钮');
    await home.waitFor(700);
    const voiceToasts = await mini.evaluate(() => globalThis.__aiFeatureToasts || []);
    assert.equal(voiceToasts.length, 1, `点语音按钮应只弹一条提示，实际 ${voiceToasts.length} 条`);
    assert.match(voiceToasts[0], /语音输入(暂)?(还)?(没|未)(有)?接入/u, `语音提示不诚实或文案变了：${voiceToasts[0]}`);
    const stillHome = await mini.currentPage();
    assert.equal(stillHome.path, 'pages/home/index', '点语音按钮不该跳走');
    const askStill = await home.data('askText');
    assert.equal(askStill, filled, '点语音按钮不该改动输入内容');
    checks.push(`语音按钮：如实提示「${voiceToasts[0]}」，不跳转、不改输入（未接入就是未接入）`);
    await mini.evaluate(() => {
      if (!globalThis.__aiFeatureToastPatched) return;
      wx.showToast = globalThis.__aiFeatureToastOriginal;
      globalThis.__aiFeatureToastPatched = false;
      globalThis.__aiFeatureToasts = [];
    });

    // 拍照按钮：指向导入页的既有截图识别。
    await tap(home, '#ask-photo', '拍照按钮');
    const photoPage = await waitForPage('pages/timetable/import/index');
    assert.ok((await photoPage.$('#choose-photo')) !== null, '拍照按钮落到的导入页没有截图识别入口');
    checks.push('问 AI 输入条：拍照按钮打开课表导入页（既有截图识别链路）');
    await mini.reLaunch('/pages/home/index?today=2026-11-10&clock=470');
    const backHome = await waitForPage('pages/home/index');
    await backHome.waitFor(900);

    // 发送：跳到课表助手并带问题，但**不自动发送**。
    await typeInto(backHome, '#ask-input', askText, 'onAskInput', '首页问 AI 输入框（发送前）');
    await backHome.waitFor(300);
    await tap(backHome, '#ask-send', '问 AI 发送键');
    const assistant = await waitForPage('pages/timetable/index');
    await assistant.waitFor(1200);
    assert.equal(await assistant.data('noticeInput'), '', '发送不该写进通知框');
    assert.equal(await assistant.data('assistantOpen'), true, '发送后没有打开课表助手');
    assert.equal(await assistant.data('assistantInput'), askText, '问题没有带进助手输入框');
    // 只填不发：打开助手时本来就有且只有一条欢迎语（role=assistant，也带 .qa-answer 标记），
    // 所以不能数 .qa-answer，要数「有没有用户气泡 / 有没有比欢迎语更多的回答」。
    const bubbles = await assistant.data('assistantMessages');
    const userBubbles = bubbles.filter((item) => item.role === 'user');
    assert.equal(userBubbles.length, 0, `问题被自动发送了（有 ${userBubbles.length} 条用户气泡）`);
    assert.equal(bubbles.length, 1, `进页面时就该只有一条欢迎语，实际 ${bubbles.length} 条`);
    assert.equal(bubbles[0].role, 'assistant', '唯一那条气泡应是欢迎语');
    // 面板要等课表读完（status=ready）才渲染，DOM 断言前先等这一刻，别拿还没挂载的节点当「没发送」。
    const readyDeadline = Date.now() + 20000;
    while (Date.now() < readyDeadline && await assistant.data('status') !== 'ready') {
      await assistant.waitFor(300);
    }
    const earlyAnswers = await assistant.$$('.qa-answer');
    assert.equal(earlyAnswers.length, 1, `回答气泡只应是欢迎语那一条，实际 ${earlyAnswers.length} 条`);
    assert.equal(await (await assistant.$('.qa-msg-user')), null, '不该有用户气泡被渲染出来');
    checks.push('问 AI 输入条：发送后打开课表助手、问题填进输入框，且**没有自动发送**（只有欢迎语、0 条用户消息）');
    await shot('02-ask-to-assistant');

    // ────────────────────────── A：通知一键调课 ──────────────────────────
    await mini.reLaunch('/pages/timetable/index?today=2026-11-10&clock=470');
    const notice = await waitForPage('pages/timetable/index');
    await notice.waitFor(1500);
    if (await notice.data('status') !== 'ready') {
      throw new Error(`课表页没有进入 ready（status=${await notice.data('status')}，error=${await notice.data('noticeError')}）`);
    }

    // 直达入口：课表页上的「贴班群通知」应当一次点开就同时打开助手与粘贴框。
    await tap(notice, '#notice-entry', '课表页「贴班群通知」直达入口');
    await notice.waitFor(600);
    assert.equal(await notice.data('assistantOpen'), true, '直达入口没有打开助手面板');
    assert.equal(await notice.data('noticeOpen'), true, '直达入口没有打开粘贴框');
    checks.push('课表页有「贴班群通知」直达入口：一次点开助手 + 粘贴框，不用先在助手面板里翻');

    const noticeText = '班群通知：第 13 周周五 5-6 节补一节高等数学，地点在崇礼楼-306-计算机十九室。';
    await typeInto(notice, '#notice-input', noticeText, 'onNoticeInput', '通知输入框');
    await notice.waitFor(300);
    assert.equal(await notice.data('noticeInput'), noticeText, '通知文本没有落到 noticeInput');

    // 真实模型 → 真实解析。等到「有提案」或「有错误提示」为止。
    // 注意：`noticeReading` 初值就是 false，点完立刻读会读到「还没开始」的旧状态，
    // 进而把一次真实的模型调用误判成「没产出提案」（2026-11-10 真机路径踩过）。
    // 所以先等它变成 true（请求已在跑），再等它回到 false（有结论）。
    await tap(notice, '#notice-read', '识别变更');
    const spinDeadline = Date.now() + 15000;
    while (Date.now() < spinDeadline && (await notice.data('noticeReading')) !== true) {
      await notice.waitFor(200);
    }
    const readDeadline = Date.now() + 90000;
    let proposal = null;
    let readSettled = false;
    while (Date.now() < readDeadline) {
      const state = await notice.data();
      if (state.noticeReading === false) {
        proposal = state.noticeProposal;
        const error = state.noticeError;
        if (proposal === null && error === '') continue;
        readSettled = true;
        if (proposal === null) {
          report.modelReply = { kind: 'no-proposal', error };
        } else {
          report.modelReply = {
            kind: 'changes',
            rows: proposal.rows.map((row) => ({
              action: row.action,
              title: row.title,
              quote: row.quote,
              checked: row.checked,
              blocked: row.blocked,
              conflict: row.conflict,
              defaultChecked: row.defaultChecked,
            })),
          };
        }
        break;
      }
      await notice.waitFor(600);
    }
    assert.equal(readSettled, true, '识别超时：90 秒内既没有提案也没有错误提示');
    assert.notEqual(report.modelReply, null, '识别没有结论：既没有提案也没有错误提示');
    await shotAt('03-notice-proposal', '#notice-proposal');

    let applied = false;
    if (report.modelReply.kind === 'changes') {
      const rows = report.modelReply.rows;
      assert.ok(rows.length > 0, '提案是空的');
      // 每条提案都必须带原文引用 —— 这是设计图 02 的核心承诺。
      assert.equal(rows.every((row) => String(row.quote || '').trim() !== ''), true, `有提案没有原文引用：${JSON.stringify(rows)}`);
      const countText = await (await notice.$('#notice-proposal .proposal-title')).text();
      assert.match(countText, new RegExp(`识别到 ${rows.length} 处变更`, 'u'), `提案标题与实际条数不符：${countText}`);
      checks.push(`通知识别（真实模型）：${rows.length} 处变更，每条都带原文引用；${rows.map((row) => row.action).join('/')}`);
      report.proposal = rows;

      // 只应用 add（补课）：新增一条可整条删回，不拿真实课程的字段做实验。
      const addIndex = rows.findIndex((row) => row.action === 'add' && row.blocked === '');
      if (addIndex >= 0) {
        // 先把所有行取消勾选，再单独勾上那条 add —— 顺带验证「取消勾选的不写入」。
        for (let index = 0; index < rows.length; index += 1) {
          if (rows[index].checked) {
            const node = (await notice.$$('#notice-proposal .change'))[index];
            await node.tap();
            await notice.waitFor(200);
          }
        }
        await notice.waitFor(300);
        assert.equal(await notice.data('noticeProposal.checkedCount'), 0, '全部取消勾选后仍计数');
        const applyDisabled = await notice.data('noticeProposal.checkedCount');
        assert.equal(applyDisabled, 0, '取消勾选后按钮应禁用（0 处）');
        checks.push('通知提案：全部取消勾选后计数为 0（取消的不会写入）');

        const addNode = (await notice.$$('#notice-proposal .change'))[addIndex];
        await addNode.tap();
        await notice.waitFor(300);
        const checkedNow = await notice.data('noticeProposal.checkedCount');
        assert.equal(checkedNow, 1, `只勾一条后计数应为 1，实际 ${checkedNow}`);
        const buttonText = await (await notice.$('#notice-apply')).text();
        assert.match(buttonText, /应用 1 处变更/u, `按钮文案没有跟着勾选变：${buttonText}`);
        checks.push(`通知提案：按钮文案跟着勾选实时变（「${buttonText.trim()}」）`);

        await tap(notice, '#notice-apply', '应用变更');
        const applyDeadline = Date.now() + 45000;
        let afterApply = null;
        while (Date.now() < applyDeadline) {
          const state = await notice.data();
          if (state.noticeReading === false && state.noticeToast !== null) {
            afterApply = state.noticeToast;
            break;
          }
          await notice.waitFor(600);
        }
        assert.notEqual(afterApply, null, '应用后 45 秒内没有出现撤销提示');
        assert.equal(afterApply.canUndo, true, '应用成功后撤销提示不可撤销');
        checks.push(`通知应用：写入后提示「${afterApply.text}」且 10 秒内可撤销`);

        const during = await liveCourses();
        assert.equal(during.courses.length, before.courses.length + 1, `应用补课后课表应为 ${before.courses.length + 1} 门，实际 ${during.courses.length}`);
        assert.equal(during.courses.some((course) => course.name.includes('高等数学')), true, '补进去的课程在云端查不到');
        checks.push(`通知应用：云端课表 ${before.courses.length} → ${during.courses.length} 门（真实写入）`);
        applied = true;

        // 撤销：只留最近一批，10 秒窗口内点。
        await tap(notice, '#notice-undo', '撤销');
        const undoDeadline = Date.now() + 45000;
        let afterUndo = null;
        while (Date.now() < undoDeadline) {
          const state = await notice.data();
          if (state.noticeToast !== null && state.noticeToast.canUndo === false) {
            afterUndo = state.noticeToast;
            break;
          }
          await notice.waitFor(500);
        }
        assert.notEqual(afterUndo, null, '撤销后没有结果提示');
        const after = await liveCourses();
        assert.equal(after.courses.length, before.courses.length, `撤销后课表应回到 ${before.courses.length} 门，实际 ${after.courses.length}`);
        checks.push(`通知撤销：云端课表回到 ${after.courses.length} 门 ——「${afterUndo.text}」`);
        await shotAt('04-notice-after-undo', '#notice-toast');
      } else {
        notes.push('真实模型这次没有给出可安全写入的 add（补课）提案，写入/撤销链路改用确定性载荷验证');
      }
    } else {
      notes.push(`真实模型这次没产出提案（${report.modelReply.error || '无错误文案'}），按如实记录处理；写入/撤销链路改用确定性载荷验证`);
    }

    // 模型没给出 add 时的确定性载荷：形状与 parseNoticeReply 输出一致，只替换「哪几条提案」。
    if (!applied) {
      const injected = await mini.evaluate(() => {
        const page = getCurrentPages()[getCurrentPages().length - 1];
        page.setData({
          noticeReading: false,
          noticeError: '',
          noticeProposal: {
            checkedCount: 1,
            rows: [{
              index: 0,
              checked: true,
              action: 'add',
              title: '补课 · 高等数学',
              diffs: [],
              quote: '第 13 周周五 5-6 节补一节高等数学',
              detail: '新增一条课程记录',
              weekText: '第13周',
              weeks: [13],
              weeksRecognized: true,
              remainingWeeks: [],
              weekday: 5,
              startSection: 5,
              endSection: 6,
              courseId: '',
              courseName: '高等数学',
              location: '崇礼楼-306-计算机十九室',
              teacher: '',
              conflict: '',
              blocked: '',
              defaultChecked: true,
            }],
          },
        });
        return true;
      });
      assert.equal(injected, true, '注入确定性提案失败');
      await notice.waitFor(400);
      const injectedButton = await (await notice.$('#notice-apply')).text();
      assert.match(injectedButton, /应用 1 处变更/u, `注入提案后按钮文案不对：${injectedButton}`);
      await shotAt('03b-notice-injected', '#notice-proposal');

      await tap(notice, '#notice-apply', '应用变更（注入提案）');
      const applyDeadline = Date.now() + 45000;
      let toast = null;
      while (Date.now() < applyDeadline) {
        const state = await notice.data();
        if (state.noticeReading === false && state.noticeToast !== null) {
          toast = state.noticeToast;
          break;
        }
        await notice.waitFor(600);
      }
      assert.notEqual(toast, null, '注入提案应用后没有提示');
      const during = await liveCourses();
      assert.equal(during.courses.length, before.courses.length + 1, `应用后课表应为 ${before.courses.length + 1} 门，实际 ${during.courses.length}`);
      checks.push(`通知应用（确定性载荷）：云端课表 ${before.courses.length} → ${during.courses.length} 门，提示「${toast.text}」`);
      applied = true;

      await tap(notice, '#notice-undo', '撤销');
      const undoDeadline = Date.now() + 45000;
      let afterUndo = null;
      while (Date.now() < undoDeadline) {
        const state = await notice.data();
        if (state.noticeToast !== null && state.noticeToast.canUndo === false) {
          afterUndo = state.noticeToast;
          break;
        }
        await notice.waitFor(500);
      }
      const after = await liveCourses();
      assert.equal(after.courses.length, before.courses.length, `撤销后课表应回到 ${before.courses.length} 门，实际 ${after.courses.length}`);
      checks.push(`通知撤销（确定性载荷）：云端课表回到 ${after.courses.length} 门`);
      await shotAt('04-notice-after-undo', '#notice-toast');
    }

    // ────────────────────────── C：目标倒排计划 ──────────────────────────
    await mini.evaluate(() => wx.removeStorageSync('goal-days/v1'));
    await mini.evaluate(() => wx.removeStorageSync('study-plan/v1'));
    await mini.reLaunch('/pages/goals/index');
    const goalsEmpty = await waitForPage('pages/goals/index');
    await goalsEmpty.waitFor(600);
    await tap(goalsEmpty, '#goal-new', '新建目标日');
    const goalEdit = await waitForPage('pages/goals/edit/index');
    await goalEdit.waitFor(500);
    await typeInto(goalEdit, '#goal-name', '英语四级', 'onNameInput', '目标日名称');
    await goalEdit.callMethod('onDateChange', { detail: { value: '2026-12-13' } });
    await goalEdit.waitFor(400);
    await tap(goalEdit, '#goal-save', '保存目标日');
    const goalsList = await waitForPage('pages/goals/index');
    await goalsList.waitFor(800);

    const planEntry = await goalsList.$('.goal-item-upcoming .goal-action-plan');
    assert.ok(planEntry !== null, '目标日条目上没有「AI 排计划」入口');
    assert.equal(await planEntry.text(), 'AI 排计划');
    checks.push('目标日列表：未到期条目上有「AI 排计划」入口，点击进入计划页');
    await shot('05-goals-plan-entry');

    await planEntry.tap();
    const plan = await waitForPage('pages/goals/plan/index');
    await plan.waitFor(1500);
    assert.equal(await plan.data('status'), 'ready', `计划页没进入 ready（${await plan.data('status')}）`);
    assert.equal(await plan.data('goalName'), '英语四级', '计划页没带上目标日');

    const constraint = '听力最弱，每次别超过 1 小时，周末上午不排';
    await typeInto(plan, '#plan-constraint', constraint, 'onConstraintInput', '约束输入框');
    await plan.waitFor(300);
    await tap(plan, '#plan-generate', '生成计划');
    // 点击只是把事件丢给页面，generate 里先 setData({busy:true}) 再读云端课表；
    // 立刻读 data 会拿到还没开始跑的状态（busy=false、plan=null），误判成「生成失败」。
    await plan.waitFor(1000);

    const planDeadline = Date.now() + 60000;
    let hasPlan = false;
    while (Date.now() < planDeadline) {
      const state = await plan.data();
      if (state.busy === false) {
        if (state.plan !== null) hasPlan = true;
        else throw new Error(`生成计划失败：${state.error || '（页面没有给出错误文案）'}`);
        break;
      }
      await plan.waitFor(700);
    }
    assert.equal(hasPlan, true, '生成计划超时');

    const planCells = await plan.$$('.week .cell.plan');
    const busyCells = await plan.$$('.week .cell.busy');
    assert.ok(busyCells.length > 0, '迷你网格里没有「已有课程」格，说明没读到真实课表');
    const rationale = await Promise.all((await plan.$$('.ai-card.brief .brief-line')).map((node) => node.text()));
    assert.ok(rationale.length > 0, '没有「为什么这样排」的解释');
    const constraintLines = await Promise.all((await plan.$$('.ai-card.brief .ai-src-item')).map((node) => node.text()));
    assert.ok(constraintLines.length > 0, '没有约束依据条');
    const legend = await Promise.all((await plan.$$('.legend-item')).map((node) => node.text()));
    assert.deepEqual(legend, ['已有课程', 'AI 计划（未保存）', '空闲'], `图例文案不对：${legend.join('|')}`);
    checks.push(`备考计划：${planCells.length} 个计划格叠进 ${busyCells.length} 个已占格，解释 ${rationale.length} 句，依据 ${constraintLines.length} 条`);
    // 约束「每次别超过 1 小时」必须真的生效：任一块都不能超过 60 分钟。
    const blocks = await plan.data('plan.blocks');
    assert.ok(Array.isArray(blocks) && blocks.length > 0, '计划里没有学习块');
    const overLimit = blocks.filter((block) => block.minutes > 60);
    assert.equal(overLimit.length, 0, `有 ${overLimit.length} 个学习块超过 60 分钟，约束没生效`);
    // 迷你网格只画周一至周五；工作日排不下时会用到周末，但必须在页面上单列说明，不能偷偷排。
    const weekendBlocks = blocks.filter((block) => block.weekday >= 6);
    const weekendLines = await Promise.all((await plan.$$('.gp-weekend-line')).map((node) => node.text()));
    if (weekendBlocks.length === 0) {
      assert.equal(weekendLines.length, 0, '没有周末块却显示了周末说明');
    } else {
      assert.equal(weekendLines.length, weekendBlocks.length, `周末排了 ${weekendBlocks.length} 块，页面只说明 ${weekendLines.length} 块`);
    }
    // 约束里明说了「周末上午不排」，所以周末块绝不能落在第 1-4 节。
    const weekendMorning = weekendBlocks.filter((block) => block.startSection <= 4);
    assert.equal(weekendMorning.length, 0, `周末上午被排了 ${weekendMorning.length} 块，约束没生效`);
    checks.push(
      weekendBlocks.length === 0
        ? `备考计划：${blocks.length} 块全部 ≤ 60 分钟，且全部落在周一至周五（约束真的生效）`
        : `备考计划：${blocks.length} 块全部 ≤ 60 分钟；${weekendBlocks.length} 块在周末（不在周一到周五网格里，页面已单列说明），且没有一块在周末上午`,
    );
    await shot('06-goal-plan');

    await tap(plan, '#plan-save', '插入课表');
    await waitForPage('pages/goals/index');
    const savedPlan = await mini.evaluate(() => {
      const raw = wx.getStorageSync('study-plan/v1');
      return typeof raw === 'string' ? raw : JSON.stringify(raw || '');
    });
    assert.ok(typeof savedPlan === 'string' && savedPlan.length > 2, '「加入课表」后本机存储里没有计划');
    const savedParsed = JSON.parse(savedPlan);
    assert.equal(savedParsed.goalName, '英语四级', '存下来的计划不属于这个目标日');
    // 关键：计划只在本机，不能污染云端真实课表。
    const afterPlanSave = await liveCourses();
    assert.equal(afterPlanSave.courses.length, before.courses.length, `保存计划后云端课表被改动了：${before.courses.length} → ${afterPlanSave.courses.length}`);
    checks.push(`备考计划：加入后本机 study-plan/v1 有 ${savedParsed.blocks.length} 块，云端课表仍是 ${afterPlanSave.courses.length} 门（未污染）`);
    await shot('07-plan-saved');

    // 清理：撤回本机计划 + 删掉测试目标日。
    await mini.evaluate(() => wx.removeStorageSync('study-plan/v1'));
    await mini.mockWxMethod('showModal', { confirm: true });
    mockedModal = true;
    await mini.reLaunch('/pages/goals/index');
    const goalsClean = await waitForPage('pages/goals/index');
    await goalsClean.waitFor(800);
    const deleteKey = await goalsClean.$('.goal-item-upcoming .goal-action-warn');
    if (deleteKey !== null) {
      await deleteKey.tap();
      await goalsClean.waitFor(900);
    }
    await mini.restoreWxMethod('showModal');
    mockedModal = false;
    const goalsLeft = await goalsClean.$$('.goal-item');
    assert.equal(goalsLeft.length, 0, `清理后还剩 ${goalsLeft.length} 条测试目标日`);
    await mini.evaluate(() => wx.removeStorageSync('goal-days/v1'));
    checks.push('清理：测试目标日与本机计划已删净（本机不留验收垃圾）');

    // ────────────────────────── 收尾核对 ──────────────────────────
    const finalState = await liveCourses();
    assert.equal(finalState.courses.length, before.courses.length, `收尾时云端课表数量与基线不一致：${before.courses.length} → ${finalState.courses.length}`);
    const beforeIds = before.courses.map((course) => course.id).sort();
    const afterIds = finalState.courses.map((course) => course.id).sort();
    assert.deepEqual(afterIds, beforeIds, '收尾时云端课表的课程 id 与基线不一致（有残留或误删）');
    checks.push(`收尾核对：云端课表 ${finalState.courses.length} 门，课程 id 与基线逐条一致（写入已全部回滚）`);

    const system = await mini.systemInfo();
    const result = {
      verifiedAt: new Date().toISOString(),
      platform: system.platform,
      model: system.model,
      SDKVersion: system.SDKVersion,
      checks,
      notes,
      modelReply: report.modelReply,
      proposal: report.proposal,
      baseline: report.baseline,
      screenshots: shots,
      boundaries: [
        'A 的「识别」走真实模型；模型未给出可安全写入的 add 提案时，写入/撤销链路用与 parseNoticeReply 同形状的确定性载荷驱动，页面代码全部真实执行（见 notes）',
        '只应用 add（补课）类变更：它是唯一可整条删回的变更；cancel/relocate/move 会改真实课程字段，验收不拿真实课表当试验田',
        '本机作息时刻为空、开学日未设，因此 B 的降级路径（只给节次、不编钟点、不插空闲段）被实际验证；有作息的正常路径由 tests/home-today.test.cjs 覆盖',
        '原生日期选择器不在小程序元素树里，选日期用 page.callMethod("onDateChange") 触发同形状事件载荷（与 verify-goals.cjs 同口径）',
        '这是开发者工具模拟器（platform=devtools），不是真机；真机预览二维码由 cli preview 单独生成，扫码上手机属人工步骤',
      ],
      result: 'passed',
      realDevice: false,
    };
    writeFileSync(path.join(output, 'verification.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (mockedModal) {
      try {
        await mini.restoreWxMethod('showModal');
      } catch (error) {
        console.log(`撤掉 showModal 替身失败：${error && error.message ? error.message : error}`);
      }
    }
    mini.disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
