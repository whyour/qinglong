# ADR-0158：同事务 Tool Execution Start Barrier

- 状态：Accepted
- 日期：2026-07-26
- 关联：ADR-0032、ADR-0133、ADR-0154、ADR-0155、ADR-0156、ADR-0157；
  RFC D-03/D-29/D-30/D-131/D-148/D-149

## 背景

ADR-0155 已建立 snapshot-bound handler binding 和 fresh Policy admission；
ADR-0156 已建立双方言 StepRun aggregate、Run/Event fence 与 mutation ledger；
ADR-0157 已能原子保存 Trace、Audit 和 receipt。

但单独 `prepare(evidence)` 仍不是“允许 adapter 开始副作用”的证明。若 evidence 提交后、
StepRun CAS 前崩溃，数据库会留下允许审计，却没有 `running` 状态；若先把 StepRun 改为
`running` 再保存 evidence，则 adapter 或恢复器可能观察到一个没有 Trace/Audit 的已启动
步骤。多副本还可能使用相同 StepRun 发起两个不同调用，或者把一次失败后的重试误判为
第一次启动的重放。

启动授权必须把 immutable plan/admission、耐久 evidence、StepRun 状态变化、RunEvent、
mutation ledger 和可恢复的 barrier 收敛成一个数据库事务，同时保持低配路由器的单连接、
零常驻后台任务边界。

## 决策

### 1. 使用纯领域 command 和低敏 barrier record

`@qinglong/runtime-core/tool-execution-start-barrier` 是现有 `runtime-core` 的显式
subpath。它定义：

- `qinglong/tool-execution-start-command@v1`，canonical JSON 最大 64 KiB；
- `qinglong/tool-execution-start-barrier@v1`，canonical JSON 最大 16 KiB；
- domain-separated `commandDigest` 与 `barrierDigest`；
- `ToolExecutionStartBarrierRepository` 的 `prepare`、按 `startId` 查询和按
  `(runId, stepRunId, startedStepRunVersion)` 查询。

command 必须精确绑定：

1. Project、current snapshot、Tool Definition 和 trusted handler binding；
2. action/plan/admission digest、Profile、execution class、timeout 和 Policy fence；
3. reviewed adapter、redaction contract、audit contract 的 identity 与 digest；
4. 可选的 exact approval request/dispatch/digest；
5. 同 Project、同 Run 的 Tool StepRun；
6. Trace anchor、Audit event 与 Audit receipt；
7. `ready` 或 `waiting_approval` 到 `running` 的 StepRun mutation 和对应 RunEvent。

admission、command 和 barrier 都不得携带 input、Secret、handler、函数、module path、
URL、execute seam、Tool output 或原始异常。

### 2. StepRun 必须先存在，barrier 只负责原子启动

产品编排先创建独立 StepRun，并把它推进到 `ready`；需要审批时则推进到
`waiting_approval` 并绑定 exact approval request。start barrier 不创建 StepRun，也不
负责解析 Workflow。

repository 在一个事务中按固定顺序执行：

1. 查找所有 start/replay identity，完全相同则返回 `existing`；
2. 锁定并复验 Run、StepRun、version、digest、状态、Definition 和 Project；
3. 插入 SecurityAuditEvent、Trace anchor 和 Audit receipt；
4. compare-and-set StepRun 为 `running`；
5. compare-and-set Run version/event sequence；
6. 插入 RunEvent 和 StepRun mutation ledger；
7. 插入 immutable start barrier；
8. commit 后才允许 composition 调用 adapter。

任一步失败必须回滚全部事实。mutation ledger 的 `committed_at_ms` 使用数据库事务时钟，
不能把调用方的业务事件时间冒充提交时间。

### 3. 重试 identity 必须包含已启动的 StepRun version

同一 `startId`、mutation、RunEvent、Trace、Audit 或
`(runId, stepRunId, startedStepRunVersion)` 只能绑定同一 barrier。完全相同的响应丢失
重放返回 `existing`；内容漂移返回 semantic conflict。

identity 不能只使用 `(runId, stepRunId)`。一个真实 adapter 在恢复后可能把
`lost → ready → running` 推进到下一次尝试；新的 StepRun version 必须能够拥有新的
barrier，同时历史启动事实保持不可覆盖。

### 4. SQLite 与 PostgreSQL 使用同一领域协议、不同事务机制

SQLite：

- `0055-tool-execution-start-barriers` 新增 `ToolExecutionStartBarriers`；
- `0056-capability-v28` 将 `local-control-core` 推进到 v28；
- repository 复用单一 `LocalSqliteOperationAuthority` 和 `BEGIN IMMEDIATE`；
- foreign key 把 barrier 绑定到 StepRun、mutation、RunEvent、Trace 和 Audit receipt；
- `committed_at_ms` 使用 SQLite 数据库时钟。

