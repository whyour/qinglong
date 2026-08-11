# ADR-0229：Local Workflow Task 单 cadence 运行生命周期

- 状态：Proposed
- 日期：2026-07-30
- 关联 RFC：QL-RFC-0001 D-18、D-19、D-71、D-115、D-175、D-207、D-212、D-213
- 关联 ADR：ADR-0066—0072、ADR-0223—0228

## 背景

Workflow admission、frontier、Task Attempt admission、cancellation 和 recovery
已经在共享领域层及 SQLite/PostgreSQL adapter 中存在，但 Local application 仍只有
普通 Run-centric scheduler/execution lifecycle。直接把 Workflow aggregate Run 交给
普通 dispatcher 会把 Workflow ID/publication digest 当成 Task identity；普通
completion/control/recovery 又会提前终结父 Run。

Local application 已经拥有 scheduler cadence、execution control cadence、单 SQLite
operation authority、completion receipt 与受审 POSIX launcher。新增 Workflow timer、
数据库连接、表或 workspace package 会增加路由设备空闲成本，也会制造第二套停止顺序。

## 决策

### 1. 一个 scheduler cadence 承载完整 Workflow 前进顺序

`LocalWorkflowSchedulerCoordinator` 是无 timer 的组合器，每个 cycle 固定执行：

1. 整体 Workflow cancellation convergence；
2. 普通 schedule；
3. Workflow frontier；
4. generation-bound Task Attempt admission；
5. 有界 local dispatch。

它复用既有 `LocalSchedulerLifecycle`。Edge 每轮 cancellation 4×1、frontier 1×1、
Task admission 1×1、dispatch 1；Standalone 分别为 32×4、16×4、16×4、dispatch
4。任何阶段失败都由原 lifecycle 隔离并在下一 cadence 重试，不增加 per-Workflow
timer、watcher、listener 或后台扫描。

### 2. Workflow Task 执行只推进 Attempt/StepRun

Local dispatch candidate 可以携带 `stepRunId`。只有 immutable Task admission ledger
与 exact ready StepRun 同时存在时，父 Run 为 `running` 的 Task Attempt 才可派发。
prepare、running、start-failure、completion、timeout 和 cancellation 都经窄
`LocalWorkflowTaskExecutionRepository` 在一个 `BEGIN IMMEDIATE` 中推进 Attempt、
StepRun、Run counter 与 Event/mutation；父 Workflow Run 保持 `running`，最终状态只
由 frontier 汇总。

普通 Run 仍要求 latest Attempt，并保持既有 `queued→dispatching→running→terminal`
语义。Workflow 分支不能改变普通 Run 的 retry、completion 或 cancellation contract。

### 3. 启动恢复按聚合类型分流

普通 startup recovery 明确排除存在 immutable Workflow admission 的父 Run。专用
Workflow Task recovery 以 Attempt 为单位：

- orphaned claimed Attempt 写 `lost`，并把 StepRun 刷新为新的 ready epoch；
- starting/running 先读取 authenticated completion receipt；
- 没有 receipt 时只接受 exact persisted process identity 的两次一致 live inspection，
  或可信 not-running evidence；
- unknown、缺 handle、身份变化和平台不可验证一律失败关闭。

恢复不终结父 Workflow，也不拥有 timer。

### 4. completion identity 与 Workflow portable identity 统一

Workflow plan 已明确使用最长 36 字节的 portable Run identity，Task admission 生成
`wta:<32 hex>` deterministic Attempt identity。Local completion receipt/journal 过去
只接受 UUIDv7，导致 adapter 单测通过而真实 launcher 永远在请求校验处失败。

receipt、journal 和文件分片统一接受
`[A-Za-z0-9][A-Za-z0-9._:-]{0,35}`。UUIDv7 是该集合的子集；空值、前导点、斜杠、
反斜杠、空白、NUL 和超长 identity 继续拒绝，因此没有扩大目录穿越 authority。

### 5. startedAt 绑定 spawn 前 durable barrier

launcher 在 spawn 前登记 journal，并把同一个 `handle.startedAtMs` 写进不可覆盖
receipt。coordinator 必须把 Attempt/StepRun 的 `startedAtMs` 保存为该 handle fact，
不能在 spawn 后用新的 wall-clock observation 覆盖。否则合法 receipt 会因早于
Attempt start 而被 quarantine。

