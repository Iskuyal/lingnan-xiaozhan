/** 部门固定题集的真实产品云链路评测；--plan 不连接工具、不计费。
 * node scripts/eval-department-cloud.cjs --max-calls=10 --out=artifacts/department-rag/cloud.json
 * 逐题语义与引用支持需要独立读原文；本脚本仅采集，不自动宣称质量达标。
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  const options = { plan: false, maxCalls: 10, out: 'artifacts/department-rag/cloud.json' };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--plan') options.plan = true;
    else if (arg.startsWith('--max-calls=')) options.maxCalls = Number(arg.slice(12));
    else if (arg.startsWith('--out=')) options.out = arg.slice(6);
    else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isInteger(options.maxCalls) || options.maxCalls < 0 || options.maxCalls > 10) {
    throw new Error('--max-calls 必须是 0–10 的整数');
  }
  const bankPath = path.join(root, 'docs/evidence/department-rag/questions.json');
  const bank = JSON.parse(fs.readFileSync(bankPath, 'utf8'));
  const qa = require(path.join(root, 'dist/pages/departments/qa.js'));
  const report = {
    startedAt: new Date().toISOString(),
    gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    questionSetSha256: createHash('sha256').update(fs.readFileSync(bankPath)).digest('hex'),
    proofBoundary: '产品请求与云端返回；guardTurn 是产品守卫，不是独立事实判定。原始模型与上屏答案分别核对。',
    cloudAttempts: 0,
    rows: bank.questions.map((q) => ({ ...q, event: qa.qaChatEvent([{ role: 'user', text: q.q }]), done: false })),
  };
  if (options.plan) { console.log(JSON.stringify(report)); return; }
  const output = path.resolve(root, options.out);
  if (fs.existsSync(output)) throw new Error('输出已存在；请使用新文件保留首次结果');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  save();
  const { connectMini } = require('./lib/mini-connect.cjs');
  const mini = await connectMini();
  try {
    for (const row of report.rows) {
      if (report.cloudAttempts >= options.maxCalls) break;
      console.log(`调用 ${row.id}（第 ${report.cloudAttempts + 1} 次）…`);
      const startedAt = Date.now();
      await mini.evaluate((serialized) => {
        globalThis.__departmentEval = { done: false };
        wx.cloud.callFunction({ name: 'ai', data: JSON.parse(serialized) }).then(
          (r) => { globalThis.__departmentEval = { done: true, result: r.result }; },
          (e) => { globalThis.__departmentEval = { done: true, error: String(e.errMsg || e.message || e) }; },
        );
      }, JSON.stringify(row.event));
      report.cloudAttempts++;
      let snapshot = { done: false };
      while (!snapshot.done && Date.now() - startedAt < 90000) {
        await sleep(1000);
        snapshot = await mini.evaluate(() => globalThis.__departmentEval);
      }
      row.clientElapsedMs = Date.now() - startedAt;
      row.result = snapshot.result || null;
      row.error = snapshot.error || (!snapshot.done ? '90 秒内未收到返回' : '');
      row.done = snapshot.done && !row.error && row.result?.ok === true;
      if (row.done) row.displayTurn = qa.guardTurn(row.result.text, row.expectedDepartmentId, row.q, row.result.citations);
      save();
      console.log(`  → ${row.done ? 'ok' : row.result?.failureClass || row.error} ${row.clientElapsedMs}ms`);
      if (row.result?.failureClass === 'quota_exhausted' || row.error) break;
      // 固定分钟额度留出余量，不自动重试失败样例或改变提示词。
      if (Date.now() - startedAt < 12000) await sleep(12000 - (Date.now() - startedAt));
    }
  } finally {
    mini.disconnect();
    report.finishedAt = new Date().toISOString();
    report.completed = report.rows.filter((r) => r.done).length;
    report.pending = report.rows.filter((r) => !r.done).map((r) => r.id);
    save();
  }
  console.log(`真实产品云请求 ${report.cloudAttempts} 次，成功返回 ${report.completed}/${report.rows.length}；语义与引用待独立核对。`);
  if (report.pending.length) process.exitCode = 2;
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; });
