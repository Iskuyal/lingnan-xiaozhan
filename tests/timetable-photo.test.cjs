const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// Ticket 05 课表截图识别:格式判定、压缩决策、识别结果解析、vision 事件组装、导入页编排、来源贯通。
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

/** 文件头样本（真实魔数）；测试把它当成 wx readFile 的返回。 */
const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const GIF_HEADER = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

/**
 * 拍照/相册路径的 wx 桩：选图 → 压缩 → 读文件头 → 上传（回传真实形状的 fileID）。
 * `header: null` 表示 readFile 失败（只能靠路径扩展名兜底）；`sizeOf` 定制每一步后量到的大小。
 */
function imageWx(cloud, options = {}) {
  const state = { compressCalls: 0, canvasCalls: 0 };
  const compressedPath = options.compressedPath ?? '/tmp/photo-small.jpg';
  const originalSize = options.originalSize ?? 100000;
  const sizeOf = options.sizeOf ?? ((filePath) => (filePath === compressedPath ? (options.compressedSize ?? 500000) : originalSize));
  const wx = baseWx(cloud, {
    chooseMedia: (opts) => {
      opts.success({ tempFiles: [{ tempFilePath: options.tempFilePath ?? '/tmp/photo.png', size: originalSize }] });
    },
    compressImage: (opts) => {
      state.compressCalls += 1;
      if (options.compressFails === true) opts.fail({ errMsg: 'compressImage:fail' });
      else opts.success({ tempFilePath: compressedPath });
    },
    getFileSystemManager: () => ({
      getFileInfo: (opts) => opts.success({ size: sizeOf(opts.filePath) }),
      readFile: (opts) => {
        const header = options.header === undefined ? PNG_HEADER : options.header;
        if (header === null) opts.fail({ errMsg: 'readFile:fail' });
        else opts.success({ data: header });
      },
    }),
    // 画布缩放步骤（阶梯后两步）所需的 wx 能力；质量压缩步骤用不到它们。
    getImageInfo: (opts) => opts.success({ width: 1000, height: 1000 }),
    createOffscreenCanvas: (opts) => ({
      width: opts.width,
      height: opts.height,
      getContext: () => ({ drawImage: () => undefined }),
      createImage: () => {
        const image = { onload: null, onerror: null };
        Object.defineProperty(image, 'src', {
          set() {
            if (typeof image.onload === 'function') image.onload();
          },
        });
        return image;
      },
    }),
    canvasToTempFilePath: (opts) => {
      state.canvasCalls += 1;
      opts.success({ tempFilePath: options.canvasPath ?? '/tmp/canvas-small.jpg' });
    },
  });
  wx.cloud.uploadFile = (opts) => {
    // 真实 uploadFile 回传 fileID；页面必须拿它继续调用，而不是用 cloudPath。
    opts.success({ fileID: `cloud://test-env.test-bucket/${opts.cloudPath}` });
    return { onProgressUpdate: () => undefined };
  };
  return { wx, state };
}

