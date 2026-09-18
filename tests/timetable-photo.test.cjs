const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// Ticket 05 课表截图识别:压缩决策、识别结果解析、vision 事件组装、导入页编排、来源贯通。
// 云函数 ai 的 vision 管道在 tests/ai-flow.test.cjs 验证;这里验证课表侧与页面编排。
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

function loadPage(route, wx, stack = [{}, {}]) {
  const filename = path.resolve(`dist/pages/${route}/index.js`);
  let page;
  globalThis.wx = wx;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: (options) => { page = options; },
    wx,
    getCurrentPages: () => stack,
    require: createRequire(filename),
    exports: {},
  }, { filename });
  page.setData = (patch) => Object.assign(page.data, patch);
  return page;
}

const photo = () => loadCompiled('dist/services/timetable/photo.js');
const ai = () => loadCompiled('dist/services/ai.js');
const draftStore = require('../dist/services/timetable/draft.js');
const view = () => loadCompiled('dist/services/timetable/view.js');

const plain = (value) => JSON.parse(JSON.stringify(value));

function cloudStub(handlers) {
  const calls = [];
  return {
    calls,
    callFunction(options) {
      calls.push({ name: options.name, data: options.data });
      const handler = handlers[options.name] ?? handlers[options.data.action];
      if (handler === undefined) return Promise.reject(new Error(`未预设的调用:${options.name}/${options.data.action}`));
      const result = typeof handler === 'function' ? handler(options.data) : handler;
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve({ result });
    },
  };
}

function baseWx(cloud, extra = {}) {
  const actions = [];
  return {
    cloud,
    navigateTo: (options) => actions.push(`navigateTo:${options.url}`),
    navigateBack: () => actions.push('navigateBack'),
    reLaunch: (options) => actions.push(`reLaunch:${options.url}`),
    showToast: (options) => actions.push(`toast:${options.title}`),
    showModal: (options) => {
      actions.push(`modal:${options.title}`);
      if (typeof options.success === 'function') options.success({ confirm: true, cancel: false });
    },
    actions,
    ...extra,
  };
}

const MODEL_JSON = {
  semester: '2026-2027学年第一学期',
  school: '广东岭南职业技术学院',
  problems: [],
  courses: [
    {
      name: '高等数学', teacher: '林加燕', weekday: 1, startSection: 1, endSection: 2,
      weekText: '[1-16]周', location: '崇礼楼-306', credits: '1.5', campus: '', siteNumber: '', note: '',
    },
  ],
};

test('解析:合法 JSON 映射为课表草稿,周次复用 parseWeekNotation,来源为 photo', () => {
  const { parseVisionText } = photo();
  const draft = parseVisionText(JSON.stringify(MODEL_JSON));
  assert.equal(draft.meta.origin, 'photo');
  assert.equal(draft.meta.semester, '2026-2027学年第一学期');
  assert.equal(draft.meta.school, '广东岭南职业技术学院');
  assert.equal(draft.courses.length, 1);
  const course = draft.courses[0];
  assert.equal(course.name, '高等数学');
  assert.equal(course.source, 'photo');
  assert.deepEqual(plain(course.sectionRanges), [{ start: 1, end: 2 }]);
  assert.equal(course.weeksRecognized, true);
  assert.deepEqual(plain(course.weeks), Array.from({ length: 16 }, (_, index) => index + 1));
  assert.equal(course.weekText, '[1-16]周');
  assert.equal(draft.stats.entries, 1);
  assert.equal(draft.stats.courses, 1);
});

test('解析:容忍 markdown 围栏与前后缀文字,只取 JSON 部分', () => {
  const { parseVisionText } = photo();
  const fenced = parseVisionText('```json\n' + JSON.stringify(MODEL_JSON) + '\n```');
  assert.equal(fenced.courses.length, 1);
  const wrapped = parseVisionText('好的,识别结果如下:' + JSON.stringify(MODEL_JSON) + ' 以上内容仅供参考。');
  assert.equal(wrapped.courses.length, 1);
});

