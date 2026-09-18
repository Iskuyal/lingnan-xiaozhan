import { cpSync, mkdirSync, readdirSync, copyFileSync, rmSync, lstatSync, existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'dist');
// 仅清理仓库内固定生成目录，拒绝符号链接或联接点。
if (relative(root, output) !== 'dist' || (existsSync(output) && lstatSync(output).isSymbolicLink())) {
  throw new Error('构建输出目录必须是仓库内的 dist 实体目录');
}
// 开发者工具可能占用 dist 目录句柄，因此保留目录本身，仅清理其内容。
if (existsSync(output)) {
  for (const name of readdirSync(output)) {
    rmSync(join(output, name), { recursive: true, force: true });
  }
}
const result = spawnSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc')], {
  cwd: root, stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

function copyAssets(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyAssets(from, to);
    else if (!entry.name.endsWith('.ts')) copyFileSync(from, to);
  }
}
copyAssets(resolve(root, 'miniprogram'), output);

// 云函数：单独一份 tsconfig（运行时是 Node，不是小程序），编译进 dist/cloudfunctions，
// 再复制各函数的非 TS 文件。开发者工具与 CLI 部署都以 project.config.json 的
// cloudfunctionRoot 在 dist 内查找云函数。
const functionsRoot = resolve(root, 'cloudfunctions');
if (existsSync(functionsRoot)) {
  const compiled = spawnSync(process.execPath, [
    resolve(root, 'node_modules/typescript/bin/tsc'), '-p', join(functionsRoot, 'tsconfig.json'),
  ], { cwd: root, stdio: 'inherit' });
  if (compiled.error) throw compiled.error;
  if (compiled.status !== 0) process.exit(compiled.status ?? 1);
  for (const entry of readdirSync(functionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = join(functionsRoot, entry.name);
    const target = join(output, 'cloudfunctions', entry.name);
    mkdirSync(target, { recursive: true });
    for (const file of readdirSync(source, { withFileTypes: true })) {
      if (!file.isFile() || file.name.endsWith('.ts') || file.name === 'tsconfig.json') continue;
      copyFileSync(join(source, file.name), join(target, file.name));
    }
  }
}

cpSync(resolve(root, 'project.config.json'), join(output, 'project.config.json'));
console.log('微信小程序已构建至 dist/');
