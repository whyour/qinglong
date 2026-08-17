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

以下命令应在可信维护工作站运行；先设置目标发布的显式值、三个经过 `realpath` 解析的工具路径，以及一个
current-owner、无 group/other 权限、无换行的短期 GitHub token file。`output_parent` 必须是已有的 owner-private
目录，`bundle` 必须尚不存在：

```sh
owner='<lowercase-owner>'
repository='<owner>/<source-repository>'
version='<source-derived-version>'
scope='local' # 或 cluster/all
source_ref='refs/tags/v<version>'
source_revision='<40-hex-git-revision>'
regctl_path='<canonical-absolute-path>/regctl'
cosign_path='<canonical-absolute-path>/cosign'
gh_path='<canonical-absolute-path>/gh'
token_file='<canonical-absolute-owner-private-token-file>'
output_parent='<canonical-absolute-owner-private-directory>'
bundle="${output_parent}/qinglong3-release-catalog-consumption-${version}-${scope}"
```

使用机器化 ceremony 完成 discovery 双次解析、immutable Cosign/GitHub provenance 验证、release-set 下载/inspection、raw
manifest/plan/receipt reconstruction 和 no-replace bundle 发布：

```sh
node scripts/ql3-release-catalog-consumption-ceremony.cjs \
  --mode=create \
  --version="${version}" \
  --source-revision="${source_revision}" \
  --source-ref="${source_ref}" \
  --release-scope="${scope}" \
  --repository-owner="${owner}" \
  --source-repository="${repository}" \
  --regctl="${regctl_path}" \
  --cosign="${cosign_path}" \
  --gh="${gh_path}" \
  --github-token-file="${token_file}" \
  --output-directory="${bundle}"

node scripts/ql3-release-catalog-consumption-ceremony.cjs \
  --mode=audit \
  --version="${version}" \
  --source-revision="${source_revision}" \
  --source-ref="${source_ref}" \
  --release-scope="${scope}" \
  --repository-owner="${owner}" \
  --source-repository="${repository}" \
  --output-directory="${bundle}"

catalog_manifest="${bundle}/qinglong3-release-catalog-manifest-${version}-${scope}.json"
consumption_report="${bundle}/qinglong3-release-catalog-consumption-${version}-${scope}.json"
```

bundle 只能包含上面三项 `0600` 文件，目录自身为 `0700`。ceremony 不使用 shell 重定向、不覆盖文件，并在每一步前与
结束前复验三个 executable；GitHub token 只进入一个 `gh attestation verify` 子进程。raw manifest 让离线 audit 能重建
catalog plan/receipt，但它不会离线重放网络签名，因此 audit 输出必须保持 `externalToolResultsReplayed:false`。

若改用 90 天 Actions bundle 的 release-set 文件，仍需另行验证该文件的 provenance；它不能替代上述 immutable catalog
ceremony，也不能与在线 ceremony 下载的文件混合后伪造成同一 three-file bundle。

## 生成离线 deployment lock

`audit` 成功后，不要从 bundle 中抽出 release-set 再作为独立输入，不要手工复制 digest，也不要直接修改仓库中的
Kustomize 占位符。deployment-lock materializer 在可信工作站离线运行，必须重新审计完整 three-file bundle，并让同一次审计
读取的 release set 直接进入物化；它不访问 registry、不连接 Kubernetes API，也不会执行 `kubectl apply`。

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
  --source-repository="${repository}" \
  --consumption-bundle="${bundle}" \
  --allow-root-service=false \
  --output="${selection}"

node scripts/ql3-deployment-lock-contract.cjs \
  --mode=local-audit \
  --version="${version}" \
  --source-revision="${source_revision}" \
  --source-ref="${source_ref}" \
  --release-scope="${scope}" \
  --repository-owner="${owner}" \
  --source-repository="${repository}" \
  --consumption-bundle="${bundle}" \
  --allow-root-service=false \
  --selection="${selection}"
