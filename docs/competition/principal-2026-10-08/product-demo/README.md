# 校园工具：功能、使用过程与最终结果

**当前v7纯代码动画与自然配音，2026-10-04。**[视频](../校园工具-纯代码动画与自然配音-v7.mp4)、[试听](../校园工具-自然配音试听-v7.mp3)、[字幕](../校园工具-纯代码动画与自然配音-v7.srt)与[浏览器源页](index.html)配套。12项功能、234秒，49项演示检查通过。PPT/PDF已按负责人要求冻结为[v6.5 PPT](../校园工具-产品演示优化-v6.5.pptx)及[PDF](../校园工具-产品演示优化-v6.5.pdf)，不再迭代。

[cinema-v7.js](cinema-v7.js)与[cinema-v7.css](cinema-v7.css)增加随实际演示状态更新的操作细节特写：草稿地点逐字修正、周课表变更、AI查询、确认前提案、确认后课程和部门资料。它与手机界面共用数据，保留确认前不写入、取消不改变课表的语义。已有课程时，导入确认明确标为“确认替换课表”。

声音改用`zh-CN-XiaoxiaoNeural`中文女声、-5%语速和自然停顿，不将旁白强行加速以塞进场景。音乐由代码生成76 BPM和弦与拨弦，语音出现时降低至25%。[narrate_v7.py](narrate_v7.py)使用线上Microsoft Edge语音服务，仅发送公开项目文案；[audio_v7.py](audio_v7.py)混音并导出视频、试听与独立SRT。业务AI仍为固定模拟响应，不请求真实业务模型。不能将“业务AI未调用”解释为“语音也未使用线上服务”。语音工具来源：[edge-tts](https://github.com/rany2/edge-tts)，声音名称参考[Microsoft文档](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts)。

## 当前播放与重建

离线播放：直接打开MP4；或保留`product-demo/`与上一级同名v7 MP4的关系，用Chrome打开`product-demo/index.html`。点击播放可同步成片音轨，暂停后可操作主要按钮，支持进度条及功能跳转。字幕需由播放器另行加载，未烧录。

重建环境：Windows、Chrome、FFmpeg、Python及Playwright、NumPy、`edge-tts==7.2.8`。读取本机已启用的回环代理，语音连接使用经过证书验证的TLS 1.2，不关闭证书校验。未缓存语音的生成需要网络；已有且文案、声音、语速与哈希匹配的缓存会复用。安装依赖后，从仓库根目录执行：

```powershell
python -X utf8 docs/competition/principal-2026-10-08/product-demo/render.py --inspect
python -X utf8 docs/competition/principal-2026-10-08/product-demo/render.py
python -X utf8 docs/competition/principal-2026-10-08/product-demo/narrate_v7.py
python -X utf8 docs/competition/principal-2026-10-08/product-demo/audio_v7.py
```

中间文件写入仓库忽略目录`artifacts/product-demo-v7/`；成片保存在本文件夹的上一级。脱离仓库时，脚本将`product-demo/`的上一级作为根目录，保留文件夹结构即可。最终材料包包含16段MP3缓存与清单，重建相同旁白可以从缓存恢复WAV。更改文案后重新生成相应段落；旧`narrate.ps1`与`audio.py`是历史版本，不用于重建v7。当前PPT不参与视频渲染。

[refine-v6.js](refine-v6.js)与[refine-v6.css](refine-v6.css)保留结果附近的出处／规则入口、完整课程列表；[showcase-model.json](showcase-model.json)保存时间轴、步骤与场景。来源动作是可见的演示反馈，不操作系统剪贴板。[本轮验证](../validation-v7.md)分别记录技术检查、静态意见以及连续动效／听感的证据缺口。

## v5历史记录

**当时版本v5，2026-10-04**。按负责人追加要求，覆盖12项主要功能；每项均呈现“功能介绍 → 使用过程 → 最终结果”。当时[3分54秒视频](../校园工具-功能过程与成果-v5.mp4)、[字幕](../校园工具-功能过程与成果-v5.srt)与[16页PPT](../校园工具-功能过程与成果-v5.4.pptx)、[PDF](../校园工具-功能过程与成果-v5.4.pdf)配套。正文后保留v4历史介绍，旧命令与时间不代表当前版本。

## v5任务与结果

| 功能 | 视频时段 | 最终可见结果 |
| --- | --- | --- |
| 首页 | 00:06–00:18 | 清楚的功能入口 |
| Excel导入 | 00:18–00:45 | 校对后6门课程进入个人课表 |
| 截图识别 | 00:45–01:03 | 图片转草稿、确认后保存 |
| 周课表与手工维护 | 01:03–01:23 | 手工新增后7门课程，修改后B308可见 |
| AI查课 | 01:23–01:39 | 查询结果包含周次、课程、节次与地点 |
| AI课程变更 | 01:39–02:01 | 确认后8门课程，项目实践在指定节次出现 |
| 部门资料与问答 | 02:01–02:23 | 4个下设部门及资料依据，缺失信息说明 |
| 校园资讯 | 02:23–02:41 | 历史文章摘要与原文来源 |
| 目标日 | 02:41–02:56 | “项目展示”剩余7天 |
| 校历与考试 | 02:56–03:10 | 已登记日期、官方来源与报名口径 |
| 体测估算 | 03:10–03:28 | 81参考分与七项分数、权重 |
| 升学资料 | 03:28–03:48 | 适用范围、原文摘录和出处；不能核对则原文降级 |

v5沿用岭南红与校徽金；采用阶段轨道、操作输入和具体成果的画面组织。浏览器窄屏采用纵向重排，保留暂停、进度拖动、功能跳转、主要按钮与Escape关闭弹层。画面和数据性质持续标明，不把代码复现写成真实小程序验收。

新增来源：[showcase-model.json](showcase-model.json)保存功能介绍、步骤、结果、时间轴和短旁白；[showcase.js](showcase.js)连接演示状态与结果；[showcase.css](showcase.css)定义材料布局与窄屏适配。[render_v5.py](render_v5.py)渲染12项×3阶段和成片，同时运行32项结果及取消分支检查。[build_presentation.ps1](build_presentation.ps1)通过本机PowerPoint制作可编辑PPT与PDF，不依赖云端模型。

从仓库根目录依次执行：

```powershell
python -X utf8 docs/competition/principal-2026-10-08/product-demo/render.py --inspect
python -X utf8 docs/competition/principal-2026-10-08/product-demo/render.py
& docs/competition/principal-2026-10-08/product-demo/narrate.ps1
python -X utf8 docs/competition/principal-2026-10-08/product-demo/audio.py
& docs/competition/principal-2026-10-08/product-demo/build_presentation.ps1 -Suffix v5.5
```

视频重建写入`artifacts/product-demo-v5/`中间目录；PPT使用新的修订后缀以保留已有成品。素材、公开资料与[设计契约](../../../design/principal-showcase-v5/README.md)可追溯。32项检查只证明代码演示的行为，不等于真机或真实模型验收。

## v4历史记录

状态：2026-10-03按负责人补充要求制作v4。视频通过HTML、CSS与JavaScript编排产品操作，再由Chromium逐帧渲染和FFmpeg编码，不使用PPT页或截图轮播作为画面。

[播放成片](../校园工具-代码产品演示-v4.mp4) · [浏览器动画源页](index.html) · [配套字幕](../校园工具-代码产品演示-v4.srt)

## 画面与操作

约1分52秒，1600×900、24fps，包含代码生成的手机舞台、点击提示、逐字输入、页面切换、滚动、加载状态、确认弹层和课表变更。短旁白只在关键动作处提示，背景音乐与触摸音效由代码合成。

| 时间 | 产品演示 |
| --- | --- |
| 00:00–00:06 | 首页与校园信息入口；手机镜头从居中移动到功能展示位置 |
| 00:06–00:18 | 打开课表、进入导入页、选择聊天中的演示Excel、解析加载 |
| 00:18–00:33 | 查看6门课程草稿、修正缺失地点、确认保存 |
| 00:33–00:44 | 周课表、切换教学周、课程详情 |
| 00:44–01:07 | 输入查询、查看模拟回答、提出新增课程、确认提案后显示第7门课程 |
| 01:07–01:23 | 学生组织列表、详情、追问；未公开联系方式如实说明 |
| 01:23–01:35 | 校园资讯列表、文章摘要、滚动阅读、复制来源反馈 |
| 01:35–01:48 | 添加目标日、体测参考展示、升学问答范围澄清 |
| 01:48–01:52 | 产品收尾与展示边界 |

暂停动画后可操作手机上的主要按钮；进度条支持回放与拖动。自动演示和手动点击共享JavaScript状态更新函数，保存、取消和确认有实际状态变化。浏览器源页只模拟产品流程，不承担真实微信登录、云端保存、文件解析或模型调用。

将`product-demo/`文件夹与成片MP4放在同一级目录后，打开`product-demo/index.html`，点击播放即可同步画面与成片音轨。仅单独复制HTML时仍可观看动画，但缺少同级成片会没有声音。

## 内容依据与边界

- 界面颜色、首页结构和课表交互参考当前小程序代码；`gate.svg`复用项目门楼图形。没有修改实际小程序页面。
- 功能范围依据[产品规格](../../../product/spec.md)、[领域术语](../../../../CONTEXT.md)和[项目状态](../../../status.md)。部门资料参考`miniprogram/services/departments.ts`；学校名称参考`miniprogram/services/school.ts`。
- 课表、地点、目标日与体测输入为合成示例；AI回答是固定模拟响应，不产生模型请求或消费。
- 新闻标题与日期参考已有历史资料，正文使用说明性摘要，不冒充当前新闻或完整原文；复制动作只模拟反馈，不操作系统剪贴板。
- 当前视频属于**代码复现的产品流程演示**，不是微信开发者工具、云端或真机验收录像。视频和源页均持续标明这一点。
- 升学问答只展示范围确认，独立效果尚未完成验收；答辩练习与暂缓的失物招领不进入本片。

## 源代码与重建

- [index.html](index.html)：产品界面、交互状态、操作时间轴、点击动画和镜头；`window.renderAt(seconds)`用于确定性逐帧渲染。
- [render.py](render.py)：无头Chrome渲染、13项行为检查、逐帧导出和视频编码。
- [narrate.ps1](narrate.ps1)：使用本机Windows中文语音生成短旁白。
- [audio.py](audio.py)：合成原创背景音乐与触摸音效、混合旁白、导出成片和字幕。

需要Windows、Chrome、Python（Playwright、NumPy）及FFmpeg。从仓库根目录执行：

```powershell
python -X utf8 docs/competition/principal-2026-10-08/product-demo/render.py --inspect
python -X utf8 docs/competition/principal-2026-10-08/product-demo/render.py
& docs/competition/principal-2026-10-08/product-demo/narrate.ps1
python -X utf8 docs/competition/principal-2026-10-08/product-demo/audio.py
```

中间画面、音轨和检查记录写入忽略目录`artifacts/product-demo-v4/`；成片与字幕保存到本目录的上一级。13项行为检查验证的是此代码演示，不等于真实小程序或模型通过验收。

脱离仓库重建时，保留`product-demo/`文件夹结构，依次执行该文件夹中的`render.py`、`narrate.ps1`、`audio.py`。脚本自动将中间产物写到同级的`artifacts/product-demo-v4/`；重建成片保存到`product-demo/`上一级。
