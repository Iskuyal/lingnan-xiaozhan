// 先用微信开发者工具 CLI auto --project <dist绝对路径> --auto-port 9420 打开项目。
const { connectMini } = require('./lib/mini-connect.cjs');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync, readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');
// 只用于合成「不写学分」版式的 xlsx 夹具（原始文件含另一款课表工具的名字，不入库）。
const XLSX = require('xlsx');

async function run() {
  const output = path.resolve('artifacts/verify');
  mkdirSync(output, { recursive: true });
  const mini = await connectMini();
  let filePickerAvailable = null;
  async function waitForPage(route) {
    // 流程变长后开发者工具响应明显变慢（模拟器、连续截图、热重载），10 秒会误报超时。
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const page = await mini.currentPage();
      if (page && page.path === route) return page;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`等待页面超时：${route}`);
  }
  /**
   * 等这一次追问的结果。两条路径都算「有反应」：
   * ① 多了一条助手气泡（`.qa-answer`，模型答出来了）；
   * ② 页面上出现降级提示（`#qa-offline`）或失败文案（`.qa-error`）——
   *    云函数未部署 / 未配密钥时走这条，不能因为「没有回答」就判失败（PR #29 的断言口径）。
   * 两条都没等到才返回 null（页面真的没反应）。
   */
  async function waitForReply(page, before, previousError, timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await page.$$('.qa-answer');
      if (rows.length > before) return { kind: 'answer', text: await rows[rows.length - 1].text() };
      const notice = await currentErrorText(page);
      // 残留的失败提示不算本次结果：只有内容变了（或本来就是干净的）才认定降级。
      if (notice !== '' && notice !== previousError) return { kind: 'degraded', text: notice };
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  /**
   * 当前页面上**失败文案**的文本（`.qa-error` 优先），没有失败则空串。
   *
   * 为什么不优先读 `#qa-offline`：它是与失败同时出现的**固定说明句**
   * （「部门资料随小程序包提供，AI 不可用时仍可正常查看列表与详情。」），
   * 读它只能证明「出过错」，读不出**是哪一类错**——2026-09-19 实测撞到这一点：
   * 内容安全当日配额用尽让模型调用失败时，这个函数返回的仍是那句常量，
   * 导致下面的降级断言比对的是一句和失败原因无关的话，等于没验。
   * `#qa-offline` 单独断言（存在且写明资料仍可查看），两者各查各的。
   */
  async function currentErrorText(page) {
    const error = await page.$('.qa-error');
    if (error) return await error.text();
    const offline = await page.$('#qa-offline');
    if (offline) return await offline.text();
    return '';
  }
  /** 课表页可能在 loading（云函数冷启动）：等到出现某个已就绪状态的元素再判定。 */
  async function waitForTimetableSettled(page, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const importEntry = await page.$('#import-entry');
      if (importEntry) return { importEntry, retryLoad: null };
      const retryLoad = await page.$('#retry-load');
      if (retryLoad) return { importEntry: null, retryLoad };
      if (Date.now() >= deadline) return { importEntry: null, retryLoad: null };
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  /** 面板被用户收起过（本地持久标记）时不会自动展开，验收里显式点开，不然命不中元素。 */
  async function ensurePanelOpen(page, label) {
    const open = await page.$('#qa-open');
    if (open === null) return true;
    await open.tap();
    await page.waitFor(600);
    console.log(`${label}：对话框处于收起状态（此前被关过），已手动点开`);
    return (await page.$('#qa-prompt')) !== null;
  }
  try {
    await mini.callWxMethod('reLaunch', { url: '/pages/home/index' });
    const home = await waitForPage('pages/home/index');
    await home.waitFor(1200);
    assert.equal(await (await home.$('.school-name')).text(), '广东岭南职业技术学院');
    assert.ok(await home.$('#timetable-entry'), '首页缺少课表主入口');
    assert.ok(await home.$('#departments-entry'), '首页缺少学生部门入口');
    assert.ok(await home.$('#news-entry'), '首页缺少校园资讯入口');
    assert.equal(await home.$('#lost-found-entry'), null, '首页应保持定稿布局，不显示失物招领入口');
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

    // 部门 AI 问答（Ticket 07）：提示、选项、追问、返回后继续四条路径。
    // 云函数 `ai` 未部署或未配密钥时追问会落到降级提示，两种结果都算通过，
    // 但同时要验证「AI 不可用时部门资料照常展示」。
    assert.ok(
      await ensurePanelOpen(list, '部门列表页'),
      '部门列表页既没有对话框也没有打开入口（#qa-open 与 #qa-prompt 都命不中）',
    );
    const prompt = await (await list.$('#qa-prompt')).text();
    assert.match(prompt, /你想了解什么部门/u, `对话框没有提示选择部门：${prompt}`);
    assert.match(prompt, /官网未公布/u, '对话框要说清资料里没有的会回答官网未公布');
    const options = await list.$$('.qa-option');
    assert.equal(options.length, 5, `AI 选项数量应为 5，实际 ${options.length}`);
    for (const item of options) {
      assert.ok(await (await item.$('.qa-option-name')).text(), 'AI 选项缺少组织名称');
    }
    const unionOption = await list.$('#qa-option-student-union');
    assert.ok(unionOption, 'AI 选项里没有校学生会');
    // 开发者工具不会在两次验收之间重启小程序，上一次运行留下的对话还在；
    // 先清空当前部门的对话，让后续断言从干净状态开始。
    const leftoverRestart = await list.$('#qa-restart');
    if (leftoverRestart) {
      await leftoverRestart.tap();
      await list.waitFor(600);
    }
    await mini.screenshot({ path: path.join(output, 'departments-qa-list.png') });
    await unionOption.tap();
    const chatDetail = await waitForPage('pages/departments/detail/index');
    await chatDetail.waitFor(1000);
    assert.equal(await (await chatDetail.$('.department-name')).text(), '校学生会', '点选项进入的不是对应部门页');
    assert.ok(
      await ensurePanelOpen(chatDetail, '部门详情页'),
      '部门详情页没有问答面板（#qa-open 与 #qa-prompt 都命不中）',
    );
    assert.match(await (await chatDetail.$('#qa-prompt')).text(), /关于校学生会/u);
    const suggestions = await chatDetail.$$('.qa-suggestion');
    assert.equal(suggestions.length, 4, `详情页追问建议应为 4 条，实际 ${suggestions.length}`);
    const qaInput = await chatDetail.$('#qa-input');
    assert.ok(qaInput, '详情页缺少追问输入框');
    // 气泡按数量增量判定，不按下标：这样即使有历史残留也能等到这一次的新气泡。
    const rowsBefore = (await chatDetail.$$('.qa-answer')).length;
    const errorBefore = await currentErrorText(chatDetail);
    await suggestions[0].tap();
    const reply = await waitForReply(chatDetail, rowsBefore, errorBefore);
    // 云函数已配好密钥时应是资料里的回答；未配置或未部署时必须是可识别的降级提示，
    // 不能白屏或假成功。两种都算通过，但降级时要额外说明部门资料仍可查看。
    assert.ok(reply !== null, '发送追问后既没有回答也没有降级提示（页面没有反应）');
    if (reply.kind === 'degraded') {
      // 覆盖三类用户可见失败（模型不可用/超时、内容被拒、额度或配额用尽）与两类技术失败
      // （未部署/权限、内部错误）。**故意不覆盖 `invalid_request`（「AI 请求参数不正确」）**：
      // 它在这个流程里基本等于调用方把事件组装坏了，属于要修的缺陷，不该被当成可接受的降级。
      assert.match(
        reply.text,
        /暂时不可用|超时|内部错误|额度|未通过安全检测|尚未部署|权限/u,
        `降级提示无法识别：${reply.text}`,
      );
      const note = await chatDetail.$('#qa-offline');
      assert.ok(note, '降级时没有说明部门资料仍可查看');
      assert.match(await note.text(), /仍可正常查看/u, '降级说明没有写清部门资料仍可查看');
      console.log(`部门问答降级提示：${reply.text}`);
    } else {
      assert.ok(reply.text.length > 0, '回答内容为空');
      console.log(`部门问答回答：${reply.text}`);
    }
    assert.ok(await chatDetail.$('#department-contact'), '追问后部门资料区块消失了');
    assert.ok(await chatDetail.$('#department-activities'), '追问后组织动态区块消失了');
    await mini.screenshot({ path: path.join(output, 'departments-qa-detail.png') });

    // 返回列表后对话不丢，可以直接接着问。
    await (await chatDetail.$('#back-to-list')).tap();
    const listWithChat = await waitForPage('pages/departments/index');
    await listWithChat.waitFor(800);
    const kept = await listWithChat.$$('.qa-row-user');
    assert.ok(kept.length >= 1, '返回列表后对话被清空');
    assert.ok(await listWithChat.$('#qa-transcript'), '返回列表后没有对话记录区');
    const listInput = await listWithChat.$('#qa-input');
    assert.ok(listInput, '返回列表后无法继续追问');
    const beforeRows = (await listWithChat.$$('.qa-answer')).length;
    await listInput.input('这个部门有联系方式吗？');
    await (await listWithChat.$('#qa-send')).tap();
    const resumed = await waitForReply(listWithChat, beforeRows);
    assert.ok(resumed !== null, '在列表页继续追问后既没有回答也没有降级提示');
    console.log(`列表页继续追问（${resumed.kind}）：${resumed.text}`);
    await mini.screenshot({ path: path.join(output, 'departments-qa-resume.png') });

    // 诊断（不作为断言）：直接调一次 `ai` 云函数的用量动作，记录它当前能否正常应答。
    // 只读、不产生模型调用；结论写进验证记录，避免把「界面通过」当成「AI 已配好」。
    try {
      const usage = await mini.evaluate(() =>
        wx.cloud
          .callFunction({ name: 'ai', data: { action: 'usage' } })
          .then((response) => JSON.stringify(response.result))
          .catch((error) => `调用失败：${error.errMsg || error.message || error}`),
      );
      console.log(`ai 云函数诊断（usage）：${usage}`);
    } catch (error) {
      console.log(`ai 云函数诊断未执行：${error && error.message ? error.message : error}`);
    }

    // 返回列表后页面实例已重建，重新取条目再进入详情。
    const firstItemAgain = await listWithChat.$('.department-item');
    assert.ok(firstItemAgain, '返回列表后条目消失');
    await firstItemAgain.tap();
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

    // 课表：入口 → 周课表页。云函数未部署或读不到时应显示可重试的错误状态，不白屏。
    const homeAgain = await mini.currentPage();
    await (await homeAgain.$('#timetable-entry')).tap();
    const timetable = await waitForPage('pages/timetable/index');
    await timetable.waitFor(800);
    // 头部的主角是「第 N 周」（学期在副标题），课表本体在「本周课表」小标题下：
    // 原来断言的是「我的课表」，那是旧版头部的标题，2026-09-20 改版后由导航栏承担。
    const week = await timetable.$('.week-now');
    assert.ok(week !== null, '课表页头部应有周次');
    assert.match(await week.text(), /第 \d+ 周/u, '头部应显示当前周次');
    // 云函数冷启动时页面会停在 loading，此时两种入口都还没渲染——等到脱离中间态再判定。
    const settled = await waitForTimetableSettled(timetable);
    assert.ok(
      settled.importEntry || settled.retryLoad,
      '课表页既没有导入入口也没有重试入口（等待 20 秒后仍在加载或状态异常）',
    );
    if (settled.retryLoad) {
      const errorText = await (await timetable.$('.tt-hint-copy')).text();
      assert.ok(errorText.length > 0, '读取失败时应给出说明文案');
      console.log(`课表读取状态（错误态可重试）：${errorText}`);
    } else {
      const hint = await timetable.$('.tt-meta');
    console.log(`课表读取状态（已就绪）：${hint ? await hint.text() : '(无元信息行)'}`);
    }
    await mini.screenshot({ path: path.join(output, 'timetable.png') });

    // 仅在模拟器页面数据上展示缺少学期配置的退化态，不触碰云端课表/设置。
    if (await timetable.$('#week-grid')) {
      const original = {
        grid: await timetable.data('grid'),
        setupHint: await timetable.data('setupHint'),
        todayBar: await timetable.data('todayBar'),
        weekRange: await timetable.data('weekRange'),
      };
      const previewGrid = {
        ...original.grid,
        columns: original.grid.columns.map((column) => ({ ...column, dateLabel: '' })),
      };
      await timetable.setData({
        setupHint: '还没设置开学日与作息时间。设置后才显示周日期和「正在上/下一节」。',
        todayBar: null,
        weekRange: '',
        grid: previewGrid,
      });
      await timetable.waitFor(300);
      assert.ok(await timetable.$('.setup-hint'), '缺少学期设置预览应显示说明与设置入口');
      await mini.screenshot({ path: path.join(output, 'timetable-settings-missing.png') });
      await timetable.setData({
        setupHint: original.setupHint,
        todayBar: original.todayBar,
        weekRange: original.weekRange,
        grid: original.grid,
      });
    }

    // 课表改版（2026-09-20）的三处新界面：周网格 + 课程详情弹层、课表设置页、课程管理页。
    // 它们在本轮之前只有本地桩测试证据，这里补上真实渲染。
    // 真实样本第 1 周没有课：往后翻，直到出现课程块（有开学日时页面会自己落在本周，所以不写死翻几周）
    let blocks = [];
    for (let step = 0; step < 6 && blocks.length === 0; step += 1) {
      await (await timetable.$('#week-next')).tap();
      await timetable.waitFor(400);
      blocks = await timetable.$$('.grid-block');
    }
    assert.ok(blocks.length > 0, '往后翻周后应至少有一个课程块（周网格没有渲染出来）');
    assert.ok((await timetable.$('#week-grid')) !== null, '有课的周应渲染周网格容器');
    console.log(`周网格：出现 ${blocks.length} 个课程块（第 ${await (await timetable.$('.week-now')).text()}）`);
    await blocks[0].tap();
    await timetable.waitFor(500);
    assert.ok((await timetable.$('#course-sheet')) !== null, '点课程块应弹出课程详情弹层');
    const sheetName = await (await timetable.$('.sheet-name')).text();
    assert.ok(sheetName.length > 0, '详情弹层应显示课程名');
    await mini.screenshot({ path: path.join(output, 'timetable-sheet.png') });
    console.log(`课程详情弹层：已弹出（${sheetName}）并截图`);
    const sheetClose = await timetable.$('.sheet-close');
    if (sheetClose !== null) await sheetClose.tap();
    await timetable.waitFor(300);

    await (await timetable.$('#timetable-settings-entry')).tap();
    const settings = await waitForPage('pages/timetable/settings/index');
    await settings.waitFor(800);
    assert.ok((await settings.$('#settings-semester-name')) !== null, '设置页应有学期名称输入');
    assert.ok((await settings.$('#settings-start-date')) !== null, '设置页应有第一周星期一的选择');
    assert.ok((await settings.$('#settings-section-time-1')) !== null, '设置页应有第 1 节的作息输入');
    assert.ok((await settings.$('#settings-save')) !== null, '设置页应有保存入口');
    await mini.screenshot({ path: path.join(output, 'timetable-settings.png') });
    console.log(`课表设置页：表单可渲染（预览「${await (await settings.$('#settings-preview')).text()}」）`);
    await (await settings.$('#settings-back')).tap();
    const backToTimetable = await waitForPage('pages/timetable/index');
    await backToTimetable.waitFor(600);

    await (await backToTimetable.$('#manage-entry')).tap();
    const manage = await waitForPage('pages/timetable/manage/index');
    await manage.waitFor(800);
    const hasList = (await manage.$('#manage-list')) !== null;
    const hasEmpty = (await manage.$('.mg-empty')) !== null;
    assert.ok(hasList || hasEmpty, '课程管理页要么有列表要么有空态，不该是空白页');
    assert.ok((await manage.$('#manage-delete-selected')) !== null || hasEmpty, '有列表时应有批量删除入口');
    await mini.screenshot({ path: path.join(output, 'timetable-manage.png') });
    console.log(`课程管理页：${hasList ? '列表已渲染' : '空态已渲染'}`);
    await (await manage.$('#manage-back')).tap();
    await waitForPage('pages/timetable/index');

    await (await timetable.$('#back-home')).tap();
    await waitForPage('pages/home/index');

    // 导入引导文案：只能从微信聊天记录选择（文件选择本身无法自动化，这里验证引导与入口存在）
    await mini.callWxMethod('reLaunch', { url: '/pages/timetable/import/index' });
    const importPage = await waitForPage('pages/timetable/import/index');
    await importPage.waitFor(800);
    const guide = await (await importPage.$('#file-guide')).text();
    assert.match(guide, /聊天记录/u, '导入引导必须写明只能从聊天记录选择');
    assert.match(guide, /文件传输助手/u, '导入引导要给出可操作的中转办法');
    assert.ok(await importPage.$('#choose-file'), '导入页缺少选择文件入口');
    assert.ok(await importPage.$('#back-from-import'), '导入页缺少返回入口');
    await mini.screenshot({ path: path.join(output, 'timetable-import.png') });

    filePickerAvailable = await mini.evaluate(() => typeof wx.chooseMessageFile === 'function');
    if (filePickerAvailable) {
      // ---------- 以下两项是 Ticket 03 此前「文件选择无法自动化」而未实测的两个尾巴 ----------
      // 实测（2026-09-19）：`mini.mockWxMethod('chooseMessageFile', <结果对象>)` 可以顶替文件选择器，
      // 从而真实走完「上传 → 云函数解析」链路。**必须传结果对象**：传函数时开发者工具不会调用它，
      // 页面拿到的是 `options.success is not a function`（已试过）。
      async function placeInUserData(name, base64) {
        return await mini.evaluate((fileName, content) => {
          const filePath = wx.env.USER_DATA_PATH + '/' + fileName;
          wx.getFileSystemManager().writeFileSync(filePath, content, 'base64');
          return filePath;
        }, name, base64);
      }
      async function pickFile(filePath, name, size) {
        await mini.mockWxMethod('chooseMessageFile', { tempFiles: [{ path: filePath, name, size, type: 'file' }] });
        const page = await waitForPage('pages/timetable/import/index');
        const entry = await page.$('#choose-file');
        assert.ok(entry, '导入页没有选择文件入口');
        await entry.tap();
        await page.waitFor(600);
      }
      /** 页面退出中间态：出现确认页元素算成功，出现 `#import-error` 算失败，都没有则超时。 */
      async function waitForImportOutcome(timeoutMs = 45000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const page = await waitForPage('pages/timetable/import/index');
          if (await page.$('#abandon-import')) return { page, kind: 'review', text: '' };
          const error = await page.$('#import-error');
          if (error) return { page, kind: 'error', text: await error.text() };
          if (Date.now() >= deadline) return { page, kind: 'timeout', text: '' };
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      /** 云端本人课表条数（只读 `list`，不产生任何写入）。 */
      async function courseCount() {
        const raw = await mini.evaluate(() =>
          wx.cloud
            .callFunction({ name: 'timetable', data: { action: 'list' } })
            .then((response) => {
              const result = response && response.result;
              return JSON.stringify({ ok: !!(result && result.ok === true), count: result ? result.count : null });
            })
            .catch((error) => JSON.stringify({ ok: false, err: String(error && (error.errMsg || error.message)) })),
        );
        return JSON.parse(raw);
      }

      // ① 不可解析的文件：内容是纯文本、扩展名却是 .xls——真实走一遍上传与云端解析，
      //    页面必须给出学生看得懂的文案，而不是把平台错误原样抛出来。
      const bogusName = '这是一段文本.xls';
      const bogusPath = await placeInUserData(bogusName, Buffer.from('这不是课表内容，只是一段普通文本。').toString('base64'));
      await pickFile(bogusPath, bogusName, 48);
      const bogus = await waitForImportOutcome();
      assert.equal(bogus.kind, 'error', `不可解析的文件没有进入错误态（${bogus.kind}）`);
      assert.ok(bogus.text.length > 0, '不可解析的文件没有给出任何提示');
      assert.doesNotMatch(
        bogus.text,
        /-5\d{5}|timed out|permission denied|FUNCTION_NOT_FOUND|cloud\.|undefined/iu,
        `提示里出现了平台/技术性文本：${bogus.text}`,
      );
      console.log(`不可解析文件的提示：${bogus.text}`);
      await mini.screenshot({ path: path.join(output, 'timetable-import-error.png') });
      // 同一错误页的截图识别状态；只改变页面内存数据，不发起识别调用。
      await bogus.page.setData({
        step: 'error',
        photoError: true,
        errorMessage: '这张截图没有识别出可用课程。可以重试、改用文件，或手工录入。',
        capWarning: '',
      });
      await bogus.page.waitFor(300);
      await mini.screenshot({ path: path.join(output, 'timetable-photo-error.png') });

      // ② 真实教务导出样本 → 确认页 →「放弃导入」：不写库、清空草稿、回到引导态。
      const fixturesDir = path.resolve('tests/fixtures/timetable');
      const sample = readdirSync(fixturesDir).filter((name) => /\.xlsx?$/iu.test(name)).sort()[0];
      assert.ok(sample, '找不到真实教务导出样本，无法验证导入链路');
      const sampleBytes = readFileSync(path.join(fixturesDir, sample));
      await mini.callWxMethod('reLaunch', { url: '/pages/timetable/import/index' });
      await waitForPage('pages/timetable/import/index');
      const before = await courseCount();
      assert.equal(before.ok, true, `读不到本人课表条数，放弃导入的「不写库」无法判定：${JSON.stringify(before)}`);
      const samplePath = await placeInUserData(sample, sampleBytes.toString('base64'));
      await pickFile(samplePath, sample, sampleBytes.byteLength);
      const imported = await waitForImportOutcome();
      assert.equal(imported.kind, 'review', `真实样本没有进入确认页（${imported.kind}）：${imported.text}`);
      assert.ok(await imported.page.$('#draft-list'), '确认页没有草稿列表');
      assert.ok(await imported.page.$('#confirm-save'), '确认页没有保存入口');
      // 草稿必须真的有课程：空草稿下「放弃导入不写库」等于什么都没验。
      const draftCount = await imported.page.data('courseCount');
      assert.ok(typeof draftCount === 'number' && draftCount > 0, `确认页课程数为 ${draftCount}，草稿是空的，这一步验证不了「不写库」`);
      await mini.screenshot({ path: path.join(output, 'timetable-import-review.png') });
      //「放弃导入」会先弹 `wx.showModal` 确认框（「放弃后不会写入任何课表数据」）——
      // 原生确认框自动化点不到，这里把它顶替成「点了确认」，验证的是**确认之后**的行为。
      await mini.mockWxMethod('showModal', { confirm: true, cancel: false });
      await (await imported.page.$('#abandon-import')).tap();
      const afterAbandon = await waitForPage('pages/timetable/import/index');
      await afterAbandon.waitFor(800);
      assert.ok(await afterAbandon.$('#file-guide'), '放弃导入后没有回到引导态');
      assert.equal(await afterAbandon.$('#abandon-import'), null, '放弃导入后确认页元素仍在');
      const after = await courseCount();
      assert.equal(after.ok, true, '放弃导入后读不到课表条数');
      assert.equal(after.count, before.count, `放弃导入写了库：放弃前 ${before.count} 门、放弃后 ${after.count} 门`);
      console.log(`放弃导入：课表条数保持 ${before.count} 门，草稿已清空并回到引导态`);

      // ③ **不写学分**的版式（真实世界里出过 47/47 全部「课程名未识别」的故障，见 Ticket 03 第 8 节）：
      //    合成一份同版式的 xlsx 走真实云端解析，确认课程名/教师都拆得出来、没有条目被拦住。
      //    矩阵与 tests/timetable-parse.test.cjs 的同名用例逐字一致——原始文件含另一款课表工具的名字，不入库。
      const head = ['', '', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
      const matrix = [
        ['某某职业技术学院2026-2027学年第一学期班级课表（无学分版式）'],
        head,
        ['', '一', '劳动教育（一） 夏舜丽 [4]周 1-4节 40号楼-B310-服装工艺室（2） 清远校区 44'],
        ['', '二', '大学美育 程晓明 [4-5、7-16]周 5-6节 崇礼楼-306-计算机十九室 清远校区 44'],
        ['', '三', '5+3 真创项目 陈实 [1-16]周 7-8节 博雅D102 清远校区 41'],
      ];
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(matrix), '数据表');
      const noCredits = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
      await mini.callWxMethod('reLaunch', { url: '/pages/timetable/import/index' });
      await waitForPage('pages/timetable/import/index');
      const noCreditsPath = await placeInUserData('无学分课表.xlsx', noCredits.toString('base64'));
      await pickFile(noCreditsPath, '无学分课表.xlsx', noCredits.byteLength);
      const noCreditsOutcome = await waitForImportOutcome();
      assert.equal(noCreditsOutcome.kind, 'review', `无学分版式没有进入确认页（${noCreditsOutcome.kind}）：${noCreditsOutcome.text}`);
      const noCreditsView = JSON.parse(await mini.evaluate(() => {
        const pages = getCurrentPages();
        const data = pages[pages.length - 1].data;
        return JSON.stringify({
          courseCount: data.courseCount,
          blockedCount: data.blockedCount,
          warningCount: data.warningCount,
          rows: (data.items || []).map((item) => ({ name: item.name, teacher: item.teacherText, blocking: item.blocking })),
        });
      }));
      assert.equal(noCreditsView.courseCount, 3, `无学分版式应解析出 3 门课，实际 ${noCreditsView.courseCount}`);
      assert.equal(noCreditsView.blockedCount, 0, `无学分版式不该有需要补全的条目：${JSON.stringify(noCreditsView.rows)}`);
      assert.equal(noCreditsView.warningCount, 3, '缺学分必须留下待核对提示，不能被当成「识别得很干净」');
      assert.deepEqual(
        noCreditsView.rows.map((row) => `${row.name}｜${row.teacher}`),
        ['劳动教育（一）｜夏舜丽', '大学美育｜程晓明', '5+3 真创项目｜陈实'],
        '课程名与教师都要拆对（含带括号的课程名与含空格的课程名）',
      );
      console.log(`无学分版式：${noCreditsView.rows.map((row) => `${row.name}｜${row.teacher}`).join('、')}（待核对 ${noCreditsView.warningCount} 条）`);
      await mini.screenshot({ path: path.join(output, 'timetable-import-nocredits.png') });
      await mini.mockWxMethod('showModal', { confirm: true, cancel: false });
      await (await noCreditsOutcome.page.$('#abandon-import')).tap();
      await (await waitForPage('pages/timetable/import/index')).waitFor(600);
    } else {
      // 该模拟器没有暴露选文件 API：验降级提示路径，并把云端 Excel 链路明确记为未测。
      await mini.mockWxMethod('showModal', { confirm: true, cancel: false });
      await (await importPage.$('#choose-file')).tap();
      await importPage.waitFor(300);
      assert.ok(await importPage.$('#file-guide'), '缺少选文件 API 时应留在导入引导页');
      assert.equal(await importPage.$('#import-error'), null, '缺少选文件 API 时不应出现平台 TypeError 错误态');
      assert.ok(await importPage.$('#choose-photo'), '缺少选文件 API 时截图识别入口仍应可用');
      console.log('模拟器缺少 wx.chooseMessageFile：已验证导入降级；Excel 上传与云端解析项标为未测');
    }

    // 手工新增入口：表单字段与保存按钮渲染正常（保存需要已部署的云函数，这里只验证页面）
    await mini.callWxMethod('reLaunch', { url: '/pages/timetable/edit/index?scope=new' });
    const editPage = await waitForPage('pages/timetable/edit/index');
    await editPage.waitFor(800);
    for (const selector of ['#field-name', '#field-teacher', '#field-location', '#field-weekday', '#field-start', '#field-end', '#field-weeks', '#save-course']) {
      assert.ok(await editPage.$(selector), `课程表单缺少 ${selector}`);
    }
    await mini.screenshot({ path: path.join(output, 'timetable-edit.png') });
    await (await editPage.$('#back-from-edit')).tap();
    await waitForPage('pages/timetable/index');

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

    // 直接打开课表页后返回首页
    await mini.callWxMethod('reLaunch', { url: '/pages/timetable/index' });
    const directTimetable = await waitForPage('pages/timetable/index');
    await directTimetable.waitFor(800);
    await (await directTimetable.$('#back-home')).tap();
    await waitForPage('pages/home/index');

    // 资讯：首页最近资讯入口 → 列表 →（分页页脚状态）→ 详情 → 返回列表 → 返回首页
    const homeForNews = await mini.currentPage();
    await homeForNews.waitFor(800);
    assert.ok(await homeForNews.$('#news-entry'), '首页缺少校园资讯入口');
    const recentItems = await homeForNews.$$('.news-recent-item');
    assert.ok(recentItems.length > 0, '首页没有展示最近资讯');
    const recentTitle = await (await recentItems[0].$('.news-recent-title')).text();
    assert.ok(recentTitle.length > 0, '首页资讯条目缺少标题');
    assert.ok(await (await recentItems[0].$('.news-recent-date')).text(), '首页资讯条目缺少日期文案');
    await mini.screenshot({ path: path.join(output, 'home-news.png') });
    await (await homeForNews.$('#news-entry')).tap();
    const newsList = await waitForPage('pages/news/index');
    await newsList.waitFor(1000);
    const newsItems = await newsList.$$('.news-item');
    assert.ok(newsItems.length > 0, '资讯列表没有条目');
    const newsTitle = await (await newsItems[0].$('.news-item-title')).text();
    assert.equal(newsTitle, recentTitle, '首页最近资讯首条应与列表首条一致');
    // 分页页脚：现有云端数据不足一页时显示已无更多；数据超过一页时提供继续加载入口。
    const moreFooter = await newsList.$('.news-more');
    assert.ok(moreFooter, '资讯列表底部缺少分页状态提示');
    const moreText = await moreFooter.text();
    assert.ok(
      moreText.includes('已经到底了') || moreText.includes('加载更多'),
      `分页状态文案未知：${moreText}`,
    );
    await mini.screenshot({ path: path.join(output, 'news.png') });
    await newsItems[0].tap();
    const newsDetail = await waitForPage('pages/news/detail/index');
    await newsDetail.waitFor(1000);
    assert.equal(await (await newsDetail.$('.detail-title')).text(), newsTitle);
    assert.ok((await newsDetail.$$('.detail-paragraph')).length > 0, '资讯详情没有正文段落');
    assert.ok(await newsDetail.$('#copy-article-source'), '资讯详情缺少复制原文链接入口');
    await mini.screenshot({ path: path.join(output, 'news-detail.png') });
    await (await newsDetail.$('#back-from-detail')).tap();
    const newsListAgain = await waitForPage('pages/news/index');
    await newsListAgain.waitFor(600);
    assert.ok((await newsListAgain.$$('.news-item')).length > 0, '返回列表后条目被清空');
    await (await newsListAgain.$('#back-home')).tap();
    await waitForPage('pages/home/index');

    const system = await mini.systemInfo();
    const report = { verifiedAt: new Date().toISOString(), platform: system.platform,
      model: system.model, SDKVersion: system.SDKVersion,
      checks: ['学校名称', '学生部门入口与返回', '部门列表显示组织名称与校区',
        '部门详情显示介绍、联系方式或缺失、动态或缺失', '未知部门 id 显示未找到状态',
        'AI 对话框提示「你想了解什么部门」并列出 5 个可点选项',
        '点选项进入对应部门页，追问建议、输入框与回答/降级提示均可渲染',
        'AI 不可用时部门资料区块仍在，降级提示写明资料仍可浏览',
        '返回列表后对话不丢，可直接继续追问',
        '课表入口与返回（周课表页显示标题、导入或重试入口，不白屏）',
        '导入页显示「只能从聊天记录选择、先发给文件传输助手」引导与选择文件入口',
        ...(filePickerAvailable ? [
          '不可解析的文件给出可读提示（真实上传 → 云端解析失败 → 页面文案不含平台错误）',
          '真实样本导入到确认页后「放弃导入」不写库、草稿清空并回到引导态',
          '不写学分的版式在真实云端仍能拆出课程名与教师（3 门、0 条需要补全、3 条待核对）',
        ] : ['模拟器缺少 wx.chooseMessageFile 时显示降级提示，并保留截图识别入口']),
        '课程表单显示课程名、星期、起止节、周次与保存入口',
        '周网格渲染出课程块，点课程块弹出课程详情弹层',
        '课表设置页渲染学期与作息表单并可返回',
        '课程管理页渲染列表或空态，并有批量删除入口',
        '直接进入部门列表后返回首页', '直接进入课表页后返回首页',
        '首页展示最近资讯并可进入资讯列表', '资讯列表显示条目与分页页脚状态',
        '资讯详情显示标题、正文段落与复制原文链接入口', '列表与详情之间可往返'],
      skipped: filePickerAvailable ? [] : ['Excel 文件上传、云端解析、放弃导入写库边界与无学分版式解析（模拟器未提供 wx.chooseMessageFile）'],
      result: filePickerAvailable ? 'passed' : 'partial', realDevice: false };
    writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    // 顶替过的系统弹层必须撤掉，而且要在 `finally` 里撤：中间任何断言失败都会跳过写在下方的清理，
    // 把「自动确认的确认框」和「返回固定文件的选择器」留给下一次运行或后续人工操作。
    const restoreMethods = filePickerAvailable === false ? ['showModal'] : ['showModal', 'chooseMessageFile'];
    for (const method of restoreMethods) {
      try {
        await mini.restoreWxMethod(method);
      } catch (error) {
        console.log(`撤掉 ${method} 的替身失败（多半本来就没 mock 过）：${error && error.message ? error.message : error}`);
      }
    }
    mini.disconnect();
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
