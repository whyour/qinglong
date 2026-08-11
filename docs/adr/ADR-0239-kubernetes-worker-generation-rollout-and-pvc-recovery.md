# ADR-0239：Kubernetes Worker Generation Rollout 与 PVC 恢复边界

- 状态：Accepted
- 日期：2026-08-01
- 关联 RFC：QL-RFC-0001 D-23、D-58、D-175、D-219、D-222、D-223
- 关联 ADR：ADR-0060、ADR-0061、ADR-0124、ADR-0234、ADR-0235、ADR-0238

## 背景

ADR-0124 已让 Kubernetes credential delivery 用 immutable stage Secret、目标 Secret
`resourceVersion` CAS 和数据库 delivery ledger 收敛响应丢失；ADR-0234 的 Worker
Deployment 也固定为单副本、`Recreate` 和单一 RWO PVC。但两者没有真正闭环：
`deploymentGeneration` 只写入目标 Secret annotation，未推进 PodTemplate，因此 Secret
更新不会重启使用 initContainer 私有复制的 Worker。数据库可能进入 `published`，而旧
Pod 永远继续使用旧 token，新的 authenticated Session observation 无法发生。

部署清单还把 CA、private key、certificate 与 `ql3w` token 放在同一个 Secret。若短生命
周期 credential admin 直接管理这个对象，它必须读取并 replace Worker 私钥，破坏最小
权限和 TLS/业务 credential 两套 authority 的隔离。

## 决策

### 1. TLS identity 与业务 credential 使用两个 Secret

`ql3-worker-identity` 只包含 `ca.crt`、`tls.key`、`tls.crt`；
`ql3-worker-credential` 是由 `WorkerCredentialKubernetesDeliveryAdapter` 管理的单键
mutable Opaque Secret，只包含 `credential-token`。Pod 仍通过一个 projected volume 读取
两个 source，initContainer 再把它们复制到同一 4 MiB tmpfs 的 `0700 private/`，主进程
不取得 Kubernetes API token。

这样 credential delivery 的 API client 不读取 TLS private key，CA/certificate operator
也不获得数据库 credential issuer authority。

### 2. Credential publication 必须同时收敛 Secret 与 Recreate PodTemplate

adapter 的 target identity 由 cluster identity、namespace、Secret name/data key 和
Deployment name 共同生成，digest domain 提升为 v2。构造时必须分别注入 CoreV1 Secret
API 与 AppsV1 Deployment API；它不使用 ambient client、watch、patch、timer 或 cache。

每次 `publish` 固定执行：

1. 读取并验证 exact Deployment：`apps/v1`、单副本、`Recreate`、worker label，且
   PodTemplate projected volume 确实引用目标 Secret/data key；
2. 在任何目标 Secret mutation 前，验证 PodTemplate 当前 credential ID 是 delivery 的
   exact predecessor；漂移直接 conflict；
3. 用 GET 返回的 opaque `resourceVersion` create/replace 目标 Secret；
4. 计算 publication digest，再以 Deployment GET 的 `resourceVersion` replace 整个
   PodTemplate，只增加 delivery ID、credential ID、deployment generation、token digest
   与 publication digest 五个低敏 annotation；
5. 只有 Secret 和 PodTemplate 都与 delivery 精确一致才返回 publication success，之后
   数据库才能进入 v2 `published`。

两个 Kubernetes 对象没有跨对象事务。若进程在 Secret 成功、Deployment 失败之间崩溃，
数据库仍保留 v1 `credential_committed`；startup recovery 使用同一 stage/delivery 重放。
已一致的 Secret 不重写，Deployment 再以新 `resourceVersion` 推进。Deployment response
loss 同样由 GET 后 exact annotation 对账收敛。409 只有在 winner 与当前 delivery 完全
一致时视作成功，否则 conflict；不得覆盖其他 generation。

### 3. Identity rollout 是显式部署 authority

base PodTemplate 固定包含
`qinglong.io/worker-identity-generation=replace-in-private-overlay`。private overlay 必须用
operator 生成的非秘密 generation 替换；CA/key/certificate 更新后同步推进该 annotation，
触发同一个 `Recreate` 边界。credential adapter 不修改 identity generation，也不读取 TLS
Secret。cert-manager、Vault、SPIFFE 或离线 CA 的具体 controller/审计仍是部署层后续工作。

### 4. 单身份继续使用 Recreate 与单一 PVC

credential 或 identity generation 变化时，旧 Pod 必须先进入 termination，再创建新 Pod；
不允许 RollingUpdate 产生两个共享 Worker ID、Session 和 PVC 的 owner。journal、logs、
receipts 与 certificate store 继续位于同一 RWO PVC。强制 Pod 丢失后 replacement 必须读取
同一 durable state，由 production startup reconciliation 决定遗留进程/Attempt，而不是
把 PID 存活或 Kubernetes Ready 冒充领域恢复。

