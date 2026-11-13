const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// 「贴班群通知 → AI 识别多处变更 → 逐条勾选 → 批量应用 → 10 秒内可撤销」（设计图 02）。
// 这一层是纯逻辑：提示词、严格解析、冲突检测、写入计划与撤销计划，不依赖小程序运行时。
function loadCompiled(relative) {
  const filename = path.resolve(relative);
  const compiled = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: compiled,
    exports: compiled.exports,
    require: createRequire(filename),
  }, { filename });
  return compiled.exports;
}

const notice = () => loadCompiled('dist/services/timetable/notice.js');
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * 与设计图 02 的三个例子同一套样本：
 * - 高等数学 周一 1-2 节、第 11-13 周（第 12 周停课）；
 * - 网页设计与制作 周三 3-4 节、第 11-18 周（博雅楼 B310 → B604）；
 * - 中华传统文化精粹 周五 5-6 节、第 13 周（与高数补课撞车）。
 */
const COURSES = [
  {
    id: 'tc_math', name: '高等数学', credits: '1.5', teacher: '林加燕', weekday: 1,
    startSection: 1, endSection: 2, sectionRanges: [{ start: 1, end: 2 }],
    weeks: [11, 12, 13], weeksRecognized: true, weekText: '[11-13]周',
    location: '崇礼楼-306', campus: '清远校区', siteNumber: '44', note: '', warnings: [],
    source: 'excel', semester: '2026-2027学年第一学期', rawText: '', createdAt: '', updatedAt: '',
  },
  {
    id: 'tc_web', name: '网页设计与制作', credits: '2', teacher: '陈明', weekday: 3,
    startSection: 3, endSection: 4, sectionRanges: [{ start: 3, end: 4 }],
    weeks: [11, 12, 13, 14, 15, 16, 17, 18], weeksRecognized: true, weekText: '[11-18]周',
    location: '博雅楼-B310', campus: '清远校区', siteNumber: '12', note: '', warnings: [],
    source: 'excel', semester: '2026-2027学年第一学期', rawText: '', createdAt: '', updatedAt: '',
  },
  {
    id: 'tc_culture', name: '中华传统文化精粹', credits: '1', teacher: '周敏', weekday: 5,
    startSection: 5, endSection: 6, sectionRanges: [{ start: 5, end: 6 }],
    weeks: [13], weeksRecognized: true, weekText: '[13]周',
    location: '博雅楼-B201', campus: '清远校区', siteNumber: '20', note: '', warnings: [],
    source: 'manual', semester: '2026-2027学年第一学期', rawText: '', createdAt: '', updatedAt: '',
  },
];

const TOTAL_WEEKS = 20;

test('限定周次：同一条提案可修改时间和地点，写入与撤销走原子接口', () => {
  const { parseNoticeReply, applyPlan, invertPlan } = notice();
  const reply = parseNoticeReply(noticeOk([{ action: 'move', courseId: 'tc_math', courseName: '高等数学',
    weekday: 5, startSection: 5, endSection: 6, weekText: '第12周', location: '新教室', quote: '第12周改到周五5-6节新教室' }]), COURSES, TOTAL_WEEKS, 11);
  assert.equal(reply.kind, 'changes');
  assert.equal(reply.changes[0].blocked, '');
  assert.match(reply.changes[0].scopeLabel, /仅第.*12.*周/u);
  assert.match(reply.changes[0].diffs[0].note, /仅第.*12.*周/u);
  const steps = applyPlan(reply.changes, COURSES, TOTAL_WEEKS);
  assert.equal(steps[0].kind, 'scoped');
  assert.deepEqual(plain(steps[0].input.weeks), [12]);
  assert.equal(steps[0].input.location, '新教室');
  assert.deepEqual(plain(steps[0].before.weeks), [11, 12, 13]);
  const inverse = invertPlan([{ ...steps[0], operationId: 'fixed-test-request', after: steps[0].input }]);
  assert.equal(inverse[0].kind, 'scoped');
  assert.equal(inverse[0].operationId, 'fixed-test-request');
});

