# ADR-0477：有界 Legacy Data Directory 盘点

- 状态：Accepted
- 日期：2026-08-21
- 关联：QL-RFC-0001、ADR-0476

## 上下文

ADR-0476 已经证明单个生产形态 QingLong 2.x `database.sqlite` 可以经过 inspect、stage、verify、activation 和 clean/write-after
双态回滚分类接管到 3.0，但真实部署的 `data` 目录不只有主数据库。现行 2.x 配置和实际用户目录可包含：

- `config/`、`scripts/`、`db/`、`upload/`、`ssh.d/`；
- `log/`、`syslog/`、`bak/`；
- `repo/`、`raw/`、`dep_cache/`、历史 `deps/`；
- 用户或插件创建的未知顶层条目。

直接复用 2.x `SystemService.exportData/importData` 不满足 3.0 接管要求。该路径以 shell 拼接 `tar`，默认只覆盖数据库和上传目录，
也没有固定资产分类、no-follow、硬链接拒绝、内容上限、确定性计划或敏感输出约束。直接打包整个 `data` 目录还会把日志、备份、
跨架构依赖缓存、仓库 checkout、SSH 材料和未知插件资产混成一个不可审核恢复单元；对低内存路由设备尤其危险。

完整目录复制之前，需要一个短生命周期、只读、确定性、按 Profile 有界的产品入口先回答：哪些资产存在、哪些可进入后续复制、哪些必须
转换、哪些只保留为外部恢复资产、哪些应在 3.0 重新生成，以及是否存在必须人工处理的不安全或未知条目。

## 决策

### 1. 复用现有一次性产品入口

在 `@qinglong/local-owner-cli` 的 `lifecycle/data-directory-adoption/` 内增加：

- exact operation：`local-data-directory.adoption.inspect`；
- exact options：`dataRoot` 与 `profile`；
- 既有 `ql3-adoption run --command-file ...` 私有 command-file 入口。

不新增 workspace package、第三方依赖、binary、daemon、listener、watcher、timer、数据库连接或部署对象。实现不得进入 Edge、
Standalone、Application、AI 或 MCP 常驻闭包。

### 2. 固定资产处置矩阵

| 类别 | 处置 | 盘点深度 | 原因 |
| --- | --- | --- | --- |
| `config` | `transform` | `recursive_content` | 需要迁移到 3.0 配置模型，不能盲拷旧配置 |
| `scripts` | `copy_reviewed` | `recursive_content` | 用户脚本是业务资产，但必须先审核安全和兼容性 |
| `db` | `transform` | `recursive_content` | 主库由 ADR-0476 迁移，Keyv/sidecar 需独立识别 |
| `upload` | `copy_reviewed` | `recursive_content` | 用户上传内容可保留，但必须受大小和文件类型边界约束 |
| `ssh.d` | `transform` | `recursive_content` | 属于敏感凭据材料，后续必须进入专用私有交付协议 |
| `log`、`syslog`、`bak` | `retain_external` | `root_only` | 作为历史/恢复资产保留，不进入默认 3.0 运行目录 |
| `repo`、`raw`、`dep_cache`、`deps` | `regenerate` | `root_only` | checkout、原始缓存和依赖缓存应按目标架构重建 |

未知顶层条目只记录数量和名称摘要，不返回原始名称，计划状态固定为 `manual_review`。本阶段不允许 caller 覆盖处置矩阵或增加任意
include/exclude glob。

### 3. No-follow、稳定身份与内容脱敏

盘点要求 `dataRoot` 为当前 UID 拥有、canonical、非符号链接、group/world 不可写的非根目录。递归类别按 UTF-8 字节序确定性遍历，
使用 `lstat` 且不跟随符号链接；只有当前 UID、group/world 不可写的普通单链接文件或目录可继续读取。符号链接、硬链接、多链接文件、
特殊文件、错误 owner 和可被组/其他用户写入的条目只计为 unsafe，不读取其内容。

普通文件通过 `O_NOFOLLOW` descriptor 读取，打开前后的 device、inode、mode、link count、UID、size、mtime 和 ctime 必须一致。
目录遍历前后也必须保持同一稳定身份。底层文件系统错误统一映射为固定错误码
`LOCAL_DATA_DIRECTORY_ADOPTION_CONFIGURATION_INVALID`，CLI 不返回原始路径、任意文件名或内容。

结果只包含固定类别名、计数、逻辑/分配字节、宽读权限计数、unsafe 计数、SQLite 主库/Keyv/sidecar 识别计数、内容摘要、未知条目
数量/摘要和完整 `planDigest`。宽读权限是审核信号；只有可写权限或身份/类型问题自动成为 unsafe。