const flush = async (times = 3) => {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const MODEL_JSON = {
  semester: '2026-2027学年第一学期',
  school: '广东岭南职业技术学院',
  problems: [],
  courses: [
    {
      name: '高等数学', teacher: '林加燕', weekday: 1, startSection: 1, endSection: 2,
      weekText: '[1-16]周', everyWeek: false, location: '崇礼楼-306', credits: '1.5',
      campus: '', siteNumber: '', note: '',
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
  const { blockingReason, weekLabelOf } = view();
  const raw = JSON.stringify({ semester: '', school: '', problems: [], courses: [
    { name: '缺星期和节次', teacher: '', weekday: 0, startSection: 0, endSection: 0, weekText: '', everyWeek: false, location: '', credits: '', campus: '', siteNumber: '', note: '' },
  ] });
  const draft = parseVisionText(raw);
  const course = draft.courses[0];
  assert.equal(course.weekday, 0);
  assert.deepEqual(plain(course.sectionRanges), []);
  assert.ok(course.warnings.some((warning) => /星期/u.test(warning)));
  assert.ok(course.warnings.some((warning) => /节次/u.test(warning)));
  assert.ok(blockingReason(course) !== '', '缺星期/节次必须拦截保存');
  assert.equal(course.weeksRecognized, false, '周次留空不得静默当成每周');
  assert.deepEqual(plain(course.weeks), []);
  assert.ok(course.warnings.some((warning) => /周次/u.test(warning)), '周次留空要给出待核对提示');
  assert.equal(weekLabelOf(course), '周次待核对');
});

test('解析:周次留空与「每周」是两回事——只有模型显式 everyWeek 才按每周', () => {
  const { parseVisionText } = photo();
  const { weekLabelOf } = view();
  const base = { name: '课', teacher: '', weekday: 1, startSection: 1, endSection: 2, location: '', credits: '', campus: '', siteNumber: '', note: '' };
  const parseOne = (course) => parseVisionText(JSON.stringify({ semester: '', school: '', problems: [], courses: [course] })).courses[0];

  const blank = parseOne({ ...base, weekText: '', everyWeek: false });
  assert.equal(blank.weeksRecognized, false, '留空不是每周');
  assert.deepEqual(plain(blank.weeks), []);
  assert.equal(blank.weekText, '', '不替模型编造周次原文');
  assert.equal(weekLabelOf(blank), '周次待核对');

  const every = parseOne({ ...base, weekText: '', everyWeek: true });
  assert.equal(every.weeksRecognized, true, '显式「每周」按每周处理');
  assert.deepEqual(plain(every.weeks), []);
  assert.equal(weekLabelOf(every), '每周');

  const word = parseOne({ ...base, weekText: '每周', everyWeek: true });
  assert.equal(word.weeksRecognized, true, '原文写「每周」且显式声明时同样按每周');
  assert.equal(weekLabelOf(word), '每周');

  const missing = parseOne({ ...base, weekText: '' });
  assert.equal(missing.weeksRecognized, false, 'everyWeek 缺失一律不当每周');

  const both = parseOne({ ...base, weekText: '[3-4]周', everyWeek: true });
  assert.deepEqual(plain(both.weeks), [3, 4], '有具体周次时以具体周次为准');
  assert.equal(weekLabelOf(both), '第 3-4 周');
});

test('解析:周次原文不认识时保留原文并标注待核对,不猜测', () => {
  const { parseVisionText } = photo();
  const raw = JSON.stringify({ semester: '', school: '', problems: [], courses: [
    { name: '大学美育', teacher: '', weekday: 2, startSection: 3, endSection: 4, weekText: '第3-18周', everyWeek: false, location: '', credits: '', campus: '', siteNumber: '', note: '' },
  ] });
  const course = parseVisionText(raw).courses[0];
  assert.equal(course.weeksRecognized, false);
  assert.equal(course.weekText, '第3-18周');
  assert.deepEqual(plain(course.weeks), []);
  assert.ok(course.warnings.some((warning) => /周次/u.test(warning)));
});

test('解析:识别结果不合成「原文」——截图已删除,rawText 保持空', () => {
  const { parseVisionText } = photo();
  const course = parseVisionText(JSON.stringify(MODEL_JSON)).courses[0];
  assert.equal(course.rawText, '', '不得把字段拼成合成文本冒充原文');
  assert.doesNotMatch(course.rawText, /识别/u);
});

test('解析:字段按服务端长度上限截断,警告条数封顶,星期数字串可接受', () => {
  const { parseVisionText } = photo();
  const long = '课'.repeat(100);
  const manyWarnings = { name: long, teacher: '师'.repeat(80), weekday: '2', startSection: 7, endSection: 8, weekText: '', everyWeek: false, location: '地'.repeat(200), credits: '', campus: '', siteNumber: '', note: '' };
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
    { name: '越界课', teacher: '', weekday: 8, startSection: 1, endSection: 2, weekText: '', everyWeek: false, location: '', credits: '', campus: '', siteNumber: '', note: '' },
  ] });
  const course = parseVisionText(raw).courses[0];
  assert.equal(course.weekday, 0);
  assert.ok(course.warnings.some((warning) => /星期/u.test(warning)));
});