```

v2 selection 同时绑定 catalog immutable reference、manifest digest、consumption report digest 与 release-set digest。不要再手工复制
`service.image`。把 selection 放入目标运行 UID 控制的 canonical `0700` 目录，保持文件为单链接 `0600`，然后把它的 absolute path 与
`local-audit` 返回的 exact `selectionDigest` 写入 Local prepare/upgrade 的 `releaseSelection`。目标侧会再次验证 canonical JSON、
self-digest、release/catalog identity、唯一 GHCR Local image 与 explicit root policy，再把完整 provenance 固化到 Compose v2 revision。
selection 本身不修改 Compose 文件，也不启动容器；prepare/upgrade 仍不等于 preflight/apply authority。

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
  --source-repository="${repository}" \
  --consumption-bundle="${bundle}" \
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
  --source-repository="${repository}" \
  --consumption-bundle="${bundle}" \
  --manifest="${rendered}" \
  --locked-manifest="${locked}" \
  --report="${lock_report}" \
  --required-images=control
```

materializer 只改写 Pod、Deployment、StatefulSet、DaemonSet、ReplicaSet、Job、CronJob 的
`containers`/`initContainers`/`ephemeralContainers`，以及固定名称
`ql3-plugin-package-secret-action-admission` ConfigMap 的 `data.image`。每个改写资源及其 Pod template 都绑定 release-set、catalog
manifest、consumption report digest、source revision 与 version annotation；未知位置的完整 QingLong role image authority、畸形
已知 container image、缺少 required role、YAML alias/cycle/非 mapping、超限输入或已有输出文件都会失败关闭。

审计成功并完成人工差异检查后，不要再直接执行裸 `kubectl apply -f "${locked}"`，也不要 apply `${rendered}` 或使用
`kubectl apply -k` 绕过 deployment lock。目标侧必须使用下面的独立 preflight/apply ceremony。

### Kubernetes 目标 preflight 与 apply

先确认所有承载 QingLong image authority 的资源都显式填写 `metadata.namespace`，且目标 Namespace 已存在；禁止依赖 context 的
ambient default namespace。server-side dry-run 不会持久化同一 multi-document 输入中排在前面的 Namespace，因此不能把“创建
Namespace”和“在该 Namespace 内验证首批对象”混成一次隐式动作。取得并人工核对目标 cluster 的
`kube-system` Namespace UID：

```sh
kubectl --kubeconfig="${kubeconfig}" --context="${context}" \
  get namespace kube-system -o=jsonpath='{.metadata.uid}'
```

ceremony 目录必须为当前 UID 的 canonical `0700` 目录；command、locked manifest、lock report、kubeconfig、preflight 与 receipt
都必须是单链接 `0600` 文件。kubectl 使用 realpath 后的 absolute executable，并记录其 SHA-256。kubeconfig 禁止 `exec` 与
`auth-provider`。每个 kubectl 调用使用独立临时 HOME/XDG cache/TMPDIR，结束即清理，不读取 ambient HOME 或在当前目录创建
`.kube/cache`。目标 Namespace 还承载固定名称 `qinglong3-deployment-head` 的小型 ConfigMap。它不属于应用 manifest，也不由
server-side apply 接管；ceremony 只通过 API Server 返回的 opaque `resourceVersion` 执行 create/replace CAS。第一次安装使用
`install` 和空 Head；后续 `upgrade`/`rollback` 必须从上一份 receipt 的 `deploymentHead` 复制 generation、deployment/lock/state
digest，不能自行推测。以下是第一次安装的 preflight command 逻辑结构；实际文件必须用 `JSON.stringify(value) + "\n"` 写成单行
canonical JSON，并以 `0600` no-replace 创建：

```json
{
  "schemaVersion": 1,
  "schema": "qinglong/kubernetes-deployment-command@v2",
  "operation": "cluster.deployment.preflight",
  "request": {
    "preflightId": "<new UUID>",
    "lockedManifest": {
      "path": "<canonical absolute locked.yaml>",
      "expectedDigest": "<lock report manifest.outputDigest>"
    },
    "lockReport": {
      "path": "<canonical absolute lock.json>",
      "expectedDigest": "<lock report lockDigest>"
    },
    "kubectl": {
      "path": "<canonical absolute kubectl>",
      "expectedDigest": "<SHA-256 of kubectl bytes>"
    },
    "kubeconfig": {
      "path": "<canonical absolute kubeconfig>",
      "expectedDigest": "<SHA-256 of kubeconfig bytes>"
    },
    "context": "<explicit context>",
    "expectedClusterUid": "<reviewed kube-system UID>",
    "transitionKind": "install",
    "expectedHead": {
      "generation": 0,
      "deploymentDigest": null,
      "lockDigest": null,
      "stateDigest": null
    },
    "output": "<unused canonical absolute preflight.json>"
  }
}
```

运行：

