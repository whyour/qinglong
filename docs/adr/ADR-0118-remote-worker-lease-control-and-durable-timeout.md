# ADR-0118：Remote Worker Lease Control 与耐久 Timeout

- 状态：Accepted（生产 route composition 已由 ADR-0119 接入、共享 Artifact adapter 已由 ADR-0120 实现、Worker execution composition 已由 ADR-0121 实现；完整 Worker 产品生命周期仍默认关闭）
- 日期：2026-07-23
- 关联 RFC：QL-RFC-0001 D-25、D-71、D-85、D-108、D-111、D-115、D-116、D-117
- 关联 ADR：ADR-0012、ADR-0021、ADR-0109、ADR-0112、ADR-0116、ADR-0117

## 背景

ADR-0117 已能认证上传 Artifact 并原子完成远端 Run，但 package Worker 在进程启动后没有持续的
Run Lease 控制链。只依赖 Offer 初始 expiry 会让长任务必然失租；只在 Worker 内存启动 timeout
timer，则重启、休眠或时钟漂移后无法证明何时应停止。控制面若直接停止远端 PID，又会跨越节点
边界并可能误杀复用身份。取消、timeout、Session replacement 与 completion 还会竞争同一 Lease
version，必须由一个完整 fence 和一个持久化顺序收敛。

低配路由设备不能为每个 Run 建 timer/socket；集群节点又需要多 Worker 实例和多 control replica
安全并行。因此控制协议必须是 caller-driven、有界、可重放，并保持数据库和本地进程各自唯一
authority。

## 决策

### 1. 不新增 package，新增 exact lease-control subpath

wire contract 放在 `@qinglong/runtime-core/remote-worker-lease-control`，Cluster service、PostgreSQL
repository 和 Worker adapter 分别放入既有 cluster-control、cluster-postgres、worker-runtime。它们
没有新的依赖、部署、权限或发布责任，不满足 D-85 的拆包条件。

`qinglong/remote-worker-lease-control@v1` request 最大 8 KiB，response 最大 4 KiB。Worker/Session
来自 path，body 携带 worker generation、Project、Run、Attempt、Offer、Lease generation、raw token
和 expected version。response 固定为 `renewed`、`stop_requested` 或 `terminal`，不回显 raw token
或 digest；续租响应必须恰为 expected version + 1。

Worker adapter 复用 ADR-0112 的 TLS 1.3 mTLS client、credential provider 和单 keep-alive Agent，
不创建第二个 socket authority。path/body identity、schema、byte cap、response authority 或 version
漂移全部 fail closed，临时 response buffer 消费后清零。

### 2. PostgreSQL 拥有时间、timeout intent 和 Lease version

repository 在 Attempt advisory lock 后，依次锁定当前 Worker Session、Run/Attempt 与 Run Lease，
最后读取数据库时间。它复验 Session/generation、Project、Run/Attempt 状态、Offer、Lease generation、
token digest、expected version 与 expiry；raw token 不进入 SQL、Event 或错误。

live `claimed|starting|running` authority 每次把 Lease 和 Attempt version 同时加一，并用数据库时间
写 renewed/expiry。若已有 user/policy/shutdown/reconcile/timeout cancel intent，则同一事务仍先续租，
再返回 durable stop request，让 Worker 有时间停止并提交 completion。若 Attempt deadline 已到且尚无
cancel intent，事务先原子写 `run.cancel_requested_at_ms/reason=timeout`、Run version/Event sequence 和
server-ID `run.cancel_requested` Event，再返回 stop request。已完整终态只做 exact terminal projection；
旧 Session、旧 version、过期 Lease 或状态漂移拒绝。

### 3. starting ACK 原子固定 durable deadline

timeout 只来自 Run 已 pin 的 immutable `task_execution_revisions.plan_json.timeoutMs`。starting ACK 在
既有 activation transaction 内 join 精确 Project/Task/task revision/executor revision，读取一次数据库
时间，并把 `deadline_at_ms = observedAtMs + timeoutMs` 与 Attempt `starting` 同时写入；Event 与 exact
activation snapshot 投影同一 deadline。无 timeout 的 revision 必须保持 deadline 为 null。

Worker Processor 对 activation snapshot 做双向约束：revision 有 timeout 时 deadline 必须存在，revision
无 timeout 时 deadline 必须缺失。spawn 前再次 replay starting ACK；只有拿到 durable deadline 才把
`timeoutMs + executionDeadlineAtMs` 交给 Executor。Executor 对单边字段、负值或非安全整数 fail closed，
不再使用本地 timer 冒充控制面 timeout authority。