## 不采用方案

### Worker 内 watcher、sidecar 或 Secret polling

拒绝。它增加路由设备/Worker 的常驻成本，并可能在 Kubernetes atomic-writer 多文件更新
窗口读取混合 identity。轮换是短生命周期 deployment authority，不是 runtime cadence。

### 只更新 Secret，等待 projected volume 自动刷新

拒绝。主进程使用的是 initContainer 私有复制的 direct file，且 private key/token 不应在
运行期被 symlink 原地替换；没有 PodTemplate generation 就不会重新物化。

### 把 token 与 TLS private key 放入同一个 managed Secret

拒绝。credential adapter 的 GET/replace authority 将同时取得设备私钥；两套撤权、轮换和
审计生命周期也会被错误绑定。

### RollingUpdate 或两个副本共享 PVC

拒绝。单 Worker identity 不是无状态 replica；并发 Pod 会竞争 Session、journal、进程恢复
和 RWO attach，不可能靠 readiness probe 修复 authority 冲突。

## 影响

- workspace 仍为 20 个 package；实现复用既有 `cluster-admin`，不新增生产依赖；
- Worker/Edge closure 不引入 `@kubernetes/client-node`，未增加 watcher、timer、Agent、
  sidecar、ServiceAccount token、端口或常驻连接；
- Kubernetes credential admin 的最小 RBAC 从 Secret
  `get/list/create/update/delete` 扩为目标 Deployment `get/update`；仍明确禁止 watch、patch、
  Deployment create/delete、Pod exec 和 Secret 以外 ConfigMap 权限。当前 live Gate 使用
  临时集群 admin kubeconfig 验证协议，不冒充该最小 RBAC 已完成生产接线；
- 原先单 Secret private overlay 必须迁移为 TLS identity Secret + adapter 创建的 credential
  Secret；这是 3.0 alpha 的有意边界修正，不改变 2.x 部署；
- publication 语义从“目标 Secret 已写”提升为“目标 Secret 与 PodTemplate generation 均已
  收敛”，数据库 ledger schema 无需变化。

## 验证

1. GitNexus upstream impact：`WorkerCredentialKubernetesDeliveryAdapter` 为 LOW，索引内
   0 caller、0 execution flow；测试 fake API class/helper 也为 LOW；
2. Cluster Admin strict TypeScript 通过；adapter 8/8 覆盖 immutable stage、Secret 与
   Deployment 双 `resourceVersion` CAS、Secret-first crash recovery、Deployment drift 在
   Secret mutation 前拒绝、双 rotation 单赢家、UID/resourceVersion discard 与 inventory
   hard cap；
3. Worker deployment audit 通过，确认单副本、`Recreate`、RWO PVC、TLS/credential
   Secret 分离、identity generation、私有 materialization、零 ServiceAccount token、零端口
   和零 synthetic probe；
4. `qinglong/worker-kubernetes-rollout-live-contract@v1` 在固定
   `rancher/k3s:v1.34.3-k3s1` digest、Kubernetes `v1.34.3+k3s1`、arm64 上使用真实 CoreV1/
   AppsV1 API 完成 credential A→B；两个 publication digest 不同，`Recreate` journal 观察
   old stop 严格先于 new start；
5. 同一 Bound RWO local-path PVC 的 journal 跨 credential rollout、强制 Pod 删除/recreate
   和 identity A→B rollout 保留 7 条记录；四个 Pod UID 均不同，replacement 观察到 CA-B
   digest，全部 gate `passed=true`；
6. live contract 使用独名临时 K3s 容器、已缓存镜像和私有 kubeconfig，成功/失败均精确
   清理；既有 CNPG evidence cluster 未修改。
7. ADR-0360 将门禁提升为 `@v2`：从当前源码构建 Cluster Admin、Cluster Control 与
   production Worker 镜像，组合真实 mTLS Worker ingress，并完成第四代 credential 与
   client identity 两次 Recreate。3 个不同 Pod/Session generation 均持久化 online、
   heartbeat、draining、offline；同一 RWO PVC 延续，最终 616 ms graceful drain 后 offline。
   8,087-byte `0600` 报告经独立 exact auditor 复核 compatible，相关容器零残留。

## 仍未完成

- 生产 ServiceAccount/Role/RoleBinding、短期 token 和双人/审批审计的正式接线；
- cert-manager/Vault/SPIFFE/离线 CA controller 与 ingress CA overlap/reload 的 Kubernetes
  分区、响应丢失和回滚矩阵；
- 多节点 CSI RWO detach/attach、节点失联、volume attachment 卡死与跨可用区恢复；
- 物理节点断电、磁盘只读/ENOSPC、对象存储故障和固定 x64/arm64 设备资源证据。
