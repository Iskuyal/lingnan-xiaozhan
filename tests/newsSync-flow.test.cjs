const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

const fixture = (name) => fs.readFileSync(`tests/fixtures/news/${name}`, 'utf8');
const LIST_URL = 'https://lnc.edu.cn/tw/djxf/tqsd';
const XYXW_LIST_URL = 'https://lnc.edu.cn/xyxw/xydt';
const ARTICLE_URL = 'https://lnc.edu.cn/tw/djxf/tqsd/content_32355';
const OLD_TIME = '2026-09-01T00:00:00.000Z';
/** 请求间隔与单批上限是票面确定的参数，测试按同样的数值核对（见 columns.ts）。 */
const REQUEST_INTERVAL_MS = 1300;
const MAX_REQUESTS_PER_CALL = 10;

/**
 * 「两个栏目」的用例固定用「校园动态 + 团委通知公告」这一份清单。
 *
 * 它们断言的是**配额怎么分**与**撞限速后是否停轮**，与生产清单里到底有几个栏目无关；
 * 直接吃生产清单会让每次追加栏目都误伤这些用例（Ticket 10 把栏目从 2 个加到 10 个时踩到过）。
 * 需要真实清单的用例照常不传 `columns`。
 */
const TWO_COLUMNS = require(path.resolve('dist/cloudfunctions/newsSync/columns.js')).COLUMNS
  .filter((column) => column.id === 'xyxw-xydt' || column.id === 'tw-tqsd');

/**
 * 最小可用的官网页面桩：结构照抄实测模板（见 docs/news-sources.md 的「通知公告类栏目」）。
 * 解析器的真实页面验证在 tests/news.test.cjs 用真 fixture；这里只为同步引擎提供可控输入。
 */
function articleStub(title, date) {
  return [
    '<article class="articleCon"><div class="printArea" data-power-area=\'content\'>',
    `<h2 class="title">${title}<div class="subheading"></div></h2>`,
    `<div class="property"><span>来源： </span> <span>发布时间：${date} 09:30:00</span></div>`,
    `<div class="conTxt"><p>${title}的正文。</p></div>`,
    '<div class="auditRecordcss"><span>终审：团委</span></div>',
    '<div class="userControl">分享到：</div>',
    '</div></article>',
  ].join('');
}

function listStub(items) {
  const rows = items
    .map((item, index) => {
      const cls = index === 0 ? 'first' : index === items.length - 1 ? 'last' : '';
      return `<li class="${cls}"><span class="date">${item.date}</span>`
        + `<a href="${item.href}" target="_blank" title="标题：${item.title}&#xD;&#xA;点击数：3&#xD;&#xA;发表时间：${item.date}">`
        + `${item.title}</a></li>`;
    })
    .join('\n<li class="split"></li>\n');
  return `<ul class="newsList">\n${rows}\n</ul>\n<div class="page"><span class="total">共3条信息/共1页</span></div>`;
}

function articleRecord(id, url, title, date, paragraphs = ['旧正文']) {
  return { _id: `seed-${id}`, id, url, title, date, paragraphs, updatedAt: OLD_TIME };
}

/** 可推进的假时钟：让 1.3 秒的请求间隔在测试里瞬时完成，同时能核对真实的时间间隔。 */
function createClock(startIso) {
  let current = Date.parse(startIso);
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(current);
      else super(...args);
    }
    static now() {
      return current;
    }
  }
  return {
    Date: FakeDate,
    now: () => current,
    setTimeout(fn, ms) {
      current += Number(ms) || 0;
      process.nextTick(fn);
      return 0;
    },
  };
}

/**
 * 只替换网络与数据库边界；运行真实入口、解析器与入库映射，不访问线上环境。
 * responses(url, index) 返回 { status, html }，缺省为 503。
 */
