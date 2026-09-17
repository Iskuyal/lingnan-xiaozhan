import {
  buildDepartmentDetail,
  NOT_FOUND_COPY,
  NOT_FOUND_TITLE,
  type DepartmentDetailView,
} from '../../../services/departments';

Page({
  data: {
    detail: null as DepartmentDetailView | null,
    notFound: false,
    notFoundTitle: NOT_FOUND_TITLE,
    notFoundCopy: NOT_FOUND_COPY,
  },
  onLoad(query: Record<string, string | undefined> | undefined) {
    const detail = buildDepartmentDetail(query ? query.id : undefined);
    this.setData({ detail, notFound: detail === null });
  },
  goBackToList() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/departments/index' });
  },
  copySource() {
    const detail = this.data.detail;
    if (!detail) return;
    wx.setClipboardData({
      data: detail.sourceUrl,
      success: () => wx.showToast({ title: '来源链接已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }),
    });
  },
});
