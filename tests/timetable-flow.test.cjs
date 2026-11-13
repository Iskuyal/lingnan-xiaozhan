const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const XLSX = require('xlsx');
const { harness } = require('./lib/timetable-harness.cjs');

const FIXTURES = path.resolve('tests/fixtures/timetable');
const STANDARD_FIXTURE = '2026-2027学年第一学期班级课表.xls';

test('限定周次调课：无效周次整项拒绝，既不修改原课也不新增课程', async () => {
  const h = harness();
  const created = await h.run('scope-owner', { action: 'createCourse', course: {
    name: '数学', weekday: 3, sectionRanges: [{ start: 3, end: 4 }], weeks: [11, 12, 13], weeksRecognized: true, weekText: '11-13',
  } });
  const before = JSON.parse(JSON.stringify((await h.run('scope-owner', { action: 'list' })).courses));
  for (const weeks of [[], [0], [31], [12.5], ['12']]) {
    const result = await h.run('scope-owner', { action: 'applyScopedChange', id: created.course.id,
      requestId: 'scope-invalid-request', weeks, course: { location: 'B604' }, expected: created.course });
    assert.equal(result.ok, false);
    assert.match(result.error, /周次/u);
  }
  assert.deepEqual(JSON.parse(JSON.stringify((await h.run('scope-owner', { action: 'list' })).courses)), before);
});


function ownerPrefix(openid) {
  const digest = crypto.createHash('sha256').update(openid).digest('hex').slice(0, 16);
  return `timetable-imports/${digest}/`;
}

async function scopedFixture(h, overrides = {}) {
  const created = await h.run('scope-owner', { action: 'createCourse', course: {
    name: '数学', weekday: 3, sectionRanges: [{ start: 3, end: 4 }], weeks: [11, 12, 13],
    weeksRecognized: true, weekText: '11-13', location: 'B602', teacher: '示例教师', color: 'c2', ...overrides,
  } });
  assert.equal(created.ok, true);
  return { action: 'applyScopedChange', id: created.course.id, requestId: 'scope-valid-request',
    weeks: [12], course: { weekday: 5, sectionRanges: [{ start: 5, end: 6 }], location: 'B604' }, expected: created.course };
}

test('限定周次调课：数据库返回保留标识时仍可撤销并再次读取', async () => {
  const h = harness();
  const event = await scopedFixture(h);
  assert.equal((await h.run('scope-owner', event)).ok, true);
  const undone = await h.run('scope-owner', { action: 'undoScopedChange', requestId: event.requestId });
  assert.equal(undone.ok, true, undone.error);
  const courses = (await h.run('scope-owner', { action: 'list' })).courses;
  assert.equal(courses.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(courses[0].weeks)), [11, 12, 13]);
  assert.equal((await h.run('scope-owner', { action: 'undoScopedChange', requestId: event.requestId })).repeated, true);
});

test('限定周次调课：仅第12周改变时间地点，其他周保持原样，整项撤销', async () => {
  const h = harness();
  const event = await scopedFixture(h);
  const result = await h.run('scope-owner', event);
  assert.equal(result.ok, true, result.error);
  const courses = JSON.parse(JSON.stringify((await h.run('scope-owner', { action: 'list' })).courses));
  assert.equal(courses.length, 2, '凭据不能作为课程返回');
  const original = courses.find((c) => c.id === event.id);
  const moved = courses.find((c) => c.id !== event.id);
  assert.deepEqual(original.weeks, [11, 13]);
  assert.equal(original.weekday, 3); assert.equal(original.location, 'B602');
  assert.deepEqual(moved.weeks, [12]); assert.equal(moved.weekday, 5); assert.equal(moved.location, 'B604');
  assert.equal(moved.teacher, '示例教师'); assert.equal(moved.color, 'c2');
  const undone = await h.run('scope-owner', { action: 'undoScopedChange', requestId: event.requestId });
  assert.equal(undone.ok, true, undone.error);
  const restored = JSON.parse(JSON.stringify((await h.run('scope-owner', { action: 'list' })).courses));
  assert.equal(restored.length, 1); assert.equal(restored[0].id, event.id);
  assert.deepEqual(restored[0].weeks, [11, 12, 13]); assert.equal(restored[0].location, 'B602');
});

