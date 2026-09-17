/**
 * 官网资讯解析（纯函数，将来运行在服务端云函数里）。
 *
 * 该模块只接收 HTML 字符串、返回普通对象：不调用 wx.*、不访问网络、不读写存储，
 * 因此可以直接在 Node 测试中执行，也可以在云函数（Node.js 运行时）里复用。
 * 客户端页面不依赖本模块——正文在入库前完成解析，见 services/news/index.ts。
 *
 * 页面结构依据与实测样本见 docs/news-sources.md；选择器只覆盖已实测特征，
 * 匹配失败时返回空值而不是抛出异常（缺日期、缺正文、缺列表都不应让整次抓取失败）。
 */
import { NewsArticle, NewsListItem } from './types';

/** 块级标签结束位置按换行处理，避免整篇正文被压成一行。 */
const BLOCK_END_TAGS = [
  'p', 'div', 'li', 'ul', 'ol', 'dl', 'dd', 'dt', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'tr', 'td', 'th', 'section', 'article', 'blockquote', 'figure', 'figcaption',
];
const BLOCK_END_PATTERN = new RegExp('</(?:' + BLOCK_END_TAGS.join('|') + ')>', 'gi');
/** 需要连同内容一起丢弃的标签：脚本与样式不是正文。 */
const DROPPED_TAGS = ['script', 'style', 'noscript'];
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", middot: '·',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–',
};

/** 去掉 HTML 注释，避免注释里的片段被当成正文或列表容器。 */
export function removeHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/** 解码常见 HTML 实体（命名实体与十进制/十六进制数字实体）。 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const value = NAMED_ENTITIES[entity.toLowerCase()];
    return value === undefined ? match : value;
  });
}

function dropTagBlocks(html: string): string {
  let text = html;
  for (const tag of DROPPED_TAGS) {
    text = text.replace(new RegExp('<' + tag + '[^>]*>[\\s\\S]*?<\\/' + tag + '>', 'gi'), ' ');
  }
  return text;
}

/** 剥离标签、脚本与实体，保留块级换行。 */
export function stripHtml(html: string): string {
  let text = dropTagBlocks(removeHtmlComments(html));
  text = text.replace(/<br[^>]*>/gi, '\n').replace(BLOCK_END_PATTERN, '\n');
  text = text.replace(/<[^>]*>/g, ' ');
  return decodeEntities(text);
}

/** HTML 片段 → 去除空白噪声的文本行。 */
export function toLines(html: string): string[] {
  return stripHtml(html)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '');
}

/** 正文：把 HTML 片段切成段落数组（无内容时返回空数组）。 */
export function toParagraphs(html: string): string[] {
  return toLines(html);
}

/** HTML 片段 → 单行文本，用于标题一类字段。 */
export function toSingleLine(html: string): string {
  return toLines(html).join(' ');
}

/** 相对链接转绝对链接；无法解析（javascript:、空值）时返回空字符串。 */
export function toAbsoluteUrl(href: string, baseUrl: string): string {
  const value = href.trim();
  if (value === '' || value.startsWith('#') || /^javascript:/i.test(value)) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('//')) return `https:${value}`;
  const origin = /^(https?:\/\/[^/]+)/i.exec(baseUrl);
  if (value.startsWith('/')) return origin === null ? value : `${origin[1]}${value}`;
  const base = baseUrl.split('#')[0].split('?')[0];
  const directory = base.slice(0, base.lastIndexOf('/') + 1);
  return directory === '' ? value : `${directory}${value}`;
}

/** 原文 URL → 条目 ID（URL 最后一段路径）。 */
export function newsIdFromUrl(url: string): string {
  const clean = url.split('#')[0].split('?')[0].replace(/\/+$/, '');
  const segments = clean.split('/');
  return segments.length === 0 ? '' : segments[segments.length - 1];
}

/** 日期文本 → YYYY-MM-DD；无法识别时返回空字符串。 */
export function normalizeDate(raw: string): string {
  const match = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(raw);
  if (match === null) return '';
  const pad = (value: string) => value.padStart(2, '0');
  return `${match[1]}-${pad(match[2])}-${pad(match[3])}`;
}

