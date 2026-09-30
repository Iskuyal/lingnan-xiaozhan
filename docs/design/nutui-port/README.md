# 岭南校园服务 · NutUI 令牌与组件结构移植（3 屏样板）

状态：**待评审**（2026-10-01）。本轮只做 **3 屏样板定调**，不动 `miniprogram/` 下任何文件。

## 为什么做这一版

NutUI 是京东的移动端组件库，本项目想借它的**结构与尺度系统**，让界面的字号、间距、控件高度不再是逐页手调的数值。
但要先讲清一件事：

**NutUI 装不进这个项目。** `jd-opensource/nutui` 是 **Vue 3** 组件库（`@nutui/nutui@4.3.15`，依赖 `@nutui/icons-vue`、`vue-router`），
本项目是**原生微信小程序**（WXML/WXSS/TypeScript，无 Vue/React/Taro 运行时，也不在运行时消费 npm 组件）。
该仓库没有 `SKILL.md`，`gh skill` 也装不了它（它不是 skill 源，是组件库）。

所以本主题的定位是：**移植 NutUI 的设计语言，而不是引入它的代码**。并且按负责人 2026-10-01 的拍板：

> **以已定稿的 `docs/design/campus-refresh/` 为视觉准则，只吸收 NutUI 的令牌阶梯与组件解剖。**

即：方角、纸白、品牌红、无全局磨砂、不用大面积渐变——**这些一条都不改**；换掉的是散落的字号与间距，以及控件的内部结构。

## NutUI 来源（可复核）

| 项 | 值 |
| --- | --- |
| 仓库 | `https://github.com/jd-opensource/nutui` |
| 提交 | `212c7c3af6d0c3b5bc5cdfe00c7eaf8dd86a78cf`（浅克隆 tip） |
| 版本 | `@nutui/nutui@4.3.15` |
| 令牌源文件 | `src/packages/styles/variables.scss` |
| 该文件规模 | **693 个令牌，其中 666 个已是 CSS 自定义属性**（`var(--nut-*, 默认值)`）——这正是可移植的原因：原生 WXSS 支持 CSS 变量 |
| 本地克隆位置 | `E:\wx-match-main\_refs\nutui`（在仓库之外，不会误提交） |

## 吸收了什么（逐条可对）

| NutUI 令牌 | NutUI 默认值 | 本主题令牌 | 落地值 |
| --- | --- | --- | --- |
| `--nut-font-size-0..4` | 10 / 12 / 14 / 16 / 18px | `--fs-cap` / `--fs-sm` / `--fs-base` / `--fs-lg` / `--fs-xl` | 同值 |
| `--nut-line-height-base` | 1.5 | `--lh-base` | 1.5 |
| `--nut-animation-duration` | 0.25s | `--dur` | 0.25s |
| `--nut-animation-timing-fun` | `cubic-bezier(.55,.085,.68,.53)` | `--ease` | 同值 |
| `--nut-cell-padding` | 13px 16px | `--cell-pad-y` / `--cell-pad-x` | 13px / 16px |
| `--nut-cell-line-height` | 20px | `--cell-line` | 20px |
| `--nut-cell-border-radius` | 6px | `--r-cell` | 6px |
| `--nut-cell-after-right` | 16px | `.cell-arrow` 宽 | 16px |
| `--nut-button-{large,default,small,mini}-height` | 48 / 38 / 28 / 24px | `--h-btn-lg` / `--h-btn` / `--h-btn-sm` / `--h-btn-mini` | 同值 |
| `--nut-divider-margin` | 16px 0 | `--divider-gap` | 16px |
| `--nut-empty-padding` | 32px 0 | `--empty-pad-y` | 32px |
| `--nut-empty-description-line-height` | 20px | `--empty-desc-lh` | 20px |
| `--nut-tag-font-size` | 12px | `--fs-sm` | 12px |
| `--nut-radio-button-padding` | 5px 18px | `.choice` 内距 | 5px 12px（取纵向节奏，横向按等分列收敛） |

组件解剖（结构，不是外观）：**Cell**（左内容 / 右值 / 右侧箭头 / 1px 分隔线）、**CellGroup**（分组外壳 + 分组标题）、
**Divider**（带文字的中线）、**Button 尺寸阶梯**、**Empty**、**Collapse**（标题行 + 内容区）、**ChoiceGroup**。
外观一律回到 campus-refresh：描边纸面、方角、品牌红只用于入口与主要动作、失败只用琥珀。

## **不**吸收什么（以及理由）