test('限定周次：同课同范围的时间与地点两条回复合并，不同范围先澄清', () => {
  const { parseNoticeReply } = notice();
  const rows = [
    { action: 'move', courseId: 'tc_math', weekday: 5, startSection: 5, endSection: 6, weekText: '第12周' },
    { action: 'relocate', courseId: 'tc_math', weekText: '第12周', location: 'B604' },
  ];
  const merged = parseNoticeReply(noticeOk(rows), COURSES, TOTAL_WEEKS);
  assert.equal(merged.changes.length, 1);
  assert.equal(merged.changes[0].location, 'B604'); assert.equal(merged.changes[0].weekday, 5);
  assert.equal(merged.changes[0].blocked, '');
  const contradictory = parseNoticeReply(noticeOk([{ ...rows[0], location: 'B603' }, rows[1]]), COURSES, TOTAL_WEEKS);
  assert.ok(contradictory.changes.every((change) => change.blocked !== ''), '同周次的两个不同新地点不能静默选后一个');
  const ambiguous = parseNoticeReply(noticeOk([rows[0], { ...rows[1], weekText: '第13周' }]), COURSES, TOTAL_WEEKS);
  assert.ok(ambiguous.changes.every((change) => !change.defaultChecked && change.blocked.includes('分段')));
});

test('限定周次：从某周起与相对周可核对；当前周未知时不猜下周', () => {
  const { parseNoticeReply } = notice();
  const row = { action: 'relocate', courseId: 'tc_math', location: 'B604' };
  const from = parseNoticeReply(noticeOk([{ ...row, weekText: '从第12周起' }]), COURSES, 20, 11);
  assert.deepEqual(plain(from.changes[0].weeks), [12, 13]);
  assert.equal(from.changes[0].blocked, '');
  const next = parseNoticeReply(noticeOk([{ ...row, weekText: '下周' }]), COURSES, 20, 11);
  assert.deepEqual(plain(next.changes[0].weeks), [12]);
  const unknown = parseNoticeReply(noticeOk([{ ...row, weekText: '下周' }]), COURSES, 20, 0);
  assert.notEqual(unknown.changes[0].blocked, '');
});

function noticeOk(changes, message = '识别到 3 处变更。') {
  return JSON.stringify({ kind: 'changes', message, changes });
}

/** 设计图 02 的三条变更：停课、改地点、补课（补课与中华传统文化精粹冲突）。 */
function designChanges() {
  return [
    {
      action: 'cancel', title: '停课 第 12 周 周一全天', quote: '第 12 周周一全天停课',
      courseName: '高等数学', courseId: '', weekday: 1, startSection: 0, endSection: 0,
      weekText: '第12周', location: '', teacher: '', conflict: '',
    },
    {
      action: 'relocate', title: '改地点 网页设计与制作', quote: '所有周次改到博雅楼 B604',
      courseName: '网页设计与制作', courseId: '', weekday: 3, startSection: 0, endSection: 0,
      weekText: '', location: '博雅楼-B604', teacher: '', conflict: '',
    },
    {
      action: 'add', title: '补课 高等数学', quote: '第 13 周周五 5-6 节补上周三的高数',
      courseName: '高等数学', courseId: '', weekday: 5, startSection: 5, endSection: 6,
      weekText: '第13周', location: '', teacher: '', conflict: '',
    },
  ];
}

test('提示词:带当前课表快照、课程 id、当前周与总周数,纪律写明只提案不写入', () => {
  const { buildNoticePrompt, NOTICE_FEATURE } = notice();
  const prompt = buildNoticePrompt(COURSES, '2026-2027学年第一学期', 12, TOTAL_WEEKS);
  assert.ok(prompt.includes('高等数学'));
  assert.ok(prompt.includes('网页设计与制作'));
  assert.ok(prompt.includes('tc_math'), '提示词必须带课程 id,模型才可能回填 courseId');
  assert.match(prompt, /第 12 周/u);
  assert.match(prompt, /共 20 周/u);
  // 四种形态都写清楚，避免模型自创 kind
  assert.ok(prompt.includes('"kind":"changes"'));
  assert.ok(prompt.includes('"kind":"none"'));
  assert.ok(prompt.includes('"kind":"clarify"'));
  assert.ok(prompt.includes('"kind":"out_of_scope"'));
  // 纪律：不声称已改、不补全通知里没写的字段、quote 必须逐字
  assert.match(prompt, /绝不自己补全|不许改写/u);
  assert.match(prompt, /不要声称已经改好课表/u);
  assert.equal(NOTICE_FEATURE, 'timetable-notice');
});

