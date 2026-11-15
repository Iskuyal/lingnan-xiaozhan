# C 分支 · 项目讲解练习页与练习记录复制（设计 31–35、42、56–62、77/78）

角色：c-defense（C 分支）
任务：共享任务板 `task-4`「C-4 答辩练习页与练习记录复制」
改动范围（仅此三项 + 本证据）：
- `miniprogram/pages/defense/index.ts`（重写，560 行；含导出的复制记录纯函数）
- `miniprogram/pages/defense/index.wxml`（重写，359 行；九段状态同页切换）
- `miniprogram/pages/defense/index.wxss`（重写，232 行；首行 `@import "../../ui/study/study.wxss";`）
- `tests/ui-v2-c-defense.test.cjs`（新增，14 项）
- `docs/evidence/lingnan-ui-implementation/c/defense.md`（本文件）

`miniprogram/pages/defense/index.json` 未改动（仍是 `{"navigationBarTitleText": "项目讲解与答辩练习"}`，导航标题沿用既有文案）。

未触碰：`services/**`（冻结区）、`app.json`、`app.wxss`、`styles/ui.wxss`、`ui/navigation.ts`、`ui/study/study.wxss`、任何既有 `tests/*.test.cjs`。

## 设计图 → 状态对应

| 设计 | 状态 | 实现位置 |
| --- | --- | --- |
| 31 选材 | `phase === 'materials'` | 材料卡（`onSelectMaterial`）+ 「练习方式与会话边界」折叠（`toggleBounds`）+ `#defense-begin` dock |
| 32 / 56 / 58 作答 | `phase === 'practice'`，第 1–3 轮 | 进度条 3 格 + 红底问题卡 + 字数行 + `#defense-material-open` 查阅入口 |
| 33 等待 | `phase === 'pending'` | ai-orb + 已等秒数 + `st-loading-bars` + 「停止等待，保留回答」 |
| 34 / 57 / 59 反馈 | `phase === 'feedback'` | 四节反馈块 + 下一轮问题卡 + 「继续第 N 轮」 |
| 35 复盘 | `phase === 'review'` | 三条复盘块 + 「可重答一次」tag + 复制入口 |
| 42 材料 | `materialOpen` | 页面内覆盖层，`#material-reader` 可定位，关闭后回原状态且保留草稿 |
| 60 重答 | `phase === 'reanswer'` | 沿用第 3 轮问题 + 「重答内容」字段 |
| 61 重答结果 | `phase === 'done'` | 结果勾 + 重答后反馈 + 复制入口 |
| 62 退出 | `onExit` 的 `showModal` | 说明会清空 + 建议先复制 |
| 77 练习记录 | `recordOpen` | 逐轮「问题 / 你的回答 / 材料反馈」+ 三轮复盘 + 重答段 + `#defense-record-copy` dock |
| 78 已复制 | `copiedOpen` | 结果勾 + 这次复制了什么 + 边界说明 + 「确认结束，清空会话」/「继续留在练习中」 |

## 复制记录：内容结构与边界

### 纯函数（可测，不依赖 `wx`）

```ts
buildRecordView(input: {
  materialName: string;
  session: DefenseSession;
  reviewRows: ReviewRow[];
}): PracticeRecordView

practiceRecordText(view: PracticeRecordView): string   // 空视图返回 ''
```

`PracticeRecordView = { materialName, rounds: PracticeRecordRound[], review: PracticeRecordReviewLine[], reanswer: PracticeRecordRound | null, empty }`。

### 纳入规则（只复制真实存在的东西）

1. **轮次**：遍历 `DEFENSE_QUESTIONS`（第 1–3 轮），只有 `session.answers` 与 `session.feedbacks` **同轮同时存在且非空白**才纳入。缺一个就跳过——这是「不补写未返回反馈」的实现点。
2. **重答**：`round === 4` 的 answer 与 feedback 同时存在才纳入 `reanswer`，标注「沿用第 3 轮问题」，不与三轮混写。
3. **复盘**：`reviewRows` 里 `status === '已反馈'` 或四段任一非空的行才纳入；编号按纳入顺序连续编 `01/02/…`，不跳过、不留空号。
4. **空会话**：`rounds.length === 0 && reanswer === null && review.length === 0` → `empty: true` → `practiceRecordText` 返回 `''`。

### 文本分段（与设计 77 逐字对齐）

```
项目讲解练习 · 练习记录
材料：<材料名>

第 N 轮 · <维度> · 原答
问题：<原问题>
你的回答：
<原答逐字>
材料反馈：
<模型反馈逐字>

三轮复盘
01 <维度>：已反馈
对应回答：…
引用核对：…
本轮追问：…
待验证保留：…

重答 · 沿用第 3 轮问题
你的重答：
<重答逐字>
重答反馈：
<反馈逐字>
```