test('限定周次调课：事务中第二次写入失败，原课与新课均没有半成品', async () => {
  const h = harness({ failTransactionWriteAt: 2 });
  const event = await scopedFixture(h);
  assert.equal((await h.run('scope-owner', event)).ok, false);
  const courses = JSON.parse(JSON.stringify((await h.run('scope-owner', { action: 'list' })).courses));
  assert.equal(courses.length, 1); assert.deepEqual(courses[0].weeks, [11, 12, 13]);
});

test('限定周次调课：提交响应丢失后同编号重试不重复拆课，撤销也可幂等重试', async () => {
  const options = { loseScopedResponse: true };
  const h = harness(options);
  const event = await scopedFixture(h);
  assert.equal((await h.run('scope-owner', event)).ok, false);
  const retry = await h.run('scope-owner', event);
  assert.equal(retry.ok, true, retry.error); assert.equal(retry.repeated, true);
  assert.equal((await h.run('scope-owner', { action: 'list' })).courses.length, 2);
  const undo = { action: 'undoScopedChange', requestId: event.requestId };
  assert.equal((await h.run('scope-owner', undo)).ok, true);
  assert.equal((await h.run('scope-owner', undo)).repeated, true);
  assert.equal((await h.run('scope-owner', { action: 'list' })).courses.length, 1);
});

test('限定周次调课：其他身份不能改或撤销，后续手工修改不会被旧撤销覆盖', async () => {
  const h = harness(); const event = await scopedFixture(h);
  assert.equal((await h.run('other-owner', event)).ok, false);
  assert.equal((await h.run('scope-owner', event)).ok, true);
  assert.equal((await h.run('other-owner', { action: 'undoScopedChange', requestId: event.requestId })).ok, false);
  await h.run('scope-owner', { action: 'updateCourse', id: event.id, course: { location: '手工的新教室' } });
  const undo = await h.run('scope-owner', { action: 'undoScopedChange', requestId: event.requestId });
  assert.equal(undo.ok, false); assert.match(undo.error, /后续修改|又发生变化/u);
  const courses = (await h.run('scope-owner', { action: 'list' })).courses;
  assert.equal(courses.length, 2); assert.equal(courses.find((c) => c.id === event.id).location, '手工的新教室');
});

test('限定周次调课：覆盖原课全部周次时原位更新，不产生空周次的课程', async () => {
  const h = harness(); const event = await scopedFixture(h, { weeks: [12], weekText: '12' });
  assert.equal((await h.run('scope-owner', event)).ok, true);
  const courses = (await h.run('scope-owner', { action: 'list' })).courses;
  assert.equal(courses.length, 1); assert.equal(courses[0].id, event.id); assert.equal(courses[0].location, 'B604');
});

test('限定周次调课：每周课先要求总周数，30周拆分后周次文本仍能保存和编辑', async () => {
  const h = harness(); const event = await scopedFixture(h, { weeks: [], weekText: '', weeksRecognized: true });
  const unknown = await h.run('scope-owner', event);
  assert.equal(unknown.ok, false); assert.match(unknown.error, /总周数/u);
  await h.run('scope-owner', { action: 'saveSettings', settings: {
    semesterName: '', startDate: '2026-09-21', totalWeeks: 30,
    sectionTimes: Array.from({ length: 12 }, () => ({ start: '', end: '' })),
  } });
  event.weeks = Array.from({ length: 29 }, (_, i) => i + 1);
  const applied = await h.run('scope-owner', event);
  assert.equal(applied.ok, true, applied.error);
  const courses = (await h.run('scope-owner', { action: 'list' })).courses;
  assert.equal(courses.length, 2); assert.ok(courses.every((course) => course.weekText.length <= 40));
  assert.equal((await h.run('scope-owner', { action: 'updateCourse', id: event.id, course: { location: '还可编辑' } })).ok, true);
});

/** 云存储 fileID 的真实形状：cloud://环境.桶/<云存储路径>。 */
const FILE_ID_BASE = 'cloud://test-env.test-bucket';

function fileIDFor(cloudPath) {
  return `${FILE_ID_BASE}/${cloudPath}`;
}

/** 放一份 fixture 到云存储桩里，返回它的裸路径与 fileID（云函数只接受后者）。 */
function uploadFixture(h, openid, fileName = STANDARD_FIXTURE) {
  const cloudPath = `${ownerPrefix(openid)}test${path.extname(fileName)}`;
  const fileID = fileIDFor(cloudPath);
  h.storage.set(fileID, fs.readFileSync(path.join(FIXTURES, fileName)));
  return { cloudPath, fileID };
}