test('解析:模型返回非 JSON 时给出可理解的问题说明,不产生任何课程', () => {
  const { parseVisionText } = photo();
  const draft = parseVisionText('抱歉,这张图片我看不清楚,请重新拍摄。');
  assert.equal(draft.courses.length, 0);
  assert.equal(draft.meta.origin, 'photo');
  assert.ok(draft.problems.some((problem) => /无法解析/u.test(problem)), '必须说明解析失败');
});

test('解析:识别不出的字段只标记不猜——星期/节次缺失时留空并给警告,拦截保存', () => {
  const { parseVisionText } = photo();
  const { blockingReason } = view();
  const raw = JSON.stringify({ semester: '', school: '', problems: [], courses: [
    { name: '缺星期和节次', teacher: '', weekday: 0, startSection: 0, endSection: 0, weekText: '', location: '', credits: '', campus: '', siteNumber: '', note: '' },
  ] });
  const draft = parseVisionText(raw);
  const course = draft.courses[0];
  assert.equal(course.weekday, 0);
  assert.deepEqual(plain(course.sectionRanges), []);
  assert.ok(course.warnings.some((warning) => /星期/u.test(warning)));
  assert.ok(course.warnings.some((warning) => /节次/u.test(warning)));
  assert.ok(blockingReason(course) !== '', '缺星期/节次必须拦截保存');
  assert.equal(course.weeksRecognized, true, '周次留空按每周处理');
  assert.deepEqual(plain(course.weeks), []);
});

test('解析:周次原文不认识时保留原文并标注待核对,不猜测', () => {
  const { parseVisionText } = photo();
  const raw = JSON.stringify({ semester: '', school: '', problems: [], courses: [
    { name: '大学美育', teacher: '', weekday: 2, startSection: 3, endSection: 4, weekText: '第3-18周', location: '', credits: '', campus: '', siteNumber: '', note: '' },
  ] });
  const course = parseVisionText(raw).courses[0];
  assert.equal(course.weeksRecognized, false);
  assert.equal(course.weekText, '第3-18周');
  assert.deepEqual(plain(course.weeks), []);
  assert.ok(course.warnings.some((warning) => /周次/u.test(warning)));
});

test('解析:字段按服务端长度上限截断,警告条数封顶,星期数字串可接受', () => {
  const { parseVisionText } = photo();
  const long = '课'.repeat(100);
  const manyWarnings = { name: long, teacher: '师'.repeat(80), weekday: '2', startSection: 7, endSection: 8, weekText: '', location: '地'.repeat(200), credits: '', campus: '', siteNumber: '', note: '' };
  const draft = parseVisionText(JSON.stringify({ semester: '', school: '', problems: [], courses: [manyWarnings] }));
  const course = draft.courses[0];
  assert.equal(course.name.length, 60, '课程名按 60 字截断');
  assert.equal(course.teacher.length, 40);
  assert.equal(course.location.length, 80);
  assert.equal(course.weekday, 2, '数字字符串星期可接受');
  assert.ok(course.warnings.length <= 12);
  for (const warning of course.warnings) assert.ok(warning.length <= 100);
});

test('解析:星期越界按未识别处理,不静默修正', () => {
  const { parseVisionText } = photo();
  const raw = JSON.stringify({ semester: '', school: '', problems: [], courses: [
    { name: '越界课', teacher: '', weekday: 8, startSection: 1, endSection: 2, weekText: '', location: '', credits: '', campus: '', siteNumber: '', note: '' },
  ] });
  const course = parseVisionText(raw).courses[0];
  assert.equal(course.weekday, 0);
  assert.ok(course.warnings.some((warning) => /星期/u.test(warning)));
});

test('压缩决策:1MB 内不压,超限按质量阶梯再画布缩放,最后放弃并说明', () => {
  const { MAX_PHOTO_BYTES, planCompression } = photo();
  assert.equal(planCompression(MAX_PHOTO_BYTES, 0), 'none');
  assert.equal(planCompression(MAX_PHOTO_BYTES + 1, 0), 'quality-80');
  assert.equal(planCompression(MAX_PHOTO_BYTES + 1, 1), 'quality-60');
  assert.equal(planCompression(MAX_PHOTO_BYTES + 1, 2), 'quality-40');
  assert.equal(planCompression(MAX_PHOTO_BYTES + 1, 3), 'canvas-0.75');
  assert.equal(planCompression(MAX_PHOTO_BYTES + 1, 4), 'canvas-0.5');
  assert.equal(planCompression(MAX_PHOTO_BYTES + 1, 5), 'give-up');
});

