# ADR-0494：PostgreSQL Secret Binding 与 Mounted Provider 在线轮换门

- 状态：Accepted
- 日期：2026-08-24
- 决策：D-399
- 关联：ADR-0129、ADR-0141、ADR-0233、ADR-0491、ADR-0492、ADR-0493

## 背景

ADR-0233 已提供 production `mounted-files` Secret provider，但原有证明主要来自
单元测试、静态部署审计和受限容器资源门。D-397 又要求 Cluster Secret migration
不能借用 Local SQLite/POSIX authority，必须证明 PostgreSQL durable approval、精确
Secret 投影和多节点运行时在同一真实 Kubernetes 门中仍然失败关闭。

旧的 Secret binding live contract 还落后于当前 executor base：base 已支持创建
action-scoped Job，而兼容门仍假设外层 executor 直接挂载值；同时成功 Pod 的 kubelet
logs 偶发 `EOF` 会让已经完成的证据在报告阶段丢失。门禁不能通过增加 Secret API
权限、ServiceAccount token、watcher、sidecar 或把值写入报告来规避这些问题。

## 决策

### 1. 复用现有生产边界，不增加新的运行时闭包

本门直接构建正式 `ql3-cluster-admin` 和 `ql3-cluster-control` 镜像，provider 使用
ADR-0233 的 `createClusterMountedSecretProvider`。不新增 workspace package、生产依赖、
PostgreSQL migration/table/role、daemon、timer、watcher、listener、sidecar 或 Secret
API client；Edge/Standalone import graph 不加载本门或 Cluster 依赖。

兼容 Secret binding executor 在 fixture 中显式进入 direct exact-key 模式：关闭
action controller、禁用 ServiceAccount token，只挂载当前批准计划所需的一个
projection key，并设置 `QL3_PLUGIN_PACKAGE_EXECUTOR_SECRET_ROOT`。这证明既有
PostgreSQL approval/binding 语义和 direct provider 消费，不改写 production base 的
action-scoped controller 决策；controller 的 digest-pinned Job/admission contract 继续由
其独立测试与部署审计证明。

### 2. 三节点拓扑与 durable approval 必须同时成立

live fixture 启动一台 K3s server 和两台 agent。两个 management Pod 使用
anti-affinity 分布到不同节点，通过正式 mTLS client 完成 plan、跨副本 replay、propose、
四眼 decide 和 inspect。PostgreSQL 18.4 保存 approval、execution 和 binding；数据库中
只能出现 SecretRef/plan/evidence digest，不能出现 Secret material。最小权限 manager
不能读取 binding 表，management Pod 不挂载业务 Secret。

外层 executor 只读挂载 exact-key `0440` projection，不能 get/list Kubernetes Secret，
且没有 ServiceAccount token。它必须发布一次 binding、消费一次 approval 并成功完成；
任一持久化 fence 或 projection 漂移都失败关闭。

### 3. 两个 provider observer 必须无重启观察原子轮换

另建与 approval 中相同 SecretRef/projection key 对应的可变 Kubernetes Secret，并启动
两个 observer Job。required pod anti-affinity 要求它们位于不同节点；二者都运行正式
Cluster provider、非 root、只读 root filesystem、drop ALL capability，并满足：

- `automountServiceAccountToken=false`；
- ServiceAccount 对 Secret `get/list/patch` 均为 `no`；
- deny-all NetworkPolicy，无 ingress/egress；
- projection read-only、`defaultMode=0440`，只包含一个精确 hash key；
- 第一代 material 被观察后才以 resourceVersion-fenced `replace` 写入第二代；
- 两个 Pod 都在不重启的情况下观察到第二代；
- stdout、termination message 和最终报告不含两代值或 SecretRef。

随后删除 Secret，并以 `optional: true` 空 projection 启动一次性 observer；生产 provider
必须返回 `QL3_CLUSTER_MOUNTED_SECRET_UNAVAILABLE`。这里的 optional 只允许 Pod 启动，
不允许 material resolve 降级成功。

### 4. 证据不依赖 kubelet 日志可用性

observer 只输出 content-free JSON，并同时写入 `/dev/termination-log`。审计优先读取
PodStatus 中的终止消息，只有没有该消息时才回退 kubelet logs。因此已完成 Job 的证据
不会因节点日志通道 `EOF` 丢失，也不需要扩大 Kubernetes API/RBAC。

私有报告使用 `qinglong/plugin-package-secret-binding-kubernetes-live@v2`，以 owner-only
`0600` 原子发布。v2 在原 v1 字段上增加 control image、provider 拓扑、轮换、RBAC、
投影模式、脱敏和 missing fail-closed 证据；离线 verifier 继续接受 immutable v1 shape，
但绝不允许 v1 报告伪装成 v2 provider 证明。

## 被拒绝的替代方案

### 给 control Pod 增加 Secret API 权限

拒绝。轮换由 Kubernetes atomic writer 投影完成；get/list/watch 会扩大 credential、网络、
缓存和审计面。

### 用 `disk-pressure` toleration 或降低 kubelet eviction 阈值通过门禁

拒绝。这会掩盖真实资源不足。本机运行先清理明确未使用且可重建的镜像/缓存，并在用户
授权后只回收未被容器引用的匿名卷，再从健康磁盘启动全新集群。

### 只验证单副本或重启后读取新值

拒绝。单副本不能证明 topology separation；重启后读取只能证明重新挂载，不能证明
atomic writer rotation 被现有 provider 请求观察。

### 把 Secret 值或 SecretRef 写入报告便于排障

拒绝。报告只保留 digest、计数、布尔值、错误码和节点名哈希。排障不得扩大 material
custody。

## 当前验证

2026-08-24 本机 Apple Silicon 完整 live gate 已通过：

- K3s `v1.34.3+k3s1`，3 个 Ready 节点；
- PostgreSQL `server_version_num=180004`；
- 2 个 management replica 位于不同节点；
- direct exact-key executor Job 成功，binding exactly once，数据库 material match 为 0；
- 2 个 provider observer 位于不同节点，第一代与轮换代均为 `2/2`；
- resourceVersion 前进，Pod 未重启，Secret API 三个权限均为 false；
- read-only `0440`、无 token、deny-all network，输出脱敏；
- Secret 删除后以 `QL3_CLUSTER_MOUNTED_SECRET_UNAVAILABLE` 失败关闭；
- v2 报告 24/24 gates 为 true，离线审计 findings 为空，文件权限 `0600`；
- v1 verifier 兼容与 v2 drift/sensitive rejection 定向测试通过。

CI 新增独立 `cluster-secret-binding-mounted-provider-kubernetes-live` Job，固定 K3s、
PostgreSQL 和 kubectl 版本，运行完整 live gate、离线复核并上传低敏报告。

## 边界与后续门禁

本 ADR 关闭 ADR-0491 的 Cluster mounted-files provider live 子门，但不把 D-397 整体
转为 Accepted，也不声明：

1. Kubernetes control-plane HA；本 fixture 是单 server + 双 agent；
2. PostgreSQL 物理 failover；它由独立 125-gate HA contract 证明；
3. 直接 Vault/KMS/HSM adapter、CSI/Vault Agent 自身故障或 credential rotation；
4. Cluster Legacy Env migration 的专用 SERIALIZABLE ledger、Task/Trigger mutation 和
   promotion 后 receipt replay；
5. 固定低性能路由设备上的真实空间、写放大、断电与恢复证据。

因此 ADR-0491 仍保持 Proposed。下一步优先完成固定 Edge 硬件空间门，随后实现并证明
Cluster migration ledger；直接外部 custody adapter 作为可选、独立供应链继续设计。
