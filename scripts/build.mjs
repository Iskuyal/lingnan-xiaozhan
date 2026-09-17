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
cpSync(resolve(root, 'project.config.json'), join(output, 'project.config.json'));
console.log('微信小程序已构建至 dist/');
