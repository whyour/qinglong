# ADR-0503：可下载的 Local Alpha 试运行套件

- 状态：Proposed（实现完成，原生 Linux x64/arm64 CI 与实际归档待验收）
- 日期：2026-08-26
- 决策：D-408
- 关联：ADR-0193、ADR-0195、ADR-0196、ADR-0425

## 背景

`3.0.0-alpha.2` 已经形成可加载的 Local Application arm64 Docker archive、SBOM、checksum、受限资源 smoke 和完整 CI 记录，但该镜像是刻意裁剪的 headless 常驻运行时。Fresh setup、首 Owner ceremony、Task/Trigger/Secret/Package 管理仍依赖工作区或另行安装的 `ql3` CLI。把这份单镜像称为“用户可试运行 Alpha”会混淆两件事：运行时已经可验证，不代表部署用户已经拿到完整操作入口。

不能为追求下载便利而把 Owner 管理代码塞回常驻 Application 镜像。那会让持有 SQLite 数据卷的远程运行时同时获得一次性 bootstrap、credential 和管理 authority，也会让低配设备永久承担未使用的管理闭包。继续只发布 headless 镜像同样不成立，因为下载者无法仅凭 artifact 完成 fresh 初始化。

## 决策

### 1. 阶段成熟度必须按用户旅程裁决

Local 阶段产物分为三档：

1. `runtime_engineering_candidate`：只有可加载、受限资源验证的常驻镜像；可用于开发与设备兼容测试，不得称为完整用户 Alpha；
2. `local_alpha_trial_kit`：同一源码、同一架构的 Application 与短生命周期 operator 同时可下载，能够在无 workspace 依赖下完成 fresh setup、首 Owner ceremony、运行时 active、SIGTERM drain 和 SQLite integrity；
3. `public_release_set`：再增加双架构、受保护 tag、签名/attestation、catalog、deployment lock、正式升级与回退承诺。

源码、Dockerfile、单元测试数字或单个 headless archive 都不能越级。

### 2. Operator 是独立镜像，不是新 package 或常驻 sidecar

新增 `deploy/containers/ql3-local-operator`，只把既有 `@qinglong/local-owner-cli` 统一 `ql3` 产品入口及其受审依赖装配为短生命周期 OCI image：

- 默认 UID/GID `65532:65532`，部署者可在 bind mount 场景显式覆盖为最终 POSIX owner；
- 默认入口是 `ql3`，每次只执行一个现有 command-file 命令后退出；
- 无 `EXPOSE`、listener、daemon、timer、watcher、Pool 或第二个 SQLite 常驻连接；
- 运行约束固定为 read-only root、network none、drop ALL、no-new-privileges；
- image label 明确 `lifecycle=short-lived`、`authority=local-owner-management`、`network=none-by-default`；
- 不新增 workspace package，不修改现有 18-package 领域边界，也不进入 Local Application dependency closure。

Operator 保留 AI/Secret/Package 等 `ql3` 管理子命令所需的完整受审 JS；它是一次性管理制品，不能把其 9.48 MiB package inventory 或约 171 MB 单独镜像虚拟大小算作 Edge 稳态 RSS。文件门为 1,024、包内容门为 12 MiB，后续增长必须显式审计。

### 3. 同架构两镜像使用一个去重 archive

Alpha workflow 在同一原生 runner 上构建 Application 与 operator，验证 source revision、版本、架构和非 root identity 后，用一次 `docker image save` 写入同一个 `qinglong3-local-trial-kit-<arch>.docker.tar`。这样共享 Node 基础层只在 archive 中保存一次，避免路由/NAS 用户下载两个重复基础层。

manifest 升为 `qinglong/alpha-local-trial-kit@v1`，同时绑定两个 image tag、image ID、共同 archive SHA-256、版本、完整 source revision、架构和已通过门。两镜像 source/version/architecture 任一不一致都失败关闭。

普通 push/PR 只构建和验证，不上传 archive。只有显式 `workflow_dispatch + produce_alpha_artifacts=true` 才产生 30 天 owner-visible artifact；该动作仍不是公开 GHCR release。

### 4. 用户旅程必须从镜像入口完成

`ql3-local-alpha-trial-kit-live-contract.cjs` 不允许从 workspace 调用 setup 或 Owner service。它只通过 operator image 的 `ql3 setup` 与 `ql3 owner` 命令完成：

1. fresh SQLite、Owner pepper keyring/backup 和 Local Secret keyring；
2. setup response-loss exact replay；
3. identity provision、challenge、首 Owner claim 与两份 delivery acknowledgement；
4. 同一数据根启动 Application，等待 `event=active`；
5. SIGTERM 后等待 `event=stopped`，复核 SQLite integrity 与唯一 active Owner binding。

Edge 使用 128 MiB、0.5 CPU、64 PID，Standalone 使用 256 MiB、0.5 CPU、256 PID；operator 固定 128 MiB、0.5 CPU、32 PID。所有容器均 read-only、network none、drop ALL、no-new-privileges。

Docker Desktop 的 bind mount 根目录可能把宿主当前 UID 映射为容器内 root，而子文件仍保留宿主 UID，无法等价满足 Owner console 的完整 POSIX lineage。此平台失败必须记录为 `platform_not_equivalent`，不能放宽权限检查；正式裁决来自原生 Linux x64/arm64 runner。

## 被拒绝的替代方案

### 把 `ql3` CLI 合入常驻 Application 镜像

拒绝。镜像内容即潜在可调用能力；持有运行数据库的远程进程不应同时携带 bootstrap、credential 与管理 authority。

### 新建 `local-operator` workspace package

拒绝。部署边界由现有 `local-owner-cli` 已经表达；新增只含一个入口的 package 会重新制造浅包，而不能增加权限隔离。

### 分别保存两个 Docker archive

拒绝。两个镜像共享相同 pinned Node runtime layer，分开保存会让低容量设备和离线分发重复付费。

### 因 Docker Desktop UID 差异放宽 Owner POSIX proof

拒绝。开发机便利不能削弱生产本机身份根。平台差异由 native Linux 门解决。

## 当前验证与剩余门

- operator 静态契约与突变测试 `2/2`；既有 Local image audit 继续 compatible；
- 本机基于未提交工作树构建的 arm64 operator 原型 image ID 为 `sha256:115e90a7442b3c92db0c566f8fc8a560e689878b67eace0236836681a14689ae`，默认 `65532:65532`，CLI `3.0.0-alpha.2`；该 ID 只证明构建可行性，不是 commit-bound release evidence；
- 运行库存为 9 package、904 files、9,479,647 bytes，低于 1,024 files/12 MiB；
- `ql3 --version` 与 `ql3 setup --help` 在 read-only、network none、128 MiB、0.5 CPU、32 PID 下通过；
- Docker Desktop 完整旅程因 mount root UID 非等价失败，临时 credential/pepper 目录已删除；未把该结果记为通过。

转为 Accepted 前必须取得同一提交的原生 Linux amd64/arm64 完整旅程成功记录，并重新执行 package、backend、artifact、dependency 和 release workflow 审计。实际双架构 trial-kit archive 仍需维护者明确授权手动生成；Public Release Set 是否把 operator 纳入正式签名/catalog，留给后续独立 release-set schema 决策。
