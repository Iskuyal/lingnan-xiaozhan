# 内容安全检测窗口复现证据（2026-09-27）

对应 [内容安全审计报告](../../review/content-safety-audit-2026-09-27.md)。代码基线 `main` @ `4e3c8d7`。

## 怎么跑

```bash
npm run build
node docs/evidence/content-safety-audit-2026-09-27/probe-moderation-window.cjs
```

必须在**仓库根目录**运行：夹具（`tests/ai-harness.cjs`）按相对路径读 `dist/cloudfunctions/ai`，也就是先构建出的编译产物。脚本不访问网络、不需要密钥，桩数据只有「好」字与一个占位标记 `【违规标记】`，不含任何真实用户内容。

## 实测输出（2026-09-27）

```text
===== 探针 1：输入侧 =====
请求 ok = true ｜failureClass = ""
safety.checked = false
msgSecCheck 调用次数 = 11 ｜累计送检字符 = 20002
  检测过的文本里出现标记 = false
  送模型的请求体里出现标记 = true
  请求携带字符数 = 40000 ｜未检测却进了模型的字符数 = 19998

===== 探针 2：输出侧（chat） =====
请求 ok = true ｜failureClass = ""
safety.checked = false
msgSecCheck 调用次数 = 11（含输入的 1 次）
  检测过的文本里出现标记 = false
  返回给客户端的 text 里出现标记 = true
  返回给客户端的 text 长度 = 25006 ｜未检测字符数 = 5001
  warnings = ["内容安全检测未完整执行（checked=false）：wechat｜security.msgSecCheck｜checked=false｜v2（scene=1）｜errcode=0｜文本共 25006 字，仅检测了前 20000 字（超过 2000×10 字上限的部分未检测）"]

===== 探针 3：输出侧（vision 分带） =====
请求 ok = true ｜failureClass = ""
模型调用次数 = 6 ｜msgSecCheck 次数 = 11 ｜累计送检字符 = 20006
合并输出长度 = 30737 ｜未检测字符数 = 10731
  合并输出里出现标记 = true
  safety.checked = false
```

## 每个探针证明了什么

| 探针 | 构造 | 证明了 |
| --- | --- | --- |
| 1 输入侧 | 5 条 8000 字消息共 4 万字，标记放在**最后一条末尾** | 只有前 2 万字送检；标记从未送检却出现在模型请求体里；请求成功。对应 CT-01 |
| 2 输出侧 chat | 桩让模型返回 2.5 万字，标记在末尾 | 尾部 5001 字未经检测就经 `result.text` 返回客户端。对应 CT-02 |
| 3 输出侧 vision | 6 带各 20 门课，标记在最后一门课名里 | 分带合并输出 30737 字，尾部 10731 字未检测即返回。分带是 Ticket 05 的默认路径，证明 CT-02 在真实链路上可达 |

## 证据边界

- 桩决定的内容是「超长文本」，**不是真实违规内容**：本证据证明的是「窗口外的文本不会被送检、也不会被拦截」，不是「某个具体违规样本能通过微信检测」。
- 探针 3 的 20 门课/带是放大构造。真实截图不会产出这么多课，因此它证明的是**可达性上限与缺口的性质**，不是「线上每次识别都会溢出」；线上是否溢出取决于模型实际输出长度。
- 探针 2 的模型输出长度由桩指定，不受 `AI_MAX_TOKENS` 约束。真实 `chat` 路径要溢出，需要以 ASCII 为主的长输出（8192 token × 约 4 字符/token），报告里按**估算**标注。
- 微信侧判定行为（含分片无重叠带来的跨片拼接，CT-05）未实测；云端环境变量的实际值（`AI_SAFETY_PROVIDER` / `AI_SAFETY_FAIL_MODE` / `AI_MODERATE_OUTPUT`）仓库里读不到，未纳入本次证据。
