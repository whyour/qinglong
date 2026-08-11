# ADR-0188：Cluster 持久发布者 Trust Authority 与受批撤销

- 状态：Accepted
- 日期：2026-07-28
- 关联：RFC D-140、D-144、D-175、D-176、D-177、D-178；
  ADR-0141、ADR-0144、ADR-0145、ADR-0185、ADR-0186、ADR-0187

## 背景

ADR-0187 已能根据可信 receipt 生成 signer impact 并隔离能力，但 receipt producer 仍是
直接调用的短生命周期函数。若管理请求可以自报 `previousTrustDigest`、
`currentTrustDigest` 或 generation，就能把客户端声明误当成集群事实；若 management
持有 package-executor credential，又会让网络入口直接取得隔离与安装写权限。

另一方面，部署既可能是资源有限的单节点，也可能是多副本控制面。协议必须允许小批量、
少连接、无常驻 timer 的执行方式，同时在多副本下对信任代际、提案、审批消费和执行租约
提供数据库事实与精确重放。

## 决策

### 1. Project Policy 是撤销 ceremony 的全局管理权威

集群显式配置一个 trust-authority Project。发布者 key 撤销固定要求
`package.manage`；审批使用既有 `approval.decide`：

- `dual_control` 创建 `separation_of_duty` 审批，请求人和确认人必须是不同 User；
- `break_glass` 创建 `human_confirmation` 审批，提案与确认均要求 hardware assurance；
- 提案、决定、消费三个阶段分别重验 Project/RoleBinding fence；
- 管理 assertion keyset 只认证操作者，不能替代 OCI publisher trust。

### 2. control-core v38 保存信任快照、head 与提案

`pg-0039-plugin-package-publisher-trust-authority` 新增：

- `plugin_package_publisher_trust_snapshots`：只保存 publisher/key ID/public-key digest/
  lifetime，不保存 PEM；
- `plugin_package_publisher_trust_heads`：每个 authority 保存 generation、base/effective
  snapshot digest 和 head digest；
- `plugin_package_publisher_revocation_proposals`：不可变绑定 Project、Policy fence、
  assurance、generation、目标 key、前后 digest 与 action/preview digest。

只读 trust 文件用于观察 base snapshot。首次观察以
`INSERT ... ON CONFLICT DO NOTHING` 竞选 head；相同 base 精确重放，不同 base 失败关闭。
文件变化不能隐式推进 effective trust。

客户端只提交 publisher、key ID、ceremony 和 reason。previous/current digest 与 generation
必须从 durable head/effective snapshot 派生，transport 响应只返回低敏摘要。

### 3. manager 只提案，executor 才消费和执行

package-manager credential 只能观察 base、创建 proposal/approval、决定与检查，不得更新
trust head、创建 revocation receipt 或执行 quarantine。

package-executor credential 以 caller-driven bounded process：

1. 扫描最多 64 个已批准 publisher revocation；
2. 以当前 `package.manage` fence 再授权并原子 consume；
3. 创建/领取既有 Approved Action execution；
4. handler 重新绑定 durable proposal、dispatch 与 execution start time；
5. D-177 的 SERIALIZABLE 事务同时推进 trust generation、写 receipt/impact；
6. 有界物化 quarantine，未收敛返回 indeterminate，保留可恢复事实。

management 永远不接触 executor credential；executor 不开放 HTTP listener。

### 4. 并发与最小权限

proposal 和 revocation 对 canonical `(publisher,keyId)` 使用相同 domain-separated
PostgreSQL advisory transaction lock。不可变 proposal/dispatch 使用普通一致性读取；
只有可变 trust head 由 executor `FOR UPDATE`。这避免为了行锁向 manager 或 executor
扩大无业务意义的 UPDATE 权限。

revocation receipt 的 `mutationId` 必须是 approved dispatch ID。旧的直接 receipt producer
不再能通过 repository authority 验证。相同 receipt 精确重放；旧 generation 或并发 winner
导致冲突。

### 5. 部署与资源梯度

- 低资源设备可由外部 cadence 调用一次性 executor CLI，默认 2 个连接、8 条审批/派发、
  4 批、每页 16 个 quarantine target，全部可下调；
- Cluster 提供 opt-in、`concurrencyPolicy: Forbid` 的两分钟 CronJob，request
  `50m/64Mi`、limit `500m/256Mi`，无 Service、无 ingress、无 Kubernetes token；
- management 以只读 ConfigMap 挂载 publisher trust；
- CloudNativePG overlay 只注入各自的 manager/executor role、CA 和 writer endpoint；
- 两个操作均不进入默认 operations Kustomization。

## 包边界

本切片不新增 workspace package或第三方生产依赖：

- `runtime-core` 保存纯 trust/proposal contract；
- `cluster-postgres` 保存 v38 migration、ACL、readiness 与 repository；
- `cluster-admin` 保存 management transport、approval consumer、handler、executor process/CLI。

workspace 仍为 22 包。单独拆出 trust、proposal 或 executor package 不形成新的制品或第三方
依赖边界，只会增加低配设备的安装、lockfile 和供应链审计成本。

## 不采用方案

### 允许客户端提交 trust digest/generation

客户端无法证明它观察的是当前 authority head，会制造 stale 或伪造 trust transition。

### 给 package-manager UPDATE 权限以支持行锁

PostgreSQL 的 `FOR SHARE/FOR UPDATE` 会隐式要求 UPDATE。manager 不应因此取得推进 head 的
能力；唯一键竞选和 signer advisory lock可以在不扩权的情况下提供并发序列化。

### management 同步执行撤销

网络入口会同时持有 manager/executor 两类 credential，长时间 quarantine 还会占用 HTTP
请求和数据库连接。

### 常驻高频 controller

路由设备不应为低频 key ceremony 维持额外常驻进程。caller-driven CLI/CronJob 与 durable
queue 已能在失败和切主后恢复。

## 验收证据

- runtime trust/proposal、PostgreSQL repository、management transport/process、
  Approved Action handler/executor process 单元门通过；
- cluster dependency audit 与 Kubernetes base/CloudNativePG Kustomize 渲染通过；
- deployment audit 精确验证只读 trust、manager/executor credential 隔离、CronJob
  资源/网络/Token 边界；
- PostgreSQL 18.4 Debian arm64 physical HA：
  - 真库先发现并修复两处 mock 未暴露的 `FOR SHARE` 隐式 UPDATE 权限扩大；
  - proposal 经 owner + admin 双人审批，executor consume 并成功执行；
  - trust generation `1→2`，proposal/receipt/impact 各 1，trust snapshot 共 2；
  - Run/Tool guard `true→false`，2 个 Task withdrawal、retained source 0；
  - quarantine COMMIT response loss exact-once；
  - `remote_apply`、timeline `1→2` promotion、旧主 fence、`pg_rewind` 与同步只读重加入后
    上述事实持续；
  - 最终 `gates.passed=true`。

## 后续

1. 增加 executor backlog、blocked/indeterminate、trust generation 与 quarantine
   remaining 的指标和告警。
2. 为 publisher key overlap rotation/retirement 增加与撤销不同的受批 action。
3. 完成真实管理客户端/UI 与硬件 assurance issuer 的部署证据。
4. 将两个 signer lock 实现抽成共享 helper 前必须单独审计 CRITICAL blast radius。
