import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const blank = (text) => text.replace(/[^\n]/g, ' ');

// Keep offsets and line numbers stable while excluding fenced examples.
function maskExamples(markdown) {
  let fence = null;
  return markdown.replace(/\r\n/g, '\n').split('\n').map((line) => {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = null;
      return blank(line);
    }
    if (match) { fence = match[1]; return blank(line); }
    return line;
  }).join('\n').replace(/<!--[\s\S]*?-->/g, blank);
}

/** Extract inline, reference-definition and HTML links, excluding code examples. */
export function extractLinks(markdown) {
  const text = maskExamples(markdown).replace(/(`+)[\s\S]*?\1(?!`)/g, blank);
  const links = [];
  const add = (url, offset) => links.push({
    url: url.replace(/\\([\\()[\]<> ])/g, '$1'),
    line: text.slice(0, offset).split('\n').length,
  });
  // Scan the destination separately so parentheses in file names remain valid.
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(\s*/g)) {
    if (match.index > 0 && text[match.index - 1] === '\\') continue;
    const start = match.index + match[0].length;
    if (text[start] === '<') {
      const end = text.indexOf('>', start + 1);
      if (end !== -1) add(text.slice(start + 1, end), match.index);
      continue;
    }
    let end = start;
    let depth = 0;
    for (; end < text.length; end++) {
      const char = text[end];
      if (char === '\\') { end++; continue; }
      if (char === '(') depth++;
      else if (char === ')') { if (depth === 0) break; depth--; }
      else if (/\s/.test(char)) break;
    }
    if (end > start) add(text.slice(start, end), match.index);
  }
  for (const match of text.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm)) add(match[1] ?? match[2], match.index);
  for (const match of text.matchAll(/<(?:a|img|source)\b[^>]*?\b(?:href|src)\s*=\s*["']([^"']+)["'][^>]*>/gi)) add(match[1], match.index);
  return links.sort((a, b) => a.line - b.line);
}

function headingAnchors(markdown) {
  const text = maskExamples(markdown);
  const anchors = new Set();
  const headings = new Set();
  for (const match of text.matchAll(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gm)) {
    const slug = match[1]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '')
      .replace(/\s/g, '-');
    let id = slug;
    for (let suffix = 1; headings.has(id); suffix++) id = `${slug}-${suffix}`;
    headings.add(id);
    anchors.add(id);
  }
  for (const match of text.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/g)) anchors.add(match[1]);
  return anchors;
}

export function collectDocumentationFiles(root) {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.md'], { cwd: root, encoding: 'utf8' });
  // A move leaves deleted tracked paths in the index until staged. Check the working tree.
  return [...new Set(output.split('\0').filter(Boolean))]
    .filter((file) => existsSync(path.resolve(root, file))).sort();
}

/**
 * 收集 Git 索引中的路径；新增链接目标先 `git add`，才能证明交付不会漏文件。
 *
 * 为什么需要：`checkDocuments` 原来只看磁盘，因此**查不出指向 `artifacts/`、`dist/` 这类
 * 被 gitignore 的路径的链接**——本地有文件、CI 的干净检出里没有（PR #127 就是这样被拦下的）。
 *
 * 文档扫描仍包含未跟踪的新 Markdown，提前发现新文档中的坏链接；但链接目标只认索引，
 * 未被忽略不代表已提交，不能据此声称它会出现在干净检出里。
 *
 * **必须用 `-z`**：默认输出会把非 ASCII 文件名转义成 `\xxx`，中文文件名会误报。
 */
export function collectVisibleFiles(root) {
  const output = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: root, encoding: 'utf8' });
  return new Set(output.split('\0').filter(Boolean));
}

/**
 * Validate repository-local paths and Markdown fragments without accessing the network.
 *
 * `visible`（可选）是 {@link collectVisibleFiles} 的返回值：给了它就要**同时**校验
 * 「链接目标能否出现在干净检出里」，没给则只校验磁盘（供不依赖 git 的单元测试使用）。
 */
export function checkDocuments({ root, files, visible }) {
  root = path.resolve(root);
  const errors = [];
  const directoryEntries = new Map();
  const anchorCache = new Map();
  let filesChecked = 0;
  let linksChecked = 0;
  const inside = (target) => {
    const relative = path.relative(root, target);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  const exactExists = (target) => {
    let directory = root;
    for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
      if (!directoryEntries.has(directory)) {
        directoryEntries.set(directory, new Set(existsSync(directory) && statSync(directory).isDirectory() ? readdirSync(directory) : []));
      }
      if (!directoryEntries.get(directory).has(segment)) return false;
      directory = path.join(directory, segment);
    }
    return true;
  };
  // 链接目标必须在「git 能看见」的集合里：只在磁盘上存在、却被 .gitignore 忽略的目标，
  // 在 CI 的干净检出里不存在。目录链接按「目录下有没有可见文件」判断（git 不跟踪目录本身）。
  const visibleFiles = new Set();
  const visibleDirectories = new Set();
  if (visible !== undefined) {
    for (const entry of visible) {
      const absolute = path.resolve(root, entry);
      visibleFiles.add(absolute);
      for (let directory = path.dirname(absolute); inside(directory) && directory !== root; directory = path.dirname(directory)) {
        visibleDirectories.add(directory);
      }
    }
  }
  for (const file of files) {
    const source = path.resolve(root, file);
    if (!inside(source) || !existsSync(source)) {
      errors.push({ file, line: 1, url: file, message: '源文档不在仓库内或不存在' });
      continue;
    }
    filesChecked++;
    for (const { url, line } of extractLinks(readFileSync(source, 'utf8'))) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) continue;
      linksChecked++;
      const error = (message) => errors.push({ file, line, url, message });
      const hash = url.indexOf('#');
      const withoutHash = hash < 0 ? url : url.slice(0, hash);
      let destination;
      let fragment;
      try {
        destination = decodeURIComponent(withoutHash.split('?')[0]);
        fragment = hash < 0 ? '' : decodeURIComponent(url.slice(hash + 1));
      } catch { error('链接含无效的百分号编码'); continue; }
      const target = destination
        ? destination.startsWith('/') ? path.resolve(root, '.' + destination) : path.resolve(path.dirname(source), destination)
        : source;
      if (!inside(target)) { error('链接指向仓库外部的本地路径'); continue; }
      if (!exactExists(target)) { error('目标不存在或路径大小写不一致'); continue; }
      if (visible !== undefined && target !== root) {
        const isDirectory = statSync(target).isDirectory();
        const inGit = isDirectory ? visibleDirectories.has(target) : visibleFiles.has(target);
        if (!inGit) { error('目标不在 git 里：被 .gitignore 忽略的文件在 CI 的干净检出中不存在'); continue; }
      }
      if (fragment && /\.md$/i.test(target)) {
        if (!anchorCache.has(target)) anchorCache.set(target, headingAnchors(readFileSync(target, 'utf8')));
        if (!anchorCache.get(target).has(fragment)) error(`文档锚点不存在：#${fragment}`);
      }
    }
  }
  return { filesChecked, linksChecked, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const result = checkDocuments({ root, files: collectDocumentationFiles(root), visible: collectVisibleFiles(root) });
    for (const error of result.errors) console.error(`${error.file}:${error.line} ${error.message} (${error.url})`);
    console.log(`文档检查：${result.filesChecked} 个 Markdown，${result.linksChecked} 个本地引用，${result.errors.length} 个错误。`);
    if (result.errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(`文档检查失败：${error.message}`);
    process.exitCode = 1;
  }
}
