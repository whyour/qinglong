# ADR-0373：Profile 可达的 Runtime JavaScript 投影

- 状态：Accepted
- 日期：2026-08-11
- 关联：QL-RFC-0001 D-240、D-263、D-270、D-281、D-284、D-285，ADR-0257、ADR-0358、ADR-0369、ADR-0372
- Supersedes：ADR-0369 中“最终 Local Profile 不删除任何 JavaScript”的阶段性限制；不改变源码、`pnpm pack`、Cluster/Worker 制品或外部 npm package

## 背景

D-284 后，Edge/Standalone Application+AI 达到 6,281,428/6,281,560 bytes，距固定 6 MiB 上限只余 10,028/9,896 bytes。新增能力属于可选 Local API，但当前最终制品仍完整携带每个已安装内部 package 的全部 JavaScript；因此即使默认 Application 不加载 API，新 SQLite repository 仍消耗所有 Local Profile 的闪存。

继续按单文件建立 workspace package 会扩大 manifest、lockfile、importer 和安装面，也违背 D-278 的薄包 ratchet。提高预算同样没有物理设备证据。应保持领域 package 边界不变，在最终 Profile 已确定入口、内部 package 集合和 export map 后，对包内运行文件做第二层可达性投影。

## 决策

1. 投影只发生在 Local Profile 完成精确 `pnpm pack`、离线安装和 package closure 核对之后；源码目录、发布 archive、开发类型、Cluster/Worker 镜像与外部 npm package 不变。
2. 裁剪器在任何 mutation 前 inventory 全部 `node_modules/@qinglong/*` regular file、解析全部直接 manifest，并解析全部内部 JavaScript 的 literal `require()`、`require.resolve()` 和 dynamic `import()`。出现非 literal module load、未证明的 `@qinglong/*` 文本、绝对/反斜线/query/hash/逃逸相对 specifier、缺失或 symlink target 时失败关闭。
3. 图根只来自调用方显式 Profile entry、保留的 manifest `bin`、无 `exports` package 的 `main`，以及遍历中实际遇到的内部 package export。相对 JavaScript target 与内部 export target 递归进入同一可达闭包；Node builtin、已安装外部 package 与非 JavaScript asset 不进入内部图。
4. 有 `exports` 的 package 只有在 `.` 被保留时才保留 `main`；否则同时投影掉不可达 `main`，避免 manifest 指向已删除文件。所有保留 runtime condition/target、name/version/license/engines、production/optional/peer dependency 与 SBOM 事实不得改写。
5. 所有 `dist/migrations/**` JavaScript、全部非 JavaScript asset、license、保留 bin target 及其递归闭包无条件保留。不得删除数据库迁移账本、Shell launcher、schema/JSON/证书或其他运行数据。
6. 只有不在上述闭包内的内部 `.js` 才能删除；对应 `.d.ts`/`.map` 仍按既有规则移除，保留 JavaScript 的 source-map 尾指令继续原子清理。所有解析、图构建、export/main 投影与 target 校验必须在第一次 unlink/rename 前完成。
7. 报告新增 JavaScript before/after/removed 文件数与回收字节；空 package、被删 entry/bin/migration、残留 manifest target 或删除后 import probe 失败都必须使 artifact 构建失败。
8. 14 个 Profile 继续执行真实 require/CLI probe、package closure、文件/字节/RSS 门。Application+AI 在不放宽 6 MiB 上限的前提下必须恢复至少 64 KiB 余量；默认 Edge/Standalone 的 package/module/RSS closure不得扩大。
9. 不新增 workspace package、第三方依赖、runtime authority、listener、connection、timer、migration、cache 或默认产品能力。

## 不采用方案

- **新增 Local API SQLite 微包**：只有一个 repository，制造新的 workspace/importer 边界却没有独立部署或 authority 生命周期。
- **忽略 dynamic import**：会删除配置启用后才加载的合法能力；literal dynamic import 必须进入静态闭包。
- **只按一次 `require.cache` 删除文件**：一次探针不能覆盖启动后按配置触发的分支。
- **JavaScript minify/bundle**：改变堆栈、文件身份和动态加载语义，审计面显著更大。
- **删除 migration 或 asset**：会让 fresh/adopted/recovery 路径在运行时才失败。
- **提高 6 MiB 上限**：掩盖包内不可达内容，没有固定设备证据。

## 完成门

- 正向覆盖跨 package export、相对 require、literal dynamic import、循环、bin、无 exports main、migration 与 asset 保留；
- 负向覆盖非 literal load、未证明内部 specifier、逃逸/缺失/symlink target、坏 manifest、删除后残留 target 与 fail-before-mutation；
- Runtime Artifact Pruner、Local Image、package/dependency boundary、完整 backend 与 18-package clean build/test 全绿；
- 14 个 Profile artifact 全部 compatible，Application+AI 至少保留 64 KiB 余量，默认 Edge/Standalone package/module/RSS closure 不扩大；
- 默认 arm64 Local image 在 Edge 128 MiB/64 PIDs 与 Standalone 256 MiB/256 PIDs 下保持 read-only/network-none、graceful stop 与 SQLite integrity `ok`。

## 实现与证据

2026-08-11 完成实现并通过全部门禁：

- 裁剪器在 mutation 前完成全量 manifest/JavaScript inventory、literal module-load 解析、内部 export 与相对目标解析，再以固定入口、bin、无 `exports` 的 `main`、migration 和递归 import 构造闭包；报告新增 `runtimeJavaScript` 文件与字节事实。10 项正反契约与 7 项 Local Image 静态契约全部通过。
- 14 个 Edge/Standalone artifact 全部 compatible。基础档由 317 个 JavaScript 收敛为 230 个，回收约 1.31 MiB；Application 由 409 收敛为 311，回收 1,432,936 bytes；Application+AI 由 566 收敛为 394，回收 2,074,217 bytes；MCP 由 349 收敛为 166，回收 2,740,531 bytes。真实 import/CLI probe 的 loaded module 数保持基础 50、Application+AI 133、MCP 210，未因文件裁剪扩大运行闭包。
- 最紧 Application+AI 为 Edge 4,211,316 bytes、Standalone 4,211,448 bytes，距既有 6 MiB 上限分别保留 2,080,140/2,080,008 bytes，超过 64 KiB 最小余量且未放宽预算。基础 Edge/Standalone 为 2,385,220/2,385,298 bytes；API 为 3,524,048/3,524,192 bytes；AI 为 2,916,611/2,916,701 bytes；MCP 为 7,151,104/7,151,212 bytes，各自继续受既有 Profile 门约束。
- 18-package clean build/test 退出 0；完整 backend 为 1,163 pass、2 skip、0 fail；package/dependency boundary 全绿。workspace 仍为 18 package、1,028 source，其中 1,010 nested、18 个受审根 entry，无 single-source 或 shallow package；未新增 package、依赖或 runtime authority。
- 最终 arm64 Local image 构建实际删除 98 个不可达 JavaScript、回收 1,432,936 bytes；`node_modules` 为 10 package、380 files、3,284,831 bytes，低于 640 files/5 MiB 门。Edge 128 MiB/64 PIDs 与 Standalone 256 MiB/256 PIDs 均在非 root、read-only、network-none、drop-all-capabilities 下 active→SIGTERM→graceful stop，SQLite integrity 为 `ok`。

因此本 ADR 的完成门已经闭合。它只收敛最终 Local Profile 的物理文件集合，不把包内文件重新定义为 workspace package，也不改变源码/发布 archive、Cluster/Worker 制品、数据库或依赖树。