const STUDENT_A = 'openid-student-a';
const STUDENT_B = 'openid-student-b';

test('导入只解析不写库：草稿返回真实样本的课程，临时文件被删除', async () => {
  const h = harness();
  const { fileID } = uploadFixture(h, STUDENT_A);
  const prepared = await h.run(STUDENT_A, { action: 'prepareUpload', fileName: STANDARD_FIXTURE });
  assert.equal(prepared.ok, true);
  assert.ok(prepared.cloudPath.startsWith(ownerPrefix(STUDENT_A)), '上传路径必须落在本人 openid 前缀下');
  assert.match(prepared.cloudPath, /\.xls$/u);

  const result = await h.run(STUDENT_A, { action: 'importDraft', fileID, fileName: STANDARD_FIXTURE });
  assert.equal(result.ok, true);
  assert.equal(result.draft.courses.length, 15, '真实样本解析出的课程数');
  assert.equal(result.draft.meta.semester, '2026-2027学年第一学期');
  assert.equal(result.tempFileDeleted, true);
  assert.deepEqual(h.calls.deletes, [fileID], '解析后临时文件必须删除');
  assert.equal(h.docs.length, 0, '解析阶段不得写入任何课表记录');
  assert.match(result.note, /未写入/u);
});

test('fileID 形态下归属校验仍生效：裸 cloudPath 与别人的 fileID 都被拒', async () => {
  const h = harness();
  // 自己上传的文件：downloadFile 收到的必须是 fileID（下载接口不认裸路径）。
  const mine = uploadFixture(h, STUDENT_A);
  const ok = await h.run(STUDENT_A, { action: 'importDraft', fileID: mine.fileID, fileName: STANDARD_FIXTURE });
  assert.equal(ok.ok, true);
  assert.deepEqual(h.calls.downloads, [mine.fileID], '下载必须用 fileID');

  // Ticket 03 的老写法：把 prepareUpload 返回的裸 cloudPath 当 fileID 传——必须明确拒绝，
  // 而不是拿它去 downloadFile 撞一个指错方向的失败。
  const bare = await h.run(STUDENT_A, { action: 'importDraft', cloudPath: mine.cloudPath, fileName: STANDARD_FIXTURE });
  assert.equal(bare.ok, false);
  assert.match(bare.error, /fileID/u);

  // 别人（另一个 openid 前缀）的 fileID。
  const other = uploadFixture(h, STUDENT_B);
  const cross = await h.run(STUDENT_A, { action: 'importDraft', fileID: other.fileID, fileName: STANDARD_FIXTURE });
  assert.equal(cross.ok, false);
  assert.match(cross.error, /不属于当前微信身份/u);
  assert.equal(h.storage.has(other.fileID), true, '也不应删除别人的文件');

  // 换了环境前缀、但路径不属于本人的 fileID：校验的是从 fileID 解析出的路径。
  const forged = await h.run(STUDENT_A, { action: 'importDraft', fileID: fileIDFor(`${ownerPrefix(STUDENT_B)}stolen.xls`), fileName: STANDARD_FIXTURE });
  assert.equal(forged.ok, false);
  assert.match(forged.error, /不属于当前微信身份/u);

  // 路径穿越同样被挡。
  const traversal = await h.run(STUDENT_A, { action: 'importDraft', fileID: fileIDFor(`${ownerPrefix(STUDENT_A)}../other/x.xls`), fileName: STANDARD_FIXTURE });
  assert.equal(traversal.ok, false);
  assert.match(traversal.error, /不属于当前微信身份/u);

  // 清理接口同样只认本人 fileID。
  const discardOther = await h.run(STUDENT_A, { action: 'discardUpload', fileID: other.fileID });
  assert.equal(discardOther.ok, false);
  assert.match(discardOther.error, /不属于当前微信身份/u);
  const discardBare = await h.run(STUDENT_A, { action: 'discardUpload', cloudPath: mine.cloudPath });
  assert.equal(discardBare.ok, false);
  assert.match(discardBare.error, /fileID/u);
  const leftovers = uploadFixture(h, STUDENT_A);
  const discardMine = await h.run(STUDENT_A, { action: 'discardUpload', fileID: leftovers.fileID });
  assert.equal(discardMine.ok, true);
  assert.equal(discardMine.deleted, true);
  assert.equal(h.storage.has(leftovers.fileID), false);
});

