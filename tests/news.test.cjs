const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// 真实页面片段（抓取日期 2026-09-17），详情见 docs/news-sources.md。
const fixturesDir = path.resolve('tests/fixtures/news');
const fixture = (name) => fs.readFileSync(path.join(fixturesDir, name), 'utf8');
const LIST_URL = 'https://lnc.edu.cn/xyxw/xydt';
const articleUrl = (id) => `https://lnc.edu.cn/xyxw/xydt/${id}`;
/** 团委通知公告（Ticket 04 新增的第二套模板）：列表与正文见 docs/news-sources.md。 */
const TW_LIST_URL = 'https://lnc.edu.cn/tw/djxf/tqsd';
const TW_ARTICLE_URL = `${TW_LIST_URL}/content_32355`;
/** 解析模块随云函数部署，测试直接从云函数产物加载。 */
const PARSE_MODULE = 'dist/cloudfunctions/newsSync/parse.js';

const LIST_TITLES = [
  '向“新”而行，逐梦岭南——我校开展2026级新生入学教育',
  '以志为炬，温暖迎新——我校召开2026年迎新志愿者动员大会',
  '长沙文创艺术职业学院领导一行到我校参观交流',
];
const ARTICLE_TITLE = LIST_TITLES[0];
/** 团委通知公告第 1 页首条的标题（真实片段 tw-list-page-1.html / tw-article-32355.html）。 */
const TW_FIRST_TITLE = '关于开展2026年迎新志愿服务活动总结表彰工作的通知';
const FIRST_PARAGRAPH = '金秋九月，青春启航。9月7日至11日，学校2026级新生入学教育如约而至。本届入学教育以“习惯养成、融入大学”为核心，坚守立德树人根本任务，在“品质教育+专业教育”双模块基础上，创新融入“5+3”双创实践、AI科技体验等特色模块，大健康、工科、文科三大阵营同向发力，各二级学院（书院）立足专业特色、深耕产教融合，为新生献上一场有温度、有深度、有特色的成长启蒙，用心扣好大学生涯“第一粒扣子”，助力新生以昂扬姿态开启青春新篇。';
/** 官网正文尾部的编辑署名行前缀（实测 4 篇文章都有，其中 content_32039 用全角分号）。 */
const SIGNOFF = /^(供稿|初审|复审|终审|编辑|责编|摄影|撰稿|排版)[:：;；]/;

function loadModule(relativePath) {
  const filename = path.resolve(relativePath);
  return createRequire(filename)(filename);
}

function loadPage(name, wx, options = {}) {
  const filename = path.resolve(`dist/pages/${name}/index.js`);
  const realRequire = createRequire(filename);
  const stubs = options.stubs || {};
  const requireShim = (specifier) => (
    Object.prototype.hasOwnProperty.call(stubs, specifier) ? stubs[specifier] : realRequire(specifier)
  );
  let page;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: (definition) => { page = definition; },
    wx,
    getCurrentPages: () => options.stack || [{}],
    require: requireShim,
    module: { exports: {} },
    exports: {},
  }, { filename });
  page.setData = (patch) => { Object.assign(page.data, patch); };
  return page;
}

const EMPTY_META = { label: '学校官网 · 校园动态', syncedAt: '', fromServer: true };

/**
 * 页面通过 require 引入资讯服务；列表页与详情页的相对路径不同，桩要同时覆盖两者。
 * 服务本身访问云数据库，测试里一律替换为桩，不触碰真实云环境。
 */
function newsStub(listNews, getNewsDetail, listLimit = 20) {
  const service = {
    listNews,
    getNewsDetail,
    formatSyncTime: (iso) => (iso === '' ? '' : 'FORMATTED'),
    // 与 services/news/index.ts 的 messageOf 行为一致：优先取 message / errMsg。
    messageOf: (error) => {
      if (error !== null && error !== undefined && typeof error === 'object') {
        if (typeof error.message === 'string' && error.message !== '') return error.message;
        if (typeof error.errMsg === 'string' && error.errMsg !== '') return error.errMsg;
      }
      return error === null || error === undefined ? '未知错误' : String(error);
    },
    LIST_LIMIT: listLimit,
    RECENT_LIMIT: 3,
    SOURCE_LABEL: '学校官网 · 校园动态',
  };
  return {
    '../../services/news/index': service,
    '../../../services/news/index': service,
  };
}

// ---------- 解析（云函数侧纯函数，靠真实官网片段验证） ----------

test('列表页真实片段解析出全部条目，导航链接不被当作资讯', () => {
  const { parseNewsList } = loadModule(PARSE_MODULE);
  const items = parseNewsList(fixture('list-page-1.html'), LIST_URL);
  assert.deepEqual(items.map((item) => item.title), LIST_TITLES);
  assert.deepEqual(items.map((item) => item.date), ['2026-09-12', '2026-09-04', '2026-08-14']);
  assert.deepEqual(items.map((item) => item.url), [
    articleUrl('content_32118'),
    articleUrl('content_32039'),
    articleUrl('content_31144'),
  ]);
  assert.deepEqual(items.map((item) => item.id), ['content_32118', 'content_32039', 'content_31144']);
  assert.equal(items.some((item) => item.title === '学院章程'), false, '导航区 content_17924 链接不应成为条目');
});

test('文章页真实片段解析出标题、日期与正文段落', () => {
  const { parseNewsArticle } = loadModule(PARSE_MODULE);
  const article = parseNewsArticle(fixture('article-32118.html'), articleUrl('content_32118'));
  assert.equal(article.title, ARTICLE_TITLE);
  assert.equal(article.date, '2026-09-12');
  assert.equal(article.id, 'content_32118');
  assert.equal(article.url, articleUrl('content_32118'));
  assert.equal(article.paragraphs[0], FIRST_PARAGRAPH);
  assert.ok(article.paragraphs.includes('大健康阵营：AI赋能，仁心守护健康'));
  assert.equal(article.paragraphs.some((text) => text.includes('<')), false, '正文不应残留标签');
  assert.equal(article.paragraphs.some((text) => text.includes('分享到')), false, '分享区块不属于正文');
  assert.equal(article.paragraphs.some((text) => text.trim() === ''), false, '空白段落应被移除');
});

