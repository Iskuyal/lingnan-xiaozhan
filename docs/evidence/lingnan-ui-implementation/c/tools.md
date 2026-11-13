# C 分支 · 校历 / 体测 / 升学三页（岭南红 UI 第二轮）

实施者：c-tools　｜　工作树：`.worktrees/lingnan-ui-c`（分支 `codex/lingnan-ui-c`）
任务板：`task-3`（C-3 校历/体测/升学三页）
设计稿：`docs/design/lingnan-red-2026-11-11/` 的 `25-calendar`、`26-fitness`、`27-fitness-result`、`63-fitness-missing`、`28-advancement`、`29-clarify`、`30-answer`

## 一、改了哪些文件

只动了任务允许的 12 个页面文件，没有碰 services、app.json、app.wxss、styles/ui.wxss、ui/navigation.ts、ui/study/study.wxss 与任何既有测试。

| 文件 | 改动 |
| --- | --- |
| `miniprogram/pages/calendar/index.ts` | 重写页面视图模型；新增 `ToolsCalendarTone` / `ToolsCalendarRow` / `ToolsCalendarGroup` 与 `TONE` / `DATE_HINT` / `GUARD` 三张状态表，`decorate()` 把服务层分组映射成视图行 |
| `miniprogram/pages/calendar/index.wxml` | 换成 `u2-` 版式：kicker / h1 / lead、分组 section、卡片（标题 + 状态标签 + 大字日期或日期状态 + 报名/适用范围 kv + 原因 + 出处 + 复制链接） |
| `miniprogram/pages/calendar/index.wxss` | 全部重写为 `.cal-*` + `u2-`/`st-` 组合；首行 `@import "../../ui/study/study.wxss";` |
| `miniprogram/pages/fitness/index.ts` | 保留 `parseNumberInput` / `parseRunInput` 与全部原有 data 键、方法；新增缺项补填模型 `ToolsMissingRow` / `ToolsFillField`、`FILL_FIELDS`、`missingRowsOf()`、`fixed1()`，新增 `missingRows` / `filledCount` / `resultEyebrow` / `totalText` / `standardText` / `bonusText` |
| `miniprogram/pages/fitness/index.wxml` | 换成 `st-seg` / `st-field` / `st-input` 表单 + 结果区两分支（有总分 / 缺项不出总分） |
| `miniprogram/pages/fitness/index.wxss` | 全部重写为 `.fit-*` + `u2-`/`st-` 组合；首行 `@import` |
| `miniprogram/pages/advancement/index.ts` | 保留全部原有问答骨架（`ask` / `onChoice` / `onCancelModel` / `onRetryModel` / `startModel` 与 `canAskModel` 门禁）；新增 `answerSegments()` / `toSources()` / `scopeLabelOf()` / `scopeRowsOf()` 与 `segments` / `sources` / `scopeLabel` / `scopeRows` / `activeRef`，新增 `onAskAgain()` / `onJumpRef()` |
| `miniprogram/pages/advancement/index.wxml` | 换成 `u2-` 版式：提问区、范围条、回答卡（行内 `[S1]` 编号可点）、「对应原文」区块（文档信息 + 适用年份 + 适用人群 + 原文 + 复制链接）、澄清/拒答分支 |
| `miniprogram/pages/advancement/index.wxss` | 全部重写为 `.qa-*` + `u2-`/`st-` 组合；首行 `@import` |
| `tests/ui-v2-c-tools.test.cjs` | 新建，11 个用例覆盖三条红线 |
| `docs/evidence/lingnan-ui-implementation/c/tools.md` | 本文件 |

三个 `index.json` 未改动（标题文案沿用既有「校历与考试」「体测估算」「升学与实习问答」）。

## 二、三条数据诚实性红线怎么守住的

### 红线 1：校历只能只用已有条目与出处