test('解析:合法批量提案按动作归类,标题与差异行按结构化字段重算', () => {
  const { parseNoticeReply } = notice();
  const reply = parseNoticeReply(noticeOk(designChanges()), COURSES, TOTAL_WEEKS);
  assert.equal(reply.kind, 'changes');
  assert.equal(reply.changes.length, 3);

  const [cancel, relocate, add] = reply.changes;
  assert.equal(cancel.action, 'cancel');
  assert.equal(cancel.courseId, 'tc_math', '按课程名精确匹配到已有课程');
  assert.match(cancel.title, /停课/u);
  assert.match(cancel.title, /第 12 周/u);
  assert.match(cancel.quote, /第 12 周周一全天停课/u);
  // 差异行：旧值（课程名）→ 新值（本周不上）
  assert.equal(cancel.diffs[0].old, '高等数学');
  assert.match(cancel.diffs[0].next, /第 12 周不上/u);
  assert.deepEqual(plain(cancel.remainingWeeks), [11, 13], '停课只去掉第 12 周');
  assert.equal(cancel.defaultChecked, true);

  assert.equal(relocate.action, 'relocate');
  assert.equal(relocate.diffs[0].old, '博雅楼-B310');
  assert.equal(relocate.diffs[0].next, '博雅楼-B604');
  assert.match(relocate.diffs[0].note, /第 11-18 周/u, '设计图里差异行末尾的灰色周次尾注');
  assert.equal(relocate.defaultChecked, true);

  assert.equal(add.action, 'add');
  assert.equal(add.courseId, '', '补课不指向已有课程');
  assert.match(add.diffs[0].next, /第 13 周/u);
  assert.match(add.diffs[0].next, /周五/u);
  assert.match(add.diffs[0].next, /第 5-6 节/u);
});

test('解析:补课与同一时段已有课程冲突时默认不勾选,并给出可操作提示', () => {
  const { parseNoticeReply } = notice();
  const reply = parseNoticeReply(noticeOk(designChanges()), COURSES, TOTAL_WEEKS);
  const add = reply.changes[2];
  assert.match(add.conflict, /中华传统文化精粹/u, '冲突文案要点名撞上的那门课');
  assert.match(add.conflict, /未勾选/u);
  assert.match(add.conflict, /可改时段或仍然加入/u);
  assert.equal(add.defaultChecked, false, '冲突项默认不勾选');
  assert.equal(add.blocked, '', '冲突不是硬阻塞：学生仍然可以勾选加入');
});

test('解析:周次没有交集就不算冲突,无冲突的补课默认勾选', () => {
  const { parseNoticeReply } = notice();
  const changes = [designChanges()[2]];
  // 第 7 周补课，与「中华传统文化精粹」的第 13 周没有交集。
  changes[0] = { ...changes[0], weekText: '第7周' };
  const reply = parseNoticeReply(noticeOk(changes), COURSES, TOTAL_WEEKS);
  assert.equal(reply.kind, 'changes');
  assert.equal(reply.changes[0].conflict, '');
  assert.equal(reply.changes[0].defaultChecked, true);
});

test('解析:空通知明确说没有变更,不生成提案', () => {
  const { parseNoticeReply } = notice();
  const reply = parseNoticeReply(JSON.stringify({ kind: 'none', message: '这段通知里没有要改课表的内容。' }), COURSES, TOTAL_WEEKS);
  assert.equal(reply.kind, 'none');
  assert.match(reply.message, /没有要改课表/u);
  // 没写 message 也不能崩，要把话说清
  const bare = parseNoticeReply(JSON.stringify({ kind: 'none' }), COURSES, TOTAL_WEEKS);
  assert.equal(bare.kind, 'none');
  assert.match(bare.message, /没有/u);
});

test('解析:通知与课表无关时按超范围如实告知', () => {
  const { parseNoticeReply } = notice();
  const reply = parseNoticeReply(
    JSON.stringify({ kind: 'out_of_scope', message: '这是关于奖学金的推送，和课表没有关系。' }),
    COURSES,
    TOTAL_WEEKS,
  );
  assert.equal(reply.kind, 'out_of_scope');
  assert.match(reply.message, /奖学金/u);
});

