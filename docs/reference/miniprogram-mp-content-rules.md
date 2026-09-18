# 小程序使用他人公众号内容的规则边界

核查日期：2026-09-18。状态：**规则层已完成主源核查；云端抓取公众号文章的实测未做**（本轮只在本地与公网做了 HTTP 行为实测，未在云函数环境跑通过一次公众号抓取）。

本文回答一个问题：**团队不拥有学校公众号的前提下，小程序可以合法、合规、可运行地使用该公众号文章到什么程度。** 结论用于决定 P3 资讯是否可以把「学校公众号」当作第二个数据源。

## 证据分级约定

本文严格区分四类材料，每一条结论都标注来源等级：

| 等级 | 含义 | 可信度 |
| --- | --- | --- |
| **已验证（文档）** | 微信官方开发者文档正文原文，附精确 URL | 最高，可直接作为工程依据 |
| **已验证（实测）** | 本轮用 `curl` 对公网发真实请求，记录到 HTTP 状态、响应头与响应体特征 | 高，可复现；但只代表本机 IP 与当日行为 |
| **已验证（官方社区精选帖）** | `developers.weixin.qq.com/community` 上标注「官方精选」「置顶」的微信团队帖，**不是开发者文档正文** | 中高，官方口径但非正式规则文本 |
| **社区 / 经验** | 社区普通开发者回答、第三方服务商文章 | 低，只能作为线索 |
| **推断** | 本文作者的推论，文档未直说 | 低，必须标注 |
| **未验证** | 本轮未取得任何依据 | 无 |

> 规矩：**不能把「推断」写进代码注释当依据，也不能把社区经验当规则引用。** 需要落地时必须转成「已验证（文档）」或补充实测。

## 结论摘要

| 需求 | 结论 | 等级 |
| --- | --- | --- |
| 用 `web-view` 打开学校公众号文章 | **不行。** `web-view` 只能打开「已关联公众号」的文章，否则该网页必须配置为业务域名；团队不是 `mp.weixin.qq.com` 的持有者，无法完成域名归属校验 | 已验证（文档） |
| 把 `mp.weixin.qq.com` 配成业务域名 | **实质不可行。** 校验要求把微信生成的 txt 放到该域名下可访问的路径；`mp.weixin.qq.com` 的服务器不受团队控制。文档还要求域名经 ICP 备案 | 已验证（文档）+ 推断 |
| 用 API 打开单篇文章 | **可行，且不要求关联。** `wx.openOfficialAccountArticle`，基础库 3.4.8+，文档原文为「打开**任意**公众号文章」，必须由点击行为触发 | 已验证（文档） |
| 打开公众号主页 / 会话 / 关注组件 | **不行。** `wx.openOfficialAccountProfile`、`wx.openOfficialAccountChat`、`official-account` 组件都要求公众号与小程序**同主体或关联主体** | 已验证（文档） |
| 云函数抓取后在小程序里重排正文 | **技术可行，规则上是高风险区。** 平台规则没有「标注来源即可」这一说；官方精选帖明确「**标明来源不代表原创作者允许其转载**」。许可（授权）才是关键，不是标注 | 已验证（文档）+官方精选帖 |
| 云函数能否出网抓 `mp.weixin.qq.com` | **能。** 云函数默认开启公网访问，且出网**没有**域名白名单；域名白名单是小程序端 `wx.request` 的限制 | 已验证（文档） |
| 定时抓取是否可靠 | **不可靠。** `mp.weixin.qq.com/robots.txt` 对全部 UA `Disallow: /`；实测无浏览器特征的请求会被 302 到验证页 `/mp/wappoc_appmsgcaptcha` | 已验证（实测）+ 文档（robots.txt） |

**一句话结论：打开文章可以（`wx.openOfficialAccountArticle`）；搬运文章正文不行；定时抓取技术上能做但既违反 robots.txt 又不稳定，不应作为比赛作品的正式数据源。**

## Q1 打开与嵌入公众号文章

### 1a. `web-view` 组件与业务域名

**文档原文（web-view 组件属性表）：**

> `src` | string | | 否 | webview 指向网页的链接。**可打开关联的公众号的文章，其它网页需登录小程序管理后台配置业务域名。** | 1.6.4

来源：<https://developers.weixin.qq.com/miniprogram/dev/component/web-view.html>

这句话把 `web-view` 的可打开范围**二分成两类**：① 已关联公众号的文章；② 已配置业务域名的网页。学校公众号若不与团队的小程序关联，其文章就落进第 ② 类，必须走业务域名。

**其他 `web-view` 限制（同一页面原文）：**

- 「承载网页的容器。会自动铺满整个小程序页面，**个人类型的小程序暂不支持使用**。」
- 「小程序插件中不能使用。」
- 「每个页面只能有一个 web-view。」
- 「网页内 iframe 的域名也需要配置到域名白名单。」
- 「web-view 网页与小程序之间不支持除 JSSDK 提供的接口之外的通信。」

**业务域名页面的限制（原文）：**

> # 1. 在管理后台配置业务域名
> 开发者登录小程序后台，选择「开发管理」-「开发设置」-「业务域名」，点击新增，按照要求配置业务域名。目前小程序内嵌网页能力暂不开放给个人类型账号和小游戏账号。
>
> # 限制说明
> 1）每个小程序账号支持配置最多300个域名；
> 2）每个域名支持绑定最多100个主体的小程序；
> 3）域名只支持 https 协议，不支持 IP 地址；
> 4）业务域名需经过ICP备案，新备案域名需24小时后才可配置；
> 5）域名格式只支持英文大小写字母、数字及「-」；
> 6）配置业务域名后，可打开任意合法的子域名；

来源：<https://developers.weixin.qq.com/miniprogram/dev/framework/ability/domain.html>

注意：文档正文只写「按照要求配置」，**没有在开发者文档里写明校验文件必须放根目录**。关于校验文件机制的唯一官方口径在社区官方精选帖《校验文件检查失败自查指引（2025版）》：