- 页面不内置任何日期常量。`reload()` 只调 `groupEvents(CALENDAR_EVENTS, now)`，`CALENDAR_EVENTS` 是 `services/calendar/events.ts` 的 9 条既有条目（5 条有日期、4 条无日期）。
- 无日期条目**不显示日期、不给倒计时**：`DATE_HINT` 把 `pending` 映射成「日期待公布」、`per-school` 映射成「日期以本校为准」、`link-only` 映射成「暂无官方日期」；`stateLabel` 与 `days` 原样来自服务层（非 published 时 `days` 为 `null`）。
- 「为什么没有日期」用**文字**写在卡片里（`GUARD`：`pending`「尚无可核实的官方日期；不沿用往年安排。」、`per-school`「报名时间由各考点自行规定，本页不给全国统一截止日期。」、`link-only`「这里只给官方入口，没有可核对的日期。」），不只是靠颜色。同时 `tone` 三档（`warn`/`plain`/`live`）驱动标签与日期大字配色，文字与颜色两套通道都在。
- 页头 lead 明说「没有官方日期的事项写『待公布』或『以本校通知为准』，不沿用往年安排」。
- 每张卡片都贴出处（`sourceLabel` / 公告发布日期 / 最后核查 `2026-09-29`）与「复制官方原文链接」，链接来自条目自身的 `sourceUrl`，页面不新造。

### 红线 2：体测缺项不出总分，单项分只来自 `estimate()`

- 页面**不计算任何分数**。`calculate()` 只做 `estimate(input)` 并把结果整体放进 `data.result`；单项分由模板直接渲染 `item.score`，`estimate()` 之外的任何加权、折算、四舍五入在页面里都不存在。
- 缺项判定也用服务层输出：`missingRowsOf()` 取 `result.items.filter(item => item.score === null)`，缺项 note 原样用服务层文案，页面不自己判断「哪些算没填」。
- 总分卡只在 `result.total !== null` 时渲染（`[wx:if="result.total !== null"]`）。缺项时走 `[wx:else]` 分支：提示块用强语义写「7 项没有全部计分，这里**不给学年总分、也不给等级**；已填项目的加权分同样不冒充总分。」，`totalText` 为 `—`，页面上**没有**大分数位置。
- `standardScore` 只在缺项时以「标准分」小字出现，并紧贴上面的说明，不占据总分位置。
- 单项明细表始终 7 行都在（缺的那行成绩显示「未填」、分数显示「—」），所以「缺项不显示总分」不等于「缺项看不到已填项」。
- 缺项名称旁可直接补填：`missingRows[].fields` 里每个字段渲染成 `st-input`，`bindinput` 写回同一个 `form`，`#fit-recalc` 触发 `onRecalculate()` → `calculate()`，补全后才出现总分与等级。

### 红线 3：升学不把模型输出写成结论，无出处不发请求

- **`canAskModel` 为 false 时不发请求**：这一门禁保留在 `startModel()` 里（未改动逻辑）。此时 `modelPhase` 置 `idle`，页面显示的是服务层返回的固定话术（clarify 的选项 / refuse 的说明与官方入口），`modelText` 为空、`segments` 为空。
- 降级为「原文摘录」：模型失败或被取消时 `modelPhase` 为 `fallback`、`modelLabel` 为「原文摘录」、`modelText` 等于 `result.answer`（即本地收录原文，未经改写）。
- 模型解释与结论的边界写在模板里：回答卡旁常驻一句「这里只解释收录文件，不据此判断你本人能否报考。」；顶部 lead 也写明「有出处再解释；资料里没有就说明」。
- **来源编号与「对应原文」互相引用**：`answerSegments()` 把正文按 `[S1]` 切成 `text` / `ref` 段，正文里的编号是 `<text class="qa-ref">` 可点（`bindtap="onJumpRef"`）；「对应原文」区块每个 `[S1]` 标题同样绑定 `onJumpRef`，点任一侧都会把对应文档卡高亮（`activeRef` + `.qa-source-on` / `.qa-ref-on`）。正文编号与区块标题**同一个 `sourceLabel(i)` 生成规则**（1-based），不会错位。
- **适用范围上屏**：`scopeLabel` 显示「2026 年已存政策 · 非新年度报考依据」，`scopeRows` 显示「通道 / 适用年份 / 适用地区」三行；每份原文卡还写适用年份（`适用：广东省 2026 年`）与**适用人群**（文档的 `applicableAudience` 原样）。
- 兜底策略「宁可不标也不标错」：`splitPlain()` 只有在正文恰好等于引用原文按序拼接时才补编号，否则不插编号。

## 三、测试与类型检查

