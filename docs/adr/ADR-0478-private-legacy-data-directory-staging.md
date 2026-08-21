# ADR-0478：私有 Legacy Data Directory 暂存与稳定校验

- 状态：Accepted
- 日期：2026-08-21
- 关联：QL-RFC-0001、ADR-0476、ADR-0477

## 上下文

ADR-0477 已把完整 QingLong 2.x `data` 目录收敛为确定性、有界、内容无关的接管计划，但只读计划不是可恢复副本。下一步必须把
审核过的 `scripts/upload` 和待转换的 `config/db/ssh.d` 放入私有暂存区，同时继续排除历史日志、备份、仓库 checkout、原始缓存和
跨架构依赖缓存。

目录暂存不能脱离 ADR-0476 的主 SQLite 接管独立成立。否则 operator 可能把一版目录计划与另一版主库 target/activation 混合，或在
2.x 主库仍可写时生成看似完整但跨资产不一致的副本。低配路由设备还要求复制过程使用固定内存、硬容量预算并在崩溃后留下可识别的
不完整状态，而不是把整个目录先读入内存或交给无边界 `tar`。

## 决策

### 1. 在既有领域目录扩展 stage/verify

`@qinglong/local-owner-cli` 的 `lifecycle/data-directory-adoption/` 增加两个 exact operation：

- `local-data-directory.adoption.stage`；
- `local-data-directory.adoption.verify`。

两者继续使用既有一次性 `ql3-adoption` 私有 command-file 入口。实现由同一领域目录中的 `contract`、`inventory`、`staging` 和产品
`command` 组合，不新增 workspace package、第三方依赖、binary、daemon、listener、watcher、timer、数据库连接或部署对象。

### 2. 使用目录计划与 SQLite activation 双围栏

stage 必须提交精确 `expectedPlanDigest`，verify 必须提交精确 `expectedManifestDigest`。两者还必须提交完整且 exact 的 SQLite binding：

- `sourcePath`、`targetPath`、`recoveryPath`、`manifestPath`、`activationPath`；
- `expectedActivationDigest`。

SQLite source 必须严格等于 `<dataRoot>/db/database.sqlite`，其余 SQLite adoption 证据必须位于 `dataRoot` 外。命令复用
`@qinglong/local-admin/runtime` 的 `acquireLocalSqliteActivation`，重新验证 adoption manifest、target identity、source snapshot 与
activation digest，并在目录复制/静态校验期间持有 source `BEGIN IMMEDIATE` 写栅栏。Profile、SQLite activation digest 和 SQLite
adoption manifest digest 都进入目录清单。

### 3. 固定、私有、no-replace 暂存布局

`stagingRoot` 必须是 `0700` canonical `deploymentRoot` 内的不存在路径，且不能位于 `dataRoot` 内。stage 使用 no-replace 创建它，并只产生：

```text
stagingRoot/
  manifest.json                         0600
  payload/
    copy-reviewed/                      0700
      scripts/...
      upload/...
    transform-input/                    0700
      config/...
      db/...                            # 不含 database.sqlite 及其 sidecar
      ssh.d/...
```

目录统一为 `0700`，文件统一为 `0600`。`log/syslog/bak` 保持外部，`repo/raw/dep_cache/deps` 在目标重新生成。主 SQLite 不进入目录
payload，因为 ADR-0476 的 recovery/target/activation 已是它的独立恢复权威。

### 4. 固定内存复制、重复预算与稳定身份

复制仅接受当前 UID 拥有、group/world 不可写、非 symlink 的目录和普通单链接文件。源文件通过 `O_NOFOLLOW` descriptor 和 64 KiB
缓冲流式复制，打开前后必须保持 device、inode、mode、link count、UID、size、mtime 和 ctime。源目录遍历前后也必须稳定。

复制循环独立重复执行 ADR-0477 的 Profile 条目数、总字节、单文件和深度预算；不能只依赖较早的 inspect。复制完成并释放 SQLite
栅栏后，再重新生成完整目录计划，必须与审核计划逐字段一致。目标 verify 同样按固定顺序、固定内存重新哈希，拒绝额外条目、缺失项、
symlink、硬链接、特殊文件、错误 owner 和非私有 mode。