test('解析:非 JSON / 缺字段 / 未知动作一律回退,绝不当成可应用的变更', () => {
  const { parseNoticeReply } = notice();
  const invalidCases = [
    '抱歉，我没看懂这段通知。',
    JSON.stringify({ kind: 'changes' }),
    JSON.stringify({ kind: 'changes', changes: 'nope' }),
    JSON.stringify({ kind: 'changes', changes: [{ action: 'cancel', courseName: '高等数学' }] }),
    JSON.stringify({ kind: 'changes', changes: [{ action: 'cancel', courseName: '高等数学', weekText: '第12周' }, { action: 'relocate', courseName: '网页设计与制作' }] }),
    JSON.stringify({ kind: 'changes', changes: [{ action: 'delete', courseName: '高等数学', weekText: '第12周' }] }),
    JSON.stringify({ kind: 'changes', changes: [{ action: 'add', courseName: '高等数学', weekText: '第13周' }] }),
    JSON.stringify({ kind: 'weird', message: 'x' }),
  ];
  for (const text of invalidCases) {
    const reply = parseNoticeReply(text, COURSES, TOTAL_WEEKS);
    assert.equal(reply.kind, 'invalid', `应当回退为 invalid：${text}`);
    assert.ok(reply.message.length > 0, '回退也要给学生一句能看懂的话');
  }
  // 回退文案必须说明「没有写入」，不能让学生以为悄悄改了
  assert.match(parseNoticeReply('oops', COURSES, TOTAL_WEEKS).message, /没有生成任何变更|没有写入/u);
});

test('解析:对不上课表的课程标成阻塞并默认不勾选,不假装能应用', () => {
  const { parseNoticeReply } = notice();
  const reply = parseNoticeReply(
    noticeOk([{ action: 'cancel', courseName: '人工智能导论', weekText: '第12周', quote: '第 12 周停课' }]),
    COURSES,
    TOTAL_WEEKS,
  );
  assert.equal(reply.kind, 'changes');
  assert.match(reply.changes[0].blocked, /没有找到「人工智能导论」/u);
  assert.equal(reply.changes[0].defaultChecked, false);
});

test('解析:停课与现状一致或会把课程清空时标阻塞,避免写出一条空周次', () => {
  const { parseNoticeReply } = notice();
  // 第 5 周高等数学本来就没有课
  const idle = parseNoticeReply(
    noticeOk([{ action: 'cancel', courseName: '高等数学', weekText: '第5周', quote: '第 5 周停课' }]),
    COURSES,
    TOTAL_WEEKS,
  );
  assert.match(idle.changes[0].blocked, /本来就没有课/u);
  assert.equal(idle.changes[0].defaultChecked, false);

  // 只有第 13 周这一周的课，停掉就没有剩余周次
  const single = parseNoticeReply(
    noticeOk([{ action: 'cancel', courseName: '中华传统文化精粹', weekText: '第13周', quote: '第 13 周停课' }]),
    COURSES,
    TOTAL_WEEKS,
  );
  assert.match(single.changes[0].blocked, /没有剩余周次/u);
  assert.equal(single.changes[0].defaultChecked, false);
});

test('解析:每周都上的课要停一周时按总周数展开,不知道总周数就标阻塞', () => {
  const everyWeek = [{ ...COURSES[0], weeks: [], weeksRecognized: true, weekText: '' }];
  const { parseNoticeReply } = notice();
  const reply = parseNoticeReply(
    noticeOk([{ action: 'cancel', courseName: '高等数学', weekText: '第12周', quote: '第 12 周停课' }]),
    everyWeek,
    TOTAL_WEEKS,
  );
  assert.deepEqual(plain(reply.changes[0].remainingWeeks).length, TOTAL_WEEKS - 1);
  assert.equal(reply.changes[0].defaultChecked, true);

  const unknown = parseNoticeReply(
    noticeOk([{ action: 'cancel', courseName: '高等数学', weekText: '第12周', quote: '第 12 周停课' }]),
    everyWeek,
    0,
  );
  assert.match(unknown.changes[0].blocked, /总周数/u);
  assert.equal(unknown.changes[0].defaultChecked, false);
});

