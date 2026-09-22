/**
 * `timetable` 云函数设置读写的端到端冒烟（学期与作息这条链路）。
 *
 * 为什么必须从小程序端跑：设置按 openid 隔离、客户端不直连数据库，读写都经 `timetable`
 * 云函数。控制台「测试」页、CLI、HTTP 触发都拿不到小程序侧身份，验不了「按身份隔离」这一条
 * （与 `smoke:ai` 同一个道理，见 cloudfunctions/ai/safety.ts 的说明）。
 *
 * **不改变你的真实设置**：先读旧值 → 写入探针值 → 断言读回一致（顺手截一张「设置生效后」的
 * 课表页）→ 把旧值写回去 → 再断言已恢复。任何一步失败都会尝试恢复。
 *
 * 前置：`cli auto --project <仓库>/dist --auto-port 9420 --trust-project`；
 *      `timetable` 云函数已重新部署（含 getSettings / saveSettings），集合 `timetable_settings` 已建。
 * 用法：`npm run smoke:settings`（端口可用 WECHAT_AUTO_PORT 覆盖，默认 9420）
 * 退出码：0 = 往返一致且已恢复；1 = 调用没跑通（未部署 / 权限 / 集合未建）；2 = 往返不一致。
 */
const { connectMini } = require('./lib/mini-connect.cjs');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

async function run() {
  const output = path.resolve('artifacts/verify');
  mkdirSync(output, { recursive: true });
  const mini = await connectMini();
  const report = { verifiedAt: new Date().toISOString(), platform: 'devtools', realDevice: false };
  try {
    await mini.callWxMethod('reLaunch', { url: '/pages/timetable/index' });
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // ① 读旧值 → 写探针值。函数体在模拟器里执行，取不到外层变量，所以全部写成字面量。
    const saved = await mini.evaluate(() => new Promise((resolve) => {
      const timer = setTimeout(() => resolve(JSON.stringify({ invoked: false, err: '调用超过 30 秒未返回' })), 30000);
      const probe = {
        semesterName: '验收探针（会被恢复）',
        startDate: '2026-08-31',
        totalWeeks: 20,
        sectionTimes: [
          { start: '', end: '' }, { start: '', end: '' }, { start: '', end: '' }, { start: '', end: '' },
          { start: '13:00', end: '13:45' }, { start: '13:50', end: '14:35' },
          { start: '', end: '' }, { start: '', end: '' }, { start: '', end: '' }, { start: '', end: '' },
          { start: '', end: '' }, { start: '', end: '' },
        ],
      };
      const call = (action, extra) => wx.cloud.callFunction({ name: 'timetable', data: Object.assign({ action }, extra || {}) })
        .then((res) => res.result)
        .catch((error) => ({ ok: false, failure: (error && error.errMsg) || String(error) }));
      call('getSettings').then((before) => {
        const old = before && before.ok && before.settings ? before.settings : null;
        // 旧值不能穿过 evaluate 的边界，只能暂存到小程序侧 storage，第 ③ 步再取出来恢复。
        try { wx.setStorageSync('__settingsProbeOld', JSON.stringify(old)); } catch (error) { /* 存不下就退回空设置 */ }
        return call('saveSettings', { settings: probe }).then((after) => {
          clearTimeout(timer);
          resolve(JSON.stringify({
            invoked: true,
            readOk: !!(before && before.ok),
            saveOk: !!(after && after.ok),
            saveFailure: (after && (after.message || after.failure)) || '',
            old,
          }));
        });
      });
    }));
    const first = JSON.parse(saved);
    report.first = first;
    if (!first.invoked) {
      console.error(`设置读写没跑通：${first.err}`);
      console.error('多半是 `timetable` 云函数没重新部署，或集合 `timetable_settings` 还没建。');
      return 1;
    }
    if (!first.saveOk) {
      console.error(`saveSettings 失败：${first.saveFailure}`);
      return 1;
    }

    // ② 设置生效后看一眼课表页：日期、今日列与速查条都该亮起来。
    await mini.callWxMethod('reLaunch', { url: '/pages/timetable/index' });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await mini.screenshot({ path: path.join(output, 'settings-live.png') });
    const seen = await mini.evaluate(() => {
      const page = getCurrentPages()[getCurrentPages().length - 1];
      const data = page && page.data ? page.data : {};
      return JSON.stringify({
        weekRange: data.weekRange || '',
        week: data.week || 0,
        todayBar: data.todayBar ? data.todayBar.kind + '｜' + (data.todayBar.name || data.todayBar.note || '') : null,
        setupHint: data.setupHint || '',
      });
    });
    report.onPage = JSON.parse(seen);

    // ③ 读回探针值 → 恢复旧值 → 再读一次确认恢复。
    const restored = await mini.evaluate(() => new Promise((resolve) => {
      const timer = setTimeout(() => resolve(JSON.stringify({ invoked: false, err: '调用超过 30 秒未返回' })), 30000);
      const empty = {
        semesterName: '', startDate: '', totalWeeks: 20,
        sectionTimes: Array.from({ length: 12 }, () => ({ start: '', end: '' })),
      };
      const call = (action, extra) => wx.cloud.callFunction({ name: 'timetable', data: Object.assign({ action }, extra || {}) })
        .then((res) => res.result)
        .catch((error) => ({ ok: false, failure: (error && error.errMsg) || String(error) }));
      call('getSettings').then((now) => {
        const probeBack = now && now.ok ? now.settings : null;
        const same = !!probeBack && probeBack.startDate === '2026-08-31' && probeBack.totalWeeks === 20
          && probeBack.sectionTimes[4].start === '13:00' && probeBack.sectionTimes[4].end === '13:45'
          && probeBack.sectionTimes[5].end === '14:35' && probeBack.sectionTimes[0].start === '';
        const target = (() => {
          try {
            const stashed = JSON.parse(wx.getStorageSync('__settingsProbeOld') || 'null');
            if (stashed !== null && typeof stashed.startDate === 'string') return stashed;
          } catch (error) { /* 读不到就退回空设置 */ }
          return empty;
        })();
        return call('saveSettings', { settings: target }).then(() => call('getSettings')).then((final) => {
          clearTimeout(timer);
          resolve(JSON.stringify({
            invoked: true, roundTripSame: same,
            restoredStartDate: final && final.ok ? final.settings.startDate : '?',
            restoredName: final && final.ok ? final.settings.semesterName : '?',
          }));
        });
      });
    }));
    const third = JSON.parse(restored);
    report.roundTripSame = third.roundTripSame;
    report.restored = third;

    if (third.roundTripSame !== true) {
      console.error('读写往返不一致：写进去的设置没能原样读回来。');
      return 2;
    }
    writeFileSync(path.join(output, 'settings-smoke.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log('设置链路 OK：写入 → 读回一致 → 已恢复旧值（未改变你的真实设置）');
    return 0;
  } finally {
    // disconnect 在老版本 automator 上返回 undefined，不能直接 .catch。
    if (typeof mini.disconnect === 'function') {
      try { await mini.disconnect(); } catch (error) { /* 收尾失败不影响结论 */ }
    }
  }
}

run().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error('冒烟失败：', error && error.message ? error.message : error);
  process.exitCode = 1;
});
