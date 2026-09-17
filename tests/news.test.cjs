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
const SERVICE_SPECIFIER = '../../services/news';

const LIST_TITLES = [
  '向“新”而行，逐梦岭南——我校开展2026级新生入学教育',
  '以志为炬，温暖迎新——我校召开2026年迎新志愿者动员大会',
  '长沙文创艺术职业学院领导一行到我校参观交流',
];
const ARTICLE_TITLE = LIST_TITLES[0];
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

function newsStub(service) {
  return { [SERVICE_SPECIFIER]: { newsService: service } };
}

test('列表页真实片段解析出全部条目，导航链接不被当作资讯', () => {
  const { parseNewsList } = loadModule('dist/services/news/parse.js');
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
  const { parseNewsArticle } = loadModule('dist/services/news/parse.js');
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
  const { parseNewsArticle } = loadModule('dist/services/news/parse.js');
  const article = parseNewsArticle(fixture('article-32118.html'), articleUrl('content_32118'));
  const signoff = article.paragraphs.filter((text) => SIGNOFF.test(text));
  assert.deepEqual(signoff, [], '尾部 4 行编辑署名不应留在正文里');
  assert.equal(article.paragraphs[article.paragraphs.length - 1].startsWith('五天的入学教育'), true);
  assert.ok(article.paragraphs.includes('中药学新生在药植园AI识别药植'), '图片说明段落应保留');
});

test('署名行的全角分号写法同样被剥离，前面的正文段落保留', () => {
  const { parseNewsArticle } = loadModule('dist/services/news/parse.js');
  const article = parseNewsArticle(fixture('article-32039-tail.html'), articleUrl('content_32039'));
  assert.equal(article.title, LIST_TITLES[1]);
  assert.equal(article.date, '2026-09-04');
  assert.equal(article.paragraphs.length, 2);
  assert.equal(article.paragraphs[0].startsWith('全体志愿者起立进行庄严宣誓'), true);
  assert.equal(article.paragraphs.join('').includes('复审；黄雅晴'), false);
});

test('署名行之后仍有正文时署名行不被剥离', () => {
  const { parseNewsArticle } = loadModule('dist/services/news/parse.js');
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
  const { parseNewsArticle } = loadModule('dist/services/news/parse.js');
  const tail = fixture('article-32039-tail.html');
  const signoffTags = tail.match(/<p[^>]*>[^<]*(?:供稿|初审|复审|终审)[^<]*<\/p>/g);
  const html = '<div class="article-content">' + signoffTags.join('') + '</div><div class="article-fd"></div>';
  const article = parseNewsArticle(html, articleUrl('content_32039'));
  assert.deepEqual(article.paragraphs, []);
});

test('同一原文 URL 的条目去重后只保留首次出现', () => {
  const { parseNewsList, dedupeByUrl } = loadModule('dist/services/news/parse.js');
  const items = parseNewsList(fixture('list-page-1.html'), LIST_URL);
  const repeated = [items[0], items[1], { ...items[0], title: `${items[0].title}（重复）` }, items[2], { ...items[1] }];
  const merged = dedupeByUrl(repeated);
  assert.deepEqual(merged.map((item) => item.url), items.map((item) => item.url));
  assert.deepEqual(merged.map((item) => item.title), items.map((item) => item.title));
  assert.deepEqual(dedupeByUrl([]), []);
});

test('条目缺少日期时保留条目并置空日期', () => {
  const { parseNewsList } = loadModule('dist/services/news/parse.js');
  // 真实片段上移除日期节点，模拟官网条目缺失日期（实测第 1/2/60/120/126 页均未出现，属容错分支）。
  const html = fixture('list-page-1.html').replace('<span class="date">2026-09-04</span>', '');
  const items = parseNewsList(html, LIST_URL);
  assert.equal(items.length, 3);
  assert.equal(items[1].date, '');
  assert.equal(items[1].title, LIST_TITLES[1]);
});

test('文章页缺少正文容器时仍返回标题与日期', () => {
  const { parseNewsArticle } = loadModule('dist/services/news/parse.js');
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
  const { parseNewsArticle } = loadModule('dist/services/news/parse.js');
  // 真实片段上替换标题标签，模拟模板变化，验证 <title> 回退分支。
  const html = fixture('article-32118.html')
    .replace('<h1 class="title">', '<h2 class="title">')
    .replace('</h1>', '</h2>');
  const article = parseNewsArticle(html, articleUrl('content_32118'));
  assert.equal(article.title, ARTICLE_TITLE);
});

test('缺少列表容器或空输入时返回空数组', () => {
  const { parseNewsList } = loadModule('dist/services/news/parse.js');
  assert.deepEqual(parseNewsList(fixture('list-no-items.html'), LIST_URL), []);
  assert.deepEqual(parseNewsList('<ul class="list list-intro"></ul>', LIST_URL), []);
  assert.deepEqual(parseNewsList('', LIST_URL), []);
});

test('每个 fixture 都记录了来源 URL 与抓取日期', () => {
  for (const name of ['list-page-1.html', 'list-no-items.html', 'article-32118.html', 'article-32039-tail.html']) {
    const text = fixture(name);
    assert.match(text, /来源：https:\/\/lnc\.edu\.cn\/xyxw\/xydt/, name);
    assert.match(text, /抓取日期 2026-09-17/, name);
  }
});

