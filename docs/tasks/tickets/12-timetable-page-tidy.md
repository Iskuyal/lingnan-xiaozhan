# 12：课表页「收纳版」整理

> **2026-10-17 收尾归档**：本票 2026-09-22 创建后一直未入仓，收尾时按原样归档并补记核对状态：
> 第 4 项「滑层交互零测试覆盖」已不成立（`tests/timetable-pages.test.cjs` 已有 openSheet/closeSheet 用例）；
> 第 1–3 项本轮没有逐项复核，且课表页将按[57 屏设计](../../design/lingnan-ui-2026/README.md)重写
> （[Issue #137](https://github.com/Iskuyal/wx-match/issues/137)），实现时按本票清单逐条核对，
> 本轮收尾不修。Issue #24 的三个决策框仍未结清。

> **2026-10-17 UI实现补记**：[Issue #137](https://github.com/Iskuyal/wx-match/issues/137) 按负责人已确认的57屏设计重写，保留周网格/列表与页内助手，不采用本历史票的“网格唯一、助手独立滑层”方向。管理、导入、新增及返回已恢复为按钮；无法落格的课程可由管理列表逐门编辑/确认删除，取消删除不写入已有回归。列表仍存在，因此助手的“课表列表”指引不再与界面脱节；详情弹层已有页面行为测试。本轮不执行含真实云调用的 `verify:wechat`，改用离线原生 UI 检查，见[证据](../../evidence/lingnan-ui-2026-10-17/README.md)。此补记不替代 Issue #24 的历史决策，也不将下方旧验收框全部勾为完成。

## 2026-10-23 逐项核对

按已批准57屏设计及`e389e6a`现况核对；本轮未改课表代码。独立目录767项测试通过，端上新记录因开发者工具启动阻断而未取得。

| 原问题 | 当前依据与结论 |
| --- | --- |
| 1. 无节次课程不可达 | 管理列表保留全部课程并支持逐门编辑/确认删除；[管理页行为测试](../../../tests/timetable-manage-page.test.cjs)及[UI回归](../../../tests/lingnan-ui.test.cjs)覆盖无法落格与取消删除；[10-17原生离线证据](../../evidence/lingnan-ui-2026-10-17/README.md)保留。旧问题不再列为待编码 |
| 2. 按钮降为text | [当前模板](../../../miniprogram/pages/timetable/index.wxml)的import-entry/manual-add/back-home均为button，已按新设计恢复；不再要求重复回退 |
| 3. 助手提示与列表脱节 | 新UI保留列表与管理入口；[助手提示](../../../miniprogram/services/timetable/assistant.ts)指向列表，与当前界面一致，不再执行旧“只能改成网格点课”建议 |
| 4. 滑层零测试 | [主页行为测试](../../../tests/timetable-pages.test.cjs)已有openSheet/closeSheet与多课成员处理，管理删除确认也有行为测试；零覆盖描述属于历史 |

旧验收框不批量勾选：#24三个决定、原判断项处置、新版真实云端/真机记录仍独立保留；已批准的新UI取代本票原“网格唯一/独立助手滑层”方向。下方保留原票及当时审查，不作为重复开发指令。

**What to build:** 课表页从「网格 + 按天列表」两套视图收敛成**网格唯一视图**：点课程弹出编辑滑层（修改 / 删除 / 取消），课表助手从页内面板改成**悬浮入口 + 独立滑层**，页头页脚重新排布。

**Blocked by:** [Issue #24](https://github.com/Iskuyal/wx-match/issues/24) 的三个决策框（起算日候选、是否接受周次小条形态、图片类通知是否人工补录）；以及本票「本票要修的」一节。

**Status:** in-progress（2026-09-20 事后补票。**代码已由 PR [#56](https://github.com/Iskuyal/wx-match/pull/56) 合入 main**——本票是**事后追认 + 待修项清单**：改动在合入时没有立项依据，且带着审查发现的 1 条硬性回归与若干判断问题一起进了主干，需要在本票里逐条修掉。）

> **编号冲突已处理（2026-09-22）**：校园通知 RAG 与 OCR 分别使用 Ticket 10、11，本票由 10 改为 12。
>
> **合入时间线（供回溯）**：2026-09-20 两轴审查时，这批改动**还在工作区、未提交**；审查结论出来前后，另一个会话把它提交为 `d26de9a`、推上去、开 PR #56 并合入 main。因此本票的整改项**要在主干上做**（不是"合并前先修"）。

## 来源：两轴审查（2026-09-20）

对**未提交的工作区改动**做 Standards + Spec 两轴审查，结论：

- **Spec 轴：整批改动没有对应规格。** Issue #24 仍 `needs-triage`、0 评论、3 个决策框全部未勾；`docs/tasks/tickets/` 里没有任何 UI 收纳 / 滑层票；全仓 docs 检索不到「收纳 / 悬浮 / 滑层」。
- **Standards 轴：2 条硬性违规 + 5 条判断问题**（见下）。
- 汇总者复核时否掉了两轴各一条不成立的指控（Spec 认为 `expectedTitle` 断言被改松、Standards 认为 `assert.ok(await page.$(...))` 恒真），**保留的发现如下**。

## 本票要修的（审查结论，按严重度）

1. **无节次课程在界面上不可达（硬性违规）**。网格只按 `course.sectionRanges` 落格（`services/timetable/view.ts:144-152`，空数组不进循环）；删掉按天列表后，`sectionRanges: []` 的课仍被 `total` 计入「共 N 门」，却**没有任何入口能打开它去修正或删除**——而 `view.ts:177` 的 `blockingReason` 原话正是「节次待补，请**修正或删除**」，且它只在**导入确认页**用（`pages/timetable/import/index.ts:425`），课表页不列这类课。依据 `docs/development-spec.md:82-85`「独立手工新增、修改、删除入口纳入首版」。
   → 期望：课表页要有办法看到并处理这类课（例如页内一段「待补节次」清单，点进同一条编辑滑层）。
2. **入口降级没有依据**。`#import-entry`（重新导入课表）、`#manual-add`（手工加课）从页顶 `<button>` 变成页脚 `<text>`，`#back-home` 由 `<button>` 变 `<text>`。Ticket 03 只要求「引导文案与选择入口已实现」，未要求降级；且与 `docs/evidence/p3-2/README.md:45` 记录的「正常态补返回按钮」取向相反。
   → 期望：回退成按钮，或在本票写明降级的理由并更新那份验证记录。
3. **助手提示词与界面脱节**。`services/timetable/assistant.ts:89` 的提示词仍写「请他在**课表列表**里操作」，而唯一的课程列表已被本次改动删掉；Ticket 06:25 的验收口径同样写着「指路**课程列表**的手工删除入口」。
   → 期望：提示词改成指路「网格里点开课程」，并同步 Ticket 06 的措辞。
4. **新增交互零测试覆盖**。`openSheet` / `closeSheet` / `editFromSheet` / `deleteFromSheet`（`pages/timetable/index.ts:152-173`）在**全部测试文件中零引用**，只有 `verify-wechat.cjs` 覆盖。与 `AGENTS.md`「添加验证」纪律不符。
   → 期望：`tests/timetable-pages.test.cjs` 补行为断言（打开 / 取消收起 / 删除走确认）。
5. **判断问题（可改可不改，逐条给结论）**：
   - 滑层里重写了一份课程卡标记（`index.wxml:77-80`），与刚删掉的按天列表逐字重复；`openSheet`/`editFromSheet`/`deleteFromSheet` 又重复了 `openEdit` 的定位 + `toCard`。建议抽 `findCard(id)`。
   - `index.wxml:49` 把「待核对」与红金交替塞进同一个三元表达式，正确性依赖 WXSS 里 `.grid-course-review` 晚于 `.grid-course-gold` 声明。两条规则不该由声明顺序耦合。
   - `#import-entry` 在 ready（页脚「重新导入课表」）与 empty（按钮「导入课表文件」）两态语义不同，却被 `verify-wechat.cjs:63` 当就绪哨兵。

## 不属于本票

依赖安全整改（`xlsx` 换 SheetJS CDN、三个云函数加 `overrides`、jimp 版本）**拆到另一个 PR**，不混在本票里。其中 jimp 的取舍见下：

- 2026-09-20 实测确认：`miniprogram-automator` 的 `out/util.js` 调 `jimp.default.read()`，而 jimp 1.6.1 把入口移到了 `Jimp.read()`；直接升级会破坏扫码路径。此前装 1.6.1 时 `verify:wechat` 连续三次超时，但干净重开项目也能解释该现象，不能把超时直接归因于 jimp。
- 2026-09-22 结论更新：旧 pin `jimp@0.22.12` 会带入 `file-type` 的中危拒绝服务通告（GHSA-5v7r-6r5c-r473），不再接受这条遗留。依赖升到 `jimp@1.6.1`，公共连接模块在加载 automator 前补 `default.read → Jimp.read` 兼容入口；合入最新课表模块后的最终状态为 `npm audit` 0、`npm test` 440 项全过、开发者工具验收 24 项通过。`tests/security-dependencies.test.cjs` 同时锁定安全版本与兼容行为。

## 验收标准（按实际证据勾选）

- [ ] Issue #24 的三个决策框有结论，或本票写明「与 #24 无关」的决定记录
- [ ] 无节次课程在课表页可见且可编辑/删除（含测试）
- [ ] 入口降级已回退，或降级理由已写入本票并同步更新 `docs/evidence/p3-2/README.md`
- [ ] `assistant.ts` 提示词与 Ticket 06 的措辞已同步到「网格点开课程」
- [ ] 滑层交互有页面级行为测试（打开 / 取消收起 / 删除走确认）
- [ ] `npm run typecheck`、`npm test`、`npm run verify:wechat` 三项全过
- [ ] 改动拆成独立 PR，且 PR 描述里写明「本票是事后补的立项」

**评分维度：** 技术实现 25%（交互与测试覆盖）、产品体验与用户增长设计 10%（入口可达性与操作路径）。
