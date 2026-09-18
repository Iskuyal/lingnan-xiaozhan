# 公众号文章作为资讯数据源的可行性核查

核查日期：2026-09-18。核查方式：本机（中国大陆住宅宽带出口 IP）用 `curl` 对公网发真实请求，逐条记录 HTTP 状态、响应体字节数与页面特征；官方接口部分只读 `developers.weixin.qq.com` 文档正文。

**状态：发现（枚举）与单篇抓取的 HTTP 行为已实测；官方接口只做了文档核查，未调用（无账号，无法调用）。**

## 本文与姊妹文档的分工

| 文档 | 回答的问题 |
| --- | --- |
| [`docs/reference/miniprogram-mp-content-rules.md`](./miniprogram-mp-content-rules.md) | **规则边界**：能不能用、合规风险、robots.txt、`web-view`/`wx.openOfficialAccountArticle`、转载侵权 |
| 本文 | **技术可行性**：第三方能不能*枚举*一个公众号的文章列表、能不能抓单篇、官方 API 长什么样、学校有哪些号 |

本文**不重复**论证合规问题。凡涉及「该不该做」，一律指向姊妹文档。特别地，姊妹文档已实测的 `mp.weixin.qq.com/robots.txt` 全文 `Disallow: /` 与「无浏览器特征 UA 被 302 到验证页」两条结论，本文直接沿用，不另测。

## 证据分级约定

沿用姊妹文档的分级，本文只用到这四级：

| 等级 | 含义 |
| --- | --- |
| **已验证（文档）** | 微信官方开发者文档正文原文，附精确 URL |
| **已验证（实测）** | 本轮发真实 HTTP 请求，记录到状态码与响应体特征；只代表本机 IP 与当日行为 |
| **第三方声明** | 开源项目文档 / 博客 / 社区帖的说法，本轮**未**逐条复现 |
| **未验证** | 本轮未取得任何依据 |

> 规矩：第三方声明只当线索，不当依据。本文所有「能/不能」的判断都来自上表前两级。

## 结论摘要

需求背景：团队**不拥有**任何公众号，目标账号属于学校；要覆盖 **2025-2026** 的资讯流。

| 问题 | 结论 | 等级 |
| --- | --- | --- |
| 搜狗微信的**公众号**搜索（`type=1`）能枚举账号吗 | **不能。** HTTP 200 但结果是空壳页，连「人民日报」都返回「暂无相关的官方认证订阅号」，说明该索引对匿名访问已失效 | 已验证（实测） |
| 搜狗微信的**文章**搜索（`type=2`）能用吗 | **部分可用但不够用。** 能拿到*标题 + 公众号名 + 发布时间*（每页 10 条，翻到第 4 页仍正常），但**拿不到文章 URL**；且学校各号的最新条目停在 **2023 年**，没有 2025-2026 内容 | 已验证（实测） |
| 搜狗文章结果能点进去拿到真链接吗 | **能，但脆。** 带会话 cookie + 间隔 5 秒时，`/link` 返回一段 856 字节 JS，把真实签名 URL 拆成碎片拼接；不带 cookie 时 302 到 antispider 验证码页 | 已验证（实测） |
| Bing / 百度 / 360 收录公众号文章吗 | **都不行。** Bing `site:mp.weixin.qq.com` 零结果（连「人民日报」也是零）；百度直接跳安全验证；360 零结果 | 已验证（实测） |
| **合集（`appmsgalbum`）能否服务端枚举文章列表** | **能，且是本轮唯一可用的枚举通道。** 无需 cookie、无需 `appmsg_token`、JSON 里直接给 `title` + `url` + `create_time` | 已验证（实测） |
| 上面这条能直接用在岭南吗 | **未验证。** 合集只覆盖号主主动归类过的文章；**学校有没有建合集无法从外部判定**，必须人工在微信里看一眼 | 未验证 |
| 单篇 `mp.weixin.qq.com/s/...` 能否服务端直取正文 | **能。** 条件是「完整规范 URL（带 `chksm`）」+「浏览器 UA」；正文在 `div#js_content`，标题/账号/时间在 `var msg_title` / `var nickname` / `var ct` | 已验证（实测） |
| 历史消息接口 `profile_ext` 还能列全部文章吗 | **不能。** `getmsg` 返回 `{"ret":-3,"errmsg":"no session"}`；`home` 返回「验证 / 请在微信客户端打开」 | 已验证（实测） |
| 官方 API 第三方能用吗 | **不能。** 发布能力、素材管理都要求**该公众号自己的** `access_token`；要代调用必须由号主扫码授权给第三方平台 | 已验证（文档） |
| 2025-2026 的可持续方案 | **只有「学校侧配合」一条**（详见文末建议路线） | 推断 |

**一句话结论：第三方无法从外部枚举学校公众号的文章列表。唯一不依赖学校配合的技术通道是「合集」，但它只覆盖号主归类过的文章，且学校是否使用合集本轮无法判定。抓单篇正文技术上完全可行，但拿不到「有哪些文章」这一步——发现环节是死的，抓取环节是活的。**

---

## Q1 发现：第三方能不能枚举一个公众号的文章列表

### 1a 搜狗微信 · 公众号搜索（`type=1`）—— 已失效

```bash
curl -sS -m 40 -o sogou_acc.html -w "HTTP=%{http_code} size=%{size_download}\n" \
  -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" \
  -H "Accept-Language: zh-CN,zh;q=0.9" \
  -G "https://weixin.sogou.com/weixin" --data-urlencode "type=1" --data-urlencode "query=广东岭南职业技术学院"
```

实测结果：**HTTP 200，11,029 字节**，`<title>` 为「广东岭南职业技术学院的相关微信公众号 – 搜狗微信搜索」——**看起来像正常结果页，但没有一条结果。**

