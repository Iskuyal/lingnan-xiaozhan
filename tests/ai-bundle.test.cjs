/**
 * 构建布局测试（Ticket 01）：AI 服务与它的依赖只允许出现在云函数产物里，
 * 不得进入小程序包；云函数的依赖与权限声明也要能被部署。
 *
 * 与 tests/miniprogram-modules.test.cjs 同为「构建产物契约」类测试：
 * 断言的是 dist 的形状，而不是某个函数的内部实现。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness, readTextFile } = require('./ai-harness.cjs');

const DIST = path.resolve('dist');
const AI_FUNCTION = path.join(DIST, 'cloudfunctions', 'ai');
const CLOUD_ROOT = path.join(DIST, 'cloudfunctions');

/**
 * 收集目录下的文件；predicate 过滤文件名。
 * 目录在并行测试里可能被 tests/pages.test.cjs 的重新构建短暂清空，因此列表为空时多试几次。
 */
function listFiles(dir, predicate = () => true) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(full, predicate));
    else if (predicate(entry.name)) found.push(full);
  }
  return found;
}

/** 产物目录必须存在（若正处于重建窗口，等它建完）。 */
function waitForDirectory(dir) {
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(dir)) {
    if (Date.now() >= deadline) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  assert.ok(fs.existsSync(dir), `产物目录不存在：${dir}`);
}

/** 小程序包的部分：dist 根下除 cloudfunctions 以外的产物。 */
function miniprogramBundleFiles() {
  waitForDirectory(DIST);
  return listFiles(DIST, (name) => name.endsWith('.js'))
    .filter((file) => !path.resolve(file).startsWith(CLOUD_ROOT));
}

test('AI 云函数构建到 dist/cloudfunctions/ai，并带上函数自己的 package.json', () => {
  waitForDirectory(AI_FUNCTION);
  assert.ok(fs.existsSync(path.join(AI_FUNCTION, 'index.js')), '应有编译后的入口 index.js');
  const manifest = JSON.parse(readTextFile(path.join(AI_FUNCTION, 'package.json')));
  assert.equal(manifest.main, 'index.js');
  assert.deepEqual(
    Object.keys(manifest.dependencies).sort(),
    ['wx-server-sdk'],
    '云函数依赖只允许 wx-server-sdk；引入额外 SDK 会同时拖慢部署与冷启动',
  );
  assert.equal(manifest.dependencies['wx-server-sdk'], '4.0.2', '与 newsSync 保持同一版本');
});

test('openapi 权限声明随函数上传，且与代码里声明的接口一致', () => {
  waitForDirectory(AI_FUNCTION);
  const configPath = path.join(AI_FUNCTION, 'config.json');
  assert.ok(fs.existsSync(configPath), '函数目录需要 config.json（云调用权限声明与部署配置）');
  const config = JSON.parse(readTextFile(configPath));
  const declared = config.permissions.openapi.slice().sort();
  // 云函数模块跑在独立 vm 上下文里，数组原型与测试不同，比较前转成普通值。
  const expected = JSON.parse(JSON.stringify(createHarness().load('probe.js').DECLARED_OPENAPI)).slice().sort();
  assert.deepEqual(declared, expected, 'config.json 的 openapi 声明要与代码常量一致');
  assert.deepEqual(declared, ['security.imgSecCheck', 'security.msgSecCheck'].sort(), '内容安全两个接口都要声明');
});

