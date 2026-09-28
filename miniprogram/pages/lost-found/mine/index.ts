/**
 * 我的失物招领(设计图 11):我的发布列表,按状态展示。
 */
import { getMyPosts, postsOf, transportMessage, userMessage, POST_STATUS_LABEL, POST_TYPE_LABEL } from '../../../services/lost-found/index';
import { PostView } from '../../../services/lost-found/types';

interface DatasetEvent {
  currentTarget: { dataset: { id?: string } };
}

Page({
  data: {
    posts: [] as PostView[],
    loading: true,
    error: '',
    statusLabelOf: POST_STATUS_LABEL,
    typeLabelOf: POST_TYPE_LABEL,
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    this.setData({ loading: true, error: '' });
    return getMyPosts()
      .then((result) => {
        if (!result.ok) {
          this.setData({ loading: false, error: userMessage(result) });
          return;
        }
        this.setData({ loading: false, posts: postsOf(result) });
      })
      .catch((error) => this.setData({ loading: false, error: transportMessage(error) }));
  },

  openDetail(event: DatasetEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    wx.navigateTo({ url: `/pages/lost-found/detail/index?id=${encodeURIComponent(id)}` });
  },

  goPublish() {
    wx.navigateTo({ url: '/pages/lost-found/publish/index' });
  },
});
