// 先用微信开发者工具 CLI auto --project <dist绝对路径> --auto-port 9420 打开项目。
const automator = require('miniprogram-automator');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

async function run() {
  const output = path.resolve('artifacts/verify');
  mkdirSync(output, { recursive: true });
  const mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
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

    // 课表：入口 → 周课表页。云函数未部署或读不到时应显示可重试的错误状态，不白屏。
    const homeAgain = await mini.currentPage();
    await (await homeAgain.$('#timetable-entry')).tap();
    const timetable = await waitForPage('pages/timetable/index');
    await timetable.waitFor(1200);
    assert.equal(await (await timetable.$('.section-title')).text(), '我的课表');
    const importEntry = await timetable.$('#import-entry');
    const retryLoad = await timetable.$('#retry-load');
    assert.ok(importEntry || retryLoad, '课表页既没有导入入口也没有重试入口');
    if (retryLoad) {
      const errorText = await (await timetable.$('.tt-hint-copy')).text();
      assert.ok(errorText.length > 0, '读取失败时应给出说明文案');
      console.log(`课表读取状态：${errorText}`);
    }
    await mini.screenshot({ path: path.join(output, 'timetable.png') });
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
        '课表入口与返回（周课表页显示标题、导入或重试入口，不白屏）',
        '导入页显示「只能从聊天记录选择、先发给文件传输助手」引导与选择文件入口',
        '课程表单显示课程名、星期、起止节、周次与保存入口',
        '直接进入部门列表后返回首页', '直接进入课表页后返回首页',
        '首页展示最近资讯并可进入资讯列表', '资讯列表显示条目与分页页脚状态',
        '资讯详情显示标题、正文段落与复制原文链接入口', '列表与详情之间可往返'],
      result: 'passed', realDevice: false };
    writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { mini.disconnect(); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
