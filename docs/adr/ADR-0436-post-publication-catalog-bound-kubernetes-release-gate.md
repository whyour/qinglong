# ADR-0436：发布后 Catalog-bound Kubernetes Release Gate

- 状态：Accepted
- 日期：2026-08-18
- 关联 RFC：QL-RFC-0001 D-336、D-338、D-339、D-341、D-343、D-344
- 关联 ADR：ADR-0428、ADR-0430、ADR-0431、ADR-0433、ADR-0434、ADR-0435

## 上下文

ADR-0428 至 ADR-0435 已分别建立持久 OCI catalog、可信工作站消费、catalog-bound deployment lock、目标侧 Kubernetes
install/upgrade/rollback、完整 inventory Head 与 UID/resourceVersion 围栏退役。但发布流水线仍在 durable catalog 与 receipt 上传后结束；
独立 K3s live 门使用合成 lock，只能证明目标侧状态机，不能证明新发布的公开 catalog 能被一个没有发布权限的下游消费者重新发现、验签、
下载、重建 deployment lock 并送入同一目标 ceremony。

把发布者 job 内已经读取过的文件直接交给 K3s 会掩盖 package visibility、discovery、Cosign workflow identity、GitHub source
tag/revision provenance、OCI raw manifest round-trip 或跨 job 权限错误。反过来，给低配 Local/Edge 设备安装 regctl、Cosign、GitHub CLI、
Node 或 K3s 又会破坏分层部署边界。因此缺口应由发布时的一次性 Cluster release gate 闭合，而不是进入产品运行时。

## 决策

1. `ql3-image-release.yml` 在 `release-set` 成功后增加独立 `release-catalog-deployment-live` job。它仅为 `cluster|all` scope 运行；
   `local` scope 明确跳过。job 使用 GitHub-hosted runner、30 分钟硬超时和只读 `contents|packages|attestations` 权限，不拥有 package write、
   OIDC signing、attestation write、Docker login、tag promotion 或 catalog mutation authority。
2. 下游 job 不下载发布 job 的 release-set artifact 作为部署 authority。它从
   `ghcr.io/<owner>/qinglong3-release-catalog:v<version>-<scope>` 重新发现 digest，前后两次解析必须稳定；随后只使用 immutable catalog
   reference，按 ADR-0430 验证 exact Cosign workflow identity 与 GitHub source tag/revision provenance，并发布 exact-three-file、
   owner-private consumption bundle。regctl 与 Cosign 不接收 registry credential；公开读取失败即阻断 Cluster release。
3. 工具链固定为 checksum-pinned `regctl@0.11.5`、immutable-action 安装的 Cosign、canonical GitHub CLI、checksum-verified kubectl
   v1.34.3 和 digest-reviewed K3s v1.34.3+k3s1。短期 GitHub token 只通过 mode-0600 文件进入 GitHub provenance verifier，ceremony
   后立即删除；bundle 与最终 evidence 不包含 credential。
4. Kubernetes live contract 增加严格 all-or-none 的 release identity 环境输入。配置完整时先离线重审 consumption bundle，再把其中同一
   release-set 对象交给既有 `createKubernetesLock`，生成绑定 release-set/catalog manifest/consumption report digest 的 v2 lock；缺少
   任一 identity 字段、scope 为 local、角色镜像不唯一或 bundle 漂移都在启动 K3s 前失败关闭。普通 PR/live workflow 不提供这些字段，
   继续使用明确标注为 `synthetic_live_fixture` 的状态机 fixture。
5. release gate 使用一个有界 7-resource manifest：Namespace、四个零副本角色 Deployment、Plugin Package admission ConfigMap 和一个
   可退役 ConfigMap。真实 catalog 中 `control|control-ai|admin|worker` 的 immutable image reference 被写入 API Server，但零副本门不拉取
   或启动业务镜像；镜像图、签名和 provenance 由上游发布/消费门负责，目标门负责证明 catalog authority 到 server-side apply、Head、
   inventory 与 retirement receipt 的连续性。
6. 隔离的三节点 K3s 执行 install preflight/apply/receipt audit，再对目标 ConfigMap 执行 UID/resourceVersion-preconditioned retirement
   preflight/apply/receipt audit。成功证据必须声明 `verified_release_catalog`、三个 catalog/release digest、source revision/ref/scope、
   Head 收敛、目标 absent 与清理完成；不保存 bundle 正文、token、kubeconfig、command 或目标集群长期 credential。
7. 该 Gate 不新增 workspace package、生产依赖、数据库、migration、controller、CRD、webhook、ServiceAccount、Pod、listener、timer
   或常驻进程。Local/Edge/Standalone 的镜像、导入图和稳态资源不变；集群用户也只在发布流水线承担一次性验证成本。
