const { test } = require('node:test');
const assert = require('node:assert/strict');

// 课表改版的纯函数层：课程取色与周网格排布。
// 依据：docs/design/timetable/README.md 的「版式规则」1–4 条（设计图 01 / 10）。
const palette = require('../dist/services/timetable/palette.js');
const view = require('../dist/services/timetable/view.js');

function course(overrides) {
  return {
    id: 'tc_1',
    name: '高等数学',
    credits: '',
    teacher: '林加燕',
    weekday: 1,
    startSection: 1,
    endSection: 2,
    sectionRanges: [{ start: 1, end: 2 }],
    weeks: [4],
    weeksRecognized: true,
    weekText: '[4]周',
    location: '崇礼楼-306-计算机十九室',
    campus: '清远校区',
    siteNumber: '44',
    note: '',
    warnings: [],
    source: 'excel',
    semester: '2026-2027学年第一学期',
    rawText: '',
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
    ...overrides,
  };
}

// ---------- 课程取色 ----------

test('色板是 8 色，每色三个值齐全，且刻意避开品牌红与警告琥珀', () => {
  assert.equal(palette.COURSE_COLORS.length, 8);
  for (const color of palette.COURSE_COLORS) {
    assert.match(color.key, /^c[1-8]$/);
    assert.match(color.solid, /^#[0-9a-f]{6}$/);
    assert.match(color.tint, /^rgba\(/);
    assert.match(color.line, /^rgba\(/);
  }
  // 品牌红 #c41c23 与警告琥珀 #9a5b1e 不得出现在色板里（设计图 10 的理由）。
  const solids = palette.COURSE_COLORS.map((c) => c.solid);
  assert.ok(!solids.includes('#c41c23'));
  assert.ok(!solids.includes('#9a5b1e'));
});

test('同名恒同色，不同名字分布不集中在一色', () => {
  const first = palette.colorIndexFor('高等数学');
  assert.equal(palette.colorIndexFor('高等数学'), first);
  assert.equal(palette.colorIndexFor(''), palette.colorIndexFor(''));

  const used = new Set();
  for (const name of ['高等数学', '劳动教育（一）', '大学美育', '网页设计与制作技术', '体育（三）', '思想道德与法治', '形势与政策', '低代码平台应用开发']) {
    used.add(palette.colorIndexFor(name));
  }
  assert.ok(used.size >= 5, `8 门常见课只落在 ${used.size} 个色上，取色太集中`);
});

test('取色：显式指定优先于按名取色，非法指定回落到按名', () => {
  const auto = palette.courseColor('高等数学');
  assert.equal(palette.courseColor('高等数学', auto.key).key, auto.key);
  assert.equal(palette.courseColor('高等数学', 'c7').key, 'c7');
  assert.equal(palette.courseColor('高等数学', '不存在的色').key, auto.key);
  assert.equal(palette.courseColor('高等数学', 'c99').key, auto.key);
});

test('索引取色：越界与负数回落到第一色，不返回 undefined', () => {
  assert.equal(palette.colorAt(0).key, 'c1');
  assert.equal(palette.colorAt(7).key, 'c8');
  assert.equal(palette.colorAt(99).key, 'c1');
  assert.equal(palette.colorAt(-3).key, 'c1');
});

// ---------- 周网格排布 ----------

test('空课表：12 行、7 列、每列都收窄、没有块', () => {
  const grid = view.buildGrid([], 4);
  assert.equal(grid.rows, 12);
  assert.deepEqual(grid.sectionNumbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], '模板靠它画时间轴与横线');
  assert.equal(grid.columns.length, 7);
  assert.deepEqual(grid.columns.map((c) => c.narrow), [true, true, true, true, true, true, true]);
  assert.equal(grid.total, 0);
  assert.equal(grid.placed, 0);
  for (const column of grid.columns) assert.deepEqual(column.blocks, []);
});

test('列宽自适应：有课的天不收窄，没课的天收窄（版式规则 1）', () => {
  const grid = view.buildGrid([
    course({ id: 'a', weekday: 1 }),
    course({ id: 'b', weekday: 4, sectionRanges: [{ start: 3, end: 4 }] }),
  ], 4);
  assert.deepEqual(grid.columns.map((c) => c.narrow), [false, true, true, false, true, true, true]);
  assert.deepEqual(grid.hasCourseWeekdays, [1, 4]);
});

test('连堂合并成一块：1-4 节是一块，跨度 4，走「满信息」档', () => {
  const grid = view.buildGrid([course({ sectionRanges: [{ start: 1, end: 4 }], startSection: 1, endSection: 4 })], 4);
  const blocks = grid.columns[0].blocks;
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].start, 1);
  assert.equal(blocks[0].end, 4);
  assert.equal(blocks[0].span, 4);
  assert.equal(blocks[0].tier, 'full');
  assert.equal(blocks[0].teacher, '林加燕');
});