- **原答与反馈分开标注**：`你的回答：` 与 `材料反馈：` 各自独立成行、独立空行，先后顺序固定（原答在前）。
- **不改写原答**：`round.answer` / `round.feedback` 直接取 session 里的字符串，不做 trim、不截断、不重组；测试用含换行、连续空格、全角引号的原答断言逐字存在。
- **不补写未返回内容**：pending 态（有 answer 无 feedback）的轮次不出现在文本里；未完成轮次的问题也不会被写进去。
- **不臆造轮次**：只按 `DEFENSE_QUESTIONS` 与 `round === 4` 遍历，不按 `session.round` 猜测「应该有几轮」。

### 页面行为（`onCopyReview`）

| 情况 | 行为 |
| --- | --- |
| 文本为空 | **不调用** `wx.setClipboardData`；`copyHint` = 「当前会话还没有可复制的内容：至少完成一轮、拿到反馈后再复制。」；toast「没有可复制的内容」 |
| 成功 | `copiedOpen: true`（进 78）、`recordOpen: false`、`copyHint: ''`；toast「练习记录已复制」 |
| 失败 | `copyHint` = 「复制没有成功，剪贴板里没有写入内容。会话仍保留，可以再试一次。」；toast「复制失败，会话已保留」；**不重置 `this.session`**（草稿、反馈、复盘全保留，可再试） |

复制路径只读页面内存，不调用 `wx.cloud.callFunction`，不写任何存储；测试断言 `calls.cloud === 0`。

## 测试

`tests/ui-v2-c-defense.test.cjs`，14 项：

1. 空会话：视图 `empty`、文本 `''`
2. 三轮完成：逐轮含「问题 / 你的回答 / 材料反馈」三段，且反馈段在原答段之后
3. 只完成 1 轮：第 2/3 轮的问题与回答都不出现
4. pending 态（有回答无反馈）：该轮不出现
5. 重答后：含「重答 · 沿用第 3 轮问题」「你的重答」「重答反馈」，且三轮本身不被顶掉
6. 原答逐字：含换行与连续空格的原答逐字出现
7. 复盘：只纳入有反馈的行，编号连续；未完成行不出现
8. 空会话复制：`setClipboardData` 调用次数 0，会话不变
9. 三轮后复制：剪贴板里 `你的回答：\n<session 原答>` 逐字相等，进入 78 态，云端 0 次、存储写入 0 次
10. 复制失败：`fail` 分支确实被走到，会话 JSON 前后一致，可重试成功
11. 78「继续留在练习中」只关 `copiedOpen`，会话与反馈都还在，不弹退出确认、不返回
12. 退出确认：取消时会话原样保留且提示文案含「清空」；确认后会话清空、`recordOpen` 复位、`navigateBack` 1 次
13. 记录页开关不改会话（4 轮含重答），不触发云端
14. WXML 含 77/78 文案与边界说明，无「可以获得职业能力等级 / 通过率」

## 实测结果（共享 dist，经 `scripts/ui-v2-c-run.cjs` 串行构建）

```
node scripts/ui-v2-c-run.cjs --wait 300 \
  tests/lingnan-ui.test.cjs tests/defense-wiring.test.cjs tests/defense-g0.test.cjs \
  tests/defense-g1.test.cjs tests/defense-g3.test.cjs tests/defense-cloud.test.cjs \
  tests/defense-timeout.test.cjs tests/wxss.test.cjs tests/ui-v2-c-defense.test.cjs
```

构建成功（部门动态语料 5 个组织、升学语料 4 份 25 段、答辩材料 2 份 3050 字注入完成），测试结果：

```
tests 90
pass  90
fail   0
skipped 0
```

其中 `tests/ui-v2-c-defense.test.cjs` 为 14 / 14 全绿；`tests/lingnan-ui.test.cjs` 7 项、`defense-wiring` / `g0` / `g1` / `g3` / `cloud` / `timeout` 与 `wxss` 两项均通过（含 `@import` 后 WXSS 无中文、令牌回退值逐字一致）。

`npx tsc --noEmit`：退出码 0，无输出。

## 未解决项与风险

1. **共享 dist 构建期曾被他人的在写文件阻塞**：`pages/goals/index.ts`（`GoalDay.goalName`）与 `pages/goals/plan/index.ts`（8×TS7006 + `coursesKnown` TS2339）在收尾期一度让 `tsc`（`noEmitOnError: true`）失败、`c-run` 无法构建；等 c-plan 修完后重跑，上表数字即为解锁后的正式结果。
2. `scripts/ui-v2-c-capture.cjs`（Lead 负责）里 77/78 场景需按本实现的 `recordOpen` / `copiedOpen` 布尔与 `recordView` 结构设置；已把字段约定回报 Lead，未改该脚本。
3. `wx.setClipboardData` 的 `fail` 分支在真机才会触发；测试用桩覆盖，真机行为待原生验证。
4. 77 记录页渲染依赖 `onOpenRecord()` 先算 `recordView`；若外部只 `setData({recordOpen:true})` 而不走该方法，会显示「还没有可复制的内容」空态（by design，避免臆造内容）。