test('写入计划:按勾选顺序生成,停课/改地点走 update、补课走 create,内容正确', () => {
  const { parseNoticeReply, applyPlan, snapshotInput } = notice();
  const reply = parseNoticeReply(noticeOk(designChanges()), COURSES, TOTAL_WEEKS);
  const steps = applyPlan(reply.changes, COURSES, TOTAL_WEEKS);
  assert.equal(steps.length, 3, '三条都已勾选（冲突那条也仍然可以勾）');
  assert.deepEqual(plain(steps.map((step) => step.kind)), ['update', 'update', 'create']);
  assert.deepEqual(plain(steps.map((step) => step.changeIndex)), [0, 1, 2], '顺序与提案一致');

  // 停课：只改周次，其余字段原样带过来
  const cancel = steps[0];
  assert.equal(cancel.courseId, 'tc_math');
  assert.deepEqual(plain(cancel.input.weeks), [11, 13]);
  assert.equal(cancel.input.weekText, '11、13');
  assert.equal(cancel.input.name, '高等数学');
  assert.equal(cancel.input.teacher, '林加燕');
  assert.equal(cancel.input.location, '崇礼楼-306');
  assert.equal(cancel.input.source, 'excel', '来源不会被改成 manual');
  assert.deepEqual(plain(cancel.before), plain(snapshotInput(COURSES[0])), 'before 是写入前的完整快照');

  // 改地点：只改地点
  const relocate = steps[1];
  assert.equal(relocate.courseId, 'tc_web');
  assert.equal(relocate.input.location, '博雅楼-B604');
  assert.equal(relocate.input.name, '网页设计与制作');
  assert.deepEqual(plain(relocate.input.weeks), [11, 12, 13, 14, 15, 16, 17, 18], '没改的周次原样保留');
  assert.deepEqual(plain(relocate.input.sectionRanges), [{ start: 3, end: 4 }]);

  // 补课：新增一条，来源 manual，周次解析成 [13]
  const add = steps[2];
  assert.equal(add.kind, 'create');
  assert.equal(add.courseId, '');
  assert.equal(add.before, null);
  assert.equal(add.input.name, '高等数学');
  assert.equal(add.input.weekday, 5);
  assert.deepEqual(plain(add.input.sectionRanges), [{ start: 5, end: 6 }]);
  assert.deepEqual(plain(add.input.weeks), [13]);
  assert.equal(add.input.source, 'manual');
});

test('写入计划:被标阻塞的条目跳过,不会写出一条空数据', () => {
  const { parseNoticeReply, applyPlan } = notice();
  const reply = parseNoticeReply(
    noticeOk([
      { action: 'cancel', courseName: '不存在的课', weekText: '第12周', quote: 'x' },
      designChanges()[1],
    ]),
    COURSES,
    TOTAL_WEEKS,
  );
  const steps = applyPlan(reply.changes, COURSES, TOTAL_WEEKS);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].changeIndex, 1, 'changeIndex 仍然对回原提案');
  assert.equal(steps[0].courseId, 'tc_web');
});

test('写入计划:解析之后课程被删掉时跳过该条,不写坏数据', () => {
  const { parseNoticeReply, applyPlan } = notice();
  const reply = parseNoticeReply(noticeOk(designChanges()), COURSES, TOTAL_WEEKS);
  // 解析后课表里少了 tc_web（比如学生在别处删了）
  const steps = applyPlan(reply.changes, COURSES.filter((course) => course.id !== 'tc_web'), TOTAL_WEEKS);
  assert.deepEqual(plain(steps.map((step) => step.courseId)), ['tc_math', '']);
});

test('撤销计划:分批写入的逆操作倒序执行——新增的删除、改动的写回旧值', () => {
  const { parseNoticeReply, applyPlan, invertPlan } = notice();
  const reply = parseNoticeReply(noticeOk(designChanges()), COURSES, TOTAL_WEEKS);
  const steps = applyPlan(reply.changes, COURSES, TOTAL_WEEKS);
  // 模拟页面写入成功后的记录：create 之后才有 id
  const applied = steps.map((step, index) => ({
    changeIndex: step.changeIndex,
    kind: step.kind,
    courseId: step.kind === 'create' ? `tc_new_${index}` : step.courseId,
    before: step.before,
    after: step.input,
    summary: step.summary,
  }));
  const inverse = invertPlan(applied);
  assert.equal(inverse.length, 3);
  // 倒序：先撤销最后一条补课（删除新记录），再还原改地点，最后还原停课
  assert.deepEqual(plain(inverse.map((step) => step.kind)), ['delete', 'update', 'update']);
  assert.equal(inverse[0].courseId, 'tc_new_2');
  assert.equal(inverse[1].courseId, 'tc_web');
  assert.equal(inverse[1].input.location, '博雅楼-B310', '写回改动前的地点');
  assert.equal(inverse[2].courseId, 'tc_math');
  assert.deepEqual(plain(inverse[2].input.weeks), [11, 12, 13], '写回改动前的周次');
});