结果容器是空的，页面正文给出明确的空态文案：

```html
<div class="news-box"></div>
<script>$(".news-box").remove();</script>
<div class="b404-box" id="noresult_part1_container">
  <p class="p1">呀！</p>
  <p class="p3">暂无与“<em>广东岭南职业技术学院</em>”相关的官方认证订阅号。</p>
</div>
```

**对照实验（关键）**：同样的命令把 `query` 换成 `人民日报`，返回 **HTTP 200，10,687 字节**，正文同样是：

> 暂无与“**人民日报**”相关的官方认证订阅号。

连头部账号都查不到，说明这不是「岭南没有号」，而是**该接口对匿名访问整体返回空**。（分级：已验证（实测））

注意页面里还有一行 `var account_anti_url = "";`，说明搜狗对账号搜索另有反爬开关，本轮观察到的是「空结果」而不是「验证码」，但结论一样：**不可用**。

### 1b 搜狗微信 · 文章搜索（`type=2`）—— 能拿元数据，拿不到 URL

```bash
curl -sS -m 40 -b ck.txt -c ck.txt -o s_art.html -w "HTTP=%{http_code} size=%{size_download}\n" \
  -A "<同上 Chrome UA>" \
  -G "https://weixin.sogou.com/weixin" --data-urlencode "type=2" --data-urlencode "query=广东岭南职业技术学院"
```

实测：**HTTP 200，35,445 字节**，`class="news-list"` ×1，`class="txt-box"` ×10，解析出 **10 条**结果，**没有验证码**。

每条结果的结构（真实片段，逐字）：

```html
<h3><a target="_blank" href="/link?url=dn9a_-gY295K0Rci_xozVXfdMkSQTLW6...&token=404A4902...">您好,我是<em>广东岭南职业技术学院</em></a></h3>
<p class="txt-info">大家好,我是岭南职业技术学院以下是我的简介...</p>
<div class="s-p">
  <span class="all-time-y2">广东岭南职业技术学院</span>
  <span class="s2"><script>document.write(timeConvert('1467123675'))</script></span>
</div>
```

**可提取字段**：标题、**公众号名**（`span.all-time-y2`）、**发布时间**（`timeConvert('<unix秒>'`）、摘要。**不可提取**：真实文章 URL（只有 `/link?...` 中转）。

翻页实测：`page=1/2/3/4` 均 **HTTP 200**，分别解析出 10 / 10 / 8 / 9 条，无验证码。

**索引新鲜度（决定成败的一条）**：四页结果里，学校各号最新的一条是——

| 公众号 | 最新可见条目日期 |
| --- | --- |
| 广东岭南职业技术学院（官微） | **2023-06-27** |
| 岭南崇礼书院 | 2023-04-11 |
| 岭南学生社区 | 2024-03-22 |
| 广东岭南成教 | 2019-05-21 |
| 岭南职院清远学生会分会 | 2019-06-17 |
| 广东岭南职院自考专升本 | 2023-09-26 |

四页之内**没有任何 2025 或 2026 年的条目**。→ **搜狗微信的文章索引无法支撑 2025-2026 的资讯流。**（分级：已验证（实测））

### 1c 搜狗 `/link` 跳转与 antispider

只拿到 `/link?...` 不够，必须跟到真链接。两种情形：

**（1）不带会话 cookie：被验证码拦住。**

```bash
curl -sS -m 30 -o /dev/null -D - -A "<Chrome UA>" -e "<搜索结果页 URL>" "https://weixin.sogou.com/link?url=dn9a_..."
```

实测响应头：

```
HTTP/1.1 302 Found
Location: http://weixin.sogou.com/antispider/?from=%2Flink%3Furl%3Ddn9a_...
```

跟随后的 **HTTP 200，6,002 字节**，正文（逐字）：

> 返回首页>> IP：183.52.244.167 访问时间：2026.09.18 10:04:15 VerifyCode：47f13a20ef3a From：weixin.sogou.com
> 此验证码用于确认这些请求是您的正常行为而不是自动程序发出的，需要您协助验证。 验证码： 提交

**（2）带上搜索结果页下发的 cookie + 间隔 5 秒：拿到 JS 中转页。**

实测 **HTTP 200，856 字节**，无 `<title>`，正文是一段把 URL 拆成碎片的脚本（逐字节选，URL 片段已截断）：

```html
<script>
    (new Image()).src = 'https://weixin.sogou.com/approve?uuid=' + 'c04ff3bc-...' + '&token=' + '4052EABF...' + '&from=inner';
    setTimeout(function () {
        var url = '';
        url += 'https://mp.';
        url += 'weixin.qq.c';
        url += 'om/s?src=3&';
        url += 'timestamp=1';
        ...
        window.location.replace(url)
    },100);
</script>
```

把 `url += '...'` 的片段顺序拼起来、去掉 `@`，就得到真实签名 URL。**拼接后实测链路**：

| 步骤 | 结果 |
| --- | --- |
| 拼出的 URL | `https://mp.weixin.qq.com/s?src=3&timestamp=1789697476&ver=1&signature=HMVk6QaHyfk*...` |
| 直取该 URL | **HTTP 200，3,517,345 字节** |
| `var msg_title` | `2017年广东岭南职业技术学院学考招生全攻略` |
| `var nickname` | `广东岭南职业技术学院` |
| `var ct` | `1490185214` → 2017-03-22 |
| `div#js_content` | 正文 7,413 字，含真实正文 |

而搜索结果页里第 1 条的标题与日期恰好是「2017年广东岭南职业技术学院学考招生全攻略 / 2017-03-22」——**搜索结果的元数据与最终抓到的文章 1:1 对得上**，说明这条链路是真实可用的。（分级：已验证（实测））

