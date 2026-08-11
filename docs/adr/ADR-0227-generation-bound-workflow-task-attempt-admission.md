# ADR-0227：Generation-bound Workflow Task Attempt 准入

- 状态：Proposed
- 日期：2026-07-30
- 关联 RFC：QL-RFC-0001 D-03、D-207、D-212
- 关联 ADR：ADR-0031、ADR-0105、ADR-0223、ADR-0226、ADR-0228

## 背景

ADR-0223—0226 已把 Plugin Package Workflow 原子展开并推进到 ready StepRun。
现有 Local/Cluster dispatch 与 activation 则是 Run-centric：

- candidate 从 Run 读取 `taskId/taskRevision`；
- Local activation 要求 Run 为 `queued` 且 Attempt 是该 Run 的 latest；
- Cluster dispatch 要求 Run 为 `queued|dispatching`，同样排除非 latest Attempt；
- activation 会把 Run 自身推进为 `dispatching|running`。

这些约束适用于一个 Run 表示一次 Task 执行的普通路径，却不能直接用于 Workflow
aggregate。Workflow Run 的 `taskId` 是 Workflow resource ID，`taskRevision` 是
automation publication digest，Run 已为 `running`，而一个 DAG 还可能有多个 ready
StepRun。直接复用现有 candidate 会把 Workflow 当 Task 执行；只创建 RunAttempt 也
无法给 executor 提供正确、generation-bound 的 TaskDefinition 和 execution revision。

materialized Workflow plan 当前故意绑定 Package source Task 和 source digest；真正可执行
的 runtime Task identity/revision 要由同 generation 的 Task reconciliation 生成：
`pkg:<package>:<resource-task>` 与
`qltd:v1:<revision>:<task-definition-content-digest>`。它不能在执行时从 current head
临时读取，否则长期运行的 Workflow 会混入后续 Package generation。

## 决策

### 1. 在 source plan 与 executor 之间增加原子 Attempt admission ledger

新增现有 runtime-core 的显式 subpath
`plugin-package-workflow-task-attempt-admission`，不新增 workspace package。一次纯
admission 必须同时接受并验证：

- exact immutable Workflow plan、running aggregate Run 与一个 exact `ready` Task
  StepRun；
- 与 plan generation/project/package/lock/materialized revision 全匹配的 immutable
  Task reconciliation receipt；
- 一个完整且可重新计算 digest 的 Local 或 Cluster immutable execution revision；
- storage 分配的 Run-global Attempt number 和单调 database observation time。

契约从 reconciliation item 推导 runtime Task identity 和 `qltd:v1` revision，拒绝
caller 单独声称 task/execution digest。Local revision 固定 `local_process`，Cluster
revision 固定 `remote_worker`。

### 2. 一次 admission 只创建执行意图，不伪造已启动状态

纯结果包含：

- deterministic、双方言可写的最多 36 字节 Attempt ID 与 RunEvent ID；
- 带 `stepRunId`、Run-global Attempt number、`claimed` 和 exact executor type 的
  RunAttempt；
- `workflow.task_attempt_admitted` Event；
- 保持 `running`、只推进一次 version/event sequence 的 aggregate Run；
- 绑定 plan、ready StepRun version/digest、reconciliation receipt digest、runtime
  Task identity/revision、TaskDefinition digest、execution digest、Attempt/Event/Run
  fence 的 immutable receipt。

StepRun 在 admission 时仍为 `ready`，因为 `claimed` 只表示 durable dispatch intent，
不等于进程/Worker 已启动。StepRun 的 `attemptCount` 继续只在进入 `running` 时增加。
后续 StepRun-aware activation 必须原子推进 Attempt 与 StepRun；不能在本 ADR 中提前
写 `running`。

### 3. 双方言 adapter 使用短事务与 current-ready-epoch 唯一性

双方言实现必须：

- 以 `(run, stepRun, stepRunVersion)` 作为一个 ready epoch 的 exact replay 边界；
- 在 Run lock 下分配 Run-global Attempt number，插入 Attempt、Event、admission
  receipt 并对 aggregate Run 做一次 CAS；
