# ADR-0228：有界 Plugin Package Workflow 整体取消收敛

- 状态：Proposed
- 日期：2026-07-30
- 关联 RFC：QL-RFC-0001 D-18、D-19、D-71、D-117、D-207、D-212、D-213
- 关联 ADR：ADR-0072、ADR-0118、ADR-0121、ADR-0226、ADR-0227

## 背景

Workflow Task 已有 generation-bound admission、StepRun-aware
activation/completion 和专用 recovery，但普通 Run cancellation convergence
一次只处理一个 Run 与最新 Attempt。Workflow aggregate 则以同一个 Run 承载最多
128 个 StepRun 和多个 Task Attempt；直接复用普通逻辑会出现三类错误：

1. 父 Run 被提前写为 terminal，而在途 Worker 仍有 execution authority；
2. pending/ready StepRun 继续被 frontier 或 Task admission 推进；
3. 只终结“最新 Attempt”，其余 StepRun 永久不能收敛。

同时，不能为每个 Workflow 或 Step 增加 timer、watcher、child Run、额外 claim 表或
workspace package。Edge/Standalone 的 SQLite 单连接与 Cluster 的 PostgreSQL 多副本
必须共享同一个领域裁决，但采用各自合适的锁和分页策略。

## 决策

### 1. 取消意图只属于父 Workflow Run

`cancel_requested_at_ms` 与 `cancel_reason` 继续写在 aggregate Run。收到意图后：

- Workflow frontier 和 Task Attempt candidate 都必须排除该 Run；
- 不再产生新的 ready StepRun 或 Task Attempt；
- 已 durable 的 Task Attempt 仍由原 activation/completion/recovery authority 收敛，
  cancellation reconciler 不能伪造 Worker 已停止。

### 2. 使用一个 profile-neutral 纯状态机

`runtime-core/plugin-package-workflow-cancellation-convergence` 接收 exact Run、
全部 StepRun、immutable admission-bound active Task Attempt、lease 状态和观察时间，
确定性输出：

- 可安全终结的 claimed、尚未执行 Attempt transition 与 Event；
- non-executing StepRun mutation/Event；
- 仍持有执行 authority 的 blocked Attempt/StepRun identity；
- 仅当 projected StepRun 全部 terminal 时才生成父 Workflow terminal transition。

状态机不读取数据库、不持有连接、不创建 timer，也不决定执行器 stop。输出 ID 由
Run、取消时间、target identity 和 durable epoch 生成，最长 36 字符，可在未知提交
结果后重算。

### 3. start barrier 不能被取消协调器越过

- claimed 且没有 active lease 的 Task Attempt 可以在 exact admitted ready epoch
  直接收敛为 `cancelled|timed_out`；
- claimed + leased、starting、running 一律 blocked，等待 Worker completion 或可信
  recovery；
- running StepRun 即使缺少当前 adapter 可见的 Task Attempt，也保持 blocked，不能写
  假终态；
- pending/lost StepRun 在 aggregate timeout 下写 `cancelled`，因为它们没有实际
  执行超时；ready/waiting_approval 可写 `timed_out`；
- 用户、Policy、shutdown、reconcile 取消统一映射为 `cancelled`；父 Run 的 timeout
  映射为 `timed_out`。

### 4. 父 Run 最后终结

每个可安全 Attempt Event、StepRun mutation/Event 都先消耗连续 aggregate
version/event sequence。只有所有 StepRun projected terminal 且 blocked 集合为空时，
才追加 `workflow.cancelled|workflow.timed_out` 并终结父 Run。部分收敛后父 Run
保持 `running` 和原 cancel intent，后续 caller-driven cycle 继续处理。

一个 Workflow 可以在一页中结算多个 Attempt，因此共享 page result 的
`settledAttempts` 上界从 `settledRuns` 修正为
`scanned * MAX_STEP_RUNS_PER_RUN`；`settledRuns` 和 `blocked` 仍以 aggregate Run
计数。

### 5. PostgreSQL 使用既有 Attempt authority 锁顺序

Cluster adapter 留在 `@qinglong/cluster-postgres` 的显式 subpath/既有 cancellation
repository：

1. 普通非 Workflow Run 保留原 `SKIP LOCKED` 收敛；
2. Workflow candidate 不先锁 Run；
3. 先稳定排序 active Attempt ID，并取得 `pg_try_advisory_xact_lock`；
4. 再锁父 Run、active Attempt、lease 和全部 StepRun，重新读取 immutable admission；
5. 在一个短事务中 CAS Attempt/StepRun/Run，并追加全部 RunEvent 与
   StepRunMutation。