test('课块按高度分级给信息：≥3 节含教师、2 节含地点、1 节只有名字（版式规则 2）', () => {
  const wide = view.buildGrid([course({ sectionRanges: [{ start: 1, end: 3 }], startSection: 1, endSection: 3 })], 4);
  assert.equal(wide.columns[0].blocks[0].tier, 'full');

  const mid = view.buildGrid([course({ sectionRanges: [{ start: 5, end: 6 }] })], 4);
  assert.equal(mid.columns[0].blocks[0].tier, 'medium');
  // 课块一行只放得下约 6 个字，地点在网格里缩成「楼栋-房间」；完整地点见列表与详情弹层。
  assert.equal(mid.columns[0].blocks[0].meta, '崇礼楼-306');

  const tiny = view.buildGrid([course({ sectionRanges: [{ start: 7, end: 7 }] })], 4);
  assert.equal(tiny.columns[0].blocks[0].tier, 'name');
  assert.equal(tiny.columns[0].blocks[0].meta, '');
  assert.equal(tiny.columns[0].blocks[0].teacher, '');
});

test('同格多门：周次重叠的两门课折叠成一块并带门数（版式规则 3）', () => {
  const grid = view.buildGrid([
    course({ id: 'a', name: '习近平新时代中国特色社会主义思想概论', sectionRanges: [{ start: 5, end: 6 }] }),
    course({ id: 'b', name: '形势与政策', sectionRanges: [{ start: 5, end: 6 }] }),
  ], 4);
  const blocks = grid.columns[0].blocks;
  assert.equal(blocks.length, 1, '完全同格应折叠成一块，而不是并排两块');
  assert.equal(blocks[0].count, 2);
  assert.deepEqual(blocks[0].ids.sort(), ['a', 'b']);
  assert.equal(blocks[0].name, '习近平新时代中国特色社会主义思想概论');
});

test('部分重叠走泳道并排，不折叠也不互相压住', () => {
  const grid = view.buildGrid([
    course({ id: 'a', sectionRanges: [{ start: 5, end: 6 }], name: '甲' }),
    course({ id: 'b', sectionRanges: [{ start: 6, end: 7 }], name: '乙' }),
  ], 4);
  const blocks = grid.columns[0].blocks;
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].laneCount, 2);
  assert.equal(blocks[1].laneCount, 2);
  assert.notEqual(blocks[0].lane, blocks[1].lane);
});

test('不重叠的课占满整列宽（泳道数回到 1）', () => {
  const grid = view.buildGrid([
    course({ id: 'a', sectionRanges: [{ start: 1, end: 2 }] }),
    course({ id: 'b', sectionRanges: [{ start: 5, end: 6 }] }),
  ], 4);
  for (const block of grid.columns[0].blocks) assert.equal(block.laneCount, 1);
});

test('周次过滤：不在本教学周的课不出现；周次未识别的课按每周展示并保留待核对', () => {
  const grid = view.buildGrid([
    course({ id: 'a', weeks: [5], sectionRanges: [{ start: 1, end: 2 }] }),
    course({ id: 'b', weeks: [], weeksRecognized: false, weekText: '4', warnings: ['周次未识别'], sectionRanges: [{ start: 5, end: 6 }] }),
  ], 4);
  const all = grid.columns.flatMap((c) => c.blocks);
  assert.equal(all.length, 1);
  assert.equal(all[0].ids[0], 'b');
  assert.equal(all[0].needsReview, true);
});

test('节次越界或倒置的课不进网格，但仍算进「本周课程数」', () => {
  const grid = view.buildGrid([
    course({ id: 'ok', sectionRanges: [{ start: 1, end: 2 }] }),
    course({ id: 'bad', sectionRanges: [], startSection: 6, endSection: 3, warnings: ['节次倒置'] }),
    course({ id: 'out', sectionRanges: [{ start: 13, end: 14 }] }),
  ], 4);
  const ids = grid.columns.flatMap((c) => c.blocks).flatMap((b) => b.ids);
  assert.deepEqual(ids, ['ok']);
  assert.equal(grid.total, 3, '本周课程数按列表口径算，不因画不出来而少算');
  assert.equal(grid.placed, 1);
});

