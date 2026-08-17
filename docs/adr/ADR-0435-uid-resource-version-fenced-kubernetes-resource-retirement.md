# ADR-0435：UID/resourceVersion 围栏的 Kubernetes 资源退役 Ceremony

- 状态：Accepted
- 日期：2026-08-17
- 关联 RFC：QL-RFC-0001 D-03、D-14、D-342、D-343
- 关联 ADR：ADR-0431、ADR-0433、ADR-0434
- 修正：ADR-0434 第 7 项中“资源退休仍待后续 ceremony”的未完成边界

## 上下文

ADR-0434 已让 Deployment Head 保存完整有序 inventory，并拒绝 upgrade 隐式遗漏资源，但仍没有安全缩小 inventory 的路径。普通
`kubectl delete` 不执行 `resourceVersion` 比较；只按 kind/namespace/name 删除会在旧对象已被替换时误删新 UID。`kubectl apply
--prune` 也无法把每个删除绑定到 preflight 所观察的 UID/resourceVersion、当前 Head 与独立 receipt。

删除还是 Kubernetes 多对象非事务操作。请求在 API Server 已接受后丢失响应、对象被 finalizer 留在 terminating、并发 operator
推进 Head，都会产生不能靠“再跑一次 delete”猜测的窗口。QingLong 3.0 因而需要显式、短生命周期、可恢复的 retirement ceremony，
同时不能给低配 Local/Edge 设备增加 Kubernetes 依赖或常驻成本。

## 决策

1. 在既有 `qinglong/kubernetes-deployment-command@v2` 中增加
   `cluster.deployment.retirement.preflight|apply|receipt.audit`，不新增 package、controller、CRD、数据库或常驻进程。退役和普通
   install/upgrade/rollback 使用同一个 Deployment Head CAS authority。
2. 调用方只能提交 current locked manifest 中、current committed inventory 内的显式有序 target identity。每次最多 64 个且只允许
   namespaced resource；Head ConfigMap及 `v1 Secret|PersistentVolumeClaim|ServiceAccount` 禁止进入此通用 ceremony。集群级对象、数据与
   credential authority 必须使用各自专用 ceremony。
3. preflight 重新验证 catalog-bound lock、pinned kubectl/curl、owner-private kubeconfig、cluster UID 与 exact expected Head，从 API
   discovery 得到唯一 plural/scope 映射，逐个 GET 并记录 exact UID/resourceVersion、期望字段与
   `qinglong3-catalog-lock` Apply ownership，再以 `DeleteOptions.dryRun=[All]`、Background propagation 和 UID/resourceVersion
   preconditions 执行服务端 dry-run。preflight 不改变 Kubernetes 状态。
4. survivor inventory 必须非空并继续包含 `control|control-ai|admin|worker` 四类 immutable image authority。退役集合必须精确等于
   `active - survivor`，不能通过手写 receipt 或隐式 prune 改写 inventory。
5. apply 在任何删除前重读目标对象并要求 UID/resourceVersion 仍与 preflight 完全相同，然后用 Head ConfigMap 的 opaque
   resourceVersion 把唯一意图 CAS 为 `phase=applying`。之后逐对象发送带相同 UID/resourceVersion preconditions 的 DELETE；仅在每个
   old UID 已确认 404 absent 后，才把缩小后的 inventory 作为下一 generation 的 `committed` Head 发布，并 no-replace 写 receipt。
6. DELETE 不使用 force、grace-period=0 或 foreground 级联；固定 Background propagation。对象处于 terminating、precondition 409、
   UID 替换、resourceVersion 漂移、字段漂移、API discovery 歧义、Head 冲突或输入替换均失败关闭，不发布成功 receipt。
7. 若 DELETE 已完成但响应丢失，Head 仍保存 exact applying intent。相同 command/mutation/preflight 重放时，只有目标已经 absent 才可把
   该次删除记为 recovered 并继续提交；不同 UID、仍 terminating 或任何非同意图都不能自动接管。若 Head 已 committed 而本地 receipt
   丢失，相同 command 可从 Head 确定性重建。
8. 普通 kubectl 缺少带 body 的安全 DELETE 接口，因此一次性启动 pinned kubectl 的 owner-private Unix socket proxy，并用 pinned
   curl 发送 JSON DeleteOptions。proxy 只接受 `/api|/apis`，拒绝 POST/PUT/PATCH 等无关方法，使用独立 HOME/XDG/TMP，完成即关闭并删除
   socket；不监听 TCP，不读取 ambient HOME。
