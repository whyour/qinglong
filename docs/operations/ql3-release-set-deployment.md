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

## 生成离线 deployment lock

`inspect` 成功后，不要手工复制 digest，也不要直接修改仓库中的 Kustomize 占位符。deployment-lock
materializer 在可信工作站离线运行，只读取已经验证的 release set 与本地清单；它不访问 registry、不连接 Kubernetes
API，也不会执行 `kubectl apply`。

### Local / Compose

对 `local` 或 `all` scope 生成一个 canonical、0600、no-replace 的 service selection：

```sh
selection="$(pwd)/qinglong3-local-selection-${version}.json"

node scripts/ql3-deployment-lock-contract.cjs \
  --mode=local-create \
  --version="${version}" \
  --source-revision="${source_revision}" \
  --source-ref="${source_ref}" \
  --release-scope="${scope}" \
  --repository-owner="${owner}" \
  --release-set="${release_set}" \
  --allow-root-service=false \
  --output="${selection}"

node scripts/ql3-deployment-lock-contract.cjs \
  --mode=local-audit \
  --version="${version}" \
  --source-revision="${source_revision}" \
  --source-ref="${source_ref}" \
  --release-scope="${scope}" \
  --repository-owner="${owner}" \
  --release-set="${release_set}" \
  --allow-root-service=false \
  --selection="${selection}"
```

把已审计的 `service.image` 和 `service.allowRootService` 交给现有 Local private prepare/rollout 入口。selection
本身不修改 Compose 文件，也不启动容器。是否允许 root service 必须显式给出，不能由设备默认值推断。

### Kubernetes / Cluster / Worker

先用已审核 overlay 生成普通多文档 YAML，再把它作为 post-render 输入。以下是 Cluster Core 示例；AI、Worker、Admin
清单分别把 `required-images` 设为 `control-ai`、`worker`、`admin`，组合清单则按发布顺序使用
`control,control-ai,admin,worker`：

```sh
rendered="$(pwd)/ql3-cluster-rendered.yaml"
locked="$(pwd)/ql3-cluster-locked.yaml"
lock_report="$(pwd)/ql3-cluster-deployment-lock.json"

kubectl kustomize deploy/kubernetes/ql3-cluster/overlays/cloudnative-pg > "${rendered}"

node scripts/ql3-deployment-lock-contract.cjs \
  --mode=kubernetes-create \
  --version="${version}" \
  --source-revision="${source_revision}" \
  --source-ref="${source_ref}" \
  --release-scope="${scope}" \
  --repository-owner="${owner}" \
  --release-set="${release_set}" \
  --manifest="${rendered}" \
  --required-images=control \
  --output-manifest="${locked}" \
  --output-report="${lock_report}"

node scripts/ql3-deployment-lock-contract.cjs \
  --mode=kubernetes-audit \
  --version="${version}" \
  --source-revision="${source_revision}" \
  --source-ref="${source_ref}" \
  --release-scope="${scope}" \
  --repository-owner="${owner}" \
  --release-set="${release_set}" \
  --manifest="${rendered}" \
  --locked-manifest="${locked}" \
  --report="${lock_report}" \
  --required-images=control
```

materializer 只改写 Pod、Deployment、StatefulSet、DaemonSet、ReplicaSet、Job、CronJob 的
`containers`/`initContainers`/`ephemeralContainers`，以及固定名称
`ql3-plugin-package-secret-action-admission` ConfigMap 的 `data.image`。每个改写资源及其 Pod template 都绑定
release-set digest、source revision 与 version annotation；未知位置的完整 QingLong role image authority、畸形已知
container image、缺少 required role、YAML alias/cycle/非 mapping、超限输入或已有输出文件都会失败关闭。

审计成功并完成人工差异检查后，才由有权限的独立步骤执行 `kubectl apply -f "${locked}"`。不要直接 apply
`${rendered}`，也不要使用 `kubectl apply -k` 绕过 deployment lock。

## 准入检查

1. 只接受已验证 Cosign exact workflow identity 与 GitHub source tag/revision provenance 的 catalog immutable
   reference；discovery tag 无 authority。
2. `schema` 必须为 `qinglong/release-set@v1`；`release.version`、`release.sourceRef`、
   `release.sourceRevision`、`release.scope` 必须与变更单一致。
3. 镜像集合必须与上表精确相等；每个 `reference` 必须是 digest reference，且 owner/repository 与部署目标一致。
4. Kubernetes 必须先渲染 overlay，再用离线 post-render materializer 生成和复验 locked manifest；嵌套 overlay 的
   `newName`/digest 不是最终 authority。Local 必须生成并审计 service selection。两族最终都只能消费 release set 中的
   `@sha256:` reference。
5. rollout 前再次确认 catalog receipt/immutable reference 与已检查文件一致。version/source/catalog tag 都只能用于
   发现；部署始终以 release set 中的镜像 digest 为准。

## 低资源设备

路由器或其他低配 Edge 设备不需要安装 Node、regctl、Cosign、GitHub CLI、Kustomize 或 materializer。维护者在可信工作站
完成上述 ceremony 和 Local selection 审计，再向设备传输已检查的 canonical JSON，并只把 `local` family 的 immutable
image reference 写入 compose/rollout。
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
