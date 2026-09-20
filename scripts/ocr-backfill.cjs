#!/usr/bin/env node
/**
 * 腾讯云 OCR 回填：把「正文是图片」的通知识别成文字（Ticket 11，负责人选定路径 C + 腾讯云 OCR）。
 *
 * 两个模式：
 *   node scripts/ocr-backfill.cjs plan     只看清单与调用量，**不调接口、不需要密钥**
 *   node scripts/ocr-backfill.cjs run      真的调 OCR（需要密钥；支持断点续跑与限量试跑）
 *
 * 输入：artifacts/rag-poc/image-notices.json（由 `node scripts/rag-poc.cjs images` 生成）
 * 输出：artifacts/rag-poc/ocr-results.json（逐图原文、失败原因、耗时；供人工抽检）
 *
 * 环境变量（**只在环境里，不要写进仓库或小程序包**）：
 *   TENCENT_SECRET_ID / TENCENT_SECRET_KEY     腾讯云访问密钥
 *   TENCENT_OCR_REGION                        可选，默认 ap-guangzhou
 *   OCR_MIN_INTERVAL_MS                       可选，两次调用之间的间隔，默认 200
 *
 * 用法示例：
 *   node scripts/ocr-backfill.cjs run --limit 3        # 先试 3 篇，验证质量与计费
 *   node scripts/ocr-backfill.cjs run                  # 跑完剩余的全部（自动跳过已完成的）
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { orderDetections } = require('./lib/ocr-order.cjs');

const ROOT = path.resolve(__dirname, '..');
const IN_FILE = path.join(ROOT, 'artifacts', 'rag-poc', 'image-notices.json');
const OUT_FILE = path.join(ROOT, 'artifacts', 'rag-poc', 'ocr-results.json');

/** 腾讯云 OCR 通用印刷体识别。控制台按「次」计费，通常有每月免费额度——**以控制台账单为准**。 */
const ACTION = 'GeneralBasicOCR';
const VERSION = '2018-11-19';
const HOST = 'ocr.tencentcloudapi.com';
/** 保守的单价估算，仅用于 plan 模式提示量级；真实单价请在腾讯云控制台核实。 */
const PRICE_PER_CALL_YUAN = 0.015;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const hmac = (key, text) => crypto.createHmac('sha256', key).update(text, 'utf8').digest();

/**
 * 腾讯云 API 3.0 签名（TC3-HMAC-SHA256）。
 * 参考 https://cloud.tencent.com/document/api/866/33519 ——步骤：规范请求 → 待签串 → 派生密钥 → 签名。
 */
function sign({ secretId, secretKey, payload, region, timestamp }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${HOST}\n`;
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, 'content-type;host', sha256hex(payload)].join('\n');
  const scope = `${date}/ocr/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), scope, sha256hex(canonicalRequest)].join('\n');
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, 'ocr');
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
    headers: {
      Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
      'Content-Type': 'application/json; charset=utf-8',
      Host: HOST,
      'X-TC-Action': ACTION,
      'X-TC-Version': VERSION,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Region': region,
    },
  };
}

/** 单张图片 → 文本。失败时把错误原样带回来，不吞掉。 */
async function ocrImage(imageUrl, config) {
  const payload = JSON.stringify({ ImageUrl: imageUrl });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const timestamp = Math.floor(Date.now() / 1000);
    const { headers } = sign({ ...config, payload, timestamp });
    const startedAt = Date.now();
    try {
      const res = await fetch(`https://${HOST}/`, { method: 'POST', headers, body: payload });
      const body = await res.json();
      const response = body?.Response ?? {};
      if (response.Error !== undefined) {
        // 限频与临时故障可重试；其余（图片过大、URL 不可达、鉴权失败）直接返回，避免白花钱。
        const code = response.Error.Code ?? '';
        if (attempt < 3 && /RequestLimitExceeded|InternalError|FailedOperation\.Timeout/i.test(code)) {
          await sleep(1000 * attempt);
          continue;
        }
        return { ok: false, error: `${code}: ${response.Error.Message ?? ''}`, elapsedMs: Date.now() - startedAt };
      }
      const lines = (response.TextDetections ?? []).map((item) => item.DetectedText).filter((text) => typeof text === 'string');
      // 连坐标一起存：海报排版顺序不对时可以离线重排，不必再花钱调一次接口。
      const detections = (response.TextDetections ?? []).map((item) => ({
        DetectedText: item.DetectedText,
        ItemPolygon: item.ItemPolygon,
        Polygon: item.Polygon,
      }));
      return {
        ok: true,
        text: lines.join('\n'),
        lineCount: lines.length,
        detections,
        requestId: response.RequestId ?? '',
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (attempt < 3) {
        await sleep(1000 * attempt);
        continue;
      }
      return { ok: false, error: `调用异常：${error.message}`, elapsedMs: Date.now() - startedAt };
    }
  }
  return { ok: false, error: '重试 3 次仍失败', elapsedMs: 0 };
}

function readInput() {
  if (!fs.existsSync(IN_FILE)) throw new Error(`缺少输入清单：先运行 node scripts/rag-poc.cjs images（${IN_FILE}）`);
  return JSON.parse(fs.readFileSync(IN_FILE, 'utf8'));
}

function readResults() {
  return fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : { runAt: '', notices: [] };
}