```sh
pnpm cluster-deployment:ql3 -- --command-file="${preflight_command}"
```

成功后，人工核对返回的 `preflightDigest`、lock/catalog digest、cluster UID、完整 resource inventory、`deploymentHead` 和
`kubernetesMutation:false`。apply 必须使用新的 mutation UUID，并精确复用 transition、expected Head 与所有 target/input
authority：

```json
{
  "schemaVersion": 1,
  "schema": "qinglong/kubernetes-deployment-command@v2",
  "operation": "cluster.deployment.apply",
  "request": {
    "mutationId": "<new UUID>",
    "preflight": {
      "path": "<canonical absolute preflight.json>",
      "expectedDigest": "<preflightDigest>"
    },
    "lockedManifest": {
      "path": "<same locked.yaml>",
      "expectedDigest": "<same manifest.outputDigest>"
    },
    "lockReport": {
      "path": "<same lock.json>",
      "expectedDigest": "<same lockDigest>"
    },
    "kubectl": {
      "path": "<same kubectl>",
      "expectedDigest": "<same kubectl SHA-256>"
    },
    "kubeconfig": {
      "path": "<same kubeconfig>",
      "expectedDigest": "<same kubeconfig SHA-256>"
    },
    "context": "<same context>",
    "expectedClusterUid": "<same cluster UID>",
    "transitionKind": "install",
    "expectedHead": {
      "generation": 0,
      "deploymentDigest": null,
      "lockDigest": null,
      "stateDigest": null
    },
    "output": "<unused canonical absolute receipt.json>"
  }
}
```

同样通过 `cluster-deployment:ql3` 执行。apply 先重读 Head 并以 create/resourceVersion replace 把唯一意图置为 `applying`，再重新
完成 lock 检查、cluster identity 和 server-side dry-run，然后以固定 `qinglong3-catalog-lock` field manager 执行 server-side
apply，不使用 `--force-conflicts`；最后读取 live objects，验证
UID/resourceVersion、完整期望字段、四类 immutable image/catalog annotations 和受影响资源的 managed-field ownership，再次确认
cluster UID，最后以同一 ConfigMap 的新 resourceVersion 提交 `committed` Head 后才发布 receipt。Head 保存当前与前一 deployment
摘要、完整有序 resource inventory、五个 workload step digest 和 self digest；它不保存 credential、token 或 manifest 正文。

`upgrade` 只接受严格递增 SemVer，且 active inventory 必须是目标 inventory 的子集；遗漏对象不会借助隐式 prune 删除，而是在
mutation 前失败关闭。`rollback` 只接受 Head 中精确的上一部署 lock，且当前/目标 inventory 必须完全相同；涉及资源退休时须等待
独立的 UID/resourceVersion-precondition retirement ceremony，不能把遗留对象伪装成回滚成功。

### Kubernetes 资源退役

缩小 active inventory 必须显式使用 `cluster.deployment.retirement.preflight`，不能先手工删除，也不能使用 `kubectl delete -f`、
`kubectl apply --prune`、force delete 或 `--grace-period=0`。只允许退役 current locked manifest 与 committed Head inventory 中的
namespaced 非 credential/data 对象；`Secret`、`PersistentVolumeClaim`、`ServiceAccount`、cluster-scoped resource 和固定 Head
ConfigMap 均须走专用运维流程。survivor inventory 必须仍包含 control、control-ai、admin、worker 四类 authority。

除上文相同的 locked manifest、lock report、kubectl、kubeconfig、context、cluster UID 与 expected Head 外，retirement command
还必须固定 realpath 后的 curl executable digest，并提交至多 64 个按 `apiVersion/kind/namespace/name` 排序的 target：

```json
{
  "schemaVersion": 1,
  "schema": "qinglong/kubernetes-deployment-command@v2",
  "operation": "cluster.deployment.retirement.preflight",
  "request": {
    "preflightId": "<new UUID>",
    "lockedManifest": "<same path/digest object>",
    "lockReport": "<same path/digest object>",
    "kubectl": "<same path/digest object>",
    "curl": {
      "path": "<canonical absolute curl>",
      "expectedDigest": "<SHA-256 of curl bytes>"
    },
    "kubeconfig": "<same path/digest object>",
    "context": "<same context>",
    "expectedClusterUid": "<same cluster UID>",
    "expectedHead": "<exact current committed Head fields>",
    "targets": [
      {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "namespace": "qinglong-system",
        "name": "obsolete-release-resource"
      }
    ],
    "output": "<unused canonical absolute retirement-preflight.json>"
  }
}
```

