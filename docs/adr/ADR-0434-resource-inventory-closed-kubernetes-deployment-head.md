# ADR-0434：Resource-inventory-closed Kubernetes Deployment Head

- 状态：Accepted
- 日期：2026-08-16
- 关联 RFC：QL-RFC-0001 D-03、D-14、D-341、D-342
- 关联 ADR：ADR-0431、ADR-0433
- 修正：ADR-0433 第 7、8 项的无目标状态重放与人工 roll-forward 边界

## 上下文

ADR-0433 把 catalog-bound lock、目标 cluster 与 pinned kubectl 绑定到最后一跳，但固定 field manager 的 server-side apply 只解决字段
ownership，不提供部署意图的先后顺序 CAS。两个运维者从同一旧状态取得 preflight 后，后执行者仍可能覆盖先执行者；manifest 中移除的
对象也不会被普通 apply 删除，若只检查新 manifest，旧对象可残留而 receipt 仍显示成功。

Kubernetes API 的 server-side apply 文档明确说明，它不适合依赖 current value 的条件更新；这种 lost-update 防护应使用包含当前
`resourceVersion` 的 update/replace。`kubectl apply --prune` 的 allowlist 仍标记为 alpha，也不能替代显式资源退休协议。因此部署
ceremony 需要一个很小的目标侧 durable head，而不是把并发或删除语义藏进 field ownership。

## 决策

1. 尚未发布的 deployment command/preflight/receipt 直接升级为 v2，不保留可绕过 Head 的 v1 双轨。每个 preflight/apply 必须显式提供
   `transitionKind=install|upgrade|rollback` 和 exact `expectedHead={generation,deploymentDigest,lockDigest,stateDigest}`。
2. Cluster 生产转换只接受 `control,control-ai,admin,worker` 完整 role surface。locked manifest 推导唯一 control namespace，并生成按
   `apiVersion/kind/namespace/name` 排序、去重的完整 resource inventory；调用方不能另选 Head namespace 或提交手写 inventory。
3. 目标 namespace 中固定使用一个 `qinglong3-deployment-head` ConfigMap，唯一数据键为 `head.json`。它保存 schema、phase、generation、
   exact transition、当前/前一 lock 与 inventory 摘要、target/tool authority、五项 workload step transcript digest、deployment digest 和
   self digest；不保存 manifest 正文、token、credential、kubeconfig 或命令输出正文。
4. preflight 在 identity read 后读取 Head，要求它为空或 `committed`，并比较 exact expected Head。第一次 `install` 只接受空 Head；
   `upgrade` 只接受严格递增 SemVer；`rollback` 只接受 Head 中精确的上一 deployment。
5. apply 重读 Head 后，以 ConfigMap create 或带 GET 所得 opaque `resourceVersion` 的 replace 原子取得 `phase=applying`。相同
   command/mutation/preflight 可以恢复同一 applying intent；任何其他意图、陈旧 preflight、resourceVersion conflict 或 Head 漂移都在
   workload mutation 前失败关闭。
6. server-side apply、convergence read 与末次 cluster identity 全部成功后，ceremony 再以 applying ConfigMap 的 resourceVersion replace
   为 `phase=committed`，然后才 no-replace 发布 receipt。若 committed response 已返回而本地 receipt 丢失，相同 command 可从 Head
   确定性重建；已有本地 receipt 的重放也必须联网确认 Head 尚未前进。
7. `upgrade` 要求 active inventory 是 target inventory 的子集；省略现存对象立即失败，不能隐式 prune。`rollback` 额外要求 current、
   target 与 previous inventory 完全相同。需要删除对象时等待独立的 UID/resourceVersion delete-precondition retirement ceremony；本
   ADR 不把“对象仍残留”冒充成功回退。
8. receipt 继续声明 Kubernetes 多资源 mutation 非事务，但新增 Head generation/deployment/state digest、完整 inventory、
   `deploymentHeadCas=true`、`resourceInventoryClosed=true` 与
   `recovery=resume_exact_transition_from_target_head`。offline receipt audit 不访问 API Server，也不宣称 Head 仍是当前状态。

## 部署与资源影响

- Local/Edge/Standalone 路径零导入、零制品增量；路由设备不创建 Head、不加载 Kubernetes/YAML/semver 或 Cluster role 代码。
- Cluster 每个目标 namespace 只增加一个小型 ConfigMap；无 controller、CRD、webhook、ServiceAccount、Pod、listener、timer、watcher、
  数据库、migration、SQL 或 Pool。preflight 比 ADR-0433 多一次 Head GET；首次 apply 多一次 create，后续 apply 为 acquire replace 和
  commit replace。
- 逻辑继续内聚在根级工作站 ceremony，不新增浅 workspace package。Head 是发布排序证据，不是通用 desired-state controller。
- namespace 必须先由受控 bootstrap 创建；否则 Head create 与 namespaced workload dry-run 都自然失败关闭。

## 被拒绝的替代方案

### 仅依赖相同 server-side apply field manager

拒绝。field manager 管理字段 ownership，不比较调用者观察到的上一部署 generation，陈旧 writer 仍可成为最后写入者。

### 使用 `kubectl apply --prune`

拒绝。当前 prune allowlist/ApplySet 仍有 alpha 边界，而且删除必须绑定已观察对象 UID/resourceVersion 与独立 receipt；隐式集合删除无法满足
这一证明要求。

### 在 PostgreSQL 或新 controller 中保存部署锁

拒绝。最后一跳的并发事实应与目标 API Server 同故障域；额外数据库或常驻 reconciler 会扩大低资源、凭据、升级与可用性边界。

## 验证

- 定向 Node 契约 14/14，通过空 Head install、create/replace CAS、committed receipt、同意图 applying 恢复、陈旧 preflight 阻断、
  resource omission fail-closed、错误/漂移不发布 receipt、closed command 与低敏 CLI；
- 隔离三节点 K3s `v1.34.3+k3s1`/Linux arm64 真实运行 6 个 release resource、4 个零副本 Deployment 和一个固定 Head ConfigMap；
  Head 从 absent 经 applying 到 generation 1 committed，deployment digest 为
  `sha256:f911cda19195735d00fcc6317db2c22794855e5eb5795696b19a4239fb68a263`，resource inventory 为 6，receipt audit 通过，临时
  container/network 清理完成；
- 完整 backend、18-package、边界、制品与 PostgreSQL HA 结果记录在 QL-RFC-0001 D-342。

## 规范依据

- [Kubernetes API concepts：resourceVersion 与 conditional update](https://kubernetes.io/docs/reference/using-api/api-concepts/)
- [Kubernetes declarative object management：prune/ApplySet 状态](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/declarative-config/)
