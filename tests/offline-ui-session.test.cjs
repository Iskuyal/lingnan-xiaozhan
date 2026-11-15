const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { installOfflineUiSession, restoreOfflineUiSession } = require('../scripts/lib/offline-ui-session.cjs');

test('离线截图会话在页面启动前阻止真实请求，种子和剪贴板不触碰原数据，退出恢复平台方法', async () => {
  const data = new Map([['goal-days/v1', 'user-data'], ['study-plan/v1', 'user-plan']]);
  let realCalls = 0;
  const real = () => { realCalls += 1; throw new Error('不能调用真实接口'); };
  const wx = { getStorageSync: (key) => data.get(key), setStorageSync: (key, val) => data.set(key, val),
    removeStorageSync: (key) => data.delete(key), setClipboardData: real, request: real,
    cloud: { callFunction: real, database: real, uploadFile: real } };
  const originalCall = wx.cloud.callFunction;
  const context = vm.createContext({ wx });
  vm.runInContext(`(${installOfflineUiSession.toString()})()`, context);
  wx.setStorageSync('goal-days/v1', 'fixture');
  wx.removeStorageSync('study-plan/v1');
  wx.setClipboardData({ data: 'fixture' });
  await assert.rejects(() => wx.cloud.callFunction({ name: 'ai', data: { action: 'chat' } }), /离线验证/);
  assert.equal(realCalls, 0);
  assert.equal(data.get('goal-days/v1'), 'user-data');
  assert.equal(data.get('study-plan/v1'), 'user-plan');
  vm.runInContext(`(${restoreOfflineUiSession.toString()})()`, context);
  assert.equal(wx.cloud.callFunction, originalCall);
  assert.equal(wx.getStorageSync('goal-days/v1'), 'user-data');
});
