# 随包许可与来源

这里保存发行所需的许可原文、署名和有来源依据的补充记录。它们会进入用户安装脚本及 `THIRD_PARTY_NOTICES.txt`。个人研究记录仍在被忽略的本地目录，不进入构建或提交。

## 生成与检查

[构建插件](../scripts/release-licenses.mjs)在 userscript 插件合并 chunk 之前读取实际模块，覆盖动态加载模块；另补入脚本 `@require` 中的运行库、生成的运行时助手及内联 SystemJS。每个依赖保留安装包中的 LICENSE、LICENCE、COPYING、COPYRIGHT 和 NOTICE，不只读取 `package.json` 的许可名称。

图标按构建模块实际使用的集合与名称收集，不依据可能过时的自动导入类型声明。`overrides.json` 对运行库按准确版本匹配，对图标许可文本按 `@iconify/json` 版本匹配；更新图标数据后需要重新核对。图标原作者、来源、许可和 SVG 转换说明随包交付，Lucide 的 ISC 与 Feather 派生图标的 MIT 均保留。Lets Icons 保留 Leonid Tsvetkov、原始 Figma 来源、CC BY 4.0 链接及转换说明。

构建输出 `release-licenses.json`，其中 `pending` 是尚未处理的实际缺项。配套私有仓库的发布脚本检查缺项、脚本/声明哈希及嵌入内容，通过后才覆盖本地发布目录和部署。清单属于工程检查记录，通过不代表已经完成每份资源的全部权利链审计。

## 需要补充正文的 npm 包

| 精确版本                      | 随包处理与来源                                                                                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@ant-design/icons-svg@4.6.0` | npm 包缺少 LICENSE，从[匹配版本的源码提交](https://raw.githubusercontent.com/ant-design/ant-design-icons/7f2516ac91226d2b41f93b35cb5197c8d94f7189/LICENSE)保留完整 MIT                                                                                                               |
| `ahooks@3.10.0`               | 从[官方 v3.10.0 对应提交](https://raw.githubusercontent.com/alibaba/hooks/39a07ee8385cc61d080913bef4655e29a8765f0c/LICENSE)保留完整 MIT；npm gitHead 实际指向旧版本，未据其认定许可                                                                                                  |
| `is-mobile@5.0.0`             | 完整 MIT 正文在[该版本 README](https://raw.githubusercontent.com/juliangruber/is-mobile/2708dd8f07d91f354a46b8dff3053abb6b840067/README.md)中，按原段落保留                                                                                                                          |
| `valtio-select@0.3.0`         | [该版本 README](https://raw.githubusercontent.com/ts-zen/valtio-select/fe7825045b51a8e185c7e69bf70c5b225ce3c5b8/README.md)明确声明 `Copyright © 2025 tszen` 与 MIT；原 LICENSE 仅有免责段，仍原样保留。另明确附上由发布方依据 README 声明整理的标准 MIT 补充，不把补充冒充上游原文件 |

根 LICENSE 为本项目的 GPL-3.0 正文；`magicdawn/Bilibili-Gate` 与 `indefined/UserScripts` 的 MIT 版权归属及许可正文统一保留在根 `NOTICE`，并以 `projectNotices` 随包嵌入产物（原文分别存于 `packages/bilibili-gate-upstream.txt` 与 `packages/indefined-userscripts.txt`）。

## 已替换的无授权资产

- `purple-colors@0.0.1`（MIT 声明但无许可正文）已移除；「紫定能行」主题组改为内联标准 CSS 命名紫色表（`src/components/ModalSettings/theme.shared.tsx`）。
- `src/modules/icon/` 下 B 站字体转换的 SVG（fresh-space、history-record）与手工内嵌素材（stat-icons、直播 GIF、稍后再看 SVG）已全部替换为 `licenses/icons/` 已登记许可的 iconify 集合（icon-park-outline、tabler、mdi、mingcute、material-symbols、lucide、svg-spinners），图标署名随构建自动收集。

`dist/release-licenses.json` 的 `pending` 为空时 `pnpm check:distribution` 才通过。