test('vision 事件组装:图片走顶层 image 字段,携带系统提示与用户消息', () => {
  const { visionEvent } = ai();
  const event = visionEvent('timetable-screenshot', '系统提示', '请识别这张课表截图', { fileID: 'cloud://a/b.png' }, 2048);
  assert.deepEqual(plain(event), {
    action: 'vision',
    feature: 'timetable-screenshot',
    system: '系统提示',
    messages: [{ role: 'user', text: '请识别这张课表截图' }],
    image: { fileID: 'cloud://a/b.png' },
    maxTokens: 2048,
  });
});

test('系统提示词:要求只输出 JSON、识别不出留空、绝不编造', () => {
  const { VISION_SYSTEM } = photo();
  assert.match(VISION_SYSTEM, /JSON/u);
  assert.match(VISION_SYSTEM, /留空/u);
  assert.match(VISION_SYSTEM, /编造/u);
  assert.match(VISION_SYSTEM, /1-7|星期/u);
});

test('导入页:拍照识别全链路——压缩→上传→vision→确认页,确认页文案标注识别来源', async () => {
  let compressCalls = 0;
  const cloud = cloudStub({
    preparePhotoUpload: () => ({ ok: true, cloudPath: 'timetable-imports/abc/课表截图.png', maxBytes: 2097152 }),
    ai: (data) => ({ ok: true, failureClass: '', message: '', text: JSON.stringify(MODEL_JSON), capWarning: '' }),
    discardUpload: () => ({ ok: true, deleted: true }),
  });
  const wx = baseWx(cloud, {
    chooseMedia: (options) => options.success({ tempFiles: [{ tempFilePath: '/tmp/photo.png', size: 3145728 }] }),
    compressImage: (options) => { compressCalls += 1; options.success({ tempFilePath: '/tmp/photo-small.png' }); },
    getFileSystemManager: () => ({ getFileInfo: (options) => options.success({ size: compressCalls > 0 ? 500000 : 3145728 }) }),
  });
  wx.cloud.uploadFile = (options) => {
    options.success();
    return { onProgressUpdate: () => undefined };
  };
  const page = loadPage('timetable/import', wx);
  page.onLoad();
  assert.match(page.data.photoGuide, /拍照/u, '引导文案必须写明拍照/相册入口');

  page.choosePhoto();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const aiCall = cloud.calls.find((call) => call.name === 'ai');
  assert.ok(aiCall, '必须调用 ai 云函数');
  assert.equal(aiCall.data.action, 'vision');
  assert.equal(aiCall.data.feature, 'timetable-screenshot');
  assert.equal(aiCall.data.image.fileID, 'timetable-imports/abc/课表截图.png');
  assert.equal(compressCalls, 1, '3MB 的图先按质量压缩');
  assert.equal(page.data.step, 'review');
  assert.equal(page.data.items.length, 1);
  assert.ok(page.data.metaLines.some((line) => /截图/u.test(line)), '确认页必须标注识别来源是截图');
  assert.ok(cloud.calls.some((call) => call.data.action === 'discardUpload'), '识别后必须删除上传的截图');

  page.confirmSave();
  await new Promise((resolve) => setImmediate(resolve));
  const save = cloud.calls.find((call) => call.data.action === 'saveDraft');
  assert.ok(save, '确认后走 saveDraft 入库');
  assert.equal(save.data.courses[0].source, 'photo', '入库来源为 photo');
  delete globalThis.wx;
});

