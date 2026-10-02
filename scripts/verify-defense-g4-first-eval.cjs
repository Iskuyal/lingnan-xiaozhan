/**
 * G4 新冻结样例首评：把冻结样例送进**已部署功能**，逐例取回四节原始反馈并做可自动化的判定。
 *
 * 判据先冻结在 `docs/evidence/project-defense-g4/samples/frozen-2026-10-02.json`，
 * 本脚本开头用 `--expect-hash` 校验冻结件哈希，**先证判据没被改过，再跑**。
 *
 * 判定的分工（rubric 四步，顺序不能变）：
 *   ① 引用核对 —— 本脚本**自动**判：反馈里出现的每个条目编号都必须在这个材料的编号集合里。
 *   ② 是否对应回答 / ③ 追问是否有针对性 / ④ 有没有把未验证说成已完成 —— 需要人读语义，
 *      本脚本只**原样落盘**反馈正文并给④一条关键词提示，**不代替人下结论**。
 *      ④ 一旦发生即整例不通过，由复核人填 `manualVerdict`。
 *
 * 前置：`cli auto` 已打开（端口见 WECHAT_AUTO_PORT），`ai` 已部署，当日**个人额度充足**
 * （实测日上限约 5 次，见主 README；不够时脚本会在第一次 quota_exhausted 停下并如实记录）。
 *
 * 用法：
 *   WECHAT_AUTO_PORT=9421 node scripts/verify-defense-g4-first-eval.cjs \
 *     --samples=docs/evidence/project-defense-g4/samples/frozen-2026-10-02.json \
 *     --out=docs/evidence/project-defense-g4/first-eval-2026-10-02.json
 *
 * 退出码：0 = 全部会话跑完（不代表判定通过）；1 = 没跑起来 / 中途被额度打断。
 */

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { connectMini } = require('./lib/mini-connect.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MODEL_WAIT_MS = 60000;

/** 材料编号的正则：两份材料共用 F/D 前缀，必须按材料分别匹配，否则会把 F1 判成 FC-2 的编号。 */
const ENTRY_PATTERNS = {
  'FC-1': /\b(?:INV-[123]|F[1-9])\b/g,
  'FC-2': /\b(?:INV-[AB]|D[1-8])\b/g,
};

/** ④ 的关键词提示（只做提示，不做判定）：「已完成/已验证/已测试」这类断言出现在待验证条目附近时标出来。 */
const DONE_WORDS = ['已验证', '验证通过', '已测试', '测过了', '已完成', '已实现', '做完', '通过验证'];

function parseArgs(argv) {
  const options = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const body = raw.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) options[body] = true;
    else options[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return options;
}

/** ① 引用核对：反馈里出现的编号必须全部在该材料的编号集合内。 */
function citationCheck(feedbackText, material) {
  const pattern = ENTRY_PATTERNS[material.id];
  if (pattern === undefined) throw new Error(`没有为 ${material.id} 配置编号正则`);
  const cited = [...new Set(String(feedbackText).match(pattern) ?? [])];
  const known = new Set(material.entries);
  const unknown = cited.filter((id) => !known.has(id));
  return {
    cited,
    unknown,
    supportRate: cited.length === 0 ? null : Number(((cited.length - unknown.length) / cited.length).toFixed(4)),
    pass: unknown.length === 0,
  };
}

/** ④ 的**提示**：待验证条目在反馈里是否被「已完成」类词包围。命中不等于判定不通过，需人读。 */
function outOfBoundsHint(feedbackText, mustStayUnverified) {
  const hits = [];
  const text = String(feedbackText);
  for (const id of mustStayUnverified) {
    const index = text.indexOf(id);
    if (index === -1) continue;
    const window = text.slice(Math.max(0, index - 60), index + 60);
    for (const word of DONE_WORDS) {
      if (window.includes(word)) {
        hits.push({ entry: id, word, window: window.trim() });
        break;
      }
    }
  }
  return hits;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const samplesFile = path.resolve(options.samples ?? 'docs/evidence/project-defense-g4/samples/frozen-2026-10-02.json');
  const rawBytes = fs.readFileSync(samplesFile);
  const frozen = JSON.parse(rawBytes.toString('utf8'));
  const freezeHash = createHash('sha256').update(rawBytes).digest('hex');

  // 先证判据没被改过：冻结时记下的哈希必须与当前文件一致。
  if (typeof options['expect-hash'] === 'string' && options['expect-hash'] !== freezeHash) {
    console.error(`❌ 冻结件哈希不符：期望 ${options['expect-hash']}，实际 ${freezeHash}。判据可能已被改动，拒绝开跑。`);
    process.exit(1);
  }

  const report = {
    startedAt: new Date().toISOString(),
    samplesFile: path.relative(process.cwd(), samplesFile).replace(/\\/gu, '/'),
    freezeHash,
    criteria: frozen.criteria,
    sessions: [],
    results: [],
    stoppedOnQuota: false,
  };

  // 断点续跑：个人日额度一次大约只够跑一个会话，而**留出样例的首次结果不能重来**。
  // 传入上一次的报告（`--resume=<文件>`）后，整段「样例都已判定过」的会话直接跳过——
  // 否则中途被打断后重跑，会把已经判定过的留出样例烧成第二次结果，那就不再是「首次」了。
  const doneSampleIds = new Set();
  if (typeof options.resume === 'string') {
    const resumePath = path.resolve(options.resume);
    const prior = JSON.parse(fs.readFileSync(resumePath, 'utf8'));
    for (const item of prior.results ?? []) {
      if (item.phase === 'feedback') doneSampleIds.add(item.sampleId);
    }
    report.resumedFrom = path.relative(process.cwd(), resumePath).replace(/\\/gu, '/');
    report.alreadyEvaluated = [...doneSampleIds];
  }

  const mini = await connectMini();
  let aborted = null;
  try {
    await mini.evaluate(() => undefined).catch(() => undefined);
    await sleep(1500);
    const system = await mini.systemInfo().catch(() => ({}));
    report.env = { platform: system.platform, model: system.model, SDKVersion: system.SDKVersion, realDevice: system.platform !== 'devtools' };

    for (const session of frozen.executionPlan.sessions) {
      // 整段会话都已判定过 → 跳过。会话内必须按轮次顺序提交，无法只跳过中间某一轮。
      if (session.rounds.every((step) => doneSampleIds.has(step.sampleId))) {
        report.sessions.push({ key: session.key, materialId: session.materialId, kind: session.kind, rounds: [], skipped: '本次运行前已判定，不重复消耗额度（留出样例的首次结果不可重来）' });
        continue;
      }
      const sessionRecord = { key: session.key, materialId: session.materialId, kind: session.kind, rounds: [] };
      report.sessions.push(sessionRecord);

      await mini.reLaunch('/pages/home/index');
      await sleep(2000);
      const home = await mini.currentPage();
      const entry = await home.$('#defense-entry');
      if (entry === null) throw new Error('首页找不到 #defense-entry');
      await entry.tap();
      await sleep(1500);
      const page = await mini.currentPage();
      if (page.path !== 'pages/defense/index') throw new Error(`没进到答辩练习页：${page.path}`);

      // 选对应材料：FC-1 是第 1 张卡，FC-2 是第 2 张。
      const materials = await page.$$('.material');
      const index = session.materialId === 'FC-1' ? 0 : 1;
      if (materials.length <= index) throw new Error(`材料页只有 ${materials.length} 张卡，取不到 ${session.materialId}`);
      await materials[index].tap();
      await sleep(800);

      for (const step of session.rounds) {
        const sample = frozen.samples.find((item) => item.id === step.sampleId);
        if (sample === undefined) throw new Error(`冻结件里没有样例 ${step.sampleId}`);
        const input = await page.$('.answer-input');
        if (input === null) throw new Error(`第 ${step.round} 轮找不到输入框`);
        await input.input(sample.answer);
        await sleep(300);
        const button = await page.$('.primary');
        if (button === null) throw new Error(`第 ${step.round} 轮找不到提交按钮`);

        const startedAt = Date.now();
        await button.tap();
        await sleep(600);
        let data = await page.data();
        while (data.phase === 'pending' && Date.now() - startedAt < MODEL_WAIT_MS) {
          await sleep(1000);
          data = await page.data();
        }
        const clientElapsedMs = Date.now() - startedAt;

        const sections = data.sections || [];
        const feedbackText = sections.map((section) => `${section.title}${section.body}`).join('\n');
        const material = { id: session.materialId, entries: frozen.materials[session.materialId].entries };
        const result = {
          sampleId: sample.id,
          group: sample.group,
          materialId: session.materialId,
          round: step.round,
          kind: sample.kind,
          answer: sample.answer,
          expectation: sample.expectation,
          phase: data.phase,
          failureTitle: data.failureTitle || '',
          clientElapsedMs,
          sections,
          feedbackText,
          ask: data.ask || '',
          judgement: {
            step1_citation: citationCheck(feedbackText, material),
            step2_corresponds: { verdict: '', note: '需人读语义' },
            step3_probeTargeted: { verdict: '', note: '需人读语义' },
            step4_unverifiedClaimedDone: { verdict: '', hints: outOfBoundsHint(feedbackText, frozen.materials[session.materialId].mustStayUnverified), note: 'hints 只是关键词提示，最终由复核人填 verdict；一旦成立即整例不通过' },
          },
        };
        sessionRecord.rounds.push({ round: step.round, sampleId: sample.id, phase: data.phase });
        report.results.push(result);

        if (data.phase === 'failure' && String(data.failureTitle).includes('额度')) {
          report.stoppedOnQuota = true;
          aborted = `样例 ${sample.id} 被 quota_exhausted 拦下，后续未执行`;
          break;
        }
        if (step.round < 3 && data.phase === 'feedback') {
          const next = await page.$('.primary');
          if (next !== null) {
            await next.tap();
            await sleep(1200);
          }
        }
      }
      if (report.stoppedOnQuota) break;
    }
  } catch (error) {
    aborted = error instanceof Error ? error.message : String(error);
  } finally {
    mini.disconnect();
  }

  report.finishedAt = new Date().toISOString();
  if (aborted !== null) report.aborted = aborted;
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (typeof options.out === 'string') {
    const file = path.resolve(options.out);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    console.error(`已写入 ${file}`);
  } else {
    console.log(text);
  }
  const ran = report.results.length;
  console.error(`\n跑完 ${ran}/${frozen.samples.length} 例${report.stoppedOnQuota ? '（额度打断）' : ''}；冻结件哈希 ${freezeHash}`);
  process.exit(aborted === null ? 0 : 1);
}

main().catch((error) => {
  console.error(`❌ 没跑起来：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
