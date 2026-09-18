/**
 * 小程序入口：云开发初始化。
 *
 * 环境 ID 不是密钥，直接写在代码里（见 docs/cloud-development.md）。
 * 初始化失败时不静默——资讯数据来自云端，需要能在页面上如实反映不可用状态。
 */
App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('当前基础库不支持云开发，请确认基础库版本满足云开发要求');
      return;
    }
    wx.cloud.init({
      env: 'cloudbase-d2gjtbbwu3575cd7b',
      traceUser: true,
    });
  },
});