- candidate page 最多 64 条，只列 `ready` 且当前 epoch 尚无 admission winner 的
  StepRun；
- SQLite 复用单 operation authority 和 `BEGIN IMMEDIATE`；Cluster 使用
  caller-driven keyset 与短 `SERIALIZABLE` transaction；
- COMMIT response loss 只读取 durable receipt，不生成第二个 Attempt；
- 不新增 timer、watcher、listener、per-Workflow coordinator、连接或缓存。

### 4. execution activation 必须新增 StepRun-aware 路径

现有普通 Task Run dispatcher/activation 保持不变。Workflow Attempt candidate 后续从
admission ledger 读取 Task identity/revision/execution digest，并按 StepRun 而不是
“latest Attempt of Run”围栏。Local/Cluster activation 都必须保留 aggregate Run 为
`running`，原子推进 Attempt 和对应 StepRun，允许多个独立 ready Step 并行，同时仍由
Run version/event sequence 作为 aggregate serialization boundary。

Cluster 路径复用现有 `cluster-postgres` repository、`run_attempts` 和
`run_dispatch_leases`，不新增 Workflow executor package 或第二套 lease 表。
dispatcher 通过 immutable Task Attempt admission ledger 投影 Task
project/revision/execution identity，并按 StepRun 检查 newer Attempt；普通 Task Run
继续使用原 Run-centric 条件。lease claim、starting、running、start failure 和
completion 都在同一个 repository 内按 ledger 是否存在分支，普通 Run 行为不变。

Workflow Task activation/completion 的 aggregate 规则固定为：

- 父 Run 始终保持 `running`，只推进 version/event sequence；
- Attempt 保存 Worker/Lease/callback/Artifact terminal evidence；
- StepRun 通过 canonical mutation/event 推进，`attemptCount` 只在进入 `running`
  时增加；
- `starting` 后 Worker 直接完成的崩溃窗口必须原子补写
  `ready → running → terminal`，不能跳过 StepRun start barrier；
- terminal completion exact replay 绑定 immutable Attempt/Event，即使父 Run 后续因
  其他步骤取消或终结也不能改写历史结果。

### 5. Attempt deadline 是 Task 级停止意图，不是父 Run 取消

Workflow Task 的 `deadline_at_ms` 到期时，Remote Worker lease control 必须返回
`stop_requested(timeout)`，并以 StepRun/Attempt 绑定的
`workflow.task_timeout_requested` Event 留下 durable audit，但不得写父 Run 的
`cancel_requested_at_ms`。完成或 start-failure 回执以数据库观察时间复验 deadline，
将该 Attempt/StepRun 收敛为 `timed_out`；父 Run 由 frontier 汇总所有 StepRun 后决定
最终状态。

用户、Policy、shutdown 等明确的整 Run cancel intent 仍保存在父 Run，并可投影到所有
在途 Worker。Task deadline 与 Run cancellation 必须保持两个 authority，避免一步超时
取消整个 DAG。

### 6. Workflow Task recovery 必须拥有独立的 StepRun 语义

现有通用 lost transition 是单 Run/单 Attempt 模型，会把 active Attempt 与父 Run
一起标记为 `lost`，因此 Workflow aggregate Run 仍按 trigger type 排除。Task Attempt
则可以复用同一个有界 recovery source、`run_recovery_controls` claim 与 evidence
provider，但 resolution 必须通过 immutable admission ledger 识别
`workflow_task` scope，禁止执行 `mark_attempt_and_run_lost`。

pristine、尚未获得 lease 的 claimed Workflow Task Attempt 是正常 dispatcher backlog，
不得因为 `lease_expires_at_ms IS NULL` 被当成 lost。获得过 lease 且过期后：

- `claimed` 尚未跨过 start barrier，没有外部副作用；旧 Attempt 写为 `lost`，exact
  `ready` StepRun 以 `ready→ready` 增加 version/digest，保持 attempt count、ready time
  与父 Run `running`，从而产生一个可再次 admission 的新 epoch；