test('文章页结尾的编辑署名行被剥离', () => {
  const { parseNewsArticle } = loadModule(PARSE_MODULE);
  const article = parseNewsArticle(fixture('article-32118.html'), articleUrl('content_32118'));
  const signoff = article.paragraphs.filter((text) => SIGNOFF.test(text));
  assert.deepEqual(signoff, [], '尾部 4 行编辑署名不应留在正文里');
  assert.equal(article.paragraphs[article.paragraphs.length - 1].startsWith('五天的入学教育'), true);
  assert.ok(article.paragraphs.includes('中药学新生在药植园AI识别药植'), '图片说明段落应保留');
});

test('署名行的全角分号写法同样被剥离，前面的正文段落保留', () => {
  const { parseNewsArticle } = loadModule(PARSE_MODULE);
  const article = parseNewsArticle(fixture('article-32039-tail.html'), articleUrl('content_32039'));
  assert.equal(article.title, LIST_TITLES[1]);
  assert.equal(article.date, '2026-09-04');
  assert.equal(article.paragraphs.length, 2);
  assert.equal(article.paragraphs[0].startsWith('全体志愿者起立进行庄严宣誓'), true);
  assert.equal(article.paragraphs.join('').includes('复审；黄雅晴'), false);
});

test('署名行之后仍有正文时署名行不被剥离', () => {
  const { parseNewsArticle } = loadModule(PARSE_MODULE);
  // 用真实片段里的 <p> 标签组装输入（真实署名段 + 真实正文段），验证只剥离「尾部连续」的署名行。
  const tail = fixture('article-32039-tail.html');
  const signoffTags = tail.match(/<p[^>]*>[^<]*(?:供稿|初审|复审|终审)[^<]*<\/p>/g);
  const bodyTag = /<p[^>]*>全体志愿者起立[\s\S]*?<\/p>/.exec(tail)[0];
  const html = '<div class="article-content">' + signoffTags.join('') + bodyTag + '</div><div class="article-fd"></div>';
  const article = parseNewsArticle(html, articleUrl('content_32039'));
  assert.equal(article.paragraphs.length, signoffTags.length + 1);
  assert.ok(article.paragraphs.includes('供稿：团委'));
  assert.equal(article.paragraphs[article.paragraphs.length - 1].startsWith('全体志愿者起立'), true);
});

test('正文只由署名行组成时返回空段落数组', () => {
  const { parseNewsArticle } = loadModule(PARSE_MODULE);
  const tail = fixture('article-32039-tail.html');
  const signoffTags = tail.match(/<p[^>]*>[^<]*(?:供稿|初审|复审|终审)[^<]*<\/p>/g);
  const html = '<div class="article-content">' + signoffTags.join('') + '</div><div class="article-fd"></div>';
  const article = parseNewsArticle(html, articleUrl('content_32039'));
  assert.deepEqual(article.paragraphs, []);
});

test('同一原文 URL 的条目去重后只保留首次出现', () => {
  const { parseNewsList, dedupeByUrl } = loadModule(PARSE_MODULE);
  const items = parseNewsList(fixture('list-page-1.html'), LIST_URL);
  const repeated = [items[0], items[1], { ...items[0], title: `${items[0].title}（重复）` }, items[2], { ...items[1] }];
  const merged = dedupeByUrl(repeated);
  assert.deepEqual(merged.map((item) => item.url), items.map((item) => item.url));
  assert.deepEqual(merged.map((item) => item.title), items.map((item) => item.title));
  assert.deepEqual(dedupeByUrl([]), []);
});

test('条目缺少日期时保留条目并置空日期', () => {
  const { parseNewsList } = loadModule(PARSE_MODULE);
  // 真实片段上移除日期节点，模拟官网条目缺失日期（实测第 1/2/60/120/126 页均未出现，属容错分支）。
  const html = fixture('list-page-1.html').replace('<span class="date">2026-09-04</span>', '');
  const items = parseNewsList(html, LIST_URL);
  assert.equal(items.length, 3);
  assert.equal(items[1].date, '');
  assert.equal(items[1].title, LIST_TITLES[1]);
});

test('文章页缺少正文容器时仍返回标题与日期', () => {
  const { parseNewsArticle } = loadModule(PARSE_MODULE);
  const html = fixture('article-32118.html');
  // 真实片段上移除正文区块，模拟文章没有正文（官网抓取失败或纯图片正文）。
  const withoutBody = html.slice(0, html.indexOf('<div class="article-content"'))
    + html.slice(html.indexOf('<div class="article-fd"'));
  const article = parseNewsArticle(withoutBody, articleUrl('content_32118'));
  assert.equal(article.title, ARTICLE_TITLE);
  assert.equal(article.date, '2026-09-12');
  assert.deepEqual(article.paragraphs, []);
});

test('文章页缺少 h1.class="title" 时回退到 title 标签', () => {
  const { parseNewsArticle } = loadModule(PARSE_MODULE);
  // 真实片段上替换标题标签，模拟模板变化，验证 <title> 回退分支。
  const html = fixture('article-32118.html')
    .replace('<h1 class="title">', '<h2 class="title">')
    .replace('</h1>', '</h2>');
  const article = parseNewsArticle(html, articleUrl('content_32118'));
  assert.equal(article.title, ARTICLE_TITLE);
});

test('缺少列表容器或空输入时返回空数组', () => {
  const { parseNewsList } = loadModule(PARSE_MODULE);
  assert.deepEqual(parseNewsList(fixture('list-no-items.html'), LIST_URL), []);
  assert.deepEqual(parseNewsList('<ul class="list list-intro"></ul>', LIST_URL), []);
  assert.deepEqual(parseNewsList('', LIST_URL), []);
});

// ---------- 团委通知公告：第二套模板（Ticket 04） ----------

test('团委列表的 title 属性解析：标题与发表时间各自独立，标题里的年份不当日期', () => {
  const { parseAnnouncementAttribute } = loadModule(PARSE_MODULE);
  const raw = '标题：关于2025-2026年度广东省“两红两优”拟推荐名单的公示&#xD;&#xA;点击数：1478&#xD;&#xA;发表时间：2026-06-04';
  assert.deepEqual(parseAnnouncementAttribute(raw), {
    title: '关于2025-2026年度广东省“两红两优”拟推荐名单的公示',
    date: '2026-06-04',
  });
  // 没有「标题：」前缀时整串当标题；没有发表时间时日期为空
  assert.deepEqual(parseAnnouncementAttribute('只有标题'), { title: '只有标题', date: '' });
  assert.deepEqual(parseAnnouncementAttribute(''), { title: '', date: '' });
  assert.deepEqual(parseAnnouncementAttribute('标题：无时间的标题 点击数：3'), { title: '无时间的标题', date: '' });
});