test('解析失败给出可理解的提示，不写入半成品，临时文件照样删除', async () => {
  const h = harness();
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['成绩表'], ['学号', '成绩'], ['1001', '90']]), 'Sheet1');
  const fileID = fileIDFor(`${ownerPrefix(STUDENT_A)}grades.xlsx`);
  h.storage.set(fileID, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));

  const result = await h.run(STUDENT_A, { action: 'importDraft', fileID, fileName: '成绩表.xlsx' });
  assert.equal(result.ok, false);
  assert.match(result.error, /未识别出课表矩阵/u);
  assert.deepEqual(h.calls.deletes, [fileID]);
  assert.equal(h.docs.length, 0);
});

test('上传前先校验扩展名，非法格式直接拒绝', async () => {
  const h = harness();
  for (const fileName of ['课表.txt', '课表', '课表.pdf']) {
    const result = await h.run(STUDENT_A, { action: 'prepareUpload', fileName });
    assert.equal(result.ok, false, fileName);
    assert.match(result.error, /\.xls|\.xlsx/u);
  }
});

test('不同学生只能看到自己的课表，写入只发生在本人的记录上', async () => {
  const h = harness();
  const draftA = (await h.run(STUDENT_A, { action: 'importDraft', fileID: uploadFixture(h, STUDENT_A).fileID, fileName: STANDARD_FIXTURE })).draft;
  const savedA = await h.run(STUDENT_A, { action: 'saveDraft', courses: draftA.courses.slice(0, 3), semester: draftA.meta.semester });
  assert.equal(savedA.ok, true);
  assert.equal(savedA.saved, 3);

  const listB = await h.run(STUDENT_B, { action: 'list' });
  assert.equal(listB.count, 0, '学生 B 看不到学生 A 的课表');

  const createdB = await h.run(STUDENT_B, { action: 'createCourse', semester: '', course: { name: '手工加的课', weekday: 3, sectionRanges: [{ start: 5, end: 6 }], weeks: [1, 2, 3], weeksRecognized: true, weekText: '1-3周' } });
  assert.equal(createdB.ok, true);

  const listA = await h.run(STUDENT_A, { action: 'list' });
  assert.equal(listA.count, 3, '学生 B 的操作不影响学生 A 的课表');
  assert.equal(listA.semester, '2026-2027学年第一学期');
  assert.ok(listA.courses.every((course) => course.name !== '手工加的课'));
  assert.ok(listA.courses.every((course) => course.owner === ''), '返回给客户端的记录不带 owner');

  const listB2 = await h.run(STUDENT_B, { action: 'list' });
  assert.equal(listB2.count, 1);
  assert.equal(listB2.courses[0].name, '手工加的课');
  assert.equal(listB2.courses[0].source, 'manual');
  assert.equal(listB2.semester, '', '学生 B 没有学期标注');
});

test('确认保存＝整份替换：旧批次被清理，重复导入不会重复堆叠', async () => {
  const h = harness();
  const draft = (await h.run(STUDENT_A, { action: 'importDraft', fileID: uploadFixture(h, STUDENT_A).fileID, fileName: STANDARD_FIXTURE })).draft;
  await h.run(STUDENT_A, { action: 'saveDraft', courses: draft.courses, semester: draft.meta.semester });
  assert.equal((await h.run(STUDENT_A, { action: 'list' })).count, 15);

  const second = await h.run(STUDENT_A, { action: 'saveDraft', courses: draft.courses.slice(0, 4), semester: draft.meta.semester });
  assert.equal(second.ok, true);
  const list = await h.run(STUDENT_A, { action: 'list' });
  assert.equal(list.count, 4, '第二次保存只保留新批次的记录');
});

test('旧批次清理失败时，新课表仍完整可见且旧课程不会混入', async () => {
  const options = { failOldBatchDelete: true };
  const h = harness(options);
  await h.run(STUDENT_A, { action: 'createCourse', course: { name: '旧课程', weekday: 1, sectionRanges: [{ start: 1, end: 2 }] } });

  const result = await h.run(STUDENT_A, {
    action: 'saveDraft',
    courses: [{ name: '新课程', weekday: 2, sectionRanges: [{ start: 3, end: 4 }] }],
  });
  assert.equal(result.ok, true, '可见批次已切换，旧记录清理失败不应把保存报成失败');
  assert.equal(result.cleanupPending, true, '清理失败要明确留痕');
  const visible = await h.run(STUDENT_A, { action: 'list' });
  assert.equal(visible.count, 1);
  assert.equal(visible.courses[0].name, '新课程');

  options.failOldBatchDelete = false;
  await h.run(STUDENT_A, { action: 'list' });
  assert.equal(h.docs.filter((doc) => doc.name === '旧课程').length, 0, '下次读取应补清旧记录');
});