**但这条路不能作为数据源**：它依赖 cookie 会话、`tsn`/`sortby` 等参数、5 秒级限速与签名有效期，一旦限速或换 IP 就退化为验证码；而且**索引本身只到 2023 年**，链路能通也没内容可取。

### 1d 通用搜索引擎 —— 全部不可用

| 引擎 | 命令要点 | 实测结果 | 判定 |
| --- | --- | --- | --- |
| Bing | `curl -sSL "https://cn.bing.com/search?q=site%3amp.weixin.qq.com+<URL编码校名>&mkt=zh-CN"` | **HTTP 200，101,906 字节**，10 个 `b_algo`，**`mp.weixin.qq.com/s` 链接 0 个**；结果全是 `lnc.edu.cn`、`baike.baidu.com` 等，说明 `site:` 被忽略 | 不可用 |
| Bing 对照 | 同法问 `site:mp.weixin.qq.com 人民日报` | **HTTP 200，96,776 字节，`mp.weixin` 链接 0 个** | 不可用 |
| 百度 | `curl -sSL "https://www.baidu.com/s?wd=..."` | **302 → `https://wappass.baidu.com/static/captcha/tuxing_v2.html?...`**，落在 **HTTP 200，1,488 字节**，`<title>` 为「百度安全验证」 | 被拦 |
| 360 | `curl -sSL "https://www.so.com/s?q=site%3amp.weixin.qq.com+..."` | **HTTP 200，357,070 字节**，`mp.weixin` 链接 **0 个** | 不可用 |
| DuckDuckGo | `https://html.duckduckgo.com/html/?q=...` | `curl: (28) Failed to connect ... port 443`（本机网络到该站不通） | 未验证 |
| 搜狗网页 | `curl -sSL "https://www.sogou.com/web?query=..."` | **HTTP 200，388,683 字节**，能捞出 1–3 条 `http://mp.weixin.qq.com/s?src=11&...&signature=...` 签名链接（正文见 1c，可抓） | 可用但覆盖极低 |

搜狗网页是唯一给出可用链接的通用引擎，但一次查询只出 1–3 条签名 URL（签名有时效），且**搜不到 2025-2026 的学校推文**。同上，不能作为数据源。

### 1e 合集（`appmsgalbum`）—— 本轮唯一可用的服务端枚举通道

这是本轮最有价值的发现。**前提**：目标公众号必须建过「合集」（号主主动把文章归类进一个主题）。

`__biz` / `album_id` 取值来源：本轮**不是**我猜的，取自第三方项目公开的示例 URL（RSSHub 路由文档、RSSHub issue #20009、opencli 插件 README），再逐条实测。

```bash
# HTML 形态
curl -sS -m 40 -o album.html -w "HTTP=%{http_code} size=%{size_download}\n" -A "<Chrome UA>" \
  "https://mp.weixin.qq.com/mp/appmsgalbum?__biz=MzA3MDM3NjE5NQ==&action=getalbum&album_id=1375870284640911361"

# JSON 形态（关键）
curl -sS -m 40 -o album.json -w "HTTP=%{http_code} size=%{size_download} ctype=%{content_type}\n" -A "<Chrome UA>" \
  "https://mp.weixin.qq.com/mp/appmsgalbum?action=getalbum&__biz=MzA3MDM3NjE5NQ==&album_id=1375870284640911361&count=20&is_reverse=1&f=json"
```

实测结果（三个真实合集 URL 全部一致）：

| 观察项 | 结果 |
| --- | --- |
| HTTP 状态 | **200** |
| Content-Type | `application/json; charset=UTF-8`（`f=json`）/ `text/html; charset=UTF-8` |
| **是否需要 cookie / 登录** | **不需要**。全新 `curl`、无 cookie、无 `Referer` 也通 |
| **是否需要 `appmsg_token`** | **不需要**。不传该参数即返回数据 |
| 是否需要浏览器 UA | **不需要**。用 `curl` 默认 UA 也返回 `ret:0` |
| JSON 顶层 | `{"base_resp":{"exportkey_token":"","ret":0},"getalbum_resp":{"article_list":[...]}}` |
| 每条的字段 | `title`、`url`（含 `__biz&mid&idx&sn&chksm`，尾部 `#rd`）、`create_time`（Unix 秒）、`msgid`、`itemidx`、`cover_img_1_1`、`pos_num` |

真实响应节选（看理想《李想主义》合集，逐字）：

```json
{"base_resp":{"exportkey_token":"","ret":0},"getalbum_resp":{"article_list":[
 {"cover_img_1_1":"https://mmbiz.qlogo.cn/.../300","create_time":"1555305380","is_pay_subscribe":"0",
  "itemidx":"1","key":"3070376195_2650841427_1","msgid":"2650841427","pos_num":"1",
  "title":"我们与恶的距离，不是单靠死刑就可以隔开",
  "url":"http://mp.weixin.qq.com/s?__biz=MzA3MDM3NjE5NQ==&mid=2650841427&idx=1&sn=0732ae47ead575b83e44073a49f0393d&chksm=84c9cf3f...746ec446#rd"}
]}}
```

HTML 形态同样是**服务端渲染**：`li[data-link]` 恰好 10 个，`js_article_create_time` 恰好 10 个，账号名在 `album__author-name`（实测值：`看理想`）。**文章列表在 HTML 里，不需要 JS，不需要 `appmsg_token`。**

**两个落地细节（本轮踩到并实测确认）**：

