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

test('开发者工具自动化图像依赖固定在兼容版本（1.x 会让 SDK 的 read 路径失效）', () => {
  const rootPackage = readJson('package.json');
  assert.equal(rootPackage.overrides['miniprogram-automator'].jimp, '0.22.12');

  // 从 SDK 的解析路径取它实际装到的 jimp：override 是嵌套安装
  // （node_modules/miniprogram-automator/node_modules/jimp），根目录 require 不到。
  const jimpPackagePath = require.resolve('jimp/package.json', {
    paths: [path.join(root, 'node_modules/miniprogram-automator')],
  });
  assert.equal(require(jimpPackagePath).version, '0.22.12', 'automator 必须拿到 0.22.x');

  // 行为断言：miniprogram-automator 的 util 调的是 `jimp.default.read()`。
  // jimp 1.6.1 是 ESM 包且没有 read（实测 typeof 为 undefined），升上去会让扫码登录路径
  // 直接不可用——这条断言就是为了防止它被"顺手升级"掉。
  const jimp = require(path.dirname(jimpPackagePath));
  const read = typeof jimp.read === 'function' ? jimp.read : jimp.default && jimp.default.read;
  assert.equal(typeof read, 'function', 'automator 依赖 jimp.read()，1.x 没有这个 API');

  // 取舍记录：jimp 树的 moderate 通告（@jimp/core → file-type）只影响**本地测试依赖**，
  // 不进小程序包、不进云函数；而升到 1.x 会卡住自动化验收（verify:wechat 依赖它）。
  // 2026-09-20 实测：装 1.6.1 时验收连续三次在不同页面超时，改回 0.22.12 并通过。
  // 若将来要修这条通告，应连 miniprogram-automator 一起升级，而不是单独升 jimp。
});
