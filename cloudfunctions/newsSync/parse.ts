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
import { NewsArticle, NewsListItem, NewsTemplate } from './types';

/** 块级标签结束位置按换行处理，避免整篇正文被压成一行。 */
const BLOCK_END_TAGS = [
  'p', 'div', 'li', 'ul', 'ol', 'dl', 'dd', 'dt', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'tr', 'td', 'th', 'section', 'article', 'blockquote', 'figure', 'figcaption',
];
const BLOCK_END_PATTERN = new RegExp('</(?:' + BLOCK_END_TAGS.join('|') + ')>', 'gi');
/** 需要连同内容一起丢弃的标签：脚本与样式不是正文。 */
const DROPPED_TAGS = ['script', 'style', 'noscript'];
/**
 * 行内标签：站群 CMS 用 <span>/<font> 按字形切分同一段文字（例如把「2026」拆成
 * `<span>202</span><span>6</span>`），它不代表词边界。这类标签直接删除而不替换为空格，
 * 否则正文会写成「202 6 年 9 月 20 日」。实测团委通知公告的文章正文大量依赖这个规则。
 */
const INLINE_TAG_PATTERN = /<\/?(?:span|font)\b[^>]*>/gi;
/**
 * 正文结尾的编辑署名行前缀。官网在正文末尾统一附「供稿/初审/复审/终审」，
 * 实测 4 篇文章都是这 4 行，其中 content_32039 用的是全角分号「复审；黄雅晴」。
 */
const SIGNOFF_PATTERN = /^(?:供稿|初审|复审|终审|编辑|责编|摄影|撰稿|排版)[:：;；]/;
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
  text = text.replace(INLINE_TAG_PATTERN, '');
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

/** 定位列表容器（<ul class="newsList">）内部片段；找不到返回空字符串。 */
function findNewsListContainer(html: string): string {
  const open = /<ul[^>]*class="[^"]*newsList[^"]*"[^>]*>/i.exec(html);
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

/**
 * 通知公告列表条目的 `title` 属性形如「标题：… 点击数：… 发表时间：…」（实测三段用换行分隔）。
 * 返回其中的标题与发表时间：标题取「标题：」之后、「点击数：」或「发表时间：」之前的部分，
 * 没有该前缀时按整串标题处理；发表时间只在 title 属性里精确截取该字段之后再解析日期，
 * 不在整串属性上直接找日期——标题本身可能含年份（实测「关于2025-2026年度…」），
 * 整串匹配会把标题里的数字当成日期。
 */
export function parseAnnouncementAttribute(rawTitle: string): { title: string; date: string } {
  const text = toSingleLine(rawTitle);
  if (text === '') return { title: '', date: '' };
  const match = /^标题\s*[:：]\s*([\s\S]*?)\s*(?:点击数\s*[:：]|发表时间\s*[:：]|$)/.exec(text);
  const title = match === null ? text : match[1].trim();
  const published = /发表时间\s*[:：]\s*([\s\S]*)$/.exec(text);
  return { title, date: published === null ? '' : normalizeDate(published[1]) };
}

function parseAnnouncementListItem(block: string, baseUrl: string): NewsListItem | null {
  // 通知公告的条目 <a> 没有 class（实测无 a.tit），用块内第一个带 href 的锚点。
  const anchor = /<a[^>]*href\s*=\s*(?:"[^"]*"|'[^']*')[^>]*>/i.exec(block);
  if (anchor === null) return null;
  const url = toAbsoluteUrl(readAttribute(anchor[0], 'href'), baseUrl);
  if (url === '') return null;
  const rest = block.slice(anchor.index + anchor[0].length);
  const closing = rest.indexOf('</a>');
  const innerHtml = closing === -1 ? rest : rest.slice(0, closing);
  // title 属性实测与锚文本一致，且额外带点击数等信息，因此优先用属性解析出的标题。
  const attribute = parseAnnouncementAttribute(readAttribute(anchor[0], 'title'));
  const title = attribute.title === '' ? toSingleLine(innerHtml) : attribute.title;
  // 日期先取 li 直挂的 span.date；该节点缺失时退回 title 属性里的「发表时间：」（同一页面的真实字段）。
  const dateMatch = /<span[^>]*class="[^"]*date[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block);
  const date = dateMatch === null ? attribute.date : normalizeDate(toSingleLine(dateMatch[1]));
  return {
    id: newsIdFromUrl(url),
    title,
    url,
    date,
  };
}

/**
 * 通知公告列表页 HTML → 条目数组。
 *
 * 只解析 <ul class="newsList"> 内的条目：实测该页侧栏栏目菜单（ul.menuList）同样使用 <li>，
 * 全局匹配会把「通知公告 / 焦点新闻」等导航项当成资讯；<li class="split"> 这类分隔条没有
 * 锚点，parseAnnouncementListItem 返回 null 后被跳过。
 */
export function parseAnnouncementList(html: string, baseUrl: string): NewsListItem[] {
  const container = findNewsListContainer(removeHtmlComments(html));
  if (container === '') return [];
  const items: NewsListItem[] = [];
  for (const block of container.split(/<li/i).slice(1)) {
    const item = parseAnnouncementListItem(block, baseUrl);
    if (item !== null && item.title !== '') items.push(item);
  }
  return dedupeByUrl(items);
}

/** 标题标签回退：官网 <title> 形如「标题_校园动态_学院新闻_广东岭南职业技术学院」，截掉后 3 段站点信息。 */
function titleFromTitleTag(html: string): string {
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleTag === null) return '';
  const parts = toSingleLine(titleTag[1]).split('_');
  return parts.length >= 4 ? parts.slice(0, parts.length - 3).join('_') : parts.join('_');
}