命令（`scripts/ui-v2-c-run.cjs` 负责串行构建 + 测试；不直接跑 `build.mjs` / `npm test`）：

```
node scripts/ui-v2-c-run.cjs tests/calendar.test.cjs tests/fitness.test.cjs tests/advancement.test.cjs tests/advancement-model.test.cjs tests/ui-v2-c-tools.test.cjs
npx tsc --noEmit
```

（结果见下方「执行记录」，随最终执行回填。）

新测试 `tests/ui-v2-c-tools.test.cjs` 的 11 个用例：

| # | 用例 | 对应红线 |
| --- | --- | --- |
| 1 | 校历：无日期事项不显示日期、不给倒计时，但每类都写明原因 | 1 |
| 2 | 校历：页面日期逐条来自 `CALENDAR_EVENTS`，不新造日期 | 1 |
| 3 | 体测：缺一项不显示学年总分与等级，已填项加权分不冒充总分 | 2 |
| 4 | 体测：单项分逐项等于 `estimate()`，页面不重算 | 2 |
| 5 | 体测：长跑三种写法换算成秒，非法写法不被当数字 | 2 |
| 6 | 体测：缺项就地补填后重新估算才出现总分与等级，且不写本机存储 | 2 |
| 7 | 升学：无可核对出处时不发模型请求（clarify / refuse 均零调用） | 3 |
| 8 | 升学：模型失败退回「原文摘录」，正文与出处编号仍互相引用 | 3 |
| 9 | 升学：模型解释上屏时正文编号与「对应原文」一一对应，可互跳 | 3 |
| 10 | 升学：适用范围（通道/年份/地区）与「非新年度报考依据」上屏 | 3 |

## 四、未解决项与风险

1. **WXSS 硬规则**：三份 WXSS 都已通过 `tests/wxss.test.cjs`（注释外无中文、花括号圆括号配平、`var(--token, 回退值)` 与 `app.wxss` 逐字一致），2/2 通过。其中 `miniprogram/pages/advancement/index.wxss` 的 `--warn-soft` 回退值曾把 `rgba(255,244,228,0.86)` 的空格写错，已由 Lead 修复，wxss 测试 2/2 通过。
2. **截图核对未做**：`scripts/ui-v2-c-capture.cjs` 需要微信开发者工具与可用的 `dist/`，本轮未跑。三页对应的 `wxmlExpect` 关键字（`校历与考试` / `以本校通知为准` / `缺项就留空` / `不上传、不保存` / `估算` / `未填` / `依据` / `原文`）已在模板文案里覆盖。
3. **`#qa-again` 重复 id 已修**：原先进学页 answer 分支用 `#qa-again`「继续提问」、澄清/拒答分支也用 `#qa-again`「换个问法」，两个分支 `wx:if` 互斥、渲染上没问题，但同 id 出现两次对按 id 取元素的自动化不友好。已把澄清/拒答分支改成 `#qa-reask`，answer 分支保留 `#qa-again`。
4. **构建曾被他人在改的 `pages/goals/plan/index.ts` 阻断**（`TS7006` 隐式 any、`TS1117` 重复属性、`TS2339 coursesKnown`），`noEmitOnError` 导致 `dist/` 被清空、依赖 dist 的测试无法运行。这不是本次改动引入的错误；等该文件修好后重跑即可。
5. **服务层冻结**：`services/{calendar,fitness,advancement}`、`app.json`、`app.wxss`、`styles/ui.wxss`、`ui/navigation.ts`、`ui/study/study.wxss` 一行未改；若后续审查要求调整（例如给 `estimate()` 增加字段），需由对应 owner 处理。
6. 三个页面仍是普通页面（非 tab），返回逻辑保持既有语义：`getCurrentPages().length > 1` 走 `navigateBack`，否则 `reLaunch('/pages/home/index')`。体测结果区额外提供「返回学习工具」，走 `openUiTab('study')` 并以 `reLaunch('/pages/study/index')` 兜底。

## 五、执行记录

### 5.1 构建 + 测试（必跑组合）

```
node scripts/ui-v2-c-run.cjs --no-build --wait 300 \
  tests/calendar.test.cjs tests/fitness.test.cjs \
  tests/advancement.test.cjs tests/advancement-model.test.cjs \
  tests/ui-v2-c-tools.test.cjs
```