function harness(options = {}) {
  const clock = createClock(options.now || '2026-09-17T22:20:00.000Z');
  const requests = [];
  const articles = options.articles ? options.articles.map((row) => ({ ...row })) : [];
  const stateDocs = options.stateDocs || {};
  const stateWrites = [];
  const responses = options.responses || (() => ({ status: 404, html: 'Not Found' }));

  const https = {
    get(requestUrl, requestOptions, callback) {
      const index = requests.length;
      requests.push({ url: requestUrl, at: clock.now() });
      const request = new EventEmitter();
      process.nextTick(() => {
        const page = responses(requestUrl, index) || { status: 503, html: 'Unavailable' };
        const response = new EventEmitter();
        response.statusCode = page.status;
        response.headers = page.headers || {};
        response.resume = () => {};
        callback(response);
        response.emit('data', Buffer.from(page.html || ''));
        response.emit('end');
      });
      return request;
    },
  };

  const db = {
    collection(name) {
      if (name === 'sync_state') {
        return {
          doc(id) {
            return {
              async get() {
                if (!stateDocs[id]) throw new Error(`document ${id} non-exists`);
                return { data: stateDocs[id] };
              },
              async set({ data }) {
                stateWrites.push({ id, data });
                stateDocs[id] = { _id: id, ...data };
              },
              async update({ data }) {
                stateWrites.push({ id, data, update: true });
                if (!stateDocs[id]) throw new Error(`document ${id} non-exists`);
                Object.assign(stateDocs[id], data);
              },
            };
          },
        };
      }
      return {
        where(condition) {
          const chain = {
            field() { return chain; },
            limit() { return chain; },
            async get() {
              return { data: articles.filter((row) => row.url === condition.url) };
            },
          };
          return chain;
        },
        doc(id) {
          return {
            async update({ data }) {
              Object.assign(articles.find((row) => row._id === id), data);
            },
            async set({ data }) {
              const found = articles.find((row) => row._id === id);
              if (found === undefined) articles.push({ _id: id, ...data });
              else Object.assign(found, data);
            },
          };
        },
        async add({ data }) {
          articles.push({ _id: `new-${articles.length}`, ...data });
        },
      };
    },
  };

  const filename = path.resolve('dist/cloudfunctions/newsSync/index.js');
  const realRequire = createRequire(filename);
  const context = {
    exports: {}, Buffer, URL, console, Date: clock.Date, setTimeout: clock.setTimeout,
    require(name) {
      if (name === 'https') return https;
      if (name === 'wx-server-sdk') return { init() {}, database: () => db };
      // options.columns 用于固定栏目清单（见 TWO_COLUMNS 的说明），其余模块照常走真实实现。
      if (options.columns !== undefined && name.endsWith('columns')) {
        return { ...realRequire(name), COLUMNS: options.columns };
      }
      return realRequire(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { run: context.exports.main, exports: context.exports, requests, articles, stateDocs, stateWrites, clock };
}

/** 请求间隔核对：相邻请求的开始时间差不得小于 1.3 秒。 */
function assertPaced(requests) {
  for (let i = 1; i < requests.length; i += 1) {
    const gap = requests[i].at - requests[i - 1].at;
    assert.ok(gap >= REQUEST_INTERVAL_MS, `第 ${i + 1} 次请求与上一次间隔 ${gap}ms，小于 ${REQUEST_INTERVAL_MS}ms：${requests[i].url}`);
  }
}

/** 云函数运行在独立 vm 上下文里，返回的数组/对象原型与测试不同，比较前先转成普通值。 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------- 分批抓取与限速 ----------

test('单次调用最多 10 次页面请求，相邻请求间隔不小于 1.3 秒', async () => {
  const app = harness({
    responses: (url) => {
      if (url === LIST_URL) return { status: 200, html: fixture('tw-list-page-1.html') };
      return { status: 200, html: articleStub(`标题 ${url.slice(-5)}`, '2026-09-18') };
    },
  });
  const result = await app.run({ column: 'tw-tqsd' });
  assert.equal(app.requests.length, MAX_REQUESTS_PER_CALL, '单批请求数应正好用满配额（1 次列表页 + 9 篇正文）');
  assert.equal(result.requestsUsed, MAX_REQUESTS_PER_CALL);
  assertPaced(app.requests);
  assert.ok(result.elapsedMs <= 16000, `单批耗时 ${result.elapsedMs}ms 应留在 20 秒超时内`);
  assert.deepEqual(plain(result.columns[0].pagesRead), [1], '第一批先读列表第 1 页');
  assert.equal(result.columns[0].backfillDone, false, '16 页的栏目不可能在第一批内完成');
  assert.equal(result.batchComplete, false, '配额用完时本轮没跑完，不能声称整批完成');
});

test('跨批续跑：第二批从上一批剩余的待抓条目接着做，不重读已完成的列表页', async () => {
  const app = harness({
    responses: (url) => {
      if (url === LIST_URL || url === `${LIST_URL}_2`) return { status: 200, html: fixture('tw-list-page-1.html') };
      return { status: 200, html: articleStub(`标题 ${url.slice(-5)}`, '2026-09-18') };
    },
  });
  const first = await app.run({ column: 'tw-tqsd' });
  const state = app.stateDocs['tw-tqsd'];
  assert.ok(state.pending.length > 0, '第一批用尽配额后应留着未抓正文的条目');
  assert.equal(state.backfillPage, 2, '列表第 1 页读完，游标推进到第 2 页');
  const pendingUrl = state.pending[0].url;

  const secondIndex = app.requests.length;
  const second = await app.run({ column: 'tw-tqsd' });
  assert.equal(app.requests[secondIndex].url, pendingUrl, '第二批第一个请求应是上一批剩余的待抓条目');
  assert.ok(second.columns[0].pagesRead.includes(2), '剩余条目抓完后继续读列表第 2 页');
  assert.ok(second.requestsUsed <= MAX_REQUESTS_PER_CALL);
  assertPaced(app.requests);
  assert.equal(first.columns[0].backfillDone, false);
});

test('每完成一次请求就落盘同步状态，中断不会丢进度', async () => {
  const app = harness({
    responses: (url) => (url === LIST_URL
      ? { status: 200, html: fixture('tw-list-page-1.html') }
      : { status: 200, html: articleStub(`标题 ${url.slice(-5)}`, '2026-09-18') }),
  });
  await app.run({ column: 'tw-tqsd' });
  assert.ok(
    app.stateWrites.length >= app.requests.length,
    `状态写入 ${app.stateWrites.length} 次应不少于请求 ${app.requests.length} 次（每次请求后都留进度）`,
  );
  const state = app.stateDocs['tw-tqsd'];
  assert.equal(state.pending.length + (app.requests.length - 1), 10, '已抓正文的条目数与队列长度应覆盖整页 10 条');
  assert.equal(state.lockUntil, '', '调用结束后应释放运行锁');
  // 字段契约直接取云函数导出的那份，避免测试里再抄一遍清单导致两边漂移。
  assert.deepEqual(
    Object.keys(state).filter((key) => key !== '_id').sort(),
    plain(app.exports.SYNC_STATE_FIELDS).slice().sort(),
    '状态文档字段应与云函数声明的契约一致',
  );
  assert.ok(Object.keys(state).includes('missing'), '缺失条目清单必须落盘，否则「还差几条」无从查起');
});

test('限速 403：立即停止本轮、记录时间与错误，并对后续调用冷却', async () => {
  const app = harness({
    responses: (url) => {
      if (url === LIST_URL) return { status: 200, html: fixture('tw-list-page-1.html') };
      return {
        status: 403,
        html: '检测到您的IP在短时间内发起多次请求，疑似正在对网站进行CC攻击，因此您的IP将被冻结一段时间。',
      };
    },
  });
  const result = await app.run({ column: 'tw-tqsd' });
  assert.equal(result.ok, false);
  assert.equal(result.columns[0].rateLimited, true);
  assert.equal(app.requests.length, 2, '列表页之后第一篇正文返回 403，本轮立刻停止，不再重试');
  const state = app.stateDocs['tw-tqsd'];
  assert.equal(state.lastOutcome, 'rate-limited');
  assert.match(state.rateLimitedAt, /^2026-09-17T22:20:00/, '记录触发限速的调用时间');
  assert.match(state.lastError, /限速|403/);
  assert.equal(state.pending.length, 10, '失败的条目留在队列里，恢复后可从原处续跑');

  const before = app.requests.length;
  const again = await app.run({ column: 'tw-tqsd' });
  assert.equal(app.requests.length, before, '冷却期内不得再发起请求');
  assert.match(again.columns[0].skippedReason, /冷却/);
});

test('限速 403 不覆盖该篇已有记录', async () => {
  const app = harness({
    articles: [articleRecord('content_32355', ARTICLE_URL, '旧标题', '2026-09-01')],
    responses: (url) => {
      if (url === LIST_URL) {
        return { status: 200, html: listStub([{ href: '/tw/djxf/tqsd/content_32355', title: '新标题', date: '2026-09-18' }]) };
      }
      return { status: 403, html: '每秒不能多于1个页面请求' };
    },
  });
  const result = await app.run({ column: 'tw-tqsd' });
  assert.equal(result.columns[0].rateLimited, true);
  assert.equal(app.articles.length, 1);
  assert.deepEqual(plain(app.articles[0].paragraphs), ['旧正文']);
  assert.equal(app.articles[0].title, '旧标题');
});

test('重复触发保护：上一次调用的锁未过期时本次直接跳过，不发起请求', async () => {
  const app = harness({
    now: '2026-09-17T22:20:00.000Z',
    stateDocs: { 'tw-tqsd': { _id: 'tw-tqsd', lockUntil: '2026-09-17T22:20:30.000Z' } },
    responses: () => ({ status: 200, html: fixture('tw-list-page-1.html') }),
  });
  const result = await app.run({ column: 'tw-tqsd' });
  assert.equal(app.requests.length, 0);
  assert.match(result.columns[0].skippedReason, /仍在运行|加锁/);
});

// ---------- 增量同步 ----------

test('增量回看最近 3 页：内容未变的条目跳过抓取，新条目入库', async () => {
  const shortListItems = [{ href: '/tw/djxf/tqsd/content_1', title: '条目一', date: '2026-09-18' }];
  const app = harness({
    stateDocs: { 'tw-tqsd': { _id: 'tw-tqsd', backfillDone: true } },
    articles: [
      articleRecord('content_1', `${LIST_URL}/content_1`, '条目一', '2026-09-18'),
      articleRecord('content_2', `${LIST_URL}/content_2`, '条目二', '2026-09-18'),
    ],
    responses: (url) => {
      if (url === LIST_URL) return { status: 200, html: listStub(shortListItems) };
      if (url === `${LIST_URL}_2`) {
        return { status: 200, html: listStub([{ href: '/tw/djxf/tqsd/content_2', title: '条目二', date: '2026-09-18' }]) };
      }
      if (url === `${LIST_URL}_3`) {
        return { status: 200, html: listStub([{ href: '/tw/djxf/tqsd/content_3', title: '条目三', date: '2026-09-18' }]) };
      }
      return { status: 200, html: articleStub('条目三', '2026-09-18') };
    },
  });
  const result = await app.run({ column: 'tw-tqsd' });
  assert.deepEqual(plain(result.columns[0].pagesRead), [1, 2, 3], '增量回看第 1-3 页');
  assert.equal(result.columns[0].roundComplete, true);
  assert.equal(result.columns[0].skipped, 2, '第 1、2 页的条目内容未变，跳过正文抓取');
  assert.equal(result.columns[0].inserted, 1, '第 3 页的新条目入库');
  assert.equal(result.requestsUsed, 4, '3 次列表页 + 1 篇新文章正文');
  assertPaced(app.requests);
  assert.equal(app.articles.length, 3);
  assert.equal(app.stateDocs['tw-tqsd'].lastOutcome, 'ok', '整轮无失败才算整批成功');
  assert.notEqual(app.stateDocs['tw-tqsd'].lastSuccessAt, '');
});

test('增量同步发现标题变化时重新抓取并更新同一篇记录，不新增重复条目', async () => {
  const app = harness({
    stateDocs: {
      'tw-tqsd': {
        _id: 'tw-tqsd', backfillDone: true,
        round: { active: true, phase: 'incremental', page: 3, pages: [1, 2], requests: 2, inserted: 0, updated: 0, skipped: 2, offsite: 0, failed: 0, failures: [] },
      },
    },
    articles: [articleRecord('content_32355', ARTICLE_URL, '旧标题', '2026-09-18')],
    responses: (url) => {
      // 第 3 页只有这一条：标题与旧记录不同，应重新抓正文并更新同一条记录。
      if (url === `${LIST_URL}_3`) {
        return { status: 200, html: listStub([{ href: '/tw/djxf/tqsd/content_32355', title: '新标题', date: '2026-09-18' }]) };
      }
      return { status: 200, html: fixture('tw-article-32355.html') };
    },
  });
  const result = await app.run({ column: 'tw-tqsd' });
  assert.equal(result.totals.inserted, 0, '同一 URL 不应新增条目');
  assert.equal(result.totals.updated, 1);
  assert.equal(app.articles.length, 1);
  assert.equal(app.articles[0].title, '关于开展2026年迎新志愿服务活动总结表彰工作的通知', '标题按官网更新');
  assert.ok(app.articles[0].paragraphs.length > 0);
  assert.equal(app.stateDocs['tw-tqsd'].lastOutcome, 'ok');
  assert.equal(result.batchComplete, true, '回看第 1-3 页跑完即本轮完成');
});

test('全量导入完成后按 mode=auto 自动转入增量回看', async () => {
  const app = harness({
    stateDocs: { 'tw-tqsd': { _id: 'tw-tqsd', backfillDone: true } },
    responses: (url) => (url.startsWith(LIST_URL)
      ? { status: 200, html: listStub([{ href: '/tw/djxf/tqsd/content_1', title: '条目一', date: '2026-09-18' }]) }
      : { status: 200, html: articleStub('条目一', '2026-09-18') }),
  });
  const result = await app.run({ column: 'tw-tqsd' });
  assert.equal(result.columns[0].phase, 'incremental');
  assert.deepEqual(plain(result.columns[0].pagesRead), [1, 2, 3]);
  assert.equal(result.backfillDone, true);
  assert.match(result.resumeHint, /增量/);
});

// ---------- 失败语义 ----------

test('HTTP 失败与正文为空不覆盖旧记录，也不记录同步成功', async () => {
  for (const [name, page] of [
    ['HTTP 503', { status: 503, html: 'Unavailable' }],
    ['HTTP 200 维护页', { status: 200, html: '<html><title>维护中</title></html>' }],
    ['正文容器丢失', { status: 200, html: '<h2 class="title">标题</h2><div class="property">发布时间：2026-09-18</div>' }],
  ]) {
    const app = harness({
      articles: [articleRecord('content_32355', ARTICLE_URL, '旧标题', '2026-09-01')],
      responses: (url) => (url === LIST_URL
        ? { status: 200, html: listStub([{ href: '/tw/djxf/tqsd/content_32355', title: '新标题', date: '2026-09-18' }]) }
        : page),
    });
    // 配额固定为 2（列表页 + 这篇正文）：把断言限定在这一条上，不让后续列表页请求混进统计。
    const result = await app.run({ column: 'tw-tqsd', maxRequests: 2 });
    assert.equal(result.columns[0].failed, 1, name);
    assert.equal(result.ok, false, name);
    assert.deepEqual(app.articles[0].paragraphs, ['旧正文'], name);
    assert.equal(app.articles[0].title, '旧标题', name);
    assert.equal(app.articles[0].updatedAt, OLD_TIME, name);
    assert.equal(app.stateDocs['tw-tqsd'].lastSuccessAt, '', name, '单篇失败不得推进整批成功时间');
    assert.equal(app.stateDocs['tw-tqsd'].lastOutcome, 'running', name, '本轮未跑完，不得声称成功');
    assert.equal(app.stateDocs['tw-tqsd'].round.failed, 1, name, '失败计入本轮累计计数');
    assert.match(app.stateDocs['tw-tqsd'].round.failures[0], /content_32355/, name, '失败摘要留在状态里可排查');
  }
});

test('缺日期的文章仍保留正文入库', async () => {
  const app = harness({
    responses: (url) => {
      if (url === LIST_URL) {
        return { status: 200, html: listStub([{ href: '/tw/djxf/tqsd/content_7', title: '无日期条目', date: '2026-09-18' }]) };
      }
      // 真实模板去掉「发布时间」节点，模拟官网条目缺日期（property 块仍在）
      return {
        status: 200,
        html: '<article class="articleCon"><div class="printArea" data-power-area=\'content\'><h2 class="title">无日期条目<div class="subheading"></div></h2><div class="property"><span>来源： </span></div><div class="conTxt"><p>正文仍在。</p></div><div class="userControl">分享到：</div></div></article>',
      };
    },
  });
  const result = await app.run({ column: 'tw-tqsd', maxRequests: 2 });
  assert.equal(result.totals.inserted, 1);
  assert.equal(result.totals.failed, 0);
  assert.equal(app.articles[0].date, '');
  assert.deepEqual(plain(app.articles[0].paragraphs), ['正文仍在。']);
});

test('部分成功只更新有效文章，不推进整批成功时间', async () => {
  // 全量导入已完成，本轮从回看第 3 页收尾：这一页含一条有效、一条持续 500 的条目。
  const pageItems = [
    { href: '/tw/djxf/tqsd/content_32355', title: '条目一', date: '2026-09-18' },
    { href: '/tw/djxf/tqsd/content_2', title: '条目二', date: '2026-09-18' },
  ];
  const app = harness({
    stateDocs: {
      'tw-tqsd': {
        _id: 'tw-tqsd', backfillDone: true,
        round: { active: true, phase: 'incremental', page: 3, pages: [1, 2], requests: 2, inserted: 0, updated: 0, skipped: 2, offsite: 0, failed: 0, failures: [], retried: [] },
      },
    },
    articles: [articleRecord('content_32355', ARTICLE_URL, '旧标题', '2026-09-01')],
    responses: (url) => {
      if (url === `${LIST_URL}_3`) return { status: 200, html: listStub(pageItems) };
      if (url.endsWith('content_32355')) return { status: 200, html: fixture('tw-article-32355.html') };
      return { status: 500, html: 'boom' };
    },
  });
  const result = await app.run({ column: 'tw-tqsd' });
  assert.equal(result.batchComplete, true, '第 3 页收尾后本轮完成');
  assert.equal(result.totals.updated, 1);
  assert.equal(result.totals.failed, 2, '持续失败的条目在本轮内重试一次，两次都计入失败次数');
  assert.equal(app.articles.length, 1, '失败的条目不应新增');
  assert.equal(app.stateDocs['tw-tqsd'].lastSuccessAt, '', '部分成功不推进整批成功时间');
  assert.equal(app.stateDocs['tw-tqsd'].lastOutcome, 'partial');
  assert.match(app.stateDocs['tw-tqsd'].lastError, /content_2/);
});

test('偶发失败的条目在同一轮内重试一次，成功写入后不再留空洞', async () => {
  let attempts = 0;
  const app = harness({
    responses: (url) => {
      if (url === LIST_URL) {
        return { status: 200, html: listStub([{ href: '/tw/djxf/tqsd/content_9', title: '偶发失败条目', date: '2026-09-18' }]) };
      }
      attempts += 1;
      // 第一次 503、第二次 200：模拟官网抖动
      return attempts === 1
        ? { status: 503, html: 'Unavailable' }
        : { status: 200, html: articleStub('偶发失败条目', '2026-09-18') };
    },
  });
  const result = await app.run({ column: 'tw-tqsd', maxRequests: 3 });
  const row = app.articles.find((article) => article.url.endsWith('content_9'));
  assert.ok(row, '重试成功后条目应入库，首次全量不留空洞');
  assert.deepEqual(plain(row.paragraphs), ['偶发失败条目的正文。']);
  assert.equal(result.totals.failed, 1, '首次失败仍记一次失败次数');
  assert.equal(app.requests.filter((request) => request.url.includes('content_9')).length, 2, '同一篇至多重试一次');
});

test('维护者可用 reset 重跑全量：游标回到第 1 页，按 URL 更新而非新增', async () => {
  const app = harness({
    stateDocs: { 'tw-tqsd': { _id: 'tw-tqsd', backfillDone: true, backfillPage: 17 } },
    articles: [articleRecord('content_32355', ARTICLE_URL, '旧标题', '2026-09-01')],
    responses: (url) => {
      if (url === LIST_URL) return { status: 200, html: fixture('tw-list-page-1.html') };
      if (url === ARTICLE_URL) return { status: 200, html: fixture('tw-article-32355.html') };
      return { status: 404, html: 'Not Found' };
    },
  });
  const result = await app.run({ column: 'tw-tqsd', reset: true, maxRequests: 2 });
  assert.deepEqual(plain(result.columns[0].pagesRead), [1], 'reset 后从第 1 页重新全量，而不是接着旧游标');
  assert.equal(result.columns[0].backfillDone, false);
  assert.equal(app.stateDocs['tw-tqsd'].backfillPage, 2);
  assert.equal(app.articles.length, 1, '同一 URL 更新而不是新增');
  assert.equal(app.articles[0].title, '关于开展2026年迎新志愿服务活动总结表彰工作的通知');
  assert.notEqual(result.totals.inserted + result.totals.updated, 0);
});

// ---------- 外链条目 ----------

test('正文不在官网的条目只存标题、日期与原文链接，不抓外链正文', async () => {
  const external = 'https://mp.weixin.qq.com/s/abcdefg';
  const app = harness({
    responses: (url) => {
      if (url === LIST_URL) {
        // 真实片段里没有外链条目，这里只把首条 href 换成外链专测外链分支，标题与日期保持原样
        return { status: 200, html: fixture('tw-list-page-1.html').replace('/tw/djxf/tqsd/content_32355', external) };
      }
      return { status: 200, html: articleStub('官网正文', '2026-09-18') };
    },
  });
  const result = await app.run({ column: 'tw-tqsd' });
  assert.equal(app.requests.some((request) => request.url === external), false, '不得抓取外链正文');
  assert.equal(result.totals.offsite, 1);
  assert.equal(result.totals.failed, 0, '外链条目不算失败');
  const row = app.articles.find((article) => article.url === external);
  assert.ok(row, '外链条目应入库');
  assert.equal(row.title, '关于开展2026年迎新志愿服务活动总结表彰工作的通知');
  assert.equal(row.date, '2026-09-18');
  assert.deepEqual(plain(row.paragraphs), [], '不存外链正文');
  assert.equal(row.sourceLabel, '学校官网 · 团委通知公告');
});

test('官网页面跳转到域外时不抓外链正文，只存标题、日期与原文链接', async () => {
  const app = harness({
    responses: (url) => {
      if (url === LIST_URL) {
        return { status: 200, html: listStub([{ href: '/tw/djxf/tqsd/content_32355', title: '外链跳转条目', date: '2026-09-18' }]) };
      }
      if (url === ARTICLE_URL) {
        // 官网条目本身在域内，但页面 302 到微信公众号：正文不在官网。
        return { status: 302, html: '', headers: { location: 'https://mp.weixin.qq.com/s/abcdefg' } };
      }
      return { status: 200, html: articleStub('不应被抓取的域外正文', '2026-09-18') };
    },
  });
  const result = await app.run({ column: 'tw-tqsd', maxRequests: 2 });
  assert.equal(
    app.requests.some((request) => request.url.includes('mp.weixin.qq.com')),
    false,
    '跳转目标不得被抓取',
  );
  assert.equal(result.totals.offsite, 1);
  assert.equal(result.totals.failed, 0, '外链跳转不算失败');
  const row = app.articles.find((article) => article.url === ARTICLE_URL);
  assert.ok(row, '外链跳转条目应入库');
  assert.equal(row.title, '外链跳转条目');
  assert.equal(row.date, '2026-09-18');
  assert.deepEqual(plain(row.paragraphs), [], '不存域外正文');
});

test('待抓队列里的坏条目被丢弃，不会卡住续跑', async () => {
  const app = harness({
    // 模拟旧版本或人工改坏的状态文档：队列里混入缺 URL 的条目
    stateDocs: { 'tw-tqsd': { _id: 'tw-tqsd', backfillDone: true, pending: [{ title: '没有 URL' }, null, 5] } },
    responses: (url) => (url.includes('content_')
      ? { status: 200, html: articleStub('条目一', '2026-09-18') }
      : { status: 200, html: listStub([{ href: '/tw/djxf/tqsd/content_1', title: '条目一', date: '2026-09-18' }]) }),
  });
  const result = await app.run({ column: 'tw-tqsd' });
  assert.equal(result.columns[0].failed, 0, '坏条目不算失败');
  assert.equal(result.columns[0].inserted, 1);
  assert.deepEqual(plain(result.columns[0].pagesRead), [1, 2, 3], '丢弃坏条目后仍能继续回看');
});

// ---------- 站点级冷却与截止点（两轴审查修复） ----------

test('任一栏目撞上限速 403：本轮立即结束，后面的栏目不再请求同一台主机', async () => {
  const app = harness({
    columns: TWO_COLUMNS,
    responses: (url) => {
      if (url === XYXW_LIST_URL) return { status: 200, html: fixture('list-page-1.html') };
      if (url.includes('/xyxw/xydt/')) return { status: 403, html: '每秒不能多于1个页面请求' };
      return { status: 200, html: articleStub('团委条目', '2026-09-18') };
    },
  });
  const result = await app.run({});
  assert.equal(app.requests.length, 2, '校园动态的列表 + 第一篇正文之后必须停下');
  assert.equal(
    app.requests.some((request) => request.url.includes('/tw/djxf/tqsd')),
    false,
    '第一个栏目撞上限速后，第二个栏目一个请求都不能再发（共用出口 IP）',
  );
  assert.equal(result.columns.length, 2, '两个栏目都要有结果说明，不能静默跳过');
  assert.equal(result.columns[0].rateLimited, true);
  assert.match(result.columns[1].skippedReason, /限速|立即结束/);
  assert.match(app.stateDocs['site'].rateLimitedAt, /^2026-09-17T22:20:00/, '冷却写在站点级文档上');
  assert.equal(result.missing, 0, '撞限速不是条目失败，不该记进缺失清单');
});

test('站点级冷却期内任何栏目都不发请求（含未标记过的那一栏）', async () => {
  for (const [name, stateDocs, column] of [
    ['站点级记录', { site: { _id: 'site', rateLimitedAt: '2026-09-17T22:19:00.000Z' } }, 'tw-tqsd'],
    ['栏目级记录（升级前的写法仍然生效）', { 'xyxw-xydt': { _id: 'xyxw-xydt', rateLimitedAt: '2026-09-17T22:19:00.000Z' } }, 'xyxw-xydt'],
  ]) {
    const app = harness({
      now: '2026-09-17T22:20:00.000Z',
      stateDocs,
      responses: () => ({ status: 200, html: fixture('tw-list-page-1.html') }),
    });
    const result = await app.run({ column });
    assert.equal(app.requests.length, 0, `${name}：冷却期内不得发起任何请求`);
    assert.match(result.columns[0].skippedReason, /冷却/, name);
    assert.equal(result.columns[0].rateLimited, false, name);
  }
});

test('撞限速后的第二次调用仍然不发请求（冷却跨调用生效）', async () => {
  const app = harness({
    now: '2026-09-17T22:20:00.000Z',
    responses: (url) => (url === LIST_URL
      ? { status: 200, html: fixture('tw-list-page-1.html') }
      : { status: 403, html: '每秒不能多于1个页面请求' }),
  });
  const first = await app.run({ column: 'tw-tqsd' });
  assert.equal(first.columns[0].rateLimited, true);
  const before = app.requests.length;
  const second = await app.run({ column: 'tw-tqsd' });
  assert.equal(app.requests.length, before, '冷却期内第二次调用不得再请求官网');
  assert.match(second.columns[0].skippedReason, /冷却/);
  assert.equal(app.stateDocs['tw-tqsd'].lastSuccessAt, '', '撞限速不推进整批成功时间');
});

test('等够 1.3 秒之后才判断截止点：等待把人推到截止点之后就不发请求', async () => {
  const app = harness({
    // lastRequestAt 落在未来：等完 1.3 秒的间隔后已经越过本次调用的截止点。
    stateDocs: { 'tw-tqsd': { _id: 'tw-tqsd', lastRequestAt: '2026-09-17T22:21:00.000Z' } },
    responses: () => ({ status: 200, html: fixture('tw-list-page-1.html') }),
  });
  const result = await app.run({ column: 'tw-tqsd' });
  assert.equal(app.requests.length, 0, '截止点之后不得再发起请求');
  assert.equal(result.totals.failed, 0, '预算用尽不是失败');
  assert.equal(result.columns[0].roundComplete, false);
  assert.match(result.columns[0].message, /时间上限|续跑/);
  const state = app.stateDocs['tw-tqsd'];
  assert.equal(state.lastOutcome, 'running');
  assert.equal(state.backfillPage, 1, '没读到的列表页游标不动');
  assert.equal(state.pending.length, 0);
  assert.equal(state.lockUntil, '', '预算用尽也要释放运行锁');
});

test('同站跳转算一次请求，并同样按 1.3 秒节流', async () => {
  const target = `${LIST_URL}/content_1`;
  const app = harness({
    responses: (url) => {
      if (url === LIST_URL) {
        return { status: 200, html: listStub([{ href: '/tw/djxf/tqsd/content_1', title: '跳转条目', date: '2026-09-18' }]) };
      }
      if (url === target) return { status: 302, html: '', headers: { location: `${LIST_URL}/content_1/` } };
      return { status: 200, html: articleStub('跳转条目', '2026-09-18') };
    },
  });
  const result = await app.run({ column: 'tw-tqsd', maxRequests: 3 });
  assert.deepEqual(
    app.requests.map((request) => request.url),
    [LIST_URL, target, `${LIST_URL}/content_1/`],
    '列表页、跳转前的地址、跳转后的地址各算一次请求',
  );
  assertPaced(app.requests);
  assert.equal(result.requestsUsed, 3);
  assert.equal(result.totals.inserted, 1);
});

// ---------- 全量完成口径与日期保留（两轴审查修复） ----------

test('全量导入零失败才算完成，resumeHint 转入增量', async () => {
  const app = harness({
    stateDocs: { 'tw-tqsd': { _id: 'tw-tqsd', backfillPage: 16 } },
    responses: (url) => (url === `${LIST_URL}_16`
      ? { status: 200, html: listStub([{ href: '/tw/djxf/tqsd/content_1', title: '条目一', date: '2026-09-18' }]) }
      : { status: 200, html: articleStub('条目一', '2026-09-18') }),
  });
  const result = await app.run({ column: 'tw-tqsd' });
  assert.equal(app.requests.length, 2, '最后一页：1 次列表 + 1 篇正文');
  assert.equal(result.backfillDone, true);
  assert.equal(result.batchComplete, true);
  assert.equal(result.missing, 0);
  assert.equal(result.columns[0].backfillDone, true);
  assert.match(result.columns[0].message, /全量导入完成/);
  assert.match(result.resumeHint, /增量回看/);
  const state = app.stateDocs['tw-tqsd'];
  assert.equal(state.backfillDone, true);
  assert.notEqual(state.lastSuccessAt, '');
  assert.deepEqual(plain(state.missing), [], '零失败完成时不该留下缺失条目');
});

test('全量读完但有条目没取到：不算完成，状态与 resumeHint 说明还差几条、如何补齐', async () => {
  const broken = `${LIST_URL}/content_1`;
  const app = harness({
    stateDocs: { 'tw-tqsd': { _id: 'tw-tqsd', backfillPage: 16 } },
    responses: (url) => (url === `${LIST_URL}_16`
      ? { status: 200, html: listStub([{ href: '/tw/djxf/tqsd/content_1', title: '条目一', date: '2026-09-18' }]) }
      : { status: 500, html: 'boom' }),
  });
  const result = await app.run({ column: 'tw-tqsd' });
  assert.equal(result.backfillDone, false, '有失败就不能宣称全量完成');
  assert.equal(result.missing, 1);
  assert.deepEqual(plain(app.stateDocs['tw-tqsd'].missing), [broken], '缺失清单要留下具体 URL');
  assert.equal(app.stateDocs['tw-tqsd'].backfillDone, false);
  assert.match(result.resumeHint, /还差 1 条/);
  assert.match(result.resumeHint, /reset/);
  assert.match(result.columns[0].message, /还差 1 条/);
  assert.match(result.columns[0].message, /reset/);
  assert.match(app.stateDocs['tw-tqsd'].lastError, /reset/);

  // 再调用一次：游标已经在末页之后，不会重复请求，但「还差 1 条」必须继续如实保留。
  const before = app.requests.length;
  const again = await app.run({ column: 'tw-tqsd' });
  assert.equal(app.requests.length, before, '没有可跑的全量页时不应再发请求');
  assert.equal(again.missing, 1, '缺失清单跨调用保留');
  assert.equal(again.backfillDone, false);
  assert.match(again.resumeHint, /还差 1 条/);
});

test('文章页缺「发布时间」时保留记录里的旧日期，不再每天重抓同一篇', async () => {
  const itemUrl = `${LIST_URL}/content_1`;
  const noDatePage = '<article class="articleCon"><div class="printArea" data-power-area=\'content\'>'
    + '<h2 class="title">条目一<div class="subheading"></div></h2>'
    + '<div class="property"><span>来源： </span></div>'
    + '<div class="conTxt"><p>正文仍在。</p></div>'
    + '<div class="userControl">分享到：</div></div></article>';
  const app = harness({
    stateDocs: { 'tw-tqsd': { _id: 'tw-tqsd', backfillPage: 16 } },
    articles: [{ _id: 'seed-1', id: 'content_1', url: itemUrl, title: '条目一', date: '2026-09-18', paragraphs: ['旧正文'], updatedAt: OLD_TIME }],
    responses: (url) => {
      // 正文地址以列表地址开头，先判它；其余列表页（含增量回看第 1-3 页）都返回同一份列表。
      if (url === itemUrl) return { status: 200, html: noDatePage };
      if (url.startsWith(LIST_URL)) {
        return { status: 200, html: listStub([{ href: '/tw/djxf/tqsd/content_1', title: '条目一', date: '2026-09-18' }]) };
      }
      return { status: 404, html: 'Not Found' };
    },
  });
  const first = await app.run({ column: 'tw-tqsd' });
  assert.equal(first.backfillDone, true);
  const row = app.articles[0];
  assert.equal(row.date, '2026-09-18', '解析不到发布时间时保留旧日期，不能被空字符串覆盖');
  assert.deepEqual(plain(row.paragraphs), ['正文仍在。']);

  // 下一轮增量回看：标题与日期都没变，应当直接跳过、不再抓正文。
  const articleRequests = () => app.requests.filter((request) => request.url === itemUrl).length;
  const before = articleRequests();
  const second = await app.run({ column: 'tw-tqsd' });
  assert.equal(second.columns[0].skipped, 3, '第 1-3 页各有 1 条未变化的条目，全部跳过');
  assert.equal(articleRequests(), before, '未变化的条目不应重复抓正文');
});

// ---------- 触发方式与状态字段 ----------

test('定时触发与手动触发都可运行，记录时区与实际运行时间', async () => {
  const app = harness({
    now: '2026-09-17T22:20:00.000Z',
    responses: (url) => (url.startsWith(LIST_URL)
      ? { status: 200, html: listStub([{ href: '/tw/djxf/tqsd/content_1', title: '条目一', date: '2026-09-18' }]) }
      : { status: 200, html: articleStub('条目一', '2026-09-18') }),
  });
  const timer = await app.run({ column: 'tw-tqsd', Type: 'Timer', TriggerName: 'newsSyncDaily' });
  assert.equal(timer.trigger, 'timer');
  assert.equal(timer.triggerName, 'newsSyncDaily');
  assert.equal(timer.timeZone, 'Asia/Shanghai（UTC+8）');
  assert.equal(timer.runAt, '2026-09-18 06:20:00 +08:00', '06:00 的定时任务用东八区记录运行时间');
  assert.equal(timer.capturedAt, '2026-09-18', '抓取日期按东八区算，不能用 UTC 日期（前一天）');
  const state = app.stateDocs['tw-tqsd'];
  assert.equal(state.lastRunAtLocal, '2026-09-18 06:20:00 +08:00');
  assert.equal(state.lastTrigger, 'timer', '状态文档记录最近一次调用来自定时触发器');
  assert.equal(state.lastTriggerName, 'newsSyncDaily', '记录触发器名，便于对照控制台配置');

  const manual = await app.run({ column: 'tw-tqsd' });
  assert.equal(manual.trigger, 'manual');
  assert.equal(manual.triggerName, '');
  assert.equal(app.stateDocs['tw-tqsd'].lastTrigger, 'manual', '手动触发覆盖为手动，不影响同步进度');
});

test('未知栏目直接返回错误，不发起请求', async () => {
  const app = harness({ responses: () => ({ status: 200, html: '' }) });
  const result = await app.run({ column: 'not-a-column' });
  assert.equal(result.ok, false);
  assert.match(result.error, /未知栏目/);
  assert.equal(app.requests.length, 0);
});

test('两个栏目平分单批配额，请求仍严格串行限速', async () => {
  const app = harness({
    columns: TWO_COLUMNS,
    responses: (url) => {
      if (url === XYXW_LIST_URL) return { status: 200, html: fixture('list-page-1.html') };
      if (url === LIST_URL) return { status: 200, html: fixture('tw-list-page-1.html') };
      if (url.includes('/xyxw/xydt/')) return { status: 200, html: fixture('article-32118.html') };
      return { status: 200, html: articleStub('团委条目', '2026-09-18') };
    },
  });
  const result = await app.run({});
  assert.equal(app.requests.length, MAX_REQUESTS_PER_CALL);
  assert.equal(result.columns.length, 2);
  assert.deepEqual(plain(result.columns).map((column) => column.requests), [5, 5], '10 次请求在两个栏目间平分');
  assertPaced(app.requests);
  assert.deepEqual(plain(result.columns[0].pagesRead), [1]);
  assert.deepEqual(plain(result.columns[1].pagesRead), [1]);
});

test('真实页面片段经真实入口跑通：列表 → 正文 → 入库', async () => {
  const app = harness({
    responses: (url) => {
      if (url === LIST_URL) return { status: 200, html: fixture('tw-list-page-1.html') };
      if (url === ARTICLE_URL) return { status: 200, html: fixture('tw-article-32355.html') };
      return { status: 404, html: 'Not Found' };
    },
  });
  const result = await app.run({ column: 'tw-tqsd', maxRequests: 2 });
  assert.equal(app.requests.length, 2);
  const row = app.articles.find((article) => article.url === ARTICLE_URL);
  assert.ok(row, '首条真实条目应入库');
  assert.equal(row.title, '关于开展2026年迎新志愿服务活动总结表彰工作的通知');
  assert.equal(row.date, '2026-09-18');
  assert.equal(row.sourceLabel, '学校官网 · 团委通知公告');
  assert.ok(row.paragraphs.length > 0);
  assert.equal(result.totals.inserted, 1);
});
