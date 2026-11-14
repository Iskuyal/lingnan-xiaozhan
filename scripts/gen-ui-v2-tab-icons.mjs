#!/usr/bin/env node
/**
 * 生成四 tab 的本地图标（81×81 PNG，普通态与选中态各一份）。
 *
 * 为什么是脚本而不是手塞 8 张二进制图：原生 tabBar 的 iconPath 只接受位图，
 * 而这一轮的设计图标是 24×24 的线性图形（见 docs/design/lingnan-red-2026-11-11）。
 * 把「路径 + 线宽 + 两种颜色」留在仓库里，既能在评审时改一笔重出，
 * 也不用为了四张图标引入一个图像库依赖。产出的 PNG 一并提交，
 * 构建与开发者工具不需要再跑这个脚本。
 *
 * 用法：node scripts/gen-ui-v2-tab-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SIZE = 81;
const SUPERSAMPLE = 4;
const VIEWBOX = 24;
const STROKE = 1.75;

const COLORS = { off: '#6b5d57', on: '#c41c23' };

/**
 * 24×24 视图里的路径，每组是一条折线：M/L 为直线，Q 为二次贝塞尔。
 * 数字与 docs/design/lingnan-red-2026-11-11 四个主入口的图标同一套轮廓。
 */
const ICONS = {
  'tab-today': [
    ['M', 4.2, 11.4, 'L', 12, 4.2, 'L', 19.8, 11.4],
    ['M', 6.4, 9.8, 'L', 6.4, 20, 'L', 17.6, 20, 'L', 17.6, 9.8],
    ['M', 10.2, 20, 'L', 10.2, 14.6, 'L', 13.8, 14.6, 'L', 13.8, 20],
  ],
  'tab-timetable': [
    ['M', 4.4, 8.6, 'L', 4.4, 19.6, 'L', 19.6, 19.6, 'L', 19.6, 8.6, 'L', 4.4, 8.6],
    ['M', 8.8, 4.4, 'L', 8.8, 7.6],
    ['M', 15.2, 4.4, 'L', 15.2, 7.6],
    ['M', 4.4, 12.4, 'L', 19.6, 12.4],
  ],
  'tab-study': [
    ['M', 12, 6.6, 'L', 7.4, 5, 'L', 3.6, 5.6, 'L', 3.6, 18.4, 'L', 7.4, 17.8, 'L', 12, 19.4],
    ['M', 12, 6.6, 'L', 16.6, 5, 'L', 20.4, 5.6, 'L', 20.4, 18.4, 'L', 16.6, 17.8, 'L', 12, 19.4],
    ['M', 12, 6.6, 'L', 12, 19.4],
  ],
  'tab-campus': [
    ['M', 3.4, 8.2, 'Q', 12, 3.6, 20.6, 8.2],
    ['M', 6.2, 7.6, 'L', 6.2, 19.8],
    ['M', 17.8, 7.6, 'L', 17.8, 19.8],
    ['M', 9, 19.8, 'L', 9, 13.8, 'Q', 12, 10.6, 15, 13.8, 'L', 15, 19.8],
  ],
};

/** 把 M/L/Q 指令摊成一串折线（贝塞尔取样 18 段，够 81px 用）。 */
function toPolylines(commands) {
  const lines = [];
  let current = [];
  let cursor = null;
  let index = 0;
  const take = () => {
    const value = commands[index];
    index += 1;
    return value;
  };
  while (index < commands.length) {
    const command = take();
    if (command === 'M') {
      if (current.length > 0) lines.push(current);
      cursor = [take(), take()];
      current = [cursor];
    } else if (command === 'L') {
      cursor = [take(), take()];
      current.push(cursor);
    } else if (command === 'Q') {
      const control = [take(), take()];
      const end = [take(), take()];
      const steps = 18;
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        const u = 1 - t;
        current.push([
          u * u * cursor[0] + 2 * u * t * control[0] + t * t * end[0],
          u * u * cursor[1] + 2 * u * t * control[1] + t * t * end[1],
        ]);
      }
      cursor = end;
    } else {
      throw new Error('未知的路径指令：' + String(command));
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function inked(lines, sampleX, sampleY) {
  for (const line of lines) {
    if (line.length === 1) {
      if (Math.hypot(sampleX - line[0][0], sampleY - line[0][1]) <= STROKE / 2) return true;
      continue;
    }
    for (let i = 1; i < line.length; i += 1) {
      if (distanceToSegment(sampleX, sampleY, line[i - 1], line[i]) <= STROKE / 2) return true;
    }
  }
  return false;
}

function render(commands, color) {
  const lines = commands.flatMap((path) => toPolylines(path));
  const rgb = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
  const scale = SIZE / VIEWBOX;
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          if (inked(lines, (x + (sx + 0.5) / SUPERSAMPLE) / scale, (y + (sy + 0.5) / SUPERSAMPLE) / scale)) hits += 1;
        }
      }
      const index = (y * SIZE + x) * 4;
      pixels[index] = rgb[0];
      pixels[index + 1] = rgb[1];
      pixels[index + 2] = rgb[2];
      pixels[index + 3] = Math.round((hits / samples) * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (SIZE * 4 + 1)] = 0;
    pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const output = resolve(process.cwd(), 'miniprogram/assets/ui-v2');
mkdirSync(output, { recursive: true });
for (const [name, commands] of Object.entries(ICONS)) {
  for (const state of ['off', 'on']) {
    const file = resolve(output, name + (state === 'on' ? '-on' : '') + '.png');
    writeFileSync(file, encodePng(render(commands, COLORS[state])));
    console.log('wrote', file);
  }
}
