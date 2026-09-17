import { getNewsDetail, formatSyncTime, messageOf } from '../../../services/news/index';
import { NewsSourceMeta } from '../../../services/news/types';

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

type Status = 'loading' | 'ready' | 'missing' | 'error';

const SOURCE_LABEL = '学校官网 · 校园动态';

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
    status: 'loading' as Status,
    id: '',
    article: null as ArticleView | null,
    source: { label: SOURCE_LABEL, syncedAt: '', fromServer: true } as NewsSourceMeta,
    syncedAtText: '',
    errorMessage: '',
  },
  onLoad(options: { id?: string }) {
    return this.load(decodeId(options === undefined ? undefined : options.id));
  },
  /** 读取云端已同步的单篇文章。空 id 视为缺失；读取失败显示可重试的错误状态。 */
  load(id: string) {
    this.setData({ id, status: 'loading', errorMessage: '' });
    if (id === '') {
      this.setData({ status: 'missing', article: null });
      return Promise.resolve();
    }
    return getNewsDetail(id)
      .then((found) => {
        if (found === null) {
          this.setData({ status: 'missing', article: null });
          return;
        }
        const article = found.article;
        this.setData({
          status: 'ready',
          source: found.meta,
          syncedAtText: formatSyncTime(found.meta.syncedAt),
          article: {
            id: article.id,
            title: article.title,
            url: article.url,
            date: article.date,
            paragraphs: article.paragraphs.map((text, index) => ({ index, text })),
          },
        });
      })
      .catch((error) => {
        this.setData({ status: 'error', errorMessage: messageOf(error) });
      });
  },
  retry() {
    return this.load(this.data.id);
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
