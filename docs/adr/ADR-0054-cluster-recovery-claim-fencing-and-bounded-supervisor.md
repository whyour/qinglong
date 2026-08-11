# ADR-0054: Cluster Recovery Claim、Fencing 与有界 Supervisor

- 状态：Proposed
- 日期：2026-07-19
- 关联 RFC：QL-RFC-0001 D-06、D-36 至 D-42、D-52、D-53

## 上下文

ADR-0053 已能从 PostgreSQL 有界发现失去有效 ownership 的 Run/Attempt，并在 admission 前独立验证是否收敛，但候选没有多副本 ownership。若两个 cluster-control Pod 都读取同一个过期 Attempt 并直接处理，它们可能重复探测、互相覆盖结果，甚至重放任务。把 `FOR UPDATE SKIP LOCKED` 事务一直持有到外部证据探测结束也不可接受：慢 Worker、网络或 Artifact I/O 会占用连接和行锁，放大集群故障。

本决策增加恢复协调 authority，不增加任务执行 authority。ADR-0055 已补充 narrowly scoped 的 evidence processor 与 fenced lost transition；其他终态、重试、取消和生产 provider 仍由后续专用组件定义。

## 决策

### 1. 恢复 claim 使用独立控制记录

`pg-0008-run-recovery-claims` 新增 `ql3.run_recovery_controls`。每个 `run|attempt` 候选只有一行控制记录，保存候选快照、数据库 observation、`available|claimed|retry|manual|resolved` 状态、owner、token、单调 version、claim expiry、next claim time 和有界 failure count。

该表不复用 RunAttempt 的执行 lease。执行 lease 是任务执行 authority 和原始故障证据；恢复 claim 只是“哪个控制面副本可以裁决此候选”的短期 authority。覆盖执行 lease 会销毁取证边界并混淆 Worker 与 recovery owner。

### 2. Claim 事务必须短，processor 在事务外运行

一次 `claim()` 最多请求 128 项，并在一个短 `READ COMMITTED` transaction 内完成：

1. 用 ADR-0053 source 在同一数据库连接读取固定 observation 的有界候选页；
2. upsert 候选快照，但不覆盖已有 claim/retry/manual/resolved 控制状态；
3. 只在本页候选内按稳定顺序选择可认领、retry 已到期或 claim 已过期的行；
4. 使用 `FOR UPDATE SKIP LOCKED` 更新 owner/token/version/expiry 后立即提交。

外部证据探测、Run/Attempt 重读和后续状态机处理必须在事务外执行。不得跨网络调用、Executor probe 或 Artifact I/O 持有数据库锁。

### 3. Settle 必须被完整 fence

`settle()` 是单条原子 UPDATE，必须同时匹配 `(target kind, target id, state=claimed, owner, token, version)`，并由 PostgreSQL `statement_timestamp()` 证明 claim 尚未过期。任一条件不匹配返回 `fenced`，旧副本不得覆盖接管者结果。

允许的 disposition 只有：

- `resolved`：本次证据处理已收敛，但只要底层候选事实仍存在，后续 discovery 可以再次认领；
- `retry(delay)`：使用数据库时间写入有上限的下次认领时间；
- `manual`：永久退出自动 claim，等待后续受审人工恢复入口。

processor 异常不会被解释为 resolved；Supervisor 将其收敛为有界 retry。存储错误使用稳定、低敏且 retryable 的 `ClusterControlRecoveryStoreError`，不泄漏 SQL/连接信息。

### 4. Supervisor 单页、串行、无 timer、绝不执行任务

runtime-core 的 `ClusterControlRecoverySupervisor` 每次只处理一个 claim page，默认 16、硬上限 128；claim lease 默认 30 秒、硬上限 5 分钟；retry delay 硬上限 5 分钟。页内串行处理，不递归翻页，不创建 timer，不缓存全局 backlog，也不调用 Executor。

