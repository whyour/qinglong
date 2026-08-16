# QingLong 3.0 release-set 部署准入

生产部署的镜像 authority 是持久 OCI catalog 中经过签名、provenance 与逐字节回读验证的 immutable release-set
reference，不是可变 version/source/catalog tag。Actions 中保留 90 天的同名 bundle 只用于便利下载。

发布入口为：

```text
ghcr.io/<owner>/qinglong3-release-catalog:v<version>-<scope>
```

该 discovery tag 只用于发现。先把它解析为
`ghcr.io/<owner>/qinglong3-release-catalog@sha256:<manifest-digest>`，验证这个 immutable reference 后，再从 JSON 的
`images[].reference` 读取完整 `ghcr.io/<owner>/<repository>@sha256:<digest>`。

## 选择 scope

| 部署类型 | release scope | 必须出现的镜像 |
| --- | --- | --- |
| 低配路由器、Edge、Standalone | `local` | `local` |
| Kubernetes/Cluster | `cluster` | `control`、`control-ai`、`worker`、`admin` |
| 同时发布两族 | `all` | 上述五个镜像 |

Local 用户不需要下载 Cluster 镜像，也不依赖 CloudNativePG 或 Worker 私有发布证据。Cluster 运维者不能拿 Local
image 的证明替代任一角色镜像；尤其 Worker 与短生命周期 Admin 必须有各自 digest。

## 工作站验真

以下命令应在可信维护工作站运行；先设置目标发布的显式值：

```sh
owner='<lowercase-owner>'
repository='<owner>/<source-repository>'
version='<source-derived-version>'
scope='local' # 或 cluster/all
source_ref='refs/tags/v<version>'
source_revision='<40-hex-git-revision>'
catalog="ghcr.io/${owner}/qinglong3-release-catalog"
discovery="${catalog}:v${version}-${scope}"
digest="$(regctl image digest "${discovery}")"
immutable="${catalog}@${digest}"
release_set="$(pwd)/qinglong3-release-set-${version}-${scope}.json"
```

要求 `digest` 精确匹配 `sha256:<64 lowercase hex>`，然后按 immutable reference 下载并验证：

```sh
regctl artifact get \
  --file "qinglong3-release-set-${version}-${scope}.json" \
  "${immutable}" > "${release_set}"

cosign verify \
  --certificate-identity \
  "https://github.com/${repository}/.github/workflows/ql3-image-release.yml@${source_ref}" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  "${immutable}"

gh attestation verify "oci://${immutable}" \
  --repo "${repository}" \
  --signer-workflow "${repository}/.github/workflows/ql3-image-release.yml" \
  --source-digest "${source_revision}" \
  --source-ref "${source_ref}" \
  --deny-self-hosted-runners \
  --bundle-from-oci

node scripts/ql3-release-set-contract.cjs \
  --mode=inspect \
  --version="${version}" \
  --source-revision="${source_revision}" \
  --source-ref="${source_ref}" \
  --release-scope="${scope}" \
  --repository-owner="${owner}" \
  --report="${release_set}"
```

若使用 90 天 bundle 中的文件，还应验证文件 provenance；它是 OCI catalog 的补充证据，不替代上述 immutable
catalog 验证：

```sh
gh attestation verify "${release_set}" \
  --repo "${repository}" \
  --signer-workflow "${repository}/.github/workflows/ql3-image-release.yml" \
  --source-digest "${source_revision}" \
  --source-ref "${source_ref}" \
  --deny-self-hosted-runners
```

`inspect` 会重算 release-set self digest 并验证结构、身份、镜像闭包和 family，但不会重放发布时已经过期的 image
records；其输出必须保持 `sourceRecordsReplayed:false`。

## 准入检查

1. 只接受已验证 Cosign exact workflow identity 与 GitHub source tag/revision provenance 的 catalog immutable
   reference；discovery tag 无 authority。
2. `schema` 必须为 `qinglong/release-set@v1`；`release.version`、`release.sourceRef`、
   `release.sourceRevision`、`release.scope` 必须与变更单一致。
3. 镜像集合必须与上表精确相等；每个 `reference` 必须是 digest reference，且 owner/repository 与部署目标一致。
4. Kubernetes overlay 用 `newName` 加 digest 或等价的 immutable image reference；不得把生产 placeholder 改成
   `newTag`。Local compose/rollout 同样固定 `@sha256:`。
5. rollout 前再次确认 catalog receipt/immutable reference 与已检查文件一致。version/source/catalog tag 都只能用于
   发现；部署始终以 release set 中的镜像 digest 为准。

## 低资源设备

路由器或其他低配 Edge 设备不需要安装 Node、regctl、Cosign 或 GitHub CLI。维护者在可信工作站完成上述 ceremony，
再向设备传输已检查的 canonical JSON，并只把 `local` family 的 immutable image reference 写入 compose/rollout。
设备不下载 Cluster 四镜像，也不加载 Kubernetes、CloudNativePG、PostgreSQL driver 或 Worker 私有发布证据。

如果设备本身不运行容器 registry client，可由工作站按 digest 拉取并通过既有离线交付渠道传送镜像；离线包的哈希与
导入后 image digest 必须继续匹配 release set，不能退回 tag。

## 发布失败与恢复

GHCR 不提供跨 repository tag 事务，release set 明确记录 `crossRepositoryAtomicity=false`。如果 promotion 中途
失败，不删除已经正确的 tag，也不重新构建镜像。使用原 source tag/revision 重跑 release workflow：它会先验证
每个 source digest 和既有 tag；既有 tag 指向同一 digest 时继续，指向其他 digest 时立即失败。只有
release-set、catalog immutable digest、两类 provenance 与 receipt 全部生成并验证后，才能宣布该 deployment family
可部署。

workflow bundle 当前保留 90 天；长期入口是 OCI catalog 的 immutable digest。GHCR 并非 WORM，release owner 仍须维护
package 可见性、读取权限和满足组织要求的 retention/备份策略。任何归档或镜像过程都不得改写 canonical JSON，并须保留
原 catalog manifest digest、receipt 与 provenance 关联。
