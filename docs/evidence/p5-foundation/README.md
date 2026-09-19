# Ticket 01 端到端冒烟记录（2026-09-19）

`ai` 云函数的首次真实端到端调用：从小程序端发一句测试文本，经内容安全检测、模型调用、用量记账，拿回模型输出。执行人：负责人；执行方式：

```powershell
# 终端 A：打开开发者工具并开启自动化端口（保持窗口开着）
& "D:\微信web开发者工具\cli.bat" auto --project F:\VibeCoding\wx-match\dist --auto-port 9420 --trust-project

# 终端 B：仓库根（不是 dist）
cd /d F:\VibeCoding\wx-match
npm run smoke:ai
```

## 原始输出

```text
> wx-match@0.1.0 smoke:ai
> node scripts/smoke-ai.cjs

ok=true failureClass=(空) elapsedMs=4600
provider=openai model=deepseek/deepseek-v4.1-flash
模型输出：链路已通
内容安全：provider=wechat checked=true passed=true｜v2（scene=1）｜errcode=0｜errmsg=openapi.security.msgSecCheck:ok｜suggest=pass｜label=100
本次用量：105 token / 0.000026 元（estimated=false）
当月累计：18 次 / 0.000026 元（上限 50 元）

记录已写入 artifacts\verify\ai-smoke.json
```

（`artifacts/` 被 gitignore，原始 JSON 不随仓库提交；本段即当次运行的完整输出。）

## 这次证明了什么

| 结论 | 依据 |
| --- | --- |
| 模型调用链路打通（经第三方中转，OpenAI 兼容格式） | `ok=true`、`text=链路已通`、`provider=openai`、`model=deepseek/deepseek-v4.1-flash` |
| **云函数超时已是 20 秒**（人工步骤 C 完成） | `elapsedMs=4600` 而未被 `-504003 ... timed out after 3 seconds` 截断——3 秒超时下这一步会失败 |
| 内容安全走**微信官方**适配器且真的检测过 | `provider=wechat checked=true passed=true`、`errcode=0`、`suggest=pass`；未认证小程序可用云调用 |
| 用量与成本记账可用、累计可查 | 「本次用量」与「当月累计」两项均由云函数写出，上限读数为 50 元 |

## 仍未证明的

- **数据库侧无密钥外泄**：小程序包与云函数产物已由 `tests/ai-bundle.test.cjs` 断言不含密钥；还差在控制台打开 `ai_usage_records` / `ai_usage_monthly` 抽查一次，确认记录里没有密钥字段或值（Ticket 01 未勾选的那一条）。
- **月度上限真的会拦**：人工步骤 F（把 `AI_MONTHLY_CAP_YUAN` 临时改小、跑一次 `chat`、确认返回 `quota_exhausted` 且没有发起模型请求）尚未执行。
- **单价是否与中转实际一致**：本次 105 token 记为 0.000026 元，说明生效的是环境变量里配置的 **0.25 元/百万 token**；这个价格是否等于中转的真实计费仍需联调核对——**单价填低了，50 元上限就会形同虚设**。
- **图片路径（`vision`）与三类失败的降级文案**：本次只跑了文字 `chat`；截图识别（Ticket 05）与部门问答（Ticket 07）的真实调用仍未执行。
- 云函数**内存**未核实（按图片大小另行确认）。
