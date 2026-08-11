# ADR-0089：版本化 TaskDefinition 存储与物理规模证据

- 状态：Accepted（领域契约、本机 SQLite v14、只读应用装配、command v1 写入门禁和规模记录协议已实现；管理入口、execution compiler、其他 kind、集群 adapter 与固定实机报告待完成）
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-03、D-05、D-06、D-17、D-22、D-37、D-48、D-64、D-86、D-87、D-88
- 关联 ADR：ADR-0001、ADR-0022、ADR-0040、ADR-0041、ADR-0063、ADR-0066、ADR-0071、ADR-0087、ADR-0088

## 上下文

3.0 已有 `Run`、不可变本机 execution revision 和 pinned execution plan，但此前没有正式的 TaskDefinition 领域记录或持久化 Repository。继续把 execution revision 当作任务定义会混淆两个生命周期：TaskDefinition 是用户管理的源定义，execution revision 是调度前物化的下游执行输入。使用 `Run` 行或临时 benchmark table 测量 100/1000/10000 个任务也无法反映真实定义 schema、索引、序列化和读取路径。

QingLong 需要同时服务低内存路由设备和集群节点。Task spec 若允许任意对象、无界嵌套或 adapter 自行解释，会在读写、摘要、API 和插件边界形成不一致的资源与安全语义；若在常驻 application 暴露写 Repository，又会让尚未具备 Policy/Approval 的入口提前修改任务。

## 决策

### 1. Head 与 immutable revision 分离

TaskDefinition 使用两个事实层：

- `QingLong3TaskDefinitions` 只保存 `(project_id,task_id)`、当前 revision 与创建/更新时间；
- `QingLong3TaskDefinitionRevisions` append-only 保存每个 revision 的 mutation、名称、kind、spec、labels、enabled、content digest 与发生时间；
- revision 由 `expectedRevision=null` 创建为 1，或由精确当前 revision 递增；不提供覆盖历史、删除历史或跳号写入；
- 全局唯一 `mutationId` 只允许完整语义一致的重放；同 ID 漂移、stale revision、归档/不存在 Project 或时间倒退全部冲突关闭；
- 每次读取都规范化记录并重算 canonical SHA-256；损坏、driver 异常和未知 row shape 统一映射为低敏 unavailable。

这两个表由 reviewed migration `0027-task-definitions` 创建，`0028-capability-v14` 把 `local-control-core` 推进为 contract v14、capability `task_definition:1`。当前本机 stream 为 28 条 migration、26 张 owned table；未知用户/插件表继续保留。

### 2. 有界领域 envelope

通用层只接受 exact-shape `{schema,config}`：

- schema 必须是显式版本名，例如 `qinglong/script@v1`；
- canonical JSON 最大 64 KiB、深度 12、总节点 1024；
- 单数组或对象最多 256 项，单字符串 16 KiB；
- 最多 32 个规范 label，值最大 256 bytes；
- kind 固定为 `script | command | workflow | agent | tool`。

这些限制只证明 envelope 可安全保存、摘要和传输，不证明内容可执行。ADR-0091 已增加启动时冻结的受审 semantic registry，并让本机 append 在写库前验证首个 `qinglong/command@v1`；其他 kind/schema 仍不可写。历史读取继续只验证 envelope/digest，未来 execution compiler 必须对 pinned revision 再次验证；未知 schema 不得由 Executor 猜测执行。

### 3. Repository 与 authority 边界

共享 `TaskDefinitionSource` 提供当前点查、历史 revision 点查和以 task ID 为 cursor、单页最多 256 条的稳定列表；`TaskDefinitionRepository` 额外提供 append。SQLite adapter 复用唯一 `LocalSqliteOperationAuthority`、同一 connection/queue/close fence 和 `BEGIN IMMEDIATE`，不创建第二数据库 authority。

base/adopted local Profile 把 Repository 传到 application storage，但常驻 application 对外只构造 read-only Source，运行时对象中不存在 append 方法。原本用于物化 execution revision 的窄 writer 更名为 `executionDefinitions`，避免它被误认为 TaskDefinition 管理能力。正式写入口必须以后续独立、短生命周期或受审 API 组合 Policy、Approval、审计与 revision fence；当前没有公开写 API。

### 4. 物理规模证据