> 1. 微信生成一个校验文件，文件名为「随机字符+.txt」后缀…文件内容是一个随机长的字符串。
> 2. 开发者将校验文件上传到目标域名的服务器下，保证访问可以按照「域名+/+校验文件名」或「域名+路径+校验文件名」访问到（具体什么路径，需按照微信相关业务平台的要求来）
> 3. 开发者在微信相关业务平台中点击配置按钮或者校验按钮，微信服务器会向目标路径请求内容，然后将服务器返回的内容和微信数据库的内容做对比，如果对比成功则确认通过。

来源：<https://developers.weixin.qq.com/community/develop/doc/0000a423770ed0c6d80323d6c6b009>（「置顶 校验文件检查失败自查指引（2025版）官方精选」；本轮访问该帖需登录，正文经搜索索引取得）

**`mp.weixin.qq.com` 能否配置为业务域名？**

- 文档层面**没有**找到任何一句「禁止把 mp.weixin.qq.com 加入业务域名」。文档列出的形式要求（https、域名格式、非 IP）`mp.weixin.qq.com` 都满足。
- 但校验流程要求**团队能把微信生成的 txt 放到该域名下可被微信服务器 GET 到**。`mp.weixin.qq.com` 由腾讯运营，团队无法在根目录放文件。→ **这一步在做不到校验这件事上是确定的，属于「已无可行路径」而不是「未验证」。**
- ICP 备案要求：文档只说「业务域名需经过ICP备案」，未写备案主体必须等于小程序主体。`mp.weixin.qq.com` 本身已备案（主体为腾讯）。→ 这一条**不构成额外阻塞，但也不是通行证**；真正的阻塞是校验文件。（分级：已验证（文档）+ 推断）

**默认行为（不配置、不关联时）**：文档只说「在小程序管理后台成功配置业务域名后，才可使用web-view组件」，**没有写明失败表现**。社区一致反馈为白屏 / 加载失败，本轮的社区检索只找到「其它网页需登录小程序管理后台配置业务域名」这类复述。→ **失败的具体表现：未验证（文档），社区称加载失败/白屏。**

### 1b. 专用 API

