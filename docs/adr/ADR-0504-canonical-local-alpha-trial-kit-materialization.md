# ADR-0504：Local Alpha Trial Kit 单一物化与离线审计

- 状态：Accepted
- 日期：2026-08-26
- 决策：D-409
- 关联：ADR-0193、ADR-0195、ADR-0196、ADR-0503

## 背景

ADR-0503 已定义 Local Application 与短生命周期 operator 组成同架构 Trial Kit，并由原生 Linux x64/arm64 门验证完整 fresh 用户旅程。此前手动 artifact 步骤仍在 workflow shell/heredoc 内直接执行 `docker image save`、复制 SBOM 并拼装 manifest。该实现能产生文件，但本地维护者无法复用同一逻辑，下载者也没有一个拒绝额外文件、checksum 漂移或 SBOM 替换的离线审计入口。

阶段产物如果只有 CI 内联命令，没有唯一可执行的物化协议，仍可能出现“CI 声称通过、实际下载目录无法独立复核”的分叉。

## 决策

### 1. 使用一个仓库内 materializer 作为唯一写 authority

新增 `ql3-local-alpha-trial-kit-bundle.cjs`，固定提供两个闭合模式：

- `create`：验证 release identity、完整 source revision、Tier-1 架构、两个镜像的 ID/OS/架构/non-root user/OCI label，以及两份受审 CycloneDX SBOM；随后通过一次 `docker image save` 生成去重 archive；
- `audit`：不调用 Docker、不访问网络，只验证 manifest exact shape、闭合文件集、每个文件的 byte length/SHA-256、`SHA256SUMS`、两份 SBOM 的 profile/version 身份和两镜像 ID 的分离。

GitHub Actions 和本地阶段产物必须调用同一入口。workflow 不再拥有独立的 heredoc manifest 实现。

### 2. 套件是闭合目录，不是松散文件集合

每个架构的目录只允许六个 regular file：

1. 一个同时包含 Application/operator 的 Docker archive；
2. Application CycloneDX SBOM；
3. operator CycloneDX SBOM；
4. 面向部署者的 `README.md`；
5. canonical `manifest.json`；
6. 覆盖前五个文件的 `SHA256SUMS`。

symlink、子目录、credential、keyring、数据库、日志、未声明证据或任意额外文件都失败关闭。创建目标必须是未使用的 canonical absolute path；任何失败都会删除本次半成品目录，既有目录不会被覆盖。

### 3. 离线验证不等同于重新证明 CI live gate

manifest 中的 `verification` 是该 artifact 生成位置之前已通过的 workflow gate 声明。离线 auditor 证明目录内容未漂移、身份相互一致，不伪称在低配设备上重新执行 fresh Owner 或 lifecycle 门。实际加载后的设备 smoke 和生产发布签名仍是不同层级的证据。

普通 push/PR 继续只运行构建和 live gate，不上传大 archive。`workflow_dispatch + produce_alpha_artifacts=true` 仍需要维护者显式授权。

## 被拒绝的替代方案

### 保留 workflow heredoc，另写一个只读 auditor

拒绝。写入与读取协议分离会形成两个 schema authority，测试只能证明 auditor 接受样例，不能证明 CI 实际写出的内容来自同一实现。

### 每个镜像各自生成 archive 和 checksum

拒绝。它会在低容量设备上重复保存共享 Node layer，并破坏 ADR-0503 的单 archive 边界。

### 把 materializer 做成 workspace package

拒绝。它是发布期仓库工具，不是运行时领域能力；新增单文件 package 会扩大 18-package 边界而不带来部署隔离。

## 影响

- 阶段产物可以在 CI 之外按同一协议生成并离线复核；
- 低配设备只需要 `sha256sum` 和 Docker 即可先验证文件再加载，不增加常驻运行时依赖或 RSS；
- manifest 从松散的顶层 image 字段收敛为 `archive/images/sboms/readme/verification` 的 exact shape；该 schema 尚未公开发布，因此不承担旧 artifact 兼容承诺；
- Cluster native image artifact 暂不复用此脚本，其单镜像/多角色发布语义与 Local Trial Kit 不同。

## 验证

- 单元测试覆盖正常物化/审计、错误 source revision、archive 篡改、额外文件和 SBOM 替换；
- Local operator 静态审计要求 workflow 同时调用 `create` 和 `audit`；
- 当前提交的真实 arm64 Application/operator 必须由该入口生成本地私有 Trial Kit，并再次执行离线审计和加载后最小 smoke；
- 正式 downloadable 双架构 artifact 仍由维护者授权的手动 workflow 生成。
