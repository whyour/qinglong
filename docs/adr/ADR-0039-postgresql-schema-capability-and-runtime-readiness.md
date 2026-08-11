# ADR-0039：PostgreSQL Schema Capability 与 Runtime Readiness

- 状态：Proposed
- 日期：2026-07-19
- 关联：QL-RFC-0001、ADR-0037、ADR-0038

## 上下文

数据库连接成功只能证明网络、认证和一个 session 可用，不能证明当前 cluster-control 副本可以安全处理 Run。以下状态都必须阻止 ready：

- PostgreSQL 版本不在支持范围；
- 数据库 history 来自更新代码、存在 gap、checksum 或 dialect 漂移；
- migration 已部分执行，但 schema capability 尚未推进；
- 表、列或关键索引缺失；
- 同名对象被手工修改或第三方对象混入 QingLong 核心 schema；
- runtime role 是表 owner、拥有 schema CREATE/DDL，或缺少业务所需 DML；
- runtime role 可以修改 migration history、schema capability 或 immutable RunEvent。

如果 readiness 只检查 `SELECT 1`，旧 pod 可能在滚动升级期间处理新 schema，未迁移 pod 可能开始 claim，过度授权 runtime 凭据也会长期进入常驻服务。

## 决策

### 1. Readiness 是有顺序的 fail-closed capability gate

cluster-control 在创建 Repository、启动 dispatcher/reconciler 或开放 admission 前，必须依次只读验证：

1. PostgreSQL `server_version_num` 和稳定 runtime User；
2. 完整 `postgresql-main` history；
3. `control-core` schema capability；
4. `ql3` schema 的表、列和关键索引；
5. runtime role 的 schema/table privilege 与 ownership。

任一步查询失败、结果行数不确定、类型不符合或内容漂移都保持 not-ready。auditor 不执行修复、DDL、GRANT、migration 或外部副作用。

### 2. History 必须是当前代码的完整前缀

readiness 与 migration runner 复用同一个纯 history auditor：

- ID 必须属于当前 `pg-*` stream；
- 已应用集合必须是代码 migration 列表的连续前缀；
- stream、dialect、ID、64 位 SHA-256 和非负 safe-integer 时间全部精确；
- 未知 ahead ID、gap、重复记录或 checksum mismatch 都不允许 ready。

不允许只比较最后一个 migration ID，也不允许因数据库“比代码新”而继续运行旧 pod。

### 3. Capability 只代表完整 vertical slice

历史首个 capability v1 固定为：

```json
{
  "contract_name": "control-core",
  "contract_version": 1,
  "migration_id": "pg-0002-run-core",
  "capabilities": { "run_core": 1 }
}
```

capability 对 migration history 使用 deferred FK。`pg-0002` 的全部 DDL、capability update 和 history insert 在同一事务成功后，commit 才能通过。字段缺失、额外 capability key、版本或 migration ID 不一致均不允许 ready。

ADR-0041 的 `pg-0003-run-retry-policy` 补齐完整 RunRepository 所需的 RetryPolicy 后，当前 capability 精确推进为 v2：

```json
{
  "contract_name": "control-core",
  "contract_version": 2,
  "migration_id": "pg-0003-run-retry-policy",
  "capabilities": { "run_core": 1, "run_retry_policy": 1 }
}
```

`pg-0003` 只接受精确 v1 前置状态；推进失败时新表、索引、capability 和 history 同事务回滚。

### 4. `ql3` 是严格拥有的核心 schema

当前 contract version 2 精确拥有：

- `schema_migrations`
- `schema_capabilities`
- `runs`
- `run_attempts`
- `run_events`
- `run_retry_policies`

这些表的 required columns 和关键索引由 typed schema contract 固定。缺失或额外表/列/索引均视为 drift。插件、运维工具和未来独立模块必须使用自己的 schema 或经新 migration/contract version 纳入，不能向 `ql3` 静默加对象。

### 5. Runtime role 使用精确的最小权限

runtime role 必须：

- 对 `ql3` 有 `USAGE`、没有 `CREATE`；
- 不是任何核心表 owner；
- 对 history/capability 只有 `SELECT`；
- 对 Run/Attempt 有 `SELECT/INSERT/UPDATE`，没有 `DELETE`；
- 对 RunRetryPolicy 有 `SELECT/INSERT/UPDATE`，没有 `DELETE`；
- 对 immutable RunEvent 有 `SELECT/INSERT`，没有 `UPDATE/DELETE`。

