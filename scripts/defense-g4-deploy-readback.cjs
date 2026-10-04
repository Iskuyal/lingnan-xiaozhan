/**
 * G4 部署回读比对：把「本地构建的 `ai`」与「从线上 `download` 回来的入口文件」逐字节比对。
 *
 * 判据不是「部署命令成功」，而是**回读的函数根目录入口文件与本地构建逐字节一致**
 * （见 docs/development/cloud/deployment.md 与 docs/evidence/project-defense-g4/README.md）。
 *
 * 只比**函数根目录的普通文件**：`node_modules/` 由云端 `--remote-npm-install` 安装，
 * 不属于这次判据，也比不动（数千个文件）。
 *
 * 用法：
 *   node scripts/defense-g4-deploy-readback.cjs \
 *     --dist=dist/cloudfunctions/ai \
 *     --archive=docs/evidence/project-defense-g4/deploy/after-2026-10-01 \
 *     --against=docs/evidence/project-defense-g4/deploy/before-2026-10-01 \
 *     --out=docs/evidence/project-defense-g4/deploy/manifest.json
 *
 * `--against` 可选：给了就把「部署前留档」的哈希一起写进清单，便于看出哪几个文件变了。
 * 退出码：0 = 全部一致；1 = 有不一致/缺失，或目录不存在。
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

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

/** 只取根目录普通文件，按名字排序；子目录（node_modules）直接跳过。 */
function rootFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

function hashOf(file) {
  const bytes = fs.readFileSync(file);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const distDir = path.resolve(options.dist ?? 'dist/cloudfunctions/ai');
  const archiveDir = path.resolve(options.archive ?? '');
  const againstDir = typeof options.against === 'string' ? path.resolve(options.against) : null;

  for (const [label, directory] of [['--dist', distDir], ['--archive', archiveDir]]) {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      console.error(`❌ ${label} 目录不存在：${directory}`);
      process.exit(1);
    }
  }

  const local = rootFiles(distDir);
  const remote = rootFiles(archiveDir);
  const against = againstDir !== null && fs.existsSync(againstDir) ? rootFiles(againstDir) : [];

  const files = [];
  let mismatched = 0;
  for (const name of [...new Set([...local, ...remote, ...against])].sort()) {
    const localPath = path.join(distDir, name);
    const remotePath = path.join(archiveDir, name);
    const againstPath = path.join(againstDir ?? '', name);
    const entry = {
      name,
      local: fs.existsSync(localPath) ? hashOf(localPath) : null,
      remote: fs.existsSync(remotePath) ? hashOf(remotePath) : null,
      before: againstDir !== null && fs.existsSync(againstPath) ? hashOf(againstPath) : null,
    };
    entry.identical = entry.local !== null && entry.remote !== null && entry.local.sha256 === entry.remote.sha256;
    entry.changedSinceDeploy = entry.before === null
      ? '新增（部署前不存在）'
      : (entry.remote !== null && entry.before.sha256 === entry.remote.sha256 ? '未变' : '已更新');
    if (!entry.identical) mismatched += 1;
    files.push(entry);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    dist: path.relative(process.cwd(), distDir).replace(/\\/gu, '/'),
    archive: path.relative(process.cwd(), archiveDir).replace(/\\/gu, '/'),
    before: againstDir === null ? null : path.relative(process.cwd(), againstDir).replace(/\\/gu, '/'),
    counts: { local: local.length, remote: remote.length, identical: files.filter((file) => file.identical).length, mismatched },
    files,
  };

  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (typeof options.out === 'string') {
    const file = path.resolve(options.out);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    console.error(`已写入 ${file}`);
  } else {
    console.log(text);
  }
  console.error(`本地 ${local.length} / 回读 ${remote.length} 个根目录文件；一致 ${report.counts.identical}，不一致 ${mismatched}`);
  process.exit(mismatched === 0 ? 0 : 1);
}

main();
