# TagRec · 就看 Ta！

**按你的兴趣，在 B 站刷视频。**

一个 B 站首页油猴脚本：把「兴趣」变成可收藏、可编辑、可分享的配置，让推荐围绕它运转。基于 [magicdawn/Bilibili-Gate](https://github.com/magicdawn/Bilibili-Gate)。

[![许可证 GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)
[![安装 TagRec](https://img.shields.io/badge/安装-tagrec.cn-brightgreen)](https://www.tagrec.cn/install/)

**[安装](https://www.tagrec.cn/install/) · [分享集市](https://www.tagrec.cn/) · [使用指南](https://www.tagrec.cn/#usage-guide) · [Issues](https://github.com/yunomega/Bilibili-Gate-TagRec/issues)**

---

## 它解决什么

B 站首页推荐无法保存兴趣方向：今天想看的和算法想给的常常不是一回事。TagRec 让兴趣成为一等对象——

- **主题推荐。** 收藏的标签组是持续的推荐源；多个兴趣按权重交错混看，一组没货时其他组自动补位。
- **标签发掘。** 输入标签开始探索；条件编辑器支持标签、标题、简介、UP 主、分区按「任一 / 全部」组合，可挂排除规则；结果少时继续深挖。
- **标签收藏表。** 组名、成员、条件、权重、启用状态全部可维护，普通组和组合条件组并存。
- **分享集市。** 整套配置（含组合条件与排除规则）可发布到[集市](https://www.tagrec.cn/)供人挑选导入；作者改分享不影响你已导入的副本。
- **分层筛选。** 屏蔽 / 仅看规则可选临时、本组、全局三种作用域；「仅看 UP 主」可直连投稿搜索取数。

Bilibili-Gate 原有的首页推荐、动态、稍后再看、收藏、热门等入口全部保留。

## 三步开始

1. **安装。** 打开[安装页](https://www.tagrec.cn/install/)按向导装好脚本管理器与 TagRec。已有脚本管理器可直接从[脚本猫商店](https://scriptcat.org/zh-CN/script-show-page/8380)或[直链](https://www.tagrec.cn/dl/tagrec.user.js)安装；官网打不开时，到 [GitHub Releases](https://github.com/yunomega/Bilibili-Gate-TagRec/releases) 下载同版脚本。
2. **选兴趣。** 到[集市](https://www.tagrec.cn/)挑一份配置导入；或在 B 站「标签发掘」输入「旅游」「电影」等词自己探索。
3. **开始看。** 回 [B 站首页](https://www.bilibili.com/)打开「主题推荐」，选中兴趣，刷视频。

| 入口         | 适合                                     |
| ------------ | ---------------------------------------- |
| **主题推荐** | 持续刷收藏的兴趣，混看几个方向           |
| **标签发掘** | 临时探索一个题材，或单独查看某个标签组   |

## 常用功能速览

**整理兴趣** — 视频卡片上的标签入口可直接把标签收进组；组按权重获得展示份额，权重 0 的组暂停参与；收藏多了可按主题和一级组归类。

**筛选** — 右键视频卡片，按 UP 主 / 标题 / 简介 / 分区「屏蔽」或「仅看」。新装默认「淘沙」档（赞率 ≥2%），另有「全放」「只看高质量」。规则作用域三选一：

| 范围 | 什么时候选 |
| ---- | ---------- |
| 临时 | 只想这次这样看，换查询即清 |
| 本组 | 这个兴趣需要自己的规则，随组保存 |
| 全局 | 长期生效，范围见菜单说明 |

**导入与备份** — 粘贴分享链接 / ID / 导入码即可导入，预览时可处理同名冲突；「备份与导入 · JSON」用于换机备份。作者后续修改原分享不会改变你已导入的副本。

## 数据与隐私

- 收藏、筛选、已看记录全部保存在浏览器本地，不会自动发布。
- 标签推荐只请求 B 站接口；安装、更新、集市功能访问 `tagrec.cn`。
- 分享前请检查组名、简介、排除名单及是否携带个人过滤配置——昵称、UID、头像会随分享公开展示。发往分享站的请求不携带 B 站 Cookie 或 `access_key`。
- 未登录可浏览推荐；上传分享、点赞需 B 站登录态。

## 常见问题

<details>
<summary><b>装好了首页没变化？</b></summary>

回[安装页](https://www.tagrec.cn/install/)检查脚本管理器是否启用、浏览器设置是否完成，再刷新 B 站首页。同时启用其他改首页的扩展/脚本时，先只开 TagRec 排查。
</details>

<details>
<summary><b>「主题推荐」没有视频？</b></summary>

确认已保存或导入标签组并选中了包含它们的主题；检查组是否启用、权重 > 0；尝试放宽筛选或允许显示已看视频。
</details>

<details>
<summary><b>筛选后结果很少甚至为空？</b></summary>

检查是否开着「仅看」和遗留的临时条件，逐项放宽。冷门标签本身视频就少，可试相关标签或「继续深挖」。
</details>

<details>
<summary><b>已装过原版 Bilibili-Gate？</b></summary>

先备份原脚本设置，停用原脚本再装 TagRec，避免两个脚本同时改首页。标签收藏需要单独导入或建立。
</details>

<details>
<summary><b>怎么更新？手机能用吗？</b></summary>

脚本管理器自动检查更新，也可手动检查或回安装页覆盖安装，更新来自同一入口。手机可浏览集市挑配置，安装向导面向电脑浏览器。
</details>

其他问题到 [Issues](https://github.com/yunomega/Bilibili-Gate-TagRec/issues) 反馈，注明浏览器、脚本管理器、版本与复现路径。

## 开发

本仓为源码仓（`src/modules/tag-rec/` 为 TagRec 新增模块）。构建产物为油猴脚本 `dist/bilibili-gate-tagrec.user.js`。

```sh
pnpm install
pnpm build:real-build   # RELEASE=1 产出分发文件名与许可声明
pnpm typecheck && pnpm lint && pnpm test && pnpm test:licenses
```

详见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 衍生与二开

GPL-3.0 开源，欢迎 Fork、魔改、维护自己的版本，无需申请。

衍生版本可去 [Discussions](https://github.com/yunomega/Bilibili-Gate-TagRec/discussions) 里挂出来，让找得到你的人聚过去；分享包格式兼容的话，你的用户也可以直接用[集市](https://www.tagrec.cn/)。

衍生版本由各自作者独立维护，与官方版本无关、未经上游审查；请遵守 GPL-3.0，别作恶就好。

想合进上游的功能改动请先开 Issue 讨论——单人维护，Review 不承诺时限，但认真地写都有回应。

## 来源与许可

**非官方社区项目，与哔哩哔哩（bilibili.com）无任何隶属、合作或背书关系。**

基于 [magicdawn/Bilibili-Gate](https://github.com/magicdawn/Bilibili-Gate)（MIT）；上游部分实现源于 [indefined/UserScripts 的 bilibiliHome](https://github.com/indefined/UserScripts/tree/master/bilibiliHome)（MIT）。

本项目以 [GPL-3.0](LICENSE) 发布；上游 MIT 版权与许可保留于 [NOTICE](NOTICE)。第三方库、图标、字体按各自授权（MIT / Apache-2.0 / CC-BY-4.0 / ISC 等）；发布产物随包嵌入完整许可文本，逐件来源见 [licenses/](licenses/README.md)。
