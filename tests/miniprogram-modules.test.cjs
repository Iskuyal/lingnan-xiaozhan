const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function listJavaScript(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listJavaScript(full));
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

// 微信小程序的模块解析只按下发的文件路径查找，不做 Node 式的目录 index 回退：
// require('../../services/news') 不会落到 services/news/index.js。
// Node 能解析成功，因此这类错误只能在开发者工具里暴露。
test('产物的模块引用按微信规则可解析到具体文件', () => {
  const files = listJavaScript(path.resolve('dist'));
  assert.ok(files.length > 0, '应当找到 .js 构建产物');
  const unresolved = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const pattern = /require\(\s*(['"])([^'"]+)\1\s*\)/g;
    let match = pattern.exec(source);
    while (match !== null) {
      const specifier = match[2];
      match = pattern.exec(source);
      if (!specifier.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), specifier);
      const asFile = [resolved, `${resolved}.js`, `${resolved}.json`].find(
        (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
      );
      if (asFile !== undefined) continue;
      const isDirectory = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
      unresolved.push(
        `${path.relative(process.cwd(), file)}: require('${specifier}')` +
          (isDirectory ? ' 指向目录，微信不会回退到 index.js' : ' 无法解析到文件'),
      );
    }
  }
  assert.deepEqual(unresolved, [], `微信无法解析的模块引用：\n${unresolved.join('\n')}`);
});
