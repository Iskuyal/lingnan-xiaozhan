import { school } from '../../services/school';

/** 校园聚合页（设计图 19）：学校资料与三个既有入口。 */
interface TapEvent {
  currentTarget: { dataset: { route?: string } };
}

Page({
  data: {
    school,
  },
  openRoute(event: TapEvent) {
    const route = event.currentTarget.dataset.route;
    if (typeof route !== 'string' || route === '') return;
    wx.navigateTo({ url: route });
  },
  copySource() {
    wx.setClipboardData({
      data: school.sourceUrl,
      success: () => wx.showToast({ title: '官网链接已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }),
    });
  },
});
