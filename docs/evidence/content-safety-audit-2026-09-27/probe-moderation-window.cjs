/**
 * 内容安全检测窗口的可运行复现（2026-09-27 审计）。
 *
 * 三个探针共用 `tests/ai-harness.cjs` 夹具：驱动**真实编译产物**，只替换网络与云 SDK 桩，
 * 不访问网络、不需要密钥。用法（必须在仓库根目录运行，夹具按相对路径读 `dist/`）：
 *
 *   npm run build && node docs/evidence/content-safety-audit-2026-09-27/probe-moderation-window.cjs
 *
 * 三个探针的结论都写在 docs/review/content-safety-audit-2026-09-27.md：
 * - 探针 1：输入侧——4 万字请求只有前 2 万字过检，末尾标记从未送检却进了模型请求体；
 * - 探针 2：输出侧（chat）——模型输出 2.5 万字时尾部 5001 字未过检即返回给客户端；
 * - 探针 3：输出侧（vision 分带）——6 带合并 30737 字，尾部 10731 字未过检即返回。
 */
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.resolve(__dirname, '../../..');
const { createHarness, openAiTextResponse } = require(path.join(REPO, 'tests/ai-harness.cjs'));

const MARKER = '【违规标记】';
/** 单条消息上限 8000 字（ai/index.ts:68），用 5 条拼出 4 万字。 */
const MSG_CHARS = 8000;

/** 记录每次送检的文本，用于判断标记有没有真的被检过。 */
function securitySpy(seen) {
  return {
    msgSecCheck: async (params) => {
      seen.push(String(params.content ?? ''));
      return { errCode: 0 };
    },
    imgSecCheck: async () => ({ errCode: 0 }),
  };
}

function report(title, lines) {
  console.log(`===== ${title} =====`);
  for (const line of lines) console.log(line);
  console.log('');
}

/** 探针 1：输入侧。标记落在最后一条消息末尾，远超 2 万字检测窗口。 */
async function probeInput() {
  const seen = [];
  const harness = createHarness({
    security: securitySpy(seen),
    respond: () => openAiTextResponse('回答'),
  });
  const messages = [
    { role: 'user', text: '好'.repeat(MSG_CHARS) },
    { role: 'user', text: '好'.repeat(MSG_CHARS) },
    { role: 'user', text: '好'.repeat(MSG_CHARS) },
    { role: 'user', text: '好'.repeat(MSG_CHARS) },
    { role: 'user', text: '好'.repeat(MSG_CHARS - MARKER.length) + MARKER },
  ];
  const result = await harness.main({ action: 'chat', feature: 'audit', messages });
  const modelBody = harness.http.map((row) => row.body).join('\n');
  const carried = messages.reduce((total, message) => total + message.text.length, 0);
  const checkedChars = seen.reduce((total, text) => total + text.length, 0);

  report('探针 1：输入侧', [
    `请求 ok = ${result.ok} ｜failureClass = ${JSON.stringify(result.failureClass)}`,
    `safety.checked = ${result.safety && result.safety.checked}`,
    `msgSecCheck 调用次数 = ${seen.length} ｜累计送检字符 = ${checkedChars}`,
    `  检测过的文本里出现标记 = ${seen.some((text) => text.includes(MARKER))}`,
    `  送模型的请求体里出现标记 = ${modelBody.includes(MARKER)}`,
    `  请求携带字符数 = ${carried} ｜未检测却进了模型的字符数 = ${carried - checkedChars}`,
  ]);
}

/** 探针 2：输出侧（chat）。模型吐 2.5 万字，标记落在末尾。 */
async function probeOutput() {
  const seen = [];
  const harness = createHarness({
    security: securitySpy(seen),
    respond: () => openAiTextResponse('好'.repeat(25000) + MARKER),
  });
  const result = await harness.main({ action: 'chat', feature: 'audit', messages: [{ role: 'user', text: '随便问一句' }] });
  const checkedChars = seen.reduce((total, text) => total + text.length, 0);

  report('探针 2：输出侧（chat）', [
    `请求 ok = ${result.ok} ｜failureClass = ${JSON.stringify(result.failureClass)}`,
    `safety.checked = ${result.safety && result.safety.checked}`,
    `msgSecCheck 调用次数 = ${seen.length}（含输入的 1 次）`,
    `  检测过的文本里出现标记 = ${seen.some((text) => text.includes(MARKER))}`,
    `  返回给客户端的 text 里出现标记 = ${result.text.includes(MARKER)}`,
    `  返回给客户端的 text 长度 = ${result.text.length} ｜未检测字符数 = ${result.text.length - checkedChars}`,
    `  warnings = ${JSON.stringify(result.warnings)}`,
  ]);
}

/** 探针 3：输出侧（vision 分带）。6 带各返回 20 门课，合并后超窗口。 */
async function probeVision() {
  const openid = 'test-admin-openid';
  const hash = crypto.createHash('sha256').update(openid).digest('hex').slice(0, 16);
  const fileID = `cloud://example.bucket/timetable-imports/${hash}/mtest-12345678.png`;
  const courseName = '高等数学'.repeat(40);
  const seen = [];
  const harness = createHarness({
    openid,
    // 只有预算装得下才会分带（vision.ts:81），8 秒默认超时会退回单带。
    env: { AI_TIMEOUT_MS: '30000', AI_TOTAL_DEADLINE_MS: '60000' },
    security: securitySpy(seen),
    downloadFile: async () => ({ fileContent: Buffer.from('fake-image') }),
    respond: (record) => {
      // 每带只保留 startSection 落在本带的课程（vision.ts:177），因此按提示词里的带起点造数据。
      const matched = /startSection 在 (\d+) 到 (\d+)/u.exec(String(record.body));
      const from = matched === null ? 1 : Number(matched[1]);
      const courses = Array.from({ length: 20 }, () => ({
        name: courseName,
        teacher: '张老师',
        location: '临港A101',
        startSection: from,
        endSection: from,
        weeks: '1-16',
      }));
      courses[courses.length - 1].name = courseName + MARKER;
      return {
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { role: 'assistant', content: JSON.stringify({ semester: '2026春', school: 'LNC', problems: [], courses }) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
      };
    },
  });
  const result = await harness.main({
    action: 'vision',
    feature: 'timetable-screenshot',
    bands: 'auto',
    maxTokens: 2048,
    image: { fileID },
    messages: [{ role: 'user', text: '识别这张课表' }],
  });
  const checkedChars = seen.reduce((total, text) => total + text.length, 0);
  const modelCalls = harness.http.filter((row) => !row.url.includes('/moderations')).length;

  report('探针 3：输出侧（vision 分带）', [
    `请求 ok = ${result.ok} ｜failureClass = ${JSON.stringify(result.failureClass)}`,
    `模型调用次数 = ${modelCalls} ｜msgSecCheck 次数 = ${seen.length} ｜累计送检字符 = ${checkedChars}`,
    `合并输出长度 = ${result.text.length} ｜未检测字符数 = ${result.text.length - checkedChars}`,
    `  合并输出里出现标记 = ${result.text.includes(MARKER)}`,
    `  safety.checked = ${result.safety && result.safety.checked}`,
  ]);
}

(async () => {
  await probeInput();
  await probeOutput();
  await probeVision();
})().catch((error) => {
  console.error('探针运行失败：', error);
  process.exitCode = 1;
});
