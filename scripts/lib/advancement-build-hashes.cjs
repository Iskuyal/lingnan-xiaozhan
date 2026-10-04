const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

/** 续跑与回放须绑定整份云端根文件及本次检索、请求生成器。 */
function advancementBuildHashes(root = process.cwd()) {
  const cloudDir = path.join(root, 'dist/cloudfunctions/ai');
  const files = fs.readdirSync(cloudDir, { withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => [entry.name, path.join(cloudDir, entry.name)]);
  for (const name of ['index.js', 'model.js']) files.push([`client/${name}`, path.join(root, 'dist/services/advancement', name)]);
  return Object.fromEntries(files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, file]) => [name, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
}

module.exports = { advancementBuildHashes };
