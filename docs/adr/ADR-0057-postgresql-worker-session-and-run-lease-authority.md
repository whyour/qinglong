# ADR-0057：PostgreSQL Worker Session 与 Run Lease Authority

- 状态：Proposed
- 日期：2026-07-19
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-23、D-34 至 D-42、D-54 至 D-56
- 关联 ADR：ADR-0012、ADR-0013、ADR-0014、ADR-0021、ADR-0039、ADR-0043、ADR-0056

## 上下文

cluster-control 的 `run_attempts` 原先同时保存 Worker、executor、lease token 和 expiry。这个扁平快照可以支持 Run 聚合读取，却不能单独表达两个不同 authority：

- Worker Session Lease 证明某个经过认证的 Worker 进程、session 和 generation 当前仍可报告容量；
- Run Lease 证明该 session 对某个 Attempt 获得了一次带 generation/version 的执行授权。

如果直接把 Attempt 行上的 `worker_id + lease_expires_at_ms` 当作远程恢复证据，会产生三个错误：Worker 在线不等于某个执行仍在运行，lease 过期不等于执行已经停止，多副本 Dispatcher 也没有可以原子竞争和 fencing 的独立行。ADR-0056 的 Remote Worker provider 因此不能建立在该扁平快照上。

同时，QingLong 3.0 仍必须保证 edge/standalone 不因集群 Worker 能力引入 PostgreSQL、常驻连接或新 timer。

## 决策

### 1. Session 与 Run Lease 使用独立事实表

PostgreSQL capability v8 新增：

- `worker_sessions`：以 `worker_id` 为主键，保存 session UUIDv7、generation、status、version、canonical capabilities/hash、容量、heartbeat 和数据库时间 lease；
- `run_dispatch_leases`：以 `attempt_id` 为主键，保存 Run、Worker session/generation、lease generation/version、token digest、稳定 offer ID 和终态元数据。

`run_attempts` 只保留用于聚合读取和 recovery snapshot CAS 的精确 fence 投影：Worker session/generation、lease generation/version、token digest、offer ID 和 expiry。`run_dispatch_leases` 才是执行授权的事实源；Attempt 投影不能独立续租、释放或证明执行停止。

### 2. Bearer lease token 不得持久化

新 cluster Run Lease API 接收内存中的高熵 bearer token，但 PostgreSQL 和返回 DTO 只保存/暴露 SHA-256 digest。claim、renew 和 release 在进程内派生 digest 后比较；事件、日志、recovery target 和诊断输出都不得包含原 token。

旧 `run_attempts.lease_token` 暂时保留用于迁移兼容，但新的 PostgreSQL Run Lease repository 固定写入 `NULL`。删除该列需要独立 migration 和 2.x 回退窗口审计。

### 3. 所有 lease 时间由 PostgreSQL 在取得必要锁之后观察

客户端时钟不参与 Session/Run Lease expiry。Repository 使用 `statement_timestamp()`，并且只能在以下锁已取得后读取 observation：

- Worker registration：按 Worker ID 的 transaction advisory lock 和现有 Worker 行锁；
- heartbeat/transition：Worker 行锁；
- Run claim：Worker、Run/Attempt 与既有 Run Lease 行锁；
- renew：Worker 与 Run Lease 行锁；
- release：Worker、Run Lease、Run/Attempt 行锁。

这样锁等待时间不能被遗漏，过期判断和新 expiry 都基于真正进行裁决时的数据库时间。

### 4. Worker Session replacement 与 mutation 全量 fencing

首次注册建立 generation 1/version 0。相同 session 只有 capabilities、容量和仍存活的 lease 全部一致时才是幂等重放；冲突、offline 或已过期 session 均拒绝。新 session 在同一 Worker ID 锁下原子推进 generation/version，并返回 `replacedSession=true`。

heartbeat、drain 和 offline 必须同时匹配 Worker ID、session、generation 和 expected version。draining/offline 容量固定为零。Repository 不认证请求体；未来 Worker transport 必须先从 mTLS/短期 enrollment credential 建立 principal，不能把 `register()` 直接暴露为匿名网络入口。

### 5. Run claim 由 Worker 行锁串行化容量裁决

claim 固定执行：

1. 锁定目标 Worker；
2. 锁定 Run/Attempt 与已有 Run Lease；
3. 读取数据库 observation；
4. 验证当前 Worker session/generation、online、session lease、Run runtime ownership、取消意图和 claimed Attempt；
5. 在 Worker 行锁保护下计算该 session 的 active lease 数，并要求它同时小于 `maxConcurrentRuns` 和最近一次 heartbeat 上报的 `availableSlots` 上界；
6. 原子写入 Run Lease、Attempt fence、Run version/event sequence 与 dispatch Event。

