const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const XLSX = require('xlsx');

const FUNCTION_FILE = path.resolve('dist/cloudfunctions/timetable/index.js');
const FIXTURES = path.resolve('tests/fixtures/timetable');
const STANDARD_FIXTURE = '2026-2027学年第一学期班级课表.xls';

// 只替换云存储、数据库与调用上下文；运行真实的云函数入口、真实解析器与校验逻辑。
function harness(options = {}) {
  const docs = [];
  let stagedAdds = 0;
  const storage = new Map();
  const calls = { downloads: [], deletes: [], openid: '' };

  function match(doc, condition) {
    return Object.entries(condition).every(([key, expected]) => {
      if (expected !== null && typeof expected === 'object' && '__neq' in expected) return doc[key] !== expected.__neq;
      return doc[key] === expected;
    });
  }

  const db = {
    command: { neq: (value) => ({ __neq: value }) },
    collection() {
      const state = { condition: null, skip: 0, limit: 100 };
      const api = {
        where(condition) { state.condition = condition; return api; },
        skip(value) { state.skip = value; return api; },
        limit(value) { state.limit = value; return api; },
        orderBy() { return api; },
        async get() {
          const rows = docs.filter((doc) => state.condition === null || match(doc, state.condition));
          return { data: rows.slice(state.skip, state.skip + state.limit) };
        },
        async remove() {
          if (options.failOldBatchDelete && state.condition?.staged?.__neq !== undefined) {
            throw new Error('旧批次清理暂时失败');
          }
          if (options.failStagedDelete && typeof state.condition?.batch === 'string') {
            throw new Error('暂存批次清理暂时失败');
          }
          const keep = docs.filter((doc) => state.condition === null || !match(doc, state.condition));
          const removed = docs.length - keep.length;
          docs.length = 0;
          docs.push(...keep);
          return { stats: { removed } };
        },
        async add({ data }) {
          if (data.staged === true) {
            stagedAdds += 1;
            if (stagedAdds === options.failStagedAddAt) throw new Error('课程写入暂时失败');
          }
          const doc = { _id: `doc-${docs.length + 1}`, ...data };
          docs.push(doc);
          return { _id: doc._id };
        },
        doc(id) {
          return {
            async get() {
              const doc = docs.find((item) => item._id === id);
              if (doc === undefined) throw new Error('document does not exist');
              return { data: doc };
            },
            async set({ data }) {
              if (options.failHeadSet && id.startsWith('timetable-head-')) throw new Error('批次提交失败');
              const doc = docs.find((item) => item._id === id);
              if (doc === undefined) docs.push({ _id: id, ...data });
              else Object.assign(doc, data);
              if (id.startsWith('timetable-head-')) options.afterHeadSet?.(docs, data);
              if (options.failHeadSetAfterWrite && id.startsWith('timetable-head-')) throw new Error('批次提交响应丢失');
              return { stats: { updated: 1 } };
            },
            async update({ data }) {
              const doc = docs.find((item) => item._id === id);
              if (doc === undefined) throw new Error('document not exists');
              Object.assign(doc, data);
              return { stats: { updated: 1 } };
            },
            async remove() {
              const index = docs.findIndex((item) => item._id === id);
              if (index < 0) throw new Error('document not exists');
              docs.splice(index, 1);
              return { stats: { removed: 1 } };
            },
          };
        },
      };
      return api;
    },
  };

  const cloud = {
    init() {},
    DYNAMIC_CURRENT_ENV: 'dynamic',
    database: () => db,
    getWXContext: () => ({ OPENID: calls.openid }),
    async downloadFile({ fileID }) {
      calls.downloads.push(fileID);
      if (!storage.has(fileID)) throw new Error('file not found');
      return { fileContent: storage.get(fileID) };
    },
    async deleteFile({ fileList }) {
      calls.deletes.push(...fileList);
      for (const fileID of fileList) {
        if (!storage.has(fileID)) throw new Error('file not found');
        storage.delete(fileID);
      }
      return { fileList: fileList.map((fileID) => ({ fileID, status: 0 })) };
    },
  };

  const realRequire = require('module').createRequire(FUNCTION_FILE);
  const context = {
    exports: {}, Buffer, console, process,
    require(name) {
      if (name === 'wx-server-sdk') return cloud;
      return realRequire(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(FUNCTION_FILE, 'utf8'), context, { filename: FUNCTION_FILE });
  const run = (openid, event) => {
    calls.openid = openid;
    return context.exports.main(event);
  };
  return { run, docs, storage, calls };
}

function ownerPrefix(openid) {
  const digest = crypto.createHash('sha256').update(openid).digest('hex').slice(0, 16);
  return `timetable-imports/${digest}/`;
}

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
      docs.push({ ...previous, _id: 'manual-after-head', id: 'tc_manual-after-head', name: '并发手工课', batch: head.activeBatch });
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
  const h = harness({ failStagedAddAt: 2, failStagedDelete: true });
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
