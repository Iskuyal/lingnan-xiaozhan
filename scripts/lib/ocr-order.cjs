/**
 * OCR 结果的阅读顺序重排（Ticket 11）。
 *
 * 为什么需要：官网那批通知的正文是**多栏设计稿式的海报**，腾讯云 OCR 按扫描行返回文本，
 * 遇到多栏排版会把不同栏的行串在一起（「左栏第一行 + 右栏第一行 + 左栏第二行…」），
 * 拼出来的正文读不通，进检索语料会答错。这里按坐标把行归到栏，再按「栏 → 行 → 列」输出。
 *
 * 算法是 XY-cut 的简化版：
 *   1. 取每行的包围盒（优先 `ItemPolygon`，缺失时用 `Polygon` 四点求外框）；
 *   2. **只用窄框**找竖向空白（通栏标题这类宽框会横跨空白，用它找栏永远找不到栏）；
 *   3. 按竖向空白切栏，每行按中心点归栏；
 *   4. 输出顺序 = 栏序号 → y → x。
 *
 * 已知取舍：跨栏的元素（分节标题）会被归到它中心点所在的栏，因而可能出现在该栏内部而不是
 * 两栏之间。对检索来说这可以接受（文字都在），对「逐字复现原版式」不可以。
 */
'use strict';

/** 宽度超过页面宽度这个比例的框，视为通栏元素，不参与找栏。 */
const WIDE_RATIO = 0.6;
/** 竖向空白的最小宽度：页面宽度的 3% 与 20px 取大者。 */
const MIN_GUTTER_RATIO = 0.03;
const MIN_GUTTER_PX = 20;
/** 最多切到几栏，防止把一句话切成碎片。 */
const MAX_COLUMNS = 4;

/** 取一行的包围盒；两种坐标字段都没有时返回 null。 */
function boxOf(detection) {
  const item = detection === null || detection === undefined ? null : detection.ItemPolygon;
  if (item !== null && item !== undefined && Number.isFinite(item.X) && Number.isFinite(item.Y)) {
    return {
      x1: item.X,
      y1: item.Y,
      x2: item.X + (Number.isFinite(item.Width) ? item.Width : 0),
      y2: item.Y + (Number.isFinite(item.Height) ? item.Height : 0),
    };
  }
  const polygon = detection === null || detection === undefined ? null : detection.Polygon;
  if (Array.isArray(polygon) && polygon.length >= 3) {
    const xs = polygon.map((point) => point && point.X).filter(Number.isFinite);
    const ys = polygon.map((point) => point && point.Y).filter(Number.isFinite);
    if (xs.length >= 3 && ys.length >= 3) {
      return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
    }
  }
  return null;
}

/** 只用窄框找竖向空白；返回切分点（x 坐标）数组，按从左到右。 */
function findGutters(boxes, minGutter) {
  const narrow = boxes.filter((box) => box.x2 - box.x1 <= (Math.max(...boxes.map((b) => b.x2)) - Math.min(...boxes.map((b) => b.x1))) * WIDE_RATIO);
  if (narrow.length < 2) return [];
  const sorted = [...narrow].sort((a, b) => a.x1 - b.x1);
  let reach = sorted[0].x2;
  const cuts = [];
  for (const box of sorted.slice(1)) {
    if (box.x1 - reach >= minGutter) cuts.push((reach + box.x1) / 2);
    reach = Math.max(reach, box.x2);
  }
  return cuts.slice(0, MAX_COLUMNS - 1);
}

/** 有坐标时按「栏 → 行 → 列」排序；坐标不全时保守地保持接口返回的顺序。 */
function orderDetections(detections) {
  const entries = (Array.isArray(detections) ? detections : [])
    .map((detection, rawIndex) => ({
      text: typeof detection?.DetectedText === 'string' ? detection.DetectedText : '',
      box: boxOf(detection),
      rawIndex,
    }))
    .filter((entry) => entry.text !== '');

  if (entries.length === 0) {
    return { lines: [], ordered: false, columns: 1, reason: '没有条目' };
  }
  if (entries.some((entry) => entry.box === null)) {
    // 腾讯云返回的顺序本身已按阅读顺序优化过，缺坐标时不动它比乱猜安全。
    return { lines: entries.map((entry) => entry.text), ordered: false, columns: 1, reason: '部分条目缺少坐标，保持接口返回顺序' };
  }

  const boxes = entries.map((entry) => entry.box);
  const pageLeft = Math.min(...boxes.map((box) => box.x1));
  const pageRight = Math.max(...boxes.map((box) => box.x2));
  const pageWidth = pageRight - pageLeft;
  const minGutter = Math.max(MIN_GUTTER_PX, pageWidth * MIN_GUTTER_RATIO);
  const cuts = findGutters(boxes, minGutter);

  /**
   * 归栏：通栏元素一律归 0 号栏，之后仍按 y 参与该栏内排序。
   *
   * 为什么不让它们「最先输出」：居中的通栏标题中心点会落在右侧空白上，若按中心点归栏会被塞进
   * 右栏、跑到左栏内容之后；归 0 号栏并按 y 排，则顶部标题自然在最前、底部通栏的署名行自然落在
   * 左栏末尾（实测的真实海报形状就是这样，见 tests/ocr-order.test.cjs）。
   */
  const bandOf = (box) => {
    if (box.x2 - box.x1 > pageWidth * WIDE_RATIO) return 0;
    const center = (box.x1 + box.x2) / 2;
    let band = 0;
    for (const cut of cuts) if (center >= cut) band += 1;
    return band;
  };
  const ordered = [...entries].sort((a, b) => {
    const bandDiff = bandOf(a.box) - bandOf(b.box);
    if (bandDiff !== 0) return bandDiff;
    const yDiff = a.box.y1 - b.box.y1;
    if (Math.abs(yDiff) > 1) return yDiff;
    return a.box.x1 - b.box.x1;
  });
  return {
    lines: ordered.map((entry) => entry.text),
    ordered: cuts.length > 0,
    columns: cuts.length + 1,
    reason: cuts.length > 0 ? `按 ${cuts.length + 1} 栏重排` : '未找到竖向空白，按自上而下重排',
  };
}

module.exports = { orderDetections, boxOf, findGutters, WIDE_RATIO, MIN_GUTTER_RATIO, MIN_GUTTER_PX, MAX_COLUMNS };