相同 token digest、offer ID 和完整 fence 是幂等重放；不同调用者看到 live lease 只能得到 `leased`。续租同时 CAS Run Lease version 和 Attempt 投影；release 只处理尚未越过启动屏障的 claimed Attempt，并在同一事务清除投影和追加 Event。starting/running 的完成、失租与取消仍由后续专用事务处理，不能借 release 扩权。

### 6. 权限和 Profile 保持分离

常驻 runtime role 对 `worker_sessions`、`run_dispatch_leases` 只有 SELECT/INSERT/UPDATE，无 DELETE/DDL；cluster-admin 对两表零权限。migration role 仍是唯一 DDL authority。

未来认证 Worker attestation ingress 应使用独立入口和更窄数据库 capability；不能因为 runtime role 当前可管理调度 lease，就允许普通业务 handler 伪造 `not_running` evidence。

runtime-core 只包含无数据库 driver 的 contract/validator。PostgreSQL repository 只从 cluster package/runtime 子入口导出，edge/standalone importer 不引入 `pg`、表、连接或 timer。

## 被否决的替代方案

1. **继续只用 Attempt 行 lease**：无法区分 Session Lease、Run Lease 和恢复快照，也无法安全串行化跨 Attempt 的 Worker 容量。
2. **用控制面进程时间计算 expiry**：副本时钟漂移和锁等待会让 takeover/renew 裁决不一致。
3. **在 PostgreSQL 保存原 lease token**：数据库读权限、备份和诊断泄漏会直接获得执行 capability。
4. **只检查 availableSlots 是否大于零**：多个 Dispatcher 可在同一 heartbeat 之间重复消费相同槽位；必须在 Worker 行锁下要求 active leases 同时低于最大并发和上报槽位上界。这个保守模型优先避免超卖；未来若要把 `availableSlots` 精确解释为“扣除运行中任务后的瞬时空闲数”，必须引入独立 reservation epoch/counter，不能在没有 heartbeat 代际的情况下直接递减并与 Worker 上报相互覆盖。
5. **Session offline/lease expiry 直接作为 `not_running`**：这只能证明控制面 authority 失效，不能证明远端进程已经停止。
6. **把 PostgreSQL Worker adapter 放入根应用**：会重新污染 edge 安装图并让 cluster adapter 依赖 legacy Sequelize。

## 影响与未完成项

正向影响：

- Worker/Run 两层 lease 在多副本下有独立、可锁定、可审计的事实源；
- bearer token 不落库，recovery target 只携带 digest；
- Session replacement、capacity claim、renew/release 都有精确 fencing；
- Attempt recovery snapshot 可以绑定 session、lease generation/version 和 offer，而不把投影误当 authority；
- edge/standalone 依赖和空闲资源成本不变。

ADR-0058 已完成独立 Worker credential/ingress role、append-only attestation、Remote Worker provider 和 PostgreSQL 16.14 四角色验证。ADR-0108 又完成 PostgreSQL candidate/placement、认证 Worker Pull 与 digest-only offer recovery；ADR-0109 已完成 starting/running/start-failure 数据库权威 ACK，并用真实 PostgreSQL 16.10 runtime role 验证。该入口在 ExecutionSpec transport 与生产内部 port 门禁前仍默认不注入生产组合根。仍未完成：

- mTLS/enrollment transport、credential recovery ceremony 与 pepper rotation；
- completion、expiry/lost、cancellation 与 retry 的 PostgreSQL 原子协调；
- Worker 本地 journal 到网络 attestation 的生产装配与 Artifact/日志 transport；
- PostgreSQL 16/18 远端 CI 首次成功证据和多 Pool failover/lock-wait 基准。

## 验证

- runtime-core contract test 验证 bounded Worker Session、canonical snapshot hash、token digest 和 lease terminal shape；
- migration/Drizzle/schema/readiness lockstep test 冻结 `pg-0009` checksum、capability v8、表/列/index/CHECK/FK 和 runtime/admin 权限；
- 真实 PostgreSQL transaction test 验证注册/replacement、幂等 claim、容量耗尽、renew version fencing、release 清权、token 不返回和 Attempt 投影；
- 本机 PostgreSQL 13.3 仅用于 SQL/锁/约束验证，production readiness 仍按策略拒绝；发布证据必须来自 PostgreSQL 16/18 CI；
- edge dependency/import audit 必须继续证明该切片没有进入 edge/standalone 产物。