结果：

```
tests 52
suites 0
pass 52
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 609.0996
exit code 0
```

即 **52 / 52 通过，0 失败、0 跳过**。

### 5.2 类型检查

```
npx tsc --noEmit
```

结果：**exit 0，零错误**（全项目）。

另有只针对三页的 scoped 类型检查（构建被阻断期间也一直保持通过）：

```
npx tsc --noEmit --strict --target ES2017 --module CommonJS --moduleResolution node \
  --types miniprogram-api-typings --skipLibCheck \
  miniprogram/pages/calendar/index.ts miniprogram/pages/fitness/index.ts miniprogram/pages/advancement/index.ts
```

结果：exit 0。

### 5.3 既有契约回归（改动未破坏旧测试）

```
node scripts/ui-v2-c-run.cjs --no-build --wait 300 \
  tests/campus-tools-pages.test.cjs tests/wxss.test.cjs tests/ui-v2-a-tabbar.test.cjs
```

结果：`tests 16 / pass 16 / fail 0 / skipped 0`，exit 0。
其中包含：体测页 `onInput` + `calculate` + `focusForm`（`wx.pageScrollTo({scrollTop:0})` 且不写本机存储）、首页入口指向三页且产物齐全、WXSS 两条硬规则（无中文 + 令牌回退值逐字一致）。

### 5.4 本页专属测试明细（`tests/ui-v2-c-tools.test.cjs`）

单独运行：`tests 10 / pass 10 / fail 0 / skipped 0`，exit 0。

| # | 用例 | 结果 |
| --- | --- | --- |
| 1 | 校历：无日期事项不显示日期、不给倒计时，但每类都写明原因 | pass |
| 2 | 校历：页面日期逐条来自 `CALENDAR_EVENTS`，不新造日期 | pass |
| 3 | 体测：缺一项不显示学年总分与等级，已填项加权分不冒充总分 | pass |
| 4 | 体测：单项分逐项等于 `estimate()`，页面不重算 | pass |
| 5 | 体测：长跑三种写法换算成秒，非法写法不被当数字 | pass |
| 6 | 体测：缺项就地补填后重新估算才出现总分与等级，且不写本机存储 | pass |
| 7 | 升学：无可核对出处时不发模型请求（clarify / refuse 均零调用） | pass |
| 8 | 升学：模型失败退回「原文摘录」，正文与出处编号仍互相引用 | pass |
| 9 | 升学：模型解释上屏时正文编号与「对应原文」一一对应，可互跳 | pass |
| 10 | 升学：适用范围（通道/年份/地区）与「非新年度报考依据」上屏 | pass |

### 5.5 类名自查

| 检查 | 结果 |
| --- | --- |
| 三页 WXML 的 `st-` 类是否都在 `miniprogram/ui/study/study.wxss` 定义 | 用到 21 个，缺失 0 个 |
| 三页 WXML 的 `u2-` 类是否都在 `miniprogram/styles/ui.wxss` 定义 | 用到 27 个，缺失 0 个 |
| 三页 WXSS 的局部前缀类是否都被 WXML 用到 | `fit-` 23 个、`qa-` 51 个、`cal-` 19 个，defined-but-unused 为 0 |

### 5.6 构建阻断记录（已解除）

开发期间全项目 `tsc` 曾被 `miniprogram/pages/goals/plan/index.ts`（c-plan 负责）的 9 条错误阻断（`TS7006` 隐式 any ×7、`TS1117` 重复属性、`TS2339 coursesKnown`），因 `noEmitOnError` 导致 `dist/` 被清空、所有依赖 dist 的测试无法运行。该文件修好后全项目 `tsc` 恢复 exit 0，上述结果均为修复后实测。

期间修掉的三处测试写法问题：`vm.runInNewContext` 里页面 data 的数组属于另一个 realm，`assert.deepEqual` 会判原型不等（`Values have same structure but are not reference-equal`）。改为比较前统一成本域普通数组（`Array.from` 或 `JSON.parse(JSON.stringify(...))`）后全部通过——被测逻辑本身没有问题。

### 5.7 文档检查

```
node scripts/check-docs.mjs
```

结果：`文档检查：267 个 Markdown，2136 个本地引用，0 个错误。`，exit 0。


