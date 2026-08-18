# ADR-0005：Durable Cancellation Dispatch、Lease 与 Fencing

- 状态：Accepted（Local 与 PostgreSQL Repository 已实现；Cluster 生产启动拓扑待接入）
- 日期：2026-07-18
- 决策范围：跨进程取消派发、崩溃恢复、并发 Worker、退避和审计事件
- 关联：QL-RFC-0001、ADR-0001、ADR-0003、ADR-0004

## 1. 上下文

`run.cancel_requested` 解决“用户取消意图是否已经提交”，但它本身不能证明哪个 Worker 有权调用 Executor，也不能阻止多个副本同时扫描同一个 Run 并重复发送 signal。

只使用内存锁在进程重启和多副本部署中无效；只依赖 append-only RunEvent 也无法原子 claim 一个外部副作用。另一方面，OS signal 与数据库事务之间没有通用的 exactly-once 提交协议：Worker 可能在 signal 成功后、结果落库前崩溃。

该协议必须同时适用于：

- edge/standalone：单进程或低性能设备，SQLite、低频轮询、严格资源上限。
- cluster-control/worker：多个副本并发扫描，共享 PostgreSQL，允许 Worker 故障和租约接管。

## 2. 决策

### 2.1 独立状态

取消意图仍属于 Run；取消副作用的协调状态属于独立 `CancellationDispatch`。每个 Run 最多一条 dispatch，并固定绑定一个 RunAttempt。首版字段为：

```text
run_id                  primary key
attempt_id              not null
status                  pending | leased | retry_wait | dispatched | blocked
version                 non-negative integer
dispatch_count          non-negative integer
next_attempt_at_ms      nullable
lease_owner             nullable
lease_token_digest      nullable
lease_expires_at_ms     nullable
last_result             nullable
last_dispatched_at_ms   nullable
created_at_ms            not null
updated_at_ms            not null
```

RunEvent 记录发生过的事实，CancellationDispatch 负责 claim、到期和退避查询。两者不能互相替代。

### 2.2 Claim 事务

Worker 对唯一 active Attempt 执行原子 claim：

1. 校验 Run 由 runtime 拥有、仍非终态、cancel request 时间一致。
2. 校验 Attempt 属于该 Run 且状态为 claimed/starting/running。
3. 不存在 dispatch 时创建 `pending`，绑定该 Attempt。
4. 既有记录绑定其他 Attempt 时 fail closed，不重新绑定或选择“最新 PID”。
5. `dispatched`、`blocked` 不再 claim；未到 `next_attempt_at_ms` 返回 not-due；未过期 lease 返回 leased。
6. 到期或可派发时，以 version CAS 更新为 leased，递增 version 和 dispatch_count，写入新的 owner、domain-separated SHA-256 token digest 和 expiry；原始 token 只随成功 claim 返回给当前调用者，不进入 durable record。

Repository 是租约、到期与退避的时间 authority。调用方只提交已有 `cancel_requested_at_ms` 事实、lease duration 或 retry delay，不得提交“当前时间”、lease expiry 或绝对 retry timestamp。SQLite adapter 使用注入 clock 与短 `IMMEDIATE` 事务串行化写竞争；PostgreSQL adapter 使用 `transaction_timestamp()`，按 Run→Attempt→CancellationDispatch 顺序取行锁。实现方式可以不同，行为契约不得改变。

### 2.3 发出副作用

只有 claim 成功的 Worker 可以调用对应 `PersistedExecutionController`。本机进程 controller 在每次 TERM/KILL 前都重新核验 durable handle：

- 平台和 handle 格式受支持。
- Attempt.pid 与 handle PID 一致。
- 当前 boot ID 与记录一致。
- `/proc/<pid>/stat` start ticks 一致。
- PID 仍为记录的 process-group leader。

任一证明缺失或不一致都不得降级为裸 PID signal。

### 2.4 Result 事务与 fencing

结果提交必须同时匹配 run ID、attempt ID、lease owner、原始 lease token 的 digest 和 expected dispatch version。任何一项过期都拒绝写入。

同一事务中：

1. 更新 dispatch 状态并清空 lease。
2. 使用当前 Run version CAS 预留下一个 event sequence。
3. 追加一个低敏 RunEvent。

结果分类：

| Controller/调度结果 | Dispatch 状态 | Event | 后续行为 |
| --- | --- | --- | --- |
| `termination_requested`、`already_exited` | dispatched | `run.cancel_dispatched` | 等待 completion/Reconciler 收敛 Run 终态 |
| `identity_mismatch`、`pid_mismatch`、`unsupported`、`invalid` | blocked | `run.cancel_dispatch_blocked` | 禁止自动重试，等待诊断或明确修复 |
| `controller_missing`、`handle_missing`、`dispatch_error` | retry_wait | `run.cancel_dispatch_failed` | 按有界指数退避重试 |

Event payload 只包含 Attempt ID、dispatch count 和枚举结果，不包含 PID、durable handle、命令、环境或 Secret。

### 2.5 崩溃窗口

该协议提供 at-least-once recovery，不宣称 OS signal exactly-once。允许的窗口是：Worker 已取得 lease 并发送 signal，但在提交 result 前崩溃。

