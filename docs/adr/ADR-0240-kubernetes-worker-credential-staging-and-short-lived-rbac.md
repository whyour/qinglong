# ADR-0240：Kubernetes Worker Credential Staging 与短期最小 RBAC

- 状态：Accepted
- 日期：2026-08-01
- 关联 RFC：QL-RFC-0001 D-23、D-58、D-175、D-223、D-224
- 关联 ADR：ADR-0060、ADR-0061、ADR-0124、ADR-0234、ADR-0239
- 收窄：ADR-0239 的 production RBAC 未完成项；不替代其 generation rollout/PVC 决策

## 背景

ADR-0239 已证明 Secret 与 `Recreate` PodTemplate 的双 CAS publication，但 live Gate 使用
cluster-admin kubeconfig。若直接给 delivery ServiceAccount 一个 Worker namespace 内的
Secret `get/list/create/update/delete`，它就能列举或读取 TLS private-key Secret。只给
`resourceNames` 也不能解决 stage 创建：Kubernetes RBAC 无法用未来对象名约束顶层
`create`，而 `list` 只有客户端携带精确 name field selector 时才能与 `resourceNames`
规则匹配，现有有界 inventory 不能依赖该隐式约定。

所以“一 Worker 一个 namespace”仍不够。一次性 delivery authority 需要创建/列举
immutable stage，又必须只能更新一个预先受审的 runtime target；这两类权限必须落在
不同 namespace。

## 决策

### 1. 每个 Worker identity 使用两个独占 namespace

- Worker namespace 只包含该 identity 的 Deployment、PVC、ConfigMap、TLS identity Secret
  与 credential target；不得复用 `qinglong3-system` 或与其他 Worker 共用；
- staging namespace 只包含 immutable delivery stage Secret 与 delivery ServiceAccount/RBAC；
  不放 TLS、ConfigMap、Pod、PVC 或其他业务 Secret；
- adapter 配置同时要求 `namespace` 与不同的 `stageNamespace`，target digest domain 提升为
  v3 并绑定两者，避免把已有 delivery ledger 重放到另一 staging authority；
- Edge/Standalone 不安装 Kubernetes client、ServiceAccount、watcher、timer 或 sidecar。

### 2. Target 由部署预创建，delivery 不拥有 create

独立 `credential-bootstrap` 资产以 create-only 语义创建空的 mutable Opaque
`ql3-worker-credential`，标签固定为
`app.kubernetes.io/managed-by=qinglong3` 与
`qinglong.io/worker-credential-target=prepared-v3`，不得含 data、ownerReference、finalizer
或业务 annotation。允许 `kubectl apply` 生成的有界
`kubectl.kubernetes.io/last-applied-configuration` 账本注解，其他注解仍视为漂移。

该 Secret 不进入常规 base 或 GitOps reconciliation set；重复 bootstrap 得到
`AlreadyExists` 时必须停止，不能转为 apply/replace/delete。若外部 reconciler 必须导入它，
必须显式忽略 delivery 拥有的 data、labels 与 annotations，禁止持续 server-side apply。
首次 publish 与后续 rotation 都只能使用 GET `resourceVersion` replace；不存在 target
时 unavailable，prepared target 不为空或带额外 authority 时 conflict，绝不 fallback 到
create。成功后 target 进入 `v3`，继续由 credential ID/token digest/delivery annotation
与 Deployment PodTemplate 双对象精确对账。

### 3. ServiceAccount 只使用短期 TokenRequest

`ql3-worker-credential-admin` 位于 staging namespace，设置
`automountServiceAccountToken: false`。operator 每次 delivery 最多签发 10 分钟 TokenRequest
token；不得创建 legacy static token Secret，不得把 token 放入命令参数、日志或提交的
kubeconfig。调用方只能使用内存 client 或 mode `0600` 的临时 kubeconfig，并在操作后销毁。

staging Role 只允许 Secret `get/list/create/delete`，不允许 update/watch/patch。Worker
namespace target Role 只允许：

- exact `ql3-worker-credential` Secret：`get/update`；
- exact 单副本 `Recreate` Worker Deployment：`get/update`。

明确拒绝 Worker namespace Secret list、TLS Secret get、target Secret create/delete/patch、
Deployment list/create/delete/patch、其他 Deployment、Pod get/list/delete/exec、ConfigMap、
ServiceAccount TokenRequest 自签和 namespace 等 cluster-scoped 读取。