test('旧批次清理不会删掉切换后新增到当前批次的手工课程', async () => {
  const h = harness({
    afterHeadSet(docs, head) {
      const previous = docs.find((doc) => doc.name === '旧课程');
      docs.push({ ...previous, _id: 'manual-after-head', id: 'tc_manual-after-head', name: '并发手工课', batch: head.activeBatch, headBound: true });
    },
  });
  await h.run(STUDENT_A, { action: 'createCourse', course: { name: '旧课程', weekday: 1, sectionRanges: [{ start: 1, end: 2 }] } });
  const result = await h.run(STUDENT_A, {
    action: 'saveDraft', courses: [{ name: '新课程', weekday: 2, sectionRanges: [{ start: 3, end: 4 }] }],
  });
  assert.equal(result.ok, true);
  const visible = await h.run(STUDENT_A, { action: 'list' });
  assert.equal(visible.count, 2);
  assert.ok(visible.courses.some((course) => course.name === '新课程'));
  assert.ok(visible.courses.some((course) => course.name === '并发手工课'));
});

test('导入切换与手工新增交错时，不能报告成功却把课程写进旧批次', async () => {
  const options = {};
  const h = harness(options);
  await h.run(STUDENT_A, { action: 'createCourse', course: { name: '旧课程', weekday: 1, sectionRanges: [{ start: 1, end: 2 }] } });
  options.beforeConcurrentManualAdd = async () => {
    const saved = await h.run(STUDENT_A, {
      action: 'saveDraft', courses: [{ name: '新课表课程', weekday: 2, sectionRanges: [{ start: 3, end: 4 }] }],
    });
    assert.equal(saved.ok, true);
  };
  const created = await h.run(STUDENT_A, {
    action: 'createCourse', course: { name: '并发新增', weekday: 4, sectionRanges: [{ start: 5, end: 6 }] },
  });
  assert.equal(created.ok, false, '如果并发导入覆盖了新增，应明确返回冲突而非成功');
  assert.match(created.error, /重新导入|冲突/u);
  const visible = await h.run(STUDENT_A, { action: 'list' });
  assert.equal(visible.count, 1);
  assert.equal(visible.courses[0].name, '新课表课程');
});

test('首次导入的旧数据清理不会误删后续导入批次的手工课程', async () => {
  const options = {};
  const h = harness(options);
  await h.run(STUDENT_A, { action: 'createCourse', course: { name: '最早的课程', weekday: 1, sectionRanges: [{ start: 1, end: 2 }] } });
  options.afterHeadSet = async () => {
    options.afterHeadSet = null;
    const later = await h.run(STUDENT_A, {
      action: 'saveDraft', courses: [{ name: '第二次导入', weekday: 2, sectionRanges: [{ start: 3, end: 4 }] }],
    });
    assert.equal(later.ok, true);
    const manual = await h.run(STUDENT_A, {
      action: 'createCourse', course: { name: '后续手工课程', weekday: 3, sectionRanges: [{ start: 5, end: 6 }] },
    });
    assert.equal(manual.ok, true);
  };
  const first = await h.run(STUDENT_A, {
    action: 'saveDraft', courses: [{ name: '第一次导入', weekday: 4, sectionRanges: [{ start: 7, end: 8 }] }],
  });
  assert.equal(first.ok, true);
  const visible = await h.run(STUDENT_A, { action: 'list' });
  assert.equal(visible.count, 2);
  assert.ok(visible.courses.some((course) => course.name === '第二次导入'));
  assert.ok(visible.courses.some((course) => course.name === '后续手工课程'));
});

