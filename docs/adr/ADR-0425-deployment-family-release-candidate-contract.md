# ADR-0425：按部署族冻结 3.0 Release Candidate，并闭合 Worker 发布集合

- 状态：Accepted（实现与静态/变异门已完成；公开 tag、GHCR digest 和远端证明结果待实际发布）
- 日期：2026-08-16
- 关联 RFC：QL-RFC-0001 D-01、D-03、D-05、D-14、D-42、D-61、D-186、D-257、D-333
- 关联 ADR：ADR-0088、ADR-0128、ADR-0196、ADR-0253、ADR-0254、ADR-0255、ADR-0281、ADR-0420、ADR-0424

## 背景

原唯一 image release workflow 有两项结构问题。第一，version 只由 dispatch input 与 tag 字符串相互校验，
没有把 18 个 QL3 workspace manifest、容器 runtime manifest、Node ABI、Dockerfile version、部署 Profile、
镜像集合与双架构矩阵冻结为同一份可证明契约。第二，Local、Control、Control AI 与 Admin 四个 image 被一个
固定矩阵发布，且无条件等待 Worker management 和 CloudNativePG 两个私有集群证据。这让只使用
Edge/Standalone 的路由器/NAS 发布也依赖集群 HA 基础设施；反过来，真实 Cluster 部署需要的
`qinglong3-worker` 已有 Dockerfile、锁文件、Kubernetes manifests 和 live rollout，却完全不在发布矩阵中。

这不是测试数量问题，而是产品集合和发布 authority 不一致：轻量用户被过度阻塞，集群用户又拿不到完整制品。

## 决策

### 1. 唯一 workflow 支持三个封闭部署族

`.github/workflows/ql3-image-release.yml` 继续是唯一 image publication authority，并只接受显式
`workflow_dispatch` 到 exact protected `v3` tag。新增必选 `release_scope`：

- `local`：仅 `qinglong3-local-application`，服务 Edge/Standalone；
- `cluster`：`control`、可选 AI control、Admin、Worker；
- `all`：同时发布两族，但不得弱化任一族的门禁。

scope 不接受自由文本、额外 repository 或运行时拼接。matrix 只能来自下一节的 source-derived contract，
workflow 内不再维护第二份 image 清单。

### 2. Source-derived release-candidate contract 是矩阵唯一来源

根级 `ql3-release-candidate-contract.cjs` 接受 exact QingLong 3 SemVer、40-hex commit、匹配的完整 tag ref 和
closed scope，随后从受审源码推导 no-replace canonical JSON：

- 18 个 workspace 必须全部通过 package-boundary audit，hard cap 仍为 18，且无 single/shallow package；
- 每个 workspace version 必须等于 tag version，Node engine 必须为 `>=24.18.0 <25`；
- 每个所选 image 的 production manifest、Dockerfile Node 24.18.0 与 OCI version label 必须相同；
- 平台固定 `linux/amd64`、`linux/arm64`；
- Local profile 固定 `edge|standalone` 且不要求 Cluster private evidence；
- Cluster profile 固定 `cluster|worker-edge|worker-node`，必须要求 Worker management 与 CloudNativePG evidence；
- legacy 根 package 的 2.x version 只作为兼容事实记录，并明确排除出 3.0 release identity。

报告携带对自身 unsigned exact JSON 的 SHA-256。publisher 从同一 checkout 重新生成并独立 exact-audit，不能直接
信任 job output 中的任意 repository/path；job output 只传递 contract 派生的有界 matrix 和 cluster evidence bit。

### 3. Local 不再被 Cluster HA 证据阻塞

Local scope 的两个私有 evidence job 必须为 skipped；publisher 仍无条件依赖 release-candidate 与 native OS scan，
并继续对 pushed Local digest 执行 Edge/Standalone 两个真实 compose rollout。Cluster/all scope 才能把 private
evidence bit 置为 true；publisher 使用显式 `always()` 条件，只在 candidate/OS 成功，且 cluster scope 的两个
私有 job 均成功时取得写权限。skipped 不能被当作 Cluster success，failed/cancelled 也不能通过条件表达式旁路。

### 4. Cluster 发布集合必须包含 Worker

