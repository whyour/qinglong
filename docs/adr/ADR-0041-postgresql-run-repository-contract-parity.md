# ADR-0041：PostgreSQL Run Repository 契约对等

- 状态：Proposed
- 日期：2026-07-19
- 关联：QL-RFC-0001、ADR-0001、ADR-0037、ADR-0038、ADR-0039、ADR-0040

## 上下文

`pg-0002-run-core` 建立了 Run、RunAttempt 和 RunEvent，但应用层 `RunRepository` 还要求 durable RunRetryPolicy：

- 随 Run admission 保存重试安全声明；
- 按 version compare-and-set 推进下一次重试时间；
- 在控制面重启后继续判断 lost retry；
- 与 Run/Attempt/Event 处于同一数据库事务边界。

如果 PostgreSQL adapter 省略 RetryPolicy，cluster-control 只能实现一个缩小版 Repository。上层 service 会被迫按方言分叉，或在内存中保存唯一重试事实，两者都违反跨 Profile 的 Runtime Kernel 和数据库事实源不变量。

另一个差异是 SQLite 兼容 contract 默认构造 `execution_owner=legacy`，而 PostgreSQL cluster schema 正确地只允许 `runtime`。为了让 contract 真正跨方言，测试数据必须参数化 owner，不能放宽 cluster 约束。

## 决策

### 1. `control-core` v2 表示完整首版 RunRepository 存储能力

新增不可变 migration `pg-0003-run-retry-policy`，在同一 migration 事务中：

1. 创建 `ql3.run_retry_policies`；
2. 创建有界 due index 和 Run lost-retry index；
3. 只允许从精确的 `control-core` v1 推进到 v2；
4. 写入 capability：

```json
{
  "contract_name": "control-core",
  "contract_version": 2,
  "migration_id": "pg-0003-run-retry-policy",
  "capabilities": {
    "run_core": 1,
    "run_retry_policy": 1
  }
}
```

若 v1 capability 的 version、migration ID 或 JSON 能力不精确匹配，migration 必须失败并回滚。不得修改 `pg-0001/0002` 的 SQL 或 checksum。

### 2. RetryPolicy 与领域约束保持一致

PostgreSQL 表固定保存：

- `max_attempts` 1–16；
- `retry_on_lost`；
- `unknown/idempotent/deduplicated` safety；
- 0–86400000 ms 且 max 不小于 base 的 backoff；
- nullable、非负的 `next_attempt_at_ms`；
- version、created/updated 时间与 Run 外键。

删除 Run 时 RetryPolicy 可级联删除；runtime role 对该表只有 `SELECT/INSERT/UPDATE`，没有 `DELETE`，常驻进程也不是 owner。

### 3. 公共端口不直接依赖 `pg`

`@qinglong/runtime-core` 提供 driver-neutral `PostgresPool/Client/Queryable` 结构接口、Run domain、Repository port 和稳定错误契约。独立 `@qinglong/cluster-postgres` 同时拥有 PostgreSQL SQL adapter 与真实 `pg.Pool` binding；公共 core 不含 SQL、driver 或具体 Profile。

因此：

- edge/standalone 根 importer 不安装或加载 `pg`；
- Repository SQL、row codec 和事务边界在 cluster adapter 内评审，稳定错误与端口语义由 runtime-core 定义；
- driver connection、TLS、pool sizing、type parser 和 shutdown 属于 cluster package。

### 4. 每次业务事务使用一个 client

`transaction(work)` 必须：

1. 从 Pool 取得一个 client；
2. `BEGIN` 并使用 `READ COMMITTED`；
3. 设置 transaction-local statement、lock 和 idle-transaction timeout；
4. 在同一 client 上完成全部 Repository work；
5. `COMMIT`，失败时 best-effort `ROLLBACK`；
6. 始终 release client。

work callback 抛出的业务错误必须原样返回；BEGIN/config/COMMIT 的 driver 错误映射为稳定 Repository error。不能在一个事务中混用 `pool.query()` 与 transaction client。

### 5. CAS、bigint 和唯一错误 fail closed

- Run CAS 精确匹配 `id + expected version`，新 version 必须恰好加一；
- Attempt CAS 精确匹配 `id + status + callback_sequence`；
- RetryPolicy CAS 精确匹配 `run_id + expected version`，新 version 必须恰好加一；
- affected rows 只能是 0 或 1，多行视为存储损坏；
- PostgreSQL bigint string 只能转换为 safe integer，越界或非法值不得静默截断；
- RunEvent JSON 必须是 object，序列化后仍受 16 KiB 上限；
- 只将已知 idempotency、Attempt number、Event sequence/dedupe constraint 映射为稳定 duplicate error；其他 SQLSTATE 23 归为 constraint error；serialization/deadlock/lock/connection shutdown 归为 retryable busy。

### 6. 共享 contract 必须覆盖完整端口

