const { test } = require('node:test');
const assert = require('node:assert/strict');

// 体测估算（Issue #92）：分数只来自《国家学生体质健康标准（2014年修订）》大学组评分表。
// 这里钉住的每一条都能回到原表：先写边界（正好 100 分档 / 60 分档 / 表外下限），再写缺项与非法值。
// 表本身在 dist/services/fitness/standard.js，来源与抽取过程见 docs/product/sources/fitness-standard.md。
const fitness = require('../dist/services/fitness/index.js');

/** 找某一项的得分，找不到则抛错（缺失本身也要被测出来）。 */
function scoreOf(result, key) {
  const item = result.items.find((entry) => entry.key === key);
  assert.ok(item, `结果里没有 ${key}`);
  return item;
}

test('单项得分取「达到的最高档」：高优项与低优项的边界都按原表', () => {
  // 肺活量（男，大一大二）：100 分 = 5040 毫升，95 分 = 4920，60 分 = 3100，50 分 = 2940
  for (const [value, expected] of [[5040, 100], [5039, 95], [4920, 95], [3100, 60], [3099, 50], [2940, 50]]) {
    const result = fitness.estimate({ sex: 'male', band: 'freshman', vitalCapacity: value });
    assert.equal(scoreOf(result, 'vitalCapacity').score, expected, `肺活量 ${value} 应得 ${expected} 分`);
  }
  // 50 米跑（男，大一大二）：越小越好，100 分 = 6.7 秒，85 分 = 7.0，60 分 = 9.1，50 分 = 9.3
  for (const [value, expected] of [[6.7, 100], [6.71, 95], [7.0, 85], [9.1, 60], [9.11, 50], [10.0, 10]]) {
    const result = fitness.estimate({ sex: 'male', band: 'freshman', sprint50: value });
    assert.equal(scoreOf(result, 'sprint50').score, expected, `50 米 ${value} 秒应得 ${expected} 分`);
  }
  // 坐位体前屈（男，大一大二）：100 分 = 24.9 厘米；负值档也在表里（20 分 = -0.3，10 分 = -1.3）
  for (const [value, expected] of [[24.9, 100], [24.8, 95], [3.7, 60], [-0.3, 20], [-1.3, 10]]) {
    const result = fitness.estimate({ sex: 'male', band: 'freshman', sitAndReach: value });
    assert.equal(scoreOf(result, 'sitAndReach').score, expected, `坐位体前屈 ${value} 应得 ${expected} 分`);
  }
});

test('年级组分开：同一成绩在大三大四的档位不同', () => {
  // 肺活量男：100 分 = 大一大二 5040 / 大三大四 5140
  assert.equal(scoreOf(fitness.estimate({ sex: 'male', band: 'freshman', vitalCapacity: 5040 }), 'vitalCapacity').score, 100);
  assert.equal(scoreOf(fitness.estimate({ sex: 'male', band: 'senior', vitalCapacity: 5040 }), 'vitalCapacity').score, 95);
  assert.equal(scoreOf(fitness.estimate({ sex: 'male', band: 'senior', vitalCapacity: 5140 }), 'vitalCapacity').score, 100);
  // 800 米女：100 分 = 大一大二 3′18″(198 秒) / 大三大四 3′16″(196 秒)
  assert.equal(scoreOf(fitness.estimate({ sex: 'female', band: 'freshman', distanceRunSeconds: 198 }), 'distanceRun').score, 100);
  assert.equal(scoreOf(fitness.estimate({ sex: 'female', band: 'senior', distanceRunSeconds: 198 }), 'distanceRun').score, 95);
});

test('低于表中最低档按 0 分计，并在该项说明里写清楚', () => {
  const result = fitness.estimate({ sex: 'male', band: 'freshman', sitAndReach: -5 });
  const item = scoreOf(result, 'sitAndReach');
  assert.equal(item.score, 0);
  assert.match(item.note, /低于表中最低档/);
  // 说明里要写明这是估算器口径，别让学生以为原表有这么一档。
  assert.ok(result.notes.some((note) => note.includes('按 0 分计')));
});

