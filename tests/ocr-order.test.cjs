const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/** 顺序重排模块由 OCR 回填脚本使用，直接用源码测试（不经过 dist 构建）。 */
const { orderDetections, boxOf, findGutters } = require(path.resolve('scripts/lib/ocr-order.cjs'));

/** 造一条 OCR 结果：默认用 ItemPolygon（腾讯云实际返回的字段之一）。 */
function line(text, x, y, width = 400, height = 40) {
  return { DetectedText: text, ItemPolygon: { X: x, Y: y, Width: width, Height: height } };
}

test('单栏：按自上而下排序，同一行再按从左到右', () => {
  const detections = [
    line('第二行', 50, 200),
    line('第一行右', 300, 100),
    line('第一行左', 50, 100),
  ];
  const result = orderDetections(detections);
  assert.deepEqual(result.lines, ['第一行左', '第一行右', '第二行']);
  assert.equal(result.columns, 1);
  assert.equal(result.ordered, false, '单栏没有切栏，标为未重排');
});

test('双栏海报：接口按扫描行交叉返回时，重排成先左栏后右栏', () => {
  const detections = [
    line('左一', 50, 100), line('右一', 550, 100),
    line('左二', 50, 200), line('右二', 550, 200),
    line('左三', 50, 300), line('右三', 550, 300),
  ];
  const result = orderDetections(detections);
  assert.equal(result.columns, 2, '应识别出两栏');
  assert.equal(result.ordered, true);
  assert.deepEqual(result.lines, ['左一', '左二', '左三', '右一', '右二', '右三']);
});

test('通栏标题不阻止分栏，且排在两栏内容之前', () => {
  const detections = [
    line('关于某某工作的通知', 50, 20, 900),
    line('左一', 50, 200), line('右一', 550, 200),
    line('左二', 50, 300), line('右二', 550, 300),
  ];
  const result = orderDetections(detections);
  assert.equal(result.columns, 2, '宽框不能参与找栏，否则永远找不到空白');
  assert.deepEqual(result.lines, ['关于某某工作的通知', '左一', '左二', '右一', '右二']);
});

test('全部是宽框时不切栏，退回自上而下', () => {
  const detections = [line('第一段', 20, 100, 960), line('第二段', 20, 200, 960)];
  const result = orderDetections(detections);
  assert.equal(result.columns, 1);
  assert.deepEqual(result.lines, ['第一段', '第二段']);
});

test('部分条目缺少坐标：保持接口返回顺序，并说明原因', () => {
  const detections = [
    line('有坐标', 50, 200),
    { DetectedText: '没有坐标' },
    line('也有坐标', 50, 100),
  ];
  const result = orderDetections(detections);
  assert.equal(result.ordered, false);
  assert.deepEqual(result.lines, ['有坐标', '没有坐标', '也有坐标']);
  assert.match(result.reason, /缺少坐标/);
});

test('Polygon 四点也能取包围盒；空文本条目被丢弃', () => {
  const polygon = { DetectedText: '四点框', Polygon: [{ X: 100, Y: 300 }, { X: 500, Y: 300 }, { X: 500, Y: 340 }, { X: 100, Y: 340 }] };
  assert.deepEqual(boxOf(polygon), { x1: 100, y1: 300, x2: 500, y2: 340 });
  const result = orderDetections([polygon, { DetectedText: '', ItemPolygon: { X: 0, Y: 0, Width: 1, Height: 1 } }]);
  assert.deepEqual(result.lines, ['四点框']);
});

test('空输入与纯空白输入不报错', () => {
  assert.deepEqual(orderDetections([]).lines, []);
  assert.deepEqual(orderDetections(undefined).lines, []);
  assert.deepEqual(orderDetections([{ DetectedText: '   ' }]).lines, ['   ']);
});

test('竖向空白阈值：够宽才算栏，太窄的缝不算', () => {
  const wide = [line('左', 0, 0, 460), line('右', 500, 0, 460)];
  assert.equal(findGutters(wide.map((item) => boxOf(item)), 30).length, 1, '40px 的缝（≥30）应切成两栏');
  const narrow = [line('左', 0, 0, 480), line('右', 490, 0, 480)];
  assert.equal(findGutters(narrow.map((item) => boxOf(item)), 30).length, 0, '10px 的缝（<30）不算栏');
});

test('真实形状：海报标题 + 两栏正文 + 底部署名', () => {
  const detections = [
    line('关于开展2025年岭南大学生科技文化节活动的通知', 40, 30, 920, 60),
    line('一、活动主题', 40, 150),
    line('二、活动时间', 40, 250),
    line('本次科技文化节以“创新”为主题', 530, 150),
    line('2025年10月至12月', 530, 250),
    line('终审：团委', 40, 900, 920, 30),
  ];
  const result = orderDetections(detections);
  assert.equal(result.columns, 2);
  // 通栏元素归 0 号栏后按 y 参与排序：标题在最前，底部署名落在左栏末尾（不会被提到开头）。
  assert.deepEqual(result.lines, [
    '关于开展2025年岭南大学生科技文化节活动的通知',
    '一、活动主题',
    '二、活动时间',
    '终审：团委',
    '本次科技文化节以“创新”为主题',
    '2025年10月至12月',
  ]);
});
