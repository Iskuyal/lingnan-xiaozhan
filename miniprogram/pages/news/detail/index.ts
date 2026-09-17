import { newsService } from '../../../services/news';

/** 正文按段落渲染，带上序号作为 wx:key，避免重复段落触发列表警告。 */
interface BodyParagraph {
  index: number;
  text: string;
}

interface ArticleView {
  id: string;
  title: string;
  url: string;
  date: string;
  paragraphs: BodyParagraph[];
}

function decodeId(raw: string | undefined): string {
  if (raw === undefined || raw === '') return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

Page({
  data: {
    status: 'missing' as 'ready' | 'missing',
    article: null as ArticleView | null,
    source: newsService.meta,
  },
  onLoad(options: { id?: string }) {
    const id = decodeId(options === undefined ? undefined : options.id);
    const article = id === '' ? null : newsService.getNewsDetail(id);
    if (article === null) {
      this.setData({ status: 'missing', article: null });
      return;
    }
    this.setData({
      status: 'ready',
      article: {
        id: article.id,
        title: article.title,
        url: article.url,
        date: article.date,
        paragraphs: article.paragraphs.map((text, index) => ({ index, text })),
      },
    });
  },
  copySource() {
    const article = this.data.article;
    if (article === null) return;
    wx.setClipboardData({
      data: article.url,
      success: () => wx.showToast({ title: '原文链接已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }),
    });
  },
  goHome() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/home/index' });
  },
});
