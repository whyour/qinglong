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

## 私有发布证据收据链

当前长期 authority 是 `qinglong/release-set@v3`。`local` scope 的 `evidenceReceipts` 必须为空；`cluster|all` 必须按顺序恰好包含
`worker-management` 与 `cloudnativepg-disaster-recovery` 两份 `qinglong/private-release-evidence-receipt@v2`。每份收据绑定同一
version/source tag/revision/scope、24 小时 freshness、私有报告 digest 和自身 digest；DR 收据还绑定 CloudNativePG backup、Barman Cloud 与
cert-manager 三项静态审计摘要。v2 收据不持久化私有 runner 的 wall-clock：创建时仍必须以当前时钟完成 freshness gate，但 durable JSON 只绑定
不可变报告的 `observedAt`。因此相同 source/report/static-lock 在 workflow 重跑时逐字节相同，不会仅因重跑时间变化而生成第二个 catalog identity。

这些收据不包含原始生产报告、路径、credential、token、Kubernetes object 或 transcript。公开 consumer 可以重算收据和 release-set digest，
但必须保持 `publicConsumerReplay=not_possible_without_private_reports`；它不能声称重放了私有现场结果。原始报告不上传，只有收据以 1 天 artifact
从私有 job 交给 release-set job，随后完整嵌入 release-set v3 并由 durable catalog 长期保护。公开收据同时声明
`freshnessValidatedAtCreation=true` 与 `durableValidationClockPublished=false`，避免把未发布的临时时钟伪装成可离线重放的现场证据。

创建时通过不等于可以无限期等待再闭合发布。`cluster|all` 的 release-set aggregate 与紧随其后的 independent audit 会各自从 runner 内部取得当前
时钟，并对两份收据公开的 `observedAt` 重新执行同一 24 小时最大年龄和五分钟未来偏差门；当前时钟没有 CLI 参数、环境变量或 durable JSON 字段。
任一收据在闭合时已过期，release-set 文件会在写入、tag promotion 与 catalog publication 前失败关闭。`local` scope 没有私有收据，因此该门为
`not_applicable`，不会把 Cluster 私有证据成本带到 Local 发布。

长期 catalog 的 standalone inspection 故意不以“今天的时钟”拒绝历史发布；它验证 receipt/release/source/self-digest 闭包，但诚实返回私有现场
证据未重放。发布时 freshness 由受保护 workflow 的 aggregate/audit 与 provenance 约束，历史 consumer 不得把当前年龄检查冒充当时的现场验证。

## 发布流水线内置 Local 与 Cluster 下游门

`local|all` scope 在 durable catalog 发布后启动独立 `release-catalog-local-deployment-live`。它与 publisher 权限隔离，从公开 catalog
重新完成发现、Cosign/GitHub provenance 验证和 three-file bundle audit，随后物化唯一 Local v2 selection。该 selection 不是只做 JSON
检查：同一个 immutable Local image 与 selection 会依次进入 Edge、Standalone 的正式 Compose rollout、SQLite backup/restore、evidence
collection 和 graceful stop。两个 content-free report 必须绑定同一 release-set、catalog manifest、consumption report 与 selection digest；
任一 Profile 失败都会阻断 Local release。

该 job 只有 `contents|packages|attestations:read`，不执行 Docker login、签名、tag promotion 或 catalog mutation。regctl、Cosign、GitHub CLI、
Node workspace、token 和原始 bundle 仅存在于短生命周期 release runner；路由设备/NAS/单机用户不安装这些发布工具，也不增加常驻 updater、
listener 或 timer。第一份真实证据仍必须由受保护 release tag 产生；PR fixture 只验证失败关闭与产品 rollout 路径。

## 发布流水线内置 Cluster 下游门

`ql3-image-release.yml` 在 durable catalog、签名、provenance、receipt 和 90 天便利 bundle 全部发布后，才启动独立
`release-catalog-deployment-live`。该 job 只处理 `cluster|all`；Local-only 发布不会启动 K3s。它没有 publisher 的 package/attestation
写权限或 registry 登录态，而是按下文工作站协议重新消费公开 catalog，离线重建 deployment lock，并在隔离三节点 K3s 上完成 install、
Head commit、一个显式 ConfigMap 的 UID/resourceVersion 围栏退役和两个 receipt audit。任何公开读取、exact workflow identity、source
tag/revision、digest、scope、角色闭包、server-side apply/Head 或清理失败都会让 Cluster release 失败。

