/**
 * 课程色板：按课程名稳定取色。
 *
 * **为什么色值在这里、而不在 app.wxss 的令牌里**：课块颜色是数据驱动的——哪门课什么色要运行时
 * 才知道，WXSS 里写不出「按课程名取色」。所以课程色板是这份数据的一员，单一来源在本文件；
 * 结构色（品牌红、金、警告琥珀、文字三级、玻璃面）仍然只在 app.wxss 里，两边的分工见
 * docs/design/timetable/README.md。改色板只改这一处。
 *
 * 8 色**刻意避开品牌红与警告琥珀**：红是「今天与主要动作」，琥珀是「这里有问题」，
 * 课块用红或棕橙会被学生读成后者（设计图 10-palette 的理由）。
 * tint 是同一色相的 rgba 浅底，压在任何底色上都不会脏，因此课块用「浅底 + 同色描边 + 左侧色条」，
 * 不用实底：实底在 20rpx 字号下读不出字，也和玻璃纸感打架。
 *
 * 色只是分组线索，不是唯一标识：45 门课里颜色会重复，界面不得让「颜色相同」暗示某种关系。
 */
export interface CourseColor {
  /** 稳定标识：课程记录里存的是它，不是色值（色值将来要调，标识不能跟着变）。 */
  key: string;
  /** 中文名，只用于色板界面的可读标签。 */
  name: string;
  /** 实色：左侧色条、详情页头部底色。 */
  solid: string;
  /** 浅底：课块填充。 */
  tint: string;
  /** 描边：与浅底同色相、略深。 */
  line: string;
}

export const COURSE_COLORS: CourseColor[] = [
  { key: 'c1', name: '靛青', solid: '#2f5f9e', tint: 'rgba(47,95,158,0.13)', line: 'rgba(47,95,158,0.30)' },
  { key: 'c2', name: '天青', solid: '#1f7fa8', tint: 'rgba(31,127,168,0.13)', line: 'rgba(31,127,168,0.30)' },
  { key: 'c3', name: '青碧', solid: '#147a70', tint: 'rgba(20,122,112,0.13)', line: 'rgba(20,122,112,0.30)' },
  { key: 'c4', name: '松绿', solid: '#2e8b57', tint: 'rgba(46,139,87,0.13)', line: 'rgba(46,139,87,0.30)' },
  { key: 'c5', name: '竹绿', solid: '#4f8a2b', tint: 'rgba(79,138,43,0.14)', line: 'rgba(79,138,43,0.32)' },
  { key: 'c6', name: '橄榄', solid: '#6b7a2a', tint: 'rgba(107,122,42,0.14)', line: 'rgba(107,122,42,0.32)' },
  { key: 'c7', name: '紫', solid: '#6a5aa8', tint: 'rgba(106,90,168,0.13)', line: 'rgba(106,90,168,0.30)' },
  { key: 'c8', name: '品红', solid: '#a8478f', tint: 'rgba(168,71,143,0.12)', line: 'rgba(168,71,143,0.28)' },
];

/** 未知 key 的哨兵值：调用方据此判断「没有显式指定」。 */
export const NO_COLOR_INDEX = -1;

/**
 * 按课程名取色下标。同名恒同色、与它在列表里的位置无关；
 * 名字为空（还没填名字的草稿）时固定给第一色，不做随机。
 */
export function colorIndexFor(name: string): number {
  const trimmed = name.trim();
  if (trimmed === '') return 0;
  // FNV-1a，再混一次：中文名常常只差一个字，简单取模会连着落到同一色上。
  let hash = 0x811c9dc5;
  for (let i = 0; i < trimmed.length; i += 1) {
    hash ^= trimmed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2545f491) >>> 0;
  return hash % COURSE_COLORS.length;
}

/** 色板界面用：下标取色，越界或负数回落到第一色。 */
export function colorAt(index: number): CourseColor {
  if (!Number.isInteger(index) || index < 0 || index >= COURSE_COLORS.length) return COURSE_COLORS[0];
  return COURSE_COLORS[index];
}

/** 课程记录里存的 key 换算成下标；不认识（空、拼写错、旧数据）返回 NO_COLOR_INDEX。 */
export function colorIndexFromKey(key: string): number {
  const found = COURSE_COLORS.findIndex((color) => color.key === key);
  return found;
}

/** 取色：显式指定优先，否则按课程名。overrideKey 不认识时静默回落到按名取色。 */
export function courseColor(name: string, overrideKey = ''): CourseColor {
  const explicit = colorIndexFromKey(overrideKey);
  return colorAt(explicit >= 0 ? explicit : colorIndexFor(name));
}