Worker 加入与其他 image 相同的 native amd64/arm64 build-once、Trivy 0.70.0 OS-only HIGH/CRITICAL、扫描证据、
OCI merge、production dependency audit、CycloneDX、Cosign keyless、GitHub attestation、远端 manifest 回读和
验证后 tag promotion。Worker production SBOM 当前为 27 components（24 external、3 internal）和 28 dependency
nodes；唯一新增 license allowlist 项是锁中 `asn1js` 的 BSD-3-Clause。OCI config 固定 non-root `65532:65532`、
唯一 Worker process entrypoint、`io.qinglong.profile=worker`、`edge,node` capacity profiles 与 exact 3.0 version。

Control/Admin Dockerfile 同步补 exact 3.0 version label，使 tag、workspace、runtime manifest 与所有 OCI config
首次共享同一 release identity。

### 5. Candidate contract 必须成为 digest-bound 第四类证明

每个发布 digest 除 SLSA、CycloneDX、OS-vulnerability 外，再以
`https://qinglong.dev/attestations/release-candidate-contract/v1` 附加 candidate predicate，并以 repository、
workflow、source digest、source ref、非 self-hosted builder 和 OCI bundle 远端回读。Admin image 内的
`verify-release.sh`、外部 workstation ceremony 与 offline report auditor 同步从三类/七步升级为四类/八步；
否则“生成了 contract”不能算发布者或部署者实际验证过。

## 资源与权限边界

- 不新增 workspace package、npm production dependency、数据库、migration、SQL、role、Pool、connection；
- contract 与 audit 只在显式 release job 短生命周期运行，不进入 Local/Worker/Control/Admin runtime filesystem；
- 不增加 Edge/Standalone timer、watcher、listener、queue、cache 或常驻进程；
- Local scope 不接触 self-hosted private evidence runner；Cluster scope 不得把 skipped 私有证据解释为成功；
- release tag 仍只在所有 digest verification 完成后 promotion，tag 本身不成为部署 authority。

## 失败与恢复

- tag/version/workspace/container version 任一漂移：修正源码并重新创建 tag，不手改报告；
- package boundary 不兼容或出现第 19 个 package：先独立评审边界，不扩大 candidate hard cap；
- Worker SBOM/license/config 漂移：更新锁与供应链 ADR 后重跑，不能从 Cluster scope 静默删除 Worker；
- Local scope 意外等待 Cluster evidence：视为发布拓扑回归；
- Cluster scope 的 private job skipped/failed：publisher 不启动；
- candidate attestation 缺失或远端 source binding 不匹配：不得 promotion version/source tag；
- 公开发布尚不存在：只报告 implementation-ready，不用 fixture、stub 或本机 tag 冒充 GHCR 成功。

## 被拒绝的替代方案

### 为 Local 和 Cluster 复制两套 workflow

拒绝。它会复制 OIDC identity、action pins、scanner、copier、签名和 tag promotion 逻辑，形成安全策略漂移。

### 继续发布固定 all matrix

拒绝。低配用户会被无关 HA 证据阻塞，同时无法表达独立修补 Local image 的发布意图。

### Cluster 不发布 Worker，让运维现场自行 build

拒绝。部署 manifest 已把 Worker 作为产品制品；现场 build 绕过统一 SBOM、OS scan、签名与 provenance。

### 只校验 tag，不持久化 candidate predicate

拒绝。tag 不能证明 workspace、容器、Profile、平台和 gate 集合，也不能让部署端在 digest 上独立回读。

## 验证

- release candidate create/audit、scope/version/source/report mutation：7 项；
- Worker SBOM/OCI、OS policy、共享 release workflow、Admin verifier/ceremony/distribution 定向总计 105/105；
- backend 1,246 pass/2 条件 skip/0 fail，18-package clean build/test 退出 0；
- package boundary 返回 18 packages、hard cap 18、single/shallow 均为空；dependency、Edge import、Cluster/Worker deployment、image release、OS policy、Console/distribution 均 compatible；
- 14 档 Local artifact 全部 compatible；默认 Edge/Standalone 为 2,589,890/2,589,968 bytes，application+AI 为 4,493,043/4,493,175 bytes，MCP 为 7,315,930/7,316,038 bytes；
- Cluster Admin npm pack 为 250 files、271,238-byte tarball、1,690,196-byte unpacked；四个 runtime dependency root 的离线缓存审计为 0 vulnerability；
- 本 Gate 无 schema、migration、SQL、role、Pool 或连接/HA 拓扑变化，因此不重复 PostgreSQL 门，复用 D-331 PostgreSQL 18.6 arm64 physical HA 142/142、timeline `1→2` 基线；
- 公开 tag 后再记录 GHCR 五镜像 digest、四类 attestation 与外部 Admin ceremony，不提前宣称完成。