lease 到期后其他 Worker 可以重新 claim。重试仍必须执行完整身份复验：

- 进程已退出时记录 `already_exited`。
- 身份改变时进入 blocked。
- 只有同一可证明进程仍存在时才允许再次发送 signal。

这比永久卡住取消请求或对裸 PID 猜测更安全。lease duration 必须大于单次 controller 的正常 TERM/KILL 检查窗口，并有固定上限。

### 2.6 退避与 Supervisor

首版退避为 `min(max, base * 2^(dispatch_count-1))`，指数有上限。调用方只提交有硬上限的 `retryDelayMs`，Repository 依据自身时间计算并持久化绝对 `next_attempt_at_ms`，进程重启不会清空退避。

Supervisor 一次只执行有界 cycle：

- source 默认每页 32，硬上限 64。
- 单 cycle 默认 4 页，硬上限 64 页。
- attempt 查询溢出、缺失 cursor 或 cursor 不前进时 fail closed。
- Supervisor 不自行创建 timer、后台线程或 boot hook。

独立 lifecycle runner 提供显式 `start()`/`stop()`：只有调用 `start()` 才创建 unref timer；每轮完成后才安排下一轮，禁止慢设备累积重叠扫描；错误只进入受限诊断回调，不终止后续 cycle；`stop()` 立即取消待执行 timer，并对正在执行的 cycle 使用有上限的 drain 等待。超时后旧 cycle 仍不得再安排新 timer，且在它完成前拒绝重新 start。

部署 Profile 决定调用 cadence。edge 可以低频串行执行；cluster 可以由多个副本触发，但实际副作用仍受同一 lease/fencing 约束。

## 3. 不采用的方案

### 3.1 仅使用 RunEvent 去重

Event 可以审计，但不能表达 lease expiry、当前 owner 和 next retry，也不能防止两个 Worker 在写 Event 之前同时 signal，拒绝。

### 3.2 进程内 Mutex 或 active handle registry

无法跨重启和跨副本协调，只能作为同进程快速路径，拒绝作为事实源。

### 3.3 直接把 Run 标记 cancelled 再 kill

会把用户意图伪装成已经发生的进程事实，且 kill 失败后状态失真，拒绝。

### 3.4 事务内发送 signal

长事务会放大 SQLite 写锁和集群锁占用；事务回滚也无法撤销 signal，拒绝。

### 3.5 PID-only 恢复

PID 可复用，可能终止无关进程，禁止。

## 4. 影响

正面影响：

- 两个 Worker 不会在正常租约期同时派发同一取消。
- 崩溃后可以接管，重启不会丢失退避。
- stale Worker 无法覆盖新 owner 的结果。
- edge 与 cluster 共享领域协议，数据库适配器可按 Profile 优化。

代价：

- 增加一张当前状态表和每次派发的短事务。
- signal 与结果提交之间仍存在不可消除的崩溃窗口。
- blocked 状态需要指标、诊断 API 和人工处置流程。

## 5. 当前孵化边界

`next` 已实现 profile-neutral canonical contract、`0005-run-cancellation-dispatch`、legacy Sequelize/SQLite adapter、PostgreSQL `pg-0066-cancellation-dispatch`/capability v65 adapter、lease expiry 接管、fencing、退避、结果事件、Dispatcher、有界 Supervisor 和默认惰性的 lifecycle runner。PostgreSQL 结果事务按 Run→Attempt→dispatch 锁序完成 dispatch 更新、Run version CAS 与 RunEvent 追加；runtime 角色只取得新表的 SELECT/INSERT/UPDATE。

HTTP worker 已通过默认关闭的 manual-only manifest bootstrap 接入 Local Supervisor：只有 accepted 且全部 gate 通过时才启动，失败或 shutdown 时有界停止。以下工作仍未完成，因此它仍只允许显式 canary，不得扩大到默认生产流量：

- 用户可见的运行指标、blocked 诊断和处置入口。
- 固定 edge 设备的数据库写放大、RSS、时延和磁盘基准。
- cluster-control 对 PostgreSQL CancellationDispatch 的生产启动/停止拓扑与运维告警接线。
- 首次真实目标实例完整激活/回滚仪式与共享 config 多写者 authority。

## 6. 验证门禁

1. 两个 Worker 竞争时只有一个 lease owner 可以调用 controller。
2. lease 未过期不接管，到期后新 token/version 可以接管。
3. 旧 owner/token/version 的结果被 fencing 拒绝。
4. 结果 Event 追加失败时 Run version 与 dispatch 状态一起回滚。
5. retry_wait 在到期前不调用 controller，到期后 dispatch_count 递增。
6. terminal/blocked dispatch 不再自动调用 controller。
7. controller missing、handle missing 和临时异常按持久化退避重试。
8. identity/PID/process-group 不一致时零 signal。
9. page、cycle 和退避均有硬上限。
10. Event 与日志不包含 handle、命令、环境和 Secret。
11. PostgreSQL 双连接只能产生一个 claim winner，raw token 不落库，数据库时间决定 lease/retry 到期。
12. v65 事实经 WAL 到达 standby，提升为新 Primary 后仍可读取；旧 owner/token/version 继续被 fencing。
