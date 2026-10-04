const test = require('node:test');
const { before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
let checkDocuments;
let collectVisibleFiles;
before(async () => {
  ({ checkDocuments, collectVisibleFiles } = await import('../scripts/check-docs.mjs'));
});

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

// ------------------------------------------------ 链接目标必须能在干净检出里存在（2026-10-02）

test('文档检查：指向被 .gitignore 忽略的目标时报错（CI 干净检出会 404）', (t) => {
  const files = {
    'README.md': '# 项目\n[回读](artifacts/verify/readback.json)',
    'artifacts/verify/readback.json': '{}',
  };
  // `visible` 就是 collectVisibleFiles 的结果：这份 fixture 里只有 README.md 被 git 看见。
  const ignored = checkDocuments({ root: fixture(t, files), files: ['README.md'], visible: new Set(['README.md']) });
  assert.equal(ignored.errors.length, 1);
  assert.equal(ignored.errors[0].url, 'artifacts/verify/readback.json');
  assert.match(ignored.errors[0].message, /git/u);

  // 同一份文件若真的会进 git（例如没有被忽略），判据必须放过。
  const tracked = checkDocuments({
    root: fixture(t, files),
    files: ['README.md'],
    visible: new Set(['README.md', 'artifacts/verify/readback.json']),
  });
  assert.deepEqual(tracked.errors, []);
});

test('文档检查：collectVisibleFiles 用 -z 解析，中文文件名不转义、被忽略项被排除', (t) => {
  const root = fixture(t, {
    '.gitignore': 'artifacts/\n',
    'README.md': '# 项目\n[中文](docs/中文.md)\n[生成物](artifacts/out.json)\n[目录](docs/)',
    'docs/中文.md': '# 中文',
    'artifacts/out.json': '{}',
  });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'README.md', 'docs/中文.md'], { cwd: root });
  const visible = collectVisibleFiles(root);
  assert.ok(visible.has('README.md'));
  // 不带 -z 的默认输出会把中文名转义成 \344\270\255\346\226\207，这里必须拿到原样文件名。
  assert.ok(visible.has('docs/中文.md'), `中文文件名不应被转义：${[...visible].join(' ')}`);
  assert.ok(!visible.has('artifacts/out.json'), '被忽略的生成物不应出现在可见集合里');

  // 目录链接（`docs/`）靠「目录下有可见文件」通过，生成物链接必须被拦下。
  const result = checkDocuments({ root, files: ['README.md'], visible });
  assert.equal(result.errors.length, 1, JSON.stringify(result.errors));
  assert.equal(result.errors[0].url, 'artifacts/out.json');
});

test('文档检查：未提交目标必须报错，git add 后才可交付', (t) => {
  const root = fixture(t, {
    'README.md': '[遗漏文件](docs/new.md)',
    'docs/new.md': '# 新文档',
  });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  const result = checkDocuments({ root, files: ['README.md'], visible: collectVisibleFiles(root) });
  assert.equal(result.errors.length, 1, '磁盘上的未跟踪目标不能冒充可交付文件');
  assert.equal(result.errors[0].url, 'docs/new.md');
  execFileSync('git', ['add', 'docs/new.md'], { cwd: root });
  assert.deepEqual(checkDocuments({ root, files: ['README.md'], visible: collectVisibleFiles(root) }).errors, []);
});
