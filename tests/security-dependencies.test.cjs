const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'));
}

function versionAtLeast(actual, expected) {
  const left = actual.split('.').map(Number);
  const right = expected.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

test('处理用户课表的 SheetJS 使用已修复版本，根项目与云函数声明保持一致', () => {
  const rootPackage = readJson('package.json');
  const timetablePackage = readJson('cloudfunctions/timetable/package.json');
  const expected = 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz';

  assert.equal(rootPackage.devDependencies.xlsx, expected);
  assert.equal(timetablePackage.dependencies.xlsx, expected);
  assert.equal(require('xlsx').version, '0.20.3');
});

test('CloudBase 传递依赖固定到无已知漏洞版本，安全 set 不允许污染原型', () => {
  const manifests = [
    readJson('package.json'),
    readJson('cloudfunctions/ai/package.json'),
    readJson('cloudfunctions/newsSync/package.json'),
    readJson('cloudfunctions/timetable/package.json'),
  ];

  for (const manifest of manifests) {
    assert.equal(manifest.overrides.axios, '0.33.0');
    assert.equal(manifest.overrides['lodash.set'], 'npm:set-value@4.1.0');
    assert.equal(manifest.overrides['lodash.unset'], '4.18.0');
  }

  assert.ok(versionAtLeast(require('axios/package.json').version, '0.33.0'));
  assert.ok(versionAtLeast(require('lodash.unset/package.json').version, '4.18.0'));

  const safeSetPath = require.resolve('lodash.set', {
    paths: [path.join(root, 'node_modules/@cloudbase/database')],
  });
  const safeSet = require(safeSetPath);
  const target = {};
  safeSet(target, 'course.teacher.name', '测试教师');
  assert.equal(target.course.teacher.name, '测试教师');
  assert.throws(
    () => safeSet(target, '__proto__.wxMatchPolluted', true),
    /unsafe key/u,
  );
  assert.equal({}.wxMatchPolluted, undefined);
});

test('开发者工具自动化使用已修复的图像依赖，并保留 SDK 所需的 read 兼容入口', () => {
  const rootPackage = readJson('package.json');
  assert.equal(rootPackage.overrides['miniprogram-automator'].jimp, '1.6.1');

  // 从 SDK 的解析路径取它实际装到的 jimp：override 是嵌套安装
  // 或提升到根目录；两种 npm 布局都应解析到修复后的版本。
  const jimpPackagePath = require.resolve('jimp/package.json', {
    paths: [path.join(root, 'node_modules/miniprogram-automator')],
  });
  assert.equal(require(jimpPackagePath).version, '1.6.1', 'automator 必须拿到已修复版本');

  // miniprogram-automator 0.12.1 调的是旧入口 `jimp.default.read()`；Jimp 1.x
  // 把实现放在 `Jimp.read()`。公共连接模块必须先装兼容入口再加载 automator。
  require('../scripts/lib/mini-connect.cjs');
  const jimp = require(path.dirname(jimpPackagePath));
  assert.equal(typeof jimp.Jimp?.read, 'function', 'Jimp 1.x 应提供新的静态 read API');
  assert.equal(typeof jimp.default?.read, 'function', '兼容层应向旧 SDK 暴露 default.read');
});