test('小程序包里没有 AI 服务的实现与配置痕迹', () => {
  const files = miniprogramBundleFiles();
  assert.ok(files.length > 0, '应当找到小程序产物');
  // 这些字符串只应出现在云函数侧；它们出现在小程序包里意味着 AI 逻辑被打进了客户端。
  const markers = ['chat/completions', '/v1/messages', 'msgSecCheck', 'imgSecCheck', 'AI_API_KEY', 'AI_BASE_URL', 'ai_usage_records', '内容安全审核员'];
  const offenders = [];
  for (const file of files) {
    const source = readTextFile(file);
    for (const marker of markers) {
      if (source.includes(marker)) offenders.push(`${path.relative(DIST, file)} 含「${marker}」`);
    }
    if (/require\(\s*['"][^'"]*cloudfunctions\//u.test(source)) {
      offenders.push(`${path.relative(DIST, file)} 引用了云函数目录`);
    }
  }
  assert.deepEqual(offenders, [], `小程序包不得包含 AI 服务代码/配置：\n${offenders.join('\n')}`);
});

test('小程序包目录里不存在 ai 云函数的副本', () => {
  waitForDirectory(DIST);
  const bundleDirs = fs.readdirSync(DIST, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'cloudfunctions')
    .map((entry) => entry.name);
  assert.ok(!bundleDirs.includes('ai'), `dist 根下不应出现 ai 目录：${bundleDirs.join('、')}`);
  assert.ok(!fs.existsSync(path.join(DIST, 'ai')), 'AI 函数只能待在 dist/cloudfunctions/ai');
  assert.equal(
    JSON.parse(readTextFile(path.join(DIST, 'project.config.json'))).cloudfunctionRoot,
    'cloudfunctions/',
    '开发者工具按 cloudfunctionRoot 识别云函数，AI 函数因此不会被当页面资源打进包',
  );
});

test('云函数只 require Node 内置模块、相对文件与 wx-server-sdk', () => {
  waitForDirectory(AI_FUNCTION);
  const files = listFiles(AI_FUNCTION, (name) => name.endsWith('.js'));
  assert.ok(files.length > 0, '应当找到云函数产物');
  const builtins = new Set(['http', 'https', 'crypto', 'url', 'util', 'zlib', 'events', 'stream', 'buffer', 'process']);
  const offenders = [];
  for (const file of files) {
    const source = readTextFile(file);
    const pattern = /require\(\s*(['"])([^'"]+)\1\s*\)/gu;
    let match = pattern.exec(source);
    while (match !== null) {
      const specifier = match[2];
      match = pattern.exec(source);
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative) {
        const resolved = path.resolve(path.dirname(file), specifier);
        const target = [resolved, `${resolved}.js`].find((candidate) => fs.existsSync(candidate));
        if (target === undefined) offenders.push(`${path.relative(DIST, file)} → ${specifier} 解析不到文件`);
        continue;
      }
      if (specifier === 'wx-server-sdk') continue;
      if (builtins.has(specifier) || (specifier.startsWith('node:') && builtins.has(specifier.slice(5)))) continue;
      offenders.push(`${path.relative(DIST, file)} 依赖了未声明的外部模块：${specifier}`);
    }
  }
  assert.deepEqual(offenders, [], `云函数依赖必须与 package.json 一致：\n${offenders.join('\n')}`);
});

test('根 tsconfig 不把云函数代码编进小程序产物', () => {
  const tsconfig = JSON.parse(fs.readFileSync(path.resolve('tsconfig.json'), 'utf8'));
  assert.deepEqual(
    tsconfig.include,
    ['miniprogram/**/*.ts'],
    '小程序端只编译 miniprogram/，云函数用 cloudfunctions/tsconfig.json 单独编译',
  );
  assert.ok(!JSON.stringify(tsconfig.include).includes('cloudfunctions'), '云函数目录不得进入小程序编译范围');
});

test('云函数源码里没有硬编码密钥', () => {
  waitForDirectory(AI_FUNCTION);
  const files = listFiles(path.resolve('cloudfunctions', 'ai'), () => true)
    .concat(listFiles(AI_FUNCTION, () => true));
  const offenders = [];
  for (const file of files) {
    const source = readTextFile(file);
    if (/sk-[A-Za-z0-9]{20,}/u.test(source)) offenders.push(`${path.relative(process.cwd(), file)} 疑似含密钥`);
    if (/\bapiKey\s*[:=]\s*['"][^'"]{16,}['"]/u.test(source)) offenders.push(`${path.relative(process.cwd(), file)} 疑似硬编码 apiKey`);
  }
  assert.deepEqual(offenders, [], `密钥只能来自环境变量：\n${offenders.join('\n')}`);
});