9. retirement receipt 显式声明 `crossResourceAtomicity=false`、
   `recovery=resume_exact_retirement_from_target_head`、UID/resourceVersion preconditions、absence、survivor role closure 与 Head CAS。
   offline audit 重建 command/receipt digest 闭包，但保持 `externalResultsReplayed=false`、`kubernetesMutation=false`。
10. Head schema 在 3.0 尚未正式发布时原地升为 v2；普通 rollback 可在 current transition 为 retire 时，以同一 release version 精确恢复
    Head.previous 的 lock 和完整 inventory。恢复对象仍走原 server-side apply/convergence ceremony，不把 DELETE 本身假装成可逆事务。

## 部署与资源影响

- Local/Edge/Standalone 不导入该脚本和 Kubernetes/YAML/semver 依赖，产物与稳态进程不变。
- Cluster 每次 retirement 临时产生一个私有目录、一个 Unix socket proxy 与顺序有界 API 请求；完成后全部清理。没有 listener 常驻、
  watcher、timer、ServiceAccount、Pod、sidecar、Pool、migration 或第三方依赖。
- 最多 64 个 target，按顺序执行 discovery/read/dry-run/delete/absence；这是明确的运维时成本，不进入 runtime hot path。
- 多资源删除仍非事务。Head 提供的是唯一意图、精确恢复与可审计 inventory closure，不宣称 API Server 跨对象原子性。

## 被拒绝的替代方案

### `kubectl delete -f` 或按名称删除

拒绝。普通命令不会绑定 preflight 观察到的 `resourceVersion`，旧操作可能删除已经替换的新 UID。

### `kubectl apply --prune`

拒绝。隐式集合差不能形成逐对象 UID/resourceVersion 删除证明，也不能表达响应丢失恢复、finalizer 和 Head inventory commit 顺序。

### 常驻 controller/finalizer

拒绝。QingLong 不是通用 Kubernetes desired-state controller；常驻 reconciler 会扩大凭据、升级、资源占用和低配部署边界。

### force delete 或 `grace-period=0`

拒绝。它会绕过正常终止/级联语义，扩大数据丢失和依赖对象孤儿风险，也不能弥补多对象非事务事实。

## 验证

- 定向 Node 契约 22/22：原 14 项部署 Head 契约保持通过，新增 exact UID/resourceVersion dry-run、preconditioned delete、inventory
  closure、offline audit、替换 UID fail-closed、DELETE 响应丢失恢复、同版本精确 rollback、独立 CI live workflow、curl/kubectl 工具解析隔离
  与锚定 proxy method 正则闭包；
- 隔离三节点 K3s v1.34.3+k3s1 live 门在 linux/arm64 同时执行 install 与一个 namespaced ConfigMap 退役，验证真实 DeleteOptions
  preconditions、对象 absent、Head generation 1→2、inventory 7→6、两个 receipt audit 与临时 Docker/Unix socket 清理；最终 retirement
  receipt digest 为 `sha256:d3145b3fee7a1191458b5c3a930c0063a0e1e446d3a196565bcdd20d9da06ec5`，门后 container/network
  残留均为 0。该门固定进入独立 GitHub Actions job，并上传 content-free evidence；
- 完整 backend 为 1,339 total/1,337 pass/2 条件 skip/0 fail；18-package clean build/test 退出 0。架构/边界审计保持
  compatible，14 档 Local artifact 字节数与 D-342 一致；
- PostgreSQL 18.6/arm64 HA 门为 142/142 gates、timeline 1→2，独立 evidence audit compatible；mode-0600 报告 SHA-256 为
  `89fd4fb47f82f35d3819d1fd9540cf3764f65fa68ac6561effd16778bee4ab8a`，门后 container/network/volume 残留均为 0。完整证据记录在
  QL-RFC-0001 D-343。

## 规范依据

- [Kubernetes API concepts：deletion、resourceVersion 与条件操作](https://kubernetes.io/docs/reference/using-api/api-concepts/)
- [Kubernetes DeleteOptions：UID/resourceVersion Preconditions](https://kubernetes.io/docs/reference/kubernetes-api/definitions/delete-options-v1-meta/)
- [kubectl delete：默认不执行 resourceVersion 检查](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_delete/)
- [Kubernetes cascading deletion：Background propagation](https://kubernetes.io/docs/tasks/administer-cluster/use-cascading-deletion/)
