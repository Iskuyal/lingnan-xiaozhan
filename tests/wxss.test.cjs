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
  }
});
