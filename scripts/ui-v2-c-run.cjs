#!/usr/bin/env node
/**
 * C 分支并行开发用的构建 + 定向测试跑手（ui-v2-c 前缀，仅本人分支使用）。
 *
 * 为什么需要它：C 的三个人在同一个 worktree 里改不同的页面目录，但 `dist/` 只有一份。
 * 两个人同时 `node scripts/build.mjs` 会互相删文件、读半成品，测试结果就没意义了。
 * 这里用一把基于 mkdir 的租约把「构建 + 跑测试」串起来，谁先拿到谁先跑，其余等待。
 *
 * 用法：
 *   node scripts/ui-v2-c-run.cjs                      只构建
 *   node scripts/ui-v2-c-run.cjs tests/ui-v2-c-x.test.cjs ...   构建后跑指定测试文件
 *   node scripts/ui-v2-c-run.cjs --no-build tests/...  跳过构建（刚刚构建过时用）
 *   node scripts/ui-v2-c-run.cjs --wait 600           租约最长等 600 秒（默认 900）
 *
 * 退出码：构建失败 1；测试失败沿用 node --test 的退出码；等不到租约 3。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const LOCK_DIR = path.join(ROOT, '.scratch', 'build-lock');
const OWNER_FILE = path.join(LOCK_DIR, 'owner');

function sleep(ms) {
  // 同步等待：整个脚本本来就是一条命令，没必要引入异步。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseArgs(argv) {
  const files = [];
  let build = true;
  let waitSeconds = 900;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-build') build = false;
    else if (arg === '--wait') {
      index += 1;
      const value = Number(argv[index]);
      if (Number.isFinite(value) && value > 0) waitSeconds = value;
    } else files.push(arg);
  }
  return { files, build, waitSeconds };
}

function ownerTag() {
  const who = process.env.UI_V2_C_OWNER || 'c';
  return `${who} pid=${process.pid}`;
}

/** 抢锁：先写临时目录再 rename，rename 在同一文件系统上是原子的，目标已存在就失败。 */
function tryAcquire() {
  fs.mkdirSync(path.dirname(LOCK_DIR), { recursive: true });
  const stamp = `${process.pid}-${Date.now().toString(36)}`;
  const staging = `${LOCK_DIR}.${stamp}`;
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'owner'), ownerTag(), 'utf8');
  try {
    fs.renameSync(staging, LOCK_DIR);
    return true;
  } catch {
    fs.rmSync(staging, { recursive: true, force: true });
    return false;
  }
}

function acquireWithWait(waitSeconds, label) {
  const deadline = Date.now() + waitSeconds * 1000;
  let announced = false;
  for (;;) {
    if (tryAcquire()) return true;
    let holder = '';
    try {
      holder = fs.readFileSync(OWNER_FILE, 'utf8').trim();
    } catch {
      /* 正好在换手，忽略。 */
    }
    const stale = holder === '' ? false : !isAlive(holder);
    if (stale) {
      // 上一个持有者已经不在（崩溃 / 被 Ctrl-C），直接清掉，避免整队卡死。
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
      continue;
    }
    if (!announced) {
      console.log(`[c-run] 等待构建租约（占用者：${holder || '未知'}），${label}`);
      announced = true;
    }
    if (Date.now() > deadline) return false;
    sleep(500);
  }
}

function isAlive(owner) {
  const match = /pid=(\d+)/.exec(owner);
  if (match === null) return true;
  const pid = Number(match[1]);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function release() {
  fs.rmSync(LOCK_DIR, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: false });
  if (result.error) {
    console.error(`[c-run] 无法启动 ${command}: ${result.error.message}`);
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

function main() {
  const { files, build, waitSeconds } = parseArgs(process.argv.slice(2));
  const label = files.length > 0 ? files.join(' ') : '仅构建';
  if (!acquireWithWait(waitSeconds, label)) {
    console.error(`[c-run] 等了 ${waitSeconds} 秒仍没拿到租约：${LOCK_DIR}`);
    console.error('[c-run] 若确认没人在构建，删掉这个目录再试。');
    return 3;
  }
  try {
    if (build) {
      console.log('[c-run] 构建 dist/ …');
      const status = run(process.execPath, ['scripts/build.mjs']);
      if (status !== 0) {
        console.error('[c-run] 构建失败，未运行测试。');
        return 1;
      }
    }
    if (files.length === 0) return 0;
    console.log(`[c-run] node --test --test-concurrency=1 ${files.join(' ')}`);
    return run(process.execPath, ['--test', '--test-concurrency=1', ...files]);
  } finally {
    release();
  }
}

process.exitCode = main();
