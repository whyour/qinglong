# ADR-0105：PostgreSQL 行租约 Cluster Scheduler 与 Run 原子准入

- 状态：Accepted（row lease、完整 fence、原子 Run admission、bounded lifecycle、PostgreSQL 16/18 integration、双独立 runtime pool 接管、物理 promotion、claim-held promotion/expiry takeover 与 scheduler decision COMMIT-response-loss 门禁已实现；Kubernetes 多 Pod、网络分区和远端 placement 闭环待完成）
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-19、D-34、D-36、D-41、D-53、D-57、D-85、D-102、D-104
- 关联 ADR：ADR-0012、ADR-0014、ADR-0039、ADR-0041、ADR-0054、ADR-0057、ADR-0103、ADR-0104

> ADR-0107 现行增量：claim command 与 Coordinator 已移除节点 `observedAtMs`/`clock`；领取和提交分别使用 PostgreSQL 单 statement observation，活跃 claim 的 `updated_at_ms` 显式成为 `claimAcquiredAtMs`。本 ADR 中由 Coordinator 提供 observation 的局部实现已被取代。

## 背景

ADR-0103 已证明 SQLite 单机可以用 durable cursor + CAS 把 cron occurrence 原子转换为 Run，但 cluster-control 允许多个副本并行运行。进程锁、单 Pod timer 或全局 advisory leader 都不能同时提供水平扩展、局部故障隔离和精确 takeover；跨外部计算持有数据库锁则会放大慢节点影响。

Cluster Scheduler 还必须与低配 Profile 隔离。Edge 路由器继续使用 SQLite 单页扫描，不应加载 PostgreSQL、行租约或 cluster lifecycle。

## 决策

### 持久状态与权限

`pg-0014-cluster-scheduler-admission` 新增一张 `trigger_schedules` 表，并把 `control-core` 推进到 v13/`cluster_scheduler_admission`。每个 Trigger head 恰有一行，保存：

- exact `trigger_revision`、`next_fire_at_ms`、`last_scheduled_at_ms`；
- `state_version`；
- `claim_owner`、UUID `claim_token`、`claim_version`、`claim_expires_at_ms` 四部分租约 fence；
- `updated_at_ms` 时钟下界。

Trigger publisher 在同一管理事务 upsert schedule。新 revision 会清空 cursor/claim 并递增 state/claim version，使旧 claim 永久失效。runtime role 只有 `SELECT`/`UPDATE` schedule 权限，没有 `INSERT`；admin role负责创建/重置行；worker-ingress 保持零权限。

### 无全局 Leader 的领取

每个 cluster-control replica 运行同一有界 coordinator。领取使用单条 PostgreSQL CTE：

1. 只选择 active Project、enabled 内建 cron Trigger、到期或待初始化且无有效 claim 的行；
2. 按 `next_fire_at_ms NULLS FIRST, project_id, trigger_id` 排序；
3. `FOR UPDATE OF schedule SKIP LOCKED LIMIT 1`；
4. 原子写 owner/token/version/expiry，同时递增 schedule state version；
5. 立即提交，不在数据库锁内计算 cron、创建 ID 或访问 Worker。

租约到期后其他 replica 可接管。系统不选举全局 scheduler leader；不同 schedule 行可以由不同副本并行推进，单个慢副本只占用自己的短租约。

### 决策与原子准入

cron 和 misfire 继续复用 Profile-neutral 决策器。`skip` 只推进 cursor，`fire_once` 最多补一个 occurrence，不回放 backlog。提交前必须重新锁定并逐项验证：

- Project/Trigger/Task revision 与内容摘要；
- schedule revision/state/next cursor；
- claim owner/token/version/expiry；
- decision candidate、观察时间与下一时刻；
- digest-valid 的 pinned `remote_worker` execution revision。

一次 admit 在同一个 `SERIALIZABLE` transaction 中创建 queued Run、`remote_worker` claimed Attempt、`run.created`/`run.queued` 两条事件，并以完整 claim fence 推进 schedule、清空 claim。任何 insert、摘要、constraint、serialization 或最终 UPDATE 失败都会整体回滚。幂等键固定为 `ql3:cron:v1:<triggerId>:<triggerRevision>:<scheduledForMs>`。

Scheduler 只准入 durable 工作，不直接选择 Worker、不签发 execution lease、不启动进程。后续 placement/dispatcher 继续拥有 Worker Session、容量与 Run Lease authority。

startup recovery 不得把仍可由 dispatcher 正常领取的 pristine queued Attempt 当成失效执行。PostgreSQL recovery source 只排除父 Run 为 runtime-owned queued、未取消且存在 `queued_at_ms`，Attempt 为最新的 claimed `remote_worker`，并且 worker/session/lease/offer/callback/start/result/error 字段均保持准入初始值的精确形态；任何字段漂移、已进入 `dispatching` 或存在更新 Attempt 时仍进入恢复候选并 fail closed。该规则不改变 dispatcher authority，也不宽泛忽略 queued work。

### 有界 Lifecycle

