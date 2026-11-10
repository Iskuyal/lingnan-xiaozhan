const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

/**
 * 首页「问 AI」输入条（设计图 01 底部常驻条）。
 *
 * 这一条的每一下点击都决定「会不会乱跳页、会不会把没写的问题发出去」，
 * 且 2026-11-10 开发者工具实测抓到过一次真实缺陷：`?ask=` 不解码，
 * 学生看到的是 `%E8%BF%99...`。所以这里把四支行为逐一钉死。
 */
function loadPage(name, wx, stack = [{}]) {
  const filename = path.resolve(`dist/pages/${name}/index.js`);
  let page;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: (definition) => { page = definition; },
    wx,
    getCurrentPages: () => stack,
    require: createRequire(filename),
    module: { exports: {} },
    exports: {},
  }, { filename });
  page.setData = (patch) => { Object.assign(page.data, patch); };
  return page;
}

/** 记录每一次跳转与每一句 toast：输入条的行为全部体现在这两个通道里。 */
function recorder() {
  const visited = [];
  const toasts = [];
  return {
    visited,
    toasts,
    wx: {
      navigateTo: ({ url }) => visited.push(url),
      showToast: ({ title }) => toasts.push(title),
    },
  };
}

test('首页问 AI：发送把问题转义后带进课表页，居中空白与超长都先清掉', () => {
  const rec = recorder();
  const home = loadPage('home', rec.wx);
  const question = '这周三第几节有课？';
  home.onAskInput({ detail: { value: `  ${question}  ` } });
  home.sendAsk();

  assert.equal(rec.visited.length, 1, '只跳一次');
  const url = rec.visited[0];
  // 中文与「？」必须转义，否则会被 URL 当成参数分隔符切断。
  assert.equal(url, `/pages/timetable/index?ask=${encodeURIComponent(question)}`);
  assert.ok(url.includes('?ask='));
  assert.equal(decodeURIComponent(url.split('?ask=')[1]), question, '课表页解码后要拿回原问题');
  assert.deepEqual(rec.toasts, [], '成功发送不弹提示');

  // 超长粘贴不能把整段塞进 URL：按 500 字截断（与 ASK_MAX_CHARS 一致）。
  const long = '课'.repeat(600);
  rec.visited.length = 0;
  home.onAskInput({ detail: { value: long } });
  home.sendAsk();
  assert.equal(decodeURIComponent(rec.visited[0].split('?ask=')[1]).length, 500);
});

test('首页问 AI：空输入只提示一句，不跳页', () => {
  for (const value of ['', '   ', '\n\t ']) {
    const rec = recorder();
    const home = loadPage('home', rec.wx);
    home.onAskInput({ detail: { value } });
    home.sendAsk();
    assert.deepEqual(rec.visited, [], '空问题不跳转');
    assert.deepEqual(rec.toasts, ['先写一句想问的']);
  }
});

test('首页问 AI：建议 chip 只填进输入框，不发送也不跳页', () => {
  for (const text of ['明天几点出门？', '贴一段调课通知', '这周哪天最空？']) {
    const rec = recorder();
    const home = loadPage('home', rec.wx);
    home.useSuggestion({ currentTarget: { dataset: { text } } });
    assert.equal(home.data.askText, text, 'chip 只是替学生把话写好');
    assert.deepEqual(rec.visited, [], '点 chip 不直接发送');
    assert.deepEqual(rec.toasts, []);
  }

  // 没有文案的 chip（dataset 缺失）不能把输入框清空成 undefined。
  const rec = recorder();
  const home = loadPage('home', rec.wx);
  home.onAskInput({ detail: { value: '先写一半' } });
  home.useSuggestion({ currentTarget: { dataset: {} } });
  assert.equal(home.data.askText, '先写一半');
});

test('首页问 AI：语音如实说明未接入，拍照走导入页既有的截图识别', () => {
  const rec = recorder();
  const home = loadPage('home', rec.wx);

  home.openVoiceAsk();
  assert.deepEqual(rec.toasts, ['语音输入暂未接入，先打字或拍照吧'], '不假装做了录音转写');
  assert.deepEqual(rec.visited, [], '语音没接入就不跳页');

  home.openPhotoAsk();
  assert.deepEqual(rec.visited, ['/pages/timetable/import/index'], '拍照复用导入页的 vision 链路');
});

test('首页问 AI：发送后课表页不要自己发请求（只填不发）', () => {
  // 首页只负责把文字带过去；真正调用模型在课表页，且要等学生自己点发送。
  const source = fs.readFileSync('dist/pages/home/index.js', 'utf8');
  assert.ok(source.includes('?ask='), '首页拼出 ?ask=');
  assert.equal(
    source.includes('callFunction') || source.includes('callAi'),
    false,
    '首页输入条不自己调云函数',
  );
});