test('星期越界的课不会掉到别的列里', () => {
  const grid = view.buildGrid([course({ weekday: 0 }), course({ weekday: 8 })], 4);
  assert.equal(grid.columns.flatMap((c) => c.blocks).length, 0);
  assert.equal(grid.total, 2);
});

test('日期与今天：给了日期就带上，没给不显示；今天列只有一天', () => {
  const bare = view.buildGrid([course({})], 4);
  assert.deepEqual(bare.columns.map((c) => c.dateLabel), ['', '', '', '', '', '', '']);
  assert.deepEqual(bare.columns.map((c) => c.today), [false, false, false, false, false, false, false]);

  const withDates = view.buildGrid([course({})], 4, {
    dateLabels: ['21', '22', '23', '24', '25', '26', '27'],
    todayWeekday: 1,
  });
  assert.equal(withDates.columns[0].dateLabel, '21');
  assert.equal(withDates.columns[6].dateLabel, '27');
  assert.deepEqual(withDates.columns.map((c) => c.today), [true, false, false, false, false, false, false]);

  // 日期数组残缺不崩，缺的当没有
  const partial = view.buildGrid([course({})], 4, { dateLabels: ['21'] });
  assert.equal(partial.columns[0].dateLabel, '21');
  assert.equal(partial.columns[3].dateLabel, '');
});

test('正在上：只有当前节次落在块范围内的块被标记，且需要页面上报节次', () => {
  const courses = [course({ id: 'a', sectionRanges: [{ start: 5, end: 6 }] }), course({ id: 'b', sectionRanges: [{ start: 7, end: 8 }] })];
  const idle = view.buildGrid(courses, 4);
  assert.deepEqual(idle.columns[0].blocks.map((b) => b.now), [false, false]);

  const now = view.buildGrid(courses, 4, { nowSection: 6 });
  assert.deepEqual(now.columns[0].blocks.map((b) => b.now), [true, false]);
});

test('块按起始节次排序，同格折叠后总块数不超过节次上限', () => {
  const grid = view.buildGrid([
    course({ id: 'late', sectionRanges: [{ start: 9, end: 10 }] }),
    course({ id: 'early', sectionRanges: [{ start: 1, end: 2 }] }),
  ], 4);
  assert.deepEqual(grid.columns[0].blocks.map((b) => b.start), [1, 9]);
  for (const block of grid.columns.flatMap((c) => c.blocks)) {
    assert.ok(block.start >= 1 && block.end <= 12, `块范围 ${block.start}-${block.end} 超出 1-12 节`);
  }
});

test('几何量按节次算好（WXML 里做不了算术）：第 5-6 节在 4 行之后，高度两节减间距', () => {
  const grid = view.buildGrid([course({ sectionRanges: [{ start: 5, end: 6 }] })], 4);
  const block = grid.columns[0].blocks[0];
  assert.equal(block.topRpx, 4 * view.SECTION_ROW_RPX);
  assert.equal(block.heightRpx, 2 * view.SECTION_ROW_RPX - view.BLOCK_GAP_RPX);
  // 单泳道占满整列，但左右各留一点白，块与列边不贴死
  assert.equal(block.laneLeftPercent, 2.5);
  assert.equal(block.laneWidthPercent, 95);
});

test('泳道几何：两条泳道各占近一半、第二条从 50% 之后开始，且互不重叠', () => {
  const grid = view.buildGrid([
    course({ id: 'a', sectionRanges: [{ start: 5, end: 6 }] }),
    course({ id: 'b', sectionRanges: [{ start: 6, end: 7 }] }),
  ], 4);
  const [first, second] = grid.columns[0].blocks;
  assert.equal(first.laneLeftPercent, 2.5);
  assert.equal(first.laneWidthPercent, 45);
  assert.equal(second.laneLeftPercent, 52.5);
  assert.equal(second.laneWidthPercent, 45);
  assert.ok(first.laneLeftPercent + first.laneWidthPercent < second.laneLeftPercent, '两条泳道不该压住对方');
});

test('连堂块的高度按节数累加：1-4 节是四节高减一个间距', () => {
  const grid = view.buildGrid([course({ sectionRanges: [{ start: 1, end: 4 }] })], 4);
  assert.equal(grid.columns[0].blocks[0].topRpx, 0);
  assert.equal(grid.columns[0].blocks[0].heightRpx, 4 * view.SECTION_ROW_RPX - view.BLOCK_GAP_RPX);
});
