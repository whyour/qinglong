# ADR-0093：本机 Execution Revision 摘要与原子发布

- 状态：Accepted（execution digest、SQLite v15 回填、TaskDefinition/recipe/revision 原子发布及 ADR-0098 Trigger/adoption 共同事务已实现；Scheduler/Run 待完成）
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-23、D-62、D-70、D-88、D-90、D-91、D-92
- 关联 ADR：ADR-0022、ADR-0023、ADR-0024、ADR-0063、ADR-0071、ADR-0089、ADR-0091、ADR-0092

## 上下文

ADR-0092 已能把一个完整、不可变且语义 canonical 的 `qinglong/command@v1` TaskDefinition 确定性编译为 context recipe 与 local execution revision，但持久化仍有两个缺口：

1. `QingLong3LocalTaskExecutionRevisions` 没有独立摘要。TaskDefinition reference 能证明来源，不能证明读取到的 command、working directory、timeout 或 context ref 没有被单独破坏；append-only 也不能提供损坏检测。
2. TaskDefinition、context recipe 和 execution revision 原来由不同 writer 分步写入。任一步失败都可能留下已更新但不可执行的 TaskDefinition，或没有来源的执行记录。

这些缺口会让管理入口、Crontab adoption 或 Scheduler 在错误的耐久事实之上继续扩展。修复必须保持 edge 单连接/队列、无新 package、无 watcher/timer，并能升级已有 capability v14 数据库。

## 决策

### 1. Execution revision 拥有独立、可重算的摘要

`LocalTaskExecutionRevision` 必须包含 64 位小写 `contentDigest`。摘要使用 domain-separated SHA-256：

```text
SHA256("qinglong.local-task-execution-revision.v1\0" || canonical-json)
```

canonical JSON 固定覆盖 `projectId`、`taskId`、`taskRevision`、`executorType`、canonical command、可选 working directory、可选 timeout 和 `contextRef`。`createdAtMs` 不参与摘要，使同一语义 identity 的精确重放保留首个观察时间；它仍须是非负安全整数。

只有 `createLocalTaskExecutionRevision()` 可以从内容创建完整记录。`normalizeLocalTaskExecutionRevision()` 在每次持久化和读取时重新 canonicalize 并重算摘要；缺失、大小写漂移或内容不匹配一律失败关闭。TaskDefinition compiler 改用创建函数，不能由 adapter 补摘要。

### 2. SQLite 0029/0030 在一个 migration transaction 中回填并前推能力

`0029-local-execution-revision-digest` 创建带 `content_digest NOT NULL` 和小写 SHA-256 CHECK 的替代表，按主键顺序使用 iterator 逐行读取旧 execution revision，不把全表载入内存。每行必须通过正式 runtime canonicalizer，再写入 canonical command 与计算后的摘要；数量漂移、旧行损坏、约束失败或 identity 冲突会回滚建表、数据和 migration history。

替表完成后，同一 migration transaction 按 Project/Task/revision 顺序重读全部历史 TaskDefinition：

- disabled 或非内建 schema 只保留历史，不获得本机执行权；
- enabled `qinglong/command@v1` 必须重验 TaskDefinition content digest 与内建语义，随后确定性编译并 exact-content append recipe/revision；
- 已存在的同 identity 同内容视为重放，其他内容视为冲突并回滚整个 migration。

这样 capability v14 期间已写入的内建 TaskDefinition 不会在升级后留下缺失派生事实。自定义 provider 的历史仍可读，但 migration 不猜测其执行语义。

`0030-capability-v15` 只有在 0029 成功后才把 `local-control-core` 前推到 v15，并增加 `local_execution_revision_digest=1`。readiness 同时核验 30 条 reviewed migration、v15 capability、migration anchor 和新列；runtime 仍不得自动执行 migration。

### 3. TaskDefinition append 同事务发布三个不可变事实

`LocalSqliteTaskDefinitionRepository.appendTaskDefinitionRevision()` 在共享 `LocalSqliteOperationAuthority` 的一个 `BEGIN IMMEDIATE` 内执行：

1. 重验 command 与 TaskSpec semantic registry；
2. 创建 TaskDefinition immutable revision；
3. 对 enabled 内建 command 编译 plan；
4. exact-content append context recipe；
5. exact-content append execution revision；
6. 更新 TaskDefinition head；
7. 一次性 commit。

