# 部门与升学新题首评（2026-10-30）

状态：三轮首次采集与1200-token诊断已实际完成，均保留第一次结果。以下是执行者逐题来源核对，不是独立人类评审。首个冻结归档提交因新文件尚未加入索引而被文档检查拦下；题面、来源与哈希已在部门请求前写定，采集器留存哈希，不声称该Git提交早于首个请求。E题则已随`4a671fd`在任何1200-token真实结果前归档。

- [部门14题](department-questions.json)与[来源快照](department-source.json)。
- [升学14题](advancement-questions.json)：10事实、4守门，使用[冻结来源](advancement-source.json)。
- [事前冻结摘要](frozen-manifest.json)与[有界续办登记](authorization.md)。

原始失败和此前NO-GO保留。本轮是维护者设计的新问法首评，执行者知晓实现；不称独立人类审查、真实学生验证或新资料泛化。未执行、原文降级和模型成功分别记录；升学≤8秒与事实正确独立判定。

## 实际结果

| 轮次 | 首次结果 | 结论与证据 |
| --- | --- | --- |
| 部门S，14题 | 14请求均返回；完整有据回应9/14，缺失说明5/8，两次客户端误拦 | NO-GO；[原始结果](department-first.json)、[逐题核对](department-review.json) |
| 升学D，600-token，10事实/4守门 | 模型有据答全6/10、降级4、守门4/4；8秒内0/10 | NO-GO；[原始结果](advancement-first.json)、[来源核对](advancement-review.json) |
| D旧截断题，1200-token诊断 | d07/d09/d10均恢复正文，来源核对3/3；端到端约11.4–16.2秒 | 仅回归；[记录](advancement-1200-diagnostic.json)、[核对](diagnostic-review.json) |
| 升学E，1200-token，10事实/4守门 | 实际8次模型请求，7/10有据答全，1次审核拒绝降级，2题本地误澄清未调用；守门4/4；8秒内0/8 | NO-GO；[E题](advancement-questions-e.json)、[原始结果](advancement-e-first.json)、[来源核对](advancement-e-review.json) |

E本地预检的检索/意图问题原样保留，没有为提高得分改题；e06仅在模型调用前纠正了“执行时间/未完成”与原文合格要求不符的题面，见[事前更正记录](e-authoring-history.json)。D与E不是相同题的对照实验，不能把6/10和7/10当成受控提升幅度。

S原始回答随后用于修复“覆盖校区”标签、长否定句误拦和标题缺失说明。73项相关回归通过，已有真实模型原文的[修后回放](department-client-regression.json)及[原生客户端回放](../ai-resume-2026-10-30/client-replay.json)通过，0次新模型调用；s05动态检索混入其他组织且漏条仍保留。S/D之后只作回归，[生命周期](evaluation-lifecycle.json)与所有首评原件保留；修补不将原始NO-GO改成通过。

每批使用独立用量起点及保守子预算，没有新增费用未知；模型费用与含审核的月账本增量分别记录。最后[实读额度](usage-final.json)为53/60、剩余7次。没有重置或上调额度，没有改变第三方审核或模型配置。原始历史未知费用仍未知。