### 4. 管理面签发与审批仍保持外置

该 RBAC 是部署执行 capability，不等于 operator 身份认证、双人审批、工单或审计产品入口。
常驻 Worker/control 不挂载该 token，也不获得 TokenRequest authority。后续管理 CLI/controller
只能在既有 Policy/audit/approval 决策后短期取得它，不能把本 ADR 的 live fixture 当成产品
ceremony 已完成。

## 不采用方案

### 共享 control/Worker namespace

拒绝。stage list 或 Secret create 会把 delivery compromise 的可见面/写入面扩大到 TLS、
数据库和其他 Worker material。

### 仅靠 `resourceNames` 限制 stage create/list

拒绝。顶层 create 在鉴权时没有现存对象可匹配；list/watch 还要求精确 field selector，不能
作为通用 inventory authority。独立空 staging namespace 才是可验证的隔离边界。

### Adapter 首次自动创建 target

拒绝。允许 Worker namespace Secret create 就无法限制新对象名与内容；预创建 target 把
对象身份、标签和投影引用提前纳入受审部署。

### 长期 ServiceAccount token 或 Worker-side controller

拒绝。长期 token 扩大泄漏窗口，Worker-side controller 又增加路由设备常驻成本并把一次性
管理 authority 放进执行主体。

## 影响

- 默认 Worker namespace 从共享 `qinglong3-system` 改为 `qinglong3-worker`，并新增默认
  `qinglong3-worker-credential-staging`；生产 private overlay 必须为每个 identity 同时改名；
- 独立 create-only bootstrap 新增一个空 credential target，常规 base 不管理它；
  credential-admin 新增 ServiceAccount、两个 Role 与
  两个跨 namespace RoleBinding；无 workspace package、生产依赖、端口、连接或 timer 增量；
- stage CRUD 与 target/Deployment update 继续由现有 `cluster-admin` adapter 承担；Worker
  runtime closure 不包含 `@kubernetes/client-node`；
- target/deployment digest 与 publication digest 均进入 v3，新 alpha ledger 不得跨 v2/v3
  target identity 静默重放；
- `kubectl apply` 客户端账本注解被显式、有界接受，但其他 prepared metadata/data 漂移仍
  fail closed。

## 验证

1. GitNexus upstream impact：`WorkerCredentialKubernetesDeliveryAdapter`、测试 fake 与 helper
   均为 LOW，0 条 production execution flow；
2. Cluster Admin strict TypeScript 通过；定向 9/9 覆盖独立 staging namespace、prepared
   target、标准 apply 注解、缺失/漂移拒绝、双 CAS、crash replay、竞态与有界 inventory；
3. deployment audit 验证专属 Worker namespace、独立 staging namespace、create-only
   prepared-v3 空 target 不在常规 base、ServiceAccount automount=false、staging 四个动词
   与 exact target 两组动词；
4. 固定 `rancher/k3s:v1.34.3-k3s1` digest 的 Kubernetes `v1.34.3+k3s1` arm64 live Gate
   签发 600 秒 TokenRequest，并以真实 token 完成 8 条 allow、20 条 deny
   SelfSubjectAccessReview；adapter 全程使用受限 client 完成 credential A→B；
5. target 最终为 active v3；Worker Pod 没有 projected ServiceAccount token；`Recreate` old
   stop-before-new start、同一 Bound RWO PVC 跨 rollout/强制 Pod 删除保留 7 条 journal，
   identity A→B replacement 同样通过，全部 gate `passed=true`；
6. 随后的 PostgreSQL 18.4 arm64 HA Gate 再次通过 physical streaming、`remote_apply`、
   fence-before-promote、timeline 1→2、未确认分区提交排除、`pg_rewind` 只读同步重入与两个
   fresh control replica，证明本次权限重构未破坏 Cluster durability contract。

## 仍未完成

- 双人审批、工单/audit 与 TokenRequest 签发/销毁的正式产品 CLI/controller；
- cert-manager/Vault/SPIFFE/离线 CA 及 ingress CA overlap/reload 的 Kubernetes 故障矩阵；
- production Worker image 的真实 360 秒 Session drain/startup reconciliation；
- 多节点 CSI RWO detach/attach、物理节点失联/断电、ENOSPC/只读磁盘与固定 x64/arm64
  设备资源证据。
