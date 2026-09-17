const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function loadModule(relativePath) {
  const filename = path.resolve(relativePath);
  return createRequire(filename)(filename);
}

test('入库记录字段与小程序读取侧的约定一致', () => {
  const { toArticleRecord, ARTICLE_RECORD_FIELDS } = loadModule('dist/cloudfunctions/newsSync/record.js');
  const article = {
    id: 'content_1',
    url: 'https://lnc.edu.cn/xyxw/xydt/content_1',
    title: '示例标题',
    date: '2026-09-01',
    paragraphs: ['第一段', '第二段'],
  };
  const record = toArticleRecord(article, '学校官网 · 校园动态', '2026-09-18', '2026-09-18T02:00:00.000Z');

  assert.deepEqual(Object.keys(record).sort(), [...ARTICLE_RECORD_FIELDS].sort());
  // 字段名是云函数与小程序之间的数据契约，改名必须两侧同步（见两份 types.ts 的说明）。
  assert.deepEqual(ARTICLE_RECORD_FIELDS, [
    'id', 'url', 'title', 'date', 'paragraphs', 'sourceLabel', 'capturedAt', 'updatedAt',
  ]);
  assert.equal(record.url, article.url);
  assert.equal(record.sourceLabel, '学校官网 · 校园动态');
  assert.equal(record.paragraphs.length, 2);
});

test('构建把云函数放进 dist，cloudfunctionRoot 指向该目录', () => {
  const config = JSON.parse(fs.readFileSync('dist/project.config.json', 'utf8'));
  assert.equal(typeof config.cloudfunctionRoot, 'string', 'project.config.json 缺少 cloudfunctionRoot');
  const root = path.join('dist', config.cloudfunctionRoot);
  assert.ok(fs.existsSync(root), `cloudfunctionRoot 指向的目录不存在：${root}`);

  const fnDir = path.join(root, 'newsSync');
  for (const file of ['index.js', 'parse.js', 'record.js', 'types.js', 'package.json']) {
    assert.ok(fs.existsSync(path.join(fnDir, file)), `云函数产物缺少 ${file}`);
  }
  assert.ok(!fs.existsSync(path.join(fnDir, 'tsconfig.json')), 'tsconfig.json 不应进入部署目录');

  const pkg = JSON.parse(fs.readFileSync(path.join(fnDir, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies && pkg.dependencies['wx-server-sdk'], '云函数必须声明 wx-server-sdk 依赖');
  assert.equal(pkg.main, 'index.js');
});

test('解析逻辑只存在于云函数产物，不打进小程序包', () => {
  assert.ok(
    !fs.existsSync('dist/services/news/parse.js'),
    '客户端不应打包解析模块：正文在入库前由云函数解析',
  );
  assert.ok(fs.existsSync('dist/services/news/index.js'), '客户端资讯服务应仍然存在');
});