test('格式判定:文件头优先、路径扩展名兜底、两者都拿不到就返回 null（不猜）', () => {
  const {
    sniffPhotoFormat, formatFromPath, resolvePhotoFormat, photoFileName, unsupportedFormatLabel, PHOTO_FORMATS, toBytes,
  } = photo();
  assert.equal(sniffPhotoFormat(PNG_HEADER).label, 'PNG');
  assert.equal(sniffPhotoFormat(JPEG_HEADER).label, 'JPG');
  assert.equal(sniffPhotoFormat(new Uint8Array([0x00, 0x01, 0x02])), null, '认不出的内容不能猜成 PNG');
  assert.equal(sniffPhotoFormat(null), null);

  assert.equal(formatFromPath('/tmp/a.jpeg').label, 'JPG', '相册的 .jpeg 也算 JPG');
  assert.equal(formatFromPath('/tmp/a.PNG').extension, '.png');
  assert.equal(formatFromPath('/tmp/a.gif'), null);
  assert.equal(formatFromPath('/tmp/wxfile'), null);

  // 内容与文件名矛盾时以文件头为准：wx.compressImage 可能产出 JPEG，而路径仍叫 .png。
  assert.equal(resolvePhotoFormat('/tmp/a.png', JPEG_HEADER).extension, '.jpg');
  assert.equal(resolvePhotoFormat('/tmp/a.png', GIF_HEADER), null, '读到字节就只信内容，路径不能给它「洗白」');
  assert.equal(resolvePhotoFormat('/tmp/a.png', null).extension, '.png', '读不到文件头才退回扩展名');
  assert.equal(resolvePhotoFormat('/tmp/wxfile-tmp', null), null, '两者都拿不到必须拒绝');

  assert.equal(photoFileName(PHOTO_FORMATS.jpg), '课表截图.jpg');
  assert.equal(unsupportedFormatLabel(GIF_HEADER), 'GIF');
  assert.equal(unsupportedFormatLabel(new Uint8Array([0x00])), '');
  assert.equal(toBytes(new Uint8Array([1, 2])).length, 2, 'TypedArray 也能收敛成字节');
  assert.equal(toBytes('binary'), null);
});

test('压缩决策:1MB 内不压,超限按质量阶梯再画布缩放,走完是可达的 give-up', () => {
  const { MAX_PHOTO_BYTES, COMPRESSION_LADDER, planCompression } = photo();
  assert.equal(planCompression(MAX_PHOTO_BYTES, 0), 'none');
  assert.equal(planCompression(MAX_PHOTO_BYTES + 1, 0), 'quality-80');
  assert.equal(planCompression(MAX_PHOTO_BYTES + 1, 1), 'quality-60');
  assert.equal(planCompression(MAX_PHOTO_BYTES + 1, 2), 'quality-40');
  assert.equal(planCompression(MAX_PHOTO_BYTES + 1, 3), 'canvas-0.75');
  assert.equal(planCompression(MAX_PHOTO_BYTES + 1, 4), 'canvas-0.5');
  assert.equal(planCompression(MAX_PHOTO_BYTES + 1, 5), 'give-up');
  assert.equal(planCompression(MAX_PHOTO_BYTES + 1, 99), 'give-up', '阶梯走完就是终点，不是够不到的兜底');
  assert.deepEqual(plain(COMPRESSION_LADDER), ['quality-80', 'quality-60', 'quality-40', 'canvas-0.75', 'canvas-0.5']);
});

test('客户端兜底文案:图片输入的内容被拒说「换一张」,服务端文案仍优先', () => {
  const { userMessage, AI_MESSAGES, AI_IMAGE_MESSAGES } = ai();
  const rejected = { ok: false, failureClass: 'content_rejected', message: '', text: '', capWarning: '', safety: null, warnings: [] };
  assert.match(userMessage(rejected, 'image'), /换一张/u);
  assert.doesNotMatch(userMessage(rejected, 'image'), /换个说法/u, '图片不能用文字语义的兜底');
  assert.match(userMessage(rejected), /换个说法/u, '文字输入的兜底文案不变');
  assert.equal(userMessage({ ...rejected, message: '服务端说这张图不行' }, 'image'), '服务端说这张图不行', '服务端文案优先');
  assert.match(AI_IMAGE_MESSAGES.content_rejected, /图片/u);
  assert.match(AI_MESSAGES.content_rejected, /安全/u);
});

