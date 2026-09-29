/**
 * 《国家学生体质健康标准（2014年修订）》大学组评分表（数据，不含逻辑）。
 *
 * 数据来源与抽取过程的证据见 `docs/product/sources/fitness-standard.md` 与
 * `docs/reference/fitness-standard-2014-tables.json`：
 * - 主来源：教育部通知附件（教体艺〔2014〕5号，Word 文件，本地抽取正文）；
 * - 校核来源：北京市教委转发件（京教体艺〔2014〕17号）的公开转载页；
 * - 两处重叠的单元格逐条比对，无差异；坐位体前屈的中间档由等差数列规律复核。
 *
 * 本文件只放"表"，判定与计分在 `./index.ts`。改数据必须同时改这两处的来源说明。
 */

export type Sex = 'male' | 'female';

/** 年级组：大学一、二年级为一组，三、四年级为一组（标准原文第 4 条）。 */
export type GradeBand = 'freshman' | 'senior';

export interface ScoreBreakpoint {
  /** 该档的单项得分。 */
  score: number;
  /** 大学一、二年级要达到的成绩（高优项：≥ 此值；低优项：≤ 此值）。 */
  freshman: number;
  /** 大学三、四年级要达到的成绩。 */
  senior: number;
}

export interface ItemTable {
  /** 单项名称，如「肺活量」。 */
  label: string;
  /** 成绩单位：毫升 / 秒 / 厘米 / 次。 */
  unit: string;
  /** true 表示数值越小越好（50 米跑、长跑）；false 表示越大越好。 */
  lowerIsBetter: boolean;
  /** 按得分从高到低排列的档位。 */
  rows: ScoreBreakpoint[];
}

/** 大学组单项权重（%）：标准原文「二、单项指标与权重」。 */
export const WEIGHTS = {
  bmi: 15,
  vitalCapacity: 15,
  sprint50: 20,
  sitAndReach: 10,
  standingLongJump: 10,
  strength: 10,
  distanceRun: 20,
} as const;

/** 等级评定（标准原文第 7 条）。 */
export const GRADE_BANDS = [
  { min: 90, label: '优秀' },
  { min: 80, label: '良好' },
  { min: 60, label: '及格' },
  { min: 0, label: '不及格' },
] as const;

/** 附加分上限（标准原文第 6 条：各指标加分幅度均为 10 分，附加分满分 20 分）。 */
export const MAX_BONUS_PER_ITEM = 10;
export const MAX_BONUS = 20;

/** 附加分表：`excess` 为超过 100 分标准的次数，`seconds` 为比 100 分标准快的秒数。 */
export const BONUS = {
  malePullUp: [
    { score: 10, excess: 10 },
    { score: 9, excess: 9 },
    { score: 8, excess: 8 },
    { score: 7, excess: 7 },
    { score: 6, excess: 6 },
    { score: 5, excess: 5 },
    { score: 4, excess: 4 },
    { score: 3, excess: 3 },
    { score: 2, excess: 2 },
    { score: 1, excess: 1 },
  ],
  femaleSitUp: [
    { score: 10, excess: 13 },
    { score: 9, excess: 12 },
    { score: 8, excess: 11 },
    { score: 7, excess: 10 },
    { score: 6, excess: 9 },
    { score: 5, excess: 8 },
    { score: 4, excess: 7 },
    { score: 3, excess: 6 },
    { score: 2, excess: 4 },
    { score: 1, excess: 2 },
  ],
  maleDistanceRun: [
    { score: 10, seconds: 35 },
    { score: 9, seconds: 32 },
    { score: 8, seconds: 29 },
    { score: 7, seconds: 26 },
    { score: 6, seconds: 23 },
    { score: 5, seconds: 20 },
    { score: 4, seconds: 16 },
    { score: 3, seconds: 12 },
    { score: 2, seconds: 8 },
    { score: 1, seconds: 4 },
  ],
  femaleDistanceRun: [
    { score: 10, seconds: 50 },
    { score: 9, seconds: 45 },
    { score: 8, seconds: 40 },
    { score: 7, seconds: 35 },
    { score: 6, seconds: 30 },
    { score: 5, seconds: 25 },
    { score: 4, seconds: 20 },
    { score: 3, seconds: 15 },
    { score: 2, seconds: 10 },
    { score: 1, seconds: 5 },
  ],
} as const;

/** 每个性别对应的六个计分项（不含 BMI）。 */
export function itemsFor(sex: Sex): Record<string, ItemTable> {
  return sex === 'male' ? MALE_ITEMS : FEMALE_ITEMS;
}

