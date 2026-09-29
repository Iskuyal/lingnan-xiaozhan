# Domain docs

采用 single-context：根目录 `CONTEXT.md` 保存领域术语，`docs/product/spec.md` 保存产品范围，`docs/adr/` 保存已确认的架构决策。

## 读取规则

探索代码前读取根目录 `CONTEXT.md`，再读取 `docs/adr/` 中涉及当前工作的决策。
若未来出现 `CONTEXT-MAP.md`，按其中的指针读取相关上下文与局部 ADR；文件不存在时正常继续，无需只为填满目录而创建。

## 消费规则

- Issue、规格、代码和测试使用 `CONTEXT.md` 已定义的术语。
- 新概念需要定义时，说明领域词汇缺口；经确认后更新上下文。
- 方案与 ADR 冲突时，指出具体 ADR 和重新决策理由，避免静默覆盖。
- 尚未确定的产品或技术选择在 `docs/tasks/pending.md` 或对应规划中保留为待定；只有已确认决策才写入 ADR。