### 4. Edge 与 Standalone 分离预算

| Profile | 最大条目 | 最大哈希字节 | 单文件上限 | 最大深度 |
| --- | ---: | ---: | ---: | ---: |
| Edge | 8,192 | 512 MiB | 64 MiB | 32 |
| Standalone | 65,536 | 4 GiB | 512 MiB | 64 |

目录通过增量 `opendir` 枚举，并在保存超过剩余预算的名称前失败，不先用一次性 `readdir` 将任意数量的目录项装入内存。文件使用
64 KiB 固定缓冲区流式哈希并在关闭前清零。`root_only` 类别不递归、不读取或哈希其子项，因此依赖缓存和历史日志规模不会进入
盘点内存或 I/O 成本。

### 5. 本阶段只发布计划，不执行迁移

该 operation 只读源目录并将结果写到 stdout。它不创建目录副本、归档、manifest、recovery 或 activation，不修改 2.x 数据，
也不把目录计划自动绑定到 ADR-0476 的 SQLite plan/activation。后续 stage 必须重新验证稳定身份并显式绑定两个计划摘要；不能把本次
inspect 输出直接当作复制授权。

## 被拒绝的替代方案

### 直接 tar 完整 data directory

拒绝。它混合不同恢复语义、可能跟随或保存不安全链接、复制跨架构缓存，并让低配设备承担不可预测的空间和内存成本。

### 为目录接管再拆一个 workspace package

拒绝。该能力只有一个短生命周期产品 owner，没有独立部署、依赖或版本生命周期；放入已有 Local Owner lifecycle 垂直目录更符合
当前包边界规则，也避免恢复“一个文件一个包”的碎片化。

### 只统计文件大小，不读取内容摘要

拒绝。大小和时间不能把后续 stage 绑定到已审核内容；确定性流式摘要提供最小的漂移证明，同时不输出文件内容。

### 在 inspect 时复制或转换文件

拒绝。盘点和 mutation 混合会让未知/不安全条目在 operator 审核前产生目标副本，也无法建立清晰的 plan-digest fence。

## 影响

### 正面

- 完整 2.x data directory 首次获得固定、可审核的资产处置模型；
- Edge 和 Standalone 使用不同硬预算，低配设备不会继承集群节点规模假设；
- 未知资产、链接和权限漂移失败关闭，且不会泄露任意文件名或内容；
- 日志、备份、仓库和依赖缓存不会污染 3.0 默认运行目录；
- 没有增加 package 粒度、常驻资源或基础制品体积。

### 代价与限制

- 对递归类别执行全内容哈希，仍会产生与资产大小线性的磁盘读取；
- 正在写入的 2.x 目录可能因稳定身份检查失败，需要先停止 writer 后重试；
- `root_only` 只证明类别根的存在、权限和类型，不证明内部历史资产完整性；
- 当前没有 stage/verify/restore，也没有固定物理 Edge 的耗时、RSS、磁盘峰值与断电演练；
- 当前目录计划尚未与 SQLite activation、service-manager cutover 和 rollback lineage 形成统一证据链。

## 验证

- D-384 聚焦 data directory CLI：`5/5`；
- Local Owner：`195 total / 190 pass / 5 conditional skip / 0 fail`；
- backend：`1,535 total / 1,533 pass / 2 conditional skip / 0 fail`，`pnpm build:back` 通过；
- 18-package clean build 与逐包测试单次退出 0；
- package boundary、Cluster dependency、Edge import、Service Bridge import、Cluster/Worker deployment、Console 与 Console
  distribution 八项审计全部 compatible/passed；
- workspace 保持 18 packages，`singleSourcePackages=[]`、`shallowSourcePackages=[]`；Local Owner 为
  `118 source / 117 nested / 1 root binary entry`；
- 14 档 Local artifact audit 全部 compatible，基础 Edge/Standalone、Adopted、Application+AI 与 MCP 的体积和 loaded-module
  基线未变化。

本阶段不修改 PostgreSQL schema、ACL、repository、role、Pool、连接或 failover 语义，因此不重跑且不重新占有 PostgreSQL HA
证明。

## 后续

- D-385：以 plan digest 和 ADR-0476 activation digest 为双 fence，设计 no-replace stage/verify manifest；
- 对 `config`、Keyv 与 `ssh.d` 定义显式转换/私有交付协议；
- 在固定物理 Edge/NAS 上测量完整目录盘点与 staging 的耗时、RSS、I/O、磁盘峰值和断电恢复；
- 把 staged data directory 证据接入 systemd/OpenRC/Compose cutover 与 rollback lineage。
