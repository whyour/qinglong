# ADR-0225：PostgreSQL Serializable Plugin Package Workflow 准入

- 状态：Proposed
- 日期：2026-07-30
- 关联 RFC：QL-RFC-0001 D-03、D-12、D-144、D-207、D-212
- 关联 ADR：ADR-0156、ADR-0158、ADR-0222、ADR-0223、ADR-0224

## 背景

SQLite v41 已证明 generation-bound Workflow plan 可以在一个 `BEGIN IMMEDIATE`
事务中原子展开。Cluster 不能简单把这个实现翻译成若干 PostgreSQL autocommit：
automation start guard 中的 publisher signer advisory lock、publication/install/
lifecycle 行锁、quarantine/revocation absence 判断，以及 Run/StepRun 写入必须属于同一
transaction。否则安全事实仍可能穿越检查与提交。

跨方言审计还发现 runtime admission 原先生成约 64 字节 RunEvent ID，而 PostgreSQL
`run_events.id` 为 `varchar(36)`；plan 的 Run ID 也曾允许 128 字节。公共契约现已
收紧为最多 36 字节 Run ID，并生成最多 36 字节 admission/Step RunEvent ID；
StepRun/mutation identity 继续允许 128 字节。这样无需扩大既有 Run 外键闭包。

## 决策

### 1. 使用同一 SERIALIZABLE transaction

Cluster adapter 必须在一个专用 connection 上执行：

1. `BEGIN ISOLATION LEVEL SERIALIZABLE`；
2. durable exact replay lookup；
3. 调用既有 `plugin_package_automation_start_allowed`；
4. 在事务内复验 exact publication Workflow 与 materialized Task source digest；
5. 原子写 Run、全部 StepRun、RunEvent、StepRunMutation、admission/step ledger；
6. `COMMIT`；serialization failure 作为可安全重试的 unavailable，不在内部无界重试。

现有 start guard 取得的 `pg_advisory_xact_lock` 与 `FOR SHARE` 锁会一直保持到该
transaction 结束。`SERIALIZABLE` 的 predicate conflict 负责拒绝 guard 后插入的
quarantine/revocation 等 phantom；不能降为默认 Read Committed。

### 2. runtime 只获得窄表权限

`pg-0045` 只向 `ql3_runtime` 授予 admission 两表的 `SELECT, INSERT`，以及既有
Run/StepRun execution 写权限；不向 runtime 开放 quarantine、publisher receipt 或
lifecycle mutation。manager、package-manager、package-executor、worker-ingress 不得
写 admission ledger。

### 3. exact replay 先于 current guard

与 SQLite 相同，已提交 exact plan 必须返回原 receipt，即使 Package 后来 withdrawn
或 quarantined。新的 plan 才检查 current guard。相同 planId/runId/receipt/StepRun/
event/mutation identity 绑定不同内容时 conflict；COMMIT response loss 只能 inspect
durable winner。

admission ledger 对 runtime 是 append-only（仅 `SELECT, INSERT`）；重放读取不得使用
`FOR UPDATE/FOR SHARE`，否则 PostgreSQL 会要求 `UPDATE` 权限。并发竞争由
`SERIALIZABLE`、唯一约束和事务级 start guard fence 收敛，不为不可变行扩大权限。

### 4. 不在事务内执行外部副作用

admission 只展开 durable DAG，不创建 Attempt、不 claim Worker、不调用 Executor。
后续 caller-driven frontier 在新事务中推进 ready Step，避免长事务、连接占用和锁
等待随 Task 执行时间增长。

## 接受门

1. `pg-0045` schema、capability、checksum、权限与 readiness；
2. mocked repository contract 与真实 PostgreSQL exact replay/collision/guard/
   serialization rollback；
3. runtime 角色可准入但不能直接读取安全 receipt 或调用管理 mutation；
4. PostgreSQL 18 physical streaming HA 下 admission ledger、Run/StepRun 和 receipt
   经 `remote_apply`、promotion、旧主 fencing、`pg_rewind`、fresh replicas 保持；
5. 无 image pull 的 HA 重跑，且不新增 package、依赖、daemon/timer/watcher。

## 当前验证

1. `pg-0045` 已把 control-core 推进至 v44，并增加两张 admission ledger、受审
   snapshot function、显式约束/索引、Drizzle schema、manifest/checksum 与六角色
   readiness；
2. PostgreSQL repository 使用同一 connection 的 `SERIALIZABLE` transaction，完整
   durable evidence exact replay 优先于 mutable guard；mock 与 package 全量为
   217 pass、1 条无测试 URL 条件 skip；
3. runtime 对新表只有 `SELECT, INSERT`，真实故障注入进一步证明 replay 读取不能使用
   `FOR SHARE`；manager/admin/package-executor/worker-ingress 无该 authority；
4. PostgreSQL 18.4 arm64 physical HA 在
   `QL3_HA_SKIP_IMAGE_PULL=true` 下完整通过：admission、2 个 StepRun、Event/mutation
   与 receipt 经 `remote_apply`、timeline 1→2、旧主 fencing、promotion、
   `pg_rewind` 和 fresh replicas 保持；
5. Workflow admission 的 atomic、exact replay、publisher revocation fence、
   runtime-only 与 survives-promotion 五项 gate 以及总 `passed` 均为 true；
6. 后续 frontier 边界见 ADR-0226。