test('BMI：按原表合并单元格，低体重与超重均计 80 分', () => {
  const normal = fitness.estimate({ sex: 'male', band: 'freshman', height: 175, weight: 61.3 });
  assert.equal(scoreOf(normal, 'bmi').score, 100);
  assert.match(scoreOf(normal, 'bmi').valueText, /^20(\.\d)?（175 厘米 \/ 61\.3 千克）$/);

  const low = fitness.estimate({ sex: 'male', band: 'freshman', height: 175, weight: 54 }); // 17.6
  assert.equal(scoreOf(low, 'bmi').score, 80);
  const obese = fitness.estimate({ sex: 'male', band: 'freshman', height: 175, weight: 86 }); // 28.1
  assert.equal(scoreOf(obese, 'bmi').score, 60);
  const fat = fitness.estimate({ sex: 'male', band: 'freshman', height: 175, weight: 80 }); // 26.1 → 超重
  assert.equal(scoreOf(fat, 'bmi').score, 80);
  assert.match(scoreOf(fat, 'bmi').note, /超重/);
  assert.equal(fat.missing.some((name) => name.includes('BMI')), false);
  assert.equal(scoreOf(fitness.estimate({ sex: 'female', band: 'senior', height: 175, weight: 80 }), 'bmi').score, 80);

  // 女生的正常下限不同：17.2 起（男生是 17.9）
  assert.equal(scoreOf(fitness.estimate({ sex: 'female', band: 'freshman', height: 160, weight: 44 }), 'bmi').score, 100); // 17.2
  assert.equal(scoreOf(fitness.estimate({ sex: 'female', band: 'freshman', height: 160, weight: 43.5 }), 'bmi').score, 80); // 17.0
});

test('BMI 超重且七项完整时可给总分，175cm/80kg 的已核对样例为 81 分', () => {
  const result = fitness.estimate({ sex: 'male', band: 'freshman', height: 175, weight: 80,
    vitalCapacity: 4300, sprint50: 7, sitAndReach: 17.7, standingLongJump: 248, strength: 15, distanceRunSeconds: 222 });
  assert.equal(result.total, 81);
  assert.equal(result.grade, '良好');
  assert.deepEqual(result.missing, []);
});

test('附加分：引体向上/仰卧起坐按超过的次数，长跑按快的秒数，各自上限 10 分', () => {
  // 引体向上（男，大一大二）：100 分 = 19 次；20 次加 1 分，29 次加 10 分，再多次数也只加 10 分
  const one = fitness.estimate({ sex: 'male', band: 'freshman', strength: 20 });
  assert.equal(scoreOf(one, 'pullUp').score, 100);
  assert.equal(one.bonus, 1);
  assert.equal(fitness.estimate({ sex: 'male', band: 'freshman', strength: 29 }).bonus, 10);
  assert.equal(fitness.estimate({ sex: 'male', band: 'freshman', strength: 40 }).bonus, 10);
  assert.equal(fitness.estimate({ sex: 'male', band: 'freshman', strength: 19 }).bonus, 0, '正好 100 分标准不加分');

  // 仰卧起坐（女，大一大二）：100 分 = 56 次；58 次（超 2 次）加 1 分，69 次（超 13 次）加 10 分
  assert.equal(fitness.estimate({ sex: 'female', band: 'freshman', strength: 58 }).bonus, 1);
  assert.equal(fitness.estimate({ sex: 'female', band: 'freshman', strength: 69 }).bonus, 10);

  // 1000 米（男，大一大二）：100 分 = 3′17″（197 秒）；快 4 秒加 1 分，快 35 秒加 10 分，快 2 秒不加
  assert.equal(fitness.estimate({ sex: 'male', band: 'freshman', distanceRunSeconds: 195 }).bonus, 0);
  assert.equal(fitness.estimate({ sex: 'male', band: 'freshman', distanceRunSeconds: 193 }).bonus, 1);
  assert.equal(fitness.estimate({ sex: 'male', band: 'freshman', distanceRunSeconds: 162 }).bonus, 10);
  // 800 米（女，大一大二）：100 分 = 198 秒；快 50 秒加 10 分
  assert.equal(fitness.estimate({ sex: 'female', band: 'freshman', distanceRunSeconds: 148 }).bonus, 10);

  // 两项都加分时合计上限 20：引体向上 29 次（+10）与 1000 米 162 秒（+10）
  const both = fitness.estimate({ sex: 'male', band: 'freshman', strength: 29, distanceRunSeconds: 162 });
  assert.equal(both.bonus, 20);
  assert.equal(both.bonusDetail.length, 2);
  assert.match(both.bonusDetail[0], /引体向上超过 100 分标准 10 次，加 10 分/);
  assert.match(both.bonusDetail[1], /长跑比 100 分标准快 35 秒，加 10 分/);
});