test('vision 事件组装:图片走顶层 image 的 fileID,携带系统提示与用户消息', () => {
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

  // 分带方式随事件下发（服务端 `bands` 字段）；不传时事件里不出现该字段，保持单带原路径。
  const banded = visionEvent('timetable-screenshot', '系统提示', '请识别这张课表截图', { fileID: 'cloud://a/b.png' }, 2048, 'auto');
  assert.equal(banded.bands, 'auto');
  assert.equal(visionEvent('timetable-screenshot', '系统提示', '识别', { fileID: 'cloud://a/b.png' }, 2048, 3).bands, 3);
  assert.equal(visionEvent('timetable-screenshot', '系统提示', '识别', { fileID: 'cloud://a/b.png' }).bands, undefined);
});

test('分带方式交给服务端按预算算，且只有「auto」或 1 以上的整数是合法取值', () => {
  const { VISION_BANDS } = photo();
  assert.equal(VISION_BANDS, 'auto', '产品路径默认让服务端按超时预算决定带数');
});

test('系统提示词:要求只输出 JSON、识别不出留空、绝不编造、每周要显式声明', () => {
  const { VISION_SYSTEM } = photo();
  assert.match(VISION_SYSTEM, /JSON/u);
  assert.match(VISION_SYSTEM, /留空/u);
  assert.match(VISION_SYSTEM, /编造/u);
  assert.match(VISION_SYSTEM, /1-7|星期/u);
  assert.match(VISION_SYSTEM, /everyWeek/u, '「每周」必须由模型显式输出');
  assert.match(VISION_SYSTEM, /待核对/u);
});

