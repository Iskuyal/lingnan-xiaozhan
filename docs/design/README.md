# 设计图（UI 先画设计图）

**约定（2026-09-20 起）：界面改动先出设计图，设计图定稿后再改代码。**
理由：这个项目的界面问题大多不是「写不出来」，而是「画的时候就发现不对」——列宽、字号、信息层级
在纸面上改一次的成本，远低于写完 WXML/WXSS 再返工。设计图同时也是实现时的尺寸依据与参赛材料里的
过程证据（`docs/competition/submission.md` 的 e 项要求真实界面截图）。

## 目录与命名

```text
docs/design/
  README.md              ← 本文件：约定
  <主题>/                ← 一个改动主题一个目录，如 timetable/
    README.md            ← 设计说明：为什么改、做什么/不做什么、版式规则、待拍板项
    _tokens.css          ← 设计令牌，与 miniprogram/app.wxss 逐条对应
    _mockup.css          ← 版式与组件（共享）
    NN-画面.html         ← 设计图源文件，编号即画面上线顺序
    png/NN-画面.png      ← 渲染产物：**评审看 PNG，实现抄 HTML 里的数字**
```

- 命名：`NN-画面.html`，编号两位数，同一主题内唯一。
- 一个 HTML 是一屏（或同一页面的两种状态），390px 宽，必须带
  `<meta name="viewport" content="width=device-width, initial-scale=1">`。
- 不写 JavaScript：设计图是静态评审件，交互用「多画一屏」表达。

## 令牌与单位

- `_tokens.css` 的每个令牌都必须在 `miniprogram/app.wxss` 里有同名同值定义，否则等于在画一个实现
  不出来的界面。改 `app.wxss` 的令牌后同步改它。
- 设计图按 **390px** 宽绘制（iPhone 14/15 逻辑宽度）。小程序 750rpx = 屏宽，所以
  **1rpx = 0.52px**；`app.wxss` 里以 px 写的值（如 `--glass-blur: 16px`）在图上仍是同值。
  写实现时按 0.52 换算回 rpx。
- **课程色板例外**：课块颜色是数据驱动的（按课程名取色），WXSS 里写不出来，因此它的单一来源是
  `miniprogram/services/timetable/palette.ts`；结构色仍在 `app.wxss`。设计图的 `_tokens.css`
  与色板页（`10-palette.html`）跟着这两处走。

## 渲染

```bash
node scripts/render-mockups.mjs                      # docs/design 下全部
node scripts/render-mockups.mjs docs/design/timetable # 只渲染一个主题
node scripts/render-mockups.mjs docs/design/timetable --only 01,02
```

脚本用 headless Chrome + CDP（Node 内置 fetch/WebSocket，无依赖，需 Node ≥ 22）。
会校验布局宽度是否等于设计宽度——缺 viewport meta 时 Chrome 会按 980px 缩放，图会静默失真，
脚本直接报错而不是产出错图。

## 评审流程

1. 按主题画完，跑渲染，**自己先看图**（图不看等于没画）。
2. 设计说明里列清「待拍板项」，负责人拍板后把状态从「待评审」改成「定稿」。
3. 定稿后才动实现；实现里不得出现与图不一致的间距与字号。
4. 图上的行为覆盖不到的部分（滑动手势、加载态、失败态、无障碍），仍按
   `docs/product/spec.md`、既有验收脚本与 ADR 处理，并在设计说明里写明。

## 与验收的关系

设计图**不是**验收证据：验收仍以开发者工具/真机实测、`npm run verify:wechat` 与
`docs/evidence/` 为准。设计图是评审件与尺寸依据，PNG 进仓库是为了可追溯。

## 设计主题索引

- [岭南红全量 UI/UX 重设计（2026-11-11，79 张静态提案，待负责人定稿）](lingnan-red-2026-11-11/README.md)

- [AI理解学习约束与规则校验（已确认并本地实现，真实模型样例另计）](ai-study-plan-2026-11-11/README.md)

- [限定周次调课与计划保存后可见（本轮三图已确认并实现）](notice-plan-loop-2026-11-10/README.md)

- [2026-11-10 反馈复查：事实与状态修正已确认，首页聚焦方案仅保留建议](ai-review-2026-11-10/README.md)

- [AI 创新点与界面升级（回应评语：通知一键调课、今日简报、目标倒排；讨论稿待拍板）](ai-innovation-2026-11/README.md)

- [部门问答守卫与缺失说明修正（现有布局下的文案对照评审件）](department-qa-guard-2026-10-30/README.md)
- [正式作品名同步（明确命名下的导航文字更新）](app-name-2026-10-29/README.md)

- [部门动态缺失范围文案修补（本轮委托执行、自查；不改布局）](department-qa-clarity-2026-10-29/README.md)

- [岭南校园工具全流程新 UI（57 屏修订稿，负责人已确认为实现依据，重写见 #137）](lingnan-ui-2026/README.md)（官网盾形校徽；本地 HTML/PNG 为实现依据，Figma 44 屏初稿受额度限制待同步）
- [原生实现首屏修订](lingnan-ui-implementation/README.md)（课表和导入校对的紧凑布局；原生评审后先画图再调整）
- [全模块界面改版](campus-refresh/README.md)
- [课表改版](timetable/README.md)
- [课表主页可读性返工](timetable-readability/README.md)
- [目标日（当前规则已于2026-10-30定稿）](goal-days/README.md)
- [校历与考试（当前范围与规则已于2026-10-30定稿）](exam-calendar/README.md)
- [体测估算（0分下限口径于2026-10-30确认，保留国家参考限制）](fitness-calc/README.md)
- [升学问答（澄清纠错，整体待评审）](advancement-qa/README.md)
- [项目讲解与答辩练习（G2 设计图与业务契约，整体待评审）](project-defense/README.md)
- [校长审核材料：功能、使用过程与最终结果](principal-showcase-v5/README.md)（仅展示材料，不修改小程序）
- [校长审核材料v6：结果核对与投影阅读](principal-showcase-v6/README.md)（展示材料继续优化）
- [校长审核材料v8：镜头推近、批注与结果核对](principal-showcase-v8/README.md)（动画画面版式，自审待评审）
