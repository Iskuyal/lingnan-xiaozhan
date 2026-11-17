# 2026-10-23 参赛候选收尾记录

**重启后复跑结果**：本轮原生模拟器离线交互10/10通过，30张截图已归档。基础库3.17.2、iPhone 12/13 (Pro)模拟器、逻辑视口390×753；详见[机器结果](native-after-restart/report.json)。已查看首页、周课表、导入校对与三轮复盘截图。云函数/数据库/上传/本机存储接管为内存夹具，真实业务AI调用0次；窗口几何已恢复。先前启动和RPC失败仍保留，下表模拟器blocked项仅指初轮。

画面：[首页](native-after-restart/01-home.png) · [周课表](native-after-restart/02-timetable.png) · [导入校对](native-after-restart/09b-import-review.png) · [材料查阅](native-after-restart/22-defense-reader.png) · [复盘](native-after-restart/24-defense-review.png) · [重答](native-after-restart/25-defense-reanswer.png)。

源码候选：`e389e6aa142512d38ed445c8ab379a3ac37b4f4a`。负责人要求按收尾检查执行；正式名仍未定。材料在 `codex/competition-closeout-20261023` 整理，源码验证用 `.worktrees/competition-verify-20261023` 的 detached checkout，不混入原工作区修改，不改业务代码、冻结题、模型/审核/额度配置。

## 本轮实际完成

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 根依赖干净安装 | passed | `npm ci --ignore-scripts` |
| 类型检查 | passed | `npm run typecheck`，含小程序与云函数 |
| 完整仓库回归 | passed | `npm test`：767通过、0失败、0跳过；不调用真实业务模型 |
| 四份锁文件审计 | passed | 根/ai/timetable/newsSync均0漏洞，三个云函数也分别干净安装；不证明云端运行依赖已更新 |
| 新版源码审查ZIP | passed | 257个源文件，CRC及禁止路径检查通过；排除整个tests与真实课表夹具，非正式参赛包 |
| 源码审查ZIP干净解压复现 | passed | 新目录 `npm ci --ignore-scripts` → typecheck → build全部成功；不在这个无tests子包声称完整回归 |
| 新模拟器UI回归 | blocked | 新worktree的CLI auto两次报`skeletonCache/EEXIST`，reset-fileutils未解除；原项目重建后第三次auto开启9420端口，但自动化RPC持续无响应，停止本次脚本；业务检查未开始、无新截图 |
| 真机 | not_run | 本轮adb列表无设备；未取得Android新UI真机证据，也未取得iOS证据 |
| 真实业务AI与云部署 | not_run | 旧4条空响应费用核账及预算决定未解除；本轮无计费业务AI请求、无部署、无生产课程写入 |
| 材料与任务同步 | 已完成起草 | 新七项候选稿、演示脚本、回归步骤、执行卡及Ticket 12逐项依据；不是人类验收或赛事提交 |

机器摘要见[validation.json](validation.json)。原始安装/测试/CLI失败日志及本地输出保存在被忽略的 `artifacts/competition-closeout-2026-10-23/`，不把个人缓存路径与未脱敏原始数据复制到本记录。

源码审查ZIP：809002字节，SHA256 `8e8186d7a6f826e83e920ca6046964952332d808233b7b84ccc55270883fc6a7`。它由固定commit检出的工作区文件生成，逐文件记录实际字节哈希；Windows换行由清单绑定，不把工作区字节误称Git blob原字节。原有2026-10-03包不覆盖。

## 内部候选材料

**本轮只读云包回读**：[cloud-readback.json](cloud-readback.json)记录ai/timetable/newsSync下载副本与候选构建的根文件哈希。唯一根文件差异均为package-lock.json；其余分别21/21、6/6、7/7一致。三份远端锁文件记录follow-redirects 1.16.0，下载包的node_modules实际包版本为1.16.1。保留该不一致，不直接断言线上仍运行旧版，也不关闭锁文件同步。本轮未部署、未触发定时任务或业务模型；下载原包含依赖，仅留私有artifacts，不放进参赛ZIP。

2026-10-23续办补充：[技术附录](https://github.com/Iskuyal/lingnan-xiaozhan/blob/864565f16691f0117b69b268433e1a998665b123/docs/competition/technical-appendix-2026-10-23.md)已补系统/页面结构图、16条在用路由与4段固定commit代码讲解；[包内运行配置说明](https://github.com/Iskuyal/lingnan-xiaozhan/blob/864565f16691f0117b69b268433e1a998665b123/docs/competition/runbook-candidate-2026-10-23.md)已补安装、AppID/云环境、三条函数、集合权限、AI配置名称及失败排查。两张1200px文档图渲染无横向溢出并已查看。页面数据取自app.json及各页JSON，代码节选逐字来自e389e6a；没有改变业务代码。新候选将本轮30张原生离线截图全量收录，保留r4及此前包，不附旧动画充当最终视频。

- [七项作品说明](https://github.com/Iskuyal/lingnan-xiaozhan/blob/864565f16691f0117b69b268433e1a998665b123/docs/competition/submission-candidate-2026-10-23.md)：新UI、能力/部署/效果边界、具体流程比较、来源许可与后续计划。
- [演示脚本](https://github.com/Iskuyal/lingnan-xiaozhan/blob/864565f16691f0117b69b268433e1a998665b123/docs/competition/demo-script-2026-10-23.md)：以截图识别/课表助手业务主线说明AI价值，计划镜头未当作录制成果。
- [回归与录屏步骤](../../testing/submission-rehearsal-2026-10-23.md)：取消、确认、失败恢复、设备/云版与原始结果字段。
- [收尾执行卡](../../tasks/closeout-2026-10-23.md)：按Ticket 09跟踪，并保留人工及真实调用停止关口。

内部候选包生成后，CRC、路径过滤、源码一致性、全文件哈希、文件名、大小及清单见本机同名 `.check.json`；包会明确 `formalSubmission:false`。源码采用上述固定commit，新增材料按包内清单独立绑定；r3及之前的UI截图为10-17离线样例；重启后的新候选改附10-23原生离线截图，仍不冒充真机或真实模型。最终真实视频、正式名称及学校回执未补齐前不按正式赛事文件命名或上报。

首份内部候选ZIP已生成并通过CRC、禁止路径、全部文件哈希与Markdown本地链接目标检查；约1.39MB，含257个源码文件及8张历史离线截图，不含最终视频或完整测试夹具。后续候选保留原源码与材料结构，补记第三次CLI尝试及RPC阻断，明确包外校验报告的位置；先前包与失败日志保留不覆盖。最终候选的独立检查见[package-check.json](package-check.json)，该报告不放入被校验ZIP，避免自引用哈希。

原项目构建输出的147个非云函数文件与独立候选对照，仅一份WXML有CRLF/LF差异，归一化后相同。构建前已备份原工作区reader-data.ts，构建后按原字节恢复。尝试用`screenshot`技能截取本项目窗口作诊断，得到黑色小图，不能用于界面判断或验收，未放入候选包。

## 保留未完成

正式名、报名字段受控填入、具体交接登记、往届成果及其他内容许可；旧费用核账与预算决定、新独立模型评测；原始人工验收记录、答辩人类二审；新版真实云端/真机/窄屏与最终视频；运行依赖核对和必要部署；最终ZIP审核、学校上报及成功回执。

报名/C组/队伍、负责人掌握校内节点、A1–C1与归属测试通过、具体校徽许可均沿用既有确认，不改为未执行。原票与失败记录保留，不关闭阶段Issue，不把当前工作区成果说成已提交/合入main。
