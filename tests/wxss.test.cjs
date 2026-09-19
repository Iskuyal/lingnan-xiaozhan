const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 中日韩文字、全角标点：本项目的样式内容只应出现在注释里，
// 一旦注释提前闭合，注释里的中文就会泄漏成非法样式并被开发者工具判为编译错误。
const NON_ASCII_TEXT = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

function listWxss(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listWxss(full));
    else if (entry.name.endsWith('.wxss')) found.push(full);
  }
  return found;
}

/** 逐字符扫描，把注释与其外的样式内容分开；注释以星号加斜杠闭合。 */
function splitComments(source) {
  const outside = [];
  let inComment = false;
  let index = 0;
  while (index < source.length) {
    if (!inComment && source.startsWith('/*', index)) {
      inComment = true;
      index += 2;
      continue;
    }
    if (inComment && source.startsWith('*/', index)) {
      inComment = false;
      index += 2;
      continue;
    }
    if (!inComment) outside.push(source[index]);
    index += 1;
  }
  return { outside: outside.join(''), closed: !inComment };
}

test('WXSS 注释不提前闭合，非注释内容不含中文文本', () => {
  const files = listWxss(path.resolve('miniprogram'));
  assert.ok(files.length > 0, '应当找到 .wxss 文件');
  for (const file of files) {
    const relative = path.relative(process.cwd(), file);
    const { outside, closed } = splitComments(fs.readFileSync(file, 'utf8'));
    assert.ok(closed, `${relative}: 存在未闭合的注释`);
    const leaked = outside.match(NON_ASCII_TEXT);
    if (leaked !== null) {
      const from = Math.max(0, leaked.index - 40);
      assert.fail(
        `${relative}: 注释提前闭合，以下文字泄漏为样式内容：` +
          JSON.stringify(outside.slice(from, leaked.index + 40)),
      );
    }
    const opened = (outside.match(/\{/g) || []).length;
    const closedBraces = (outside.match(/\}/g) || []).length;
    assert.equal(opened, closedBraces, `${relative}: 花括号不平衡（${opened} != ${closedBraces}）`);
    // 回退值里含 rgba(...) 这类嵌套括号，用 [^)]* 之类的正则批量改写很容易多补或少补
    // 一个右括号——那样整条声明会被浏览器判为非法并丢弃，且不报错，只能靠这条守住。
    const leftParens = (outside.match(/\(/g) || []).length;
    const rightParens = (outside.match(/\)/g) || []).length;
    assert.equal(leftParens, rightParens, `${relative}: 圆括号不平衡（${leftParens} != ${rightParens}）`);
  }
});

/**
 * 用括号配对解析出所有 var() 用法。回退值里可能含 rgba(...) 这类嵌套括号，
 * 正则的 [^)]* 会在第一个右括号截断，因此逐字符扫描而不是用正则取内容。
 * 返回 { name, fallback }；fallback 为 null 表示没写回退值。
 */
function parseVarUsages(source) {
  const usages = [];
  let start = source.indexOf('var(');
  while (start !== -1) {
    let depth = 1;
    let cursor = start + 4;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === '(') depth += 1;
      else if (source[cursor] === ')') depth -= 1;
      cursor += 1;
    }
    const inner = source.slice(start + 4, cursor - 1);
    // 在顶层逗号处切分令牌名与回退值。
    let nested = 0;
    let split = -1;
    for (let index = 0; index < inner.length; index += 1) {
      const char = inner[index];
      if (char === '(') nested += 1;
      else if (char === ')') nested -= 1;
      else if (char === ',' && nested === 0) { split = index; break; }
    }
    usages.push({
      name: (split === -1 ? inner : inner.slice(0, split)).trim(),
      fallback: split === -1 ? null : inner.slice(split + 1).trim(),
    });
    start = source.indexOf('var(', cursor);
  }
  return usages;
}

// WXSS 对 CSS 自定义属性的支持存在不一致的报告：官方 Skyline 文档称支持，但有
// 「app.wxss 中的 page 变量不继承到页面文件」「开发者工具正常、真机失效」的反馈。
// 因此约定：引用令牌一律写回退值 var(--token, 字面值)，且回退值与令牌定义严格一致。
// 变量生效时令牌仍是单一来源，失效时退回字面值，两种情况渲染结果都正确。
// 这条测试同时守住「不回退」和「回退值与定义漂移」两种情况。
test('样式引用设计令牌一律带回退值，且回退值与令牌定义一致', () => {
  const appSource = fs.readFileSync(path.resolve('miniprogram/app.wxss'), 'utf8');
  const tokens = new Map();
  for (const [, name, value] of appSource.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(name, value.trim());
  }
  assert.ok(tokens.size > 0, 'app.wxss 应当定义设计令牌');

  let checked = 0;
  for (const file of listWxss(path.resolve('miniprogram'))) {
    const relative = path.relative(process.cwd(), file);
    // 令牌定义与说明写在注释里，扫描前先剥掉注释，避免把说明当成用法。
    const { outside } = splitComments(fs.readFileSync(file, 'utf8'));
    for (const { name, fallback } of parseVarUsages(outside)) {
      checked += 1;
      const defined = tokens.get(name);
      assert.ok(defined !== undefined, `${relative}: 引用了未定义的令牌 ${name}`);
      assert.ok(
        fallback !== null,
        `${relative}: var(${name}) 缺少回退值，应写成 var(${name}, ${defined})（原因见本测试上方说明）`,
      );
      assert.equal(
        fallback,
        defined,
        `${relative}: var(${name}) 的回退值「${fallback}」与 app.wxss 中的定义「${defined}」不一致`,
      );
    }
  }
  assert.ok(checked > 0, '应当至少找到一处令牌引用，否则主题可能已被改回字面色值');
});
