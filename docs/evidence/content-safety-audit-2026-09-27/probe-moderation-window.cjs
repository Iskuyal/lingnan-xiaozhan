/**
 * 内容安全检测窗口的可运行复现（2026-09-27 审计）。
 *
 * 三个探针共用 `tests/ai-harness.cjs` 夹具：驱动**真实编译产物**，只替换网络与云 SDK 桩，
 * 不访问网络、不需要密钥。用法（必须在仓库根目录运行，夹具按相对路径读 `dist/`）：
 *
 *   npm run build && node docs/evidence/content-safety-audit-2026-09-27/probe-moderation-window.cjs
 *
 * 三个探针的结论都写在 docs/review/content-safety-audit-2026-09-27.md：
 * - 探针 1：输入侧——标记落在最后一条消息末尾，超出检测窗口；
 * - 探针 2：输出侧（chat）——模型输出 2.5 万字，标记落在末尾；
 * - 探针 3：输出侧（vision 分带）——6 带合并约 3 万字，标记落在末尾。
 *
 * **两个口径分别对应修复前后**（2026-09-28 修复 CT-01/CT-02 后重跑）：
 * - 修复前：超窗口的输入带着 `checked=false` 继续进模型；超窗口的输出尾部未过检就返回客户端；
 * - 修复后：输入超窗口按 `invalid_request` 拒绝（不进模型、不花检测配额）；
 *   输出超窗口的分片全检（`checked=true`、无 `checked=false` 告警），超过 4 万字才失败且不返回内容。
 * 判定看三行：请求 ok / 模型调用次数 / 未检测字符数，以及标记是否出现。
 */
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.resolve(__dirname, '../../..');
const { createHarness, openAiTextResponse } = require(path.join(REPO, 'tests/ai-harness.cjs'));

const MARKER = '【违规标记】';
/** 单条消息上限 8000 字（ai/index.ts），探针 1 用 5 条拼出 4 万字。 */
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

/** 送进模型的请求体（审核接口的请求不算）。 */
function modelBodies(harness) {
  return harness.http.filter((row) => !row.url.includes('/moderations')).map((row) => row.body);
}

/**
 * 上屏文本里**没被任何一次送检覆盖**的字符数。
 * 按「送检片段是否为上屏文本的子串」判定，而不是拿总字符数相减——
 * 相减会把输入检测的字符算进来，得出负数这类看不出问题的数字。
 */
function uncheckedChars(seen, text) {
  const covered = seen
    .filter((chunk) => chunk !== '' && text.includes(chunk))
    .reduce((total, chunk) => total + chunk.length, 0);
  return Math.max(0, text.length - covered);
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
  const bodies = modelBodies(harness);
  const carried = messages.reduce((total, message) => total + message.text.length, 0);
  const checkedChars = seen.reduce((total, text) => total + text.length, 0);

  report('探针 1：输入侧', [
    `请求 ok = ${result.ok} ｜failureClass = ${JSON.stringify(result.failureClass)}`,
    `模型调用次数 = ${bodies.length} ｜msgSecCheck 次数 = ${seen.length} ｜累计送检字符 = ${checkedChars}`,
    `请求携带字符数 = ${carried}`,
    `  检测过的文本里出现标记 = ${seen.some((text) => text.includes(MARKER))}`,
    `  送模型的请求体里出现标记 = ${bodies.some((body) => body.includes(MARKER))}`,
    `  safety.checked = ${result.safety === null ? null : result.safety.checked}`,
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

  report('探针 2：输出侧（chat）', [
    `请求 ok = ${result.ok} ｜failureClass = ${JSON.stringify(result.failureClass)}`,
    `safety.checked = ${result.safety === null ? null : result.safety.checked}`,
    `msgSecCheck 次数 = ${seen.length}（含输入的 1 次）`,
    `  检测过的文本里出现标记 = ${seen.some((text) => text.includes(MARKER))}`,
    `  返回给客户端的 text 里出现标记 = ${result.text.includes(MARKER)}`,
    `  返回给客户端的 text 长度 = ${result.text.length} ｜未检测字符数 = ${uncheckedChars(seen, result.text)}`,
    `  warnings = ${JSON.stringify(result.warnings)}`,
  ]);
}

/** 探针 3：输出侧（vision 分带）。6 带各返回 20 门课，合并后超输入窗口。 */
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

  report('探针 3：输出侧（vision 分带）', [
    `请求 ok = ${result.ok} ｜failureClass = ${JSON.stringify(result.failureClass)}`,
    `模型调用次数 = ${modelBodies(harness).length} ｜msgSecCheck 次数 = ${seen.length} ｜累计送检字符 = ${checkedChars}`,
    `合并输出长度 = ${result.text.length} ｜未检测字符数 = ${uncheckedChars(seen, result.text)}`,
    `  合并输出里出现标记 = ${result.text.includes(MARKER)}`,
    `  safety.checked = ${result.safety === null ? null : result.safety.checked}`,
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