Event 时间仍必须不早于 Run/Attempt creation；时间回退继续失败关闭。

### 6. 停机先冻结 admission，再 drain execution

application stop 顺序保持：

1. `LocalSchedulerLifecycle.stopAndDrain()`，冻结新 Workflow/Task admission；
2. `LocalExecutionControlLifecycle.stopAndDrain()`，对在途进程提交 shutdown intent、
   exact stop 与 Step-scoped terminal/recovery；
3. 关闭共享 SQLite storage 和 adoption fence。

并发 stop 复用同一个 promise，不产生第二轮 scheduler 或重复 Attempt。

## 不采用的方案

### 新建 `local-workflow` workspace package

拒绝。该能力没有独立部署或依赖边界；组合器、执行 port、SQLite adapter 分别属于既有
local-execution/local-sqlite/local-application。继续拆包会产生更多单文件 package。

### 为每个 Workflow 创建 timer 或 child Run

拒绝。前者增加路由器唤醒/RSS，后者复制 Run/取消/recovery authority，并破坏 same-Run
StepRun fence。

### 保留 receipt UUIDv7-only 并把 deterministic Attempt 强制改为随机 UUID

拒绝。会破坏 admission 的可重算 exact replay，也与已经受审的双方言 portable
identity contract 冲突。严格 portable 字符集在保持路径安全的同时覆盖两类 Run。

## 当前验证

1. `runtime-core` 419/419、`local-process` 18/18、`local-execution` 30/30、
   `local-sqlite` 189/189；
2. macOS application 全量 41 项为 38 pass、3 条 Linux 条件 skip、0 fail；
3. 本机已有 `node:24-bookworm-slim` 镜像在 `--pull never --network none` 下执行真实
   Linux product vertical：两步 Workflow 全部成功，每个 Step 恰好一个 Attempt，
   两条 admission，无重复 dispatch；
4. 启动前用户取消的 Workflow 在 application 首轮 cadence 原子收敛为 cancelled，
   普通 Run recovery 扫描为 0，且没有启动 Attempt；
   Linux 产品门还覆盖在途 Local Task：等待真实 PID/Attempt/StepRun running，
   持久化父 Workflow 取消意图，先停止进程，再将 Attempt/全部 StepRun/父 Workflow
   精确收敛为 cancelled；
5. PostgreSQL 18.4 arm64 physical HA 新增独立
   `pluginPackageWorkflowTaskAttempt*` 五项 gate：原子提交、exact replay、
   `remote_apply` 晋升前复制、runtime-only ACL、timeline 1→2 后存活全部为 true；
6. HA 继续完成旧主 fencing、`pg_rewind` 只读同步重入、两个 fresh control replica，
   `gates.passed=true`，并使用 `QL3_HA_SKIP_IMAGE_PULL=true`；
7. 真实 Local Workflow 已进入既有 Linux resource gate，没有新增 workspace
   package、依赖或常驻 cadence。arm64 Node 24.18.0 的 128 MiB/0.5 CPU 档
   `memory.peak=120217600`、Workflow process peak RSS `87449600`、RSS delta
   `16908288`，16 次 admission write-lock p95 `4.053 ms`；256 MiB/1 CPU 档
   `memory.peak=121344000`、Workflow process peak RSS `87949312`、RSS delta
   `17408000`，32 次 write-lock p95 `3.317 ms`。两档 `memory.events` 的
   max/OOM 增量为零，并完成 Edge/Standalone admission 与
   conclusive-stop/control-terminal 两组各 16 个
   `SIGKILL → reopen → exact replay` 场景。
8. PostgreSQL 18.4 arm64 HA 已完成 Remote Workflow
   `stop_requested → completion response loss/exact replay → parent convergence
   response loss/exact replay → promotion 后再次 replay`；Run/Attempt/StepRun
   cancelled、Lease completed@v6，独立四项 gate 和总 `passed` 均为 true。

## 尚未关闭

1. 固定 Edge/Standalone 物理路由设备报告、闪存/FTL 写放大、真实 ENOSPC 与受控
   突发断电门；CI `SIGKILL` crash matrix 明确不等同于物理断电；
2. Linux x64/arm64 的长期 CI 成功记录和实际低配设备基线。
