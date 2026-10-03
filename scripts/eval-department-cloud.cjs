/** 部门首次产品云采集；题集先冻结，三项评分由逐题来源核对给出。 */
const fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function parseArgs(argv) {
    const o = { plan: false, maxCalls: 10, out: 'artifacts/department-rag/cloud.json', questions: '', budget: '', cloudManifest: '', blockedReason: '' };
    const fields = { '--out=': 'out', '--questions=': 'questions', '--budget=': 'budget', '--cloud-manifest=': 'cloudManifest', '--blocked-reason=': 'blockedReason' };
    for (const a of argv) {
        if (a === '--plan')
            o.plan = true;
        else if (a.startsWith('--max-calls='))
            o.maxCalls = Number(a.slice(12));
        else {
            const k = Object.keys(fields).find(k => a.startsWith(k));
            if (!k || !a.slice(k.length).trim())
                throw Error(`未知或空参数：${a}`);
            o[fields[k]] = a.slice(k.length);
        }
    }
    if (!Number.isInteger(o.maxCalls) || o.maxCalls < 0 || o.maxCalls > 30)
        throw Error('--max-calls必须是0–30整数');
    if (o.blockedReason && o.maxCalls !== 0)
        throw Error('阻塞记录须max-calls=0');
    return o;
}
function sourceValue(ref, departments) {
    const d = departments.find(d => d.id === ref?.departmentId);
    if (!d || !['introduction', 'unitNote', 'units', 'contacts', 'campus', 'campusNote', 'activities'].includes(ref.field))
        return undefined;
    if (ref.field !== 'activities')
        return d[ref.field];
    if (!ref.value || typeof ref.value !== 'object')
        return undefined;
    return d.activities.find(a => a.title === ref.value.title && a.publishedAt === ref.value.publishedAt && a.sourceUrl === ref.value.sourceUrl);
}
function loadBank(file, independent, departments) {
    const bank = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!bank || !Array.isArray(bank.questions) || bank.questions.length < 10)
        throw Error('题集至少10题');
    if (independent && (typeof bank.datasetId !== 'string' || !bank.datasetId.trim() || typeof bank.frozenAt !== 'string' || !Number.isFinite(Date.parse(bank.frozenAt))))
        throw Error('独立题集须登记datasetId及有效冻结时间');
    if (independent && (!bank.judgeRules || ['supportedAnswer', 'missingExplained', 'unsupportedDisplay'].some(k => typeof bank.judgeRules[k] !== 'string' || !bank.judgeRules[k].trim())))
        throw Error('须分别登记三项评分判据');
    if (bank.sourceSnapshotFile !== undefined) {
        const snapshotFile = path.resolve(path.dirname(file), bank.sourceSnapshotFile);
        if (path.dirname(snapshotFile) !== path.resolve(path.dirname(file))) throw Error('来源快照必须与题库同目录');
        if (hash(snapshotFile) !== bank.sourceSnapshotSha256) throw Error('来源快照哈希与实际文件不一致');
        const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
        if (!isDeepStrictEqual(snapshot.departments, departments)) throw Error('来源快照与实际产品资料不一致');
    }
    const ids = new Set(), kinds = ['base', 'activity', 'organizer_unknown', 'detail_missing', 'latest_unknown', 'no_hit', 'event_date_unknown'];
    for (const q of bank.questions) {
        if (!q || typeof q.id !== 'string' || !q.id.trim() || ids.has(q.id))
            throw Error('题号为空或重复');
        ids.add(q.id);
        if (typeof q.q !== 'string' || !q.q.trim() || q.q.length > 1500)
            throw Error('题面为空或超长');
        if (!departments.some(d => d.id === q.expectedDepartmentId))
            throw Error('题目部门不在随包资料');
        if (!kinds.includes(q.kind) || typeof q.expectedAnswer !== 'string' || !q.expectedAnswer.trim())
            throw Error('类型或预期无效');
        if (!independent)
            continue;
        if (!Array.isArray(q.sourceRefs) || (!q.sourceRefs.length && q.kind !== 'no_hit') || !Array.isArray(q.missingFields) || q.missingFields.some(v => typeof v !== 'string' || !v.trim()))
            throw Error('来源或缺失字段无效');
        for (const ref of q.sourceRefs) {
            const v = sourceValue(ref, departments);
            if (v === undefined || !isDeepStrictEqual(v, ref.value))
                throw Error(`来源与随包资料不符：${q.id}`);
        }
    }
    return bank;
}
function buildHashes() {
    const dir = path.join(root, 'dist/cloudfunctions/ai');
    const files = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile()).map(e => [`cloud/${e.name}`, path.join(dir, e.name)]);
    for (const [label, file] of [['qa.js', 'pages/departments/qa.js'], ['departments.js', 'services/departments.js'], ['ai.js', 'services/ai.js'], ['cloud.js', 'services/cloud.js']])
        files.push([`client/${label}`, path.join(root, 'dist', file)]);
    return Object.fromEntries(files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, f]) => [k, hash(f)]));
}
function createReport(o) {
    const file = path.resolve(root, o.questions || 'docs/evidence/department-rag/questions.json');
    const departments = require(path.join(root, 'dist/services/departments.js')).departments;
    const qa = require(path.join(root, 'dist/pages/departments/qa.js'));
    const bank = loadBank(file, Boolean(o.questions), departments);
    return { startedAt: new Date().toISOString(), gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), datasetId: bank.datasetId || 'legacy-department-10', frozenAt: bank.frozenAt || null, questionSetSha256: hash(file), collectorSha256: hash(__filename), buildHashes: buildHashes(), judgeRules: bank.judgeRules || null, proofBoundary: '真实产品qaChatEvent/guardTurn；guardTurn重算页面数据不是真实截图。检索、安全通过、标题安全不等于问题回答正确。', cloudAttempts: 0, stoppedReason: o.blockedReason || '', humanReview: 'pending', rows: bank.questions.map(q => ({ ...q, event: qa.qaChatEvent([{ role: 'user', text: q.q }]), execution: 'not_called', done: false, scores: { supportedAnswer: null, missingExplained: null, unsupportedDisplay: null } })) };
}
function stopReason(result, error = '') {
    if (error)
        return 'transport_failed';
    if (result?.failureClass === 'quota_exhausted')
        return 'quota_exhausted';
    if (/记账|核账|accounting|审核.*配额|检测.*配额/iu.test([result?.detail || '', ...(result?.warnings || [])].join(' ')) || result?.usage?.usageUnknown === true)
        return 'accounting_or_safety_quota';
    if (result?.ok === true && result.safety?.checked !== true)
        return 'safety_unchecked';
    return '';
}
function applyResult(row, state, qa) {
    const client = require(path.join(root, 'dist/services/ai.js'));
    row.cloudElapsedMs = Number.isFinite(state.elapsedMs) ? state.elapsedMs : null;
    row.clientTimedOut = row.cloudElapsedMs !== null && row.cloudElapsedMs >= client.AI_CALL_TIMEOUT_MS;
    row.clientElapsedMs = row.clientTimedOut ? client.AI_CALL_TIMEOUT_MS : row.cloudElapsedMs;
    row.result = state.result || null;
    row.error = state.error || '';
    row.execution = row.clientTimedOut ? 'client_timeout' : row.error ? 'transport_failed' : 'cloud_returned';
    row.done = !row.clientTimedOut && !row.error && row.result?.ok === true;
    row.rawModelText = typeof row.result?.text === 'string' ? row.result.text : '';
    row.serverElapsedMs = row.result?.elapsedMs ?? null;
    row.usage = row.result?.usage ?? null;
    row.rawCitations = row.result?.citations ?? [];
    const normalized = row.clientTimedOut ? client.timedOutResult() : row.result === null ? null : client.aiResultOf(row.result);
    row.displayTurn = row.done ? qa.guardTurn(normalized.text, row.expectedDepartmentId, row.q, normalized.citations) : null;
    row.displayText = row.displayTurn?.text ?? '';
    row.displayWarning = row.displayTurn?.warning ?? '';
    row.displayCitations = row.displayTurn?.citations ?? [];
    row.failureMessage = row.done ? '' : normalized ? client.userMessage(normalized) : client.transportMessage(new Error(row.error));
    row.displayProof = 'Node运行产品guardTurn重算页面数据，非真实页面截图或真机';
}
async function cloudRequest(mini, event) {
    await mini.evaluate(serialized => { const start = Date.now(); globalThis.__departmentEval = { done: false }; wx.cloud.callFunction({ name: 'ai', data: JSON.parse(serialized) }).then(r => { globalThis.__departmentEval = { done: true, result: r.result, elapsedMs: Date.now() - start }; }, e => { globalThis.__departmentEval = { done: true, error: String(e.errMsg || e.message || e), elapsedMs: Date.now() - start }; }); return 'started'; }, JSON.stringify(event));
    const deadline = Date.now() + 90000;
    do {
        await sleep(500);
        const state = await mini.evaluate(() => globalThis.__departmentEval);
        if (state.done)
            return state;
    } while (Date.now() < deadline);
    return { error: '90秒内未收到返回，未重试', elapsedMs: null };
}
function validateBudget(file, calls) {
    if (!file)
        throw Error('真实调用前须--budget登记用量与核账状态');
    const b = JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'));
    if (b.accountingReconciled !== true)
        throw Error('此前记账故障未确认核账，保持停止');
    if (!Number.isInteger(b.maxCloudCalls) || b.maxCloudCalls < calls || !b.usageSnapshot || b.safetyQuota === undefined)
        throw Error('预算登记不完整');
    const s = JSON.parse(fs.readFileSync(path.resolve(root, b.usageSnapshot), 'utf8')).result;
    if (s?.ok !== true || s.usageSummary?.exceeded || s.capWarning || !Number.isInteger(s.userDailyLimit?.remaining) || s.userDailyLimit.remaining < calls)
        throw Error('用量快照异常或日余量不足');
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    if (s.userDailyLimit.day !== today)
        throw Error('日余量快照不是当前东八区日期');
    return b;
}
function loadCloudManifest(file, report) {
    if (!file)
        throw Error('真实调用须--cloud-manifest登记实际回读哈希');
    const m = JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'));
    const actual = Object.fromEntries(m.files.filter(f => f.remote?.sha256).map(f => [`cloud/${f.name}`, f.remote.sha256]));
    for (const k of ['cloud/index.js', 'cloud/providers.js', 'cloud/rag.js', 'cloud/department-corpus.js'])
        if (!actual[k])
            throw Error('云回读缺必要文件');
    for (const k of ['cloud/rag.js', 'cloud/department-corpus.js'])
        if (actual[k] !== report.buildHashes[k])
            throw Error('实际云检索或语料与冻结产品不一致');
    return actual;
}
async function collect(report, o, request, save, qa, pace = sleep) {
    for (const row of report.rows) {
        if (report.stoppedReason || report.cloudAttempts >= o.maxCalls) {
            row.notCalledReason = report.stoppedReason || 'batch_budget';
            continue;
        }
        const start = Date.now();
        report.cloudAttempts++;
        let state;
        try {
            state = await request(row.event);
        }
        catch (e) {
            state = { error: e.message, elapsedMs: null };
        }
        applyResult(row, state, qa);
        row.fingerprint = { questionSetSha256: report.questionSetSha256, collectorSha256: report.collectorSha256, buildHashes: report.buildHashes, deployedCloudHashes: report.deployedCloudHashes };
        report.stoppedReason = row.clientTimedOut ? 'client_timeout' : stopReason(row.result, row.error);
        save(row);
        console.log(`  ${row.id}: ${row.done ? 'returned' : row.result?.failureClass || row.error}；端到端${row.clientElapsedMs ?? '未知'}ms，尚未语义评分`);
        if (!report.stoppedReason && Date.now() - start < 12000)
            await pace(12000 - (Date.now() - start));
    }
}
async function run(argv = process.argv.slice(2)) {
    const o = parseArgs(argv), report = createReport(o);
    if (o.plan) {
        console.log(JSON.stringify(report));
        return;
    }
    const out = path.resolve(root, o.out), jsonl = `${out}.jsonl`;
    if (fs.existsSync(out) || fs.existsSync(jsonl))
        throw Error('输出已存在；使用新路径保留首次结果');
    if (o.maxCalls > 0) {
        report.budget = validateBudget(o.budget, o.maxCalls);
        report.deployedCloudHashes = loadCloudManifest(o.cloudManifest, report);
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const save = row => { if (row)
        fs.appendFileSync(jsonl, JSON.stringify(row) + '\n'); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); };
    save();
    let mini;
    try {
        if (o.maxCalls > 0) {
            mini = await require('./lib/mini-connect.cjs').connectMini();
            await mini.reLaunch('/pages/home/index');
            report.env = await mini.systemInfo();
            const current = await cloudRequest(mini, { action: 'usage' });
            report.usageBefore = current;
            if (current.result?.ok !== true || !Number.isInteger(current.result.userDailyLimit?.remaining) || current.result.userDailyLimit.remaining < o.maxCalls || current.result.usageSummary?.exceeded)
                throw Error('即时用量核对失败，未发业务请求');
            await collect(report, o, event => cloudRequest(mini, event), save, require(path.join(root, 'dist/pages/departments/qa.js')));
        }
        else {
            report.stoppedReason = o.blockedReason || 'batch_budget_zero';
            for (const row of report.rows)
                row.notCalledReason = report.stoppedReason;
        }
    }
    catch (e) {
        report.error = e.message;
        report.stoppedReason ||= 'preflight_or_transport_failure';
        process.exitCode = 1;
    }
    finally {
        if (mini)
            mini.disconnect();
        report.finishedAt = new Date().toISOString();
        report.completed = report.rows.filter(r => r.done).length;
        report.pending = report.rows.filter(r => !r.done).map(r => r.id);
        report.scores = { supportedAnswer: null, missingExplained: null, unsupportedDisplay: null, reason: '未做逐题语义复核；未调用不填0或正确' };
        save();
    }
    console.log(`真实业务云请求${report.cloudAttempts}次，返回成功${report.completed}/${report.rows.length}，其余保留未执行或失败`);
    if (report.pending.length && !process.exitCode)
        process.exitCode = 2;
}
module.exports = { parseArgs, sourceValue, loadBank, buildHashes, createReport, stopReason, applyResult, cloudRequest, validateBudget, loadCloudManifest, collect, run };
if (require.main === module)
    run().catch(e => { console.error(e.message); process.exitCode = 1; });
