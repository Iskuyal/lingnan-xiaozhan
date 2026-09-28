/**
 * 失物招领认领核验页(设计图 09/10/12):认领人提交结构化核验;
 * 发布者视角展示申请列表并处理(通过/需补充/拒绝/确认交接)。
 */
import {
  confirmHandover,
  reviewClaim,
  submitClaim,
  claimsOf,
  getPost,
  listClaimsForPost,
  postOf,
  transportMessage,
  userMessage,
  CLAIM_STATUS_LABEL,
} from '../../../services/lost-found/index';
import { ClaimView, PostView } from '../../../services/lost-found/types';

interface DatasetEvent {
  currentTarget: { dataset: { claimId?: string; toStatus?: string } };
}

interface InputEvent {
  detail: { value?: unknown };
}

Page({
  data: {
    postId: '',
    post: null as PostView | null,
    isOwner: false,
    claims: [] as ClaimView[],
    relation: '',
    evidence: '',
    submitting: false,
    loading: true,
    error: '',
    claimStatusLabel: '',
    actionError: '',
  },

  onLoad(options: Record<string, string | undefined>) {
    const postId = options.postId;
    if (typeof postId !== 'string' || postId === '') {
      this.setData({ loading: false, error: '缺少帖子编号' });
      return;
    }
    this.setData({ postId });
    this.refresh();
  },

  refresh() {
    this.setData({ loading: true, error: '', actionError: '' });
    return getPost(this.data.postId)
      .then((result) => {
        if (!result.ok) {
          this.setData({ loading: false, error: userMessage(result) });
          return;
        }
        const post = postOf(result);
        this.setData({ loading: false, post, isOwner: post !== null && post.isOwner === true });
        if (post !== null && post.isOwner === true) this.loadClaims();
      })
      .catch((error) => this.setData({ loading: false, error: transportMessage(error) }));
  },

  loadClaims() {
    return listClaimsForPost(this.data.postId)
      .then((result) => {
        if (!result.ok) {
          this.setData({ actionError: userMessage(result) });
          return;
        }
        this.setData({ claims: claimsOf(result) });
      })
      .catch((error) => {
        this.setData({ actionError: transportMessage(error) });
      });
  },

  onRelation(event: InputEvent) {
    this.setData({ relation: typeof event.detail.value === 'string' ? event.detail.value : '' });
  },

  onEvidence(event: InputEvent) {
    this.setData({ evidence: typeof event.detail.value === 'string' ? event.detail.value : '' });
  },

  submit() {
    const data = this.data;
    if (data.submitting) return;
    if (data.relation.trim() === '' || data.evidence.trim() === '') {
      this.setData({ actionError: '请填写关系说明与核验信息' });
      return;
    }
    this.setData({ submitting: true, actionError: '' });
    return submitClaim(data.postId, { relation: data.relation.trim(), evidence: data.evidence.trim() })
      .then((result) => {
        this.setData({ submitting: false });
        if (!result.ok) {
          this.setData({ actionError: userMessage(result) });
          return;
        }
        wx.showToast({ title: '申请已提交，等待发布者核验', icon: 'none' });
        this.setData({ relation: '', evidence: '' });
        this.refresh();
      })
      .catch((error) => this.setData({ submitting: false, actionError: transportMessage(error) }));
  },

  review(event: DatasetEvent) {
    const { claimId, toStatus } = event.currentTarget.dataset;
    if (typeof claimId !== 'string' || typeof toStatus !== 'string') return;
    if (toStatus === 'accepted') {
      wx.showModal({
        title: '通过申请',
        content: '通过后进入交接确认，请确认对方信息与你的核验特征相符。',
        confirmText: '通过',
        success: (res) => {
          if (!res.confirm) return;
          this.doReview(claimId, toStatus, '');
        },
      });
      return;
    }
    if (toStatus === 'needs_more_info') {
      this.doReview(claimId, toStatus, '请补充更多未公开的特征信息');
      return;
    }
    this.doReview(claimId, toStatus, '核验信息不符');
  },

  doReview(claimId: string, toStatus: string, note: string) {
    return reviewClaim(claimId, toStatus, note)
      .then((result) => {
        if (!result.ok) {
          wx.showToast({ title: userMessage(result), icon: 'none' });
          return;
        }
        wx.showToast({ title: '已处理', icon: 'success' });
        this.refresh();
      })
      .catch((error) => wx.showToast({ title: transportMessage(error), icon: 'none' }));
  },

  confirm(event: DatasetEvent) {
    const claimId = event.currentTarget.dataset.claimId;
    if (typeof claimId !== 'string') return;
    wx.showModal({
      title: '确认交接',
      content: '请确认已在公共场所完成交接。双方都确认后帖子将结案。',
      confirmText: '确认',
      success: (res) => {
        if (!res.confirm) return;
        confirmHandover(this.data.postId, claimId)
          .then((result) => {
            if (!result.ok) {
              wx.showToast({ title: userMessage(result), icon: 'none' });
              return;
            }
            wx.showToast({ title: '已记录确认', icon: 'success' });
            this.refresh();
          })
          .catch((error) => wx.showToast({ title: transportMessage(error), icon: 'none' }));
      },
    });
  },
});
