# ADR-0104：PostgreSQL 不可变 Task、Trigger 与远端执行修订

- 状态：Accepted（migration、Repository、readiness、角色权限、摘要验证和 PostgreSQL 16 四角色 integration 已实现；PostgreSQL 18/failover 证据待完成）
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-06、D-17、D-34、D-35、D-36、D-41、D-85、D-88、D-90、D-91、D-92、D-93、D-103
- 关联 ADR：ADR-0037、ADR-0039、ADR-0043、ADR-0087、ADR-0091、ADR-0092、ADR-0093、ADR-0094

## 背景

Cluster-control 已有 PostgreSQL Run、Policy、Identity、Worker Session 与 Lease，但此前没有正式的 TaskDefinition/Trigger 权威，也没有能交给 remote Worker 的不可变执行修订。若 Scheduler 直接读取可变配置并临时拼接命令，Run 无法证明究竟执行了哪个定义；若把管理写权限留给常驻 runtime，HTTP 或调度漏洞又会升级为定义篡改。

本机已经证明 head + immutable revision、semantic registry、pinned digest 和 execution revision 的边界。Cluster 实现必须复用相同领域契约，但使用 PostgreSQL 的并发、角色和 migration 语义，不复制 SQLite 表名或 SQL。

## 决策

1. `pg-0012-task-trigger-definitions` 建立 `task_definitions`、`task_definition_revisions`、`triggers`、`trigger_revisions`，把 `control-core` 从 v10 推进到 v11。
2. `pg-0013-task-execution-revisions` 建立 `task_execution_revisions`，把 capability 推进到 v12，并声明 `cluster_execution_revision`。
3. TaskDefinition 与 Trigger 都使用 Project 内稳定 head、append-only revision、全局 mutation identity、expected-revision fence 和 domain-separated digest。Trigger revision 固定 `taskId/taskRevision/taskContentDigest`，不得在运行时解析 current Task。
4. enabled `qinglong/command@v1` Task 发布时，管理仓储在同一个 `SERIALIZABLE` transaction 写 Task revision 与 `remote_worker` execution revision。重放必须逐字段和逐摘要一致；缺行或损坏不得隐式修补。
5. Cluster execution revision 使用 `qltd:v1:<sourceRevision>:<sourceContentDigest>` identity，计划 schema 固定为 `qinglong/command-execution@v1`，内容摘要覆盖 Project、Task、source fence、executor、command、environment、working directory 和 timeout，但不覆盖创建时间。
6. 计划只保存 canonical Secret reference，不保存明文。`qlsecret:v1` 被提升为 Profile-neutral `runtime-core/secret-reference` 契约；原 local alias 保持字节兼容，避免数据迁移和 local/cluster 双 parser。
7. runtime subpath 只导出只读 `TaskDefinitionSource`、`TriggerSource` 与 digest-verifying `ClusterTaskExecutionRevisionSource`；admin subpath 才导出 publisher Repository。
8. PostgreSQL runtime role 对定义与执行修订只有 `SELECT`；admin role 可写 head/revision/execution；worker-ingress 对这些表保持零读写。readiness 对表、列、索引、CHECK、FK、capability 和精确角色权限一起 fail closed。

## Package 与部署影响

不新增 workspace package。Profile-neutral contract 放在既有 `@qinglong/runtime-core` 子入口，PostgreSQL adapter 放在既有 `@qinglong/cluster-postgres`，composition 位于既有 `@qinglong/cluster-control`/`cluster-admin`。Edge、Standalone 和路由器制品不导入 PostgreSQL adapter，也不会因该能力安装 `pg`、Drizzle 或集群 scheduler。

这遵守 D-85：模块或 use case 不是 package 的默认边界；只有独立部署、依赖、权限或供应链责任才值得拆包。

## 拒绝的方案

- Scheduler 读取 Task head 后临时生成 Worker payload：拒绝，因为 current head 会让历史 Run 失去稳定解释。
- 只保存 source digest、不保存 execution digest：拒绝，因为无法发现执行计划行的局部损坏。
- runtime 直接发布 Task/Trigger：拒绝，因为扩大常驻控制面的写 authority。
- 复用 SQLite migration identity 或建表 SQL：拒绝，因为破坏方言独立 history 与 PostgreSQL catalog 审查。
- 为 Task、Trigger、execution revision 各建一个 package：拒绝，因为它们没有独立部署或供应链边界。

## 验收证据

- PostgreSQL migration stream 为 14 条中的前 13 条定义/执行基线，v12 时共 24 张受审表；checksum、Drizzle/schema contract 与 readiness lockstep。
- Task/Trigger publisher 覆盖创建、更新、精确重放、serialization retry、task pin 漂移、缺失 execution revision 与损坏摘要。
- runtime/admin/worker-ingress 三类业务角色权限测试通过；migration role 仍独立。
- runtime-core 对 remote execution revision 覆盖 digest drift、跨 Project Secret reference 与有界计划。
- 临时 PostgreSQL 16.10 实例上的 migration/runtime/admin/worker-ingress 四角色 integration 20/20 通过；真实发布与读取、精确权限、长 Trigger ID 和 schedule 初始化均由数据库执行而非 fake Pool 模拟。

## 未包含

- 远端 Worker placement、offer ACK、执行完成与 Artifact transport；
- Task/Trigger 管理 CLI/API/UI 和审批 ceremony；
- PostgreSQL 18、主备切换、多 Pod 与长期容量证据；
- 非 command Task kind 与非 cron Trigger provider。