1. **JSON 里的 `url` 是 `http://`，不是 `https://`。** 直接在 `curl` 里请求 `http://mp.weixin.qq.com/s?...` 得到 **HTTP 301，2,252 字节**（跳转壳）。把协议换成 `https://` 才是 **HTTP 200 + 正文**。解析器必须做一次 `http→https` 归一化。
2. **`url` 尾部的 `#rd` 要去掉。** 它是微信的锚点标记，带上不影响服务端（`#` 之后不会发给服务器），但入库/去重时建议先剥掉。

其余实测参数行为：

| 测试 | 结果 |
| --- | --- |
| `count=20` | **HTTP 200**，返回 20 条 |
| 用上页最后一条的 `msgid` + `itemidx` 作 `begin_msgid` / `begin_itemidx` 翻页 | **HTTP 200，`ret:0`**，再返回 20 条（下一页时间为 2019-12~2020-02），无报错 |
| 伪造 `album_id`（`album_id=1`） | **HTTP 200**，`{"base_resp":{"exportkey_token":"","ret":10004}}`（错误码而非验证码） |
| 用学校的真实 `__biz` + 伪造 `album_id` | **HTTP 200**，同样 `ret:10004` |

**这条通道的真正限制不在技术，在覆盖面**：

1. 只能拿到**号主主动归入该合集的文章**，不是该号的全部历史文章；没有合集就没有任何数据。
2. 必须**先知道 `album_id`**。而 `album_id` 只能从「已打开的文章页里已属于某合集」或微信客户端内复制合集链接获得——**这一步仍是手工的**。
3. 本轮**无法**用外部手段枚举一个 `__biz` 下的所有 `album_id`（这就是 `ret:10004` 那组测试想验证的：猜测会直接被拒）。

→ **判定：合集是「已知合集 → 全量拉取该合集文章」的高效工具，但它不解决「发现该号有哪些文章」的冷启动问题。**（分级：已验证（实测））

### 1f 历史消息接口 `profile_ext` —— 已封死

旧方案（`action=home` 列历史文章）本轮实测：

```bash
curl -sSL -m 40 -A "<iPhone MicroMessenger UA>" \
  "https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=MzA3MDM3NjE5NQ==&scene=124"
```

**HTTP 200，2,138 字节**，`<title>` 为「**验证**」，正文含 **「请在微信客户端打开」**。换浏览器 UA、换「看理想」的真实 `__biz` 结果相同（说明不是 `__biz` 错，而是接口本身要微信客户端会话）。

翻页用的 JSON 接口更直白：

```bash
curl -sSL -m 40 -A "<MicroMessenger UA>" \
  "https://mp.weixin.qq.com/mp/profile_ext?action=getmsg&__biz=MzA3MDM3NjE5NQ==&f=json&offset=0&count=10&is_ok=1&scene=124&is_direct=1"
```

**HTTP 200，111 字节，逐字**：

```json
{"base_resp":{"ret":-3,"errmsg":"no session","cookie_count":0},"ret":-3,"errmsg":"no session","cookie_count":0}
```

→ **「列出某号全部文章」这条最经典的路已被彻底关闭。**（分级：已验证（实测））

---

## Q2 单篇抓取：`mp.weixin.qq.com/s/...` 能不能服务端直取正文

**能。** 但有两个容易踩的硬条件。

### 2a 两个必需条件

测试样本（真实公开文章，任意公众号，非学校号）：

```bash
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
curl -sS -m 40 -o art.html -w "HTTP=%{http_code} size=%{size_download}\n" -A "$UA" \
  "https://mp.weixin.qq.com/s?__biz=MzA3MDM3NjE5NQ==&mid=2650841427&idx=1&sn=0732ae47ead575b83e44073a49f0393d&chksm=84c9cf3fb3be4629475d3af0b0d7a986db1ae4d2341e7c5508c3a664d5d4e03763fe746ec446"
```

| 条件 | 满足时 | 不满足时 |
| --- | --- | --- |
| **浏览器 UA** | **HTTP 200**，3,539,704 字节，含正文 | 用 `curl` 默认 UA → **HTTP 302**，`Location: https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=...&target_url=...`（即姊妹文档 4b 记录的验证闸门） |
| **完整规范 URL（必须带 `chksm`）** | 同上 | 把 `chksm` 去掉、只留 `__biz&mid&idx&sn` → **HTTP 302**，同样跳到 `wappoc_appmsgcaptcha` |

**第 2 条是本轮新发现，值得单独记**：`chksm` 不是可选参数。少一个参数，请求就从「拿到正文」变成「被判为可疑」。

### 2b 两个真实样本的解析结果

