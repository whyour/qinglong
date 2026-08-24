# ADR-0495：无敏感内容的 Cluster Legacy Env 迁移计划账本

- 状态：Accepted
- 日期：2026-08-24
- 决策：D-400
- 关联：ADR-0104、ADR-0233、ADR-0259、ADR-0491、ADR-0494

> 2026-08-24：ADR-0497/D-402 已完成本 ADR 所列的下一切片：在同一 Automation Manager
> SERIALIZABLE transaction 中复验并迁移 Task/Trigger，重置 schedule fence，并写入逐项
> content-free receipt。本 ADR 的 plan ledger 决策保持不变。

## 背景

ADR-0491 已完成 Local SQLite 上的 Legacy Env 检查、人工裁决、Secret application、
Task/Trigger revision mutation、回滚和 completion；ADR-0494 又证明了 Cluster
`mounted-files` provider 的在线轮换。Cluster 仍缺少一个独立于 Local SQLite/POSIX
authority 的持久计划边界，无法在真正写 Secret、Task 或 Trigger 之前冻结源证据、目标
revision 集合和幂等 mutation 身份。

该边界不能把 2.x `Envs` 的名称、值、行内容搬进 PostgreSQL，也不能为了“先跑起来”
让 runtime、admin 或通用 root export 取得迁移写权限。小型路由设备不应安装或加载本
Cluster 能力；集群侧也必须有明确的行数、Task、Trigger 和有效载荷预算。

## 决策

### 1. 账本只保存不可逆摘要、计数和目标引用

新增 profile-neutral `qinglong/cluster-legacy-env-migration-plan@v1`。计划只包含：

- plan、mutation、Project 身份；
- reconciliation bundle、reviewed decision、candidate set 三个 SHA-256 摘要；
- source/active/disabled/effective binding 计数；
- 同 Project、精确固定 version 的 canonical `SecretRef`；
- Task 与 Trigger revision set 摘要和计数；
- effective Secret 总字节数、数据库计划时间和 plan digest。

它不得包含源 Env 名称/值、row body、目标 plaintext/ciphertext、key ID、credential、
Task spec、Trigger spec 或迁移日志。`SecretRef` 是既有目标路由引用，不是源 Env 名称；
其 payload 仍受 canonical encoding、同 Project 和固定 version 校验。

硬上限为 100,000 个源行、100,000 个 Task、500,000 个 Trigger、64 KiB effective
Secret 和 8 KiB plan JSON。active/disabled/source 计数必须守恒，至少存在一个 active
行、effective binding 和 Task。

### 2. PostgreSQL 只提供 append-only v69 计划表

`pg-0070-cluster-legacy-env-migration-plans` 将 control contract 推进到 v69，并新增
`cluster_legacy_env_migration_plans`：

- `plan_id` 为主键，`mutation_id` 与 `plan_digest` 各自唯一；
- Project 外键使用 `ON DELETE/UPDATE RESTRICT`；
- identity、digest、source、target、time、JSON 六组 named constraints；
- `plan_json` 必须与列值构造出的完整 canonical JSONB **精确相等**，不是包含关系，
  因而任何额外 Env 字段也会被数据库拒绝；
- 不提供 UPDATE、DELETE、TRUNCATE 或后台 GC。

迁移能力值新增 `cluster_legacy_env_migration_plan: 1`。Drizzle schema、readiness
contract、固定 migration checksum 和实际 SQL stream 必须保持同锁步。

### 3. 只有 Automation Manager 可以读取和追加

新表从 PUBLIC 撤销全部权限，只向 `ql3_automation_manager` 授予 `SELECT, INSERT`。
runtime、admin、Worker ingress、Approval/Run/Package/Worker Credential 等其他角色均为
零权限；migration owner 只用于 schema 管理与集成验证。

具体 repository 只由
`@qinglong/cluster-postgres/cluster-legacy-env-migration-plan` 显式子路径发布，不进入
package root、runtime 或 admin entrypoint。runtime-core 也只通过
`@qinglong/runtime-core/cluster-legacy-env-migration-plan` 发布数据契约。

### 4. 发布使用数据库时间、SERIALIZABLE 和精确重放

