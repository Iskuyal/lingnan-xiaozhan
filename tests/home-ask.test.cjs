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
  // 课表 tab 的跳转经 ui/navigation 完成，它读平台全局 wx；与页面用同一份 mock。
  globalThis.wx = wx;
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

/**
 * 记录每一次跳转、写入的意图与每一句 toast：输入条的行为全部体现在这三个通道里。
 * 课表是 tab（switchTab 不接受 query），问题由 ui/navigation 的一次性意图带过去。
 */
function recorder(options = {}) {
  const visited = [];
  const toasts = [];
  const storage = new Map();
  return {
    visited,
    toasts,
    storage,
    wx: {
      navigateTo: ({ url }) => visited.push(url),
      switchTab: ({ url, success, fail }) => {
        visited.push(url);
        (options.failSwitchTab ? fail : success)?.();
      },
      getStorageSync: (key) => (storage.has(key) ? storage.get(key) : ''),
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: (key) => storage.delete(key),
      showToast: ({ title }) => toasts.push(title),
    },
  };
}

/** 课表页真正会用的读法：同一个 key 上那张一次性纸条。 */
function intentOf(storage) {
  const row = storage.get('lingnan/ui-timetable-intent/v1');
  return row === undefined ? null : row.intent;
}

test('首页问 AI：发送把问题转义后带进课表页，居中空白与超长都先清掉', () => {
  const rec = recorder();
  const home = loadPage('home', rec.wx);
  const question = '这周三第几节有课？';
  home.onAskInput({ detail: { value: `  ${question}  ` } });
  home.sendAsk();

  assert.deepEqual(rec.visited, ['/pages/timetable/index'], '只切一次课表 tab');
  // 问题原样交给课表页：不清掉「？」也不做二次转义。
  assert.deepEqual(intentOf(rec.storage), { kind: 'assistant', text: question });
  assert.deepEqual(rec.toasts, [], '成功发送不弹提示');

  // 超长粘贴不能整段塞进意图：按 500 字截断（与 ASK_MAX_CHARS 一致）。
  const long = '课'.repeat(600);
  rec.storage.clear();
  rec.visited.length = 0;
  home.onAskInput({ detail: { value: long } });
  home.sendAsk();
  assert.equal(intentOf(rec.storage).text.length, 500);
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
  assert.ok(source.includes('ui/navigation'), '首页经共享导航桥写意图');
  assert.ok(source.includes('kind: \'assistant\'') || source.includes("kind: 'assistant'"), '带的是助手意图');
  assert.equal(
    source.includes('callFunction') || source.includes('callAi'),
    false,
    '首页输入条不自己调云函数',
  );
});

test('首页问 AI：课表 tab 打不开时提示一句，不改已写好的问题', async () => {
  const rec = recorder({ failSwitchTab: true });
  const home = loadPage('home', rec.wx);
  home.onAskInput({ detail: { value: '这周三第几节有课？' } });
  await home.sendAsk();
  await home.sendAsk(); // 失败后重试仍然从输入框原文出发
  assert.deepEqual(rec.toasts, ['课表页暂时打不开，稍后再试', '课表页暂时打不开，稍后再试']);
  assert.equal(home.data.askText, '这周三第几节有课？', '路由失败不吞掉学生写的话');
  assert.equal(rec.storage.size, 0, '失败的跳转把纸条也收回去了');
});