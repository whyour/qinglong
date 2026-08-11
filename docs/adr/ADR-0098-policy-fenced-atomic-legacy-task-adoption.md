# ADR-0098：Policy 围栏下的原子 Legacy Task adoption

- 状态：Accepted（本机原子 publisher、ledger、Policy/fence/audit 与端到端测试已实现；产品 issuer/CLI、实机写放大、Scheduler/Run admission 和 PostgreSQL 对等实现待完成）
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-03、D-04、D-08、D-17、D-23、D-62、D-70、D-85、D-90、D-91、D-92、D-93、D-94、D-95、D-96、D-97
- 关联 ADR：ADR-0074、ADR-0087、ADR-0088、ADR-0089、ADR-0091、ADR-0092、ADR-0093、ADR-0094、ADR-0095、ADR-0096、ADR-0097

## 背景

ADR-0095 至 ADR-0097 已把 Legacy Crontab source、逐项分类、review decision、强认证 reviewer、短 TTL 和私有 HMAC decision file 绑定起来，但尚未定义最终物化事务。常规 `appendTaskDefinitionRevision` 与 `appendTriggerRevision` 各自拥有 `BEGIN IMMEDIATE`；按行循环调用会在后续 Trigger 或 candidate 失败时留下已提交 Task，不能满足 adoption 的全有或全无语义。

同时，路由设备不能为 100,000 行审阅一次缓存全部 command/candidate；集群节点又需要确定的 canonical 结果、授权 fence 和可审计重放。publisher 不能进入常驻 runtime，也不应为了一个单 consumer 用例再拆一个 workspace package。

## 决策

### 1. 使用既有包的短生命周期 subpath

本机存储新增 `@qinglong/local-sqlite/adoption`，local-admin 新增内部 `legacyCrontabPublisher` module；不新增 workspace package。常规 runtime、edge/standalone composition 和 adopted activation subpath不导入该入口，dependency audit 只允许 local-admin 的该内部 module 访问 adoption、Policy、security 与 audit contract。

`/adoption` 只支持 revision 1 的新建。目标已存在同 Task/Trigger identity、mutation/decision 冲突或任何 constraint 失败时整批回滚；常规 Task/Trigger Repository 的事务与更新语义保持不变。

### 2. canonical candidate 只能在进程内流转

classifier 内部生成 Task/Trigger canonical candidate，但根入口、diagnostic、receipt、decision file、ledger、audit 和响应都不得暴露 command。字段语义固定为：

- `name` 映射 Task name；缺失或空值使用 `Legacy Crontab <id>`；控制字符或超限为 malformed；
- `isPinned=1` 映射 `qinglong.io/legacy-pinned=true`；
- `saved` 是 2.x crontab 同步瞬态，不迁移；
- `sub_id` 表示 Subscription binding，在 3.0 等价模型完成前固定为 `subscription_binding_requires_mapping`，只能 skip，不能静默丢弃；
- 只有 `lossless→adopt` 和 `requires_shell_compatibility→adopt_shell_compatibility` 能产生 publisher candidate。

publisher 重新以目标 `projectId` 运行 TaskSpec/TriggerSpec semantic registry，并重新生成 Task/Trigger content digest；classifier 的 placeholder Project 不能成为持久化事实。

### 3. 外部 authority 和目标事务的顺序固定

完整顺序为：

1. 对 legacy source 取得 `BEGIN IMMEDIATE` 写围栏并记录文件身份；
2. 在同一个 `O_NOFOLLOW` decision-file descriptor 上完成 HMAC、header、receipt、TTL、source 与 disposition 验证；
3. 使用 receipt reviewer 强 Principal 对目标 Project 请求 `project.manage`；
4. denied、approval-required 或 policy-unavailable 在不触碰 Task/Trigger 时单独写低敏 audit；
5. allow 路径进入目标单一 `BEGIN IMMEDIATE`，重验 Project version、最新 RoleBinding version、active 状态及 owner/admin role；
6. 用 iterator 锁步消费 fenced source、第三遍 authenticated decision stream 和内部 candidate；
7. 原子创建全部 TaskDefinition revision、context recipe、local execution revision、Trigger revision、allowed audit 和 adoption ledger；
8. COMMIT 前再次确认 legacy source 路径身份和已认证 authorization descriptor/path 身份。

source 与 target 是两个 SQLite 文件，不能宣称跨库 ACID；正确边界是 source 全程只读且持有写围栏，所有新事实只在 target 的一个事务内提交。任何外部身份漂移、source/decision 锁步失败或 target mutation 失败都回滚目标事务。

