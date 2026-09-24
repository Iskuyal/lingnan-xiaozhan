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

function listFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(full));
    else found.push(full);
  }
  return found;
}

// 课表解析必须留在云函数侧：主包不因 Excel 库（SheetJS 约 0.9MB，单包上限 2MB）变大。
// 云函数目录按 project.config.json 的 cloudfunctionRoot 单独部署，不进小程序包。
test('小程序产物不含 Excel 解析库，解析器只在云函数产物里', () => {
  const root = path.resolve('dist');
  const offenders = [];
  for (const file of listFiles(root)) {
    const relative = path.relative(root, file);
    if (relative.split(path.sep)[0] === 'cloudfunctions') continue;
    if (/xlsx|sheetjs|cpexcel/iu.test(relative)) {
      offenders.push(`${relative}: 文件名像 Excel 解析库`);
      continue;
    }
    if (!file.endsWith('.js')) continue;
    const source = fs.readFileSync(file, 'utf8');
    const requires = source.match(/require\(\s*(['"])[^'"]+\1\s*\)/g) ?? [];
    for (const call of requires) {
      if (/xlsx|sheetjs|cpexcel/iu.test(call)) offenders.push(`${relative}: ${call}`);
      if (/cloudfunctions/iu.test(call)) offenders.push(`${relative}: 小程序侧引用了云函数目录 ${call}`);
    }
  }
  assert.deepEqual(offenders, [], `小程序包不应包含 Excel 解析库：\n${offenders.join('\n')}`);
  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(root, 'miniprogram_npm')), false);

  // 反向断言：解析器确实随云函数构建，并且声明了 xlsx 依赖，否则解析跑不起来。
  const functionPackage = JSON.parse(fs.readFileSync(path.resolve('cloudfunctions/timetable/package.json'), 'utf8'));
  assert.equal(
    functionPackage.dependencies.xlsx,
    'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz',
  );
  assert.ok(fs.existsSync(path.resolve('dist/cloudfunctions/timetable/parse.js')), '云函数产物应包含解析器');
  const parseSource = fs.readFileSync(path.resolve('dist/cloudfunctions/timetable/parse.js'), 'utf8');
  assert.match(parseSource, /require\("xlsx"\)/u, '云函数侧的解析器应在运行时引入 xlsx');
});
