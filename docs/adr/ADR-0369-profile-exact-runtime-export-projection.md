# ADR-0369：Profile 精确 Runtime Export 投影

- 状态：Accepted
- 日期：2026-08-11
- 关联：QL-RFC-0001 D-240、D-263、D-270、D-279、D-280、D-281，ADR-0257、ADR-0351、ADR-0358、ADR-0367、ADR-0368

## 背景

D-280 后 Edge/Standalone Application+AI 制品达到 6,281,356/6,281,488 bytes，距固定 6 MiB 上限只剩 10,100/9,968 bytes。下一产品闭环需要把已有低敏 RunEvent 时间线带到 Local/Cluster HTTP；若直接把共享投影加入 Runtime Core，最紧路由设备制品很可能先突破预算。

最终 Profile 已经完成精确 `pnpm pack`、离线安装、package closure 核对，并删除内部声明/map 与无运行意义的 manifest 字段，但仍保留每个内部 package 的全部公开 runtime export。Application+AI 中 Runtime Core 106 个、Local SQLite 52 个、Local Admin 23 个、AI 60 个 export，实际该 Profile 只引用其中一部分。只读测算表明：保持全部 JavaScript、依赖、`main`、`bin`、license 与入口语义不变，仅删除未被本 Profile 静态引用的 export key，可回收约 34 KiB。

## 决策

1. 源码 package manifest、`pnpm pack` 产物与 Cluster/Worker 制品保持完整；投影只发生在 Local Profile 精确离线安装并核对 package 集合之后。
2. 裁剪器在任何 mutation 前 inventory 全部 `node_modules/@qinglong/*` regular file、解析全部直接 manifest，并扫描全部内部运行 JavaScript。只承认 literal `require()`、`require.resolve()`、literal dynamic `import()` 与调用方显式声明的 Profile entry specifier；出现无法证明的动态 `@qinglong/*` 组装必须失败关闭。
3. entry specifier 必须 canonical、属于已安装内部 package，并能映射到该 package 已声明的精确 export key。内部 JavaScript 引用的每个 `@qinglong/*` specifier 也必须满足相同条件；唯一例外是 Profile 显式排除、确实未安装，且引用方 manifest 将其声明为 `workspace:*` 或与引用方相同精确版本的 development-only 可选 feature。未声明/已安装却排除的 package、未导出 subpath、重复/畸形入口或逃逸 target 均在 mutation 前失败。
4. 只从 `exports` 删除未被上述闭包引用的 key，并继续删除精确 `types` condition。保留顺序按源码 manifest；不得修改仍保留 export 的 runtime condition/target，不得删除或改写任何 JavaScript、migration、asset、`main`、`bin`、name/version/license/engines、production/optional/peer dependency 或 SBOM 事实。
5. 每个保留的 runtime export target 必须解析为同 package 内现存 regular file，拒绝绝对路径、`..`、symlink、缺失文件和不支持的 condition shape。所有语义验证先于 mutation，每个 manifest 使用既有同目录原子替换；构建失败时丢弃临时 artifact/image layer，不承诺多个 manifest 之间存在跨文件事务。
6. 报告增加 export key 的 before/after/removed 数与回收字节，并保持现有 development/map/manifest projection 分项。空引用 package 不允许自动清空 exports；必须由 entry、内部引用或显式无投影结论证明。
7. 14 个 Local Profile artifact 都传入各自固定入口并在投影后执行真实 require/CLI probe；默认 Local Application image 传入固定产品入口并复用同一裁剪器。预算、package/file closure 和 RSS 门不得放宽。
8. 不新增 workspace package、第三方依赖、runtime module、listener、connection、timer、migration、authority 或默认能力；该切片只回收最终闪存元数据，为后续 RunEvent HTTP 纵向切片恢复可验证余量。

## 不采用方案

- **抬高 6 MiB 上限**：没有固定路由设备证据，且会掩盖闭包增长。
- **删除未加载 JavaScript/tree-shake/minify**：动态加载、调试与审计风险显著更高，不是本切片所需。
- **修改源码 package export map**：会把 Profile 私有裁剪转嫁给 SDK、测试、Cluster 和其他消费者。
- **只按一次 `require.cache` 删除 export**：运行探针没有覆盖未来按配置触发的静态分支；必须扫描整个已安装内部 JavaScript并显式加入产品入口。
- **删除 dependencies、license、bin 或 main**：破坏运行解析、产品入口、许可或 SBOM 事实。
- **为共享 API 投影新增 package**：扩大 importer、manifest、lockfile 与低配安装面，且不能解决当前制品余量。

## 完成门

- 正向覆盖 root/subpath/static dynamic import/CLI entry、确定性 key 投影与精确字节报告；
- 负向覆盖 symlink、坏 manifest、未知 package/subpath、逃逸/缺失 target、动态内部 specifier 和 fail-before-mutation；
- Runtime Artifact Pruner、Local Image、package/dependency boundary 与完整 backend 通过；
- 14 个 Local Profile artifact 全部 compatible，Application+AI 至少实际回收只读测算范围内的大部分 export metadata，且 package/file/module/RSS closure 不扩大；
- PostgreSQL schema/runtime 未变，因此本切片不以 HA 重跑冒充相关证据；下一次 Cluster/RunEvent 功能切片再执行 HA 门。

## 实现证据

- Runtime Artifact Pruner 7/7、Local Image 7/7、完整 backend 1,160 pass/2 skip、18-package build/test 退出 0；package boundary、dependency 与静态 image audit 均 compatible。
- 14 个 Edge/Standalone Profile artifact 全部 compatible。最紧 Edge/Standalone Application+AI 分别为 6,257,060/6,257,192 bytes、644 files；export key 254→109，删除 145 个 key，实际回收 24,296 bytes，距 6 MiB 上限恢复到 34,396/34,264 bytes。
- Application+AI 的真实加载闭包均为 133 modules，RSS 分别为 21,020,672/21,217,280 bytes；预算与文件上限未放宽。显式产品入口增加了 Plugin Package Recovery Catalog 探针覆盖，因此 module 数不能与旧的不完整入口探针直接比较。
- 本切片未新增 package、第三方依赖、JavaScript 删除、migration、listener、connection、timer、authority 或默认能力；PostgreSQL/Cluster runtime 未变，未重跑 HA 门。