这些边界同时服务两类部署：小规格控制节点可选择更小的 page/cadence，集群副本依靠 PostgreSQL claim/fencing 横向并行。edge/standalone 不安装该 PostgreSQL 表、driver 或 supervisor，它们继续使用 Profile 专属 SQLite 生命周期。

### 5. Capability 与最小权限 lockstep

control-core capability 推进到 v7，并增加 `cluster_recovery_claim: 1`。reviewed migration、冻结 checksum、Drizzle schema、catalog contract 和 readiness 必须同步。runtime role 对控制表只有 SELECT/INSERT/UPDATE、没有 DELETE/DDL；cluster-admin 对该表零权限。

`ClusterControlAssemblyInput` 同时暴露只读 `recovery` source 和 `recoveryClaims` repository，避免把候选发现、协调 authority 和业务状态推进揉成一个万能 Repository。

### 6. 当前仍不开放生产执行

ADR-0055 已实现 provider contract、保守 evidence processor 与 Run/Attempt `lost` 原子事务，但仍没有默认 production evidence provider、retry/其他 terminal 状态事务、周期 lifecycle、指标告警或人工 recovery API。bootstrap 仍只接受 application 提供的 reconcile，并在之后独立验证 source 收敛。

因此不能把 claim 成功解释为任务可安全重跑，也不能据此默认注册 `run.get`、开放 mutation API 或宣称 cluster-control 已可部署。

## 被否决的替代方案

### 复用 RunAttempt execution lease

拒绝。它会覆盖原 Worker authority 和过期证据，使 recovery 与执行 ownership 无法独立审计。

### 在外部证据探测期间保持行锁

拒绝。慢依赖会形成长事务、连接耗尽和锁放大；Pod 崩溃只能依赖数据库断开，无法表达可观测 retry/manual 状态。

### 只使用进程内 mutex 或 leader election

拒绝。进程内锁不能协调多 Pod；单 leader 会把全部 backlog 和 failover 恢复压到一个节点，而且仍需要每项 fencing 防止旧 leader 晚到写入。

### Claim 到期后直接重放任务

拒绝。claim expiry 只证明 recovery owner 失权，不证明旧任务副作用不存在。自动重试必须经过固定 Run 策略、Attempt N+1 和可信业务去重边界。

## 影响

### 正向

- 多副本对同一候选只有一个 claim winner，过期后可接管；
- 旧 owner 的迟到 settle 被数据库时间、token 和 version fence 拒绝；
- 外部探测不持有数据库事务或行锁；
- 单批数据库、内存和处理工作量均有硬上限；
- manual/retry/resolved 具备持久化、可审计控制状态；
- runtime/admin 权限边界可由 readiness 精确验证。

### 代价与未完成项

- 新增一张控制表、三个部分索引和每候选一次持久化控制写；
- resolved 只表示控制处理结果，底层候选未消失时会再次被发现；
- poison candidate 仍可能反复消耗页预算，需要后续告警、退避策略和人工恢复入口；
- 仍需 PostgreSQL 16/18 多 Pool、failover、大 backlog `EXPLAIN` 与资源基准。

## 验证

1. runtime-core contract test 证明 Supervisor 单页串行、异常转 retry、manual/retry/fenced 均保持 unsafe，并拒绝越界配置与畸形页。
2. PostgreSQL unit test 证明短事务顺序、rollback/release、完整 settle fence 与稳定低敏错误。
3. PostgreSQL 13.3 真实集成测试证明两个 repository 并发只有一个 winner、有效 claim 不可偷取、到期接管后旧 settle 被 fence、retry 未到期/manual 不可认领、resolved 在底层事实仍存在时可再次认领。
4. migration/manifest/Drizzle/schema/readiness test 证明 capability v7、表、索引、CHECK/FK 和 runtime/admin 权限 lockstep。
5. Node 22/24、PostgreSQL 16/18 三角色 CI、edge import audit、cluster dependency audit 与 GitNexus detect-changes 继续作为合并门禁。