test('旧导入请求不能清除后续导入的待清理标记', async () => {
  const options = {};
  const h = harness(options);
  await h.run(STUDENT_A, { action: 'createCourse', course: { name: '最早的课程', weekday: 1, sectionRanges: [{ start: 1, end: 2 }] } });
  options.afterHeadSet = async (_docs, firstHead) => {
    options.afterHeadSet = null;
    options.failCleanupBatch = firstHead.activeBatch;
    const later = await h.run(STUDENT_A, {
      action: 'saveDraft', courses: [{ name: '第二次导入', weekday: 2, sectionRanges: [{ start: 3, end: 4 }] }],
    });
    assert.equal(later.ok, true);
    assert.equal(later.cleanupPending, true);
  };
  await h.run(STUDENT_A, {
    action: 'saveDraft', courses: [{ name: '第一次导入', weekday: 4, sectionRanges: [{ start: 7, end: 8 }] }],
  });
  const head = h.docs.find((doc) => String(doc._id).startsWith('timetable-head-'));
  assert.equal(head.cleanupPending, true, '后续导入的清理失败仍须在标记中保留');
});

test('导入切换与手工修改交错时，不把已失效课程的修改报告为成功', async () => {
  const options = { failOldBatchDelete: true };
  const h = harness(options);
  const original = await h.run(STUDENT_A, {
    action: 'createCourse', course: { name: '旧课程', weekday: 1, sectionRanges: [{ start: 1, end: 2 }] },
  });
  options.beforeConcurrentUpdate = async () => {
    const saved = await h.run(STUDENT_A, {
      action: 'saveDraft', courses: [{ name: '新课表课程', weekday: 2, sectionRanges: [{ start: 3, end: 4 }] }],
    });
    assert.equal(saved.ok, true);
  };
  const changed = await h.run(STUDENT_A, {
    action: 'updateCourse', id: original.course.id, course: { name: '并发修改' },
  });
  assert.equal(changed.ok, false);
  assert.match(changed.error, /重新导入/u);
  const visible = await h.run(STUDENT_A, { action: 'list' });
  assert.equal(visible.count, 1);
  assert.equal(visible.courses[0].name, '新课表课程');
});

test('批次提交响应丢失后，读取提交状态，不删除已经生效的新课表', async () => {
  const h = harness({ failHeadSetAfterWrite: true });
  await h.run(STUDENT_A, { action: 'createCourse', course: { name: '旧课程', weekday: 1, sectionRanges: [{ start: 1, end: 2 }] } });
  const result = await h.run(STUDENT_A, {
    action: 'saveDraft', courses: [{ name: '新课程', weekday: 2, sectionRanges: [{ start: 3, end: 4 }] }],
  });
  assert.equal(result.ok, true, '提交已经生效，只是应答丢失');
  const visible = await h.run(STUDENT_A, { action: 'list' });
  assert.equal(visible.count, 1);
  assert.equal(visible.courses[0].name, '新课程');
});

