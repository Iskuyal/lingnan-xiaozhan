/**
 * 失物招领首页:丢失/拾获切换、类别筛选、公开列表(设计图 01/02)。
 */
import {
  POST_CATEGORIES,
  listPosts,
  postsOf,
  transportMessage,
  userMessage,
} from '../../services/lost-found/index';
import { PostType, PostView } from '../../services/lost-found/types';

interface DatasetEvent {
  currentTarget: { dataset: { type?: string; category?: string; id?: string } };
}

Page({
  data: {
    activeType: 'found' as PostType,
    activeCategory: '',
    categories: ['全部类别' as string].concat([...POST_CATEGORIES]),
    posts: [] as PostView[],
    loading: false,
    error: '',
  },

  onLoad() {
    this.loadList();
  },

  loadList() {
    this.setData({ loading: true, error: '' });
    return listPosts({
      type: this.data.activeType,
      category: this.data.activeCategory === '全部类别' ? undefined : this.data.activeCategory,
      page: 0,
      pageSize: 20,
    })
      .then((result) => {
        if (!result.ok) {
          this.setData({ loading: false, error: userMessage(result), posts: [] });
          return;
        }
        this.setData({ loading: false, posts: postsOf(result) });
      })
      .catch((error) => {
        this.setData({ loading: false, error: transportMessage(error), posts: [] });
      });
  },

  switchType(event: DatasetEvent) {
    const type = event.currentTarget.dataset.type;
    if (type !== 'lost' && type !== 'found') return;
    this.setData({ activeType: type, activeCategory: '全部类别' });
    this.loadList();
  },

  pickCategory(event: DatasetEvent) {
    const category = event.currentTarget.dataset.category;
    if (typeof category !== 'string') return;
    this.setData({ activeCategory: category });
    this.loadList();
  },

  retry() {
    this.loadList();
  },

  openDetail(event: DatasetEvent) {
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || id === '') return;
    wx.navigateTo({ url: `/pages/lost-found/detail/index?id=${encodeURIComponent(id)}` });
  },

  goPublish() {
    wx.navigateTo({ url: '/pages/lost-found/publish/index' });
  },

  goMine() {
    wx.navigateTo({ url: '/pages/lost-found/mine/index' });
  },
});