test('团委通知公告列表页真实片段解析出全部 10 条，标题与日期齐全', () => {
  const { parseAnnouncementList } = loadModule(PARSE_MODULE);
  const items = parseAnnouncementList(fixture('tw-list-page-1.html'), TW_LIST_URL);
  assert.equal(items.length, 10, '第 1 页应解析出 10 条，与页脚「共155条信息/共16页」的第 1 页吻合');
  assert.deepEqual(items.map((item) => item.date), [
    '2026-09-18', '2026-06-18', '2026-06-04', '2026-05-15', '2026-04-10',
    '2026-03-10', '2026-03-09', '2026-03-06', '2026-03-06', '2026-03-06',
  ]);
  assert.deepEqual(items.map((item) => item.id), [
    'content_32355', 'content_29791', 'content_29144', 'content_28737', 'content_27674',
    'content_27028', 'content_26994', 'content_26930', 'content_26929', 'content_26928',
  ]);
  assert.equal(items[0].title, '关于开展2026年迎新志愿服务活动总结表彰工作的通知', '标题取 title 属性的「标题：」段，而不是整串含点击数的文本');
  assert.equal(items[0].url, `${TW_LIST_URL}/content_32355`);
  assert.deepEqual(
    items.filter((item) => item.title === '' || item.date === ''),
    [],
    '第 1 页所有条目都应解析出标题与日期',
  );
  assert.equal(
    items.some((item) => item.title === '通知公告' || item.title === '焦点新闻'),
    false,
    '侧栏 menuList 的导航项不应成为条目',
  );
});

test('团委列表的日期：span.date 优先，缺失时回退 title 属性里的「发表时间」', () => {
  const { parseAnnouncementList } = loadModule(PARSE_MODULE);
  const raw = fixture('tw-list-page-1.html');
  // (a) 真实片段首条：li 直挂 span.date，以它为准
  assert.equal(parseAnnouncementList(raw, TW_LIST_URL)[0].date, '2026-09-18');
  // (b) 真实片段上改掉首条的 span.date，验证 span 优先于 title 属性里的发表时间
  const changed = raw.replace('<span class="date">2026-09-18</span>', '<span class="date">2026-01-01</span>');
  assert.equal(parseAnnouncementList(changed, TW_LIST_URL)[0].date, '2026-01-01');
  // (c) 真实片段上删掉首条的 span.date：退回 title 属性里的「发表时间」（同一页面的真实字段）
  const withoutSpan = parseAnnouncementList(raw.replace('<span class="date">2026-09-18</span>', ''), TW_LIST_URL);
  assert.equal(withoutSpan[0].date, '2026-09-18', '缺 span.date 时用 title 属性中的发表时间');
  assert.equal(withoutSpan[0].title, TW_FIRST_TITLE, '标题里的年份不参与日期解析');
  assert.equal(withoutSpan[1].title, '关于2026年广东大学生“青马工程” 培训班学员推荐名单的公示');
  assert.equal(withoutSpan[1].date, '2026-06-18');
});