这保持 activation/completion/recovery 的 Attempt authority → Run/Attempt/Step
固定锁序。锁竞争返回 blocked，不以扩大 timeout 或交换锁序处理。

### 6. SQLite 使用每 Workflow 一个短事务

Edge/Standalone adapter 留在既有 `@qinglong/local-sqlite` 包并复用共享
`LocalSqliteOperationAuthority`。一页先有界读取 candidate，但每个 Workflow 单独执行
一个 `BEGIN IMMEDIATE`：

- 页面增大不会把一个 SQLite write lock 放大到整页 DAG；
- 单 Workflow 最多 128 StepRun，内存和写放大有硬上限；
- 中途故障只会留下已完整提交的前序 Workflow，重跑按 durable terminal 状态继续；
- 不增加连接、后台线程、timer、表、migration 或依赖。

## 不采用的方案

### 每个 Step 创建 child Run

拒绝。会复制 Workflow/Step 聚合、取消 intent、版本序列和 recovery authority。

### cancellation reconciler 直接终结 leased/running Attempt

拒绝。stop_requested 不是执行已停止的证据，迟到 completion 可能来自仍合法的 Worker
authority。

### 为 Workflow 新建 cancellation package、表或 cadence

拒绝。该能力没有独立部署、权限或重依赖边界；复用现有 core/storage subpath 更符合
D-207，也避免增加路由器供应链和空闲唤醒成本。

## 当前验证

1. `runtime-core` 共享状态机覆盖全部 non-executing、unleased claim、leased/running
   blocked、timeout 映射、determinism 与 stale admission，完整测试 419/419；
2. `local-sqlite` 在真实内存 SQLite 上完成 Attempt + 两 StepRun + 父 Run 原子取消、
   admission crash 与 conclusive-stop/control-terminal crash 的 exact replay，
   完整测试 189/189；
3. `cluster-postgres` 完整测试 238 项为 237 pass、1 条条件 skip、0 fail；
4. 全新 PostgreSQL 18.4 最小权限六角色实例已完成 admission→recovery→requeue→
   second admission→whole cancellation，连续事件和所有 terminal fact 同事务提交；
5. `QL3_HA_SKIP_IMAGE_PULL=true` 的 PostgreSQL 18.4 arm64 物理 HA 门再次通过
   `remote_apply`、timeline 1→2、旧主先 fencing、`pg_rewind` 只读同步重入、两个
   fresh control replica 与 `gates.passed=true`；
6. Cluster production composition 已复用原有全局 cancellation lifecycle 和同一个
   PostgreSQL repository，因此不增加第二 cadence。
7. ADR-0229 已把 Local cancellation、frontier、Task admission 与 dispatch 接入同一
   scheduler cadence；启动前取消的 Workflow 原子终结两个 StepRun、零 Attempt，
   普通 Run recovery 扫描为 0；
8. PostgreSQL physical HA 已新增独立 Workflow Task Attempt report，原子提交、
   exact replay、晋升前复制、runtime-only ACL 与晋升后存活五项 gate 全为 true；
9. Local 两步 Workflow、每 Workflow 一个 SQLite write transaction，以及
   Edge/Standalone 两组各 16 点 admission 与 conclusive-stop/control-terminal
   crash/reopen/replay 已接入既有 128/256 MiB Linux resource gate。arm64 实测的
   Workflow process peak RSS 分别为 `87449600`/`87949312` bytes，写锁 p95
   分别为 `4.053`/`3.317` ms，cgroup memory pressure/OOM 增量为零；
   workspace 仍为 20 包。
10. PostgreSQL 18.4 arm64 physical HA 新增真实 Remote Workflow cancellation
    矩阵：正式 admission/Task Attempt、`stop_requested`、成功退出映射 cancelled、
    completion 与父 Workflow convergence 两个 COMMIT response-loss 窗口、
    exact replay、`remote_apply`、timeline 1→2 与 promotion 后再次 replay 均通过；
    Run/Attempt/StepRun 为 cancelled、Lease 为 completed@v6，8 个 Event 与 3 个
    StepRun mutation 无重复。

## 尚未关闭

1. 固定 Edge/Standalone 物理设备基线、闪存/FTL 写放大和受控突发断电门；CI
   `SIGKILL` 证据不提升为物理 power-loss 结论。
