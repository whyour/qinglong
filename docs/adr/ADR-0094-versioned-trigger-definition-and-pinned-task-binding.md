# ADR-0094：版本化 Trigger 与固定任务修订绑定

- 状态：Accepted（领域契约、本机 SQLite v16、Repository 与 ADR-0098 adoption 共同事务已实现；Scheduler、Run admission 待完成）
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-03、D-04、D-08、D-17、D-23、D-62、D-70、D-88、D-90、D-91、D-92、D-93
- 关联 ADR：ADR-0022、ADR-0023、ADR-0063、ADR-0087、ADR-0088、ADR-0089、ADR-0091、ADR-0092、ADR-0093

## 背景

TaskDefinition、context recipe 与 local execution revision 已经具备不可变修订、独立摘要和同事务发布，但 Trigger 仍只是 RFC 中的概念联合类型。若 Scheduler 直接读取可变 Crontab 或 Task head，它会在触发时重新解释命令、时区和任务版本，历史 Run 也无法证明由哪个 Trigger revision 与 TaskDefinition revision 创建。

Trigger 还必须同时适应低性能路由器和集群节点：本机存储不能增加 watcher、timer、第二连接或新部署 package，列表与语义 provider 必须有硬上限；未来 PostgreSQL 对等实现又需要明确的 revision、CAS、摘要和任务引用契约，而不能复制 SQLite 偶然行为。

## 决策

### 1. Trigger 是 head 与 immutable revision，不是 Scheduler 配置缓存

新增 `TriggerRecord`、`TriggerSource` 与 `TriggerRepository`。head 只保存 `projectId/triggerId/taskId/currentRevision` 和生命周期时间；每次修改追加 immutable revision，并使用 `expectedRevision` CAS。`mutationId` 全局唯一，相同 mutation 只接受完全一致的重放。

Trigger identity 创建后不能改绑另一个 Task。每个 Trigger revision 固定保存 `taskId`、`taskRevision` 和 `taskContentDigest`；写入与重放都会完整读取并重算对应 TaskDefinition revision。启用 Trigger 不能引用禁用任务，禁用 Trigger 可以保留指向禁用历史任务的可审计关系。

### 2. TriggerSpec 使用版本化 envelope 与冻结语义 registry

TriggerSpec 采用 `{schema, config}` envelope。写入 authority 由 1–32 个 exact descriptor 一次性构造并冻结，禁止 wildcard、运行期注册、目录扫描和覆盖 `qinglong/` 内建 namespace。历史读取只验证 envelope 与 Trigger content digest，所以移除扩展 provider 不会让历史失读；再次写入仍必须具有当前受信 provider。

首个内建 `qinglong/cron@v1` 只接受五或六个有界 cron field，并要求显式有效 timezone 和 `skip | fire_once` misfire policy。空白被规范化、timezone 使用 Node ICU 规范名持久化；`@daily` 等 macro、隐式主机时区和无界补跑不属于 v1，Legacy adoption 必须逐项诊断而不能猜测。

### 3. Trigger revision 使用独立、域隔离的内容摘要

`contentDigest` 是 `qinglong.trigger-definition.v1\0` 域下的 SHA-256，覆盖 Project、Trigger、revision、固定任务 identity/digest、canonical spec 与 enabled，排除 mutation identity 和首写时间。Repository 每次读取都重算摘要，格式正确但语义不匹配的持久化内容同样失败关闭。

### 4. SQLite v16 增加两张正式表，不增加 package 或常驻资源

`0031-trigger-definitions` 创建 `QingLong3Triggers` 与 `QingLong3TriggerRevisions`，以 FK 固定 Project、Task head、Trigger identity 与 TaskDefinition revision，并提供 mutation、enabled scan 和 task history 索引。`0032-capability-v16` 仅在前者成功后加入 `trigger_definition=1`，把本机契约推进为 32 条 reviewed migration、capability v16、28 张 owned table。

`LocalSqliteTriggerRepository` 复用唯一的 `LocalSqliteOperationAuthority` 和同一 connection；单次 append 使用既有 `BEGIN IMMEDIATE`，稳定列表最多 256 条。该能力留在 `runtime-core/trigger` subpath 与 `local-sqlite` 内部文件中，不新增 package、sidecar、timer 或 watcher。

### 5. 本 ADR 本身不开放 Scheduler、Run 或 adoption mutation

本 ADR 的 Trigger Repository 只建立正式事实与写入边界。ADR-0095 至 ADR-0098 后续补齐 Legacy Crontab 的有界逐项诊断、review authorization、Policy/audit 与 TaskDefinition、execution facts、Trigger 的同事务 adoption publisher。Trigger 回调幂等键、due-state、misfire 计算、Run admission 和 PostgreSQL 对等 adapter 仍未完成；已发布 current head 仍不得被解释为生产 Scheduler 已接管。

## 被否决的替代方案

1. **Trigger 永远引用 Task current head**：触发时语义可漂移，历史 Run 不可解释，拒绝。
2. **只保存 task revision number，不保存 task digest**：不能证明引用内容，拒绝。
3. **把 cron expression 直接作为 Trigger 类型**：未来语义升级和插件 Trigger 无稳定版本边界，拒绝。
4. **沿用主机默认 timezone**：路由器迁移、容器配置或集群节点差异会改变触发时间，拒绝。
5. **v1 自动兼容所有 crontab macro 和方言**：会把无法证明的 2.x 行为伪装成无损迁移，拒绝。
6. **为 Trigger 新拆 package 或启动独立 Scheduler sidecar**：尚无独立部署/依赖边界，并扩大 edge 常驻成本，拒绝。
7. **建表后立即接管 Crontab**：缺少诊断、共同事务、Run admission 与回滚证据，拒绝。

## 验收证据

1. runtime-core 测试覆盖 cron canonicalization、显式 timezone/misfire、macro 拒绝、extension namespace、摘要损坏与结构预算。
2. local-sqlite contract tests 覆盖创建/更新/精确重放、Task revision pin、digest drift、disabled target、stale CAS、禁止 task rebind、竞争单 winner 与稳定分页。
3. 持久化损坏测试覆盖 Trigger digest 和 pinned TaskDefinition digest；普通 replay 不会修补坏事实。
4. typed schema lockstep 覆盖两张新表的列、索引、CHECK 与 FK；fresh migration/readiness 推进到 v16。
5. runtime import、edge import、依赖方向、全包测试和六种 production artifact 门禁继续作为回归条件。

## 后续约束

ADR-0095 至 ADR-0098 已完成 Legacy Crontab 到 `qinglong/command@v1 + qinglong/cron@v1` 的只读分类、显式裁决与 TaskDefinition、execution facts、Trigger 同成同败的 adoption publisher。Scheduler/Run admission 仍必须另外固定 Trigger revision、scheduled time 与 execution revision，不能把本 ADR 的 Repository 或 adoption ledger 误当作已完成接管。