8. 第一份真实成功 evidence 只能由实际受保护 `v3` release tag 的 workflow dispatch 产生。仓库内 fixture、离线 bundle 和本机 K3s
   回归可以验证代码与失败关闭语义，但不能冒充尚未发生的公开 GHCR/Cosign/GitHub 在线 ceremony。

## 部署与资源影响

- 只在 Cluster 发布时新增一次 GitHub-hosted runner job；三节点 K3s、kubectl proxy、私有目录和 Docker network/container 全部短生命周期。
- 四个业务 Deployment 固定 `replicas=0`，不下载或启动 QingLong 业务镜像；因此该 Gate 的成本由 K3s control-plane 与 API 操作主导，
  不把完整 Cluster 数据面启动时间混入 supply-chain 判定。
- Local-only 发布无该 job；路由器、NAS、Edge 与 Standalone 用户不安装 catalog 工作站工具，也不运行 Kubernetes。
- 发布者与消费者权限分离。consumer 不能修复 package visibility 或 tag；它只能让发布失败，并由维护者修正发布配置后对同一 tag 重跑。

## 被拒绝的替代方案

### 在 `release-set` publisher job 内直接运行 K3s

拒绝。它复用发布者登录态、文件和写权限，不能证明一个真实下游只读消费者可以独立取得 catalog。

### 从 90 天 workflow artifact 生成 deployment lock

拒绝。短期 artifact 不是长期发现入口，也绕过 immutable OCI manifest、Cosign 与 GitHub OCI provenance 的重新验证。

### 只解析 mutable discovery tag 一次

拒绝。tag 只有发现权；ceremony 必须固定 immutable digest，并在下载与验证后再次确认 discovery 未变化。

### 为 Local/Edge 也运行 K3s 或下发验签工具

拒绝。Local image 已有独立 Compose digest rollout gate；Cluster K3s 门不能成为低资源部署的发布或稳态依赖。

### 在 release gate 启动四类真实业务 Pod

拒绝。业务启动还依赖数据库、Secret、Policy 与各自 lifecycle gate，会把 supply-chain/目标 mutation 证明扩展成不稳定的全栈验收。此门只验证
immutable image authority 被目标 API 接受和 Head/receipt 闭包，不重复镜像构建与各产品 live contract。

## 验证

- `ql3ClusterImageReleaseAudit` 冻结 job dependency、scope、只读权限、11 个精确步骤、三套 pinned 工具、公开 catalog create+offline audit、
  digest-reviewed K3s、catalog-bound live 输入、隔离清理与 content-free evidence，并包含移除 Gate、错误 Local 条件和 consumer 写权限的负向用例；
- `ql3DeploymentLockContract` 验证完整/部分环境选择、cluster/all scope、同一 audited release-set 到 v2 lock 的物化、四角色引用、7-resource
  closure、五个受影响资源的 catalog annotations 与退役目标存在；
- 发布/部署定向契约 109/109；完整 backend 1,344 项为 1,342 pass/2 条件 skip/0 fail，18-package clean build/test 退出 0；
- 14 项有效架构/发布/部署审计与 14 档 Local artifact 全部 compatible；package boundary 为 18，`singleSourcePackages=[]`、
  `shallowSourcePackages=[]`，所有 Local artifact 字节数与 D-343 一致；
- 使用真实执行六步 catalog ceremony 的可离线重审 fixture bundle，在 linux/arm64 三节点 K3s v1.34.3+k3s1 上完成 catalog-bound
  lock、7-resource install、Head `1→2`、inventory `7→6` 和 UID/resourceVersion 围栏退役；两个 receipt audit、target absent、Unix
  socket proxy 与 cleanup 全部通过，最终 retirement receipt digest 为
  `sha256:e20532f2f2cd3fce3e7985e4bb3b4b75dc87ca3b59d7f9530ad9d8e02694d1f3`；
- PostgreSQL 18.6/arm64 HA 为 142/142、timeline `1→2`，独立 evidence audit compatible，报告 SHA-256 为
  `796e4b85a9f45c3b63537010057c1c91c6011ecfab2f2f289763b4915037d9dd`，所有 HA Docker 资源清理为零；
- 真实公开 registry/Cosign/GitHub ceremony 仍必须由第一份实际受保护 release tag 运行记录闭合，本机 fixture 不计作线上成功证据。

## 规范依据

- [GitHub artifact attestations verification](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/verifying-the-authenticity-of-artifacts)
- [Sigstore Cosign verify](https://docs.sigstore.dev/cosign/verifying/verify/)
- [OCI image-spec manifest](https://github.com/opencontainers/image-spec/blob/main/manifest.md)
- [Kubernetes server-side apply](https://kubernetes.io/docs/reference/using-api/server-side-apply/)
