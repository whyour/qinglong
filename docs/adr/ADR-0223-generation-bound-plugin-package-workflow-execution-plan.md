# ADR-0223：按 generation 绑定的 Plugin Package Workflow 执行计划

- 状态：Proposed
- 日期：2026-07-30
- 关联 RFC：QL-RFC-0001 D-12、D-144、D-211、D-212
- 关联 ADR：ADR-0001、ADR-0150、ADR-0156、ADR-0222、ADR-0224

## 背景

ADR-0222 已经让 Workflow 定义以 immutable、generation-bound publication 发布，并让
quarantine、publisher revocation 和正常 lifecycle withdrawal 立即阻止新启动。但定义
可见不等于 Workflow 可执行。现有系统仍缺少一个不可变输入，把以下事实绑定为同一次
运行意图：

- exact active automation publication；
- exact materialized revision 与 Workflow 定义；
- Workflow 中每个 Task 的 immutable source digest；
- DAG 依赖、初始 ready frontier、Run ID 与每个 StepRun ID。

如果执行器临时读取多个 current head，再逐项创建 StepRun，会留下三个问题：

1. Package upgrade、disable 或安全撤销可在读取之间切换 generation；
2. 进程崩溃可能只展开部分 DAG；
3. 响应丢失后无法区分 exact replay 与使用新定义重新执行。

这些问题不能靠进程内缓存、定时扫描或“再次读取最新定义”修复。

## 决策

### 1. 先冻结纯执行计划，不提前开放执行副作用

`@qinglong/runtime-core/plugin-package-workflow-execution-plan` 提供 profile-neutral
纯契约，不新增 workspace package、第三方依赖或进程：

- schema 固定为 `qinglong/plugin-package-workflow-execution-plan@v1`；
- 最多 128 个 Step，编码后最多 256 KiB；
- plan 绑定 Project、Package、installation、lock、generation、materialized
  revision、publication、Workflow definition、Run 与所有 StepRun identity；
- 每个 Step 绑定 Task ID、generation-bound reference、原始 source digest、依赖和
  `pending|ready` 初态；
- root Step 才能为 `ready`，有依赖的 Step 必须为 `pending`；
- plan 使用 domain-separated canonical SHA-256，可严格 normalize 与复算。

本 ADR 的切片只创建不可变 plan。后续 ADR-0224 已在 SQLite 中原子创建
Run/StepRun/receipt，但仍不调用 Executor、不解析 Secret、不读取输入 Artifact，
也不把 durable admission 解释为产品 Workflow 已开放。

### 2. v1 执行面严格等于现有 Package Workflow 语义

Plugin Package Workflow v1 只包含有界、无环的 Task DAG：

- Step 只引用同一 materialized revision 中的 Package Task；
- disabled Workflow 或 disabled Task 拒绝规划；
- publication 与 revision 的 Project、Package、installation、lock、generation 和
  digest 必须完全一致；
- publication 中的 Workflow semantic digest 必须与 revision 中的同名 Workflow
  一致；
- 调用者必须一次提供与 Step key 精确相等、无重复的 StepRun ID 集合。

RFC 15.1 中的 Model、Tool、Approval、条件、表达式、Subworkflow、动态重试和模板输入
不是这个 v1 plan 的隐式能力。它们必须在各自的 Policy、Secret、Artifact、Trace 和
start barrier 契约完成后按版本扩展，不能通过任意 JSON 字段提前进入执行面。

### 3. durable admission 必须是双方言单事务

存储切片必须新增专用 Workflow admission authority，而不是让应用串联通用
RunRepository 与 StepRunRepository。一次 admission transaction 必须：

1. 取得与 publisher revocation 相同的安全序列化边界；
2. 在事务内验证 exact publication start guard；
3. exact replay 优先检查 immutable plan/receipt；
4. 原子创建 Workflow Run、全部 StepRun、顺序 RunEvent/StepRun mutation 与
   admission receipt；
