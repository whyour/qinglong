# ADR-0255：Build-once Scanned OCI Digest Promotion

- 状态：Accepted（workflow、repository auditor、bundle merger 与负向测试已实现；GitHub-hosted 六矩阵及真实 GHCR 发布记录待取得）
- 日期：2026-08-01
- 关联 RFC：QL-RFC-0001 D-14、D-61、D-128、D-186、D-236、D-237、D-238
- 关联 ADR：ADR-0128、ADR-0196、ADR-0253、ADR-0254
- Supersedes：ADR-0254 决策 5 中 release candidate 到 publisher 的传输方式；ADR-0254 的 base、scanner、漏洞策略与例外治理继续有效

## 背景

ADR-0254 已要求 `control|admin|local × amd64|arm64` 在发布前执行 OS HIGH/CRITICAL 扫描，但原流程的
`os-vulnerability` job 扫描六个 native candidate，持有 GHCR/OIDC 权限的 publisher 随后再次运行 multiarch build。
即使两次 build 使用相同 commit、Dockerfile、lock 和 base digest，也没有密码学事实证明最终发布的 OCI graph 就是
Trivy 检查过的 graph。source reproducibility 不能替代 artifact identity。

QingLong 3.0 需要同时满足供应链完整性和部署分层：集群发布面可以承担短生命周期的构建、合并、证明与 registry I/O；
Edge/Standalone 路由设备只消费最终 digest，不应为发布能力新增 package、scanner、daemon、连接或后台资源。

## 决策

1. release 的六个 native job 各自只 build 一次。Buildx 使用 native runner、exact Dockerfile、source revision、
   SBOM 与 `mode=max` provenance attestation，输出标准 OCI image-layout tar：
   `${RUNNER_TEMP}/ql3-native/image.oci.tar`。禁止 daemon tag、registry candidate tag 或未记录的第二次 build。
2. Trivy 0.70.0 直接通过 `input` 扫描该 OCI tar；D-237 的 OS-only、HIGH/CRITICAL、unfixed 不忽略、cache false、
   central 30-day exception policy 和失败关闭约束保持不变。扫描失败时不会产生可供 publisher 使用的 artifact。
3. 扫描成功后才把同一 tar 解包为 OCI layout。repository-owned recorder 完整审计 native manifest、config、SBOM、
   provenance、platform 和 source revision，生成 `qinglong/native-image-os-vulnerability-evidence@v1`。随后删除 tar，
   只上传 layout 与绑定 evidence，避免重复保存相同 blob。
4. artifact 名必须绑定 `github.run_id + github.run_attempt + image + architecture`，使用 full-commit pinned
   `actions/upload-artifact`，`overwrite=false`、保留 1 天、无隐藏文件。publisher 只按 exact 名称从同一 run attempt
   下载 amd64 与 arm64；artifact 不包含 D-236 的私密 release evidence、token、Secret 或个人信息。
5. publisher 不安装 QEMU/Buildx，不运行 Dockerfile，也不得 rebuild。repository-owned merger 重新验证两份 native
   evidence 与所有 OCI blob，排除 native root index 后复制被引用内容，确定性构造一个双架构 OCI index，并再次执行
   完整 OCI layout 审计。输出目录必须是未存在的 canonical 隔离路径；失败时清除部分输出。
6. merger 生成 `qinglong/image-os-vulnerability-release-evidence@v1`，将最终 index digest 绑定到 source revision、
   scanner/policy、两个 native root、manifest/config 与 attestation digest。该 predicate 不能由 workflow 手写或只依赖
   job 成功状态。
7. publisher 在本地 merge/audit 完成后才登录 GHCR。`regctl` 固定 v0.11.5 Linux amd64 binary 及 SHA-256
   `c93aa7638749f5aaac1a8e01787321889c78f0101809bb2880343478d0ba0467`，只允许把合并后的 OCI archive
   导入 `IMAGE@sha256:...`，并立即读取远端 digest 精确比对；禁止先导入 movable tag。
8. 远端 exact digest 必须完成 Cosign keyless signature、SLSA provenance、CycloneDX 和自定义 OS vulnerability
   GitHub attestation，随后逐项按 repository/source/predicate type 验证，并通过 manifest 与本机 rollout preflight/apply。
   version tag 与完整 `sha-${GITHUB_SHA}` tag 只能在全部 digest verification 后由最后一个 publisher step 创建；其后
   不允许任何 step。