### 4. Worker 先回放 completion，再续租或精确停机

`WorkerRemoteExecutionControlCoordinator.reconcile(offerId)` 是单项、无 timer、同 Offer coalesced 操作：

1. 读取并规范化唯一 inbox record；已 completion ACK 直接结束。
2. 先调用 receipt-first completion recovery。Artifact/completion transport 临时失败与 lease transport
   隔离，不能阻止仍运行进程保有 authority。
3. 本地 Lease 已到期时不再访问控制面，只对已持久化 durable handle 调用受审
   `LocalProcessController.stop()`；TERM/KILL 成功或已退出记录
   `lease_lost_local_execution_stopped`，身份/信号无法确认记录
   `lease_lost_local_execution_unverified`。
4. Session 与本地 Lease 仍有效时发送完整 fence。`renewed|stop_requested` 必须先以 inbox revision CAS
   持久化新 Lease version/time，再执行 stop；这样 completion 永远使用最新 version。
5. `terminal` 先停止精确本地身份，再将 record 隔离为 `control_plane_terminal`，绝不由旧 Worker
   写控制面假终态。

### 5. Headless lifecycle 只做 caller-driven 有界监督

显式 headless lifecycle 现在要求注入 control coordinator。startup reconciliation 完成后，每个 tick
先按稳定 cursor 扫描最多 1–64 条 inbox record，串行监督 `launching|started|running_acknowledged`，再
决定是否 Pull。出现 lease loss、control-plane terminal 或 durable recovery fact 后立即停止 Pull。
监督扫描与 Pull 之间再次检查 AbortSignal，确保 shutdown 先中止请求再释放 journal owner。

lifecycle 不创建 timer、watcher、队列或额外连接。Edge 可以由外层单 cadence 使用较小 page，Node
可以增大到 64 或按 Worker 实例水平扩展；禁用时仍为零后台活动。外层 heartbeat/drain、共享
Artifact store 和完整 Worker Profile composition 未闭合前不得默认启用。

### 6. 用户取消使用认证 mutation 与事务内 Policy fence

Cluster Control 提供 `POST /api/v3/projects/{projectId}/runs/{runId}/cancellation`，权限固定为
`run.stop`。body 只接受 exact `qinglong/run-cancellation@v1` 与 bounded `mutationId`，reason
固定为 `user`，调用方不能伪造 `shutdown|policy|timeout`。通用 admission 必须在读 body 前完成
authentication、Project Policy 和 durable security audit；Agent 的 `run.stop` 仍返回
`require_approval`，不能用该路由绕过 Approval 状态机。

PostgreSQL repository 不能只信任 admission 的历史 allow：它在 serializable 短事务中依次锁定
Project、读取当前 RoleBinding、锁 Run，精确复验 Project/binding version、active 状态和
owner/admin/operator role。随后以数据库时间写 `cancel_requested_at_ms/reason=user`，递增 Run
version/event sequence，并追加 server-ID、actor-bound `run.cancel_requested` Event。首次提交返回
202 `accepted`；已有意图和终态分别返回 200 `already_requested|already_terminal`，不重复 Event。
Project 漂移、撤权或角色变化在 Run 写入前返回 fence conflict；跨 Project 与不存在 Run 同样投影
404，避免资源枚举。该入口只提交 durable intent，不承诺进程已经停止；Remote Worker 在下一次
lease-control 看到 stop request。ADR-0119 已把该 mutation 固定注册进受审生产 registry；Worker
ingress 与 headless 组合仍保持独立、默认关闭。

### 7. 非执行状态由一个有界 convergence lifecycle 收敛

`ClusterRunCancellationConvergenceCoordinator` 每周期最多处理 1–128 条、最多 1–64 页，跨调用
coalesce，自身不持有 timer、连接或队列。Cluster Control 外层只创建一个全局 cadence；Edge/Standalone
后续也可复用 coordinator 并选择更小预算，不得创建 per-Run timer。

