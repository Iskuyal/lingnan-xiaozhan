import { school } from '../../services/school';

Page({
  data: { school },
  openDepartments() {
    wx.navigateTo({ url: '/pages/departments/index' });
  },
  openTimetable() {
    wx.navigateTo({ url: '/pages/timetable/index' });
  },
  copySource() {
    wx.setClipboardData({
      data: school.sourceUrl,
      success: () => wx.showToast({ title: '官网链接已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }),
    });
  },
});
