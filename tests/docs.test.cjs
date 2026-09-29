const test = require('node:test');
const { before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let checkDocuments;
before(async () => { ({ checkDocuments } = await import('../scripts/check-docs.mjs')); });

function fixture(t, files) {
  const tempRoot = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, 'wx-match-doc-links-'));
  t.after(() => {
    // Only remove the exact temporary workspace created by this fixture.
    if (path.dirname(path.resolve(root)) !== tempRoot || !path.basename(root).startsWith('wx-match-doc-links-')) {
      throw new Error('Refuse to remove an unexpected fixture path');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const [name, content] of Object.entries(files)) {
    const file = path.resolve(root, name);
    assert.ok(file.startsWith(root + path.sep));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

function check(t, files, sources = ['README.md']) {
  return checkDocuments({ root: fixture(t, files), files: sources });
}

test('文档检查：有效的相对链接、图片与目录通过', (t) => {
  const result = check(t, {
    'README.md': '# 项目\n[指南](docs/guide.md)\n![图](docs/image.png)\n[目录](docs/)',
    'docs/guide.md': '# 指南', 'docs/image.png': 'fixture',
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.filesChecked, 1);
  assert.equal(result.linksChecked, 3);
});

test('文档检查：丢失文件返回来源行号与目标', (t) => {
  const result = check(t, { 'README.md': '# 项目\n[失效](missing.md)' });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].file, 'README.md');
  assert.equal(result.errors[0].line, 2);
  assert.equal(result.errors[0].url, 'missing.md');
});

test('文档检查：中文标题、行内代码、重复标题与显式锚点通过', (t) => {
  const result = check(t, {
    'README.md': '[中文](guide.md#中文-code)\n[重复](guide.md#重复-1)\n[显式](guide.md#legacy)',
    'guide.md': '# 中文 `code`\n## 重复\n## 重复\n<a id="legacy"></a>',
  });
  assert.deepEqual(result.errors, []);
});

test('文档检查：同页锚点有效，失效锚点报错', (t) => {
  const result = check(t, { 'README.md': '# 标题\n[有效](#标题)\n[失效](#不存在)' });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].line, 3);
  assert.match(result.errors[0].message, /锚点/);
});

test('文档检查：引用式链接定义同样验证本地目标', (t) => {
  const result = check(t, {
    'README.md': '[文档][good]\n[good]: guide.md "标题"\n[bad]: missing.md',
    'guide.md': '# 指南',
  });
  assert.equal(result.linksChecked, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].line, 3);
});

test('文档检查：忽略外部地址且不请求网络', (t) => {
  const result = check(t, {
    'README.md': '[网站](https://example.invalid/page#absent)\n[邮箱](mailto:test@example.invalid)\n[远程](//example.invalid/a)\n![内嵌](data:image/png;base64,AAAA)',
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.linksChecked, 0);
});

test('文档检查：代码围栏和行内代码中的示例不作为链接', (t) => {
  const result = check(t, {
    'README.md': '# 项目\n`[示例](missing.md)`\n````md\n[示例](missing.md)\n```\n[仍为代码](missing.md)\n````\n~~~md\n[示例](missing.md)\n~~~',
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.linksChecked, 0);
});

test('文档检查：支持空格编码、括号路径、标题属性与编码锚点', (t) => {
  const result = check(t, {
    'README.md': '[一](docs/guide%20(1).md#%E4%B8%AD%E6%96%87 "说明")\n[二](<docs/guide (1).md#中文>)',
    'docs/guide (1).md': '# 中文',
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.linksChecked, 2);
});

test('文档检查：仓库根路径与查询串可解析', (t) => {
  const result = check(t, {
    'README.md': '[指南](/docs/guide.md?plain=1#标题)',
    'docs/guide.md': '# 标题',
  });
  assert.deepEqual(result.errors, []);
});

test('文档检查：Windows 上也拒绝大小写错误以兼容 Linux CI', (t) => {
  const result = check(t, { 'README.md': '[指南](Guide.md)', 'guide.md': '# 指南' });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /大小写|不存在/);
});

test('文档检查：拒绝仓库外路径和错误百分号编码', (t) => {
  const result = check(t, { 'README.md': '[越界](../outside.md)\n[编码](%ZZ.md)' });
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0].message, /仓库/);
  assert.match(result.errors[1].message, /编码/);
});

test('文档检查：HTML 图片与链接可检查且保留显式锚点', (t) => {
  const result = check(t, {
    'README.md': '<img src="image.png">\n<a href="guide.md#named">指南</a>',
    'image.png': 'fixture', 'guide.md': '<a name="named"></a>',
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.linksChecked, 2);
});

test('文档检查：不把围栏里的标题当作文档锚点', (t) => {
  const result = check(t, { 'README.md': '[错误](#示例标题)\n```md\n# 示例标题\n```' });
  assert.equal(result.errors.length, 1);
});
