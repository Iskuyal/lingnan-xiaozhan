/**
 * 把样式里 var(--token, 回退值) 的回退值同步为 app.wxss 中的令牌定义。
 *
 * 为什么要常驻：tests/wxss.test.cjs 会逐条核对「回退值与令牌定义严格一致」，
 * 改动令牌定义后若不同步，测试会失败并指出具体位置；本脚本就是那条失败的修复方式。
 *
 * 注意：回退值里含 rgba(...) 这类嵌套括号，必须按括号配对解析——用 [^)]* 之类的
 * 正则会贪婪吃掉内层括号并在替换时多补一个右括号，把样式改坏。
 * 用法：node scripts/sync-css-token-fallbacks.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MINIPROGRAM = 'miniprogram';

function listWxss(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listWxss(full));
    else if (entry.name.endsWith('.wxss')) found.push(full);
  }
  return found;
}

/** 从 app.wxss 的 page 块读出令牌表。 */
function readTokens() {
  const css = readFileSync(join(MINIPROGRAM, 'app.wxss'), 'utf8');
  const tokens = new Map();
  for (const [, name, value] of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(name, value.trim());
  }
  return tokens;
}

/** 返回从 start 处 var( 的配对右括号之后的字符下标。 */
function afterParen(source, start) {
  let depth = 1;
  let cursor = start + 4;
  while (cursor < source.length && depth > 0) {
    if (source[cursor] === '(') depth += 1;
    else if (source[cursor] === ')') depth -= 1;
    cursor += 1;
  }
  return cursor;
}

/** 在顶层逗号处切分令牌名与回退值；没有逗号说明没写回退值。 */
function splitUsage(inner) {
  let nested = 0;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === '(') nested += 1;
    else if (char === ')') nested -= 1;
    else if (char === ',' && nested === 0) {
      return { name: inner.slice(0, index).trim(), fallback: inner.slice(index + 1).trim() };
    }
  }
  return { name: inner.trim(), fallback: null };
}

function syncSource(source, tokens) {
  let out = '';
  let index = 0;
  let changed = 0;
  for (;;) {
    const start = source.indexOf('var(', index);
    if (start === -1) {
      out += source.slice(index);
      break;
    }
    out += source.slice(index, start);
    const cursor = afterParen(source, start);
    const { name, fallback } = splitUsage(source.slice(start + 4, cursor - 1));
    const defined = tokens.get(name);
    // 未定义的令牌与缺失的回退值原样保留，交给测试报错，脚本只负责「值不一致」。
    if (defined === undefined || fallback === null || fallback === defined) {
      out += source.slice(start, cursor);
    } else {
      out += `var(${name}, ${defined})`;
      changed += 1;
    }
    index = cursor;
  }
  return { source: out, changed };
}

const tokens = readTokens();
let files = 0;
let changed = 0;

for (const file of listWxss(MINIPROGRAM)) {
  const before = readFileSync(file, 'utf8');
  const { source, changed: count } = syncSource(before, tokens);
  if (source !== before) {
    writeFileSync(file, source);
    files += 1;
    changed += count;
  }
}

console.log(`令牌 ${tokens.size} 个；更新 ${files} 个文件、${changed} 处回退值`);
