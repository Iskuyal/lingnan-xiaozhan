const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

const fixture = (name) => fs.readFileSync(`tests/fixtures/news/${name}`, 'utf8');
const oldTime = '2026-09-01T00:00:00.000Z';
const url = 'https://lnc.edu.cn/xyxw/xydt/content_32118';

// 只替换网络和数据库边界；运行真实入口、解析器与入库映射，不访问线上环境。
function harness(responses) {
  const articles = [{ _id: 'old', id: 'content_32118', url, title: '旧标题', date: '2026-09-01', paragraphs: ['旧正文'], updatedAt: oldTime }];
  const state = { lastSuccessAt: oldTime };
  const db = {
    collection(name) {
      let condition;
      return {
        where(value) { condition = value; return this; },
        limit() { return this; },
        orderBy() { return this; },
        async get() { return { data: articles.filter((row) => !condition || row.url === condition.url) }; },
        doc(id) {
          return {
            async update({ data }) {
              Object.assign(name === 'sync_state' ? state : articles.find((row) => row._id === id), data);
            },
            async set({ data }) { Object.assign(state, data); },
          };
        },
        async add({ data }) { articles.push({ _id: `new-${articles.length}`, ...data }); },
      };
    },
  };
  const https = {
    get(requestUrl, options, callback) {
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new EventEmitter();
        const page = requestUrl.endsWith('/xydt')
          ? { status: 200, html: fixture('list-page-1.html') }
          : responses[requestUrl] || { status: 503, html: 'Unavailable' };
        response.statusCode = page.status;
        response.headers = {};
        callback(response);
        response.emit('data', Buffer.from(page.html));
        response.emit('end');
      });
      return request;
    },
  };
  const filename = path.resolve('dist/cloudfunctions/newsSync/index.js');
  const realRequire = createRequire(filename);
  const context = {
    exports: {}, Buffer, URL, console,
    require(name) {
      if (name === 'https') return https;
      if (name === 'wx-server-sdk') return { init() {}, database: () => db };
      return realRequire(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { run: context.exports.main, articles, state };
}

for (const [name, html] of [
  ['HTTP 200 维护页', '<html><title>维护中</title></html>'],
  ['正文容器丢失', '<h1 class="title">标题</h1><div>发布时间：2026-09-12</div>'],
]) {
  test(`${name}不覆盖旧文章，也不记录同步成功`, async () => {
    const app = harness({ [url]: { status: 200, html } });
    const before = JSON.stringify(app.articles);
    const result = await app.run({ limit: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.failed, 1);
    assert.equal(JSON.stringify(app.articles), before);
    assert.equal(app.state.lastSuccessAt, oldTime);
    assert.equal(app.state.lastOutcome, 'failed');
  });
}

test('全部文章 HTTP 失败时保留最后成功时间', async () => {
  const app = harness({});
  const result = await app.run({ limit: 2 });
  assert.equal(result.failed, 2);
  assert.equal(result.inserted + result.updated, 0);
  assert.equal(app.state.lastSuccessAt, oldTime);
  assert.equal(app.state.lastOutcome, 'failed');
});

test('部分成功仅更新有效文章，不推进整批成功时间', async () => {
  const app = harness({ [url]: { status: 200, html: fixture('article-32118.html') } });
  const result = await app.run({ limit: 2 });
  assert.equal(result.updated, 1);
  assert.equal(result.failed, 1);
  assert.equal(app.state.lastOutcome, 'partial');
  assert.equal(app.state.lastSuccessAt, oldTime);
  assert.notEqual(app.articles[0].updatedAt, oldTime);
});

test('有效文章可重复同步且无日期时仍允许保存正文', async () => {
  const html = '<h1 class="title">真实标题</h1><div class="article-content"><p>有效正文</p></div><div class="article-fd"></div>';
  const app = harness({ [url]: { status: 200, html } });
  await app.run({ limit: 1 });
  const result = await app.run({ limit: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.inserted, 0);
  assert.equal(result.updated, 1);
  assert.equal(app.articles.length, 1);
  assert.equal(app.articles[0].date, '');
  assert.equal(app.articles[0].paragraphs[0], '有效正文');
  assert.equal(app.state.lastOutcome, 'ok');
  assert.notEqual(app.state.lastSuccessAt, oldTime);
});
