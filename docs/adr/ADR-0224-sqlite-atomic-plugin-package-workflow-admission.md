# ADR-0224：SQLite Plugin Package Workflow 原子准入

- 状态：Proposed
- 日期：2026-07-30
- 关联 RFC：QL-RFC-0001 D-03、D-12、D-144、D-207、D-212
- 关联 ADR：ADR-0001、ADR-0156、ADR-0158、ADR-0222、ADR-0223

## 背景

ADR-0223 已冻结 generation-bound Workflow execution plan，但纯计划本身不构成可恢复
执行事实。若应用依次调用通用 Run repository 和 StepRun repository，则进程崩溃可能
留下只有 Run、只有部分 StepRun 或缺少 receipt 的半展开 DAG；若 start guard 与这些
写入不共享序列化边界，publisher revocation、quarantine、lifecycle withdrawal 或
Package generation 切换还能在检查后、提交前穿越。

SQLite Edge/Standalone 不能通过新增 coordinator 进程、每 Workflow timer 或常驻缓存
掩盖这个窗口。准入必须复用现有单连接有界 operation authority，并在一个短事务中
完成。

## 决策

### 1. authority 留在现有 local-sqlite package

新增显式 subpath
`@qinglong/local-sqlite/plugin-package-workflow-admission`，不新增 workspace package、
第三方依赖、进程、timer、watcher、listener 或端口。root export 不暴露该 mutation
authority；现有 `LocalSqliteOperationAuthority` 不修改，只用于串行化同一 SQLite
connection 上的调用。

### 2. `BEGIN IMMEDIATE` 是检查与写入的共同边界

一次 `admit(plan)` 按固定顺序执行：

1. 在进入事务前严格 normalize plan 并生成 deterministic admission bundle；
2. `BEGIN IMMEDIATE` 后优先按 `planId` 检查 durable exact replay；
3. 复验 automation head、active publication、active install/head、lifecycle
   disposition 与 exact installation/lock quarantine absence；
4. 复算 Workflow definition digest，并逐 Step 比对 publication DAG 和 materialized
   revision 中 enabled Task 的 source digest；
5. 原子插入一个 runtime-owned running Run、`workflow.admitted`、全部 StepRun、
   `step.created`、StepRunMutation、admission/step ledger 与 receipt；
6. 任一 identity collision、Task/publication drift、guard false、约束或写入失败均
   `ROLLBACK`，不存在部分 Run artifact。

SQLite 的 `BEGIN IMMEDIATE` 在 guard 检查前取得 write reservation，因此另一个连接
不能在检查与提交之间提交 quarantine/lifecycle/publication head 切换。事务不在锁内
执行网络、文件、Executor 或用户回调。

### 3. exact replay 先于当前状态复验

已存在的 exact plan 直接检查完整 durable evidence 并返回原 receipt，即使 Package
后来被正常退役或安全隔离，也不重新生成 ID、不重新规划、不创建第二个 Run。相同
`planId` 绑定不同 plan，或 Run/StepRun/event/mutation/receipt 任一 identity 被其他
事实占用时返回 conflict。

这一区分保证 COMMIT response loss 可以只 inspect/replay durable winner，同时新的
plan 仍受最新安全 guard 拒绝。

### 4. v41 schema 保存可独立审计的投影

`0081-plugin-package-workflow-admissions` 新增两张表：

- `QingLong3PluginPackageWorkflowAdmissions`：绑定 plan、Run、Package target、
  publication、Workflow digest、最终 Run fence 与 receipt；
- `QingLong3PluginPackageWorkflowAdmissionSteps`：逐 Step 绑定 Task definition、
  needs、StepRun、mutation 和 event identity。

表通过 FK、unique index、bounded JSON、mirror check 与 readiness cross-check 绑定
既有 Runs、StepRuns、RunEvents、StepRunMutations 和 automation publication。
`0082-capability-v41` 把 `local-control-core` 推进至 v41，并增加
`plugin_package_workflow_admission:1`。Compose image label、preflight、rollout、
OCI 与 physical Edge evidence 同步只接受 v41，避免旧 writer 与新 schema 混跑。

### 5. 这不是 Workflow executor

当前 authority 只把不可变 DAG 展开为 durable Run/StepRun 初态。它不推进 dependency
frontier、不创建 Attempt、不调用 Executor、不聚合终态，也不开放 API/CLI/UI。
下一切片必须以 caller-driven、有界页推进 ready frontier；Edge 默认仍不得为每个
Workflow 创建常驻 timer。

## 不采用方案

### 串联通用 RunRepository 与 StepRunRepository

拒绝。每个 repository 各自提交会产生半展开 DAG，且无法把 start guard 与所有写入
绑定为同一原子决定。

### exact replay 时再次要求 Package 当前 active

拒绝。会把已提交 winner 误判成失败，使 COMMIT response loss 在后续 quarantine 后
无法收敛；安全事实应阻止新 plan，不应抹去既有 receipt。

### 新建 workflow-storage package

拒绝。该 authority 与 SQLite schema、事务和 deployment contract 同生共死，没有
独立部署、权限进程、重依赖或 Profile 替换价值，另拆只会恢复 D-207 已消除的碎片化。

### 在准入事务里启动 Task

拒绝。外部副作用不能由 SQLite transaction 回滚，且会把数据库写锁持有时间扩大到
不可控；Task Attempt 必须在 durable StepRun ready 之后经过既有 start barrier。

## 当前验证

1. runtime-core 6/6：deterministic bundle、顺序 fence、receipt round-trip 与篡改拒绝；
2. SQLite repository 5/5：原子创建、exact replay、非 active guard、Run identity
   collision 全回滚、Task drift 与 durable evidence corruption fail closed；
3. 含真实 2-Step admission 的 v41 readiness/foreign-key/integrity audit 通过；
4. typed Drizzle schema 与 executable migration 的 table、column、index、check、FK
   contract 一致；
5. runtime-core 完整 394/394 通过；
6. Edge `DELETE/FULL` 与 Standalone `WAL/FULL` 共 16 个真实子进程 `SIGKILL`
   窗口通过：14 个 COMMIT 前窗口恢复后零部分事实并重放 `created`，2 个 COMMIT 后
   窗口只重放 `existing`；readiness、integrity、foreign-key 全绿；
7. workspace 保持 20 个 package，未修改共享 operation authority，未新增依赖或常驻
   资源。

## 尚未关闭

1. PostgreSQL 等价单事务 admission、最小权限函数与 HA promotion/rewind；
2. SQLite 真实断电与固定 Edge 写放大/资源预算；
3. 有界 ready-frontier、Attempt 启动、terminal aggregation、取消、超时与恢复；
4. 产品级强认证/Policy/API/CLI/UI；
5. Model、Tool、Approval、Subworkflow、Prompt 与 Secret/Artifact binding。
