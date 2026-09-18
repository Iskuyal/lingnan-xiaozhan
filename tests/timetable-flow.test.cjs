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
function harness() {
  const docs = [];
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
          const keep = docs.filter((doc) => state.condition === null || !match(doc, state.condition));
          const removed = docs.length - keep.length;
          docs.length = 0;
          docs.push(...keep);
          return { stats: { removed } };
        },
        async add({ data }) {
          const doc = { _id: `doc-${docs.length + 1}`, ...data };
          docs.push(doc);
          return { _id: doc._id };
        },
        doc(id) {
          return {
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

function uploadFixture(h, openid, fileName = STANDARD_FIXTURE) {
  const cloudPath = `${ownerPrefix(openid)}test${path.extname(fileName)}`;
  h.storage.set(cloudPath, fs.readFileSync(path.join(FIXTURES, fileName)));
  return cloudPath;
}

const STUDENT_A = 'openid-student-a';
const STUDENT_B = 'openid-student-b';

test('导入只解析不写库：草稿返回真实样本的课程，临时文件被删除', async () => {
  const h = harness();
  const cloudPath = uploadFixture(h, STUDENT_A);
  const prepared = await h.run(STUDENT_A, { action: 'prepareUpload', fileName: STANDARD_FIXTURE });
  assert.equal(prepared.ok, true);
  assert.ok(prepared.cloudPath.startsWith(ownerPrefix(STUDENT_A)), '上传路径必须落在本人 openid 前缀下');
  assert.match(prepared.cloudPath, /\.xls$/u);

  const result = await h.run(STUDENT_A, { action: 'importDraft', cloudPath, fileName: STANDARD_FIXTURE });
  assert.equal(result.ok, true);
  assert.equal(result.draft.courses.length, 15, '真实样本解析出的课程数');
  assert.equal(result.draft.meta.semester, '2026-2027学年第一学期');
  assert.equal(result.tempFileDeleted, true);
  assert.deepEqual(h.calls.deletes, [cloudPath], '解析后临时文件必须删除');
  assert.equal(h.docs.length, 0, '解析阶段不得写入任何课表记录');
  assert.match(result.note, /未写入/u);
});

test('拒绝解析不属于当前微信身份的云存储路径', async () => {
  const h = harness();
  const otherPath = uploadFixture(h, STUDENT_B);
  const result = await h.run(STUDENT_A, { action: 'importDraft', cloudPath: otherPath, fileName: STANDARD_FIXTURE });
  assert.equal(result.ok, false);
  assert.match(result.error, /不属于当前微信身份/u);
  assert.deepEqual(h.calls.downloads, [], '不应下载别人的文件');
  assert.equal(h.storage.has(otherPath), true, '也不应删除别人的文件');
});

test('解析失败给出可理解的提示，不写入半成品，临时文件照样删除', async () => {
  const h = harness();
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['成绩表'], ['学号', '成绩'], ['1001', '90']]), 'Sheet1');
  const cloudPath = `${ownerPrefix(STUDENT_A)}grades.xlsx`;
  h.storage.set(cloudPath, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));

  const result = await h.run(STUDENT_A, { action: 'importDraft', cloudPath, fileName: '成绩表.xlsx' });
  assert.equal(result.ok, false);
  assert.match(result.error, /未识别出课表矩阵/u);
  assert.deepEqual(h.calls.deletes, [cloudPath]);
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
  const draftA = (await h.run(STUDENT_A, { action: 'importDraft', cloudPath: uploadFixture(h, STUDENT_A), fileName: STANDARD_FIXTURE })).draft;
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
  const draft = (await h.run(STUDENT_A, { action: 'importDraft', cloudPath: uploadFixture(h, STUDENT_A), fileName: STANDARD_FIXTURE })).draft;
  await h.run(STUDENT_A, { action: 'saveDraft', courses: draft.courses, semester: draft.meta.semester });
  assert.equal((await h.run(STUDENT_A, { action: 'list' })).count, 15);

  const second = await h.run(STUDENT_A, { action: 'saveDraft', courses: draft.courses.slice(0, 4), semester: draft.meta.semester });
  assert.equal(second.ok, true);
  const list = await h.run(STUDENT_A, { action: 'list' });
  assert.equal(list.count, 4, '第二次保存只保留新批次的记录');
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

test('preparePhotoUpload:仅放行 png/jpg 截图，路径落在本人 openid 前缀下', async () => {
  const h = harness();
  const ok = await h.run(STUDENT_A, { action: 'preparePhotoUpload', fileName: '课表截图.png' });
  assert.equal(ok.ok, true);
  assert.ok(ok.cloudPath.startsWith(ownerPrefix(STUDENT_A)));
  assert.match(ok.cloudPath, /\.png$/u);
  for (const fileName of ['课表.gif', '课表.xls', '课表']) {
    const bad = await h.run(STUDENT_A, { action: 'preparePhotoUpload', fileName });
    assert.equal(bad.ok, false, fileName);
    assert.match(bad.error, /png|jpg/u);
  }
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