`scripts/ql3-physical-edge-task-scale.cjs` 只在原生 Linux Node 24.18+、无容器/VM 指示、架构和文件系统与 exact manifest 一致时运行。它在 operator 指定的真实数据文件系统创建私有临时数据库，执行正式 migration，并只调用正式 TaskDefinition Repository 写入 100、1000、10000 条定义。每档必须经最多 40 页、每页 256 条的完整稳定扫描，记录 ID/revision digest、追加/累计/扫描耗时、进程 RSS/peak RSS，以及数据库、journal、WAL、SHM 的 logical/allocated bytes。

报告以 `0600` no-replace 文件和 SHA-256 发布，始终保持 `supported=false`。基础物理报告只导入同 device、Profile、boot、Linux、架构、数据路径和文件系统的完整三档报告。该证据明确不证明：

- production scheduler 吞吐或 Trigger/Run 创建开销；
- 2.x adopted database migration 时间和额外磁盘峰值；
- 整机闪存写放大；
- 非 command task spec 的语义与 TaskDefinition→execution compilation；
- 任一物理设备已达到产品支持门槛。

## 被否决的替代方案

1. **复用本机 execution revision 表**：它是物化执行输入，不是用户定义历史，拒绝。
2. **只保存当前 TaskDefinition row**：更新会使历史 Run 无法解释，也无法安全重放 mutation，拒绝。
3. **在 application 直接暴露写 Repository**：当前尚无管理 Policy/Approval 入口，会扩大常驻 authority，拒绝。
4. **用 Run 行或临时表做规模压测**：绕过正式 schema、摘要、索引和 Repository，结论无效，拒绝。
5. **把 10000 条本机写入结果推导为集群容量**：SQLite 单节点定义存储与 PostgreSQL 多副本调度是不同工作负载，拒绝。

## 影响

- 本机 readiness 现在要求 capability v14、28 条 frozen migration 和两张 TaskDefinition 表的列、索引、CHECK/FK 契约；旧 v13 目标会 fail closed，必须显式迁移。
- edge/standalone application 增加只读定义查询能力，不增加 timer、watcher、sidecar、第二 connection 或常驻写 authority。
- Run pinned Task revision、Trigger 管理和 Crontab adoption 以后必须引用该正式定义模型；当前尚未接入，不能声称 2.x 任务已迁移。
- cluster-control 仍需 PostgreSQL 对等 schema/Repository、权限和多副本 contract；不得回退共享 SQLite。

## 验收证据

1. runtime-core contract test 覆盖 exact shape、结构/字节预算、canonical digest、cursor 和错误边界。
2. local-sqlite migration/schema/readiness lockstep 覆盖 capability v14、28 条 checksum、26 张 owned table及两张新表的 CHECK/FK/index。
3. SQLite Repository test 覆盖 create/update/exact replay、stale fence、归档 Project、当前/历史读取、分页、双 connection 竞争和 digest corruption。
4. local-profile、local-adopted-profile 与 local-application test 证明共享 authority 传递、read-only TaskDefinition Source 和独立 `executionDefinitions` writer。
5. 物理规模记录器 contract test 覆盖 exact manifest、设备漂移、三档扫描、logical/allocated bytes、私有同设备报告导入和畸形 workload fail closed；Linux resource CI 执行该契约测试。
6. 六种 Profile production package audit 全部通过。ADR-0090 已把开发 source/declaration map 排除在精确 production packlist 外；ADR-0092 后当前最大 standalone-application 为 1,691,009 bytes、267 files、61 loaded modules，最大抽样 RSS delta 为 11,780,096 bytes，低于 4 MiB、512 files、16 MiB 门禁。

## 后续约束

下一切片不能直接开放 TaskDefinition HTTP/CLI 写入。production artifact map 排除规则已由 ADR-0090 冻结，ADR-0091 已完成不可变 registry 与首个 command v1；现在应先实现 pinned TaskDefinition revision 到 immutable execution revision/context recipe 的纯 compiler，再定义 Crontab adoption 映射、Trigger/Run 事务和 Policy/Approval/审计入口，随后实现 PostgreSQL 对等 adapter。物理设备方面需在冻结硬件清单采集真实规模报告，并继续独立完成 adopted migration、冷启动/首次 ready、整机写放大、application recovery、断电与 release signature；这些证据不得由本 ADR 的 fresh schema 规模协议替代。

## 后续更新（2026-08-01）

ADR-0256 在后续 compiler、execution publication、Owner credential 与 Project Policy 基线完成后，
已开放 Edge/Standalone 的短生命周期 `ql3-task` 产品入口；它没有把 append authority 加回常驻
application。Cluster PostgreSQL 管理 transport、Trigger 产品入口和固定物理设备证据仍未由该更新完成。
