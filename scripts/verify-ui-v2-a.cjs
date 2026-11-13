/** 岭南红 A 段（公共基础/首页/学习/校园/部门/资讯）原生模拟器验证。
 *
 * 端口 9461、独立项目目录（每次构建单独拷一份，避免 IDE 缓存出现「WXML 新、JS 旧」）。
 * 云函数、数据库与本机存储在本脚本里被替换为内存夹具；除夹具外不发出真实请求，
 * 不写真实云数据，也不调用真实模型。截图只作为本次实现的运行证据，
 * 不能代替真机、读屏或设计图评分。
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { connectMini } = require('./lib/mini-connect.cjs');

const INPUT = (value) => ({ detail: { value } });
const DATASET = (dataset) => ({ currentTarget: { dataset } });

async function waitForApp(mini) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const page = await mini.currentPage();
      if (page && page.path) return;
    } catch { /* CLI auto 可能先于首页元数据就绪。 */ }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('开发者工具启动页尚未就绪，请等编译完成后复跑');
}

function course(id, name, weekday, start, end, location) {
  return {
    id, name, weekday, teacher: '示例教师', location, campus: '清远校区', siteNumber: '',
    note: '离线布局验证示例', credits: '2',
    sectionRanges: [{ start, end }], startSection: start, endSection: end,
    weeks: Array.from({ length: 20 }, (_, index) => index + 1), weeksRecognized: true,
    weekText: '1–20周', source: 'manual', warnings: [], rawText: '',
    semester: '布局验证示例学期', createdAt: '', updatedAt: '',
  };
}

function fixtures() {
  const times = Array.from({ length: 12 }, () => ({ start: '', end: '' }));
  times[2] = { start: '10:10', end: '11:45' };
  times[3] = { start: '11:50', end: '12:35' };
  times[4] = { start: '14:00', end: '14:45' };
  times[5] = { start: '14:50', end: '15:35' };
  return {
    courses: [
      course('mock-java', 'Java 程序设计（布局示例）', 3, 3, 4, '博雅楼 B604'),
      course('mock-db', '数据库原理（布局示例）', 3, 5, 6, '博雅楼 A302'),
    ],
    semester: { semesterName: '布局验证示例学期', startDate: '2026-09-21', totalWeeks: 20, sectionTimes: times },
    news: [
      {
        id: 'mock-news-long',
        title: '校园资讯布局验证示例：一条很长的标题用来核对换行与日期列是否仍然可读（第二行继续写长）',
        date: '2026-11-11', url: 'https://lnc.edu.cn/', sourceLabel: '学校官网（离线布局示例）',
        updatedAt: '2026-11-11T01:00:00Z',
        paragraphs: [
          '这是一条明确标识的离线布局验证示例，不是学校发布的新闻。',
          '用于检查长标题、中文正文、来源说明和返回操作。',
        ],
      },
      { id: 'mock-news-2', title: '第二条示例资讯', date: '2026-11-09', url: 'https://lnc.edu.cn/', sourceLabel: '学校官网（离线布局示例）', updatedAt: '2026-11-09T01:00:00Z', paragraphs: ['示例正文。'] },
    ],
    storage: {
      'goal-days/v1': JSON.stringify([
        { id: 'mock-goal', name: '英语四级考试', date: '2026-12-19', countToday: false, createdAt: 1, updatedAt: 1 },
      ]),
    },
    qaAnswer: '当前资料里没有这项信息。\n\n已收录的组织介绍没有报名材料和报名时间，暂时无法确认。可以先看部门职责，再按学校发布的新公告核对。',
  };
}