function plan() {
  const input = readInput();
  const calls = input.notices.reduce((sum, notice) => sum + notice.images.length, 0);
  const byColumn = new Map();
  for (const notice of input.notices) {
    byColumn.set(notice.column, (byColumn.get(notice.column) ?? 0) + notice.images.length);
  }
  console.log(`图片正文通知 ${input.notices.length} 篇，共 ${calls} 张图（清单抓取日期 ${input.capturedAt}）\n`);
  for (const [column, count] of byColumn) console.log(`  ${column}：${count} 张`);
  console.log(`\n预计调用 ${calls} 次 ${ACTION}。按 ¥${PRICE_PER_CALL_YUAN}/次 估约 ¥${(calls * PRICE_PER_CALL_YUAN).toFixed(2)}；`);
  console.log('**真实单价与每月免费额度请在腾讯云控制台核对**，本数字只是量级提示。');
  console.log('\n先小批量验证：node scripts/ocr-backfill.cjs run --limit 3');
  console.log('提醒：海报是多栏设计稿，OCR 的阅读顺序可能错乱，跑完必须人工抽检（逐字比对原图）。');
}

async function run() {
  const secretId = process.env.TENCENT_SECRET_ID ?? '';
  const secretKey = process.env.TENCENT_SECRET_KEY ?? '';
  const region = process.env.TENCENT_OCR_REGION ?? 'ap-guangzhou';
  const intervalMs = Number(process.env.OCR_MIN_INTERVAL_MS ?? 200);
  if (secretId === '' || secretKey === '') {
    throw new Error('需要环境变量 TENCENT_SECRET_ID 与 TENCENT_SECRET_KEY（**不要写进仓库**）');
  }
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Number.POSITIVE_INFINITY;

  const input = readInput();
  const results = readResults();
  const done = new Set(results.notices.map((notice) => notice.url));
  const pending = input.notices.filter((notice) => !done.has(notice.url)).slice(0, limit);

  let calls = 0;
  let failures = 0;
  for (const notice of pending) {
    const images = [];
    const orderedParts = [];
    let columns = 1;
    for (const imageUrl of notice.images) {
      const outcome = await ocrImage(imageUrl, { secretId, secretKey, region });
      calls += 1;
      if (!outcome.ok) failures += 1;
      if (outcome.ok) {
        // 逐图重排：每张图是海报的一页，跨图拼接按图片原有顺序。
        const order = orderDetections(outcome.detections);
        outcome.orderedText = order.lines.join('\n');
        outcome.order = { ordered: order.ordered, columns: order.columns, reason: order.reason };
        columns = Math.max(columns, order.columns);
        orderedParts.push(outcome.orderedText);
      }
      images.push({ url: imageUrl, ...outcome });
      console.log(`  ${outcome.ok ? (outcome.order.ordered ? `✓ ${outcome.lineCount} 行（重排为 ${outcome.order.columns} 栏）` : `✓ ${outcome.lineCount} 行（${outcome.order.reason}）`) : `✗ ${outcome.error}`}  ${imageUrl.slice(-40)}`);
      await sleep(intervalMs);
    }
    results.notices.push({
      url: notice.url,
      title: notice.title,
      date: notice.date,
      column: notice.column,
      images,
      // text = 接口返回顺序（原样留存，供抽检比对）；orderedText = 按坐标重排后的文本（入库用这个）。
      text: images.filter((image) => image.ok).map((image) => image.text).join('\n'),
      orderedText: orderedParts.join('\n'),
      columns,
    });
    // 边跑边落盘：中断后重跑自动跳过已完成的通知
    results.runAt = new Date().toISOString();
    fs.writeFileSync(OUT_FILE, `${JSON.stringify(results, null, 1)}\n`, 'utf8');
    console.log(`\n【${notice.title.slice(0, 32)}】${notice.images.length} 张图 → ${notice.url}\n`);
  }

  const okNotices = results.notices.filter((notice) => (notice.orderedText ?? notice.text).trim() !== '').length;
  const multiColumn = results.notices.filter((notice) => (notice.columns ?? 1) > 1).length;
  console.log(`\n本次调用 ${calls} 次，失败 ${failures} 张；累计完成 ${results.notices.length} 篇（其中 ${okNotices} 篇有文字，${multiColumn} 篇识别为多栏并被重排）`);
  console.log(`结果 → ${OUT_FILE}`);
  console.log('\n下一步（脚本不替你做判定）：');
  console.log('  1. 人工抽检：至少 5 篇逐字比对原图。结果里 `text` 是接口原顺序、`orderedText` 是重排后，');
  console.log('     两者都在，方便判断重排是否真的帮上忙；');
  console.log('  2. 重排规则见 scripts/lib/ocr-order.cjs 与 tests/ocr-order.test.cjs（通栏元素归第 0 栏、');
  console.log('     竖向空白够宽才切栏）。**原始坐标已一并存下**，规则要改可离线重算，不必再调接口；');
  console.log('  3. 抽检达标后，再决定入库方式与「OCR 提取」来源标记（见 Ticket 11 的验收标准）。');;
}

const mode = process.argv[2] ?? '';
if (mode === 'plan') plan();
else if (mode === 'run') run().catch((error) => { console.error(`失败：${error.message}`); process.exitCode = 1; });
else {
  console.error('用法：node scripts/ocr-backfill.cjs <plan|run> [--limit N]');
  process.exitCode = 1;
}
