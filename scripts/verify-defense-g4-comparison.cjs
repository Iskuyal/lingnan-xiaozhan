/**
 * G4 对照实验：同材料同任务的**固定检查表**（= 已部署的答辩练习功能）vs **通用 AI 提示**。
 *
 * 目的（阶段方案 G4）：看「固定检查表」相对「把同一段回答丢给通用提示让模型自由点评」
 * 在**完成步骤、定位依据是否方便、人工判定的有效建议数、完成时间**上差在哪里。
 * **不故意弱化对照**：两边用同一份材料正文、同一段回答、同一个模型；
 * 通用提示写得合理（明确要求给具体建议），不是稻草人。
 *
 * 两边都记录**逐字原始输出**与**客户端端到端耗时**；「有效建议数」「定位依据是否方便」
 * 需要人读语义，脚本**留空**由复核人填，不自动打分。
 *
 * 前置：`cli auto` 已打开（端口见 WECHAT_AUTO_PORT），`ai` 已部署，当日个人额度充足。
 * 用法：
 *   WECHAT_AUTO_PORT=9421 node scripts/verify-defense-g4-comparison.cjs \
 *     --material=FC-1 --round=1 --out=docs/evidence/project-defense-g4/comparison-2026-10-02.json
 *
 * 退出码：0 = 两边都拿到输出；1 = 没跑起来 / 被额度打断。
 */
const fs = require('node:fs');
const path = require('node:path');
const { connectMini } = require('./lib/mini-connect.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MODEL_WAIT_MS = 60000;

/** 对照用的回答：与首评样例同一风格（引用条目编号、如实交代未验证项）。 */
const ANSWER = '这个功能是给需要把教务系统课表带进小程序的同学用的。F1 说明只能从微信聊天记录里选文件，不能浏览手机本地文件；F4 说明识别不出的字段只标记不猜，留给确认页裁决。F8 的三项我还没有验证。';

/** 通用提示：合理、明确要求可执行建议，不弱化对照。 */
const GENERIC_PROMPT = `下面是一份项目材料，以及一位同学对「这个功能是给谁、解决什么问题的」这一问的回答。
请你以评委的身份给出反馈：指出他讲清楚的地方、没讲清楚的地方，并给出具体可执行的改进建议。

【材料】
{{MATERIAL}}

【回答】
${ANSWER}`;

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

/** 取材料正文：与云函数同源，直接读构建产物，避免两份正文漂移。 */
function loadMaterialText(materialId) {
  const file = path.resolve('dist/cloudfunctions/ai/defense-materials.js');
  if (!fs.existsSync(file)) throw new Error(`找不到构建产物 ${file}，先跑 npm run build`);
  delete require.cache[file];
  const loaded = require(file);
  // 构建产物是 CommonJS 命名导出（`exports.DEFENSE_MATERIALS = [...]`），不是默认导出。
  const list = Array.isArray(loaded) ? loaded
    : (loaded.DEFENSE_MATERIALS ?? loaded.materials ?? loaded.defenseMaterials ?? loaded.default ?? loaded);
  const material = (Array.isArray(list) ? list : []).find((item) => item.id === materialId);
  if (material === undefined) throw new Error(`构建产物里没有材料 ${materialId}`);
  return material.text;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const materialId = typeof options.material === 'string' ? options.material : 'FC-1';
  const materialText = loadMaterialText(materialId);
  const report = {
    startedAt: new Date().toISOString(),
    materialId,
    answer: ANSWER,
    genericPromptChars: GENERIC_PROMPT.length,
    arms: {},
    humanScoring: {
      note: '以下四项需复核人读语义后填写，脚本不自动打分',
      fixedChecklist: { completedSteps: '', evidenceLookupEasy: '', validSuggestions: '', elapsedMs: null },
      genericPrompt: { completedSteps: '', evidenceLookupEasy: '', validSuggestions: '', elapsedMs: null },
    },
  };

  const mini = await connectMini();
  let aborted = null;
  try {
    await mini.evaluate(() => undefined).catch(() => undefined);
    await sleep(1500);
    const system = await mini.systemInfo().catch(() => ({}));
    report.env = { platform: system.platform, model: system.model, SDKVersion: system.SDKVersion };

    // ---- A 臂：固定检查表（已部署的答辩练习功能）----
    await mini.reLaunch('/pages/home/index');
    await sleep(2000);
    const home = await mini.currentPage();
    const entry = await home.$('#defense-entry');
    if (entry === null) throw new Error('首页找不到 #defense-entry');
    await entry.tap();
    await sleep(1500);
    const page = await mini.currentPage();
    const materials = await page.$$('.material');
    await materials[materialId === 'FC-1' ? 0 : 1].tap();
    await sleep(800);
    await (await page.$('.answer-input')).input(ANSWER);
    await sleep(300);
    const startA = Date.now();
    await (await page.$('.primary')).tap();
    await sleep(600);
    let data = await page.data();
    while (data.phase === 'pending' && Date.now() - startA < MODEL_WAIT_MS) {
      await sleep(1000);
      data = await page.data();
    }
    const elapsedA = Date.now() - startA;
    report.arms.fixedChecklist = {
      elapsedMs: elapsedA,
      phase: data.phase,
      failureTitle: data.failureTitle || '',
      sections: data.sections || [],
      ask: data.ask || '',
      text: (data.sections || []).map((section) => `${section.title}${section.body}`).join('\n'),
    };
    report.humanScoring.fixedChecklist.elapsedMs = elapsedA;
    if (data.phase === 'failure' && String(data.failureTitle).includes('额度')) {
      report.arms.genericPrompt = { skipped: 'A 臂被额度拦下，B 臂不执行' };
      aborted = '额度不足，对照实验未跑完';
    } else {
      // ---- B 臂：通用 AI 提示（同一个模型、同一份材料与回答）----
      await mini.reLaunch('/pages/home/index');
      await sleep(1800);
      await mini.evaluate(() => {
        globalThis.__g4BenchOriginal = wx.cloud.callFunction.bind(wx.cloud);
      });
      const prompt = GENERIC_PROMPT.replace('{{MATERIAL}}', materialText);
      const startB = Date.now();
      const result = await mini.evaluate(async (text) => {
        const response = await wx.cloud.callFunction({
          name: 'ai',
          data: { action: 'chat', feature: 'benchmark-generic', messages: [{ role: 'user', text }] },
        });
        return response.result;
      }, prompt);
      const elapsedB = Date.now() - startB;
      report.arms.genericPrompt = {
        elapsedMs: elapsedB,
        ok: result && result.ok === true,
        failureClass: (result && result.failureClass) || '',
        message: (result && result.message) || '',
        text: (result && result.text) || '',
        usage: (result && result.usage) || null,
        safety: (result && result.safety) || null,
      };
      report.humanScoring.genericPrompt.elapsedMs = elapsedB;
      if (!result || result.ok !== true) aborted = `B 臂未拿到输出：${(result && result.failureClass) || '未知'}`;
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
  process.exit(aborted === null ? 0 : 1);
}

main().catch((error) => {
  console.error(`❌ 没跑起来：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
