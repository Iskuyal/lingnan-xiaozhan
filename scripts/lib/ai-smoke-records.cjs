const { appendFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

function parseOptions(args) {
  let attempts = 1;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--attempts') {
      index += 1;
      if (index >= args.length) throw new Error('请为 --attempts 指定 1 到 5 的整数');
      attempts = Number(args[index]);
    } else if (arg.startsWith('--attempts=')) {
      attempts = Number(arg.slice('--attempts='.length));
    } else {
      throw new Error(`不支持的参数：${arg}`);
    }
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
      throw new Error('--attempts 只能是 1 到 5 的整数');
    }
  }
  return { attempts };
}

function makeAttemptRecord(input) {
  const result = input.result && typeof input.result === 'object' ? input.result : {};
  const invoked = input.invoked !== false;
  const ok = invoked && result.ok === true;
  return {
    smokeAt: input.smokeAt ?? new Date().toISOString(),
    runId: input.runId ?? '',
    attempt: input.attempt ?? 1,
    attempts: input.attempts ?? 1,
    realDevice: false,
    invoked,
    ok,
    retryable: !ok && result.failureClass === 'model_unavailable',
    failureClass: typeof result.failureClass === 'string' ? result.failureClass : null,
    elapsedMs: Number.isFinite(result.elapsedMs) ? result.elapsedMs : null,
    provider: typeof result.provider === 'string' ? result.provider : null,
    model: typeof result.model === 'string' ? result.model : null,
    system: input.system ?? null,
    request: input.request ?? null,
    response: result,
    ...(input.err ? { err: String(input.err) } : {}),
  };
}

function appendAttemptRecord(filename, record) {
  mkdirSync(path.dirname(filename), { recursive: true });
  appendFileSync(filename, `${JSON.stringify(record)}\n`, 'utf8');
}

module.exports = { appendAttemptRecord, makeAttemptRecord, parseOptions };