| NutUI | 默认值 | 为什么不用 |
| --- | --- | --- |
| `--nut-button-border-radius` | 25px（胶囊） | campus-refresh 定稿规则是「方角、6–12px 小圆角优先」，胶囊与之冲突；保留 `--r-control: 5px` |
| `--nut-primary-color-end` | `#fa6419`（主色渐变终点） | 规则明令「不使用大面积渐变」；品牌色保持纯色 `--brand: #c41c23` |
| `--nut-primary-color` | `#fa2c19` | **不改色**。本项目品牌色是 `#c41c23`，两者同属红系，映射后血缘一致 |
| `--nut-popup-border-radius` | 20px | 用 `--r-panel: 8px` |
| `--nut-cell-background` / `--nut-cell-box-shadow` | 纯白 + `0 1px 7px rgba(237,238,241,1)` | 规则明令「不使用重复的卡片投影」；保留 campus-refresh 的描边式纸面 |
| `--nut-switch-*`（36×21 胶囊开关） | — | 本轮 3 屏**没有任何开关用例**。不画没有产品语义的控件，故未纳入组件层（第一版画了，已删除） |

## 三屏映射

| 文件 | 对应 campus-refresh | 这一屏演示什么 |
| --- | --- | --- |
| `01-home.html` | `01-home.html` | 字号阶梯（cap→display）、Cell 解剖用于「最近动态」、入口按钮高度 48px |
| `02-timetable-grid.html` | `07-timetable-grid.html` | 尺度系统用于高密度数据网格；**课程几何一字未动**（节次行高 84rpx = 43.68px、12 节 = 524.16px、窄列 29px）；分段控件与操作按钮走尺寸阶梯 |
| `03-timetable-settings.html` | `16-timetable-settings.html` | CellGroup + 折叠 + 选择组 + 页脚操作栏；标签在上、值在下的表单结构 |

三屏的**页面内容、状态与操作语义全部沿用** campus-refresh，未新增任何业务能力、未新增默认作息时刻、未新增学校背书。

## 令牌落地约定（重要）

`_tokens.css` 分两段，落地方式不同：

1. **颜色段**：逐条抄自 `miniprogram/app.wxss`，**一字未改**，因此现在就已同名同值。
   课程色 `--c1..--c8` 的单一来源是 `miniprogram/services/timetable/palette.ts`（与 campus-refresh 同一约定）。
2. **尺度段（本主题新增）**：定稿后写入 `miniprogram/app.wxss` 的 `page {}` 块。**本轮不写**——按项目规则，设计图定稿前不改代码。
   写入时注意 `tests/wxss.test.cjs` 的两条硬约束：
   - 页面里引用令牌**必须带回退值**，且回退值与 `app.wxss` 中的定义**严格一致**（如 `var(--fs-base, 14px)`）；
   - 非注释内容不得出现中文（本文件是设计件，不受该测试约束，但 WXSS 实现受）。

## 待拍板项

1. **`--r-cell` 取 6px 还是 7px**：NutUI cell 是 6px，campus-refresh 的 `.surface` 原为 7px。本稿按 NutUI 收敛到 **6px**（少一个近似档位）。若要严格保持原样，改回 7px 即可。
2. **`--r-tag` 取 3px 还是 4px**：campus-refresh 的 `.chip` 是 3px，NutUI tag 是 4px。本稿**保持 3px**（以已定稿为准）。
3. **字号收敛的代价**：校园刷新稿里散落的 9 / 11 / 13 / 15px 被收敛到 10 / 12 / 14 / 16px，部分次要文字会有 **±1px** 变化。这是「系统性」的代价，请确认可接受。
4. **`--fs-display: 21px` 与 `--fs-title: 27px`**：NutUI 是组件库，其阶梯只到 18px，这两档是页面级标题，取值**沿用 campus-refresh 现行值**并纳入同一张表（不新增视觉变化）。
5. **推广范围**：campus-refresh 共 20 屏，本轮只做 3 屏定调。定调通过后再决定是否铺开余下 17 屏。

## 渲染

    node scripts/render-mockups.mjs docs/design/nutui-port

产物为 390px 宽、@2x 的 PNG：`png/01-home.png`、`png/02-timetable-grid.png`、`png/03-timetable-settings.png`。

**评审看 PNG，实现抄 HTML 里的数字。** 页面宽度 390px，1px = 1.923rpx。

## 已知取舍（画的时候就发现的问题）

- **页脚操作栏不能用 `position: sticky` 画**：设计图是全页静态截图、不写 JS，sticky 会让该栏浮到视口中部**压住内容**（本主题第一版即踩到，「第 1–4 节」被遮住）。已改为页面末尾的静态栏；实现里该栏仍固定在视口底部。
- 设计图不表达交互：按压态、加载态、失败态、无障碍仍按 `docs/product/spec.md` 与既有验收脚本处理。

## 与验收的关系

设计图**不是**验收证据。验收仍以开发者工具 / 真机实测、`npm run verify:wechat` 与 `docs/evidence/` 为准。
本主题未修改任何业务代码或页面，故不需要补构建与行为回归。