repository 每次使用一个短 `SERIALIZABLE` transaction，设置 statement、lock 和 idle
transaction timeout；先按 `mutation_id` 查 exact replay，再验证 Project 在该可序列化
快照中为 active，使用 `transaction_timestamp()` 生成 `plannedAtMs`，最后追加计划。

相同 mutation 与相同 intent 返回 durable `existing`；mutation drift、plan identity
占用、inactive Project 和 named constraint 冲突失败关闭。`40001`、`40P01`、`55P03`
最多重试三次。可选 transaction hook 只用于后续在**同一 Automation Manager 事务**中
追加 Task/Trigger revision mutation；本 ADR 不调用它来声称那些 mutation 已实现。

Project 检查使用普通 SERIALIZABLE read，而不是 `FOR SHARE`。后者在 PostgreSQL 中还
要求 UPDATE privilege，会错误扩大 Automation Manager 权限；可序列化顺序与外键已足以
表达“计划发生在并发归档之前”的合法历史。

### 5. 不扩大 Edge/Standalone 闭包

实现复用既有 `runtime-core` 与 `cluster-postgres` package，不新增 workspace package、
生产依赖、daemon、timer、watcher、controller 或缓存全集。Edge/Standalone 不导入
PostgreSQL repository 或 migration；计数上限是 Cluster 计划输入预算，不是把集群表或
Task 集合加载进小型设备。

## 被拒绝的替代方案

### 在 PostgreSQL 保存 Env 名称、值、密文或 key ID

拒绝。密文仍会扩大 custody、rotation、backup 和 HA 泄漏面；计划账本只需要摘要和目标
引用即可证明后续 mutation 的输入身份。

### 在同一切片直接改写全部 Task/Trigger head

拒绝。计划发布和实际 DML 是两个可独立审计的 authority 阶段。没有 current-head
revalidation、逐项 mutation receipt 与完整 response-loss 测试前，不得把 plan 冒充迁移。

### 复用 Local SQLite 或 Plugin Package Secret Binding 表

拒绝。Local authority 不属于 Cluster；Plugin Package binding 的 installation/generation
身份也不能表达 Legacy Env reconciliation bundle、disabled preservation 和 Task/Trigger
revision set。

### 为一个 contract 和一个 repository 新建 package

拒绝。它们分别属于既有 runtime migration contract 与 Cluster reconciliation storage
能力，新增微包会再次制造用户已经指出的单文件 package 问题。

## 当前验证

2026-08-24 已完成：

- runtime contract 定向测试 4/4；
- PostgreSQL repository 定向测试 5/5；
- `@qinglong/runtime-core` 与 `@qinglong/cluster-postgres` 完整 package 测试零失败；
- PostgreSQL migration/schema/readiness/entrypoint 定向门 92/92；
- 真实 PostgreSQL 18.4 应用 70 条 migration 成功；
- 实际 automation-manager create/replay/read 成功，UPDATE 被 `42501` 拒绝；
- 实际 runtime/admin SELECT 被 `42501` 拒绝；
- 带源 `envName` 的 widened JSON 被
  `ql3_cluster_legacy_env_plan_json_check` 以 `23514` 拒绝。

## 边界与后续门禁

本 ADR 关闭 ADR-0491 的 **Cluster plan ledger baseline**，但不把 ADR-0491 整体转为
Accepted，也不声明：

1. Legacy source scan、sealed bundle 或 signed decision 已在 Cluster 中生产装配；
2. Task/Trigger current head 已逐项复验或 revision mutation 已提交；
3. Secret material 已写入 Kubernetes/Vault/KMS/HSM；
4. migration Job、短期身份、receipt 与 promotion 后 exact replay 已完成；
5. PostgreSQL physical failover、CloudNativePG promotion 或多架构结果已由本切片重新证明；
6. 固定低性能路由设备的空间、写放大、断电和恢复证据已完成。

下一切片应在 Automation Manager 同一事务内绑定 current Task/Trigger revision set、逐项
mutation 与 receipt，同时保持计划表 append-only；随后再接入外部 custody 和 HA promotion
后的 exact replay。任何一步都不能回写源 Env 明文或放宽其他数据库角色。
