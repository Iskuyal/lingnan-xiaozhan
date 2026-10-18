const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const defense = require('../dist/services/defense/index.js');

function page() {
  let options;
  let cloudCalls = 0;
  global.Page = value => { options = value; };
  global.wx = { cloud: { callFunction() { cloudCalls++; return Promise.resolve({ result: {} }); } }, showToast() {} };
  delete require.cache[require.resolve('../dist/pages/defense/index.js')];
  require('../dist/pages/defense/index.js');
  const instance = { ...options, data: JSON.parse(JSON.stringify(options.data)), setData(patch, callback) { Object.assign(this.data, patch); callback?.(); } };
  instance.onLoad();
  return { instance, calls: () => cloudCalls };
}

test('材料查阅：冻结正文可定位F5，设计情景不变成已实现作品', () => {
  const reader = require('../dist/services/defense/reader.js');
  const source = fs.readFileSync(path.resolve('docs/evidence/project-defense-g0/fact-card-1-timetable.md'), 'utf8').replace(/\r\n/g, '\n').trim();
  const own = reader.materialForReading('FC-1');
  assert.equal(own.text, source);
  assert.ok(own.entries.find(item => item.id === 'F5').body.includes('确认前不写'));
  assert.ok(own.entries.find(item => item.id === 'INV-1').body.includes('非上线声明'));
  assert.ok(own.preface.includes('冻结日期：2026-09-30'));
  assert.ok(own.boundary.includes('不推断哪一方是错的'));
  const fiction = reader.materialForReading('FC-2');
  assert.equal(fiction.kind, 'design');
  assert.ok(fiction.entries.find(item => item.id === 'D7').status.includes('未测试'));
  assert.equal(reader.materialForReading('unknown'), null);
});

test('打开/定位/关闭材料不改当前轮次、草稿、反馈，也不调用模型', () => {
  const { instance: p, calls } = page();
  p.onPickMaterial({ currentTarget: { dataset: { id: 'FC-1' } } });
  p.onAnswerInput({ detail: { value: '这是尚未提交的课程项目回答，材料F5说明确认前不写入。' } });
  const before = JSON.stringify(p.session);
  const answer = p.data.answer;
  p.onOpenMaterial({ currentTarget: { dataset: { anchor: 'F5' } } });
  assert.equal(p.data.materialOpen, true);
  assert.equal(p.data.materialAnchor, 'material-F5');
  p.onCloseMaterial();
  assert.equal(p.data.materialOpen, false);
  assert.equal(p.data.answer, answer);
  assert.equal(JSON.stringify(p.session), before);
  assert.equal(calls(), 0);
});

test('重答查阅材料后仍是同一重答，次数和新写草稿不丢失', () => {
  const { instance: p, calls } = page();
  p.onPickMaterial({ currentTarget: { dataset: { id: 'FC-1' } } });
  let session = p.session;
  const feedback = '【引用核对】F5成立\n【是否对应回答】已对应\n【待验证保留】F8待验证\n【追问】请补充F4';
  for (let round = 1; round <= 3; round++) {
    session = defense.recordFeedback(defense.submitAnswer(session, '按冻结素材写下本轮回答，保留待验证事项。'), feedback).session;
    if (round < 3) session = defense.advanceRound(session);
  }
  p.session = session;
  p.onStartReanswer();
  p.onAnswerInput({ detail: { value: '我新写的重答包含F4和F5，说明先校对后确认保存。' } });
  const before = JSON.stringify(p.session);
  const answer = p.data.answer;
  p.onOpenMaterial({ currentTarget: { dataset: { anchor: 'F4' } } });
  p.onCloseMaterial();
  assert.equal(p.data.phase, 'reanswer');
  assert.equal(p.data.round, 4);
  assert.equal(p.data.answer, answer);
  assert.equal(JSON.stringify(p.session), before);
  assert.equal(calls(), 0);
});

test('选择材料先改变选中对象，明确开始后才进入第一轮', () => {
  const { instance: p, calls } = page();
  p.onSelectMaterial({ currentTarget: { dataset: { id: 'FC-2' } } });
  assert.equal(p.data.phase, 'materials');
  assert.equal(p.data.selectedMaterialId, 'FC-2');
  p.onBegin();
  assert.equal(p.data.phase, 'practice');
  assert.equal(p.data.materialId, 'FC-2');
  assert.equal(calls(), 0);
});

test('材料目录按需展开，定位后收起，保留当前会话和草稿', () => {
  const { instance: p, calls } = page();
  p.onBegin();
  p.onAnswerInput({ detail: { value:'按F5说明先校对再保存，这份回答仍是草稿。' } });
  const before = JSON.stringify(p.session);
  const answer = p.data.answer;
  p.onOpenMaterial();
  assert.equal(p.data.materialIndexOpen, false);
  p.toggleMaterialIndex();
  assert.equal(p.data.materialIndexOpen, true);
  p.onLocateMaterial({ currentTarget:{dataset:{id:'F5'}} });
  assert.equal(p.data.materialIndexOpen, false);
  assert.equal(p.data.materialAnchor, 'material-F5');
  assert.equal(p.data.answer, answer);
  assert.equal(JSON.stringify(p.session), before);
  assert.equal(calls(), 0);
});

test('复制复盘保留可见的核对、对应回答、追问和完整待验证文字', () => {
  const { instance: p } = page();
  let copied = '';
  global.wx.setClipboardData = options => { copied = options.data; options.success?.(); };
  const retained = '待验证事项必须完整保留。'.repeat(12);
  p.data.reviewRows = [{ dimension:'问题与目标',status:'已反馈',summary:'回答说明了确认边界',basis:'引用F5',followup:'请结合F4补充',excerpt:retained }];
  p.onCopyReview();
  for (const text of ['回答说明了确认边界','引用F5','请结合F4补充',retained]) assert.ok(copied.includes(text));
});

test('周视图固定七列，默认收起尾部空课时，晚间课程始终可见', () => {
  const { presentGrid } = require('../dist/services/timetable/presentation.js');
  const { buildGrid } = require('../dist/services/timetable/view.js');
  const course = { id:'late', name:'晚间课程', teacher:'', location:'B305', campus:'', siteNumber:'', note:'', credits:'', weekday:7, startSection:11, endSection:12, sectionRanges:[{start:11,end:12}], weeks:[8], weeksRecognized:true, weekText:'8', warnings:[], rawText:'', semester:'示例', source:'manual', updatedAt:1 };
  const raw = buildGrid([course], 8);
  const before = JSON.stringify(raw);
  const ui = presentGrid(raw);
  assert.equal(ui.columns.length, 7);
  assert.equal(ui.widthPx, 7 * 66);
  assert.equal(ui.sectionNumbers.at(-1), 12);
  assert.ok(ui.columns[6].blocks[0].topPx < ui.heightPx);
  assert.equal(JSON.stringify(raw), before);
  const early = buildGrid([{...course, startSection:1,endSection:2,sectionRanges:[{start:1,end:2}]}],8);
  assert.equal(presentGrid(early).sectionNumbers.at(-1), 6);
  assert.equal(presentGrid(early,true).sectionNumbers.at(-1), 12);
});
