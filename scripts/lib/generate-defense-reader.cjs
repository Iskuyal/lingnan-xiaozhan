// The reader and server use the same frozen materials; the client still sends only materialId.
const fs = require('node:fs');
const path = require('node:path');
const { buildDefenseMaterials } = require('./generate-defense-materials.cjs');

function readerMaterials(root) {
  return buildDefenseMaterials(root).map(material => ({
    ...material,
    frozenAt: '2026-09-30',
    preface: material.text.split('\n## ')[0].replace(/^# .*\n/u, '').replace(/\*\*|`/gu, '').trim(),
    boundary: (material.text.split('## 边界\n')[1] || '').replace(/\*\*|`/gu, '').trim(),
    entries: material.text.split('\n').map(line => line.split('|').map(value => value.replace(/\*\*|`/gu, '').trim()))
      .filter(parts => /^(?:INV-[A-Z0-9]+|[FD]\d+)$/u.test(parts[1] || ''))
      .map(parts => ({ id: parts[1], body: parts[2], status: parts[3] })),
  }));
}

function generateDefenseReader(root) {
  const target = path.join(root, 'miniprogram/services/defense/reader-data.ts');
  const code = '// Generated from G0 frozen materials. Do not edit.\n' +
    'export interface MaterialEntry { id: string; body: string; status: string; }\n' +
    'export interface ReaderMaterial { id: string; name: string; kind: string; kindLabel: string; file: string; text: string; frozenAt: string; preface: string; boundary: string; entries: MaterialEntry[]; }\n' +
    `export const READER_MATERIALS: ReaderMaterial[] = ${JSON.stringify(readerMaterials(root), null, 2)};\n`;
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== code) fs.writeFileSync(target, code, 'utf8');
}

module.exports = { readerMaterials, generateDefenseReader };