Coordinator 默认每轮最多领取 16 条、硬上限 256，租约 30 秒；lifecycle 默认 1 秒 cadence、单轮不重叠、timer `unref`、停止等待 10 秒。错误只进入低敏 diagnostic sink，不让 timer 崩溃或重叠。

Cluster composition root 在 schema readiness 和 startup recovery 收敛后、HTTP admission 开放前启动 lifecycle。停止时先撤 admission，再停止并 drain scheduler，之后停止应用 stack 和数据库。配置在打开 PostgreSQL 前做边界验证。

## Package 与 Profile 决策

不新增 package：contract 在 `runtime-core/cluster-scheduler`，adapter 在 `cluster-postgres`，coordinator/lifecycle 是 `cluster-control` 内部模块。ADR-0106 收敛 Profile wrapper 后当前 workspace importer 为 23。Edge/Standalone 的依赖闭包、SQLite、cadence 与内存预算不受影响。

## 拒绝的方案

- 单例 Pod 或全局 advisory leader：拒绝，因为形成粗粒度故障域与扩展瓶颈。
- 只用 `claim_owner` 或过期时间：拒绝，因为 ABA takeover 后旧副本仍可能提交。
- 在领取事务中计算 cron或等待 Worker：拒绝，因为延长行锁并放大数据库尾延迟。
- 先创建 Run、再单独推进 schedule：拒绝，因为崩溃会产生重复 occurrence 或丢失 cursor。
- Scheduler 直接 dispatch/spawn：拒绝，因为会绕过 placement、Run Lease 与执行恢复 authority。

## 验收证据

- PostgreSQL migration stream 现为 18 条、capability v17、30 张受审表；v16 由 `pg-0017` 复验四个非特权 LOGIN role 并安装 exact Database/schema/table GRANT，v17 由 ADR-0137 `pg-0018` 加入 admin-only Plugin Package 三表与受审 Project lock function，checksum/Drizzle/schema/readiness/四角色权限一致；scheduler 决策仍由 v13 的 `trigger_schedules` contract 拥有。
- Repository 测试覆盖 `SKIP LOCKED` 顺序、expiry takeover 条件、完整 fence race、skip、原子 Run/Attempt/Event、写入故障回滚和损坏 execution revision。
- Coordinator/lifecycle 测试覆盖硬 claim budget、只为 admit 分配 Run identity、race 统计、非重叠和有界 drain。
- 历史 PostgreSQL 16.10 四角色证据保持有效；当前本机 arm64 `postgres:18` 上 cluster-postgres 四角色 integration 28 pass/1 个同角色 backend termination 条件 skip/0 fail，cluster-control 纵向 integration 6/6、0 skip。单角色轮次继续执行 active query backend terminate 的 availability 报告证据；四角色轮次证明精确权限、Plugin Package repository 与其 Project lock function。cluster-control 使用两个独立 runtime pool/不同 backend PID 与 owner，证明初始化单 claim、同一 occurrence 仅 1 Run/2 Event、持 claim 副本关闭后的 expiry takeover，以及 production Pool idle backend terminate 后摘流。CI 已配置 PostgreSQL 16/18 × x64/arm64 矩阵；未配置测试 URL时仍明确 skip，不能把 skip 计作发布证据。
- ADR-0125 的本机 arm64 PostgreSQL 18.4 physical-promotion 门禁又在 primary 上取得一个 15 秒 schedule claim，并先证明该 claim 已 WAL replay 到 standby；旧主 fencing 前数据库 observation 仍剩 14,641 ms 且目标 occurrence 的 Run 数为 0。standby timeline 1→2 promotion 后，两个 fresh control 只能在数据库 expiry 之后接管：claim version 从 1 推进到 2 并清空，最终同一 scheduled time 恰有 1 queued Run、1 claimed remote-worker Attempt、2 Event 和 0 duplicate occurrence。
- 同一 HA 门禁通过真实 `ClusterSchedulerCoordinator` 注入 scheduler decision COMMIT-response-loss：driver 确认 `COMMIT` 后终止该 transaction backend，再让上层收到 `ECONNRESET`；提交事实先经 standby WAL replay，promotion 后 fresh control 启动恢复忽略仍属 dispatcher authority 的 pristine queued/claimed Attempt，最终仍为 1 Run、1 Attempt、2 Event、claim 清空且 0 duplicate。该故障位于 PostgresClient 边界，不宣称 raw-wire packet-loss。

## 未包含

- 真实 Kubernetes 多 Pod 网络边界、生产 operator/proxy、raw-wire packet-loss 与网络分区演练；ADR-0125 已证明 claim-held physical promotion、数据库时间 expiry takeover、exact occurrence admission 和 PostgresClient 边界的 decision COMMIT-response-loss；节点调用方时钟 authority 已由 ADR-0107 移除；
- Worker placement、offer/ACK、completion、expiry、cancellation、retry 完整闭环；
- schedule backlog/latency 指标、告警与管理面投影；
- interval/event/webhook/AI Trigger provider；
- Legacy scheduler 正式停写与 cutover。