PostgreSQL：

- `pg-0030-tool-execution-start-barriers` 将 `control-core` 推进到 v29；
- `ql3.tool_execution_start_barriers` 只授予 `ql3_runtime`
  `SELECT, INSERT`，其他产品角色无权限；
- repository 使用短 `SERIALIZABLE` transaction、固定 statement/lock/idle timeout
  和最多三次可判定 retry；
- Run 与 StepRun 在 evidence 写入前一起 `FOR UPDATE`，CAS 失败回滚；
- `committed_at_ms` 使用 `transaction_timestamp()`。

两种方言读取时都重新执行领域规范化，并逐项核对 JSON、镜像列、mutation digest、
started StepRun digest、Trace digest 和 Audit receipt digest。损坏或多行 identity
必须失败关闭。

### 5. 不新增 workspace package

虽然协议跨越领域层和两种存储实现，但它没有独立部署、依赖或版本生命周期，因此：

- 纯领域协议留在 `ql3-runtime-core`；
- SQLite adapter 留在 `ql3-local-sqlite`；
- PostgreSQL adapter 留在 `ql3-cluster-postgres`；
- 三者只通过显式 `tool-execution-start-barrier` subpath 暴露；
- root、通用 runtime、admin、package executor 和 worker ingress 不重新导出 authority。

文件少不是拆包理由，真实部署/权限/依赖边界才是 package 边界。

### 6. barrier 仍不执行 adapter

本 ADR 只关闭“副作用开始前是否已经原子提交完整授权事实”的缺口。repository 没有调用
built-in、process、MCP、HTTP 或 Worker adapter。当前 Tool execution 仍保持
production unreachable，直到后续完成：

1. opaque/encrypted invocation plan 与 redacted preview Artifact；
2. adapter-specific start/result/recovery contract；
3. trusted composition 在观察 `created|existing` barrier 后调用 adapter；
4. post-start 不确定结果的 inspect/manual recovery；
5. receipt retention/compaction 与物理 Edge 资源证据。

## 低配与集群资源影响

- 不新增 package、第三方依赖、timer、watcher、socket、线程或常驻进程；
- Edge/standalone 继续复用一个 SQLite authority 和一次 `BEGIN IMMEDIATE`；
- Cluster 每次启动只使用一个有上限的短事务，不引入队列、Redis 或新控制副本；
- 每次启动新增一条 immutable barrier，并复用既有 Audit、Trace、RunEvent 和 mutation
  ledger；
- 唯一索引与 exact identity 提供常数级重放查找，历史尝试不被覆盖。

## 被否决方案

1. **evidence 提交后再单独更新 StepRun**：存在半提交窗口，拒绝。
2. **先更新 StepRun，再异步写 Trace/Audit**：允许观察到无证据的运行态，拒绝。
3. **用 RunEvent 代替独立 barrier**：无法完整绑定 admission、adapter contract 和
   evidence digest，拒绝。
4. **只以 StepRun ID 作为唯一启动 identity**：阻止合法的新 version 重试，拒绝。
5. **把调用方时间写入 `committed_at_ms`**：混淆业务时间与数据库提交观察，拒绝。
6. **在事务中直接调用 adapter**：把外部 I/O 放入数据库锁窗口且仍无法原子提交外部
   副作用，拒绝。
7. **为 barrier 新增 workspace package**：没有独立部署或依赖生命周期，拒绝。
8. **把 authority 从 cluster runtime/admin root 导出**：扩大可达性与数据库权限，
   拒绝。

## 验证

- runtime-core 完整测试：309/309；
- local-sqlite 完整测试：111/111，其中 start barrier repository 5/5；
- cluster-postgres package：166 pass、1 条件 skip，其中 start barrier repository
  4/4；
- 全新 PostgreSQL 18.4 arm64 六角色 integration：41 pass、1 条件 skip、0 fail；
- 真实 PostgreSQL 用例证明 migration v29、runtime 最小权限、同事务启动、exact replay、
  双查询入口和数据库提交时钟；
- PostgreSQL 18.4 arm64 physical HA：physical streaming、`remote_apply`、
  timeline 1→2、旧主 fencing、promotion、`pg_rewind`、同步复制恢复和两代双 control
  replica，`gates.passed=true`；
- 临时单实例与 HA Docker 资源均由 gate 清理。

## 后续门禁

1. 设计 invocation plan/preview Artifact 的加密、脱敏与 retention；
2. 实现第一类真实 built-in adapter 与 post-start recovery evidence；
3. 用产品 composition 串联 snapshot publication、StepRun、start barrier 和 adapter；
4. 增加 response-loss、进程崩溃、MCP/HTTP 超时和人工恢复实证；
5. 完成 physical Edge idle/fault/task-scale 门后再开放 production execution。
