# ADR-0232：Cluster runtime recovery 与 lost retry 复用单一 Scheduler cadence

- 状态：Accepted
- 日期：2026-07-30
- 关联 RFC：QL-RFC-0001 D-14、D-57、D-104、D-118、D-214、D-216
- 关联 ADR：ADR-0012—0014、ADR-0057—0061、ADR-0108—0121、
  ADR-0227、ADR-0230、ADR-0231

## 背景

Cluster 已具备 Worker ingress、Run Lease、starting/running/completion、
startup recovery 和 admission-time retry policy，但 production runtime 仍存在两处
断点：

1. startup recovery 只在进程启动时扫描，运行期间过期的 Remote Worker Attempt
   不会进入证据恢复；
2. PostgreSQL 已保存 lost retry policy，却没有 production consumer 把 lost Run
   收敛为失败，或在安全策略允许时建立下一次 Attempt。

现有 `ClusterWorkflowSchedulerCoordinator` 已由一个不重叠 Scheduler cadence 驱动。
另建 recovery/retry timer、sidecar 或 package 会增加多副本扫描、连接、shutdown
顺序和空闲资源成本，也会让 Edge/Standalone 或小型路由设备承担不属于其 Profile
的常驻闭包。

还发现一个原子性缺口：Attempt 被恢复为 lost 时，如果对应
`run_dispatch_leases` 仍保持 `leased`，数据库会同时表达“执行 authority 已失效”
和“旧 authority 仍有效”。这会阻塞后续调度，并允许运维查询观察到矛盾事实。

## 决策

### 1. 连续 recovery 只扫描运行期过期 Attempt

新增 PostgreSQL runtime recovery source，使用数据库
`statement_timestamp()` 观察时间，只选择：

- `runtime` owner 的 `dispatching|running|lost` Run；
- `claimed|starting|running` Attempt；
- lease 缺失或已过期；
- 排除尚未分配 Worker、没有 lease/offer/start 事实的 pristine remote
  `claimed` Attempt。

source 复用 startup recovery 的 claim、evidence、resolution authority，不复制
状态机。页上限沿用 recovery contract 的 64 条硬上限，production 默认 16 条；
查询使用 `limit + 1` 判定 `hasMore`，不保存跨轮 cursor，也不扫描 startup 专属的
orphaned `created` Run。

`starting|running` 过期不等于远端进程已经停止。start barrier 之后仍必须取得
可信的 not-running evidence；未知或仍在运行时失败关闭并留待下一轮，不能仅凭
lease timeout 复制可能有外部副作用的执行。

### 2. lost 转换与 dispatch lease 释放原子提交

恢复事务继续先取得 Attempt advisory authority，再锁 Run/Attempt/lease。
当 leased Attempt 收敛为 lost 时，同一事务把精确 generation/version 的
`run_dispatch_leases` 从 `leased` 改为 `released`：

- lease version 加一；
- release reason 固定为 `lease_expired`；
- Attempt 保存新的 lease version；
- Run、Attempt、Event 与 lease release 一起提交或一起回滚。

旧 Worker 的 renew、activation 或 completion 随后会因 generation/version/token
fence 被拒绝。没有匹配 lease authority 时不伪造 release。

### 3. 只有 admission 时声明安全的 Run 才自动重试

`runtime-core` 增加 profile-neutral 的纯 lost retry transition builder；PostgreSQL
只负责候选排序、锁和原子持久化：

- 没有 policy、`retryOnLost=false` 或最大次数不允许重试：收敛为 failed；
- safety 未声明：收敛为 failed；
- attempts 已耗尽：收敛为 failed；
- 只有 `idempotent|deduplicated` 才能从 lost 进入 `retry_wait`；
- 到达数据库观察的 `nextAttemptAtMs` 后，原子建立全新的、未租约 Attempt N+1，
  并把 Run 重新置为 queued。

新 Attempt 不继承旧 offer、Worker、session、lease、callback 或开始事实。
Plugin Package Workflow 的聚合 Run 被排除，继续由 StepRun-aware recovery、
frontier 与 generation-bound Task admission 管理。