示例中的 `"<same path/digest object>"` 与 `"<exact current committed Head fields>"` 是文档占位符，实际 command 必须展开为上文
展示的 JSON object，且仍须是单行 canonical JSON。运行同一个 `pnpm cluster-deployment:ql3 -- --command-file=...` 入口。preflight
逐对象读取 exact UID/resourceVersion 与 Apply ownership，并向 API Server 发送带 Preconditions 的 `DeleteOptions` dry-run；成功报告
保持 `kubernetesMutation:false`。人工核对 active/survivor inventory、target observation 和两个 tool digest 后，生成
`cluster.deployment.retirement.apply` command：把 `preflightId` 改为新 `mutationId`，增加
`preflight={path,expectedDigest}`，其余 authority 与 targets 必须逐字一致，output 改为新的 retirement receipt 路径。

apply 在删除前再次读取对象并 CAS Head 为 `applying`，随后通过 owner-private Unix socket proxy 发送带同一 UID/resourceVersion
preconditions 和 Background propagation 的 DELETE。只有 old UID 已确认 absent 才会提交缩小 inventory 的下一代 Head。若 DELETE
响应丢失，保留 command 与 preflight 原文件并原样重跑；只有相同 applying intent 且对象已经 absent 才可恢复。对象被新 UID 替换、
resourceVersion 漂移、处于 terminating 或 Head 已被其他意图推进时必须人工处理，不能改 command 绕过围栏。

退役收据使用 `cluster.deployment.retirement.receipt.audit` 离线审计，结构与普通 audit 相同，但 applyCommand 必须指向 retirement
apply command。成功 audit 只证明 command/receipt digest 闭包，不重放外部删除结果。

离线审计使用 `cluster.deployment.receipt.audit` command，其中 `applyCommand.expectedDigest` 是 apply command 文件完整字节的
SHA-256，`receipt.expectedDigest` 是 receipt 内的 `receiptDigest`。审计不会访问 Kubernetes API，结果必须保持
`externalResultsReplayed:false`、`kubernetesMutation:false`。

多资源 apply 不是事务，也不提供自动删除式 rollback。失败或 receipt 响应丢失时保留原文件：只有相同 command/mutation/preflight
意图能从 `applying` Head 重做 live convergence；不同意图和陈旧 preflight 都失败关闭。若 Head 已 `committed` 但本地 receipt 丢失，
同一 command 可从目标 Head 确定性重建 receipt。已有本地 receipt 的重放也会联网确认 Head 尚未前进，不能离线冒充当前部署。

## 准入检查

1. 只接受已验证 Cosign exact workflow identity 与 GitHub source tag/revision provenance 的 catalog immutable
   reference；discovery tag 无 authority。
2. materializer 只能接受完整 `qinglong/release-catalog-consumption-ceremony@v1` bundle，不能接受旧的松散 `--release-set`；其中
   `qinglong/release-set@v1` 的 `release.version`、`release.sourceRef`、`release.sourceRevision`、`release.scope` 必须与变更单一致。
3. 镜像集合必须与上表精确相等；每个 `reference` 必须是 digest reference，且 owner/repository 与部署目标一致。
4. Kubernetes 必须先渲染 overlay，再用离线 post-render materializer 生成和复验 v2 locked manifest；嵌套 overlay 的
   `newName`/digest 不是最终 authority。Local 必须生成并审计 v2 service selection。两族输出都必须绑定同一 catalog manifest、
   consumption report 与 release-set digest，并且只能消费 release set 中的 `@sha256:` reference。
5. rollout 前再次确认 catalog receipt/immutable reference 与已检查文件一致。Kubernetes 必须把 locked manifest/report、pinned
   kubectl/kubeconfig 和目标 cluster UID 绑定进 preflight/apply receipt；version/source/catalog tag 都只能用于发现，部署始终以
   release set 中的镜像 digest 为准。

## 低资源设备

路由器或其他低配 Edge 设备不需要安装 Node、regctl、Cosign、GitHub CLI、Kustomize 或 materializer。维护者在可信工作站
完成上述 ceremony 和 Local v2 selection 审计，再向设备传输已检查的 catalog-bound canonical JSON，并只把 `local` family 的
immutable image reference 写入 compose/rollout。
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