9. 本决策只增加 repository workflow、script、test 和文档。workspace 保持 19 个 package；不新增 production
   dependency、migration、Profile artifact、daemon、controller、timer、watcher、listener、Pool 或端口。Edge 与
   Standalone 稳态成本为零，Cluster 节点也只消费最终 digest；额外成本仅存在于受保护 release job。

## 失败与恢复

- native build、attestation 或 Trivy 失败：对应 artifact 不上传，publisher 因 `needs` 失败而不启动；修复后重新发起
  新 run，不复用旧 artifact；
- artifact 缺失、过期、名称/run attempt 不匹配或 evidence 与 layout 不一致：merge 失败且不得登录 registry；
- merge 检测到 architecture、source revision、SBOM/provenance 或 blob digest 漂移：删除部分输出，重新从 native job
  开始，不用 tag 或重新打包掩盖差异；
- regctl 下载/checksum 失败：发布失败，不回退到 movable binary、Docker daemon push 或未经审计的 copier；
- digest import 后任一 signature/attestation/manifest/rollout verification 失败：不创建 release tags；按 exact digest
  调查或清理 registry 中未打 tag 的对象，修复后用新 run 重新发布；
- version/commit tag promotion 失败：已验证 digest 仍可按 digest 审计，但发布不算完成；重跑前先确认 tag 未被其他
  digest 占用，不覆盖不一致 tag。

## 被拒绝的替代方案

### 扫描一次、按相同 source 再 build

拒绝。它证明的是输入接近，而不是最终发布 artifact identity；BuildKit、网络依赖、时间或上游元数据都可能造成差异。

### 扫描 daemon/registry candidate tag

拒绝。tag 可移动，且会在 vulnerability gate 完成前把 candidate 写入 registry；OCI tar input 直接绑定扫描对象。

### 上传 tar 与解包 layout 两份副本

拒绝。OCI digest 由 layout graph 决定，重复上传 blob 增加 artifact 存储与传输；扫描后解包、审计并移除 tar 保持同一
graph，同时让 publisher merger 使用有界目录输入。

### publisher 用 Buildx 创建 multiarch manifest

拒绝。publisher 再次获得 build authority 会恢复 artifact gap。确定性 repository merger 只处理已验证 OCI descriptors。

### 提前创建 candidate/version tag 再验证

拒绝。失败产物会暴露为可消费引用，也允许验证与最终 tag 指向不同 digest；tag promotion 必须是最后一步。

## 验证

- `ql3ClusterImageReleaseAudit` 与 `ql3ClusterOciLayoutAudit` 合计 57/57，覆盖 exact OCI tar input、action pin、
  1-day/no-overwrite artifact、same-run-attempt download、privileged rebuild 禁止、regctl checksum、digest import、
  双架构 deterministic merge、native evidence tamper、三类 GitHub attestation 与 tag-last；
- `audit:image-release:ql3` 返回 `buildOnce=true`、`attestedToPublishedDigest=true`、
  `rebuildAfterScan=false`、`tagAfterVerification=true`；
- workflow YAML、两个 repository script 的语法检查通过；
- PostgreSQL 18.4 arm64 physical HA 同轮重新通过 `remote_apply`、timeline 1→2、旧主 fencing、`pg_rewind`
  只读同步重入、两个 fresh control replica 与全部领域 gate，`gates.passed=true`；fixture 结束后 HA 容器、卷、网络零残留；
- 本机真实 OCI build 因 Docker container driver 获取 BuildKit SBOM scanner 时网络超时，未形成 live image/CVE clean
  证据；GitHub-hosted 六 native job、regctl→GHCR exact-digest import 和完整 attestation/tag promotion 仍是外部门禁。

## 上游依据

- Docker Buildx OCI exporter 与 attestation：<https://docs.docker.com/reference/cli/docker/buildx/build/>、
  <https://docs.docker.com/build/metadata/attestations/>；
- Trivy image/tar/OCI input：<https://www.trivy.dev/docs/v0.69/guide/target/container_image/>；
- GitHub artifact immutable upload：<https://github.com/actions/upload-artifact>；
- GitHub custom attestations：<https://github.com/actions/attest>；
- regctl OCI archive import：<https://regclient.org/cli/regctl/image/import/>。