test('撤销计划:只成功了一部分时只还原真正写入的那些', () => {
  const { parseNoticeReply, applyPlan, invertPlan } = notice();
  const reply = parseNoticeReply(noticeOk(designChanges()), COURSES, TOTAL_WEEKS);
  const steps = applyPlan(reply.changes, COURSES, TOTAL_WEEKS);
  const applied = [{ changeIndex: 1, kind: 'update', courseId: steps[1].courseId, before: steps[1].before, after: steps[1].input, summary: steps[1].summary }];
  const inverse = invertPlan(applied);
  assert.equal(inverse.length, 1);
  assert.equal(inverse[0].courseId, 'tc_web');
  assert.equal(inverse[0].input.location, '博雅楼-B310');
});

test('撤销窗口常量是 10 秒,页面与文案共用同一个来源', () => {
  const { NOTICE_UNDO_MS } = notice();
  assert.equal(NOTICE_UNDO_MS, 10000);
});

test('解析:改时间同时携带星期与节次,差异行展示当前值 → 变更后', () => {
  const { parseNoticeReply, applyPlan } = notice();
  const reply = parseNoticeReply(
    noticeOk([{
      action: 'move', courseName: '高等数学', quote: '高数改到周五第 5-6 节',
      weekday: 5, startSection: 5, endSection: 6, weekText: '',
    }]),
    COURSES,
    TOTAL_WEEKS,
  );
  assert.equal(reply.kind, 'changes');
  const change = reply.changes[0];
  assert.match(change.diffs[0].old, /星期一 第 1-2 节/u);
  assert.match(change.diffs[0].next, /星期五 第 5-6 节/u);
  const steps = applyPlan(reply.changes, COURSES, TOTAL_WEEKS);
  assert.equal(steps[0].input.weekday, 5);
  assert.deepEqual(plain(steps[0].input.sectionRanges), [{ start: 5, end: 6 }]);
  assert.deepEqual(plain(steps[0].input.weeks), [11, 12, 13], '改时间不动周次');
});

test('解析:改时间撞上同一时段已有课时同样提示冲突且默认不勾选', () => {
  const { parseNoticeReply } = notice();
  // 把高数改到周五 5-6 节、第 13 周 → 与中华传统文化精粹冲突
  const reply = parseNoticeReply(
    noticeOk([{
      action: 'move', courseName: '高等数学', quote: '高数改到周五第 5-6 节',
      weekday: 5, startSection: 5, endSection: 6, weekText: '',
    }]),
    COURSES,
    TOTAL_WEEKS,
  );
  // 高数第 11-13 周与精粹第 13 周有交集
  assert.match(reply.changes[0].conflict, /中华传统文化精粹/u);
  assert.equal(reply.changes[0].defaultChecked, false);
});

test('解析:模型写的 conflict 只作参考,结论以系统按课表算出来的为准', () => {
  const { parseNoticeReply } = notice();
  const changes = [designChanges()[2]];
  // 模型说没冲突，但课表里明明撞了
  changes[0] = { ...changes[0], conflict: '' };
  const conflict = parseNoticeReply(noticeOk(changes), COURSES, TOTAL_WEEKS);
  assert.match(conflict.changes[0].conflict, /中华传统文化精粹/u);

  // 模型说有冲突，但课表里其实没撞（第 7 周）
  changes[0] = { ...changes[0], weekText: '第7周', conflict: '和中某门课冲突' };
  const free = parseNoticeReply(noticeOk(changes), COURSES, TOTAL_WEEKS);
  assert.equal(free.changes[0].conflict, '', '系统的冲突判定覆盖模型的说法');
  assert.equal(free.changes[0].defaultChecked, true);
});