recipe 可由不同 Task 共享，因此其 `createdAtMs` 不参与 replay equality；execution revision 使用独立 content digest 比较。预置 execution identity 冲突、任何 SQLite 约束或 head CAS 失败都会回滚 TaskDefinition head/revision 以及本次新 recipe/revision。

相同 mutation 重放不会修补缺失派生事实：repository 重新编译并要求 recipe/revision 已存在且摘要一致，缺失或损坏返回 unavailable。显式 migration 负责历史回填，普通业务重放不能成为隐式 repair authority。

disabled revision 和非内建 schema 不生成本机执行记录。低层 `LocalDispatchDefinitionWriter` 继续服务受审测试、迁移和未来窄管理组合，但常驻 application 仍只取得 TaskDefinition Source，不能绕过原子 publisher。

### 4. Trigger、Run 与 adoption 是后续独立事务 Gate

本 ADR 只关闭 TaskDefinition→context recipe→execution revision 三类本机事实的事务窗口。ADR-0094 后续建立了正式 Trigger append-only schema/repository，ADR-0098 又建立了 TaskDefinition、execution facts、Trigger、audit 与 ledger 的 adoption 共同事务；Run 创建仍有独立 idempotency 与调度事务，因此不能把这些提交宣称为 TaskDefinition/Trigger/Run 全链原子。

Legacy Crontab adoption 已按上述顺序完成字段分类、只读诊断和共同裁决；常驻 Scheduler 与 Run admission 在其独立边界完成前继续不可达，产品 issuer/CLI 也不能把内部 publisher 直接暴露为通用管理写入口。

## 被否决的替代方案

1. **只信任 TaskDefinition content digest**：不能发现 execution row 被单独修改，拒绝。
2. **把 `createdAtMs` 放入 execution digest**：会让同语义 identity 的首写时间改变 replay 结果，拒绝。
3. **只给新行写摘要，不迁移旧行**：升级后的读取会出现两套完整性语义，拒绝。
4. **迁移时把 execution 表一次性读入数组**：TaskDefinition 规模可增长，不符合路由设备有界内存要求，拒绝。
5. **重放时自动补缺失 recipe/revision**：把普通 mutation 变成隐式修复 authority，掩盖数据丢失，拒绝。
6. **为 publisher 新增 package 或第二 SQLite connection**：没有新部署/依赖边界，并破坏单机 authority，拒绝。
7. **把三个事实原子提交宣传为 Trigger/Run 已完成**：Trigger schema 与 adoption 仍缺失，拒绝。

## 影响

- 本机 execution revision 现在具有独立损坏检测，不再依赖“append-only”推断完整性。
- 新的 enabled 内建 TaskDefinition 一旦可见，对应 recipe/revision 已在同一 commit 内可见；失败不会留下半成品。
- v14 历史 execution rows 与内建 command TaskDefinitions 可在一个 reviewed transaction 中升级，损坏数据库保持 v14 且不记录 0029。
- migration entrypoint 会加载 compiler/semantic registry 以做历史回填；runtime entrypoint仍不加载 executable migration SQL。
- 没有新增 package、timer、watcher、数据库连接或常驻缓存。

## 验收证据

1. runtime-core 测试证明 digest 重算、时间戳排除、内容篡改失败和 compiler 产出完整摘要记录。
2. local-sqlite 测试证明 fresh v15 schema、v14 execution row 回填、v14 TaskDefinition 派生事实回填和坏旧行整 migration rollback。
3. 预置同 identity 不同 execution content 时，TaskDefinition append 返回 conflict，数据库中没有留下 TaskDefinition head/revision。
4. 删除或篡改已发布 execution revision 后，精确 mutation replay 返回 unavailable 且不自动修补。
5. schema lockstep 覆盖新列、CHECK 和 FK；runtime-only import test继续证明没有加载 migration modules。

## 后续约束

ADR-0094 已定义正式 Trigger head/revision 与版本化 TriggerSpec，ADR-0095 至 ADR-0098 已完成逐项诊断和 TaskDefinition/Trigger adoption transaction，并在新事实 commit 前以写围栏保持 2.x source 稳定。Run admission 仍只能引用已存在且 digest 验证通过的 pinned execution revision，且必须另行绑定 Trigger revision 与 scheduled time。