const MALE_ITEMS: Record<string, ItemTable> = {
  vitalCapacity: {"label":"肺活量","unit":"毫升","lowerIsBetter":false,"rows":[{"score":100,"freshman":5040,"senior":5140},{"score":95,"freshman":4920,"senior":5020},{"score":90,"freshman":4800,"senior":4900},{"score":85,"freshman":4550,"senior":4650},{"score":80,"freshman":4300,"senior":4400},{"score":78,"freshman":4180,"senior":4280},{"score":76,"freshman":4060,"senior":4160},{"score":74,"freshman":3940,"senior":4040},{"score":72,"freshman":3820,"senior":3920},{"score":70,"freshman":3700,"senior":3800},{"score":68,"freshman":3580,"senior":3680},{"score":66,"freshman":3460,"senior":3560},{"score":64,"freshman":3340,"senior":3440},{"score":62,"freshman":3220,"senior":3320},{"score":60,"freshman":3100,"senior":3200},{"score":50,"freshman":2940,"senior":3030},{"score":40,"freshman":2780,"senior":2860},{"score":30,"freshman":2620,"senior":2690},{"score":20,"freshman":2460,"senior":2520},{"score":10,"freshman":2300,"senior":2350}]},
  sprint50: {"label":"50 米跑","unit":"秒","lowerIsBetter":true,"rows":[{"score":100,"freshman":6.7,"senior":6.6},{"score":95,"freshman":6.8,"senior":6.7},{"score":90,"freshman":6.9,"senior":6.8},{"score":85,"freshman":7,"senior":6.9},{"score":80,"freshman":7.1,"senior":7},{"score":78,"freshman":7.3,"senior":7.2},{"score":76,"freshman":7.5,"senior":7.4},{"score":74,"freshman":7.7,"senior":7.6},{"score":72,"freshman":7.9,"senior":7.8},{"score":70,"freshman":8.1,"senior":8},{"score":68,"freshman":8.3,"senior":8.2},{"score":66,"freshman":8.5,"senior":8.4},{"score":64,"freshman":8.7,"senior":8.6},{"score":62,"freshman":8.9,"senior":8.8},{"score":60,"freshman":9.1,"senior":9},{"score":50,"freshman":9.3,"senior":9.2},{"score":40,"freshman":9.5,"senior":9.4},{"score":30,"freshman":9.7,"senior":9.6},{"score":20,"freshman":9.9,"senior":9.8},{"score":10,"freshman":10.1,"senior":10}]},
  sitAndReach: {"label":"坐位体前屈","unit":"厘米","lowerIsBetter":false,"rows":[{"score":100,"freshman":24.9,"senior":25.1},{"score":95,"freshman":23.1,"senior":23.3},{"score":90,"freshman":21.3,"senior":21.5},{"score":85,"freshman":19.5,"senior":19.9},{"score":80,"freshman":17.7,"senior":18.2},{"score":78,"freshman":16.3,"senior":16.8},{"score":76,"freshman":14.9,"senior":15.4},{"score":74,"freshman":13.5,"senior":14},{"score":72,"freshman":12.1,"senior":12.6},{"score":70,"freshman":10.7,"senior":11.2},{"score":68,"freshman":9.3,"senior":9.8},{"score":66,"freshman":7.9,"senior":8.4},{"score":64,"freshman":6.5,"senior":7},{"score":62,"freshman":5.1,"senior":5.6},{"score":60,"freshman":3.7,"senior":4.2},{"score":50,"freshman":2.7,"senior":3.2},{"score":40,"freshman":1.7,"senior":2.2},{"score":30,"freshman":0.7,"senior":1.2},{"score":20,"freshman":-0.3,"senior":0.2},{"score":10,"freshman":-1.3,"senior":-0.8}]},
  standingLongJump: {"label":"立定跳远","unit":"厘米","lowerIsBetter":false,"rows":[{"score":100,"freshman":273,"senior":275},{"score":95,"freshman":268,"senior":270},{"score":90,"freshman":263,"senior":265},{"score":85,"freshman":256,"senior":258},{"score":80,"freshman":248,"senior":250},{"score":78,"freshman":244,"senior":246},{"score":76,"freshman":240,"senior":242},{"score":74,"freshman":236,"senior":238},{"score":72,"freshman":232,"senior":234},{"score":70,"freshman":228,"senior":230},{"score":68,"freshman":224,"senior":226},{"score":66,"freshman":220,"senior":222},{"score":64,"freshman":216,"senior":218},{"score":62,"freshman":212,"senior":214},{"score":60,"freshman":208,"senior":210},{"score":50,"freshman":203,"senior":205},{"score":40,"freshman":198,"senior":200},{"score":30,"freshman":193,"senior":195},{"score":20,"freshman":188,"senior":190},{"score":10,"freshman":183,"senior":185}]},
  pullUp: {"label":"引体向上","unit":"次","lowerIsBetter":false,"rows":[{"score":100,"freshman":19,"senior":20},{"score":95,"freshman":18,"senior":19},{"score":90,"freshman":17,"senior":18},{"score":85,"freshman":16,"senior":17},{"score":80,"freshman":15,"senior":16},{"score":76,"freshman":14,"senior":15},{"score":72,"freshman":13,"senior":14},{"score":68,"freshman":12,"senior":13},{"score":64,"freshman":11,"senior":12},{"score":60,"freshman":10,"senior":11},{"score":50,"freshman":9,"senior":10},{"score":40,"freshman":8,"senior":9},{"score":30,"freshman":7,"senior":8},{"score":20,"freshman":6,"senior":7},{"score":10,"freshman":5,"senior":6}]},
  distanceRun: {"label":"1000 米跑","unit":"秒","lowerIsBetter":true,"rows":[{"score":100,"freshman":197,"senior":195},{"score":95,"freshman":202,"senior":200},{"score":90,"freshman":207,"senior":205},{"score":85,"freshman":214,"senior":212},{"score":80,"freshman":222,"senior":220},{"score":78,"freshman":227,"senior":225},{"score":76,"freshman":232,"senior":230},{"score":74,"freshman":237,"senior":235},{"score":72,"freshman":242,"senior":240},{"score":70,"freshman":247,"senior":245},{"score":68,"freshman":252,"senior":250},{"score":66,"freshman":257,"senior":255},{"score":64,"freshman":262,"senior":260},{"score":62,"freshman":267,"senior":265},{"score":60,"freshman":272,"senior":270},{"score":50,"freshman":292,"senior":290},{"score":40,"freshman":312,"senior":310},{"score":30,"freshman":332,"senior":330},{"score":20,"freshman":352,"senior":350},{"score":10,"freshman":372,"senior":370}]},
};
const FEMALE_ITEMS: Record<string, ItemTable> = {
  vitalCapacity: {"label":"肺活量","unit":"毫升","lowerIsBetter":false,"rows":[{"score":100,"freshman":3400,"senior":3450},{"score":95,"freshman":3350,"senior":3400},{"score":90,"freshman":3300,"senior":3350},{"score":85,"freshman":3150,"senior":3200},{"score":80,"freshman":3000,"senior":3050},{"score":78,"freshman":2900,"senior":2950},{"score":76,"freshman":2800,"senior":2850},{"score":74,"freshman":2700,"senior":2750},{"score":72,"freshman":2600,"senior":2650},{"score":70,"freshman":2500,"senior":2550},{"score":68,"freshman":2400,"senior":2450},{"score":66,"freshman":2300,"senior":2350},{"score":64,"freshman":2200,"senior":2250},{"score":62,"freshman":2100,"senior":2150},{"score":60,"freshman":2000,"senior":2050},{"score":50,"freshman":1960,"senior":2010},{"score":40,"freshman":1920,"senior":1970},{"score":30,"freshman":1880,"senior":1930},{"score":20,"freshman":1840,"senior":1890},{"score":10,"freshman":1800,"senior":1850}]},
  sprint50: {"label":"50 米跑","unit":"秒","lowerIsBetter":true,"rows":[{"score":100,"freshman":7.5,"senior":7.4},{"score":95,"freshman":7.6,"senior":7.5},{"score":90,"freshman":7.7,"senior":7.6},{"score":85,"freshman":8,"senior":7.9},{"score":80,"freshman":8.3,"senior":8.2},{"score":78,"freshman":8.5,"senior":8.4},{"score":76,"freshman":8.7,"senior":8.6},{"score":74,"freshman":8.9,"senior":8.8},{"score":72,"freshman":9.1,"senior":9},{"score":70,"freshman":9.3,"senior":9.2},{"score":68,"freshman":9.5,"senior":9.4},{"score":66,"freshman":9.7,"senior":9.6},{"score":64,"freshman":9.9,"senior":9.8},{"score":62,"freshman":10.1,"senior":10},{"score":60,"freshman":10.3,"senior":10.2},{"score":50,"freshman":10.5,"senior":10.4},{"score":40,"freshman":10.7,"senior":10.6},{"score":30,"freshman":10.9,"senior":10.8},{"score":20,"freshman":11.1,"senior":11},{"score":10,"freshman":11.3,"senior":11.2}]},
  sitAndReach: {"label":"坐位体前屈","unit":"厘米","lowerIsBetter":false,"rows":[{"score":100,"freshman":25.8,"senior":26.3},{"score":95,"freshman":24,"senior":24.4},{"score":90,"freshman":22.2,"senior":22.4},{"score":85,"freshman":20.6,"senior":21},{"score":80,"freshman":19,"senior":19.5},{"score":78,"freshman":17.7,"senior":18.2},{"score":76,"freshman":16.4,"senior":16.9},{"score":74,"freshman":15.1,"senior":15.6},{"score":72,"freshman":13.8,"senior":14.3},{"score":70,"freshman":12.5,"senior":13},{"score":68,"freshman":11.2,"senior":11.7},{"score":66,"freshman":9.9,"senior":10.4},{"score":64,"freshman":8.6,"senior":9.1},{"score":62,"freshman":7.3,"senior":7.8},{"score":60,"freshman":6,"senior":6.5},{"score":50,"freshman":5.2,"senior":5.7},{"score":40,"freshman":4.4,"senior":4.9},{"score":30,"freshman":3.6,"senior":4.1},{"score":20,"freshman":2.8,"senior":3.3},{"score":10,"freshman":2,"senior":2.5}]},
  standingLongJump: {"label":"立定跳远","unit":"厘米","lowerIsBetter":false,"rows":[{"score":100,"freshman":207,"senior":208},{"score":95,"freshman":201,"senior":202},{"score":90,"freshman":195,"senior":196},{"score":85,"freshman":188,"senior":189},{"score":80,"freshman":181,"senior":182},{"score":78,"freshman":178,"senior":179},{"score":76,"freshman":175,"senior":176},{"score":74,"freshman":172,"senior":173},{"score":72,"freshman":169,"senior":170},{"score":70,"freshman":166,"senior":167},{"score":68,"freshman":163,"senior":164},{"score":66,"freshman":160,"senior":161},{"score":64,"freshman":157,"senior":158},{"score":62,"freshman":154,"senior":155},{"score":60,"freshman":151,"senior":152},{"score":50,"freshman":146,"senior":147},{"score":40,"freshman":141,"senior":142},{"score":30,"freshman":136,"senior":137},{"score":20,"freshman":131,"senior":132},{"score":10,"freshman":126,"senior":127}]},
  sitUp: {"label":"1 分钟仰卧起坐","unit":"次","lowerIsBetter":false,"rows":[{"score":100,"freshman":56,"senior":57},{"score":95,"freshman":54,"senior":55},{"score":90,"freshman":52,"senior":53},{"score":85,"freshman":49,"senior":50},{"score":80,"freshman":46,"senior":47},{"score":78,"freshman":44,"senior":45},{"score":76,"freshman":42,"senior":43},{"score":74,"freshman":40,"senior":41},{"score":72,"freshman":38,"senior":39},{"score":70,"freshman":36,"senior":37},{"score":68,"freshman":34,"senior":35},{"score":66,"freshman":32,"senior":33},{"score":64,"freshman":30,"senior":31},{"score":62,"freshman":28,"senior":29},{"score":60,"freshman":26,"senior":27},{"score":50,"freshman":24,"senior":25},{"score":40,"freshman":22,"senior":23},{"score":30,"freshman":20,"senior":21},{"score":20,"freshman":18,"senior":19},{"score":10,"freshman":16,"senior":17}]},
  distanceRun: {"label":"800 米跑","unit":"秒","lowerIsBetter":true,"rows":[{"score":100,"freshman":198,"senior":196},{"score":95,"freshman":204,"senior":202},{"score":90,"freshman":210,"senior":208},{"score":85,"freshman":217,"senior":215},{"score":80,"freshman":224,"senior":222},{"score":78,"freshman":229,"senior":227},{"score":76,"freshman":234,"senior":232},{"score":74,"freshman":239,"senior":237},{"score":72,"freshman":244,"senior":242},{"score":70,"freshman":249,"senior":247},{"score":68,"freshman":254,"senior":252},{"score":66,"freshman":259,"senior":257},{"score":64,"freshman":264,"senior":262},{"score":62,"freshman":269,"senior":267},{"score":60,"freshman":274,"senior":272},{"score":50,"freshman":284,"senior":282},{"score":40,"freshman":294,"senior":292},{"score":30,"freshman":304,"senior":302},{"score":20,"freshman":314,"senior":312},{"score":10,"freshman":324,"senior":322}]},
};
