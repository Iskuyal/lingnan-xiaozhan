import { newsService } from '../../services/news';
import { NewsListItem } from '../../services/news/types';

/** 只声明页面用到的事件字段，避免依赖 typings 内部结构。 */
interface TapEvent {
  currentTarget: { dataset: { id?: string } };
}

Page({
  data: {
    items: [] as NewsListItem[],
    empty: false,
    source: newsService.meta,
  },
  onLoad() {
    const items = newsService.listNews();
    this.setData({ items, empty: items.length === 0 });
  },
  openDetail(event: TapEvent) {
    const id = event.currentTarget.dataset.id;
    if (id === undefined || id === '') return;
    wx.navigateTo({ url: `/pages/news/detail/index?id=${encodeURIComponent(id)}` });
  },
  goHome() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/home/index' });
  },
});
