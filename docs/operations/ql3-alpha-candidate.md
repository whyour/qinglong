# QingLong 3.0 阶段性 Alpha 候选产物

该产物回答“当前源码是否已经形成可下载、可验证、可试运行的阶段成果”。它不是公开 release、不可变 GHCR digest 或生产升级承诺，也不能替代正式 release-set、签名、catalog、部署锁和回退门。

## 产物等级

| 等级 | 面向对象 | 必须通过 | 当前用途 |
| --- | --- | --- | --- |
| Runtime Engineering Candidate | QingLong 开发者、设备兼容测试者 | 单个常驻镜像的 OS 漏洞策略、SBOM/库存、资源门和生命周期 | 验证 runtime 可加载、可启动；缺少管理制品时不能称用户 Alpha |
| Local Alpha Trial Kit | amd64/arm64 路由器、NAS、单机试用者 | 同源 Application + 短生命周期 operator、fresh setup/Owner/active/stop 完整旅程、SBOM/库存与资源门 | 一个去重 Docker archive 完成隔离 fresh 试运行；不承诺生产升级 |
| Cluster Integration Candidate | amd64/arm64 集群测试节点 | OS 漏洞策略、SBOM 与镜像库存复核、non-root identity；Admin 额外通过产品 facade smoke | 导入隔离 registry/测试节点，进行多组件集成；不作为 production HA release |
| Public Release Set | 生产用户 | 受保护 tag、五镜像 multi-arch digest、签名/attestation、私有发布证据、catalog、Local/Cluster 部署与回退闭环 | 尚未实际发布；只能由受保护 release workflow 生成 |

只有 `Local Alpha Trial Kit` 可以称为本阶段“用户可试运行产物”。单个 headless runtime 和 Cluster archive 都只是工程候选；后者还不满足正式 Kubernetes deployment-lock 的 GHCR immutable digest 与 catalog provenance。

## 当前阶段实物（2026-08-26）

当前已经存在一份与 `3.0.0-alpha.2` 源码身份一致、owner-private、可重新加载的 Local arm64 runtime engineering candidate，而不是只有源码或 Dockerfile：

- source revision：`e3c05862b8c2690d69f58b098cdc128a09c83f97`；
- image：`qinglong3-local-application:alpha2-e3c05862-arm64`，image ID `sha256:dfce2cc9d70044d75f72f2cc3075e1f24569fb9fe279d9c25a45698c19c3bde9`；
- archive SHA-256：`01afb30cbe0c21f980ca083ad98fd316e659941f940dd8930ffd9ccfa7153edf`；
- 工作区目录 `.tmp/ql3-alpha-e3c05862b8c2690d69f58b098cdc128a09c83f97-local-arm64/` 包含 `manifest.json`、`verification-evidence.json`、release-candidate contract、CycloneDX 1.5 SBOM、`README.md` 与 `SHA256SUMS`；全套 checksum、`docker load` 后身份和资源约束 smoke 已复验；
- HIGH/CRITICAL OS vulnerability 为 0；128 MiB、0.5 CPU、read-only、no-network、drop-all 下的 Edge/Standalone fresh lifecycle、graceful stop 与 SQLite integrity 已通过；本机 Edge 首次运行曾在 Docker Desktop 文件桥上出现一次 startup receipt 发布瞬态，精确重跑通过，未将首次失败隐藏为成功；
- 原生 Linux arm64 Local image job `97986754052` 已覆盖 Docker Desktop 无法等价证明的 Local API cancellation。完整 CI run `32903679764` attempt 2 为 40/40，独立 Kubernetes deployment run `32903679644` 与三节点 Security Administration run `32903679570` 同源通过。首轮 CI 的两项 `pnpm/action-setup` 内部 DNS 失败和一次 PostgreSQL 18 x64 scheduler 并发断言均在 failed-only rerun 收敛。

该实物保存在工作区忽略目录，不进入 Git，也尚未上传 GitHub。公开下载仍需维护者明确授权上传。它只含 headless Application，没有可下载的 `ql3 setup/owner/task/...` 管理制品；因此它足以证明 runtime 工程可用性，但不能独立完成部署用户旅程。此前“单架构内部试运行材料”的表述按 D-408 收紧为“运行时工程候选”。

ADR-0503 已增加独立的 `qinglong3-local-operator`：它复用现有统一 `ql3` CLI，每次执行一个 command-file 命令后退出，不进入常驻 Application。提交 `2253b99066e0c221e11dc01384f496ec2a50e4bd` 的原生 Linux amd64/arm64 已同时通过 fresh setup、首 Owner ceremony、Application active/stop 和 SQLite integrity，CI run `32918632202` 为 40/40。ADR-0504 又把一次 `docker image save`、manifest、SBOM、README、`SHA256SUMS` 和离线审计收敛为同一个 materializer；下一项未完成的外部里程碑是维护者授权生成并保留两个可下载 archive。

提交 `2620be0587c29c2384e7f587c490dc11e357dfc8` 已通过该 materializer 生成新的本地私有 arm64 Trial Kit，位于 `.tmp/ql3-alpha-2620be0587c29c2384e7f587c490dc11e357dfc8-local-arm64/`：