RunRepository contract 至少验证：

- Run/Attempt/Event 原子写入与失败回滚；
- Run/Attempt CAS；
- RetryPolicy insert/read/version CAS；
- 稳定 duplicate error；
- 有界 Event 与 cancellation recovery page；
- oversized payload 在 SQL 前拒绝。

contract 接受 `defaultExecutionOwner`：SQLite 兼容 adapter 使用 `legacy`，PostgreSQL 使用 `runtime`。不得建立删减 PostgreSQL 专属 contract 来规避端口能力。

## 当前孵化状态

`next` 已具备：

- `pg-0003-run-retry-policy`、`control-core` v2、6 表/18 索引严格 schema contract；
- readiness 对 capability v2、RetryPolicy 表和最小权限矩阵的检查；
- 本机一次性 PostgreSQL 13 对三条 migration、deferred history/capability 和最终表集合的真实 DDL/事务 smoke；
- 本机 PostgreSQL 服务端已对 Repository 生成的 13 条参数化读写/CAS SQL 执行 `PREPARE`，验证占位符和参数类型推断；该检查曾发现并推动 `pg-0003` 增量补齐 `runs.legacy_cron_id`；
- 独立 `@qinglong/runtime-core` 的 Run domain、RetryPolicy、Repository port 和稳定错误契约；
- 独立 `@qinglong/cluster-postgres` 的 PostgreSQL Run Repository、lazy `openDatabase()` 与 package-local fake-client tests；
- 独立 `@qinglong/cluster-control` 组合根已把 readiness、真实 Repository 创建、activation 与 Pool close ownership 串联；
- transaction/CAS/row codec/SQLSTATE/payload 的 fake-client 测试；
- 扩展后的 SQLite RunRepository contract，首次真实覆盖 RetryPolicy。

共享 contract 允许每个 adapter 注入自己的错误 constructor/常量，避免 legacy 根兼容副本与 runtime-core package 因 JavaScript class identity 不同而产生伪失败；默认仍保持 SQLite legacy contract 不变。独立 `@qinglong/cluster-postgres` 已在本机 PostgreSQL 13 上用真实 driver 运行完整共享 Repository contract 和 migration/runtime 双角色权限验证；PostgreSQL 16/18 × x64/arm64 matrix 已接入 CI。远端矩阵成功证据、双连接竞争/failover 和完整 production control-plane stack 仍未完成，因此 cluster-control 继续保持 production unreachable。

## 影响

正面影响：

- cluster-control 不需要缩小版 Repository 或内存 RetryPolicy；
- SQLite/PostgreSQL 共享同一应用层事务和 CAS 语义；
- bigint 与 driver error 不泄漏为不稳定平台行为；
- edge 依赖隔离不因 PostgreSQL adapter 进入核心源码而失效。

代价与风险：

- SQL row codec 字段较多，schema、migration 和 contract 必须保持 lockstep；
- fake client 只能证明编排和映射，不能替代真实 PostgreSQL 并发语义；
- READ COMMITTED 下的正确性依赖所有状态写继续使用显式 CAS；
- concrete Pool 必须配置连接级 read timeout/type parser/shutdown，并接受 PostgreSQL 16/18 矩阵验证。

## 未选择的方案

1. **PostgreSQL 暂不保存 RetryPolicy**：破坏端口和恢复事实源，拒绝。
2. **放宽 cluster execution owner 为 legacy**：把 2.x 兼容 ownership 带入集群，拒绝。
3. **在核心根包直接依赖 `pg`**：破坏 edge 安装隔离，拒绝。
4. **所有 bigint 直接 `Number()`**：可能静默丢精度，拒绝。
5. **所有 23505 都映射为同一种 duplicate**：掩盖主键或未知约束损坏，拒绝。
6. **用 SERIALIZABLE 代替所有 CAS**：增加重试成本且不能替代领域 version/fencing，拒绝。

## 验证要求

- `pg-0001/0002` checksum 不变，v1 数据库只能由 `pg-0003` 推进到 v2；
- capability 漂移时 `pg-0003` 全事务回滚且不留下 RetryPolicy 表/history；
- schema readiness 精确验证 6 表、18 索引、39 个 CHECK、7 个 FK 和六表权限矩阵；
- SQLite 与 PostgreSQL 均运行同一完整 RunRepository contract；
- PostgreSQL 16/18 上验证 transaction rollback、Run/Attempt/RetryPolicy CAS 和 duplicate mapping；
- 两个 Pool client 竞争时只有一个 CAS 获胜；
- statement/lock/idle timeout 和 serialization/deadlock 映射为 bounded retryable error；
- bigint 越界、非法 enum、非 object JSON 和多行 identity 结果全部 fail closed；
- edge import/tarball/SBOM 审计继续证明未包含 `pg`/Drizzle/cluster package。
