/**
 * 失物招领帖子详情(设计图 05/06/07/08):公开信息、本人视角(私密特征/关闭/删除/候选)、
 * 他人视角(认领入口)。候选列表为规则召回(未经 AI 比对,如实标注)。
 */
import {
  closePost,
  deletePost,
  getPost,
  listMatches,
  matchesOf,
  postOf,
  transportMessage,
  userMessage,
  POST_STATUS_LABEL,
  POST_TYPE_LABEL,
} from '../../../services/lost-found/index';
import { MatchView, PostView } from '../../../services/lost-found/types';

interface DatasetEvent {
  currentTarget: { dataset: { id?: string; matchId?: string } };
}

Page({
  data: {
    postId: '',
    post: null as PostView | null,
    matches: [] as MatchView[],
    matchesError: '',
    loading: true,
    error: '',
    statusLabel: '',
    typeLabel: '',
  },

  onLoad(options: Record<string, string | undefined>) {
    const id = options.id;
    if (typeof id !== 'string' || id === '') {
      this.setData({ loading: false, error: '缺少帖子编号' });
      return;
    }
    this.setData({ postId: id });
    this.refresh();
  },

  refresh() {
    this.setData({ loading: true, error: '' });
    return getPost(this.data.postId)
      .then((result) => {
        if (!result.ok) {
          this.setData({ loading: false, error: userMessage(result) });
          return;
        }
        const post = postOf(result);
        this.setData({
          loading: false,
          post,
          statusLabel: post === null ? '' : (POST_STATUS_LABEL[post.status] ?? post.status),
          typeLabel: post === null ? '' : POST_TYPE_LABEL[post.type],
        });
        if (post !== null && post.isOwner === true && (post.status === 'open' || post.status === 'verifying' || post.status === 'matching')) {
          this.loadMatches();
        }
      })
      .catch((error) => {
        this.setData({ loading: false, error: transportMessage(error) });
      });
  },

  loadMatches() {
    this.setData({ matchesError: '' });
    return listMatches(this.data.postId)
      .then((result) => {
        if (!result.ok) {
          this.setData({ matchesError: userMessage(result) });
          return;
        }
        this.setData({ matches: matchesOf(result) });
      })
      .catch((error) => {
        this.setData({ matchesError: transportMessage(error) });
      });
  },

  goClaim() {
    wx.navigateTo({ url: `/pages/lost-found/claim/index?postId=${encodeURIComponent(this.data.postId)}` });
  },

  goPublishEdit() {
    const post = this.data.post;
    if (post === null) return;
    wx.navigateTo({ url: `/pages/lost-found/publish/index?postId=${encodeURIComponent(post.postId)}` });
  },

  closeCurrent() {
    const post = this.data.post;
    if (post === null) return;
    wx.showModal({
      title: '关闭帖子',
      content: '关闭后将不再接受认领与匹配。是否关闭？',
      confirmText: '关闭',
      success: (res) => {
        if (!res.confirm) return;
        closePost(post.postId, '发布者主动关闭')
          .then((result) => {
            if (!result.ok) {
              wx.showToast({ title: userMessage(result), icon: 'none' });
              return;
            }
            wx.showToast({ title: '已关闭', icon: 'success' });
            this.refresh();
          })
          .catch((error) => wx.showToast({ title: transportMessage(error), icon: 'none' }));
      },
    });
  },

  deleteCurrent() {
    const post = this.data.post;
    if (post === null) return;
    wx.showModal({
      title: '删除帖子',
      content: '删除后其他人将无法查看。是否删除？',
      confirmText: '删除',
      success: (res) => {
        if (!res.confirm) return;
        deletePost(post.postId)
          .then((result) => {
            if (!result.ok) {
              wx.showToast({ title: userMessage(result), icon: 'none' });
              return;
            }
            wx.showToast({ title: '已删除', icon: 'success' });
            wx.navigateBack();
          })
          .catch((error) => wx.showToast({ title: transportMessage(error), icon: 'none' }));
      },
    });
  },

  openCandidate(event: DatasetEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    wx.navigateTo({ url: `/pages/lost-found/detail/index?id=${encodeURIComponent(id)}` });
  },
});
