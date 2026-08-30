# ADR-0509：Cluster Alpha Bundle 与跨架构里程碑闭合

- 状态：Accepted（首份实际 Cluster milestone 已交付）
- 日期：2026-08-28
- 决策：D-414
- 关联：ADR-0503、ADR-0506、ADR-0508

## 背景

QingLong 3.0 已开发约二十天。Local Alpha 已有双架构 Trial Kit 和完整 CI 后置 milestone index，但 Cluster 的 control、control-ai、admin、worker 仍由矩阵 job 内的 shell 各自生成 Docker archive 和一份 v1 manifest。

旧 Cluster archive 没有 `SHA256SUMS`、闭合文件集、独立 verification evidence 或可离线 auditor；manifest 直接把 gate 写成 `passed`，没有绑定 workflow ref/SHA、run ID/attempt 和 exact image ID。八个 artifact 也没有完整 CI 后置的唯一完成信号。部署者无法区分“某个矩阵 job 上传成功”与“本次阶段版本整体成立”。

## 决策

### 1. 单镜像 bundle 由仓库脚本统一物化

新增 `ql3-cluster-alpha-bundle.cjs`，固定四角色的 repository、OCI title、runtime user 和两种架构。bundle schema 为 `qinglong/alpha-cluster-image@v1`，文件集恰好包含：单镜像 Docker archive、对应 CycloneDX SBOM、`verification-evidence.json`、README、manifest 和 `SHA256SUMS`。

物化前必须重新检查 image reference、ID、OS、architecture、non-root user、source/version/title label，复用现有 SBOM closure audit，并验证 evidence 绑定 exact source、role、architecture、image ID、workflow ref/SHA、run/attempt 和 gate 集。离线 audit 不调用 Docker或网络，拒绝额外文件、symlink、长度/digest、SBOM/evidence 或 checksum 漂移。

### 2. 八个 bundle 只有在完整 CI 后才能闭合

新增 `cluster-alpha-milestone` finalizer，依赖现有完整 CI 的 19 个顶层 job。它下载同一 source 的四角色乘 amd64/arm64 八个 artifact，逐个离线复审，并要求 version/source/run/attempt 一致，image ID、archive digest 和 verification digest 八项均互不复用。

成功后上传 `qinglong/alpha-cluster-milestone@v1` 三文件索引。索引保存八个 artifact 名、bundle manifest digest、archive digest、image ID 和 verification digest。缺少索引的零散 archive 是中间文件，不是阶段版本。

### 3. 仍不把 Integration Candidate 冒充 Public Release

Cluster milestone 的 maturity 固定为 `cluster_integration_candidate_not_public_release`。它可供隔离 registry/K3s/Kubernetes 节点做多组件集成，但没有受保护 tag、GHCR immutable digest、签名/attestation、release catalog 或生产 deployment lock。正式发布继续由 Public Release Set 独立裁决。

## 被拒绝的替代方案

- 保留 workflow 内联 shell：难以单测和离线复核，manifest 仍会自报通过。
- 只依赖 GitHub job 绿色状态：下载物与 workflow 主体没有内容级绑定，失败运行也可能留下部分 archive。
- 把八个 archive 合并为一个超大 artifact：会重复下载和存储，对只需要特定角色/架构的部署者不友好。
- 将 Cluster candidate 直接提升为正式发布：缺少 registry、签名、catalog 和生产部署闭环。

## 影响

- 显式 `alpha_artifact_scope=cluster|all` 时增加 verification 文件、离线 audit 和一次八 artifact finalization；普通 push/PR 不生成大产物；
- 每个部署者只下载目标架构/角色，milestone 本身保持三文件小索引；
- 新实现属于 repository release tooling，不新增 workspace package、runtime dependency、镜像 layer、端口、daemon、timer、连接池或稳态 RSS；
- Local 的路由/NAS 稳态边界不变，Cluster 节点获得可裁决的阶段集成产物。

## 验证

- bundle 正向测试覆盖闭合六文件、image/SBOM/evidence identity 与离线 audit；
- 负向测试覆盖 root user、archive/SBOM/evidence 篡改、额外文件和 image subject 脱离；
- milestone 正向测试闭合八项，并覆盖跨 workflow run 混用、index mutation、额外文件和 workflow 门序；
- 静态 audit 固定 19 个完整 CI dependency、八 artifact 下载和 `finalize → audit → upload`；
- 首份真实产物已由显式 `produce_alpha_artifacts=true + alpha_artifact_scope=all` 的 run `33265538836` 生成；八个 bundle 与 milestone 均绑定提交 `97333da34cce48cdfcfa1bbd5e8d48340802d2ef` 和 attempt 1。
