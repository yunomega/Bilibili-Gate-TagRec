# 本地开发说明

本仓库保存 TagRec 的脚本源代码。配套网站与服务端独立维护，不属于本次脚本开源准备。用户安装与更新统一使用 [tagrec.cn 安装页](https://www.tagrec.cn/install/)。

## 环境与常用命令

使用 Node.js 24 和项目 `package.json` 中 `packageManager` 指定的 pnpm。已有工作副本中运行：

```sh
corepack enable
pnpm install
pnpm dev
```

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:licenses
pnpm build:real-build
```

构建产物位于 `dist/`。`pnpm build` 会在构建后启动预览；只生成产物时使用 `pnpm build:real-build`。

`pnpm test` 只收集 `src/` 内的源码测试，避免收集本地研究目录与旧工作副本。`pnpm test:licenses` 单独检查许可构建逻辑。

构建同时生成 `LICENSE.txt`、`THIRD_PARTY_NOTICES.txt` 和 `release-licenses.json`，第三方声明也嵌入安装脚本。清单内 `pending` 非空时只能作为本地草稿，发布脚本会停止。许可来源及补充方式见[许可清单说明](../licenses/README.md)。生成非压缩发行草稿后，运行 `pnpm check:distribution` 核对缺项、哈希与嵌入声明；检查失败时不能发布。

本地构建的脚本版本默认来自 Git 的 annotated tag；发布构建通过 `RELEASE=true` 使用 `package.json` 版本。`MINIFY=false` 可显式保留未压缩产物。

没有旧 Git 标签的源码快照也可以构建。POSIX shell 使用 `RELEASE=true MINIFY=false pnpm build:real-build`；PowerShell 使用：

```powershell
$env:RELEASE = 'true'
$env:MINIFY = 'false'
pnpm build:real-build
```

`tag-rec` 是自有功能分支。维护上游更新时，应检查已有改动和测试，不把本地开发分支直接推送到上游仓库。

## 发布说明

许可证义务与产物检查：`pnpm test:licenses` 校验许可清单，`pnpm check:distribution` 核对构建产物内嵌的第三方声明。许可来源与待处理项见 [licenses/README.md](../licenses/README.md)。

GitHub CI 只执行检查与本地构建，不写发布分支、Release 或网站。