test('缺项与非法值：该项不计分、写明原因，其余项照常算', () => {
  const result = fitness.estimate({ sex: 'male', band: 'freshman', vitalCapacity: 4300, height: 17 });
  assert.equal(scoreOf(result, 'vitalCapacity').score, 80);
  assert.equal(scoreOf(result, 'bmi').score, null);
  assert.match(scoreOf(result, 'bmi').note, /超出可核对范围/);
  assert.equal(scoreOf(result, 'sprint50').score, null);
  assert.match(scoreOf(result, 'sprint50').note, /没填/);
  assert.equal(result.total, null);
  assert.equal(result.grade, null);
  // 已计分项权重只有 15%（肺活量），标准分按已填项折算，说明里要写清这不是学年总分
  assert.equal(result.standardScore, 12);
  assert.ok(result.notes.some((note) => note.includes('不是学年总分')));
  assert.ok(result.missing.includes('50 米跑'));
});

test('七项齐全时给总分与等级；等级只按标准原文的分段', () => {
  // 全项 100 分档：标准分 100，等级优秀
  const perfect = fitness.estimate({
    sex: 'male', band: 'freshman',
    height: 175, weight: 61.3,
    vitalCapacity: 5040, sprint50: 6.7, sitAndReach: 24.9, standingLongJump: 273, strength: 19,
    distanceRunSeconds: 197,
  });
  assert.equal(perfect.standardScore, 100);
  assert.equal(perfect.total, 100);
  assert.equal(perfect.grade, '优秀');
  assert.equal(perfect.missing.length, 0);
  assert.equal(perfect.bonus, 0);

  // 全项 60 分档：标准分 60，加 10 分附加分 → 70 分，等级及格
  const passing = fitness.estimate({
    sex: 'male', band: 'freshman',
    height: 175, weight: 86, // BMI 28.1 → 60 分
    vitalCapacity: 3100, sprint50: 9.1, sitAndReach: 3.7, standingLongJump: 208, strength: 10,
    distanceRunSeconds: 272, // 4′32″ = 60 分；比 197 秒慢，不加分
  });
  assert.equal(passing.standardScore, 60);
  assert.equal(passing.total, 60);
  assert.equal(passing.grade, '及格');

  // 加权不是简单平均：把长跑（20%）拉到 100 分档，标准分应变成 68
  const betterRun = fitness.estimate({
    sex: 'male', band: 'freshman',
    height: 175, weight: 86,
    vitalCapacity: 3100, sprint50: 9.1, sitAndReach: 3.7, standingLongJump: 208, strength: 10,
    distanceRunSeconds: 197,
  });
  assert.equal(betterRun.standardScore, 68, '60 + (100-60)*0.2 = 68');
  assert.equal(betterRun.total, 68);
  assert.equal(betterRun.grade, '及格');
});

test('结果里不出现「合格/不合格」这类结论，只给等级与估算说明', () => {
  const result = fitness.estimate({
    sex: 'female', band: 'senior',
    height: 160, weight: 50,
    vitalCapacity: 3450, sprint50: 7.4, sitAndReach: 26.3, standingLongJump: 208, strength: 57,
    distanceRunSeconds: 196,
  });
  assert.equal(result.grade, '优秀');
  const text = JSON.stringify(result);
  assert.ok(!text.includes('合格'), '不得出现是否合格的结论');
  assert.ok(text.includes('估算分'), '要写明这是估算分');
  assert.ok(text.includes('学校实际采用的测试与计分规则尚未核实'));
});

test('同一份输入算两次结果一致（纯函数，不依赖时间与随机）', () => {
  const input = { sex: 'female', band: 'freshman', height: 160, weight: 50, vitalCapacity: 3000, sprint50: 8.4, sitAndReach: 19.5, standingLongJump: 182, strength: 47, distanceRunSeconds: 222 };
  assert.deepEqual(JSON.parse(JSON.stringify(fitness.estimate(input))), JSON.parse(JSON.stringify(fitness.estimate(input))));
});