test('团委列表的日期与发表时间都缺时置空日期，条目仍保留', () => {
  const { parseAnnouncementList } = loadModule(PARSE_MODULE);
  const raw = fixture('tw-list-page-1.html');
  // 真实片段上同时删掉 span.date 与 title 属性里的「发表时间：」，模拟官网条目缺日期（容错分支）。
  const html = raw
    .replace('<span class="date">2026-09-18</span>', '')
    .replace(/&#xD;&#xA;发表时间：2026-09-18/, '');
  const items = parseAnnouncementList(html, TW_LIST_URL);
  assert.equal(items.length, 10);
  assert.equal(items[0].title, TW_FIRST_TITLE, '缺日期仍保留标题与链接');
  assert.equal(items[0].date, '');
  assert.equal(items[1].date, '2026-06-18', '其余条目不受影响');
});

test('团委文章页真实片段解析出标题、日期与正文段落', () => {
  const { parseAnnouncementArticle } = loadModule(PARSE_MODULE);
  const article = parseAnnouncementArticle(fixture('tw-article-32355.html'), TW_ARTICLE_URL);
  assert.equal(article.title, TW_FIRST_TITLE, '标题取 h2.title（该模板没有 h1.title）');
  assert.equal(article.date, '2026-09-18', '日期取 div.property 里的「发布时间」');
  assert.equal(article.id, 'content_32355');
  assert.equal(article.url, TW_ARTICLE_URL);
  assert.ok(article.paragraphs.length > 10, `正文段落数偏少：${article.paragraphs.length}`);
  assert.equal(article.paragraphs.some((text) => text.includes('<')), false, '正文不应残留标签');
  assert.equal(article.paragraphs.some((text) => text.includes('分享到')), false, '分享区块不属于正文');
  assert.equal(article.paragraphs.some((text) => text.includes('浏览次数')), false, '元信息块不属于正文');
  assert.equal(article.paragraphs.some((text) => text.trim() === ''), false, '空白段落应被移除');
  assert.equal(
    article.paragraphs.join('').includes('扫一扫') === false,
    true,
    '页面脚本与二维码提示不应混进正文',
  );
  assert.equal(
    /^\d{4}年\d{1,2}月\d{1,2}日$/.test(article.paragraphs[article.paragraphs.length - 1]),
    true,
    '末尾落款日期应保留（该模板署名只有「终审：团委」一行，不影响落款）',
  );
  assert.equal(
    article.paragraphs.some((text) => /^(供稿|初审|复审|终审)[:：;；]/.test(text)),
    false,
    '尾部编辑署名不应留在正文里',
  );
});

test('团委文章页缺少 h2.class="title" 时回退到 title 标签', () => {
  const { parseAnnouncementArticle } = loadModule(PARSE_MODULE);
  // fixture 是正文片段，不含 <head>；这里按官网 <title> 的真实格式（标题_通知公告_团委_学校）
  // 补一行，再删掉 h2.title，验证回退分支。
  const html = '<title>' + TW_FIRST_TITLE + '_通知公告_团委_广东岭南职业技术学院</title>'
    + fixture('tw-article-32355.html').replace('<h2 class="title">', '<h3 class="title">');
  const article = parseAnnouncementArticle(html, TW_ARTICLE_URL);
  assert.equal(article.title, TW_FIRST_TITLE, '<title> 回退时截掉后面的站点分段');
});

test('团委文章页缺少正文容器时仍返回标题与日期', () => {
  const { parseAnnouncementArticle } = loadModule(PARSE_MODULE);
  const html = fixture('tw-article-32355.html').replace('class="printArea"', 'class="noBody"');
  const article = parseAnnouncementArticle(html, TW_ARTICLE_URL);
  assert.equal(article.title, TW_FIRST_TITLE);
  assert.equal(article.date, '2026-09-18');
  assert.deepEqual(article.paragraphs, []);
});

test('两套模板各自分派：容器与标题锚点不同，交叉套用解析不出条目', () => {
  const { parseList, parseArticle } = loadModule(PARSE_MODULE);
  assert.equal(parseList(fixture('tw-list-page-1.html'), TW_LIST_URL, 'newsList').length, 10);
  assert.equal(parseList(fixture('list-page-1.html'), LIST_URL, 'xyxw').length, 3);
  assert.deepEqual(parseList(fixture('tw-list-page-1.html'), TW_LIST_URL, 'xyxw'), [], 'ul.newsList 不是校园动态的列表容器');
  assert.deepEqual(parseList(fixture('list-page-1.html'), LIST_URL, 'newsList'), [], 'ul.list-intro 不是通知公告的列表容器');
  const twAsXyxw = parseArticle(fixture('tw-article-32355.html'), TW_ARTICLE_URL, 'xyxw');
  assert.equal(twAsXyxw.title, '', '团委文章页没有 h1.title');
  assert.deepEqual(twAsXyxw.paragraphs, [], '团委文章页没有 div.article-content');
  assert.equal(parseArticle(fixture('tw-article-32355.html'), TW_ARTICLE_URL, 'newsList').date, '2026-09-18');
});

// ---------- Ticket 10：为「校园通知与办事指引问答」追加入库的 8 个栏目 ----------

/**
 * 2026-09-19 追加栏目的真实页面片段。它们全部实测为 `newsList` 模板（列表 ul.newsList、
 * 条目 title 属性、文章 div.printArea），因此**加栏目只改 columns.ts 的清单、不改解析**——
 * 本组测试锁定这一结论，免得日后有人以为需要新的模板分支。
 * 抓取与实测过程见 docs/tasks/tickets/10-campus-rag-qa.md 与 docs/news-sources.md。
 */
const ADDED_COLUMNS = [
  { file: 'bw-list-page-1.html', url: 'https://lnc.edu.cn/bw/tqsd', count: 10, title: '关于国庆中秋假期防御台风“麦德姆”的公告', date: '2025-10-05' },
  { file: 'bw-guide-list-page-1.html', url: 'https://lnc.edu.cn/bw/xywt', count: 7, title: '教职工户口迁移办理流程', date: '2025-07-01' },
  { file: 'bw-rule-list-page-1.html', url: 'https://lnc.edu.cn/bw/djxf/aqglzd', count: 1, title: '广东岭南职业技术学院（清远校区）交通与车辆管理规定（试行）', date: '2026-03-13' },
  { file: 'zl-list-page-1.html', url: 'https://lnc.edu.cn/zl/tzgg', count: 10, title: '关于开展2025-2026学年第二学期学生期末评价工作的通知', date: '2026-07-01' },
  { file: 'jwc-jxyh-list-page-1.html', url: 'https://lnc.edu.cn/jwc/jxyh', count: 9, title: '关于教材选用委员会成员的公示（教务部 〔2025〕8号 ）', date: '2025-03-03' },
  { file: 'zxsy-list-page-1.html', url: 'https://lnc.edu.cn/zxsy/lnpp', count: 5, title: '锚定目标明方向，实干笃行启新程——医学应用技术学院（知行书院）2025-2026学年第二学期教职工大会顺利召开', date: '2026-03-10' },
  { file: 'ln-list-page-1.html', url: 'https://lnc.edu.cn/ln/xssw/ggtz', count: 1, title: '关于陈志欣、魏建敏同学自动退学处理的公告', date: '2022-06-26' },
  { file: 'cl-list-page-1.html', url: 'https://lnc.edu.cn/cl/jyjx/zzyr', count: 3, title: '家校共育|家访，一场家校双向奔赴的沟通之旅', date: '2024-02-27' },
];

/** 追加栏目的文章页片段（每个栏目各一篇，取自该栏目列表首条）。 */
const ADDED_ARTICLES = [
  { file: 'bw-article-25412.html', url: 'https://lnc.edu.cn/bw/tqsd/content_25412', title: '关于国庆中秋假期防御台风“麦德姆”的公告', date: '2025-10-05' },
  { file: 'bw-guide-article-23050.html', url: 'https://lnc.edu.cn/bw/xywt/content_23050', title: '教职工户口迁移办理流程', date: '2025-07-01' },
  { file: 'bw-rule-article-27064.html', url: 'https://lnc.edu.cn/bw/djxf/aqglzd/content_27064', title: '广东岭南职业技术学院（清远校区）交通与车辆管理规定（试行）', date: '2026-03-13' },
  { file: 'zl-article-30318.html', url: 'https://lnc.edu.cn/zl/tzgg/content_30318', title: '关于开展2025-2026学年第二学期学生期末评价工作的通知', date: '2026-07-01' },
  { file: 'jwc-jxyh-article-21623.html', url: 'https://lnc.edu.cn/jwc/jxyh/content_21623', title: '关于教材选用委员会成员的公示（教务部 〔2025〕8号 ）', date: '2025-03-03' },
  { file: 'zxsy-article-27034.html', url: 'https://lnc.edu.cn/zxsy/lnpp/content_27034', title: '锚定目标明方向，实干笃行启新程——医学应用技术学院（知行书院）2025-2026学年第二学期教职工大会顺利召开', date: '2026-03-10' },
  { file: 'ln-article-10585.html', url: 'https://lnc.edu.cn/ln/xssw/ggtz/content_10585', title: '关于陈志欣、魏建敏同学自动退学处理的公告', date: '2022-06-26' },
  { file: 'cl-article-16590.html', url: 'https://lnc.edu.cn/cl/jyjx/zzyr/content_16590', title: '家校共育|家访，一场家校双向奔赴的沟通之旅', date: '2024-02-27' },
];

test('追加的 8 个栏目套用 newsList 模板即可解析，首条标题与日期逐条核对', () => {
  const { parseList } = loadModule(PARSE_MODULE);
  for (const column of ADDED_COLUMNS) {
    const items = parseList(fixture(column.file), column.url, 'newsList');
    assert.equal(items.length, column.count, `${column.file} 条目数`);
    assert.equal(items[0].title, column.title, `${column.file} 首条标题`);
    assert.equal(items[0].date, column.date, `${column.file} 首条日期`);
    assert.match(items[0].url, /^https:\/\/lnc\.edu\.cn\//, `${column.file} 首条应指向官网`);
    // 交叉套用校园动态模板必须解析不出条目：两套容器不同构（与 tw 的既有断言同一口径）。
    assert.deepEqual(parseList(fixture(column.file), column.url, 'xyxw'), [], `${column.file} 不应被 xyxw 模板解析`);
  }
});

test('追加栏目的文章页解析出标题、日期与正文段落', () => {
  const { parseArticle } = loadModule(PARSE_MODULE);
  for (const article of ADDED_ARTICLES) {
    const parsed = parseArticle(fixture(article.file), article.url, 'newsList');
    assert.equal(parsed.title, article.title, `${article.file} 标题`);
    assert.equal(parsed.date, article.date, `${article.file} 日期`);
    assert.ok(parsed.paragraphs.length > 0, `${article.file} 应有正文段落`);
    assert.ok(parsed.paragraphs.join('').length > 0, `${article.file} 正文不应为空`);
    // 正文尾部署名由既有规则剥离；只断言不残留导航/页脚文本。
    assert.ok(!parsed.paragraphs.some((line) => /^(分享到|扫码关注|统一门户|学院章程)$/.test(line.trim())), `${article.file} 不应含导航页脚`);
  }
});

test('列表标题属性被 CMS 二次转义时解两次，使列表与正文标题一致', () => {
  const { parseList, parseAnnouncementAttribute } = loadModule(PARSE_MODULE);
  // 实测原始属性值是 `&amp;nbsp;`：解一次只剩字面量，浏览器与我们的列表都会显示「&nbsp;」。
  const attribute = parseAnnouncementAttribute('标题：教务部&amp;nbsp;〔2025〕8号 点击数：51 发表时间：2025-03-03');
  assert.equal(attribute.title, '教务部 〔2025〕8号');
  assert.equal(attribute.date, '2025-03-03');
  const jwc = parseList(fixture('jwc-jxyh-list-page-1.html'), 'https://lnc.edu.cn/jwc/jxyh', 'newsList');
  assert.equal(jwc[0].title, ADDED_COLUMNS[4].title);
  assert.ok(!/&[a-zA-Z#][a-zA-Z0-9]*;/.test(jwc[0].title), '列表标题不应残留 HTML 实体');
  // 已上线的两个栏目（2026-09-18 上线）标题不受影响。
  for (const [file, url, template] of [
    ['tw-list-page-1.html', 'https://lnc.edu.cn/tw/djxf/tqsd', 'newsList'],
    ['list-page-1.html', 'https://lnc.edu.cn/xyxw/xydt', 'xyxw'],
  ]) {
    for (const item of parseList(fixture(file), url, template)) {
      assert.ok(!/&[a-zA-Z#][a-zA-Z0-9]*;/.test(item.title), `${file} 标题不应残留 HTML 实体`);
    }
  }
});

test('栏目内混入的站外条目仍被解析出来，由同步侧按外链处理（教务处教学运行实测 1 条）', () => {
  const { parseList } = loadModule(PARSE_MODULE);
  const items = parseList(fixture('jwc-jxyh-list-page-1.html'), 'https://lnc.edu.cn/jwc/jxyh', 'newsList');
  const offsite = items.filter((item) => !item.url.startsWith('https://lnc.edu.cn/'));
  assert.equal(offsite.length, 1, '该栏目实测混有 1 条公众号链接');
  assert.match(offsite[0].url, /^https:\/\/mp\.weixin\.qq\.com\//);
  // 解析层照常返回它（标题与日期可用）；正文是否抓取由同步侧的 isOffsiteUrl 决定——
  // 外链条目只存标题、日期与原文链接，不抓公众号正文（见 index.ts 的 saveOffsiteItem）。
  assert.ok(offsite[0].title !== '' && offsite[0].date !== '');
});

test('COLUMNS 清单包含追加的 8 个栏目，且模板均为 newsList', () => {
  const { COLUMNS } = loadModule('dist/cloudfunctions/newsSync/columns.js');
  const byId = new Map(COLUMNS.map((column) => [column.id, column]));
  const expected = [
    ['bw-tqsd', 'https://lnc.edu.cn/bw/tqsd', 2],
    ['bw-xywt', 'https://lnc.edu.cn/bw/xywt', 1],
    ['bw-aqglzd', 'https://lnc.edu.cn/bw/djxf/aqglzd', 1],
    ['zl-tzgg', 'https://lnc.edu.cn/zl/tzgg', 7],
    ['jwc-jxyh', 'https://lnc.edu.cn/jwc/jxyh', 1],
    ['zxsy-lnpp', 'https://lnc.edu.cn/zxsy/lnpp', 1],
    ['ln-ggtz', 'https://lnc.edu.cn/ln/xssw/ggtz', 1],
    ['cl-zzyr', 'https://lnc.edu.cn/cl/jyjx/zzyr', 1],
  ];
  for (const [id, listUrl, totalPages] of expected) {
    const column = byId.get(id);
    assert.ok(column !== undefined, `清单缺少栏目 ${id}`);
    assert.equal(column.listUrl, listUrl, `${id} 的列表 URL`);
    assert.equal(column.template, 'newsList', `${id} 应复用 newsList 模板`);
    assert.equal(column.totalPages, totalPages, `${id} 的总页数（实测页脚口径）`);
  }
  // 已上线栏目仍在清单里：校园动态保留以维持每日增量（全量已暂缓）。
  assert.equal(byId.get('tw-tqsd').totalPages, 16);
  assert.equal(byId.get('xyxw-xydt').totalPages, 126);
  // 栏目 id 同时是状态文档 `_id`，不得重复。
  assert.equal(byId.size, COLUMNS.length, '栏目 id 不得重复');
});

test('每个 fixture 都记录了来源 URL 与抓取日期', () => {
  for (const name of ['list-page-1.html', 'list-no-items.html', 'article-32118.html', 'article-32039-tail.html']) {
    const text = fixture(name);
    assert.match(text, /来源：https:\/\/lnc\.edu\.cn\/xyxw\/xydt/, name);
    assert.match(text, /抓取日期 2026-09-17/, name);
  }
  // 团委通知公告的第二套模板片段（Ticket 04，2026-09-18 抓取）
  for (const name of ['tw-list-page-1.html', 'tw-article-32355.html']) {
    const text = fixture(name);
    assert.match(text, /来源：https:\/\/lnc\.edu\.cn\/tw\/djxf\/tqsd/, name);
    assert.match(text, /抓取日期 2026-09-18/, name);
  }
  // Ticket 10 追加的 8 个栏目片段（2026-09-19 抓取）：来源必须是该栏目自己的 URL。
  for (const column of ADDED_COLUMNS.concat(ADDED_ARTICLES)) {
    const text = fixture(column.file);
    const path = new URL(column.url).pathname;
    const listPath = path.replace(/\/content_\d+$/, '');
    assert.match(text, new RegExp(`来源：https://lnc\\.edu\\.cn${listPath.replace(/[/.]/g, '\\$&')}`), column.file);
    assert.match(text, /抓取日期 2026-09-19/, column.file);
  }
});

// ---------- 客户端服务（云数据库读取） ----------

test('服务把云端记录映射为页面字段，列表按日期倒序并取最新同步时间', async () => {
  const calls = [];
  const rows = [
    { id: 'content_1', title: '标题一', url: articleUrl('content_1'), date: '2026-09-12', updatedAt: '2026-09-17T09:00:00.000Z' },
    { id: 'content_2', title: '标题二', url: articleUrl('content_2'), date: '2026-09-04', updatedAt: '2026-09-17T10:30:00.000Z' },
  ];
  const chain = {
    field() { calls.push('field'); return chain; },
    orderBy(field, order) { calls.push(`orderBy:${field}:${order}`); return chain; },
    skip(count) { calls.push(`skip:${count}`); return chain; },
    limit(count) { calls.push(`limit:${count}`); return chain; },
    where(condition) { calls.push(`where:${JSON.stringify(condition)}`); return chain; },
    async get() { return { data: rows }; },
  };
  globalThis.wx = {
    cloud: { database: () => ({ collection: (name) => { calls.push(`collection:${name}`); return chain; } }) },
  };
  try {
    const service = loadModule('dist/services/news/index.js');
    const feed = await service.listNews(5);
    assert.equal(feed.items.length, 2);
    assert.deepEqual(feed.items[0], { id: 'content_1', title: '标题一', url: articleUrl('content_1'), date: '2026-09-12' });
    assert.equal(feed.meta.fromServer, true);
    assert.equal(feed.meta.syncedAt, '2026-09-17T10:30:00.000Z', '取最新 updatedAt 作为更新时间');
    assert.ok(calls.includes('collection:news_articles'));
    assert.ok(calls.includes('orderBy:date:desc'));
    assert.ok(calls.includes('limit:5'));

    const found = await service.getNewsDetail('content_1');
    assert.equal(found.article.title, '标题一');
    assert.deepEqual(found.article.paragraphs, [], '缺少 paragraphs 时按空数组处理');
    assert.ok(calls.includes('where:{"id":"content_1"}'));

    const before = calls.length;
    assert.equal(await service.getNewsDetail(''), null);
    assert.equal(calls.length, before, '空 id 不应发起云端查询');
  } finally {
    delete globalThis.wx;
  }
});

test('列表分页按日期倒序、同日期按 id 倒序稳定排序，skip 决定页起点', async () => {
  const calls = [];
  const chain = {
    field() { return chain; },
    orderBy(field, order) { calls.push(`orderBy:${field}:${order}`); return chain; },
    skip(count) { calls.push(`skip:${count}`); return chain; },
    limit(count) { calls.push(`limit:${count}`); return chain; },
    async get() { return { data: [] }; },
  };
  globalThis.wx = {
    cloud: { database: () => ({ collection: () => chain }) },
  };
  try {
    const service = loadModule('dist/services/news/index.js');
    await service.listNews(20, 40);
    assert.deepEqual(
      calls.filter((entry) => entry.startsWith('orderBy') || entry.startsWith('skip') || entry.startsWith('limit')),
      ['orderBy:date:desc', 'orderBy:id:desc', 'skip:40', 'limit:20'],
      '同日期条目需要确定性的 id 次序，否则逐页加载会重复或遗漏',
    );
    await service.listNews();
    assert.ok(calls.includes('skip:0'), '首页读取从第 0 条开始');
  } finally {
    delete globalThis.wx;
  }
});

test('云开发不可用时服务抛出可读错误，不静默返回空数据', async () => {
  delete globalThis.wx;
  const service = loadModule('dist/services/news/index.js');
  await assert.rejects(() => service.listNews(), /云开发不可用/);
  await assert.rejects(() => service.getNewsDetail('content_1'), /云开发不可用/);
});

test('同步时间格式化为本地时间文本，空值与非法值返回空字符串', () => {
  const { formatSyncTime } = loadModule('dist/services/news/index.js');
  assert.equal(formatSyncTime(''), '');
  assert.equal(formatSyncTime('not-a-date'), '');
  assert.match(formatSyncTime('2026-09-17T09:12:00.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

// ---------- 页面行为 ----------

test('资讯列表页展示云端条目，点击后进入已注册的详情页', async () => {
  const visited = [];
  const items = [{ id: 'content_32118', title: ARTICLE_TITLE, url: articleUrl('content_32118'), date: '2026-09-12' }];
  const stubs = newsStub(
    async () => ({ items, meta: { label: '学校官网 · 校园动态', syncedAt: '2026-09-17T09:12:00.000Z', fromServer: true } }),
    async () => null,
  );
  const page = loadPage('news', { navigateTo: ({ url }) => visited.push(url) }, { stack: [{}], stubs });
  await page.onLoad();
  assert.equal(page.data.status, 'ready');
  assert.deepEqual(page.data.items, items);
  assert.equal(page.data.syncedAtText, 'FORMATTED');
  page.openDetail({ currentTarget: { dataset: { id: 'content_32118' } } });
  assert.deepEqual(visited, ['/pages/news/detail/index?id=content_32118']);
  const app = JSON.parse(fs.readFileSync('dist/app.json', 'utf8'));
  for (const url of visited) {
    assert.ok(app.pages.includes(url.slice(1).split('?')[0]));
  }
});

test('资讯列表页区分空数据与读取失败，并可重试', async () => {
  const empty = loadPage('news', {}, {
    stack: [{}],
    stubs: newsStub(async () => ({ items: [], meta: EMPTY_META }), async () => null),
  });
  await empty.onLoad();
  assert.equal(empty.data.status, 'empty');
  assert.equal(empty.data.syncedAtText, '');

  const failed = loadPage('news', {}, {
    stack: [{}],
    stubs: newsStub(async () => { throw new Error('云开发不可用'); }, async () => null),
  });
  await failed.onLoad();
  assert.equal(failed.data.status, 'error');
  assert.equal(failed.data.errorMessage, '云开发不可用');

  let calls = 0;
  const retryable = loadPage('news', {}, {
    stack: [{}],
    stubs: newsStub(async () => {
      calls += 1;
      return { items: [{ id: 'a', title: '标题', url: articleUrl('a'), date: '' }], meta: EMPTY_META };
    }, async () => null),
  });
  await retryable.onLoad();
  assert.equal(retryable.data.status, 'ready');
  await retryable.retry();
  assert.equal(calls, 2, '重试应重新读取数据');
});

// ---------- 逐页加载（Ticket 02） ----------

/** 生成分页测试条目，id 连续便于构造重叠场景。 */
function makeItems(start, count) {
  return Array.from({ length: count }, (_, offset) => {
    const id = `content_${start + offset}`;
    return { id, title: `标题${start + offset}`, url: articleUrl(id), date: '2026-09-12' };
  });
}

/** 分页桩：pages 依调用次序给出每页返回（数组），Error 实例表示该次读取失败。 */
function pagingStub(pages) {
  const calls = [];
  const listNews = async (limit, skip) => {
    calls.push({ limit, skip });
    const next = pages[calls.length - 1];
    if (next instanceof Error) throw next;
    return { items: next, meta: EMPTY_META };
  };
  return { calls, listNews };
}

test('资讯列表逐页加载：追加下一页，不足一页即已无更多', async () => {
  const paging = pagingStub([makeItems(1, 3), makeItems(4, 2)]);
  const stubs = newsStub(paging.listNews, async () => null, 3);
  const page = loadPage('news', {}, { stack: [{}], stubs });
  await page.onLoad();
  assert.equal(page.data.status, 'ready');
  assert.equal(page.data.items.length, 3);
  assert.equal(page.data.hasMore, true, '首页读满一页时假定还有更多');
  await page.loadMore();
  assert.deepEqual(paging.calls[1], { limit: 3, skip: 3 }, '下一页从已读条数之后开始');
  assert.equal(page.data.items.length, 5);
  assert.equal(page.data.hasMore, false, '返回不足一页表示没有更多');
  assert.equal(page.data.moreState, 'idle');
  await page.loadMore();
  assert.equal(paging.calls.length, 2, '已无更多时不再发起读取');
});

test('加载下一页失败时保留已加载条目，重试不重复追加', async () => {
  const paging = pagingStub([makeItems(1, 3), new Error('网络中断'), makeItems(4, 3)]);
  const stubs = newsStub(paging.listNews, async () => null, 3);
  const page = loadPage('news', {}, { stack: [{}], stubs });
  await page.onLoad();
  const before = page.data.items.map((item) => item.id);
  await page.loadMore();
  assert.equal(page.data.moreState, 'error');
  assert.equal(page.data.errorMessage, '网络中断');
  assert.deepEqual(page.data.items.map((item) => item.id), before, '失败不能清空已有条目');
  assert.equal(page.data.hasMore, true, '失败后仍可继续加载');
  await page.retryMore();
  assert.deepEqual(paging.calls[2], { limit: 3, skip: 3 }, '重试仍从上次的页起点开始');
  assert.equal(page.data.items.length, 6);
  assert.equal(page.data.moreState, 'idle');
});

test('连续加载遇到重叠条目不重复追加', async () => {
  const overlap = makeItems(3, 1)[0];
  const paging = pagingStub([makeItems(1, 3), [overlap, ...makeItems(4, 2)]]);
  const stubs = newsStub(paging.listNews, async () => null, 3);
  const page = loadPage('news', {}, { stack: [{}], stubs });
  await page.onLoad();
  await page.loadMore();
  const ids = page.data.items.map((item) => item.id);
  assert.equal(page.data.items.length, 5, '重叠条目只保留一次');
  assert.equal(new Set(ids).size, ids.length, '条目 id 不应重复');
});

test('资讯详情页展示云端返回的标题、日期与正文段落', async () => {
  const article = {
    id: 'content_32118',
    title: ARTICLE_TITLE,
    url: articleUrl('content_32118'),
    date: '2026-09-12',
    paragraphs: ['第一段', '第二段'],
  };
  const stubs = newsStub(
    async () => ({ items: [], meta: EMPTY_META }),
    async () => ({ article, meta: { label: '学校官网 · 校园动态', syncedAt: '2026-09-17T09:12:00.000Z', fromServer: true } }),
  );
  const page = loadPage('news/detail', { setClipboardData() {}, showToast() {} }, { stack: [{}, {}], stubs });
  await page.onLoad({ id: 'content_32118' });
  assert.equal(page.data.status, 'ready');
  assert.equal(page.data.article.title, ARTICLE_TITLE);
  assert.equal(page.data.article.url, articleUrl('content_32118'));
  assert.equal(page.data.article.paragraphs[0].text, '第一段');
  assert.equal(page.data.article.paragraphs[0].index, 0);
  assert.equal(page.data.syncedAtText, 'FORMATTED');
});

test('资讯详情页对未知 id 显示缺失状态，空 id 不请求云端', async () => {
  let calls = 0;
  const stubs = newsStub(async () => ({ items: [], meta: EMPTY_META }), async () => { calls += 1; return null; });
  const page = loadPage('news/detail', {}, { stack: [{}, {}], stubs });
  await page.onLoad({ id: 'content_999999' });
  assert.equal(page.data.status, 'missing');
  assert.equal(page.data.article, null);
  await page.onLoad({});
  assert.equal(page.data.status, 'missing');
  assert.equal(calls, 1, '空 id 不应发起云端查询');
});

test('资讯详情页读取失败时显示错误并可重试', async () => {
  let attempt = 0;
  const article = { id: 'content_1', title: '标题', url: articleUrl('content_1'), date: '2026-09-01', paragraphs: ['正文'] };
  const stubs = newsStub(async () => ({ items: [], meta: EMPTY_META }), async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('读取超时');
    return { article, meta: EMPTY_META };
  });
  const page = loadPage('news/detail', {}, { stack: [{}, {}], stubs });
  await page.onLoad({ id: 'content_1' });
  assert.equal(page.data.status, 'error');
  assert.equal(page.data.errorMessage, '读取超时');
  await page.retry();
  assert.equal(page.data.status, 'ready');
  assert.equal(page.data.article.title, '标题');
});

test('资讯详情页复制原文链接成功和失败都有反馈', async () => {
  const article = {
    id: 'content_32118',
    title: ARTICLE_TITLE,
    url: articleUrl('content_32118'),
    date: '2026-09-12',
    paragraphs: ['正文'],
  };
  for (const success of [true, false]) {
    const notices = [];
    const stubs = newsStub(async () => ({ items: [], meta: EMPTY_META }), async () => ({ article, meta: EMPTY_META }));
    const page = loadPage('news/detail', {
      setClipboardData: (options) => {
        assert.equal(options.data, articleUrl('content_32118'));
        (success ? options.success : options.fail)();
      },
      showToast: (options) => notices.push(options.title),
    }, { stack: [{}, {}], stubs });
    await page.onLoad({ id: 'content_32118' });
    page.copySource();
    assert.deepEqual(notices, [success ? '原文链接已复制' : '复制失败，请重试']);
  }
});

test('资讯详情页来自列表时返回上一页，直接打开时回到首页', () => {
  for (const stack of [[{}, {}], [{}]]) {
    const actions = [];
    const page = loadPage('news/detail', {
      navigateBack: () => actions.push('back'),
      reLaunch: ({ url }) => actions.push(url),
    }, { stack });
    page.goHome();
    assert.deepEqual(actions, [stack.length > 1 ? 'back' : '/pages/home/index']);
  }
});

test('首页展示最近资讯，提供进入列表与详情的入口', async () => {
  const visited = [];
  const items = makeItems(1, 2);
  const stubs = newsStub(
    async (limit) => {
      assert.equal(limit, 3, '首页只取最近几条');
      return { items, meta: { label: '学校官网 · 校园动态', syncedAt: '2026-09-17T09:12:00.000Z', fromServer: true } };
    },
    async () => null,
  );
  const page = loadPage('home', { navigateTo: ({ url }) => visited.push(url) }, { stack: [{}], stubs });
  await page.onLoad();
  assert.equal(page.data.newsStatus, 'ready');
  assert.deepEqual(page.data.recentNews, items);
  assert.equal(page.data.newsSyncedAtText, 'FORMATTED');
  page.openNews();
  page.openNewsDetail({ currentTarget: { dataset: { id: 'content_1' } } });
  page.openNewsDetail({ currentTarget: { dataset: { id: undefined } } });
  assert.deepEqual(visited, ['/pages/news/index', '/pages/news/detail/index?id=content_1']);
  const app = JSON.parse(fs.readFileSync('dist/app.json', 'utf8'));
  for (const url of visited) {
    assert.ok(app.pages.includes(url.slice(1).split('?')[0]), `${url} 应是已注册页面`);
  }
});

test('首页资讯读取失败时显示错误并可重试，不影响既有入口', async () => {
  let calls = 0;
  const stubs = newsStub(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error('云开发不可用');
      return { items: makeItems(1, 1), meta: EMPTY_META };
    },
    async () => null,
  );
  const page = loadPage('home', {}, { stack: [{}], stubs });
  await page.onLoad();
  assert.equal(page.data.newsStatus, 'error');
  assert.equal(page.data.newsError, '云开发不可用');
  await page.retryNews();
  assert.equal(page.data.newsStatus, 'ready');
  assert.equal(page.data.recentNews.length, 1);
  assert.equal(page.data.newsError, '');
});

test('资讯详情页正常状态返回上一页，直接打开则回到资讯列表', async () => {
  const article = { id: 'content_1', title: '标题', url: articleUrl('content_1'), date: '2026-09-01', paragraphs: ['正文'] };
  for (const stack of [[{}, {}], [{}]]) {
    const actions = [];
    const stubs = newsStub(async () => ({ items: [], meta: EMPTY_META }), async () => ({ article, meta: EMPTY_META }));
    const page = loadPage('news/detail', {
      navigateBack: () => actions.push('back'),
      reLaunch: ({ url }) => actions.push(url),
    }, { stack, stubs });
    await page.onLoad({ id: 'content_1' });
    page.goBack();
    assert.deepEqual(actions, [stack.length > 1 ? 'back' : '/pages/news/index']);
  }
});

test('资讯列表与详情的正常状态都提供返回入口', () => {
  // 正常状态没有页内返回按钮时，直接打开详情的用户只能靠系统返回；列表页同理。
  const list = fs.readFileSync('miniprogram/pages/news/index.wxml', 'utf8');
  const listReady = list.slice(list.indexOf('class="news-list"'));
  assert.ok(/id="back-home"[^>]*bindtap="goHome"/.test(listReady), '资讯列表正常状态缺少返回首页按钮');
  const detail = fs.readFileSync('miniprogram/pages/news/detail/index.wxml', 'utf8');
  const start = detail.indexOf('<block wx:if="{{status === \'ready\'}}">');
  const detailReady = detail.slice(start, detail.indexOf('</block>', start));
  assert.ok(/id="back-from-detail"[^>]*bindtap="goBack"/.test(detailReady), '资讯详情正常状态缺少返回按钮');
  assert.equal(
    /goBackToList/.test(fs.readFileSync('miniprogram/pages/news/detail/index.ts', 'utf8')), false,
    '详情页的返回方法不应再叫 goBackToList：它从首页进入时不会回到列表',
  );
});

test('资讯页面已注册且构建产物齐全', () => {
  const app = JSON.parse(fs.readFileSync('dist/app.json', 'utf8'));
  for (const page of ['pages/news/index', 'pages/news/detail/index']) {
    assert.ok(app.pages.includes(page), `${page} 应在 app.json 注册`);
    for (const ext of ['js', 'json', 'wxml', 'wxss']) {
      assert.ok(fs.existsSync(`dist/${page}.${ext}`), `缺少 dist/${page}.${ext}`);
    }
  }
});

test('客户端不再随包提供内容快照，正文只来自云端', () => {
  assert.equal(fs.existsSync('dist/services/news/snapshot.js'), false, '随包快照应已移除');
  assert.ok(fs.existsSync('dist/services/news/index.js'), '客户端资讯服务应仍然存在');
});