test('导入页:拍照识别全链路——压缩→判格式→上传→vision→确认页,全程用 fileID', async () => {
  const cloud = cloudStub({
    preparePhotoUpload: (data) => ({ ok: true, cloudPath: `timetable-imports/abc/${data.fileName}`, maxBytes: 2097152 }),
    ai: () => ({ ok: true, failureClass: '', message: '', text: JSON.stringify(MODEL_JSON), capWarning: '' }),
    discardUpload: () => ({ ok: true, deleted: true }),
  });
  // 压缩产物一般是 JPEG（相机与 wx.compressImage 的常态），路径仍带 .png —— 必须按内容判成 .jpg。
  const { wx, state } = imageWx(cloud, { compressedPath: '/tmp/photo-small.png', header: JPEG_HEADER, originalSize: 3145728 });
  const page = loadPage('timetable/import', wx);
  page.onLoad();
  assert.match(page.data.photoGuide, /拍照/u, '引导文案必须写明拍照/相册入口');

  page.choosePhoto();
  await flush();

  assert.equal(state.compressCalls, 1, '3MB 的图先按质量压缩');
  const prepared = cloud.calls.find((call) => call.data.action === 'preparePhotoUpload');
  assert.ok(prepared, '必须申请本人 openid 下的上传路径');
  assert.equal(prepared.data.fileName, '课表截图.jpg', '扩展名按文件头判成 JPEG，而不是照抄路径的 .png');

  const aiCall = cloud.calls.find((call) => call.name === 'ai');
  assert.ok(aiCall, '必须调用 ai 云函数');
  assert.equal(aiCall.data.action, 'vision');
  assert.equal(aiCall.data.feature, 'timetable-screenshot');
  assert.match(aiCall.data.image.fileID, /^cloud:\/\//u, 'vision 必须传上传返回的 fileID');
  assert.equal(aiCall.data.image.fileID, 'cloud://test-env.test-bucket/timetable-imports/abc/课表截图.jpg');
  assert.equal(aiCall.data.cloudPath, undefined, '不得把裸 cloudPath 传给 ai');
  assert.equal(aiCall.data.bands, 'auto', '截图识别走分带并行（服务端按预算算带数）');

  const discard = cloud.calls.filter((call) => call.data.action === 'discardUpload');
  assert.deepEqual(discard.map((call) => call.data.fileID), [aiCall.data.image.fileID], '识别后按 fileID 删除截图');

  assert.equal(page.data.step, 'review');
  assert.equal(page.data.items.length, 1);
  assert.equal(page.data.isPhoto, true);
  assert.equal(page.data.items[0].rawText, '', '截图识别不展示合成「原文」');
  assert.ok(page.data.metaLines.some((line) => /截图/u.test(line)), '确认页必须标注识别来源是截图');

  page.confirmSave();
  await new Promise((resolve) => setImmediate(resolve));
  const save = cloud.calls.find((call) => call.data.action === 'saveDraft');
  assert.ok(save, '确认后走 saveDraft 入库');
  assert.equal(save.data.courses[0].source, 'photo', '入库来源为 photo');
  assert.equal(save.data.courses[0].rawText, '', '入库不带合成原文');
  delete globalThis.wx;
});

test('导入页:文件头读不到时用路径扩展名兜底,读不到又不认识就拒绝上传', async () => {
  const cloud = cloudStub({
    preparePhotoUpload: (data) => ({ ok: true, cloudPath: `timetable-imports/abc/${data.fileName}`, maxBytes: 2097152 }),
    ai: () => ({ ok: true, failureClass: '', message: '', text: JSON.stringify(MODEL_JSON), capWarning: '' }),
    discardUpload: () => ({ ok: true, deleted: true }),
  });
  const { wx } = imageWx(cloud, { header: null, compressedPath: '/tmp/photo-small.png' });
  const page = loadPage('timetable/import', wx);
  page.onLoad();
  page.choosePhoto();
  await flush();
  assert.equal(page.data.step, 'review', '扩展名能认出来就继续');
  const prepared = cloud.calls.find((call) => call.data.action === 'preparePhotoUpload');
  assert.equal(prepared.data.fileName, '课表截图.png', '文件头读不到时才按路径扩展名兜底');

  // 文件头读不到、路径也没有可识别的扩展名：明确拒绝，不上传、不调模型。
  const unknownCloud = cloudStub({
    preparePhotoUpload: () => ({ ok: true, cloudPath: 'timetable-imports/abc/x', maxBytes: 2097152 }),
    discardUpload: () => ({ ok: true, deleted: true }),
  });
  const unknown = imageWx(unknownCloud, { header: null, tempFilePath: '/tmp/wxfile-tmp-123' });
  const second = loadPage('timetable/import', unknown.wx);
  second.onLoad();
  second.choosePhoto();
  await flush();
  assert.equal(second.data.step, 'error');
  assert.equal(second.data.photoError, true);
  assert.match(second.data.errorMessage, /无法确认图片格式/u);
  assert.equal(unknownCloud.calls.filter((call) => call.data.action === 'preparePhotoUpload').length, 0, '认不出格式不得上传');
  assert.equal(unknownCloud.calls.filter((call) => call.name === 'ai').length, 0, '认不出格式不得送识别');
  delete globalThis.wx;
});

test('导入页:认出 GIF 等不支持格式时给出格式名并拒绝上传', async () => {
  const cloud = cloudStub({
    preparePhotoUpload: () => ({ ok: true, cloudPath: 'timetable-imports/abc/x.gif', maxBytes: 2097152 }),
    discardUpload: () => ({ ok: true, deleted: true }),
  });
  const { wx } = imageWx(cloud, { header: GIF_HEADER });
  const page = loadPage('timetable/import', wx);
  page.onLoad();
  page.choosePhoto();
  await flush();
  assert.equal(page.data.step, 'error');
  assert.match(page.data.errorMessage, /GIF/u, '不支持格式要说清是哪种格式');
  assert.equal(cloud.calls.filter((call) => call.data.action === 'preparePhotoUpload').length, 0);
  assert.equal(cloud.calls.filter((call) => call.name === 'ai').length, 0);
  delete globalThis.wx;
});

test('导入页:上传没拿到 fileID 时明确失败,不把 cloudPath 当 fileID 传下去', async () => {
  const cloud = cloudStub({
    preparePhotoUpload: () => ({ ok: true, cloudPath: 'timetable-imports/abc/x.png', maxBytes: 2097152 }),
    ai: () => ({ ok: true, failureClass: '', message: '', text: JSON.stringify(MODEL_JSON), capWarning: '' }),
    discardUpload: () => ({ ok: true, deleted: true }),
  });
  const { wx } = imageWx(cloud);
  wx.cloud.uploadFile = (options) => {
    options.success(undefined); // 异常形态：上传完成但没回传 fileID
    return { onProgressUpdate: () => undefined };
  };
  const page = loadPage('timetable/import', wx);
  page.onLoad();
  page.choosePhoto();
  await flush();
  assert.equal(page.data.step, 'error');
  assert.match(page.data.errorMessage, /fileID/u);
  assert.equal(cloud.calls.filter((call) => call.name === 'ai').length, 0, '没有 fileID 就不该调识别');
  delete globalThis.wx;
});

test('导入页:模型不可用——独立文案,给出「改为文件导入」与「手工录入」两个出口,截图仍清理', async () => {
  const cloud = cloudStub({
    preparePhotoUpload: (data) => ({ ok: true, cloudPath: `timetable-imports/abc/${data.fileName}`, maxBytes: 2097152 }),
    ai: () => ({ ok: false, failureClass: 'model_unavailable', message: '', text: '', capWarning: '' }),
    discardUpload: () => ({ ok: true, deleted: true }),
  });
  const { wx } = imageWx(cloud);
  const page = loadPage('timetable/import', wx);
  page.onLoad();
  page.choosePhoto();
  await flush();
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

test('导入页:内容被拒(图片)与额度用尽走各自独立文案,图片用「换一张」而不是「换个说法」', async () => {
  let failure = 'content_rejected';
  const cloud = cloudStub({
    preparePhotoUpload: (data) => ({ ok: true, cloudPath: `timetable-imports/abc/${data.fileName}`, maxBytes: 2097152 }),
    ai: () => ({ ok: false, failureClass: failure, message: '', text: '', capWarning: '' }),
    discardUpload: () => ({ ok: true, deleted: true }),
  });
  const { wx } = imageWx(cloud);
  const page = loadPage('timetable/import', wx);
  page.onLoad();
  page.choosePhoto();
  await flush();
  assert.match(page.data.errorMessage, /安全/u, '内容被拒的文案');
  assert.match(page.data.errorMessage, /换一张/u, '图片被拒要给图片语义的提示');
  assert.doesNotMatch(page.data.errorMessage, /换个说法/u, '不能用文字语义的「换个说法」');

  failure = 'quota_exhausted';
  page.retryPhoto();
  await flush();
  assert.match(page.data.errorMessage, /上限/u, '额度用尽的文案与内容被拒不同');
  delete globalThis.wx;
});

test('导入页:服务端给了文案就优先用服务端的（本地兜底不覆盖）', async () => {
  const cloud = cloudStub({
    preparePhotoUpload: (data) => ({ ok: true, cloudPath: `timetable-imports/abc/${data.fileName}`, maxBytes: 2097152 }),
    ai: () => ({ ok: false, failureClass: 'content_rejected', message: '服务端文案：这张图被拒了', text: '', capWarning: '' }),
    discardUpload: () => ({ ok: true, deleted: true }),
  });
  const { wx } = imageWx(cloud);
  const page = loadPage('timetable/import', wx);
  page.onLoad();
  page.choosePhoto();
  await flush();
  assert.equal(page.data.errorMessage, '服务端文案：这张图被拒了');
  delete globalThis.wx;
});

test('导入页:压缩走完阶梯仍超限——按「压缩后仍超过 1MB」措辞,并保留两个出口', async () => {
  const cloud = cloudStub({
    preparePhotoUpload: () => ({ ok: true, cloudPath: 'timetable-imports/abc/p.png', maxBytes: 2097152 }),
    discardUpload: () => ({ ok: true, deleted: true }),
  });
  const { wx, state } = imageWx(cloud, { originalSize: 999999999, sizeOf: () => 999999999 });
  const page = loadPage('timetable/import', wx);
  page.onLoad();
  page.choosePhoto();
  await flush();
  assert.equal(page.data.step, 'error');
  assert.equal(page.data.photoError, true);
  assert.match(page.data.errorMessage, /超过 1MB|清晰/u);
  assert.equal(state.compressCalls, 3, '三次质量压缩都试过');
  assert.equal(state.canvasCalls, 2, '两次画布缩放也试过才放弃');
  assert.equal(cloud.calls.filter((call) => call.name === 'ai').length, 0, '超限图不应送识别');
  page.goManualAdd();
  assert.ok(wx.actions.includes('navigateTo:/pages/timetable/edit/index?scope=new'), '手工录入出口仍在');
  delete globalThis.wx;
});

test('导入页:压缩调用失败——按真实原因提示「压缩失败」,不冒充「超过 1MB」', async () => {
  const cloud = cloudStub({
    preparePhotoUpload: () => ({ ok: true, cloudPath: 'timetable-imports/abc/p.png', maxBytes: 2097152 }),
    discardUpload: () => ({ ok: true, deleted: true }),
  });
  const { wx } = imageWx(cloud, { originalSize: 3145728, compressFails: true });
  const page = loadPage('timetable/import', wx);
  page.onLoad();
  page.choosePhoto();
  await flush();
  assert.equal(page.data.step, 'error');
  assert.match(page.data.errorMessage, /压缩失败/u);
  assert.doesNotMatch(page.data.errorMessage, /超过 1MB/u, '失败原因不能都归到「压缩后仍超限」');
  assert.equal(cloud.calls.filter((call) => call.name === 'ai').length, 0);
  delete globalThis.wx;
});

test('导入页:识别部分成功时确认页也有三个出口,取消重试保留草稿', async () => {
  const partial = {
    semester: '', school: '', problems: ['截图右侧有一处被笔迹遮挡'],
    courses: [
      { name: '已识别的课', teacher: '某某', weekday: 1, startSection: 1, endSection: 2, weekText: '[1-8]周', everyWeek: false, location: '崇礼楼-306', credits: '', campus: '', siteNumber: '', note: '' },
      { name: '', teacher: '', weekday: 0, startSection: 0, endSection: 0, weekText: '', everyWeek: false, location: '', credits: '', campus: '', siteNumber: '', note: '' },
    ],
  };
  const cloud = cloudStub({
    preparePhotoUpload: (data) => ({ ok: true, cloudPath: `timetable-imports/abc/${data.fileName}`, maxBytes: 2097152 }),
    ai: () => ({ ok: true, failureClass: '', message: '', text: JSON.stringify(partial), capWarning: '' }),
    discardUpload: () => ({ ok: true, deleted: true }),
  });
  const { wx } = imageWx(cloud);
  const page = loadPage('timetable/import', wx);
  page.onLoad();
  page.choosePhoto();
  await flush();
  assert.equal(page.data.step, 'review');
  assert.ok(page.data.problemsText.includes('遮挡'), '整体问题要在确认页标出');
  assert.equal(page.data.blockedCount, 1, '没识别出课程名/星期/节次的条目要被标出来');
  assert.ok(page.data.warningCount >= 1);

  // 模板里三个出口都要在（确认页可见）。
  const wxml = fs.readFileSync(path.resolve('miniprogram/pages/timetable/import/index.wxml'), 'utf8');
  for (const id of ['review-retry-photo', 'review-rechoose-file', 'review-to-manual']) {
    assert.ok(wxml.includes(`id="${id}"`), `确认页缺少出口按钮 ${id}`);
  }

  // 出口一：手工录入
  page.goManualAdd();
  assert.ok(wx.actions.includes('navigateTo:/pages/timetable/edit/index?scope=new'));

  // 出口二：改为文件导入；取消选择时回到确认页，草稿不丢
  page.retryChoose();
  assert.equal(page.data.step, 'guide');
  wx.chooseMessageFile = (options) => options.fail({ errMsg: 'chooseMessageFile:fail cancel' });
  page.chooseFile();
  assert.equal(page.data.step, 'review', '取消重选要回到确认页');
  assert.equal(page.data.blockedCount, 1, '草稿仍在');

  // 出口三：重试识别；取消选图同样回到确认页，重试成功后仍进确认页
  wx.chooseMedia = (options) => options.fail({ errMsg: 'chooseMedia:fail cancel' });
  page.retryPhoto();
  assert.equal(page.data.step, 'review', '取消重试识别不能把草稿藏起来');
  assert.equal(cloud.calls.filter((call) => call.name === 'ai').length, 1, '取消不产生识别调用');

  wx.chooseMedia = imageWx(cloud).wx.chooseMedia;
  page.retryPhoto();
  await flush();
  assert.equal(page.data.step, 'review');
  assert.equal(cloud.calls.filter((call) => call.name === 'ai').length, 2, '重试要真的再识别一次');
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
  assert.equal(rewritten.rawText, '', '截图识别的原文本就是空，不是合成文本');
});