权限比要求少会导致运行时中途失败；权限比要求多也会 readiness 失败。migration role 由独立 Job 使用，不作为常驻 runtime 凭据。

### 6. 失败事实必须低敏且稳定

readiness error 只暴露稳定 code 和 bounded finding，例如：

- `server_version_unsupported`
- `migration_history_invalid`
- `capability_invalid`
- `schema_contract_invalid`
- `runtime_role_invalid`

不得输出连接 URI、口令、SQL 参数、Run payload 或 Secret。数据库连接/查询错误由外层映射为 unavailable，不从错误推导 migration 或副作用结果。

## 当前孵化状态

`next` 已实现 driver-neutral `assertPostgresSchemaReady()` 和 contract v2：

- 支持 PostgreSQL 16–18；
- 复用 migration core 的 ahead/gap/checksum 审计；
- 精确验证 capability、6 张表、columns、18 个索引、39 个命名 CHECK 和 7 个命名 FK；
- 精确验证 schema CREATE、table owner 和六张表的 DML 矩阵；
- SQL contract 与 reviewed `pg-0001/0002/0003` migration 有静态 lockstep test；
- fake-query tests 覆盖成功、版本过低、capability 漂移、未知对象/约束和过度授权 role。

auditor 已绑定 `@qinglong/cluster-postgres` 的真实 lazy `pg.Pool` integration，并在独立 migration/runtime role 下执行完整 history、catalog 与权限 readiness；该测试已进入 PostgreSQL 16/18 × x64/arm64 CI matrix。ADR-0045 的 HTTP application host 已把 `/readyz` 绑定到本次 activation：catalog/recovery/lifecycle 未全部完成时固定返回 503，完成后才与 `/api/v3` admission 一起切换。远端 PostgreSQL 矩阵成功证据、认证业务 router 和 Kubernetes 部署实测尚未完成，因此 cluster-control 仍不可发布为 ready。

runtime readiness 现在使用 metadata-only migration manifest 审计 ID/checksum，不加载 `pg-*` DDL/up 模块；manifest 与 executable stream 由精确 lockstep test 约束。该拆分隔离常驻 runtime 与 migration role 的代码入口，但不改变完整 history fail-closed 语义。

## 影响

正面影响：

- 滚动升级和 downgrade 不会让不兼容 pod 接受流量；
- migration 完成与业务 capability 可分别证明；
- 最小权限成为可执行发布门禁，不只是一段运维文档；
- 插件和第三方对象不会静默污染核心 schema。

代价与风险：

- 每次 contract version 变更都要同步 migration、manifest、GRANT 和 readiness test；
- 对额外对象严格失败要求插件使用独立 schema；
- 云数据库权限模型差异需要在支持矩阵内逐个验证；
- readiness 查询必须有 timeout 和缓存/节流，不能在每个 HTTP 请求重复执行 catalog 扫描。

## 未选择的方案

1. **只执行 `SELECT 1`**：不能证明 schema 或权限，拒绝。
2. **只比较最后 migration ID**：无法发现 gap、checksum 和 dialect 漂移，拒绝。
3. **发现 drift 自动运行 migration**：runtime/migration 角色混权，拒绝。
4. **忽略未知 `ql3` 对象**：无法区分插件对象、手工 drift 和 ahead schema，拒绝。
5. **runtime 使用 owner/superuser**：破坏最小权限和 blast-radius 边界，拒绝。
6. **readiness 失败后回退 SQLite**：会形成双事实源，拒绝。

## 验证要求

- PostgreSQL 16/18 上 success report 与 catalog 事实一致；
- 15/19/未知未来 major 均 fail closed；
- ahead、gap、checksum、stream、dialect 和 history 类型损坏均 not-ready；
- capability/history 任一事务回滚后 contract version 不推进；
- 任一 required table/column/index 缺失或额外对象出现均 not-ready；
- runtime role 多一个或少一个 privilege 都 not-ready；
- migration role 可以迁移但不能被 runtime entrypoint 接受；
- auditor query timeout、连接失败和 failover 均保持 not-ready，恢复后可重新收敛；
- readiness 成功前没有 Repository admission、dispatcher timer、claim 或用户副作用。