每个候选使用短事务，Attempt advisory lock 先于 Run row lock；页上限为 64，
production 默认 16。任何数据库、锁、状态或持久化异常均失败关闭，不以跳过损坏
head candidate 的方式静默推进后续执行。

### 4. 固定单一 cadence 与执行顺序

production 顺序固定为：

1. runtime recovery；
2. lost retry；
3. 普通 Trigger schedule；
4. Workflow frontier；
5. Workflow Task Attempt admission。

新的 coordinator 自身不拥有 timer、Pool、连接、cursor 或 per-Run 状态，只包裹
既有 Scheduler coordinator，并由现有 `ClusterSchedulerLifecycle` 驱动。一次 cycle
重入继续 coalescing；recovery/retry 失败时该轮调度不继续，下一 cadence 再试，
避免在 authority 状态未知时派发新工作。

该装配只存在于 Cluster production bootstrap。Edge/Standalone 保留各自已有的
Profile lifecycle 和页预算，不加载 PostgreSQL adapter，也不增加常驻唤醒。

### 5. 不扩大部署与依赖面

实现复用现有 `runtime-core`、`cluster-postgres` 和 `cluster-control`：

- 不新增 workspace package；
- 不新增 migration、表、索引或生产依赖；
- 不新增 timer、watcher、listener、queue、sidecar、Pool 或连接；
- Worker ingress 最小权限 Pool 不取得 Run/Attempt/Lease mutation authority；
- Cluster runtime 继续使用既有 runtime Pool 和数据库 fencing。

## 不采用的方案

### 为 recovery 与 retry 各建一个 timer

拒绝。多个 cadence 会形成恢复、重试与调度之间的竞态，增加多副本扫描和 shutdown
复杂度，也无法证明低资源环境中的固定空闲成本。

### lease 到期后直接复制 starting/running Attempt

拒绝。lease 到期只证明 authority 失效，不证明远端进程停止。没有可信 evidence
就建立 Attempt N+1，可能让非幂等副作用并行发生。

### 默认重试所有 lost Run

拒绝。旧数据或未声明安全性的 Task 不能被推断为幂等。默认终结失败比隐式重复执行
更安全；自动恢复必须是 admission-time durable policy。

### 新建 recovery package 或 sidecar

拒绝。该能力与 Cluster runtime Pool、Scheduler 生命周期和数据库 authority
完全同部署、同版本；拆包不会形成独立发布或权限边界，只会增加 importer、镜像与
常驻进程成本。

## 当前验证

1. `runtime-core` 全量 425/425；
2. `cluster-postgres` 全量 246 项：245 pass、1 条真实 PostgreSQL 条件 skip、
   0 fail；
3. `cluster-control` 全量 153 项：151 pass、2 条外部服务条件 skip、0 fail；
4. 定向测试覆盖 runtime-only 有界候选、pristine claim 排除、数据库观察时间、
   advisory-lock 顺序、lost lease 原子 release/version fence、安全/禁用/耗尽
   policy、fresh Attempt 与 recovery→retry→scheduler 顺序；
5. workspace 保持 20 个 QL3 package，没有新增 migration、表、生产依赖、timer、
   listener、Pool、连接或 sidecar；
6. 禁止 image pull 的 PostgreSQL 18.4 arm64 physical HA 门已通过
   `remote_apply`、timeline 1→2、旧主 fencing、`pg_rewind` 只读同步重入、
   两个 fresh control replica 与总 `gates.passed=true`。

## 尚未关闭

1. Cluster Secret material 的正式 provider、rotation/retention 和产品入口；
2. Worker Session heartbeat/drain/offline、credential renewal/recovery 与真实
   Kubernetes 多 Pod Session replacement；
3. recovery/retry 的指标、告警、损坏 head candidate 诊断/人工处置，以及真实
   raw-wire 分区、operator/proxy/STONITH 和固定多架构容量证据。