test('随包快照来自校园动态第 1 页真实条目并标注未同步云端', () => {
  const { newsService } = loadModule('dist/services/news/index.js');
  const items = newsService.listNews();
  assert.equal(items.length, 10);
  assert.equal(items[0].url, articleUrl('content_32118'));
  assert.equal(items[9].url, articleUrl('content_30217'));
  assert.equal(newsService.meta.listUrl, LIST_URL);
  assert.equal(newsService.meta.capturedAt, '2026-09-17');
  assert.equal(newsService.meta.syncedFromServer, false);
  assert.match(newsService.meta.label, /校园动态/);
  for (const item of items) {
    const detail = newsService.getNewsDetail(item.id);
    assert.ok(detail, `快照应包含 ${item.id} 的正文`);
    assert.equal(detail.title, item.title);
    assert.equal(detail.date, item.date);
    assert.equal(detail.url, item.url);
    assert.ok(detail.paragraphs.length > 0, `${item.id} 正文不应为空`);
  }
});

test('按 id 查询未知条目或空 id 返回 null', () => {
  const { newsService } = loadModule('dist/services/news/index.js');
  assert.equal(newsService.getNewsDetail('content_999999'), null);
  assert.equal(newsService.getNewsDetail(''), null);
});

test('数据源可替换：注入其他数据源后列表与详情改由该数据源提供', () => {
  const { createNewsService } = loadModule('dist/services/news/index.js');
  const entry = { id: 'content_1', title: '云函数返回的标题', url: articleUrl('content_1'), date: '2026-09-17' };
  const calls = [];
  const service = createNewsService({
    meta: { listUrl: 'https://example.test/list', label: '测试栏目', capturedAt: '2026-09-17', syncedFromServer: true },
    list: () => [entry],
    findById: (id) => { calls.push(id); return id === entry.id ? { ...entry, paragraphs: ['云端正文'] } : null; },
  });
  assert.deepEqual(service.listNews(), [entry]);
  assert.equal(service.getNewsDetail('content_1').paragraphs[0], '云端正文');
  assert.equal(service.getNewsDetail('missing'), null);
  assert.deepEqual(calls, ['content_1', 'missing']);
  assert.equal(service.meta.syncedFromServer, true);
});

test('资讯列表页展示快照条目，点击后进入已注册的详情页', () => {
  const visited = [];
  const page = loadPage('news', { navigateTo: ({ url }) => visited.push(url) }, { stack: [{}] });
  page.onLoad();
  assert.equal(page.data.items.length, 10);
  assert.equal(page.data.items[0].title, ARTICLE_TITLE);
  assert.equal(page.data.items[0].date, '2026-09-12');
  assert.equal(page.data.empty, false);
  assert.equal(page.data.source.syncedFromServer, false);
  page.openDetail({ currentTarget: { dataset: { id: 'content_32118' } } });
  assert.deepEqual(visited, ['/pages/news/detail/index?id=content_32118']);
  const app = JSON.parse(fs.readFileSync('dist/app.json', 'utf8'));
  for (const url of visited) {
    assert.ok(app.pages.includes(url.slice(1).split('?')[0]));
  }
});

test('资讯列表页在空数据源下显示空状态', () => {
  const emptyService = {
    meta: { listUrl: LIST_URL, label: '学校官网 · 校园动态', capturedAt: '2026-09-17', syncedFromServer: false },
    listNews: () => [],
    getNewsDetail: () => null,
  };
  const page = loadPage('news', { navigateTo() {} }, { stack: [{}], stubs: newsStub(emptyService) });
  page.onLoad();
  assert.deepEqual(page.data.items, []);
  assert.equal(page.data.empty, true);
});

test('资讯详情页展示标题、日期与正文段落', () => {
  const page = loadPage('news/detail', { setClipboardData() {}, showToast() {} }, { stack: [{}, {}] });
  page.onLoad({ id: 'content_32118' });
  assert.equal(page.data.status, 'ready');
  assert.equal(page.data.article.title, ARTICLE_TITLE);
  assert.equal(page.data.article.date, '2026-09-12');
  assert.equal(page.data.article.url, articleUrl('content_32118'));
  assert.equal(page.data.article.paragraphs[0].text, FIRST_PARAGRAPH);
  assert.equal(page.data.article.paragraphs[0].index, 0);
  assert.ok(page.data.article.paragraphs.length > 3);
});

test('资讯详情页对未知条目显示缺失状态', () => {
  const page = loadPage('news/detail', {}, { stack: [{}, {}] });
  page.onLoad({ id: 'content_999999' });
  assert.equal(page.data.status, 'missing');
  assert.equal(page.data.article, null);
  page.onLoad({});
  assert.equal(page.data.status, 'missing');
});

test('资讯详情页复制原文链接成功和失败都有反馈', () => {
  for (const success of [true, false]) {
    const notices = [];
    const page = loadPage('news/detail', {
      setClipboardData: (options) => {
        assert.equal(options.data, articleUrl('content_32118'));
        (success ? options.success : options.fail)();
      },
      showToast: (options) => notices.push(options.title),
    }, { stack: [{}, {}] });
    page.onLoad({ id: 'content_32118' });
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

test('资讯页面已注册且构建产物齐全', () => {
  const app = JSON.parse(fs.readFileSync('dist/app.json', 'utf8'));
  for (const page of ['pages/news/index', 'pages/news/detail/index']) {
    assert.ok(app.pages.includes(page), `${page} 应在 app.json 注册`);
    for (const ext of ['js', 'json', 'wxml', 'wxss']) {
      assert.ok(fs.existsSync(`dist/${page}.${ext}`), `缺少 dist/${page}.${ext}`);
    }
  }
});
