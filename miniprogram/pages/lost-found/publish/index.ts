/**
 * 失物招领发布向导(设计图 03/04)。
 *
 * 图片上传在原型阶段(C 方案)先不接云存储:表单保留 images 字段但固定为空数组,
 * 发布仍可用;内容安全与联系方式拦截由云函数校验执行。
 */
import { POST_CATEGORIES, createPost, transportMessage, userMessage } from '../../../services/lost-found/index';
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

  onLoad() {
    this.setData({ timeStart: this.data.today, timeEnd: this.data.today });
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

  submit() {
    const data = this.data;
    if (data.submitting) return;
    if (data.title.trim() === '' || data.description.trim() === '') {
      this.setData({ error: '请填写标题与公开描述' });
      return;
    }
    if (!data.agree) {
      this.setData({ error: '请先同意图片与文字的使用授权' });
      return;
    }
    this.setData({ submitting: true, error: '' });
    return createPost({
      type: data.type,
      category: data.category === '' ? '其他' : data.category,
      title: data.title.trim(),
      description: data.description.trim(),
      timeRange: { start: data.timeStart, end: data.timeEnd },
      locationArea: data.locationArea.trim(),
      images: [],
      verificationTraits: data.verificationTraits.trim(),
      agree: data.agree,
    })
      .then((result) => {
        this.setData({ submitting: false });
        if (!result.ok) {
          this.setData({ error: userMessage(result) });
          return;
        }
        const postId = result.data.postId;
        if (typeof postId !== 'string') return;
        wx.redirectTo({ url: `/pages/lost-found/detail/index?id=${encodeURIComponent(postId)}` });
      })
      .catch((error) => {
        this.setData({ submitting: false, error: transportMessage(error) });
      });
  },
});