async function install(mini, data) {
  await mini.evaluate((payload) => {
    const original = {
      call: wx.cloud.callFunction, database: wx.cloud.database, upload: wx.cloud.uploadFile,
      get: wx.getStorageSync, set: wx.setStorageSync, remove: wx.removeStorageSync,
    };
    globalThis.__uiV2A = { original, data: payload, calls: [], mode: 'ready' };
    wx.getStorageSync = (key) => payload.storage[key] ?? '';
    wx.setStorageSync = (key, value) => { payload.storage[key] = value; };
    wx.removeStorageSync = (key) => { delete payload.storage[key]; };
    wx.cloud.database = () => {
      let offset = 0, count = 20, id = '';
      const query = {
        collection() { return query; }, field() { return query; }, orderBy() { return query; },
        skip(value) { offset = value; return query; }, limit(value) { count = value; return query; },
        where(value) { id = value.id; return query; }, doc(value) { id = value; return query; },
        get() {
          const state = globalThis.__uiV2A;
          if (state.mode === 'error') return Promise.reject(new Error('离线模拟：云开发不可用'));
          if (state.mode === 'empty') return Promise.resolve({ data: [] });
          const rows = id ? payload.news.filter((row) => row.id === id) : payload.news.slice(offset, offset + count);
          return Promise.resolve({ data: rows });
        },
      };
      return query;
    };
    wx.cloud.callFunction = (options) => {
      const state = globalThis.__uiV2A;
      state.calls.push({ name: options.name, feature: options.data?.feature });
      if (options.name === 'ai') {
        return Promise.resolve({
          result: {
            ok: true, text: payload.qaAnswer, warnings: [], citations: [],
            safety: { checked: false }, capWarning: '',
          },
        });
      }
      if (options.name !== 'timetable') return Promise.reject(new Error('离线验证阻止了未配置云接口'));
      const action = options.data?.action;
      if (state.mode === 'error') return Promise.reject(new Error('离线模拟：课表读取失败'));
      if (action === 'list') {
        return Promise.resolve({
          result: { ok: true, courses: state.mode === 'empty' ? [] : payload.courses, count: state.mode === 'empty' ? 0 : payload.courses.length, semester: payload.semester.semesterName, updatedAt: '' },
        });
      }
      if (action === 'getSettings') {
        if (state.mode === 'no-times') {
          return Promise.resolve({ result: { ok: true, saved: false, settings: { semesterName: '', startDate: '', totalWeeks: 20, sectionTimes: Array.from({ length: 12 }, () => ({ start: '', end: '' })) } } });
        }
        return Promise.resolve({ result: { ok: true, saved: true, settings: payload.semester } });
      }
      return Promise.reject(new Error('离线验证阻止写入：' + action));
    };
    wx.cloud.uploadFile = (options) => { setTimeout(() => options.success({ fileID: 'cloud://mock-ui-only' }), 0); return { onProgressUpdate() {} }; };
  }, data);
}

