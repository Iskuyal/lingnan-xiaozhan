/** 在任何待测页面启动前接管请求与存储。函数可序列化给 mini.evaluate。 */
function installOfflineUiSession() {
  if (globalThis.__offlineUiSession) return;
  const storage = new Map();
  const original = { get: wx.getStorageSync, set: wx.setStorageSync, remove: wx.removeStorageSync,
    clipboard: wx.setClipboardData, call: wx.cloud.callFunction, database: wx.cloud.database,
    upload: wx.cloud.uploadFile, request: wx.request };
  globalThis.__offlineUiSession = { original, blockedCalls: [] };
  wx.getStorageSync = (key) => storage.get(key) ?? '';
  wx.setStorageSync = (key, value) => { storage.set(key, value); };
  wx.removeStorageSync = (key) => { storage.delete(key); };
  wx.setClipboardData = (options) => { options.success?.({ errMsg: 'setClipboardData:ok' }); };
  wx.cloud.callFunction = (options) => {
    globalThis.__offlineUiSession.blockedCalls.push({ name: options.name, action: options.data?.action });
    return Promise.reject(new Error('离线验证：该请求未配置夹具'));
  };
  wx.cloud.database = () => { throw new Error('离线验证：数据库未配置夹具'); };
  wx.cloud.uploadFile = () => { throw new Error('离线验证：上传未配置夹具'); };
  wx.request = () => { throw new Error('离线验证：禁止网络请求'); };
}

function restoreOfflineUiSession() {
  const session = globalThis.__offlineUiSession;
  if (!session) return;
  const original = session.original;
  wx.getStorageSync = original.get;
  wx.setStorageSync = original.set;
  wx.removeStorageSync = original.remove;
  wx.setClipboardData = original.clipboard;
  wx.cloud.callFunction = original.call;
  wx.cloud.database = original.database;
  wx.cloud.uploadFile = original.upload;
  wx.request = original.request;
  delete globalThis.__offlineUiSession;
}

module.exports = { installOfflineUiSession, restoreOfflineUiSession };
