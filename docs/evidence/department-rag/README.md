# 部门动态 RAG 证据（feat/department-activity-rag，Ticket 10 先行落地）

实测日期：2026-09-26 ｜ 状态：检索结构已落地并验证召回；**达标线重测待云端执行**（需要模型密钥）。

设计决策见 [ADR-0002](../../adr/0002-department-activity-rag.md)，题集与判定口径见本目录 [questions.json](questions.json)。

## 一、检索命中评测（离线，不调模型）

`npm run eval:department-rag recall`（或 `node scripts/eval-department-rag.cjs recall`）：

动态题 5 题，用与云函数**同一套** bigram 检索跑 top-5，对照题集 `expectedUrl`：

| 指标 | 结果 |
| --- | --- |
| recall@1 | **4 / 5** |
| recall@3 | **5 / 5** |
| recall@5 | **5 / 5** |

逐题明细（rank 为预期来源在 top-5 中的位置）：

| 题 | rank | 首条候选 |
| --- | --- | --- |
| 校学生会最近有什么动态？ | 1 | 第十四次学生代表大会顺利召开 ✅ |
| 校学生团委的青马工程培训班公示讲的是什么？ | 1 | 青马工程学员推荐名单公示 ✅ |
| 学生社团进社区活动办到第几期了？ | 2 | 第二期圆满落幕（第三期第 2 位） |
| 2026 清远马拉松赛志愿服务总结大会是哪个组织办的？ | 1 | 清远马拉松志愿服务复盘总结大会 ✅ |
| 校学生会办过校园提案大赛吗？ | 1 | 第四届校园提案大赛圆满结束 ✅ |

原始明细：`artifacts/department-rag/recall.json`（该目录已 gitignore）。

## 二、达标线重测（调模型，待云端执行）

口径沿用部门问答达标线：**问答 10 题 ≥80%、防幻觉 100%**（编造一次即不达标），另加**引用正确性**（回答引用的动态必须在返回的 `citations` 里）。

前置与步骤：

```powershell
# 1) 环境变量与 ai 云函数同一套配置
$env:AI_BASE_URL = '<中转地址>'; $env:AI_API_KEY = '<密钥>'; $env:AI_MODEL = '<模型名>'
# 2) 跑 10 题（基础 5 + 动态 5），逐题记录答案、命中来源、耗时与成本
npm run eval:department-rag answer
# 明细：artifacts/department-rag/answers.json
```

脚本不自动打分：有据 / 没查到 / 编造与引用是否支持答案需**人工逐题核对**（与 rag-poc 同一口径）。跑完后把结论与原始记录回填本文件。

## 三、范围边界（诚实声明）

- 检索对象是**标题级**的动态条目（title / publishedAt / sourceUrl），不是正文段落——官网动态正文普遍极短（Ticket 10 PoC 实测六成不足 200 字），首版先立结构。
- 基础信息（简介、下设、校区、联系方式）仍随客户端语料全量携带，不受检索影响。
- 检索是词面重合打分：语义相近但零字面重合的问题命不中，命中不了时模型按纪律回答「官网未公布」。
