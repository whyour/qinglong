# ADR-0013：Remote Run 启动确认、Lease Fencing 与启动失败

- 状态：Accepted
- 日期：2026-07-22
- 关联：QL-RFC-0001、ADR-0001、ADR-0003、ADR-0012、ADR-0109

## 上下文

Run candidate、Placement 和 claim 只能决定“哪个 Worker Session 暂时拥有某个 Attempt”，不能证明 ExecutionSpec 已被接受，更不能证明执行器已经建立可恢复所有权。若 claim 后直接把 Attempt 标记为 running，会留下三个无法区分的崩溃窗口：

1. Worker 尚未收到 ExecutionSpec；
2. Worker 已收到但尚未调用 Executor；
3. Executor 已返回 handle，但控制面尚未持久化。

Remote Worker 还会同时更新 Worker Session Lease 和 Run Lease。启动 ACK 若不携带两层 fencing，旧 Session、旧 lease generation/token 或 renewal 前的旧 version 都可能迟到覆盖当前状态。

## 决策

### 1. claim、starting 和 running 是三个不同事实

Remote Run 启动固定为：

1. Dispatcher 发现有界 candidate 并完成 Placement；
2. `claim` 事务提交 Run Lease，Run 进入 `dispatching`，Attempt 仍为 `claimed`；
3. Worker 接受匹配的 ExecutionSpec 后提交 `acknowledgeStarting`，Attempt 进入 `starting`；
4. Worker 获得稳定 executor handle 后提交 `acknowledgeRunning`，Attempt 与 Run 在同一事务进入 `running`；
5. 只有第 4 步提交后，控制面才能宣称执行器所有权已经持久化。

不得用 candidate 命中、消息 delivery ACK、内存中的 future 或 Worker heartbeat 代替上述状态事实。

### 2. 每个 ACK 都验证两层 Lease

`acknowledgeStarting`、`acknowledgeRunning` 和 `failStart` 必须同时绑定：

- Worker ID、Session ID、Worker generation；
- Run ID、Attempt ID；
- Run Lease generation、token 和 expected version；
- Attempt 的 executor type。

控制面在一个数据库事务中复验 Worker Session 状态/过期时间和 Run Lease 状态/过期时间。任一字段不匹配、lease 已过期、Worker 已 offline 或 version 已被 renewal 推进时 fail closed。Worker 必须从本地单 timer lifecycle 取得最新 lease version 后重试，不允许忽略 version mismatch。

### 3. ACK 必须幂等但不能掩盖元数据冲突

- 重复 starting ACK 在同一 Lease authority 下返回 `already_starting`；若 Run 已正确进入 running，迟到的 starting ACK 返回 `already_running`。
- 重复 running ACK 只有在 executor handle、log artifact 和 Worker authority 完全一致时返回 `already_running`；不同 handle 必须拒绝。
- ACK 不推进 Run Lease version；renewal 是 version 的唯一非终态推进者。ACK 首次写入仍要求 expected version 精确匹配。
- 原始 lease token 只存在于认证后的 Worker capability 和 `RunDispatchLeases`，不得进入 RunEvent、普通日志或 API 投影。

### 4. 启动失败是终结事务

Worker 已确认 starting 但 Executor 未建立所有权时，`failStart` 必须在同一事务中：

- 将 Attempt 置为 `failed`，错误码为 `EXECUTOR_START_FAILED`；
- 将 Run 置为 `failed`；
- 追加 Attempt/Run 两条 Worker 归因事件；
- 将 Run Lease 置为 `completed` 并推进 version。

若 Run 已存在 cancellation request，取消事实优先：普通取消进入 `cancelled`，timeout 取消进入 `timed_out`。因此 Run 状态机允许 `dispatching → timed_out`。事务任何一步失败都必须回滚 Attempt、Run、事件和 Lease。

### 5. SQLite 与 PostgreSQL 共享协议，生产装配仍受门禁

`next` 的 SQLite `withLease`、Activation Service 与 Worker 私有 inbox 继续证明单控制面 crash window。ADR-0109 已在 PostgreSQL runtime role 上实现等价的 starting/running/start-failure 原子事务，并把 callback sequence/token digest、offer、Session 与完整 Lease fence 一起固化；认证 Worker ingress 只调用注入 port，独立 ingress role 不获得 Run mutation 权限。

这不等于 Remote Worker 已生产可用。认证 ExecutionSpec/Artifact/completion transport、Worker inbox 网络装配、远端 completion/expiry/cancellation/retry 生命周期及多 Pod/failover 证据仍是后续门禁。不得通过共享 SQLite、delivery ACK 或消息系统 ACK 代替数据库 fencing。

## 影响

正面影响：

- claim 后的三个启动崩溃窗口具有可区分状态；
- 旧 Worker、旧 Lease 和旧 renewal version 无法提交启动事实；
- executor handle 与 Run `running` 原子落库，后续 Reconciler 有稳定所有权依据；
- 启动失败、取消和超时保留真实终态。

代价：

- Worker transport 至少增加 starting、running 和 start-failure 三类幂等命令；
- Worker 必须协调 Run Lease renewal 与启动 ACK 的最新 version；
- running 前的失联恢复需要按 `claimed/starting` 分别制定过期策略。

## 未选择的方案

1. **claim 后立即标记 running**：无法证明 Worker 已接收任务或 Executor 已启动。
2. **Executor 启动后只发送一次 running 回调**：Worker 在 spawn 前后崩溃时可能留下重复执行窗口。
3. **ACK 不验证 lease version**：renewal、迟到请求和 Session replacement 无法形成统一 fencing。
4. **启动失败只 release lease**：Attempt 会残留 starting，候选与恢复路径失去事实依据。

## 验证要求

- running ACK 未经过 starting 时必须拒绝；
- starting/running ACK 相同元数据可幂等重放，冲突 handle 必须拒绝；
- renewal 后的旧 expected version 必须被 fencing，最新 version 可继续；
- lease expiry、Worker Session replacement 和错误 token 均不得改变 Run；
- start failure 同事务提交 Attempt、Run、双 Event 和 lease completed；
- cancellation 与 timeout 在启动失败竞争中保持正确终态；
- 第二条 running Event 或 lease completion 前注入失败时，所有写入整体回滚；
- Node 22、Node 24 和未来 PostgreSQL contract suite 复用上述场景。

ADR-0109 已用 PostgreSQL 16.10 真库覆盖 starting/running 精确重放、普通启动失败、timeout 优先终态、digest-only capability 与独立角色权限；其余 renewal/ACK 并发和 failover 压力仍需远端矩阵继续验证。
