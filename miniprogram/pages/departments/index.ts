import { buildDepartmentList } from '../../services/departments';

Page({
  data: { view: buildDepartmentList() },
  openDetail(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id.length === 0) return;
    wx.navigateTo({ url: `/pages/departments/detail/index?id=${id}` });
  },
  goHome() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/home/index' });
  },
});
