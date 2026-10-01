# G3 最小纵向实现（项目讲解与答辩练习）

- 对应 [Issue #114](https://github.com/Iskuyal/wx-match/issues/114)；前置 [Issue #113](https://github.com/Iskuyal/wx-match/issues/113) 的设计与契约已定稿（见 [docs/design/project-defense/](../../design/project-defense/README.md)）。
- 分支：`codex/project-defense-g3`（基于 G2 定稿分支）。基线 `main` = `925cc65`。
- **状态（如实）**：**本地实现完成、构建与全量测试通过**。**未部署云函数、未真机、本阶段未发起任何真实模型调用**——因此这里没有「真实效果」证据，效果属于 G4。

## 交付物

| 文件 | 作用 |
| --- | --- |
| `miniprogram/services/defense/index.ts` | 客户端契约与状态机：事件组装（**只发 `materialId`，不发 `system`/材料正文**）、四节完整性校验、失败文案映射、轮次/重答/失败不改轮次、`resetSession` 清空会话 |
| `miniprogram/pages/defense/index.{ts,wxml,wxss,json}` | 八个状态同页切换：材料 → 三轮作答 → 等待/取消 → 四节反馈 → 复盘 → 重答 → 结束 / 失败 |
| `miniprogram/pages/home/index.{wxml,ts}` + `miniprogram/app.json` | 首页整宽次级入口（G2 定稿的 A 形态）与页面注册 |
| `cloudfunctions/ai/defense.ts` | 服务端契约：**固定纪律提示词**（逐字取自 G1 PoC 的 `DISCIPLINE`）、材料加载、四节与引用编号校验 |
| `cloudfunctions/ai/index.ts` | 接线：`feature=project-defense` 时按 `materialId` 取服务端材料、**覆盖**客户端 `system`；模型返回后校验不过则 `citation_unverified`，**不返回正文**（+44 行纯插入，未改既有分支） |
| `scripts/lib/generate-defense-materials.cjs` + `scripts/build.mjs` | 构建时把 G0 **冻结件**的正文生成 `dist/cloudfunctions/ai/defense-materials.js` |
| `tests/defense-g3.test.cjs`、`tests/defense-cloud.test.cjs` | 契约、状态机、页面冒烟、冻结件漂移守卫、服务端校验（共 28 项） |

## 谁守什么（与 G2 契约一一对应）

1. **纪律**：`cloudfunctions/ai/defense.ts` 的 `DEFENSE_DISCIPLINE` 是服务端常量；客户端事件的 `system` 一律被覆盖，材料只作为「被引用的资料」拼在纪律之后。→ 对应契约「业务纪律在服务端固定，用户材料不能覆盖系统规则」。
2. **材料**：客户端只发 `materialId`；正文由服务端从**构建产物**（源自 G0 冻结件）取，缺文件或 id 查不到按 `internal` / `invalid_request` **fail-closed**。→ 对应「引用核对是对当前材料做的」，客户端自带材料无效。
3. **结构**：四节标题缺一或顺序错 → 服务端 `citation_unverified` 不返回正文；**客户端再守一道**，不合格的正文一个字都不上屏（bug 修复记录见下）。
4. **引用**：服务端用 `defenseMaterialIds()` 从材料正文抽编号，回答里出现材料中没有的编号即拒绝。
5. **失败**：页面按 `failureClass` 映射**本页**文案，不改全局 `AI_MSG_*`；模型不可用/超时明确写成「你的回答没有被判定」，不写成学生没讲清楚；失败**保留已写内容**且**不显示上一轮反馈**。
6. **数据**：会话只在页面内存；`onUnload` 与退出都调 `resetSession()`；云端只走既有用量记账，**不写材料或回答正文**。

## 验证（本机实跑）

| 命令 | 结果 |
| --- | --- |
| `npm run build` | 通过；输出含「答辩练习材料已注入 ai 云函数（2 份、3050 字，正文逐字取自 G0 冻结件）」 |
| `npm run typecheck` | 通过（小程序与云函数两套 `tsc --noEmit`） |
| `npm test` | **713 / 713 通过、0 失败**（基线 685 + 本阶段新增 28） |
| `node --test tests/defense-g3.test.cjs tests/defense-cloud.test.cjs` | 28 / 28 |
| `npm run docs:check` | 130 个 Markdown、880 个引用、0 错误 |
| `git diff --check` | 无输出 |

其中与「状态与安全边界」直接相关的用例：四节不齐→失败态且**不上屏**；失败**不推进轮次、不写反馈**；失败后**拿不到旧反馈**；取消**保留草稿**且迟到结果不上屏；退出清空会话；回答过短**不发云调用**；额度用尽**不显示成可重试**；服务端对缺节、顺序错、未知编号（`F99`）分别拒绝；客户端与服务端 feature 名一致；材料正文与 G0 冻结件**逐字一致**（漂移守卫）。

## 实现中发现并修掉的两个问题（如实记录）

1. **页面会把半截反馈上屏**：`ask()` 最初无论校验是否通过都 `parseSections(text)`，导致四节不齐时仍把残片渲染出来——正是 G1 首评截断事故的形态。**测试抓到**（断言失败态 `sections` 为空），已改为不合格时清空并只显示「缺了哪几节」。
2. **WXSS 令牌回退值不一致**：`rgba(214, 160, 90, 0.55)` 与 `app.wxss` 的 `rgba(214,160,90,0.55)` 差空格，被既有 `tests/wxss.test.cjs` 拦下，已按定义逐字对齐。

## 已知缺口（不隐藏）

1. **未部署**：`ai` 云函数的这次改动要重新部署才生效；部署属负责人动作，本阶段未做，**线上仍是旧行为**。
2. **未真机、未真实模型调用**：本阶段只做本地契约与页面；真实调用、内容安全开销与逐例判定属于 G4。
3. **文案作用域**：服务端 `citation_unverified` 的默认文案仍是升学问答口径（「已改为展示检索到的原文摘录」）；按 G2 定稿第 5 项，答辩练习页面自己映射文案，所以学生看不到那句，但云函数日志/其他调用方看到的仍是原句。若要在服务端区分，需另开票。
4. **空回答口径差异**：服务端 `empty_answer` 按 `trim() === ''` 判，PoC 的 `AX-1` 样例（只有标点）不会被判空；客户端有 20 字下限，页面路径上到不了这条分支。差异已记录，未擅自扩大服务端判据。
5. **语义错误仍靠人工**：编号存在不等于说法正确；「把待验证说成已完成」这类越界断言本阶段**没有**自动判定，仍按 rubric 人工判读。

## 不得据此声称

- 新功能已上线或已部署；真实学生效果、教师认可、通过率或职业等级已达标；
- 引用核对已 100%（那是 G1 首评对 8 个自编样例的结论，不是本实现的在线保证）；
- 真机可用、时延达标（G1 实测每次 12–23 秒，属 G3 的降级设计输入）。
