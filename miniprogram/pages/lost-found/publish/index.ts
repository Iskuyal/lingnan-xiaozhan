/**
 * 失物招领发布向导(设计图 03/04)。
 *
 * 图片上传在原型阶段(C 方案)先不接云存储:表单保留 images 字段但固定为空数组,
 * 发布仍可用;内容安全与联系方式拦截由云函数校验执行。
 */
import {
  POST_CATEGORIES,
  createPost,
  getPost,
  postOf,
  transportMessage,
  updatePost,
  userMessage,
} from '../../../services/lost-found/index';
import { PostType } from '../../../services/lost-found/types';

interface DatasetEvent {
  currentTarget: { dataset: { type?: string; category?: string } };
}

interface InputEvent {
  detail: { value?: unknown };
}

function todayString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

Page({
  data: {
    editPostId: '',
    editVersion: 0,
    editIsDraft: false,
    type: 'found' as PostType,
    categories: [...POST_CATEGORIES],
    category: '',
    title: '',
    description: '',
    timeStart: '',
    timeEnd: '',
    today: todayString(),
    locationArea: '',
    verificationTraits: '',
    agree: false,
    submitting: false,
    error: '',
  },

  onLoad(options: Record<string, string | undefined>) {
    this.setData({ timeStart: this.data.today, timeEnd: this.data.today });
    const postId = options.postId;
    if (typeof postId === 'string' && postId !== '') {
      this.setData({ editPostId: postId });
      this.loadForEdit(postId);
    }
  },

  /** 编辑模式:预填本人帖子(公开字段;核验特征不回填,避免页面滞留私密原文)。 */
  loadForEdit(postId: string) {
    return getPost(postId)
      .then((result) => {
        if (!result.ok) {
          this.setData({ error: userMessage(result) });
          return;
        }
        const post = postOf(result);
        if (post === null || post.isOwner !== true) {
          this.setData({ error: '只能编辑自己的帖子' });
          return;
        }
        this.setData({
          type: post.type,
          category: post.category,
          title: post.title,
          description: post.description,
          timeStart: post.timeRange.start,
          timeEnd: post.timeRange.end,
          locationArea: post.locationArea,
          editVersion: post.version,
          editIsDraft: post.status === 'draft',
        });
      })
      .catch((error) => this.setData({ error: transportMessage(error) }));
  },

  switchType(event: DatasetEvent) {
    const type = event.currentTarget.dataset.type;
    if (type !== 'lost' && type !== 'found') return;
    this.setData({ type });
  },

  pickCategory(event: DatasetEvent) {
    const category = event.currentTarget.dataset.category;
    if (typeof category !== 'string') return;
    this.setData({ category: category === this.data.category ? '' : category });
  },

  onTitle(event: InputEvent) {
    this.setData({ title: typeof event.detail.value === 'string' ? event.detail.value : '' });
  },

  onDescription(event: InputEvent) {
    this.setData({ description: typeof event.detail.value === 'string' ? event.detail.value : '' });
  },

  onLocation(event: InputEvent) {
    this.setData({ locationArea: typeof event.detail.value === 'string' ? event.detail.value : '' });
  },

  onTraits(event: InputEvent) {
    this.setData({ verificationTraits: typeof event.detail.value === 'string' ? event.detail.value : '' });
  },

  onTimeStart(event: InputEvent) {
    this.setData({ timeStart: typeof event.detail.value === 'string' ? event.detail.value : '' });
  },

  onTimeEnd(event: InputEvent) {
    this.setData({ timeEnd: typeof event.detail.value === 'string' ? event.detail.value : '' });
  },

  onAgree() {
    this.setData({ agree: !this.data.agree });
  },

  /** 表单最小校验(服务端仍会全量校验)。 */
  formReady(): boolean {
    const data = this.data;
    if (data.title.trim() === '' || data.description.trim() === '') {
      this.setData({ error: '请填写标题与公开描述' });
      return false;
    }
    if (!data.agree) {
      this.setData({ error: '请先同意图片与文字的使用授权' });
      return false;
    }
    return true;
  },

  /** 发布(新建发布或草稿转发布)。 */
  submit() {
    if (this.data.submitting || !this.formReady()) return;
    this.setData({ submitting: true, error: '' });
    const payload = {
      type: this.data.type,
      category: this.data.category === '' ? '其他' : this.data.category,
      title: this.data.title.trim(),
      description: this.data.description.trim(),
      timeRange: { start: this.data.timeStart, end: this.data.timeEnd },
      locationArea: this.data.locationArea.trim(),
      images: [] as string[],
      verificationTraits: this.data.verificationTraits.trim(),
      agree: this.data.agree,
    };
    const request = this.data.editPostId === ''
      ? createPost({ ...payload, status: 'open' })
      : updatePost(this.data.editPostId, {
        title: payload.title,
        description: payload.description,
        timeRange: payload.timeRange,
        locationArea: payload.locationArea,
        version: this.data.editVersion,
        status: this.data.editIsDraft ? 'open' : undefined,
      });
    return request
      .then((result) => {
        this.setData({ submitting: false });
        if (!result.ok) {
          this.setData({ error: userMessage(result) });
          return;
        }
        const postId = this.data.editPostId === '' ? result.data.postId : this.data.editPostId;
        if (typeof postId !== 'string') return;
        wx.redirectTo({ url: `/pages/lost-found/detail/index?id=${encodeURIComponent(postId)}` });
      })
      .catch((error) => {
        this.setData({ submitting: false, error: transportMessage(error) });
      });
  },

  /** 存草稿:新建存 draft;编辑模式直接保存(不发布)。 */
  saveDraft() {
    if (this.data.submitting) return;
    if (this.data.title.trim() === '' && this.data.description.trim() === '') {
      this.setData({ error: '写点内容再存草稿吧' });
      return;
    }
    this.setData({ submitting: true, error: '' });
    const payload = {
      type: this.data.type,
      category: this.data.category === '' ? '其他' : this.data.category,
      title: this.data.title.trim(),
      description: this.data.description.trim(),
      timeRange: { start: this.data.timeStart, end: this.data.timeEnd },
      locationArea: this.data.locationArea.trim(),
      images: [] as string[],
      verificationTraits: this.data.verificationTraits.trim(),
      agree: this.data.agree,
    };
    const request = this.data.editPostId === ''
      ? createPost({ ...payload, status: 'draft' })
      : updatePost(this.data.editPostId, {
        title: payload.title,
        description: payload.description,
        timeRange: payload.timeRange,
        locationArea: payload.locationArea,
        version: this.data.editVersion,
      });
    return request
      .then((result) => {
        this.setData({ submitting: false });
        if (!result.ok) {
          this.setData({ error: userMessage(result) });
          return;
        }
        wx.showToast({ title: '草稿已保存', icon: 'success' });
        if (this.data.editPostId === '' && typeof result.data.postId === 'string') {
          this.setData({ editPostId: result.data.postId });
        }
      })
      .catch((error) => {
        this.setData({ submitting: false, error: transportMessage(error) });
      });
  },
});