### 5. 显式崩溃残留与内容无关清单

stage 创建根后立即以 no-replace 写入并持久化固定 `.incomplete` 标记；复制或清单发布前后的任何失败都不覆盖、不自动重用该目录。
只有 payload 已持久化、`manifest.json` 以 no-replace 写入并同步后才删除标记。verify 要求根目录精确只有 `payload` 与 `manifest.json`，
因此任何残留标记或额外文件都失败关闭。operator 必须保留现场或显式移走失败目录，再使用新路径重试。

清单不包含原始绝对路径、任意用户文件名或文件内容，只保存：Profile、时间、目录 plan digest、SQLite 两个 digest、源/暂存路径摘要，
以及两个固定 payload group 的类别、计数、字节和语义 digest。语义 digest 绑定相对路径、entry kind、文件大小与内容摘要；源权限和时间
由 plan digest 绑定，目标则强制归一化私有权限。

## 被拒绝的替代方案

### 直接复用 2.x tar 导出/导入

拒绝。它无法表达固定处置矩阵、双 digest 围栏、稳定 descriptor、Profile 预算和崩溃残留状态，也会把缓存和秘密材料混成一个恢复单元。

### 暂存成功后自动删除失败残留

拒绝。崩溃或 I/O 错误后不能证明每个创建对象仍属于本次调用；保留 `.incomplete` 比递归清理更容易审计，也避免错误删除 operator 资产。

### 不绑定 SQLite activation

拒绝。目录 payload 与主库 target 会成为两个可任意拼接的时间点，无法证明后续 config/Keyv 转换使用的是同一接管快照。

### 再拆一个 workspace package

拒绝。stage/verify 与 ADR-0477 inventory 是同一短生命周期 Local Owner capability，没有独立部署和依赖生命周期；继续内聚可避免
“一个文件一个包”和平铺根源码两种碎片化。

## 影响

### 正面

- 完整 2.x 目录首次得到 no-replace、可重复 verify 的私有迁移输入；
- 主库接管与目录接管通过真实 activation 写栅栏和摘要链绑定；
- Edge/Standalone 复制器保持 64 KiB 固定缓冲并重复硬预算；
- 崩溃残留不会被静默当作成功或被重试覆盖；
- 能直接复制的资产与需要转换、外部保留、目标重建的资产保持物理隔离。

### 代价与限制

- stage 需要再次完整读取相关资产，并额外占用 payload 等量磁盘；
- SQLite 写栅栏只保护主库；其他文件依靠逐文件稳定身份和 stage 前后完整计划复核，不是跨文件系统事务；
- `.incomplete` 残留需要 operator 显式处置；
- 本阶段只产出转换输入，不实现 config、Keyv、SSH 的目标模型转换；
- 尚未把目录清单接入 systemd/OpenRC/Compose cutover lineage，也未完成固定物理 Edge 的断电、ENOSPC 和闪存写放大证明。

## 验证

- D-385 聚焦 data directory inspect/stage/verify `10/10`，使用真实 ADR-0476 SQLite 链；
- 覆盖 reviewed payload、主库/缓存/日志排除、私有 mode、source/target drift、activation drift、no-replace crash residue、
  verify exact replay 与扩权命令；
- Local Owner `200 total / 195 pass / 5 conditional skip / 0 fail`；backend
  `1,535 total / 1,533 pass / 2 conditional skip / 0 fail`，`pnpm build:back` 通过；
- 18-package clean build/逐包测试、八项架构审计与按顺序执行的 14 档 artifact audit 全部通过；
- GitNexus impact 最高 LOW，无跨模块 execution flow；change audit 作为提交前最后门禁。

本阶段不修改 PostgreSQL schema、ACL、repository、role、Pool、连接或 failover 语义，因此不重新占有 PostgreSQL HA 证明。

## 后续

- D-386：把 `config`、Keyv 与 `ssh.d` 转换输入变成版本化目标模型和恢复合同；
- 在固定物理 Edge/NAS 上执行 stage/verify 的 RSS、I/O、磁盘峰值、ENOSPC 与受控断电演练；
- 将目录 manifest digest 接入 systemd/OpenRC/Compose cutover、rollback 和发布证据 lineage。