| 样本 | 公众号 | `var ct` | `msg_title` | `js_content` 正文字数 |
| --- | --- | --- | --- | --- |
| [`art1`](https://mp.weixin.qq.com/s?__biz=MzA3MDM3NjE5NQ==&mid=2650841427&idx=1&sn=0732ae47ead575b83e44073a49f0393d&chksm=84c9cf3fb3be4629475d3af0b0d7a986db1ae4d2341e7c5508c3a664d5d4e03763fe746ec446) | 看理想 | 1555305522 → 2019-04-15 | 我们与恶的距离，不是单靠死刑就可以隔开 | 7,507 |
| `art2` | SlowGrowth.慢速生长 | 1778801400 → **2026-05-14** | 11天，21章，我把一本书变成了可复用的AI工作流 | 8,689 |

`art2` 证明**机制对 2026 年的新文章同样有效**——问题从来不是「能不能抓新文章」，而是「怎么知道有新文章」。

### 2c 可解析字段清单（供解析器设计）

| 字段 | 页面中的形态 | 实测 |
| --- | --- | --- |
| 标题 | `var msg_title = '...'`；另有 `<meta property="og:title" content="...">` | 两个样本都命中；`og:title` 与 `msg_title` 一致 |
| 公众号名 | `var nickname = htmlDecode("...")` | 注意外层裹了 `htmlDecode(...)`，要剥壳 |
| 发布时间 | `var ct = "1778801400"`（Unix 秒） | 两个样本都命中 |
| `__biz` / `mid` | `var biz = "..."` / `var mid = "..."` | 两个样本都命中 |
| 正文容器 | `id="js_content"` | 两个样本都命中 |
| 原链接 | `var msg_link`（未逐字核对） | 本轮未作为依据使用 |

**提醒**：`已被删除` 这四个字在**四篇正常文章**的 HTML 里都出现了（逐字为「该内容已被发布者删除」之类的 JS 模板串）。**不能用 `includes('已被删除')` 判文章是否被删**，必须锚定到具体的空态容器，否则把正常文章误判为空。

### 2d 频率实测

8 篇连续请求、浏览器 UA、**零延迟**：

| 序号 | HTTP | 标题是否解析出 |
| --- | --- | --- |
| 1–8 | **全部 200** | 8/8 命中 |

8/8 全通。另有一轮混合测试中 9 次里出现 1 次 302（可能与该轮先用 `http://`、或前后请求状态有关），**未**复现为稳定限流。结论保守表述为：**当前 IP 与当日频率下未见硬限流；不可外推为「高频安全」**——姊妹文档已指出云函数出口是腾讯云机房 IP，风控策略与住宅 IP 不同。

---

## Q3 官方接口：有哪些、谁能用

### 3a 发布能力（freepublish）

来源：<https://developers.weixin.qq.com/doc/offiaccount/Publish/Publish.html>（分级：已验证（文档））

| 接口名 | 路径 |
| --- | --- |
| 获取已发布的消息列表 | `/cgi-bin/freepublish/batchget` |
| 删除发布文章 | `/cgi-bin/freepublish/delete` |
| 发布状态查询 | `/cgi-bin/freepublish/get` |
| 获取已发布图文信息 | `/cgi-bin/freepublish/getarticle` |
| 发布草稿 | `/cgi-bin/freepublish/submit` |

文档正文的限制原文（逐字）：

> 2025年7月起，个人主体账号、企业主体未认证账号及不支持认证的账号将被回收以上接口的调用权限。

即：**这些接口面向「认证服务号」；未认证主体 2025 年 7 月起已被回收权限。**

姊妹文档另引到更具体的一条（同一接口的订阅号版本文档）：`access_token` 属于**该公众号**，适用范围写「公众号：**仅认证**」，未授权调用返回 `48001 api unauthorized`。详见 [`miniprogram-mp-content-rules.md`](./miniprogram-mp-content-rules.md) 的 4d 节。

### 3b 素材管理

来源：<https://developers.weixin.qq.com/doc/offiaccount/Asset_Management/Get_materials_list.html>（分级：已验证（文档））

该页是总览，`服务号可以通过服务端接口，对永久/临时素材进行管理`，列出：

| 类别 | 路径 |
| --- | --- |
| 永久素材 | `/cgi-bin/material/get_material`、`/cgi-bin/material/get_materialcount`、`/cgi-bin/material/batchget_material`、`/cgi-bin/media/uploadimg`、`/cgi-bin/material/add_material`、`/cgi-bin/material/del_material` |
| 临时素材 | `/cgi-bin/media/get`、`/cgi-bin/media/upload`、`/cgi-bin/media/get/jssdk` |

文档只写明面向**服务号**，未在该页给出认证要求。

### 3c 微信开放平台：第三方平台（代调用）

来源：<https://developers.weixin.qq.com/doc/oplatform/Third-party_Platforms/2.0/getting_started/how_to_call_api.html>（分级：已验证（文档））

文档正文（逐字节选）：

> 服务商能否代商家成功调用某个公众号、服务号、小程序……的 API，取决于该公众号……管理员是否将对应的权限集授权给当前第三方平台账号。

> 调用 API 出现无权限的问题，常见的错误码为 `48001` 和 `61007`

授权流程来源：<https://developers.weixin.qq.com/doc/oplatform/Third-party_Platforms/2.0/api/Before_Develop/Authorization_Process_Technical_Description.html>（分级：已验证（文档））

关键点（逐字/转述）：

- 「公众号/小程序管理员**扫码**或者访问移动端授权链接，确认同意授权给第三方平台」；
- 服务商需先建「第三方平台」账号并配置**权限集**；
- 授权后用 `authorizer_access_token` 代替 `access_token` 调接口（有效期 7200 秒，用 `authorizer_refresh_token` 刷新）；
- 「上述提到的所有 API 调用需要验证调用者 IP 地址」（**IP 白名单**）；
- 授权参数 `auth_type=1` 表示仅展示公众号。

### 3d 三条都绕不开的硬边界

| 路径 | 谁必须行动 | 本团队能否独立完成 |
| --- | --- | --- |
| freepublish / 素材管理 | 需要**该公众号**的 `access_token`（即 AppID+AppSecret，掌握在学校手里） | **不能** |
| 第三方平台代调用 | 需要**学校公众号管理员扫码授权**给我们的第三方平台，并把所需权限集勾上 | **不能** |
| 抓 HTML | 无需任何人配合 | 能，但要先知道文章 URL，且规则上另有问题（见姊妹文档） |

**结论：没有任何一条官方 API 是「第三方不拥有账号、也未经号主授权」就能读该号已发布内容的。**（分级：已验证（文档））

### 3e 一个容易被误会的点

`freepublish/batchget` 返回的是**该号通过「发布能力」发布的内容**，**不是**该号历史上所有群发文章。即便学校配合开通了接口，**也不能假设能一次性取到 2025 年以来的全部推文**——历史群发内容的覆盖范围文档未明确说明。**这一点本轮未验证，落地前必须用真实账号实测。**（分级：未验证）

---

## Q4 程序化发现不可行时的手工路线与真实成本

结论先说：**手工路线可行、合规、零技术风险，但对「2025-2026 持续资讯流」这个需求，成本与 2-3 人学生团队的承受力不匹配。**

### 4a 手工路线长什么样

1. 在微信里打开目标推文 → 右上角「…」→ **复制链接**（得到 `https://mp.weixin.qq.com/s/...`）；
2. 粘贴进一个登记表（表格 / GitHub Issue / 小程序内隐藏的录入页）；
3. 服务端（云函数）按 Q2 的方法抓一次，只取**标题 / 发布号 / 发布时间**入库，正文不入库；
4. 小程序列表点进去用 `wx.openOfficialAccountArticle` 打开原文（姊妹文档 Q1 已确认可行）。

### 4b 成本估算

| 项 | 估算 | 依据 |
| --- | --- | --- |
| 单篇人工耗时 | 约 0.5–1 分钟（打开→复制→粘贴） | 步骤数固定，无网络等待 |
| 目标账号数 | 2–4 个（官微 + 团委/学生会/书院，见 Q5） | Q5 实测清单 |
| 假设日产出 | 官微级账号约 1 篇/天（历史报道提到「累计发布推文 350 篇/年」，约 1 篇/天） | 第三方声明（集团新闻稿） |
| **日成本** | **约 5–15 分钟/天**，且**每天都得有人做** | 上面两项相乘 |
| **年成本** | **约 30–90 小时**，覆盖在 2-3 人头上每人 10–45 小时 | 推算 |
| 断更后果 | 一天没人登记 = 当天资讯流缺一块，且**事后无法补**（发现环节不可回溯，见下） | Q1 结论 |

**最要命的不是「费时间」，是「不可回溯」**：一旦某天没人登记，那天的推文就再也找不回来了——因为第三方没有任何办法补列历史（搜狗索引停在 2023、`profile_ext` 已封、Bing/百度/360 不收）。手工路线实际上是**一份必须在当天完成的、不可漏的每日值班表**。

对 2-3 人的学生团队、且要打到 2026 年一整年，**这不是一个可以承诺的运维模式**。若学校愿意配合，正确做法是让学校侧走 3a 的接口或给一个「转载白名单」的转载授权，而不是靠人肉值班。

---

## Q5 学校公众号识别

### 5a 已确认的账号

| 公众号名 | 身份 | 识别方式 | `__biz` | 置信度 |
| --- | --- | --- | --- | --- |
| **广东岭南职业技术学院** | **官微**（校党委宣传部管理） | ①搜狗文章搜索显示该号名下的推文；②**抓到原文正文自述**（见下） | `MjM5MTAyNzY2NA==` | **高** |
| 岭南崇礼书院 | 书院号 | 搜狗文章搜索，名下推文 2022-06-16、2023-04-11 | 未取得 | 中 |
| 岭南学生社区 | 学生社区号 | 搜狗文章搜索，名下推文 2024-03-22 | 未取得 | 中 |
| 广东岭南成教 | 成教 | 搜狗文章搜索，名下推文 2019-05-21 | 未取得 | 中 |
| 岭南职院清远学生会分会 | 学生会分会 | 搜狗文章搜索，名下推文 2019-06-17 | 未取得 | 中 |
| 广东岭南职院自考专升本 | 非学校官方（自考机构） | 搜狗文章搜索，名下推文 2023-09-26 | 未取得 | 中（**排除为官微**） |
| 岭南职院专升本 | 非学校官方（培训机构） | 抓到原文，`nickname` = 岭南职院专升本 | `MjM5MzQ5NTYzMQ==` | 中（**排除为官微**） |

**官微的「一手证据」**：抓到的 2015-10-15 那篇推文正文逐字写着——

> 广东岭南职业技术学院官方微信
> 广东岭南职业技术学院官方微信公众平台（微信号：lnc-news）由校党委宣传部管理，是岭南职业技术学院校园信息的权威发布平台……

即：**官微名称 = 广东岭南职业技术学院，微信号 = `lnc-news`，管理单位 = 校党委宣传部。** 该结论来自公众号自己发布的原文，不是第三方转述。（分级：已验证（实测，原文自述））

外部旁证（第三方声明，未独立核实）：集团新闻稿 <https://lnedugroup.com/xwzx/jtxw/content_1533> 与 <https://www.scvedugroup.com/xwzx/content_1602> 称「广东岭南职业技术学院官微」由学院党政办公室、党委宣传部指导，2024 年获广东高校新媒体影响力（高职高专组）二等奖、全国高职高专官微百强第 22 名。**与本轮抓到的原文自述一致，但等级只算第三方声明。**

**易混淆项（务必注意）**：搜索「岭南 公众号」会频繁命中 **广东岭南现代技师学院**（例如 `https://mp.weixin.qq.com/s/qwqptEAn7HN0w2UrZ14dug`，2025 级新生入学教育）。它是**技师学院**，与广东岭南职业技术学院**不是同一法人**。把它当作本校号会把错误内容带进小程序。

### 5b 团委页脚二维码：能下能解，但解不出账号名

```bash
curl -sSL -m 40 -o wx_qr.jpg -w "HTTP=%{http_code} size=%{size_download} ctype=%{content_type}\n" \
  -A "<Chrome UA>" "https://lnc.edu.cn/content/tw/base/img/wx.jpg"
```

实测：**HTTP 200，20,129 字节，`image/jpeg`，258×258**。

用 `jimp` + `jsqr` 解码（本机 `npm i jimp jsqr`），**成功解出**：

```
http://weixin.qq.com/r/3Tjv9wnEXFQjrU2U923P
```

**但这条链接解不出账号名**。跟随实测：

| 步骤 | 结果 |
| --- | --- |
| `http://weixin.qq.com/r/...` | **HTTP 302** → `https://weixin.qq.com/r/...` |
| 该页 | **HTTP 200，597 字节**，无 `<title>`，正文只有一段 JS：`window.location="http://weixin.qq.com/d"`（即「下载微信」页） |
| 换 MicroMessenger UA 再取 | **HTTP 200，814 字节**，仍是同一个跳转壳，无账号信息 |
| 页面内 `__biz` | **无** |

→ **该二维码是「微信内扫码关注」类型，服务端解析只落到微信下载页，拿不到 `__biz` 或昵称。要确认它属于哪个号，只能在微信 App 里扫。**（分级：已验证（实测））

补充：这个二维码是**团委**页脚的码，**不一定是官微的码**——它更可能是团委自己或某个学生组织的号。**不能把它当作官微账号的证据。**

### 5c 未能识别的账号

| 目标 | 尝试过的手段 | 结果 |
| --- | --- | --- |
| 团委 / 学生会 / 各书院的独立公众号名 | 搜狗 `type=1` 账号搜索 | 返回空（1a，接口失效） |
| 同上 | 搜狗 `type=2` 文章搜索 | 只捞出「岭南崇礼书院」「岭南学生社区」「岭南职院清远学生会分会」等，**没有团委/学生会的独立号** |
| 官微是否建有「合集」 | ①抓到的 3 篇官微文章里查 `appmsgalbuminfo`；②搜狗网页搜 `appmsgalbum` + 校名 | ①**0 个数字型 `album_id`**（对照：看理想的合集内文章有 `appmsgalbuminfo: { album_id: '1375870284640911361', title: '李想主义', ... }`）；②无结果 |
| 官微索引是否还有 2025-2026 文章 | 搜狗文章搜索 4 页 | **没有**，最新 2023-06-27 |

**判读**：抽到的 3 篇官微文章（2015 / 2017 / 2022）**都不属于任何合集**。这**不构成**「官微没有合集」的结论——只说明抽样到的那几篇没有。**官微是否使用合集，必须在微信 App 里人工确认一次**（打开官微任一近期推文，看标题下方有没有「合集」入口）。这是决定「合集路线」能否启用的唯一前置条件。

### 5d 顺带发现的官网侧变化（影响现有云函数）

本轮多次访问 `lnc.edu.cn` 后，站点 WAF 对本机 IP 下发 **HTTP 403，392 字节**，正文逐字：

> 183.52.244.167，检测到您的IP在短时间内发起多次请求，疑似正在对网站进行CC攻击，因此您的IP将被冻结一段时间。如果您是正常的网站监测扫描，为避免因为您的扫描而影响网站正常运行，请您调整扫描软件的并发请求数设置（**每秒不能多于1个页面请求**），以免被系统自动冻结IP而影响扫描结果！

- 触发页面：`https://lnc.edu.cn/tw`、`https://lnc.edu.cn/xyxw/xydt` 均 403；
- **冷却后仍 403**：间隔 45 秒、再间隔 60 秒各重试一次，两次都还是同样的 403 页（冻结不是秒级）；
- 但静态图片 `https://lnc.edu.cn/content/tw/base/img/wx.jpg` 仍 **HTTP 200**（静态资源与页面走不同策略）。

这与 `docs/news-sources.md` 记录的「官网列表页可稳定抓取」**不矛盾**（那是低频、单线程抓取），但它给出一个**明确的运维红线**：官网同步**每秒不得超过 1 个页面请求**，否则会整站 403 且解冻缓慢。`docs/cloud-development.md` 已记录现有 403 处理方案，建议把这条写进那里。（分级：已验证（实测））

---

## 未验证与被阻塞

以下事项本轮**未验证**，不得当作已完成能力或已成立结论：

- [ ] **官微（及其他学校号）是否建有「合集」** —— 决定 Q1e 通道能否启用。需在微信 App 内人工确认。
- [ ] **任何真实 `album_id` 是否属于学校账号** —— 本轮用的三个 `album_id` 全部来自第三方项目文档，均非学校账号。
- [ ] `freepublish/batchget` 对**历史群发文章**的覆盖范围（3e）。
- [ ] 官方接口的真实调用 —— 无账号，未调用；全部结论来自文档正文。
- [ ] 云函数环境（腾讯云机房 IP）下的 `mp.weixin.qq.com` 抓取行为 —— 本轮全部为住宅 IP；机房 IP 风控可能更严（姊妹文档已提示）。
- [ ] 团委/学生会/书院等**独立公众号的准确名称与 `__biz`** —— 搜狗账号搜索失效，未能识别。
- [ ] 搜狗 `type=2` 的 `tsn=1`（限时）过滤 —— 实测返回 **HTTP 200，6,694 字节、0 条结果**的空白页，无法判断是「当天无内容」还是「该过滤参数已失效」，故未作为结论。
- [ ] 二维码归属 —— 解出的 `weixin.qq.com/r/...` 链接服务端不透露账号，只能在微信 App 内扫码确认。

## 附：本轮实测命令与原始观测索引

| 编号 | 目标 | 关键命令 | 观测 |
| --- | --- | --- | --- |
| T1 | 搜狗账号搜索 | `curl -G weixin.sogou.com/weixin --data-urlencode type=1 --data-urlencode query=<校名>` | 200 / 11,029 B / 空态 `b404-box` |
| T1c | 同上对照 | `query=人民日报` | 200 / 10,687 B / 同样空态 |
| T2 | 搜狗文章搜索 | `... --data-urlencode type=2 ...` | 200 / 35,445 B / 10 条 / 无验证码 |
| T2p | 搜狗翻页 | `... --data-urlencode page=2/3/4` | 200 / 10·8·9 条 / 最新学校条目 2023-06-27 |
| T3 | 搜狗 `/link`（无 cookie） | `curl -D - weixin.sogou.com/link?url=...` | 302 → `antispider` → 200 / 6,002 B 验证码页 |
| T3b | 搜狗 `/link`（带 cookie + 5s） | 同上，附 `-b ck -c ck -e <搜索页>` | 200 / 856 B / JS 碎片拼 URL |
| T3c | 拼接后签名 URL | `curl -A <Chrome> <拼出的 URL>` | 200 / 3,517,345 B / 标题·日期与搜索结果 1:1 一致 |
| T4 | Bing | `curl -sSL "cn.bing.com/search?q=site%3amp.weixin.qq.com+<编码校名>&mkt=zh-CN"` | 200 / 101,906 B / 10 b_algo / **0** `mp.weixin/s` |
| T4c | Bing 对照 | `site:mp.weixin.qq.com 人民日报` | 200 / 96,776 B / **0** `mp.weixin/s` |
| T5 | 百度 | `curl -sSL "baidu.com/s?wd=..."` | 302 → `wappass.baidu.com/static/captcha/...` → 200 / 1,488 B「百度安全验证」 |
| T6 | 360 | `curl -sSL "so.com/s?q=..."` | 200 / 357,070 B / **0** `mp.weixin/s` |
| T7 | 搜狗网页 | `curl -sSL "sogou.com/web?query=..."` | 200 / 388,683 B / 1–3 条 `src=11` 签名链接 |
| T8 | 合集 HTML | `curl "mp.weixin.qq.com/mp/appmsgalbum?__biz=...&action=getalbum&album_id=..."` | 200 / 325,188 B / `data-link`×10 / `js_article_create_time`×10 |
| T9 | 合集 JSON | `...&count=20&is_reverse=1&f=json` | 200 / 13,894 B / `ret:0` / 20 条含 `title`+`url`+`create_time` |
| T10 | 合集翻页 | `...&begin_msgid=<上页末条>&begin_itemidx=1` | 200 / 13,057 B / `ret:0` / 再 20 条 |
| T11 | 合集错误码 | `album_id=1` | 200 / 48 B / `{"base_resp":{"exportkey_token":"","ret":10004}}` |
| T12 | 单篇（规范 URL + 浏览器 UA） | 见 2a | 200 / 3,539,704 B / `msg_title`+`nickname`+`ct`+`js_content` |
| T13 | 单篇（缺 `chksm`） | 同上去掉 `chksm` | 302 → `wappoc_appmsgcaptcha` |
| T14 | 单篇（默认 curl UA） | 同上不传 `-A` | 302 → `wappoc_appmsgcaptcha` |
| T15 | 频率 | 8 篇连续、零延迟、浏览器 UA | 8/8 全 200 |
| T16 | `profile_ext` home | `mp/profile_ext?action=home&__biz=...&scene=124` | 200 / 2,138 B / 标题「验证」/「请在微信客户端打开」 |
| T17 | `profile_ext` getmsg | `...&action=getmsg&f=json&...` | 200 / 111 B / `{"ret":-3,"errmsg":"no session"}` |
| T18 | 团委二维码 | `curl lnc.edu.cn/content/tw/base/img/wx.jpg` | 200 / 20,129 B / JPEG 258×258 |
| T19 | 二维码解码 | `node` + `jimp`+`jsqr` | `http://weixin.qq.com/r/3Tjv9wnEXFQjrU2U923P` |
| T20 | 二维码跟随 | `curl -sSL weixin.qq.com/r/...` | 200 / 597 B / JS 跳 `weixin.qq.com/d` / 无 `__biz` |
| T21 | 官微原文自述 | 拼接签名 URL 取 2015-10-15 推文 | 正文含「微信号：lnc-news……由校党委宣传部管理」 |
| T22 | 官网 WAF | `curl lnc.edu.cn/tw` | 403 / 392 B /「每秒不能多于1个页面请求」 |

## 建议路线

**推荐（唯一可持续）：把公众号交给学校侧，而不是第三方去取。**

1. **当下**：P3 资讯继续以**官网**（`lnc.edu.cn`）为唯一自动数据源——它已验证、合规、可控，且已有解析器。**不要把公众号加入自动发现链路。**
2. **公众号条目的过渡形态**：只做「人工登记链接 → 云函数取元数据（标题/号名/时间）→ 小程序用 `wx.openOfficialAccountArticle` 打开原文」，**正文不入库、不重排**（与姊妹文档结论一致）。
3. **向学校（党委宣传部，即官微管理单位）提一次合作请求**，请其在三条里选一条：
   - 给小程序**开转载授权/白名单**；或
   - 由学校自己在公众号后台调用 `freepublish/batchget` 取数后提供给我们（学校掌握 `access_token`，这条路最干净）；或
   - 把我们的第三方平台加入**授权**（管理员扫码 + 勾权限集 + IP 白名单）。
4. **落地前必须先做的一个 20 分钟人工探针**：在微信 App 里打开官微任一近期推文，看有没有「合集」入口。
   - **有** → 复制该合集链接，用 Q1e 的接口即可稳定拉到该合集全部文章（含 `create_time`，天然适配 2025-2026 过滤）。这是**唯一**不需要学校配合且能自动发现的技术通道，值得优先验证。
   - **没有** → 合集路线作废，公众号自动发现到此为止，按第 2、3 条走。

**明确不做**：用搜狗链路做生产数据源（索引停在 2023，且验证码随时会拦）；用通用搜索引擎（零收录）；用 `profile_ext`（已封）；对 `wappoc_appmsgcaptcha` 做验证绕过（规则问题见姊妹文档 4e）。