async function run() {
  const directory = path.resolve(process.argv[2] || 'docs/evidence/lingnan-ui-implementation/a/screens');
  fs.mkdirSync(directory, { recursive: true });
  const report = {
    date: new Date().toISOString(),
    mode: 'wechat_simulator_mock',
    port: 9461,
    boundary: '原生模拟器；云函数、数据库、本机存储接管为示例夹具。接管后真实云请求 0 次、真实模型调用 0 次。不含连接前的启动读取，不证明真机、读屏或 320px 布局。',
    checks: [], screenshots: [], passed: false,
  };
  let mini = null;
  let installed = false;
  const shot = async (name, page) => {
    await page.waitFor(320);
    const file = path.join(directory, name + '.png');
    await mini.screenshot({ path: file });
    const width = fs.readFileSync(file).readUInt32BE(16);
    report.screenshots.push({ file: path.basename(file), page: page.path, rasterWidth: width });
  };
  const open = async (route) => {
    await mini.reLaunch(route);
    const page = await mini.currentPage();
    await page.waitFor(500);
    return page;
  };
  const check = (name, detail) => report.checks.push({ name, passed: true, detail: detail ?? '' });
  /** 等目标页面出现：模拟器切换有动画，固定等待容易抓到上一页。 */
  const waitForPath = async (expected, timeout = 4000) => {
    const deadline = Date.now() + timeout;
    let page = await mini.currentPage();
    while (page.path !== expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      page = await mini.currentPage();
    }
    return page;
  };
  const setMode = (mode) => mini.evaluate((next) => { globalThis.__uiV2A.mode = next; }, mode);

  try {
    mini = await connectMini('9461');
    await waitForApp(mini);
    report.environment = await mini.systemInfo();
    await install(mini, fixtures());
    installed = true;

    // 01 首页：下一节课卡片 + 今日时间线
    let page = await open('/pages/home/index?today=2026-11-11&clock=600');
    assert.equal(await page.data('state'), 'ready');
    const hero = await page.data('hero');
    assert.equal(hero.mode, 'class');
    assert.equal(hero.label, '下一节课');
    // 3–4 节跨两个小节：下课时刻取第 4 节结束（11:50–12:35 的 12:35），不是第 3 节的结束。
    assert.equal(hero.timeRange, '10:10 — 12:35');
    assert.equal(hero.sectionText, '第 3-4 节');
    await shot('01-home-next-class', page);
    const rows = await page.data('brief.rows');
    assert.ok(rows.length >= 2, '今日时间线至少两段');
    await mini.pageScrollTo(520);
    await shot('02-home-timeline', page);
    check('首页下一课卡片与今日时间线', JSON.stringify({ hero: hero.title, rows: rows.length }));

    // 02 首页：没填作息（设计图 53）
    await setMode('no-times');
    page = await open('/pages/home/index?today=2026-11-11&clock=600');
    assert.equal(await page.data('hero.mode'), 'unknown-times');
    const brief = await page.data('brief');
    assert.equal(brief.hasTimes, false);
    for (const row of brief.rows) assert.equal(row.timeText, '', '没填作息不许出现时刻');
    await shot('03-home-unknown-times', page);
    check('首页没填作息：只按节次看，不出现具体时刻');

    // 03 首页：没有课表（设计图 36）
    await setMode('empty');
    page = await open('/pages/home/index?today=2026-11-11&clock=600');
    assert.equal(await page.data('hero.mode'), 'empty');
    await shot('04-home-empty', page);
    check('首页空课表：导入与手工添加入口');

    // 04 首页：读取失败（设计图 37）
    await setMode('error');
    page = await open('/pages/home/index?today=2026-11-11&clock=600');
    assert.equal(await page.data('hero.mode'), 'error');
    await shot('05-home-error', page);
    check('首页读取失败：不说「今天没课」');

    await setMode('ready');

    // 05 学习聚合页（设计图 11）
    page = await open('/pages/study/index');
    const studyHero = await page.data('hero');
    assert.equal(studyHero.hasGoal, true);
    assert.equal(studyHero.name, '英语四级考试');
    assert.equal(studyHero.dateText, '12月19日');
    await shot('06-study', page);
    check('学习页目标卡读取本机目标日', JSON.stringify({ days: studyHero.days }));

    await mini.evaluate(() => { delete globalThis.__uiV2A.data.storage['goal-days/v1']; });
    page = await open('/pages/study/index');
    assert.equal(await page.data('hero.hasGoal'), false);
    await shot('07-study-no-goal', page);
    check('学习页没有目标日的空态');
    await mini.evaluate(() => { globalThis.__uiV2A.data.storage['goal-days/v1'] = JSON.stringify([{ id: 'mock-goal', name: '英语四级考试', date: '2026-12-19', countToday: false, createdAt: 1, updatedAt: 1 }]); });

    // 06 校园聚合页（设计图 19）
    page = await open('/pages/campus/index');
    assert.equal(await page.data('newsStatus'), 'ready');
    await shot('08-campus', page);
    await mini.pageScrollTo(700);
    await shot('09-campus-news', page);
    check('校园页最近资讯来自云端夹具');

    await setMode('error');
    page = await open('/pages/campus/index');
    assert.equal(await page.data('newsStatus'), 'error');
    await shot('10-campus-news-error', page);
    await setMode('ready');
    check('校园页资讯读取失败可重试');

    // 07 部门（设计图 20 / 22 / 65）
    page = await open('/pages/departments/index');
    assert.equal(await page.data('qaOpen'), true, '进入即展开问答面板');
    await shot('11-departments', page);
    const list = await page.data('view.items');
    assert.equal(list.length, 5);
    await page.callMethod('scrollToQa');
    await page.waitFor(600);
    await shot('12-department-qa', page);
    await page.callMethod('onQaInput', INPUT('现在报名需要什么材料？'));
    await page.callMethod('sendQuestion');
    await page.waitFor(800);
    const messages = await page.data('qaMessages');
    assert.ok(messages.length >= 2, '问答至少一问一答');
    assert.ok(String(messages[messages.length - 1].text).includes('没有这项信息'), '资料不足时如实说明');
    await mini.pageScrollTo(900);
    await shot('13-department-qa-insufficient', page);
    check('部门问答资料不足状态', JSON.stringify({ turns: messages.length }));

    page = await open('/pages/departments/detail/index?id=student-union');
    assert.equal(await page.data('notFound'), false);
    await shot('14-department-detail', page);
    await page.callMethod('scrollToQa');
    await page.waitFor(600);
    await shot('15-department-detail-qa', page);
    page = await open('/pages/departments/detail/index?id=unknown-department');
    assert.equal(await page.data('notFound'), true);
    await shot('16-department-not-found', page);
    check('部门详情、问答与未找到分支');

    // 08 资讯（设计图 23 / 24）
    page = await open('/pages/news/index');
    assert.equal(await page.data('status'), 'ready');
    await shot('17-news-list', page);
    await page.callMethod('openDetail', DATASET({ id: 'mock-news-long' }));
    page = await waitForPath('pages/news/detail/index');
    assert.equal(page.path, 'pages/news/detail/index');
    await shot('18-news-detail', page);
    await page.callMethod('goBack');
    page = await waitForPath('pages/news/index');
    assert.equal(page.path, 'pages/news/index', '详情返回列表');
    check('资讯列表进入详情再返回', '回到 pages/news/index');

    await setMode('error');
    page = await open('/pages/news/index');
    assert.equal(await page.data('status'), 'error');
    await shot('19-news-error', page);
    await page.callMethod('retry');
    await page.waitFor(400);
    assert.equal(await page.data('status'), 'error', '仍然失败时保持错误态');
    await setMode('empty');
    page = await open('/pages/news/index');
    assert.equal(await page.data('status'), 'empty');
    await shot('20-news-empty', page);
    await setMode('ready');
    check('资讯刷新失败保留错误态，空态独立');

    // 09 分享直达：详情直接打开，无处可返时回资讯列表
    page = await open('/pages/news/detail/index?id=mock-news-long');
    await page.callMethod('goBack');
    page = await waitForPath('pages/news/index');
    assert.equal(page.path, 'pages/news/index', '直达详情返回资讯列表');
    check('分享直达详情返回列表');

    // 10 跨 tab 意图：首页问课表 → 课表 tab + 一次性纸条
    page = await open('/pages/home/index?today=2026-11-11&clock=600');
    await page.callMethod('askTimetable');
    page = await waitForPath('pages/timetable/index');
    assert.equal(page.path, 'pages/timetable/index', '切到课表 tab');
    const intent = await mini.evaluate(() => wx.getStorageSync('lingnan/ui-timetable-intent/v1'));
    assert.ok(intent && intent.intent && intent.intent.kind === 'assistant', '意图已写入');
    await shot('21-timetable-from-home-intent', page);
    check('首页问课表切到课表 tab 并留下意图', JSON.stringify({ id: intent.id, consumed: false }));

    report.mockCalls = await mini.evaluate(() => globalThis.__uiV2A.calls);
    report.passed = true;
  } catch (error) {
    report.error = error && error.stack ? error.stack : String(error);
    process.exitCode = 1;
  } finally {
    if (installed && mini) {
      await mini.evaluate(() => {
        const original = globalThis.__uiV2A.original;
        wx.cloud.callFunction = original.call;
        wx.cloud.database = original.database;
        wx.cloud.uploadFile = original.upload;
        wx.getStorageSync = original.get;
        wx.setStorageSync = original.set;
        wx.removeStorageSync = original.remove;
        delete globalThis.__uiV2A;
      }).catch(() => {});
    }
    if (mini) mini.disconnect();
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, screenshots: report.screenshots.length, error: report.error }));
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { fixtures, install, waitForApp };