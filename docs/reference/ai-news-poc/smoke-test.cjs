/**
 * 冒烟测试：只发一次请求，确认 Key、baseUrl、模型名都对。
 * 避免直接跑全套 40 次调用才发现参数写错。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const key = fs
  .readFileSync(path.join(ROOT, 'key.txt'), 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .join('');

if (!key) {
  console.error('key.txt 里没有 Key');
  process.exit(1);
}

const url = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
console.log('POST ' + url);
console.log('model: ' + cfg.model);
console.log('key:   ' + key.slice(0, 3) + '*'.repeat(6) + key.slice(-4) + '  (len ' + key.length + ')');

(async () => {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: '只回复两个字：通了' }],
      max_tokens: 20,
    }),
  });
  const ms = Date.now() - t0;
  const raw = await res.text();
  console.log('\nHTTP ' + res.status + '  ' + ms + 'ms');
  if (!res.ok) {
    console.log('原始返回: ' + raw.slice(0, 500));
    process.exit(1);
  }
  const j = JSON.parse(raw);
  console.log('模型回复: ' + JSON.stringify(j.choices?.[0]?.message?.content));
  console.log('用量: ' + JSON.stringify(j.usage));
  console.log('\n✅ 通了，可以跑全套');
})().catch((e) => {
  console.error('\n❌ 失败: ' + e.message);
  console.error('排查方向: 1) 网络能否直连 api.deepseek.com  2) Key 是否有效  3) 账户余额');
  process.exit(1);
});
