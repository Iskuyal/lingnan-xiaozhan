# ai-news-poc · 一次性验证脚本

> **这不是产品代码，是一次性的可行性验证脚本。**
> 结论见上级文档 [`../ai-news-poc.md`](../ai-news-poc.md)。
> 保留在此仅为**可复现的证据**（primary source），**不建议合并进 main**。

## 文件

| 文件 | 作用 |
|---|---|
| `fetch-news.cjs` | 抓取官网真实资讯。**解析逻辑直接 require 项目自身的编译产物** `dist/cloudfunctions/newsSync/parse.js`，保证与被测对象同源 |
| `smoke-test.cjs` | 冒烟测试：单次调用，确认 Key / baseUrl / 模型名正确，避免 40 次调用后才发现参数错误 |
| `poc-ai-news.cjs` | 主体：5 项能力 × 8 篇 + 3 个跨全库问答，逐次记录 token 与耗时 |
| `analyze.cjs` | 统计：解析成功率、各测试项 token 分布、字段完整度、规模换算 |
| `config.json` | 接口地址与模型名 |
| `results.json` | **实测原始数据**（43 次调用的逐条记录），结论即由此得出 |

## 运行前准备

1. 需要模型 API Key。在**本目录**下新建 `key.txt`，粘贴 Key（一行，勿加引号）：

   ```
   sk-xxxxxxxx
   ```

   > ⚠️ `key.txt` 已被本目录的 `.gitignore` 忽略。**永远不要把 Key 提交进版本库**——一旦提交，即使后续删除，它仍会永久留在 git 历史中。

2. `fetch-news.cjs` 依赖项目已构建（需要 `dist/cloudfunctions/newsSync/parse.js` 存在）：

   ```powershell
   npm run build
   ```

3. 脚本内写死了项目路径 `D:/DSH/wx-match/dist/...`。换机器运行时需修改 `fetch-news.cjs` 顶部的 `PARSE_PATH`。

## 运行

```powershell
node fetch-news.cjs      # 1. 抓数据，产出 data/news.json
node smoke-test.cjs      # 2. 冒烟测试
node poc-ai-news.cjs     # 3. 跑全套，产出 data/results.json
node analyze.cjs         # 4. 统计
```

## 注意事项

- 学校官网限速约 **1 请求/秒**，`fetch-news.cjs` 已内置 1.3 秒间隔，请勿调小。
- `config.json` 中的 `delayMs` 用于规避模型侧限流，免费层尤其需要。
- 换模型只需改 `config.json` 的 `baseUrl` 与 `model`（兼容任何 OpenAI 格式接口）。
- **`deepseek-flash` 默认开启思考模式**，这是本轮输出 token 偏高的直接原因（见结论文档 3.3 第 3 条）。若要复测成本，注意此项。
- `data/news.json`（抓取的官网正文全文）已被 `.gitignore` 忽略，不入库。