| API | 主源 | 基础库 | 参数 | 关联/同主体要求 | 其他限制 |
| --- | --- | --- | --- | --- | --- |
| `wx.openOfficialAccountArticle` | [文档](https://developers.weixin.qq.com/miniprogram/dev/api/navigate/wx.openOfficialAccountArticle.html) | **3.4.8** | `url`（公众号文章地址） | **文档未提任何关联或同主体要求**，功能描述为「打开**任意**公众号文章」 | 「**必须有点击行为才能调用成功**」；「不包括临时链接等异常状态下的公众号文章」；不支持 Promise 风格；插件需基础库 ≥ 3.15.1 |
| `wx.openOfficialAccountProfile` | [文档](https://developers.weixin.qq.com/miniprogram/dev/api/navigate/wx.openOfficialAccountProfile.html) | **3.7.10** | `username`（公众号原始 ID） | **Tips：跳转的公众号需与小程序为同主体或关联主体** | 不支持 Promise 风格；插件需 ≥ 3.11.2 |
| `wx.openOfficialAccountChat` | [文档](https://developers.weixin.qq.com/miniprogram/dev/api/navigate/wx.openOfficialAccountChat.html) | **3.10.0** | `username`（公众号微信号） | **Tips：跳转的公众号需与小程序为同主体或关联主体** | 「如果用户没有关注则进行回退，跳转到公众号主页」；不支持插件 |
| `wx.openChannelsUserProfile` | [文档](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/channels/wx.openChannelsUserProfile.html) | **2.21.2** | `finderUserName`（视频号 ID） | 文档未提同主体要求 | 这是**视频号**主页，不是公众号；「若为插件环境，只允许在插件页面中调用」 |

`wx.openOfficialAccountArticle` 的功能描述原文：

> 通过小程序打开任意公众号文章（不包括临时链接等异常状态下的公众号文章），必须有点击行为才能调用成功。

**关键判读：**

1. 文档写的是「**任意**公众号文章」，并且**没有**任何 Tips 要求同主体或关联。这与 `openOfficialAccountProfile` / `openOfficialAccountChat` 把「同主体或关联主体」写进 Tips 形成**明显对照**——微信在这三个 API 上的限制写法是刻意不同的。（分级：已验证（文档））
2. 因此 `web-view` 的「关联公众号」限制**不是**全局限制，只是 `web-view` 组件自身的限制。文档层面存在一条「打开任意公众号文章」的官方通道。（分级：已验证（文档））
3. 社区帖称该接口「不需要关联」，与文档一致，仅作为旁证：<https://developers.weixin.qq.com/community/develop/doc/0000e03e420a28be959304b0966000>（分级：社区/经验）
4. 已知会失败的情形：属性名写错会返回 `openOfficialAccountArticle:fail invalid url. errCode: -2`（社区帖常见误用：把参数写成 `articleUrl`）。正确参数名是 `url`。（分级：社区/经验）
5. **个人主体小程序能否调用该接口：未验证（文档）。** 社区有提问，未见官方答复。`web-view` 明确写了「个人类型的小程序暂不支持」，但 `openOfficialAccountArticle` 没写。本项目若为非个人主体则不受此条影响，但**建议实测一次并留档**。

### 1c. 替代路径

| 路径 | 实际可行性 | 依据 |
| --- | --- | --- |
| **复制原文链接到剪贴板** | **可行**，但必须由用户点击触发。`wx.setClipboardData`（基础库 1.1.0）「设置系统剪贴板的内容」，参数 `data: string` 无域限制，可写入 `https://mp.weixin.qq.com/s/...` | [文档](https://developers.weixin.qq.com/miniprogram/dev/api/device/clipboard/wx.setClipboardData.html) 已验证 |
| **剪贴板的红线** | 运营规范 5.15.4「滥用操作剪切板接口」：「用户未进行任何操作情况下，小程序默认读取剪切板信息、往剪切板写入信息」属违规。→ **不能自动复制**，必须放在用户点击的按钮上 | [运营规范](https://developers.weixin.qq.com/miniprogram/product/) 已验证（文档） |
| **`wx.onCopyUrl`（右上角「复制链接」）** | **不能用来复制公众号链接**。该接口只允许自定义小程序短链的 `query` 和 `title`，不接收任意 URL | [文档](https://developers.weixin.qq.com/miniprogram/dev/api/share/wx.onCopyUrl.html) 已验证 |
| **客服消息发原文链接** | 接口层面**支持**：`customerServiceMessage.send` 的 `msgtype="link"`（图文链接）有 `url` 字段「URL to which a message with image/text links is redirected」；`msgtype="news"` 文档标注为「图文消息（**点击跳转到外链**）」。但运营规范 5.15.3「滥用客服消息接口」禁止「通过客服消息接口向用户发送与客服场景无关的消息」，且仅能在用户触发客服会话后 48 小时内下发（用户发消息 5 条 / 48 小时，进入客服消息 2 条 / 1 分钟）。→ **把客服消息当内容分发渠道属于滥用接口能力** | [接口文档](https://developers.weixin.qq.com/miniprogram/dev/server/API/kf-mgnt/kf-message/api_sendcustommessage)、[发送规则](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/customer-message/send.html)、运营规范 5.15.3 已验证（文档） |
| **`wx.openCustomerServiceChat`** | **不行。** 文档要求绑定**同主体**的微信客服企业 ID | [文档](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/service-chat/wx.openCustomerServiceChat.html) + 企业微信文档 <https://developer.work.weixin.qq.com/document/path/97013> 已验证（文档） |
| **公众号名片 / 关注组件** | **不行。** `official-account` 组件 Tips 原文：「设置的公众号需与小程序为**同主体或关联主体**」；且只在特定场景值（1011/1017/1025/1047/1124 等扫码场景）才展示 | [文档](https://developers.weixin.qq.com/miniprogram/dev/component/official-account.html) 已验证 |
| **「相关公众号」展示** | **可行但很弱。** 小程序后台「账号设置 - 基本信息 - 相关公众号」可让该公众号出现在**小程序主页**。这只影响小程序资料页，不能把文章搬进页面 | [绑定关系说明](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/bind/bind-intro.html) 已验证（文档） |
| **关联公众号（`web-view` 免业务域名通道）** | **需要学校配合，但规则上允许跨主体。** 关联规则：「一个公众号可关联 10 个同主体的小程序，**3 个不同主体的小程序**」；「一个小程序可关联 500 个公众号」。流程由公众号侧发起（公众号后台「广告与服务 - 小程序管理 - 关联小程序」），且小程序侧需开启「允许公众号关联此小程序」 | 关联规则：<https://developers.weixin.qq.com/minigame/introduction/guide/gzh.html>；流程：<https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/bind/bind-official-account.html> 已验证（文档） |

**关于「公众号名片」的补充：** 文档里能查到的「公众号文章卡片」能力属于**多端应用（SAAASDK）**场景（<https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/miniapp/new-capability/official-account.html>），解决的是「在 App 的 webview 里点公众号卡片能跳到小程序」，**不是**小程序里插入公众号名片。→ 小程序内没有「插入公众号名片」的文档化能力。（分级：已验证（文档，该页功能范围）+ 推断）

### 1d. 关联公众号后 `web-view` 的限制仍然存在

即使学校公众号关联了小程序，`web-view` 也**不是**推荐方案，因为：

- `web-view` 里打开的网页**只能**用 JSSDK 的 `wx.miniProgram.*` 一组接口与小程序通信（文档明列 7 个接口），无法做内容抽取、埋点或摘要。
- 运营规范 §8「微信小程序内嵌网页规范」要求：8.1「内嵌的网页必须已经履行备案手续」；8.2「通过内嵌网页所提供的服务，必须与微信小程序填写的类目和标签一致」；8.4「不得通过提供内嵌网页的方式，绕开或规避微信小程序的平台规则」。

来源：<https://developers.weixin.qq.com/miniprogram/product/>（分级：已验证（文档））

→ **对本项目：公众号文章的打开用 `wx.openOfficialAccountArticle`，不要为了 `web-view` 去推动关联。**

## Q2 抓取后二次发布（转载 / 来源标注 / 侵权 / 服务范围）

这一节的结论最硬，也最不乐观。

### 2a. 平台规则里没有「标注来源即可」这回事

**官方精选帖直接把这个问题回答了。**《微信公众平台文章违规抄袭申诉指引》：

> **Q：转载他人文章已经标注了来源，为何还会被判定为抄袭/洗稿？**
> **A：转载他人文章须获得授权，标明来源不代表原创作者允许其作品被转载**，所以原创作者有权发起投诉。如事先已通过相关途径获得原创作者授权，可在微信公众平台右上角通知中心处发起申诉，申诉时需提交有效的授权证明材料…（纸质版授权证明、公众号文字授权证明、已添加白名单的截图等）。

来源：<https://developers.weixin.qq.com/community/develop/doc/000ac652a802c81073b994b9a5c809>（「置顶 微信公众平台文章违规抄袭申诉指引 官方精选」）（分级：已验证（官方社区精选帖））

**同一帖的另一个问题同样关键：**

> **Q：我转发了一篇没有标原创的文章到自己的公众号上，为啥还会被判定为抄袭/洗稿？**
> **A：原创标识属于发布方对所发布内容中自行创作部分的著作权或著作权来源的单方面声明…没有标原创的内容，不代表就不符合平台的原创规范…不管有没有标原创，只要文章实际是原创，被他人抄袭/洗稿了，都可以提交投诉。**

→ **「对方没标原创」不能当作可以转载的理由。**（分级：已验证（官方社区精选帖））

### 2b. 小程序侧的规则文本

《微信小程序平台运营规范》主源：<https://developers.weixin.qq.com/miniprogram/product/>（该页 H1 为「一、原则及相关说明」，页名即运营规范）。**注意：该规范全文没有出现「转载」二字**，本轮已逐行检索确认。也就是说，平台**不区分「转载」和「侵权」**，统一按侵权处理。

原文摘录（逐字）：

| 条 | 原文 |
| --- | --- |
| §5.6 侵犯知识产权行为 | 「小程序开发者不得自行或与其他第三方共同利用腾讯的服务，侵犯其他主体的知识产权，包括但不限于：文字、图片、视频、音频、软件等。」处理规则：「一经发现将根据违规程度对该小程序侵权内容清空**直至下架处理**。」 |
| §6.1.8 | 「未经授权，擅自使用他人商标、版权内容等，以及其他侵犯他人合法知识产权的。」处理规则：「一经发现将对该小程序**封号处理**。」 |
| §9.2 | 「使用他人商标、版权内容等涉及他人知识产权的内容需要在账号申请时如实说明，并根据要求提供相关权利证书或授权证明等。**非权利人或未经授权的，不得使用他人享有合法知识产权的内容。**」 |
| §3.4 | 「微信小程序的服务范围需与实际填写的类目和标签一致，也需和自身所提供的服务一致，且不应超出小程序平台的类目库范围。」 |
| §5.7.3 类目不符行为 | 「内容展示类目不符：小程序发布展示相关内容，未申请通过相关类目，包括但不限于：发布展示**信息资讯**、文娱、社交等信息。」处理规则：「提醒开发者限期调整，如未申请通过相关类目或下架相关服务，将根据违规程度对该小程序封禁能力直至下架处理。」 |
| §3.9 | 「未经允许或未经腾讯公司授权的情况下，…**也不得展示或者推荐其他微信小程序或公众号。**」 |
| §10.2 | 「微信小程序的服务提供者，应设置过滤违法、违规等不当信息内容的机制，通过使用内容安全API接口、人工审核等机制做好内容把关。」 |
| §8.3 | 「开发者在微信小程序内嵌的网页内容，需遵守《微信外部链接内容管理规范》的规定。」 |

《微信小程序平台常见拒绝情形》主源：<https://developers.weixin.qq.com/miniprogram/product/reject.html>。原文摘录：

| 条 | 原文 |
| --- | --- |
| 1.2（4） | 「小程序服务类目所对应的页面链接加载**侵犯他人权益的内容**…」 |
| 2.1.1 | 「小程序服务类目所对应的页面核心内容必须与该类目一致。」 |
| 3.1.3 | 「小程序实际所提供的服务不得属于尚未开放的服务范围。不应超出小程序平台已开放的类目库范围。」 |
| 3.1.7 | 「在未经允许或未经腾讯公司授权的情况下，**不得展示和推荐第三方小程序**。示例：不能做小程序导航，不能做小程序链接互推，小程序排行榜等。」 |
| 3.2.1 | 「…诱导添加、**诱导关注公众号**、诱导下载等，要求用户分享、添加、关注或下载后才可操作的程序…都将会被拒绝」 |

《小程序侵犯知识产权违规案例解析》（官方精选帖）给出处理口径：

> 平台尊重原创，保护原创。若小程序内容未经授权许可，内容存在抄袭、仿冒；未经授权许可，擅自使用他人注册商标、版权内容等、侵犯合法知识产权的，包括但不限于美术作品、音乐作品、代码包等…如证据充分、核实成立，将根据违规程度对小程序采取**警告甚至进行下架处理**。
> 案例 3：未经授权许可，内容使用他人版权作品 → 投诉其小程序内容侵权，提供版权材料…如核实存在使用他人版权内容涉嫌整体侵权的**可下架处理**。

来源：<https://developers.weixin.qq.com/community/develop/doc/0006e4b67f8ec01684e99cc9b5b009>（「置顶 小程序侵犯知识产权违规案例解析 官方精选」）（分级：已验证（官方社区精选帖））

### 2c. 服务范围一致性：类目真会拦住「校园资讯」

《小程序开放的服务类目》主源：<https://developers.weixin.qq.com/miniprogram/product/material/>。与资讯最相关的三行逐字摘录：

| 类目 | 资质要求 | 类目适用范围 | 备注 |
| --- | --- | --- | --- |
| **资讯 - 信息资讯** | 无 | 「适用于提供娱乐、美妆、餐饮等**单一行业**资讯展示等服务。」 | 「1、如提供**两个及以上**行业资讯相关服务，需选择【文娱-资讯广场】类目；2、如提供**时政信息**服务，需选择【时政信息】类目。」 |
| **文娱 - 资讯广场** | **《互联网新闻信息服务许可证》** | 「适用于提供娱乐、游戏、服饰、美妆、科普、养生、法律、求职、拍卖、体育、旅游、科技、美食、医疗等行业资讯中的**两类或两类以上**的内容资讯信息。」 | 「如提供时政信息服务，需补充【时政信息】类目。」 |
| **时政信息** | （2 选 1）1、新闻服务商：**《互联网新闻信息服务许可证》**；2、政府或监管机构：《非经营性互联网信息服务备案核准》+《统一社会信用代码证》（机构类型：机关） | 「适用于提供**时政类新闻信息**的文章/图片/视频/音频报道，包括**政治（含法律法规）、经济、军事、外交、农业、历史、社会突发事件**等。」 | 「选择该类目后首次提交代码审核，需经当地互联网主管机关审核确认，预计审核时长 **7 天**左右。」 |

**判读（分级：推断，但依据是上面的原文）：**

- 一个只做「校园动态」单一主题的资讯页，落点应是**资讯 - 信息资讯**（无需资质）。
- 一旦资讯来源扩展到「学校要闻 / 校园动态 / 创新创业 / 产教融合 / **媒体报道**」多个栏目（`docs/news-sources.md` 列的正是这五个），且媒体报道会转载**南方+ 等外部媒体**内容，就有被判定为「两类及以上行业资讯」→ 需要 **《互联网新闻信息服务许可证》** 的风险。**学生团队无法取得该证。**
- 公众号文章里若出现「党委」「政府领导调研」「社会突发事件」这类内容，还有被归入**时政信息**的风险，同样需要许可证。
- 学校自有的官网新闻和公众号推文属于学校自有/授权内容；**一旦混入第三方媒体稿件（如「【南方+】…」），风险从「学校内容」变成「第三方版权内容」**。`docs/news-sources.md` 的「媒体报道」栏目里就存在这种稿件。

### 2d. 关于「学校是否算授权」

- 规则层面**只有「授权」是出口**，且 §9.2 要求「在账号申请时如实说明，并根据要求提供相关权利证书或授权证明」。
- 学校是公众号主体，学校**可以**给这个项目授权（例如出具书面授权、在公众号后台开转载白名单）。**但本项目目前没有拿到任何书面授权**，`docs/` 中也没有相关记录。→ **未验证/尚无授权**（这不是文档问题，是项目状态问题）。
- 即使学校口头同意，微信的申诉/投诉流程认的是「有效的授权证明材料」（纸质授权、公众号文字授权、白名单截图）——见 2a 引文。

### 2e. 本节结论

| 做法 | 规则判定 | 等级 |
| --- | --- | --- |
| 抓正文 → 存库 → 小程序自己排版渲染 | 属于 §5.6 / §6.1.8 / §9.2 的「未经授权使用他人版权内容」；标注来源**不能**豁免 | 已验证（文档）+官方精选帖 |
| 抓标题 + 摘要（几十字）+ 原文链接 + 明确来源 | 仍属使用他人作品，但风险显著低于全文；**平台的判定是人工/投诉驱动的**，没有「摘要多少字以内安全」的文档化阈值 | 推断（文档未给阈值） |
| 只存标题 + 原文链接，正文完全跳转看 | 风险最低；但 §3.9「不得展示或者推荐其他…公众号」仍然存在，需以「来源标注」而非「推荐导流」的姿态呈现 | 推断（§3.9 原文 + 未文档化豁免） |
| 学校出具书面授权 / 公众号开白名单后搬运 | 规则上成立，需保留授权证明材料 | 已验证（文档） |

> **没有找到的规则**：本轮没有找到任何一条微信文档给出「注明来源 + 回链原文即可转载」的授权性表述。**结论是「不存在这样的规则文本」，而不是「本轮没查到」。**

### 2f. 上游侧（学校公众号）会被怎么处理

如果团队把文章搬到小程序，投诉路径上先被查的是**公众号侧**的《微信公众平台运营规范》§4.1.2 内容侵权：

> 「未经授权发送他人原创文章，侵犯他人知识产权。」→「此类侵权行为一经发现，将对违规公众账号采取清除违规内容、功能封禁、甚至注销等形式的处理。」

来源：<https://mp.weixin.qq.com/cgi-bin/readtemplate?t=business/faq_operation_tmpl&type=info&lang=zh_CN>（分级：已验证（文档））

→ 这条约束的是公众号运营者，但它说明一件事：**在微信生态内「未经授权转发他人文章」是被明确定义为侵权的行为**，不是灰色地带。

### 2g. 上游侧的另一条关键文本（谁转发、怎么展示）

《微信公众平台服务协议》：

> 10.6 你理解并同意，你向任何第三人分享、转发、复制微信公众平台信息内容的行为，均应遵守微信公众平台为此制定的规范和标准，包括但不限于**展示方式应为该信息或内容的原链接**、确保附属于该信息或内容的功能可正常使用等。
> 10.7 任何未经腾讯书面同意及权利人许可的**非法获取行为，均属违法侵权行为**。

来源：<https://mp.weixin.qq.com/cgi-bin/readtemplate?t=home/agreement_tmpl&type=info&lang=zh_CN>（分级：已验证（文档））

10.6 的约束主体是「你」（公众平台用户）向第三人转发的行为，团队作为「第三人」时严格说不是该条的被约束方。但它是微信对「公众号内容如何传播」的**官方立场文本**：**传播形态应为原链接**。这反向支持了 1b 的做法（用 `wx.openOfficialAccountArticle` 打开原链接），而不是自建排版。（分级：已验证（文档）原文 + 推断其对本项目的适用性）

## Q3 云函数出网

### 3a. 域名白名单只约束小程序端

《网络》页面明确白名单的作用范围是**小程序（客户端）**：

> 每个微信小程序需要事先设置通讯域名，**小程序只可以跟指定的域名进行网络通信**。包括普通 HTTPS 请求（wx.request）、上传文件（wx.uploadFile）、下载文件（wx.downloadFile) 和 WebSocket 通信（wx.connectSocket）。

来源：<https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html>（分级：已验证（文档））

同一页有一条**值得注意的类比条款**（针对 `api.weixin.qq.com`）：

> 出于安全考虑，`api.weixin.qq.com` 不能被配置为服务器域名，相关 API 也不能在小程序内调用。开发者应将 AppSecret 保存到后台服务器中，通过服务器使用 `getAccessToken` 接口获取 `access_token`，并调用相关 API。

（分级：已验证（文档））——这条恰好说明微信的取向：**微信服务的 API 只能从服务端调用，不能从小程序端直接调。**

### 3b. 云函数出网无域名白名单

《云函数》页面（微信侧文档）：

> 我们可以如在 Node.js 环境中使用 JavaScript 一样**在云函数中进行网络请求等操作**。

来源：<https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/functions.html>（分级：已验证（文档））

CloudBase 侧文档把「出网」讲得更直接：

> ### 公网访问
> **云函数默认开启公网访问能力**，您可以根据安全需求选择关闭。关闭后，函数将无法访问公网资源。

来源：<https://docs.cloudbase.net/cloud-function/function-configuration/config>（分级：已验证（文档））

**本仓库的旁证（实测，非文档）：** `docs/cloud-development.md` 记录 `newsSync` 云函数已成功抓取 `https://lnc.edu.cn/xyxw/xydt`，「同一地址在本机 curl 返回 200」；给请求加上浏览器请求头后云端 403 恢复。这证明云函数出网可达任意公网域名，**没有域名白名单**。（分级：已验证（本仓库实测记录））

> 注意区分：CloudBase 的「自定义域名 / HTTP 网关」是**入向**（外部访问云函数）；「公网访问」开关是**出向**。文档没有给出云函数出向的域名白名单机制。（分级：已验证（文档））

### 3c. 因此

云函数**可以**发 HTTPS GET 到 `mp.weixin.qq.com`。**技术允许 ≠ 规则允许 ≠ 稳定**：Q4 说明为什么这条链路不能用来做定时抓取。

## Q4 `mp.weixin.qq.com` 的反爬

这里必须把「文档」「实测」「社区」分得非常清楚：**微信没有任何一份文档描述 `mp.weixin.qq.com` 的反爬机制**（本轮未找到，判定为「未文档化」，而不是「没有」）。

### 4a. `robots.txt`：这是唯一的「文档级」依据

实测 `https://mp.weixin.qq.com/robots.txt`（HTTP 200）：

```
User-Agent: *
Allow: /$
Allow: /debug/
Allow: /qa/
Allow: /wiki
Allow: /cgi-bin/loginpage
Allow: /cgi-bin/wx
Allow: /webpoc/ruleCenter
Allow: /miniprogram/landing_page
Disallow: /

Sitemap: https://mp.weixin.qq.com/miniprogram/landing_page/sitemap.xml
```

**逐字判读：**

- `User-Agent: *` → 对**所有**爬虫生效。
- 白名单只开放 7 个路径（首页、`/debug/`、`/qa/`、`/wiki`、登录页、`/cgi-bin/wx`、规则中心、小程序落地页）。
- `Disallow: /` → **其余全部禁止抓取，包括文章页 `/s/...` 与 `/s?__biz=...`。**

（分级：**已验证（实测 + 该文件本身就是站点发布的机器可读策略）**。这比任何社区说法都硬。）

→ **结论：对 `mp.weixin.qq.com/s/*` 做常规爬取，是明确违反站点 robots 策略的行为。** 这条足以在合规评审里否决「定时抓取公众号文章」的方案，不需要再讨论反爬能不能绕过。

### 4b. 行为实测：无浏览器特征的请求会被 302 到验证页

实测条件：2026-09-18，本机（中国大陆住宅宽带出口 IP），对同一篇公开文章 `https://mp.weixin.qq.com/s/Xur-QQuUy9itmiHyznR8xg` 用不同 UA 发 GET。

| 请求的 `User-Agent` | HTTP 状态 | 响应体 | 特征 |
| --- | --- | --- | --- |
| `Mozilla/5.0 ... Chrome/120.0 Safari/537.36` | **200** | 3,478,029 字节，含 `js_content`，可见正文 | 正常文章页；响应头 `LogicRet: 0` |
| `Mozilla/5.0 (iPhone...) ... MicroMessenger/8.0.30` | **200** | 3,478,029 字节，含 `js_content` | 同上 |
| **无 UA（`curl/8.x` 默认）** | **302** | `Content-Length: 45` | `Location: https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=...&target_url=...`；`Set-Cookie: poc_sid=...; Secure; HttpOnly` |
| 跟随 302 后的页面 | 200 | 18,045 字节，**不含** `js_content` | 正文为「**环境异常** 当前环境异常，完成验证后即可继续访问。 去验证」 |
| `axios/1.6.0` | 302 → 200 | 18,045 字节 | 同上「环境异常」页 |
| `node-fetch/1.0` | 302 → 200 | 18,045 字节 | 同上 |
| `python-requests/2.31.0` | 302 → 200 | 18,045 字节 | 同上 |
| `Googlebot/2.1` / `Baiduspider/2.0` | **200** | **775 字节** | 页面正文为「**该页面不存在**」；响应头 `RetKey: 11`、`LogicRet: -12` |

**强判读：**

1. 「环境异常」不是静态错误页，而是 **302 重定向到 `/mp/wappoc_appmsgcaptcha`**（`poc` = proof-of-capability）并下发 `poc_sid` cookie。**这就是反爬验证闸门本身**，从响应头可以机器验证。（分级：已验证（实测））
2. 触发条件**至少包含请求指纹**：同一 URL、同一 IP、同一时刻，只换 UA 就能改变结果。`curl`、`axios`、`node-fetch`、`python-requests` 的默认 UA 全部被拦，浏览器/微信 UA 放行。（分级：已验证（实测））
3. **搜索引擎爬虫被单独对待**：Googlebot / Baiduspider UA 拿到的是「该页面不存在」（HTTP 200，775 字节），带 `RetKey`/`LogicRet` 风控响应头——**不是**正常文章页。这说明微信对「爬虫 UA」有专门的应答策略，而不是简单放行。（分级：已验证（实测））
4. **本项目云函数已经在用的做法正好命中工作条件**：`cloudfunctions/newsSync/index.ts:39` 设置了 Chrome UA 字符串（`Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/120.0.0.0 Safari/537.36`）。仅从 UA 这一个维度看，它能通过第一道闸门。（分级：已验证（实测试验支持）+ 推断（未在云函数环境实测））
5. **风险仍在**：本轮 25 次连续请求（浏览器 UA）**未**触发闸门（`ok=25 gate=0`）。也就是说**在当前 IP 与当前频率下，闸门不由频率单独触发**——但这**不能**推广为「高频安全」。云函数出口 IP 是腾讯云机房 IP，风控策略与住宅 IP 不同；`poc_sid` 类 cookie 说明平台具备下发挑战、按会话记账的能力。（分级：已验证（实测）+ 推断）

### 4c. 社区经验（低可信，只作线索）

- 【社区/经验】多处技术文章称：直连 `mp.weixin.qq.com/s/...` 会被 403/302 或「环境异常」拦截；`pass_ticket`、`appmsg_token` 等凭证**有效期短（约 2 小时）**；机房 IP 被风控更严；建议「增加请求延迟（2–5 秒 / 次）」「使用代理 IP 池轮换」「Cookie/UA 伪装」。
- 【社区/经验】有工具/Skill 的说明文字直接写「直接抓取被微信『环境异常/去验证』拦截…纯 headless 路线经常失败」，解决思路是「接管已通过验证的真实浏览器会话」。
- 【社区/经验】有开源项目写明：**不要在云服务器（机房 IP）上做公众号登录/全量抓取**，凭证几十分钟到几小时失效，且可能触发账号级风控。

**这些全部是社区经验，不是文档，不能作为工程依据，也不能作为「这样做是允许的」的理由。** 与 4a 的 robots.txt 相比，它们只说明「即使想抓也不稳定」。

### 4d. 官方提供的、合规的取数通道

如果学校愿意授权，正确的取数方式是**公众号自己的服务端接口**，而不是抓 HTML：

| 接口 | 路径 | 说明 |
| --- | --- | --- |
| 获取已发布的消息列表 | `POST /cgi-bin/freepublish/batchget?access_token=...` | 返回 `content.news_item`，含 `title`、`author`、`digest`、`content`（HTML）、`content_source_url`、`thumb_url`、`url` |
| 获取已发布图文信息 | `/cgi-bin/freepublish/getarticle` | 单篇详情 |

来源：<https://developers.weixin.qq.com/doc/subscription/api/public/api_freepublish_batchget.html>、<https://developers.weixin.qq.com/doc/subscription/guide/product/publish.html>（分级：已验证（文档））

限制（同页原文）：

- 「接口应在**服务器端**调用，不可在前端（小程序、网页、APP 等）直接调用。」
- `access_token` 属于**该公众号**；适用范围写「公众号：**仅认证**」（表示仅允许企业主体已认证账号调用）。
- 未授权调用返回 `48001 api unauthorized`。

→ **本团队不是该公众号的主体，拿不到 `access_token`；除非学校作为主体配合（授权或第三方平台代调用，权限集 id 7）。这就是「必须由学校侧行动」的硬边界。**（分级：已验证（文档）+ 推断）

### 4e. 「环境异常」页本身是给用户过的验证

跟随 302 后拿到的页面只有一句话与一个「去验证」入口：

> 环境异常
> 当前环境异常，完成验证后即可继续访问。
> 去验证

这是给**浏览器里的人**点的验证，不是给程序调用的接口。**用云函数「过」它是对抗平台风控的行为**，与运营规范 §5.19（绕开、规避或对抗平台审核监管）以及 §8.4（不得通过内嵌网页绕开平台规则）的取向直接冲突——**不建议，也不应写进比赛作品。**（分级：已验证（文档原文）+ 推断其适用）

## 对本项目（校园工具小程序，比赛作品）的含义

### 可以做的

1. **资讯列表里加「公众号」来源条目，但只存元数据 + 原文链接**：标题、发布日期、来源标识、`https://mp.weixin.qq.com/s/...` 链接。正文用 `wx.openOfficialAccountArticle` 打开。这是唯一同时满足「文档化能力」与「传播形态为原链接」的做法（对应服务协议 10.6）。基础库要求 3.4.8，本项目锁定 3.17.2，**满足**。
2. **把「复制原文链接」做成一个显式按钮**（`wx.setClipboardData`），并在按钮上写明用途。注意运营规范 5.15.4：不能自动写剪贴板。
3. **云函数继续只抓官网站点**（`lnc.edu.cn`）。官网站点不适用 `mp.weixin.qq.com` 的 robots 与风控问题；目前的 403 + 请求头处理方案已在 `docs/cloud-development.md` 记录并有效。
4. **在页面上如实说明来源与数据范围**（如「来源：学校官网 · 校园动态」），这是项目一贯做法，也降低审核误判风险。
5. **向学校申请书面授权或公众号开白名单**（若比赛演示确实需要展示推文）。学校是本项目最自然的合作方，一旦拿到授权，Q2 的障碍就从「侵权」变成「已授权」，并且可以顺带申请公众号关联（跨主体额度：一个公众号可关联 3 个不同主体小程序）。

### 不能做 / 不应做的

1. **不要把公众号正文抓进 `news_articles` 再自己排版渲染。** 规则上属 §5.6 / §6.1.8 / §9.2 的未经授权使用他人版权内容；官方精选帖明确「标明来源不代表原创作者允许其转载」。比赛作品被投诉下架，代价远大于收益。
2. **不要为了 `web-view` 去推动公众号关联。** 关联后仍受 `web-view` 的通信限制与运营规范 §8 约束，收益接近零。
3. **不要做定时抓取公众号文章。** `robots.txt` 明确 `Disallow: /`；实测无浏览器特征的请求会被 302 到验证页；过验证属于对抗风控。
4. **不要在页面里做「公众号导航 / 推荐」。** 运营规范 §3.9、常见拒绝情形 3.1.7 都禁止未经授权展示或推荐其他公众号/小程序。
5. **不要把「媒体报道」栏目的第三方稿件与学校自有稿件混为一谈。** 前者的版权在学校之外，且涉及 2c 的类目风险。
6. **不要把「AI 摘要」当规避手段。** 摘要仍是对他人作品的使用；平台没有给出「多少字以内安全」的阈值；同时 AI 生成内容还引入 P5 的独立问题。

### 需要补的实测 / 决策

| 事项 | 动作 | 完成判据 |
| --- | --- | --- |
| `wx.openOfficialAccountArticle` 在真机是否可用 | 用一篇学校公众号公开文章，在开发者工具 + 真机各调一次 | 记录 `errMsg`；失败则记录 `errCode` |
| 该接口对**个人主体**小程序是否开放 | 若本项目为个人主体需先确认；非个人主体可跳过 | 文档未写，只能用实测或社区答复 |
| 是否向学校争取授权 | 负责人决策；需要学校出具书面授权或开白名单 | 授权文件入 `docs/`，不进 Git 明文（如需） |
| 资讯类目是否需补充 | 按 2c 核对本项目当前类目是否覆盖「资讯 - 信息资讯」 | 以平台类目页与后台实际类目为准 |
| 公众号条目是否入库 | 若做「元数据 + 外链」方案，需确认 `news_articles` 是否需要区分来源体系与去重键 | 决定后再改数据模型 |

## 未验证 / 未找到依据的问题

诚实记录本轮没有结论的部分：

1. **`mp.weixin.qq.com` 作为业务域名会被后台直接拒绝吗？** 未找到文档依据，也未实测（无后台权限）。已确认的只有「无法完成校验文件放置」这一硬阻塞。
2. **不配置、不关联时 `web-view` 的失败表现**（白屏 / 报错 / `bind:error`）——文档未写，本轮未实测。
3. **`wx.openOfficialAccountArticle` 对个人主体小程序是否开放**——文档未写。
4. **`wx.openOfficialAccountArticle` 是否有调用频次限制**——文档未写。
5. **`wx.openOfficialAccountArticle` 对「已删除文章」「临时链接」的失败码**——文档只写「不包括临时链接等异常状态下的公众号文章」，未给错误码表。
6. **从腾讯云机房 IP 抓 `mp.weixin.qq.com` 的实际拦截率**——本轮只有住宅 IP 数据，**未在云函数环境实测**。
7. **`mp.weixin.qq.com/robots.txt` 是否按 UA 返回不同内容**——本轮只测了默认 UA（返回上面那份）。搜索引擎 UA 抓的是文章页而非 robots.txt，两者未交叉验证。
8. **是否存在微信认可的「摘要 + 回链」合规阈值**——没有找到任何文档化的字数或比例阈值。
9. **`news_articles` 混入公众号元数据后的去重键问题**——纯工程问题，本轮未设计。
10. **法条层（《著作权法》信息网络传播权、《信息网络传播权保护条例》合理使用）未在本轮核实原文**，本文只覆盖微信平台规则。若要写进比赛材料，需另找国家法律法规数据库原文。

## 来源清单

**微信开发者文档（已验证）**

- web-view 组件：<https://developers.weixin.qq.com/miniprogram/dev/component/web-view.html>
- 业务域名：<https://developers.weixin.qq.com/miniprogram/dev/framework/ability/domain.html>
- 网络（服务器域名）：<https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html>
- `wx.openOfficialAccountArticle`：<https://developers.weixin.qq.com/miniprogram/dev/api/navigate/wx.openOfficialAccountArticle.html>
- `wx.openOfficialAccountProfile`：<https://developers.weixin.qq.com/miniprogram/dev/api/navigate/wx.openOfficialAccountProfile.html>
- `wx.openOfficialAccountChat`：<https://developers.weixin.qq.com/miniprogram/dev/api/navigate/wx.openOfficialAccountChat.html>
- `wx.openChannelsUserProfile`：<https://developers.weixin.qq.com/miniprogram/dev/api/open-api/channels/wx.openChannelsUserProfile.html>
- `wx.setClipboardData`：<https://developers.weixin.qq.com/miniprogram/dev/api/device/clipboard/wx.setClipboardData.html>
- `wx.onCopyUrl`：<https://developers.weixin.qq.com/miniprogram/dev/api/share/wx.onCopyUrl.html>
- `official-account` 组件：<https://developers.weixin.qq.com/miniprogram/dev/component/official-account.html>
- `wx.openCustomerServiceChat`：<https://developers.weixin.qq.com/miniprogram/dev/api/open-api/service-chat/wx.openCustomerServiceChat.html>
- 发送客服消息接口：<https://developers.weixin.qq.com/miniprogram/dev/server/API/kf-mgnt/kf-message/api_sendcustommessage>
- 发送客服消息规则：<https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/customer-message/send.html>
- 小程序与微信生态业务的绑定关系：<https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/bind/bind-intro.html>
- 小程序绑定公众号：<https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/bind/bind-official-account.html>
- 公众号关联小程序（关联额度）：<https://developers.weixin.qq.com/minigame/introduction/guide/gzh.html>
- 《云函数》：<https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/functions.html>
- 获取已发布的消息列表：<https://developers.weixin.qq.com/doc/subscription/api/public/api_freepublish_batchget.html>
- 发布能力总览：<https://developers.weixin.qq.com/doc/subscription/guide/product/publish.html>
- 多端应用-公众号文章卡片：<https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/miniapp/new-capability/official-account.html>

**微信平台规则（已验证）**

- 《微信小程序平台运营规范》：<https://developers.weixin.qq.com/miniprogram/product/>
- 《微信小程序平台常见拒绝情形》：<https://developers.weixin.qq.com/miniprogram/product/reject.html>
- 《小程序开放的服务类目》：<https://developers.weixin.qq.com/miniprogram/product/material/>
- 《微信小程序平台服务条款》：<https://developers.weixin.qq.com/miniprogram/product/service.html>
- 《微信公众平台运营规范》：<https://mp.weixin.qq.com/cgi-bin/readtemplate?t=business/faq_operation_tmpl&type=info&lang=zh_CN>
- 《微信公众平台服务协议》：<https://mp.weixin.qq.com/cgi-bin/readtemplate?t=home/agreement_tmpl&type=info&lang=zh_CN>
- 《微信外部链接内容管理规范》：<https://weixin.qq.com/cgi-bin/readtemplate?t=weixin_external_links_content_management_specification>

**CloudBase / 云开发（已验证）**

- 云函数基础配置（公网访问默认开启）：<https://docs.cloudbase.net/cloud-function/function-configuration/config>
- 云函数安全规则：<https://docs.cloudbase.net/cloud-function/security-rules>

**官方社区精选帖（已验证但非文档正文）**

- 校验文件检查失败自查指引（2025版）：<https://developers.weixin.qq.com/community/develop/doc/0000a423770ed0c6d80323d6c6b009>
- 微信公众平台文章违规抄袭申诉指引：<https://developers.weixin.qq.com/community/develop/doc/000ac652a802c81073b994b9a5c809>
- 小程序侵犯知识产权违规案例解析：<https://developers.weixin.qq.com/community/develop/doc/0006e4b67f8ec01684e99cc9b5b009>
- 小程序如何打开公众号文章？（社区回答，非官方）：<https://developers.weixin.qq.com/community/develop/doc/0004c0690f4590c3e684b338b6b400>

**本仓库实测记录**

- `docs/cloud-development.md`（云函数 403 + 请求头处理、环境 ID、函数权限）
- `docs/news-sources.md`（官网栏目范围与抓取实测）
- `cloudfunctions/newsSync/index.ts`（`REQUEST_HEADERS`，第 39 行 Chrome UA）
