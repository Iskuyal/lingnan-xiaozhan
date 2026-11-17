# 岭南小栈

面向广东岭南职业技术学院学生的微信原生校园助手。导入并核对自己的课表后，可以查看今天与每周安排、核对调课通知，并围绕目标安排学习；校园资讯和问答保留资料出处。

**Inlux 团队 · 第九届传智杯 AI 微信小程序赛道 · C 组 · 3 人团队**

## 当前交付

最新代码已通过 [PR #152](https://github.com/Iskuyal/lingnan-xiaozhan/pull/152) 合入 `main`，包括岭南红四 tab、限定周次调课、AI 约束核对与学习计划、本机练习记录复制及集成审查修补。

- [最新参赛材料](docs/competition/submission-latest/README.md)：可编辑 Word、PDF、体验说明、演示与包校验。
- [集成审查与修补](docs/review/lingnan-ui-integration-2026-11-14.md)：旧提案、迟到回复、写入锁、规则换排及导航等问题的复现与处理。
- [本机及原生验证](docs/evidence/lingnan-ui-implementation/integration-2026-11-14/README.md)：1025 项回归，A 14 项、B 12 项、C 31 场景、目标日 9 项及跨模块 10 项检查。
- [版本与参赛包](https://github.com/Iskuyal/lingnan-xiaozhan/releases)：本次包以 Release 草稿准备，未代为提交赛事。

本次提交只收录负责人提供并确认的最新视频，未重新审查内容或转码。三份Word/PDF、源码、虚构输入和逐文件校验随包，旧预提交材料不再作为交付入口。

## 四个主入口

| 入口 | 可以完成的任务 |
| --- | --- |
| 今天 | 下一节课、今日安排与已保存计划；未填作息、无课表、今日无课和读取失败分别提示 |
| 课表 | Excel或截图导入、逐条校对、周和日视图、课程维护、AI提案和限定周次调课 |
| 学习 | 目标日、AI约束核对与规则排程、本机计划、项目讲解练习、升学问答及体测参考 |
| 校园 | 有来源的学校、学生部门及资讯，资料缺失时如实说明 |

课表由学生自行导入，不接收教务账号密码。课程修改先展示提案并等待确认；限定周次变更保留其他周次，支持整项撤销。学习计划只存本机，与正式课程分开展示。失物招领仍暂缓。

## AI如何进入业务

截图识别把图片转为可校对的课程草稿；课表助手查询课程或生成变更提案；部门问答在已收录资料和动态内回答并展示出处。学习计划先由模型整理带原话的约束，学生核对后交给规则排程，换排、保存和重开不重复调用模型。升学问答与答辩练习保留资料范围和评价边界，不作资格或能力保证。

今日简报、倒计时、校历和体测计算属于规则工具；使用AI编程工具也不计作产品内AI能力。历史独立质量与8秒门槛、320独立复跑及部分平台交互仍有未通过或未覆盖项，见[状态](docs/status.md)和[待办](docs/tasks/pending.md)。

## 本地运行

需要Node.js 22或以上、npm和微信开发者工具，CI使用Node.js 24。

```powershell
git clone https://github.com/Iskuyal/lingnan-xiaozhan.git
cd lingnan-xiaozhan
npm ci
npm run typecheck
npm test
npm run docs:check
```

`npm test`先构建再测试。只构建时运行`npm run build`，随后在开发者工具导入`dist/`；不要在生成目录存放手工改动。本地构建不会部署云函数。

团队AppID、云资源和账号权限需要按实际配置。模型密钥只放服务端环境变量。详细步骤见[本地开发](docs/development/local-setup.md)、[云开发手册](docs/development/cloud/README.md)和[数据使用说明](docs/product/data-usage.md)。参赛源码子包排除真实课表夹具和完整tests，其安装及构建范围单独说明，不能宣称包内复现全部1025项测试。

## 结构与协作

```text
miniprogram/       原生页面与功能服务
cloudfunctions/    ai timetable newsSync 云函数
scripts/           构建 验证及维护工具
tests/             仓库回归与导入样本
docs/              规格 设计 决策 证据及参赛材料
```

开发前读取[AGENTS.md](AGENTS.md)、[规格](docs/product/spec.md)与[ADR](docs/adr/README.md)。界面调整先按[设计约定](docs/design/README.md)评审图稿。文档入口见[docs/README.md](docs/README.md)。

旧Issues按负责人要求归档，未完成事项保留在待办中；新增任务按明确范围建票。后续使用短期分支和PR，合入main后清理。历史r1至r3材料保留原版本，不覆盖为本轮成果。