- `starting` 或 `running` 已存在外部副作用不确定性，只有可信 `not_running` evidence
  才能恢复；Attempt 写为 `lost`，StepRun 收敛为 `failed`。running 路径必须保留
  `running→lost→failed` Event/mutation 链。v1 没有 Step 级幂等/去重策略，因此跨过
  start barrier 后禁止静默自动重试。

PostgreSQL resolution 在 live claim fence 下先取得与 activation/completion 相同的
Attempt advisory authority，再复验 Run、Attempt、admission receipt 与 canonical
StepRun snapshot，并在一个事务内 CAS 父 Run counters、Attempt、StepRun，追加
Attempt Event、StepRun Event 与 mutation。父 Run 状态不变，最终状态继续由 frontier
汇总。实现复用现有 runtime-core/cluster-postgres 与 claim 表，不新增 workspace
package、lease/recovery 表或常驻 timer。

## 不采用方案

### 把 Workflow aggregate 改回 queued 并复用普通 dispatcher

拒绝。它会把 Workflow ID/publication digest 当成 TaskDefinition identity，并且一次
latest Attempt 模型无法表达 DAG 并行 Step。

### 为每个 Step 伪造 child Run

拒绝。现有 StepRun 与 RunAttempt 的 same-Run 外键会被破坏；额外 child Run 还会复制
Workflow/Step 状态、取消、重试和终态语义，制造双聚合。

### 在 dispatch 时读取 current TaskDefinition head

拒绝。current head 可能已属于后续 Package generation，导致一次 immutable Workflow
执行混合不同 generation。

### 只保存 taskId/taskRevision，不验证完整 execution revision

拒绝。caller 可伪造 execution digest 或 executor type；必须使用既有 Local/Cluster
normalizer 重新计算完整 immutable revision。

### 新建 workflow-executor package

拒绝。当前能力没有独立部署、重依赖或权限域，复用 runtime-core 与双方言 storage
subpath 更符合 D-207。

## 当前验证

1. GitNexus 对 admission、dispatch、lease、activation、completion、lease control
   和 recovery source 的影响均为 LOW；普通 Task Run 分支保留原行为；
2. SQLite v42 已完成 immutable ledger、readiness 与 `BEGIN IMMEDIATE` adapter；
   PostgreSQL `pg-0046`/control-core v45 已完成 ledger、runtime-only snapshot、
   六角色 readiness 与短 `SERIALIZABLE` adapter；
3. Cluster 已覆盖 bounded candidate、per-Step newer Attempt、父 Run 不变的 lease、
   starting/running/start-failure/completion、`starting` crash window、Task deadline
   和父 Run 后续取消后的 exact replay，并已实现 admission-bound 专用 recovery；
4. ADR-0228 已补齐双方言整 Workflow cancellation convergence：取消后冻结
   frontier/admission，尊重 start barrier，最后终结父聚合；
5. runtime-core 419/419、local-sqlite 185/185；cluster-postgres 237 项为
   236 pass、1 条件 skip、0 fail；
6. 全新 PostgreSQL 18.4 六角色实例已完成 Task admission→recovery→requeue→
   second admission→whole cancellation；
7. PostgreSQL 18.4 arm64 physical streaming HA 在
   `QL3_HA_SKIP_IMAGE_PULL=true` 下通过：`remote_apply`、timeline 1→2、旧主先
   fencing、`pg_rewind` 只读同步重入、两个 fresh control replica 与总
   `gates.passed=true`；
8. workspace 仍为 20 个 package；本切片没有新增 package、第三方依赖、migration、
   timer、watcher、listener、缓存或第二套 lease/cancellation 表。

## 尚未关闭

1. Local StepRun-aware activation、completion、deadline 与真实断电门；
2. application/control lifecycle 装配、并行度/背压、产品入口和真实低配资源门；
3. 在途 Worker stop_requested→completion/recovery→父 Workflow terminal 的产品
   crash-window 门；
4. 在 PostgreSQL HA fixture 中增加 Workflow Task admission→dispatch→activation→
   completion/timeout→promotion replay 的独立 domain gate。