/** 按原文 URL 去重，保留首次出现的条目与原有顺序；缺少 URL 的条目被丢弃。 */
export function dedupeByUrl(items: NewsListItem[]): NewsListItem[] {
  const seen = new Set<string>();
  const result: NewsListItem[] = [];
  for (const item of items) {
    const key = item.url.trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function readAttribute(tag: string, name: string): string {
  const match = new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i').exec(tag);
  if (match === null) return '';
  return match[2] === undefined ? match[3] ?? '' : match[2];
}

/** 定位列表容器（<ul class="list list-intro">）内部片段；找不到返回空字符串。 */
function findListContainer(html: string): string {
  const open = /<ul[^>]*class="[^"]*list-intro[^"]*"[^>]*>/i.exec(html);
  if (open === null) return '';
  const start = open.index + open[0].length;
  const end = html.indexOf('</ul>', start);
  return end === -1 ? html.slice(start) : html.slice(start, end);
}

function parseListItem(block: string, baseUrl: string): NewsListItem | null {
  const anchor = /<a[^>]*class="[^"]*tit[^"]*"[^>]*>/i.exec(block);
  if (anchor === null) return null;
  const url = toAbsoluteUrl(readAttribute(anchor[0], 'href'), baseUrl);
  if (url === '') return null;
  const rest = block.slice(anchor.index + anchor[0].length);
  const closing = rest.indexOf('</a>');
  const innerHtml = closing === -1 ? rest : rest.slice(0, closing);
  const attributeTitle = toSingleLine(readAttribute(anchor[0], 'title'));
  const title = attributeTitle === '' ? toSingleLine(innerHtml) : attributeTitle;
  const dateMatch = /<span[^>]*class="[^"]*date[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block);
  return {
    id: newsIdFromUrl(url),
    title,
    url,
    date: dateMatch === null ? '' : normalizeDate(toSingleLine(dateMatch[1])),
  };
}

/**
 * 列表页 HTML → 条目数组。
 *
 * 只解析 <ul class="list list-intro"> 内的条目：官网顶部导航同样使用 <a class="tit">，
 * 甚至包含形如 content_17924 的链接，全局匹配会把「学院章程」等误当成资讯。
 */
export function parseNewsList(html: string, baseUrl: string): NewsListItem[] {
  const container = findListContainer(removeHtmlComments(html));
  if (container === '') return [];
  const items: NewsListItem[] = [];
  for (const block of container.split(/<li/i).slice(1)) {
    const item = parseListItem(block, baseUrl);
    if (item !== null && item.title !== '') items.push(item);
  }
  return dedupeByUrl(items);
}

/** 文章标题：优先 h1.class="title"，回退到 <title> 去掉站点后缀。 */
function parseArticleTitle(html: string): string {
  const heading = /<h1[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (heading !== null) {
    const inner = heading[1];
    const subTitle = inner.search(/<div[^>]*class="[^"]*sub-title/i);
    const title = toSingleLine(subTitle === -1 ? inner : inner.slice(0, subTitle));
    if (title !== '') return title;
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleTag === null) return '';
  // 官网 <title> 形如「标题_校园动态_学院新闻_广东岭南职业技术学院」，截掉后 3 段站点信息。
  const parts = toSingleLine(titleTag[1]).split('_');
  return parts.length >= 4 ? parts.slice(0, parts.length - 3).join('_') : parts.join('_');
}

/** 文章日期：优先正文头部「发布时间」，回退到 <meta name="PubDate">。 */
function parseArticleDate(html: string): string {
  const published = /发布时间\s*[:：]\s*([^<]{4,40})/.exec(html);
  if (published !== null) {
    const date = normalizeDate(published[1]);
    if (date !== '') return date;
  }
  const meta = /<meta[^>]*name\s*=\s*"PubDate"[^>]*content\s*=\s*"([^"]*)"/i.exec(html);
  return meta === null ? '' : normalizeDate(meta[1]);
}

/**
 * 文章正文：<div class="article-content"> 到 <div class="article-fd">（或 </article>）之间。
 * 右边界必须用 article-fd / </article>：页面的正文结束注释在 </article> 之后、
 * 包含分享脚本，不能作为正文结束位置。
 */
function parseArticleParagraphs(html: string): string[] {
  const open = /<div[^>]*class="[^"]*article-content[^"]*"[^>]*>/i.exec(html);
  if (open === null) return [];
  const rest = html.slice(open.index + open[0].length);
  const boundary = /<div[^>]*class="[^"]*article-fd[^"]*"[^>]*>|<\/article>/i.exec(rest);
  return toParagraphs(boundary === null ? rest : rest.slice(0, boundary.index));
}

/** 文章页 HTML → 标题、日期、正文；字段缺失时返回空字符串或空数组。 */
export function parseNewsArticle(html: string, url: string): NewsArticle {
  const clean = removeHtmlComments(html);
  return {
    id: newsIdFromUrl(url),
    url,
    title: parseArticleTitle(clean),
    date: parseArticleDate(clean),
    paragraphs: parseArticleParagraphs(clean),
  };
}