- 单一双镜像 archive 为 178,765,312 bytes，SHA-256 `7456202efb252e665d658664d69693cfbc170e02ec19923302d5c354bcaa140f`；
- Application image ID 为 `sha256:88c3027609c5f18a15111cb5820e34191d758ac6b4a41fc46d4a6bdf41fd71dd`，operator image ID 为 `sha256:529b86b85e18d6bd4ec8644d9da82d49ea45902534da27a99ee65ad4058e513b`；
- 两份 CycloneDX SBOM 均与镜像内实际 package inventory 对账为 `inventoryVerified=true`；闭合目录离线审计、`SHA256SUMS`、archive reload 及 128 MiB 无网络只读 entrypoint smoke 全部通过。

这证明当前提交已经存在可重复生成和离线复核的单架构完整 Trial Kit 实物，但它仍只在维护者工作区，不等于 amd64/arm64 两份可下载 GitHub artifact。

## 生成

在 GitHub Actions 手动运行 `QingLong 3.0 CI`，选择目标 `next` 提交并设置 `produce_alpha_artifacts=true`。普通 push/PR 不上传大镜像，避免每次开发提交都制造伪里程碑和额外存储成本。

成功后同一次 run 生成、保留 30 天：

- `ql3-alpha-<commit>-local-amd64` 与 `ql3-alpha-<commit>-local-arm64`；
- `ql3-alpha-<commit>-control-<arch>`、`control-ai-<arch>`、`admin-<arch>`、`worker-<arch>`。

Local artifact 含：

- 一个包含 Application 与短生命周期 operator 的 `qinglong3-local-trial-kit-<arch>.docker.tar`；共享 Node 基础层在 archive 中去重；
- schema 为 `qinglong/alpha-local-trial-kit@v1` 的 `manifest.json`，通过 `archive/images/sboms/readme/verification` 绑定版本、完整 source commit、架构、两个 image tag/image ID、文件长度/SHA-256 与已通过 gate；
- 与实际只读镜像 inventory 对账过的 CycloneDX SBOM；
- 面向 Local 用户的 README 与覆盖全部内容文件的 `SHA256SUMS`。

Cluster artifact 仍是每个角色一个 native Docker archive 和各自 manifest。

任何 required job 失败时不上传对应产物。artifact 名和 archive 内的 `ci-*` tag 都表示 commit-bound candidate，不能改名后冒充 `v3.x` release。

## 下载后验证与最小 smoke

在同架构 Linux Docker 主机上进入解压后的 artifact 目录：

```sh
sha256sum --check SHA256SUMS

archive="$(node -p "require('./manifest.json').archive.file")"
docker load --input "${archive}"
image="$(node -p "require('./manifest.json').images.application.reference")"
expected_id="$(node -p "require('./manifest.json').images.application.id")"
test "$(docker image inspect --format '{{.Id}}' "${image}")" = "${expected_id}"
operator_image="$(node -p "require('./manifest.json').images.operator.reference")"
operator_expected_id="$(node -p "require('./manifest.json').images.operator.id")"
test "$(docker image inspect --format '{{.Id}}' "${operator_image}")" = "${operator_expected_id}"
docker run --rm --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges "${image}" --help
docker run --rm --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges "${operator_image}" --version
docker run --rm --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges "${operator_image}" setup --help
```

下载页本身不是 source identity；还必须把 `manifest.json.sourceRevision` 与预期 `next` commit 对齐。不要在生产数据库、生产 Secret 或 2.x 唯一数据目录上直接试用。

## 试运行与回退边界

Local 正式部署仍应遵循 [Edge/Standalone 部署准备](./ql3-local-deployment.md)。Trial Kit 中的 operator 可以从受审命令文件生成 fresh pepper、credential 和数据库，但不会猜测部署路径、mutation ID、POSIX owner，也不会替操作者生成 2.x cutover evidence。使用 bind mount 时必须以最终文件 owner 的 UID/GID 运行 operator；Docker Desktop 的 mount-root UID 语义不等价于原生 Linux，失败时不得放宽 Owner proof。

阶段试运行必须使用独立目录和独立数据库；回退的最低保证是停止并删除 Alpha 容器、保留测试目录用于诊断，然后回到未被修改的 2.x 实例。凡是执行 2.x→3.0 数据迁移或 3.0 写入后切回，都必须走既有 reconciliation/cutover/rollback ceremony，不能只换镜像。

Cluster candidate 必须先导入隔离 registry 并重新绑定该 registry 的 immutable digest。当前 archive 不带 public catalog、签名或正式 deployment selection；生产 Kubernetes、CloudNativePG HA、跨主机 STONITH/DR、CSI custody 和外部 IdP 不在此阶段产物的声明范围内。

## 里程碑判定

一次用户阶段里程碑只有同时记录以下事实才成立：源码 commit、版本、两种 Tier-1 架构的 Application/operator、完整 CI run、artifact 名与 digest、fresh setup→首 Owner→active→stop 的目标 Profile smoke、已知限制和回退路径。仅有源码、`dist/`、单元测试数字、Dockerfile、单个 headless runtime 或“理论上可构建”都不算用户可用产物。