/** 文章标题（校园动态）：优先 h1.class="title"，回退到 <title> 去掉站点后缀。 */
function parseArticleTitle(html: string): string {
  const heading = /<h1[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (heading !== null) {
    const inner = heading[1];
    const subTitle = inner.search(/<div[^>]*class="[^"]*sub-title/i);
    const title = toSingleLine(subTitle === -1 ? inner : inner.slice(0, subTitle));
    if (title !== '') return title;
  }
  return titleFromTitleTag(html);
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
 * 去掉正文结尾连续的编辑署名行（供稿/初审/复审/终审/编辑/责编/摄影…）。
 *
 * 只处理尾部连续行：署名行之后若还有正文，说明它属于正文内容而不是页脚署名，
 * 原样保留，避免误删正文里出现的「编辑：…」这类叙述。全部段落都是署名行时返回空数组。
 */
function stripTrailingSignoff(paragraphs: string[]): string[] {
  let end = paragraphs.length;
  while (end > 0 && SIGNOFF_PATTERN.test(paragraphs[end - 1])) end -= 1;
  return paragraphs.slice(0, end);
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
  return stripTrailingSignoff(toParagraphs(boundary === null ? rest : rest.slice(0, boundary.index)));
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

/** 从文本里删掉第一个匹配到的块（用于剔除正文容器里的元信息块与标题块）。 */
function removeFirstBlock(text: string, pattern: RegExp): string {
  const match = pattern.exec(text);
  if (match === null) return text;
  return text.slice(0, match.index) + text.slice(match.index + match[0].length);
}

/** 文章标题（通知公告）：优先 h2.class="title"（实测该模板没有 h1.title），回退到 <title>。 */
function parseAnnouncementTitle(html: string): string {
  const heading = /<h2[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i.exec(html);
  if (heading !== null) {
    const inner = heading[1];
    const subHeading = inner.search(/<div[^>]*class="[^"]*subheading/i);
    const title = toSingleLine(subHeading === -1 ? inner : inner.slice(0, subHeading));
    if (title !== '') return title;
  }
  return titleFromTitleTag(html);
}

/**
 * 文章日期（通知公告）：div.property 内的「发布时间：」。
 * 实测该模板没有 <meta name="PubDate">，因此不设该回退（与校园动态模板的差异之一）；
 * property 块缺失时退回整页搜索同一文案，仍沿用同一字段名，不引入页面以外的来源。
 */
function parseAnnouncementDate(html: string): string {
  const property = /<div[^>]*class="[^"]*property[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  const scope = property === null ? html : property[1];
  const published = /发布时间\s*[:：]\s*([^<]{4,40})/.exec(scope);
  return published === null ? '' : normalizeDate(published[1]);
}

/**
 * 文章正文（通知公告）：<div class="printArea" data-power-area='content'> 到分享/打印区
 * （div.userControl、div#relativeInfo 或 </article>）之间。
 *
 * 与校园动态的差异：正文容器不是 div.article-content，且容器里混着整段脚本、div.property
 * 元信息块与 h2.title。处理顺序有依赖：
 * 1. 先按右边界截断，避免把「相关内容」「分享到」等页脚组件当成正文；
 * 2. 再整块丢弃 <script>（脚本的 JS 模板字符串里含 `<div class="repost-container">`，
 *    不先删掉会让第 3 步的块级匹配提前结束）；
 * 3. 依次剔除 property 元信息块与标题块（标题在详情页单独展示）；
 * 4. 结尾的 auditRecordcss 署名行（实测「终审：团委」）交给 stripTrailingSignoff。
 */
function parseAnnouncementParagraphs(html: string): string[] {
  const open = /<div[^>]*class="[^"]*printArea[^"]*"[^>]*>/i.exec(html);
  if (open === null) return [];
  const rest = html.slice(open.index + open[0].length);
  const boundary = /<div[^>]*class="[^"]*userControl[^"]*"[^>]*>|<div[^>]*id="relativeInfo"[^>]*>|<\/article>/i.exec(rest);
  let body = boundary === null ? rest : rest.slice(0, boundary.index);
  body = body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  body = removeFirstBlock(body, /<div[^>]*class="[^"]*property[^"]*"[^>]*>[\s\S]*?<\/div>/i);
  body = removeFirstBlock(body, /<h2[^>]*class="[^"]*title[^"]*"[^>]*>[\s\S]*?<\/h2>/i);
  return stripTrailingSignoff(toParagraphs(body));
}

/** 文章页 HTML → 标题、日期、正文（通知公告模板）；字段缺失时返回空字符串或空数组。 */
export function parseAnnouncementArticle(html: string, url: string): NewsArticle {
  const clean = removeHtmlComments(html);
  return {
    id: newsIdFromUrl(url),
    url,
    title: parseAnnouncementTitle(clean),
    date: parseAnnouncementDate(clean),
    paragraphs: parseAnnouncementParagraphs(clean),
  };
}

/** 按栏目模板选择列表解析规则（两套模板不同构，见 types.ts 的 NewsTemplate）。 */
export function parseList(html: string, baseUrl: string, template: NewsTemplate): NewsListItem[] {
  return template === 'newsList' ? parseAnnouncementList(html, baseUrl) : parseNewsList(html, baseUrl);
}

/** 按栏目模板选择文章解析规则。 */
export function parseArticle(html: string, url: string, template: NewsTemplate): NewsArticle {
  return template === 'newsList' ? parseAnnouncementArticle(html, url) : parseNewsArticle(html, url);
}