PostgreSQL repository 用 `FOR UPDATE SKIP LOCKED` 在短事务内选择已经有 durable cancel intent 且处于
`created|queued|waiting_approval|retry_wait|lost` 的 runtime Run。`lost` 不是终态，因为 retry authority
仍可把它推进 `retry_wait|queued`；取消 API 不得提前返回 `already_terminal`。最新 Attempt 若仍是
`claimed`，repository 先把 Attempt 收敛为 `cancelled|timed_out`，随后按连续 sequence/version 原子终结
Run 并写两条 reconciler Event；没有活动 Attempt 或最新 Attempt 已终态时只写 Run Event。

Event ID 只在实际锁到 candidate 后，按 domain + Run/Attempt + cancel timestamp 做域分离 SHA-256 并截取
128 bit，空闲 tick 不预生成 UUID；同一次意图重试得到同一稳定 ID。若发现已经跨过 start barrier 的
`starting|running` Attempt 或带 active Lease 的 claimed Attempt，repository 返回 `blocked`，绝不伪造
终态；这些状态只允许由 Worker completion 或受信 evidence recovery 收敛。多 replica 通过 SKIP LOCKED
分摊候选，无需新增 claim 表、migration、schema 或常驻连接。

## 被否决的替代方案

1. **每 Run 一个 timeout/renewal timer**：资源随并发增长，休眠与重启丢失语义，拒绝。
2. **Worker 本地时钟决定 durable timeout**：多节点时钟漂移且不能认证重放，拒绝。
3. **控制面远程发送 PID signal**：跨节点 authority 且 PID 可复用，拒绝。
4. **stop 后再保存 Lease version**：完成回调会携带旧 version，被 fence 或产生不可解释窗口，拒绝。
5. **续租失败立即写 Run lost**：旧 Worker 无控制面终态写 authority，拒绝。
6. **为 lease client/coordinator 新建 package**：依赖与发布责任未分离，违反 D-85，拒绝。
7. **只在 admission 检查一次 Policy**：授权与 Run mutation 之间可被撤权竞态穿透，拒绝。
8. **允许调用方提交 cancel reason**：可伪造系统 shutdown、policy 或 timeout 事实，拒绝。

## 验收证据

1. runtime exact wire 覆盖 renewed/stop/terminal、byte cap、未知字段和非法 shape。
2. ingress 先认证/audit，再 path-bind command；fenced 映射 409、storage unavailable 映射 503，response
   不泄漏 token。
3. PostgreSQL repository 覆盖续租、既有取消、deadline timeout intent、terminal projection、旧 version
   rollback，且 raw token 不进入 SQL/Event。
4. starting ACK 用数据库时间写 deadline，无 timeout 时写 null；wire round-trip deadline。
5. Worker HTTPS adapter 验证完整 identity 和 version + 1；真实 TLS 1.3 mTLS 回归在同一默认
   Agent 上连续执行 Artifact、completion 与 lease-control，并验证可清零凭据 Buffer 不会改变
   socket 回收池键或挂起后续请求。
6. control coordinator 证明 completion-first、persist-before-stop、本地过期不访问控制面、成功/不确定
   stop 证据分离、Session unavailable 和同 Offer coalescing。
7. headless lifecycle 证明 bounded supervise-before-Pull、recovery fail-closed、tick coalescing 与
   Abort-before-release。
8. Executor 无 durable deadline 时不 spawn，有 deadline 时通过原有 reviewed spawn barrier。
9. exact 用户取消 route 在 admission 后传递完整 subject/policy fence；PostgreSQL 16 最小权限
   runtime role 真实验证 accepted、exact replay、Event actor/payload 与撤权 fence rejection。
10. 未新增 workspace package、migration、schema、per-run timer、队列或常驻连接。
11. bounded convergence 覆盖 queued+claimed、lost+terminal Attempt、timeout、blocked start barrier、
    page/coalescing/stop drain；PostgreSQL 16 最小权限 runtime role 真实验证
    `run.cancel_requested → attempt.cancelled → run.cancelled` 原子序列。
12. ADR-0125 的本机 arm64 PostgreSQL 18.4 physical-promotion 门分别在用户 cancellation intent 和
    cancellation convergence 的 driver-confirmed `COMMIT` 后终止 transaction backend。意图以同一
    command 重放为 `already_requested`，终态收敛重放扫描 0 条；standby 在 promotion 前及 timeline 2
    promoted primary 上均保持 Run version 4/event sequence 3、上述 3 条 Event、3 个 dedupe key 和
    0 duplicate。故障范围是 PostgresClient 边界，不是 raw-wire packet-loss。