5. 任一 collision、generation 漂移、非 current publication、quarantine、
   lifecycle withdrawal 或权限失败全部回滚；
6. COMMIT response loss 只能 inspect durable receipt，不得重新生成 ID 或重新规划。

SQLite 复用单 `LocalSqliteOperationAuthority` 与 `BEGIN IMMEDIATE`。PostgreSQL 使用
受审 `SECURITY DEFINER` admission function 或等价的单一 runtime transaction，使
start guard 和 Run/StepRun 写入共享同一 transaction-level signer lock。runtime
不取得 Package provenance、quarantine 或 publisher receipt 表的直接读取权。

### 4. executor 使用 durable frontier，不使用常驻全量扫描

后续 executor 只能从已 admission 的 plan 与 StepRun 状态计算 frontier：

- 只有全部 `needs` succeeded 的 pending Step 才能原子推进为 ready；
- 任一 required dependency failed/cancelled/timed_out 时，下游收敛为 skipped，
  Workflow Run 按固定聚合规则终结；
- 已 durable running 的 Step 在 Package 后续 withdrawn/quarantined 时按原 revision
  完成或恢复；安全事实只禁止新的 Workflow/Step start；
- Edge/Standalone 使用既有 application lifecycle 的有界单页调用，默认分别限制为
  8/32 个候选，不新增 daemon、watcher 或 per-Workflow timer；
- Cluster 使用 caller-driven worker/executor cycle 与数据库 keyset claim，不创建
  每 Workflow 常驻 Job 或内存队列。

具体 Task Attempt 启动仍必须复用现有 Run/Attempt/Executor fence，不能由 Workflow
planner 直接 spawn。

## 不采用方案

### 每次执行重新读取 current Workflow 和 Task head

拒绝。会让一次 Run 混合多个 generation，也无法 exact replay。

### 先建 Run，再逐项创建 StepRun

拒绝。崩溃会留下半展开 DAG，恢复只能猜测未创建步骤。

### 把 Workflow executor 放进新的 workspace package

拒绝。纯领域契约没有独立部署、权限域、重依赖或 Profile 替换价值；它属于
runtime-core subpath。双方言 authority 分别留在既有 local-sqlite 与
cluster-postgres。

### Edge 为每个 Workflow 启动 timer 或 watcher

拒绝。低配路由设备不能为 dormant Workflow 支付常驻内存、唤醒和闪存写放大。

### publication withdrawn 后终止所有 running Step

拒绝。正常退役和安全隔离都不等于已启动副作用可以安全热杀；running execution 继续由
Attempt cancellation/recovery authority 裁决。

## 当前验证

1. runtime-core 定向 6/6：active publication + exact revision 生成两步 DAG，
   root 为 ready、dependent 为 pending，并绑定两个 Task source digest；
2. 完整 plan、JSON round-trip 与无摘要字段输入得到相同 canonical digest；
3. withdrawn publication、跨 revision 漂移、缺失或重复 StepRun ID、plan digest 和
   generation-bound Task reference 漂移均失败关闭；
4. planner 只经显式 runtime-core subpath 发布，root 不暴露 authority；
5. runtime-core 完整测试 394/394 通过；
6. ADR-0224 已完成 SQLite v41 单事务 admission、Run/StepRun/event/mutation/receipt
   exact replay 与 readiness；workspace 仍为 20 个 package；
7. 未新增生产依赖、timer、watcher、listener 或常驻进程。

## 尚未关闭

1. PostgreSQL durable admission repository、migration、readiness、权限与 HA；
2. SQLite 真实断电和固定 Edge 资源预算；
3. 有界 ready-frontier coordinator 与 Task Attempt 启动；
4. Workflow terminal aggregation、取消、超时和恢复；
5. 产品级强认证/Policy/API/CLI/UI 入口；
6. Prompt、Secret binding 以及 Model/Tool/Approval/Subworkflow 扩展。