### 4. append-only ledger 是 batch replay authority

SQLite `0033-legacy-adoption-ledger` 新增 `QingLong3LegacyAdoptions`，绑定：

- batch mutation ID、唯一 decision ID、Project/Profile；
- plan、inventory、decision-set、receipt、authorization-file digest；
- domain-separated publication digest；
- source row、adopted Task、adopted Trigger、skip 计数；
- 与 mutation ID 相同的 allowed audit event 和创建时间。

Task/Trigger revision mutation ID 由 batch mutation ID、row ordinal 和本地 index 通过 domain-separated SHA-256 确定派生，并强制 UUIDv4 version/variant bit。batch replay 只有在 ledger 的所有输入事实精确相同时返回 `existing`；相同 decision 的不同 mutation 或相同 mutation 的语义漂移均冲突。`0034-capability-v17` 只在 ledger migration 成功后把本机 contract 推进为 v17；readiness 现要求 34 条 migration、30 张 owned table。

### 5. 资源上限和部署档位

source、decision 和 candidate 均按 iterator 顺序消费，不缓存全量数组；Task 最多 100,000，Trigger 最多 500,000，超过上限在同一目标事务内失败并回滚。compiler 只在短生命周期 adoption subpath 被调用时加载；没有 timer、watcher、sidecar、第二个目标写 connection 或新增 package。

这些是安全硬上限，不是路由设备容量承诺。正式发布仍要求在固定物理 Edge 设备记录不同规模的事务时间、数据库/WAL/rollback-journal 写放大、峰值 RSS、断电恢复和剩余空间；超大 adoption 可由产品层先拒绝或要求迁移到能力更强的维护环境，但不能改成非原子分批后冒充同一 reviewed batch。

## 被否决的替代方案

1. **逐行调用公共 Task/Trigger Repository**：每个调用独立提交，会留下半迁移状态，拒绝。
2. **把 Repository 改成可嵌套事务**：扩大所有常规写路径的复杂度，而 adoption 只需 revision-1 create-only primitive，拒绝。
3. **没有 ledger，只依赖 audit 或逐行 mutation ID**：无法持久绑定完整 batch 输入和 exact replay，拒绝。
4. **把 command 写入 decision file/ledger/audit**：扩大 secret 泄漏面并破坏低敏凭据边界，拒绝。
5. **为 publisher 新增 workspace package**：单 consumer、共同部署、无独立依赖/制品责任，不满足 D-85，拒绝。
6. **在常驻 runtime 暴露 adoption writer**：让一次性高权限入口永久可达，拒绝。
7. **为降低事务时长而自动分批提交**：破坏一个 reviewed decision set 的原子语义；若未来需要分批，必须成为新的显式 plan/receipt/ledger 协议，拒绝隐式实现。

## 验收证据

1. local-sqlite 测试证明两条 Task、execution facts、Trigger、allowed audit 与 ledger 同事务创建，并可 exact replay。
2. 第二个 candidate identity 冲突时，先前 Task、Trigger、audit 和 ledger 全部为零，证明整批 rollback。
3. Project version 或 RoleBinding fence 变化时，在任何 adoption mutation 前失败。
4. local-admin 端到端测试从 HMAC decision file 和 fenced legacy source 发布 Task/Trigger，并验证第二次调用只返回 existing。
5. classifier 测试覆盖 pinned label、Subscription manual gate、非法 name、candidate 不经根入口暴露及 diagnostic 不含 command/path。
6. local-sqlite 52 项、local-admin 25 项、dependency audit 22 项与 backend 664 项测试通过；typed Drizzle schema 与真实 migration catalog lockstep。
7. 六种 Profile 制品门禁通过：edge/standalone 为 216 files、34 loaded modules；edge-adopted/standalone-adopted 为 234 files、37 loaded modules；edge-application/standalone-application 为 295 files、64 loaded modules。最大制品为 1,962,274 bytes，最大本轮抽样 RSS delta 为 11,763,712 bytes，均低于既有 4 MiB/512 files/16 MiB 门禁。

## 后续约束

本 ADR 只完成本机持久化 mutation authority，不代表 Scheduler、Run admission、2.x process cutover 或产品 issuer 已接管。下一阶段必须提供可信本机产品 ceremony/CLI，使用 adoption 专用 keyring 签发 decision file，并在固定物理 edge 设备完成规模、写放大、断电和空间门禁；随后才可把已发布 Trigger 接到 Scheduler/Run。cluster 必须实现 PostgreSQL 对等 batch ledger/transaction 和独立管理面，不能远程调用本机文件 authority。
