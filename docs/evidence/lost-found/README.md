# 失物招领 · 阶段证据（feat/lost-found，代码已随 [PR #76](https://github.com/Iskuyal/wx-match/pull/76) 合入 `main`；原始明细存本地未推送）

状态：**LF-3 非 AI 基线已实现并验证；LF-4 AI 原型未开始（待决策关卡 D1–D3 与许可样本）**。
框架与完成定义见 [lost-found-framework.md](../../tasks/lost-found-framework.md)，领域口径见 [domain/lost-found.md](../../domain/lost-found.md)，设计图见 [design/lost-found/](../../design/lost-found/)（待评审定稿）。

## 一、LF-3 已交付与验证（2026-09-27）

| 产物 | 内容 | 验证 |
| --- | --- | --- |
| 云函数 `cloudfunctions/lost-found/` | 帖子/私密特征隔离、认领与交接、规则召回、审计;动作分发入口,openid 只取可信上下文 | `npm run typecheck` 0;`npm test` **476 项全过**(新增 28 项:校验/状态机/安全 16 项、流程 12 项) |
| 小程序端 | 5 页面(index/publish/detail/claim/mine)+ services/lost-found + 首页入口卡片 | 开发者工具加载后冒烟:首页渲染、发布入口与类型切换正常;云函数未部署时列表降级不白屏 |
| 评测集与脚本 | `tests/fixtures/lost-found/eval-set.json`(合成分组)+ `scripts/eval-lost-found.cjs` | recall 模式离线跑通,结果见下 |
| 设计图 | `docs/design/lost-found/` 12 屏 HTML + PNG | 渲染脚本全过;**评审待拍板** |

### 规则召回评测(合成样例,`node scripts/eval-lost-found.cjs recall`)

| 指标 | 结果 | 说明 |
| --- | --- | --- |
| Recall@1 / @3 | 2/4、**3/4** | 4 个可答题(pair×2、distractor、negative) |
| 负样本漏入 | **0** | 类别/地点冲突的帖子被规则过滤拦下 |
| 干扰项命中 | 1/1 | **规则阶段无法区分同区域同类的不同物品**——distractor 与 expected 词面相同,这正是 AI 重排要解决的差距,如实记录 |
| 安全样本 | 入库被校验拦截 | 「含手机号 + 提示词注入」样例在 createPost 校验被拒,符合预期 |

原始明细:`artifacts/lost-found/recall.json`(已 gitignore)。

## 二、决策关卡状态(框架第 3 节,均待负责人)

- **D1(与三个 AI 落点的关系)**:本分支按框架建议的 **C(独立验证原型)** 推进——合成分组、不接真实用户、不承诺上线范围;是否定为第四落点/替换现有落点仍待决定。
- **D2(首版数据来源)**:许可样本的授权范围、授权时间与删除方式待定;合成分组不得用于正式评测与演示材料。
- **D3(成本与阈值)**:候选数 K、召回率/误匹配率/延迟/失败率阈值、图片压缩规格与月度预算**全部待定**,不以模拟结果替代实测结论。

## 三、LF-4 及之后的待办

1. 决策关卡 D1–D3 由负责人拍板并同步权威范围文档;
2. 设计图评审定稿(README 列有 5 个待拍板项:默认页签、类别枚举、时间/地点粒度、入口层级、来源条上限);
3. 许可样本替换评测集合成分组,记录来源与许可;
4. 接入 ai 云函数(feature=`lost-found-match`)做多模态重排:结构化相符点/冲突点/不确定性 + JSON Schema 校验 + 候选 ID 白名单 + 私密特征泄漏检查;
5. 云端部署 lost-found 云函数(安全规则:公开集合只读、私密集合无客户端路径)后跑真机回归;
6. LF-5/LF-6(受控演示、上线准备)按框架第 14 节与完成定义推进。

## 四、诚实声明(参赛材料口径)

- 当前候选是**规则召回**(类别+类型+时间+地点),不是 AI 匹配;界面上已如实标注「未经过 AI 图文比对」。
- 评测集是**合成样例**,没有真实物品或真实用户数据;任何指标都不得写进参赛材料充当实测。
- 图片上传、举报处理链路、数据删除保留策略在原型阶段未实现(框架 LF-5/LF-6 范围)。