该门的四个业务 Deployment 都为零副本：它证明真实 catalog image authority 已进入目标 API、lock、Head 与 receipt 闭包，不重复下载和启动
完整业务数据面。应用启动、数据库、Secret、Worker 与 AI lifecycle 继续由各自 live/release gate 负责。成功 artifact 只保存 content-free
JSON evidence；consumption bundle、token、kubeconfig 和 command 文件不上传。首份真实成功记录必须来自实际受保护 release tag，普通 PR 中的
synthetic live fixture 不能替代它。

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
   `qinglong/release-set@v3` 的 `release.version`、`release.sourceRef`、`release.sourceRevision`、`release.scope` 必须与变更单一致。
3. 镜像集合必须与上表精确相等；每个 `reference` 必须是 digest reference，且 owner/repository 与部署目标一致。
4. Local scope 必须为零私有收据；Cluster/All 必须精确包含两份同 source、同 scope、自摘要有效且 freshness 闭合的 content-free 收据。
   static lock compatible 不等于现场证据已公开重放，任何 consumer 都必须保留该限制。
5. Kubernetes 必须先渲染 overlay，再用离线 post-render materializer 生成和复验 v2 locked manifest；嵌套 overlay 的
   `newName`/digest 不是最终 authority。Local 必须生成并审计 v2 service selection。两族输出都必须绑定同一 catalog manifest、
   consumption report 与 release-set digest，并且只能消费 release set 中的 `@sha256:` reference。
6. rollout 前再次确认 catalog receipt/immutable reference 与已检查文件一致。Kubernetes 必须把 locked manifest/report、pinned
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

GHCR 不提供跨 repository tag 事务，release set 与最终 closure receipt 都明确记录 `crossRepositoryAtomicity=false`。正式
`versionTag/sourceTag` 只能在 release-set file provenance、catalog immutable digest、catalog signature/provenance、catalog receipt
及其 attestation 全部成功后开始。publisher 随后必须为每个 image repository 取得不超过 1 MiB 的完整 tag inventory；读取失败、非
canonical line、非法 OCI tag 或重复项均失败关闭，不能把任意 `image digest` 错误当作 tag absent。它会在任何 mutation 前验证全部
immutable source 与全部既有目标 tag，任一不同 digest 都使本轮零 tag 写入。

如果 promotion 中途失败，不删除已经正确的 tag，也不重新构建镜像。使用原 source tag/revision 重跑 release workflow：它会复用 exact
tag，只补 absent tag；全部 tag 最终回读后生成 `qinglong/release-publication-tag-observation@v1` 与
`qinglong/release-publication-closure-receipt@v1`。closure receipt 绑定 release-set、catalog plan/manifest/receipt 和每个最终 tag，
与 plan、observation 一起进入 90 天 bundle；receipt 再次审计、attest 后，下载者可离线重放 closure audit。只有这条闭合链全部生成并验证后，才能宣布该 deployment family
可部署。对于 `cluster|all`，还必须等待只读 catalog consumer 与 catalog-bound K3s deployment/retirement Gate 成功；publisher 成功而
consumer 失败时不能宣布 Cluster release。不要给 consumer 临时增加写权限“修复”可见性或 tag，应修正 GHCR package visibility/retention
或发布配置后，对同一受保护 tag 重跑完整工作流并重新验证 exact digest。

catalog discovery tag 另有独立的无覆盖协议。publisher 先在 runner 私有 `ocidir://` 中生成 exact manifest；不得直接向
`v<version>-<scope>` 执行 `artifact put`。远端 repository 不存在时只允许创建
`staging-<catalog-plan-digest>` 非权威 tag，以便重新取得不超过 1 MiB 的完整 tag inventory；inventory 必须先通过
`qinglong/release-catalog-tag-inventory-decision@v1` 的 canonical line、OCI tag 字符集和无重复检查。随后：

- discovery 缺失：publication decision 为 `publish_if_absent`，从本地 immutable reference copy 后立即回读；
- discovery 已是 exact manifest digest：decision 为 `reuse_exact_digest`，不写 registry，继续 immutable 验证；
- discovery 是其他 digest、inventory 无界/重复/畸形，或 repository 建立后仍无法读取：在覆盖前失败。

catalog plan/receipt 因此分别为 v2，receipt 固定声明 `fail_closed_before_mutation` 与
`reuse_exact_manifest_digest_only`。GHCR tag 没有 CAS，组织仍必须限制 package writer；workflow 的同 ref concurrency 只能串行受保护
tag 的本仓库 run。最终 digest/manifest 回读用于发现发布期间竞争，deployment consumer 仍只接受已签名和 attested 的 immutable reference，
绝不能因为 discovery 当前“看起来正确”而把 tag 写入 rollout。

workflow bundle 当前保留 90 天；长期入口是 OCI catalog 的 immutable digest。GHCR 并非 WORM，release owner 仍须维护
package 可见性、读取权限和满足组织要求的 retention/备份策略。任何归档或镜像过程都不得改写 canonical JSON，并须保留
原 catalog manifest digest、receipt 与 provenance 关联。