test('导入页:模型不可用——独立文案,给出「改为文件导入」与「手工录入」两个出口,截图仍清理', async () => {
  const cloud = cloudStub({
    preparePhotoUpload: () => ({ ok: true, cloudPath: 'timetable-imports/abc/p.png', maxBytes: 2097152 }),
    ai: () => ({ ok: false, failureClass: 'model_unavailable', message: '', text: '', capWarning: '' }),
    discardUpload: () => ({ ok: true, deleted: true }),
  });
  const wx = baseWx(cloud, {
    chooseMedia: (options) => options.success({ tempFiles: [{ tempFilePath: '/tmp/photo.png', size: 100000 }] }),
  });
  wx.cloud.uploadFile = (options) => { options.success(); return { onProgressUpdate: () => undefined }; };
  const page = loadPage('timetable/import', wx);
  page.onLoad();
  page.choosePhoto();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.data.step, 'error');
  assert.equal(page.data.photoError, true);
  assert.match(page.data.errorMessage, /暂时不可用/u);
  assert.doesNotMatch(page.data.errorMessage, /安全/u);
  assert.ok(cloud.calls.some((call) => call.data.action === 'discardUpload'), '失败也要清理截图');
  page.goManualAdd();
  assert.ok(wx.actions.includes('navigateTo:/pages/timetable/edit/index?scope=new'), '手工录入出口可走通');
  page.retryChoose();
  assert.equal(page.data.step, 'guide', '返回后可改为文件导入');
  delete globalThis.wx;
});

test('导入页:内容被拒与额度用尽走各自独立文案', async () => {
  let failure = 'content_rejected';
  const cloud = cloudStub({
    preparePhotoUpload: () => ({ ok: true, cloudPath: 'timetable-imports/abc/p.png', maxBytes: 2097152 }),
    ai: () => ({ ok: false, failureClass: failure, message: '', text: '', capWarning: '' }),
    discardUpload: () => ({ ok: true, deleted: true }),
  });
  const wx = baseWx(cloud, {
    chooseMedia: (options) => options.success({ tempFiles: [{ tempFilePath: '/tmp/photo.png', size: 100000 }] }),
  });
  wx.cloud.uploadFile = (options) => { options.success(); return { onProgressUpdate: () => undefined }; };
  const page = loadPage('timetable/import', wx);
  page.onLoad();
  page.choosePhoto();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page.data.errorMessage, /安全/u, '内容被拒的文案');
  failure = 'quota_exhausted';
  page.retryPhoto();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page.data.errorMessage, /上限/u, '额度用尽的文案与内容被拒不同');
  delete globalThis.wx;
});

test('导入页:压缩到最后仍超限——明确提示并保留两个出口', async () => {
  const cloud = cloudStub({
    preparePhotoUpload: () => ({ ok: true, cloudPath: 'timetable-imports/abc/p.png', maxBytes: 2097152 }),
    discardUpload: () => ({ ok: true, deleted: true }),
  });
  const wx = baseWx(cloud, {
    chooseMedia: (options) => options.success({ tempFiles: [{ tempFilePath: '/tmp/photo.png', size: 999999999 }] }),
    compressImage: (options) => options.success({ tempFilePath: '/tmp/photo-small.png' }),
    getFileSystemManager: () => ({ getFileInfo: (options) => options.success({ size: 999999999 }) }),
  });
  const page = loadPage('timetable/import', wx);
  page.onLoad();
  page.choosePhoto();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.data.step, 'error');
  assert.equal(page.data.photoError, true);
  assert.match(page.data.errorMessage, /太大|清晰/u);
  assert.equal(cloud.calls.filter((call) => call.name === 'ai').length, 0, '超限图不应送识别');
  delete globalThis.wx;
});

test('来源贯通:草稿修正后来源保持 photo,不被打回 excel', () => {
  const { parseVisionText } = photo();
  const form = loadCompiled('dist/services/timetable/form.js');
  const course = parseVisionText(JSON.stringify(MODEL_JSON)).courses[0];
  const input = form.buildCourseInput(form.formOf(course), form.extrasOf(course));
  assert.equal(input.ok, true);
  const rewritten = form.draftFromInput(course, input.value);
  assert.equal(rewritten.source, 'photo', '修正草稿不得把来源改回 excel');
  assert.equal(rewritten.rawText, course.rawText, '原文保留');
});
