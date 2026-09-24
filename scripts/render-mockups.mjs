/**
 * 设计图渲染：把 docs/design 下的 HTML 设计图渲成 PNG。
 *
 * 用法：node scripts/render-mockups.mjs [目录] [--only 01,02] [--width 390] [--scale 2]
 *   默认目录 docs/design，逐个处理其下的 *.html，PNG 写到同目录的 png/<同名>.png。
 *
 * 为什么要有这个脚本：项目约定「界面改动先出设计图」，设计图必须以 PNG 的形式进仓库
 * 才能被评审和引用；HTML 是源、PNG 是审阅件。实现见 [docs/design/README.md]。
 *
 * 做法：headless Chrome + CDP，零依赖（Node 内置 fetch 与 WebSocket，需要 Node ≥ 22）。
 * 宽度默认 390px（iPhone 14/15 逻辑宽度），按 scale=2 渲染成 780px 宽的图，
 * 与 _tokens.css 里的换算（1rpx = 0.52px）配套。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const rootDir = resolve(argv.find((a) => !a.startsWith('--') && !argv[argv.indexOf(a) - 1]?.startsWith('--')) ?? 'docs/design');
const only = flag('--only', '');
const width = Number(flag('--width', '390'));
const scale = Number(flag('--scale', '2'));

const chromePath = CHROME_CANDIDATES.find((p) => p && existsSync(p));
if (!chromePath) {
  console.error('找不到 Chrome/Edge 可执行文件，无法渲染设计图。');
  process.exit(1);
}

const workDir = join(tmpdir(), 'mockup-render');
mkdirSync(workDir, { recursive: true });
const profileDir = join(workDir, `profile-${Date.now()}`);
const port = 9333 + (process.pid % 500);

const chrome = spawn(chromePath, [
  '--headless=new',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--allow-file-access-from-files',
  `--user-data-dir=${profileDir}`,
  `--remote-debugging-port=${port}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function browserWsUrl() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const info = await res.json();
      if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口没起来');
}

function connect(wsUrl) {
  return new Promise((resolveConn, rejectConn) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`));
        else res(msg.result);
      }
    });
    ws.addEventListener('error', rejectConn);
    ws.addEventListener('open', () => {
      resolveConn((method, params = {}, sessionId) => new Promise((res, rej) => {
        const id = (seq += 1);
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }));
    });
  });
}

/** 渲染一张设计图：按宽度渲染、按内容高度截全页。 */
async function render(send, file, outFile) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', {
      width, height: 900, deviceScaleFactor: 1, mobile: true,
    }, sessionId);
    await send('Page.navigate', { url: `file:///${file.replace(/\\/g, '/')}` }, sessionId);
    let height = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(150);
      const { result } = await send('Runtime.evaluate', {
        // 量 body 的实际高度：html 的 scrollHeight 会被视口撑大（缺 viewport meta 时更离谱），
        // 截出来就是一大片空白。同时校验布局宽度，避免「按 980px 缩放」这类静默失真。
        expression: `(() => {
          if (document.readyState !== 'complete') return { ready: false };
          const rect = document.body.getBoundingClientRect();
          return { ready: true, layoutWidth: document.documentElement.clientWidth,
                   width: Math.round(rect.width), height: Math.ceil(rect.height + rect.top) };
        })()`,
        returnByValue: true,
      }, sessionId);
      const value = result.value;
      if (value && value.ready) {
        if (value.layoutWidth !== width || value.width !== width) {
          throw new Error(`布局宽度 ${value.layoutWidth}/内容宽度 ${value.width} 与设计宽度 ${width} 不一致`
            + '（多半是缺 <meta name="viewport" content="width=device-width, initial-scale=1">）');
        }
        height = value.height;
        if (attempt >= 2) break;
      }
    }
    if (!height) throw new Error('页面没渲染出高度');
    await sleep(350); // 字体与 backdrop-filter 落地
    const { data } = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale },
    }, sessionId);
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, Buffer.from(data, 'base64'));
    return height;
  } finally {
    await send('Target.closeTarget', { targetId });
  }
}

const targets = [];
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'png') continue;
      walk(full);
    } else if (entry.name.endsWith('.html')) {
      targets.push(full);
    }
  }
}
walk(rootDir);

const filtered = only
  ? targets.filter((f) => only.split(',').some((tag) => basename(f).startsWith(tag.trim())))
  : targets;
if (filtered.length === 0) {
  console.error(`没有找到要渲染的 HTML（目录 ${rootDir}${only ? `，筛选 ${only}` : ''}）`);
  chrome.kill();
  process.exit(1);
}

try {
  const send = await connect(await browserWsUrl());
  for (const file of filtered) {
    const out = join(dirname(file), 'png', `${basename(file, '.html')}.png`);
    const height = await render(send, file, out);
    console.log(`ok  ${basename(file)}  →  ${out.replace(resolve('.') + '\\', '')}  (${width}×${height} @${scale}x)`);
  }
} finally {
  chrome.kill();
}