test('暂存写入与清理同时失败时，旧课表仍可见且错误不谎称已回滚', async () => {
  const options = { failStagedAddAt: 2, failStagedDelete: true };
  const h = harness(options);
  await h.run(STUDENT_A, { action: 'createCourse', course: { name: '旧课程', weekday: 1, sectionRanges: [{ start: 1, end: 2 }] } });
  const result = await h.run(STUDENT_A, {
    action: 'saveDraft',
    courses: [
      { name: '新课程一', weekday: 2, sectionRanges: [{ start: 3, end: 4 }] },
      { name: '新课程二', weekday: 3, sectionRanges: [{ start: 5, end: 6 }] },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /待清理/u);
  assert.doesNotMatch(result.error, /已回滚/u);
  const visible = await h.run(STUDENT_A, { action: 'list' });
  assert.equal(visible.count, 1);
  assert.equal(visible.courses[0].name, '旧课程');

  // 云存储清理恢复后，过期的隐藏批次应在下次读取时得到补清。
  options.failStagedDelete = false;
  for (const row of h.docs.filter((doc) => doc.staged === true)) row.createdAt = '2020-01-01T00:00:00.000Z';
  await h.run(STUDENT_A, { action: 'list' });
  assert.equal(h.docs.filter((doc) => doc.staged === true).length, 0);
});

test('保存时整批校验：有一条不合规就整批不写', async () => {
  const h = harness();
  const good = { name: '高等数学', weekday: 2, sectionRanges: [{ start: 1, end: 2 }], weeks: [1, 2], weeksRecognized: true, weekText: '1-2周' };
  const bad = { name: '没有节次的课', weekday: 2, sectionRanges: [{ start: 5, end: 3 }], weeks: [1], weeksRecognized: true, weekText: '1周' };
  const result = await h.run(STUDENT_A, { action: 'saveDraft', courses: [good, bad], semester: '2026-2027学年第一学期' });
  assert.equal(result.ok, false);
  assert.match(result.error, /第 2 项无法保存/u);
  assert.equal(h.docs.length, 0, '不得留下半成品数据');

  const noSections = await h.run(STUDENT_A, { action: 'saveDraft', courses: [{ name: '缺节次', weekday: 1, sectionRanges: [] }], semester: '' });
  assert.equal(noSections.ok, false);
  assert.match(noSections.error, /缺少节次/u);
  assert.equal(h.docs.length, 0);
});

test('手工新增、修改、删除三条路径各自可用，且只能改自己的记录', async () => {
  const h = harness();
  const created = await h.run(STUDENT_A, { action: 'createCourse', semester: '2026-2027学年第一学期', course: { name: '人工智能导论', teacher: '某某', weekday: 4, sectionRanges: [{ start: 3, end: 4 }], weeks: [1, 2, 3, 4], weeksRecognized: true, weekText: '1-4周', location: '博雅楼-B101-多媒体课室' } });
  assert.equal(created.ok, true);
  const id = created.course.id;
  assert.ok(id.startsWith('tc_'));

  const updated = await h.run(STUDENT_A, { action: 'updateCourse', id, course: { name: '人工智能导论（改）', teacher: '某某', weekday: 4, sectionRanges: [{ start: 3, end: 6 }], weeks: [1, 2], weeksRecognized: true, weekText: '1-2周' } });
  assert.equal(updated.ok, true);
  const list = await h.run(STUDENT_A, { action: 'list' });
  assert.equal(list.count, 1);
  assert.equal(list.courses[0].name, '人工智能导论（改）');
  assert.deepEqual(list.courses[0].sectionRanges, [{ start: 3, end: 6 }]);
  assert.equal(list.courses[0].semester, '2026-2027学年第一学期', '修改不改变学期标注');

  const crossUser = await h.run(STUDENT_B, { action: 'updateCourse', id, course: { name: '偷改', weekday: 4, sectionRanges: [{ start: 3, end: 4 }] } });
  assert.equal(crossUser.ok, false);
  assert.match(crossUser.error, /未找到/u);
  const crossDelete = await h.run(STUDENT_B, { action: 'deleteCourse', id });
  assert.equal(crossDelete.ok, false);
  assert.equal((await h.run(STUDENT_A, { action: 'list' })).count, 1, '学生 B 删不掉学生 A 的课');

  const deleted = await h.run(STUDENT_A, { action: 'deleteCourse', id });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.count, 0);
  assert.equal((await h.run(STUDENT_A, { action: 'list' })).count, 0);

  const again = await h.run(STUDENT_A, { action: 'deleteCourse', id });
  assert.equal(again.ok, false);
  assert.match(again.error, /未找到/u);
});

test('没有微信身份或未知操作时给出明确错误', async () => {
  const h = harness();
  const anonymous = await h.run('', { action: 'list' });
  assert.equal(anonymous.ok, false);
  assert.match(anonymous.error, /微信身份/u);
  const unknown = await h.run(STUDENT_A, { action: '不存在的操作' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /不支持的操作/u);
});

test('修改课程只覆盖显式给出的字段：未给出的保持原值，显式给空才清空', async () => {
  const h = harness();
  const saved = await h.run(STUDENT_A, {
    action: 'saveDraft',
    semester: '2026-2027学年第一学期',
    courses: [{
      name: '高等数学', credits: '1.5', teacher: '林加燕', weekday: 1,
      startSection: 1, endSection: 2, sectionRanges: [{ start: 1, end: 2 }],
      weeks: [1, 2, 3, 4], weeksRecognized: true, weekText: '[1-4]周',
      location: '崇礼楼-306', campus: '清远校区', siteNumber: '44', note: '1班',
      warnings: ['节次已按原文核对'], source: 'excel', rawText: '高等数学 1.5 林加燕 [1-4]周 1-2节',
    }],
  });
  assert.equal(saved.ok, true);
  const id = h.docs[0].id;

  // 只改时间（Ticket 06 的「把高等数学改到周五第 5-6 节」）：其余字段一律保持原值。
  const updated = await h.run(STUDENT_A, { action: 'updateCourse', id, course: { weekday: 5, sectionRanges: [{ start: 5, end: 6 }] } });
  assert.equal(updated.ok, true);
  const row = h.docs[0];
  assert.equal(row.weekday, 5);
  assert.deepEqual(row.sectionRanges, [{ start: 5, end: 6 }]);
  assert.equal(row.startSection, 5);
  assert.equal(row.endSection, 6);
  assert.equal(row.name, '高等数学');
  assert.equal(row.teacher, '林加燕');
  assert.equal(row.location, '崇礼楼-306');
  assert.equal(row.credits, '1.5');
  assert.deepEqual(row.weeks, [1, 2, 3, 4]);
  assert.equal(row.weeksRecognized, true);
  assert.equal(row.weekText, '[1-4]周');
  assert.equal(row.campus, '清远校区');
  assert.equal(row.siteNumber, '44');
  assert.equal(row.note, '1班');
  assert.equal(row.source, 'excel', '修改不改变来源');
  assert.deepEqual(row.warnings, ['节次已按原文核对']);
  assert.equal(row.semester, '2026-2027学年第一学期');
  assert.equal(row.rawText, '高等数学 1.5 林加燕 [1-4]周 1-2节', '原文不受修改影响');

  // 要清空某个字段必须显式给空字符串（手工编辑表单的既有语义不受影响）。
  const cleared = await h.run(STUDENT_A, { action: 'updateCourse', id, course: { teacher: '' } });
  assert.equal(cleared.ok, true);
  assert.equal(h.docs[0].teacher, '');
  assert.equal(h.docs[0].credits, '1.5', '其它字段仍不受影响');

  // 白名单之外（归属、学期、来源）即使传了也不生效。
  const forged = await h.run(STUDENT_A, {
    action: 'updateCourse', id,
    course: { name: '高等数学', source: 'photo', semester: '2099学年', owner: STUDENT_B, createdAt: 'x' },
  });
  assert.equal(forged.ok, true);
  assert.equal(h.docs[0].source, 'excel');
  assert.equal(h.docs[0].semester, '2026-2027学年第一学期');
  assert.equal(h.docs[0].owner, STUDENT_A);
});

test('preparePhotoUpload:仅放行 png/jpg 截图，路径落在本人 openid 前缀下', async () => {
  const h = harness();
  const ok = await h.run(STUDENT_A, { action: 'preparePhotoUpload', fileName: '课表截图.png' });
  assert.equal(ok.ok, true);
  assert.ok(ok.cloudPath.startsWith(ownerPrefix(STUDENT_A)));
  assert.match(ok.cloudPath, /\.png$/u);
  // `.jpeg` 不在白名单里：客户端会把 JPEG 统一归一成 `.jpg` 再申请路径（ai 云函数也认 .jpg），
  // 因此服务端不需要第二个 JPEG 扩展名——留一个「到不了的入口」只会让校验口径含糊。
  for (const fileName of ['课表.gif', '课表.jpeg', '课表.xls', '课表']) {
    const bad = await h.run(STUDENT_A, { action: 'preparePhotoUpload', fileName });
    assert.equal(bad.ok, false, fileName);
    assert.match(bad.error, /png|jpg/u);
  }
  const jpg = await h.run(STUDENT_A, { action: 'preparePhotoUpload', fileName: '课表截图.jpg' });
  assert.equal(jpg.ok, true);
  assert.match(jpg.cloudPath, /\.jpg$/u);
});

test('saveDraft:截图识别来源 photo 入库并被保存', async () => {
  const h = harness();
  const courses = [{
    name: '识别出来的课', teacher: '某某', weekday: 1,
    startSection: 1, endSection: 2, sectionRanges: [{ start: 1, end: 2 }],
    weeks: [1, 2], weeksRecognized: true, weekText: '[1-2]周',
    location: '崇礼楼-306', campus: '', siteNumber: '', note: '',
    warnings: [], source: 'photo', rawText: '', credits: '',
    sourceRowLabel: '', sourceWeekdayLabel: '',
  }];
  const saved = await h.run(STUDENT_A, { action: 'saveDraft', courses, semester: '2026-2027学年第一学期' });
  assert.equal(saved.ok, true);
  const list = await h.run(STUDENT_A, { action: 'list' });
  assert.equal(list.courses[0].source, 'photo');
});
