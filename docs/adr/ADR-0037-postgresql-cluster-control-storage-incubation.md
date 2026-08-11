# ADR-0037：PostgreSQL Cluster-control 存储孵化与跨方言契约

- 状态：Proposed
- 日期：2026-07-19
- 关联：QL-RFC-0001、ADR-0004、ADR-0012、ADR-0014、ADR-0031、ADR-0032、ADR-0033、ADR-0036

## 上下文

QingLong 3.0 已明确 edge/standalone 使用本机 SQLite，cluster-control 使用 PostgreSQL。但当前 `next` 的实现事实仍是：

- 生产依赖只有 Sequelize + SQLite driver，没有 `pg`、Drizzle ORM 或 Drizzle Kit；
- migration runner 的 `MigrationContext`、history model 和 transaction 都绑定 Sequelize；
- `0001` 至 `0024` 的 checksum 由 SQLite manifest 计算，部分 migration 还扩展 2.x legacy 表；
- 至少 20 个 legacy-sequelize adapter 显式拒绝非 SQLite，其中 11 个包含 `SQLITE_BUSY`、短 `BEGIN IMMEDIATE` 或等价单机重试假设；
- local completion journal、local Secret envelope、local Artifact retention、legacy owner bootstrap 和 legacy panel identity 不是 cluster-control 应复制的 schema；
- cluster-control Profile 当前拒绝装配 SQLite + LocalProcess Primary，这是正确的 fail-closed 状态。

如果为了“双方言”把 PostgreSQL SQL 直接加入已应用的 `0001` 至 `0024` checksum，现有 SQLite 数据库会在升级时得到 checksum mismatch。反过来，如果 PostgreSQL 复用这些 migration ID 但记录不同 checksum，同一 ID 将不再代表同一不可变变更。把现有 Sequelize adapter 切换 dialect 也不能自动获得多副本 claim、row lock、SQLSTATE retry 和 shared evidence 语义。

因此 PostgreSQL 不能作为现有 SQLite runner 的一个连接字符串选项加入；它需要独立、可审查的 migration stream 和 adapter 实现，但必须通过相同领域 Repository contract。

## 决策

### 1. 冻结 SQLite migration identity

`0001` 至 `0024` 继续属于 `sqlite-main` stream，其 ID 与 checksum 不因 PostgreSQL 实现而变化。后续 SQLite migration 也只对自身方言 SQL/manifest 计算 checksum。

PostgreSQL 使用全局可区分的 ID，例如：

```text
pg-0001-schema-history
pg-0002-run-core
pg-0003-worker-dispatch
pg-0004-project-identity-policy
pg-0005-approval-action-recovery
```

一个 PostgreSQL 数据库只记录 `pg-*` stream；一个 SQLite 数据库只记录现有数字 stream。禁止在同一数据库伪装应用另一方言 migration，也禁止通过修改旧 checksum“升级”migration 内容。

跨方言兼容由单独的 `schema contract version` 表达，而不是要求 migration ID 相同。contract version 只在一组 migration 全部完成后推进，用于 ql-core readiness；它不替代逐条 checksum 历史。

这项决策补充并修正 ADR-0004 中“一个 checksum 同时覆盖两个方言 SQL”的早期目标。单一不可变 history 语义保留，但具体 migration stream 按方言分开。

### 2. PostgreSQL 从空库建立 control-plane-only schema

首版只支持空 PostgreSQL 数据库或受支持的 `pg-*` 3.x migration，不把 2.x SQLite 文件当作可原地升级的 PostgreSQL 数据库。baseline 分阶段创建：

1. migration history、schema metadata 与 runtime capability；
2. Run、RunAttempt、RunEvent、Task revision、cancellation、retry；
3. Worker registry、Run dispatch lease 与多副本 queue 索引；
4. Project、stable Identity、RoleBinding 与 Policy 审计事实；
5. ApprovalRequest、ApprovedAction dispatch/execution/recovery/receipt/authorization fact。

cluster-control baseline 不创建：

- 2.x Crontab/Env/Subscription/RunningInstance 等 legacy projection；
- local completion receipt journal；
- local execution context recipe；
- local Secret envelope/key；
- local Artifact retention/checkpoint；
- local owner bootstrap challenge；
- legacy panel singleton identity binding。

这些能力必须分别由共享 Artifact/object store、KMS/Secret provider、OIDC/mTLS/API identity 和集群运维 bootstrap 协议替代。表名相同不代表可以复制 local-only security model。

### 3. Migration runtime 与应用 runtime 分权

PostgreSQL migration 默认由部署级 Job 使用 migration role 执行；应用 pod 使用无 DDL 权限的 runtime role。若支持应用内 migration，必须先取得固定、版本化 advisory lock，并满足：

- lock key、等待上限和 owner metadata 固定；
- lock 未取得时 pod 保持 not-ready，不并行执行 DDL；
- 每条 migration 在单事务可行时原子提交；需要 `CREATE INDEX CONCURRENTLY` 等非事务步骤时拆为显式 prepare/commit migration，并有可恢复 marker；
- history row 只在全部步骤成功后写入；
- checksum mismatch、未知 ahead migration 或 contract version 不兼容都阻止 readiness；
- runtime role 只能只读验证 history/capability，不能自动修复 schema。

生产 PostgreSQL backup、PITR 和 restore 属于部署平台；应用只调用有界 backup precondition hook，不读取或复制数据目录。

### 4. 共享 Repository contract，不共享并发 SQL

领域 port、状态机、错误码、幂等键和 cursor 语义保持统一；SQLite 和 PostgreSQL adapter 使用不同算法。

PostgreSQL 至少采用：

- queue-like batch claim：`SELECT ... FOR UPDATE SKIP LOCKED` 或等价的有界 claim + `UPDATE ... RETURNING`；
- 单资源 mutation：锁定 aggregate/control row，再按 expected version CAS；
- 不存在子资源的首次创建：通过 parent row、唯一约束或专用 lock row 串行化，不能依赖 SQLite 的 database-wide write lock；
- immutable append：唯一 `(aggregate_id, version|sequence|mutation_id)` 约束；
- lease fencing：owner、token、generation/attempt、version 全部进入条件写；
- Policy fence：Project 与 RoleBinding version 在同一事务复验；
- Approved Run：Run/Attempt/Event/receipt 在同一 PostgreSQL transaction；
- human recovery：resolution、execution/control terminal 与 authorization fact 在同一 transaction。

`SKIP LOCKED` 只用于 queue claim，不用于普通列表、Policy read 或审计查询。cursor 仍使用稳定 keyset，不暴露 offset 全表扫描。

### 5. 现有逐条 claim port 先保正确性，再扩展批量能力

当前 dispatcher/reconciler 的流程是 `listDue -> claim(id)`。PostgreSQL 可先用条件 `UPDATE ... WHERE version/status/due RETURNING` 保证只有一个 winner，从而保持领域正确性；但高并发下会产生额外 round trip 和热点竞争。

cluster 性能实现允许增加显式 `claimDueBatch` port，由 adapter 在一个短事务内 SKIP LOCKED 并返回已 fenced 的 bounded snapshots。应用层必须把单条与批量 claim 归一为相同领域结果，并通过同一 mutation replay/terminal winner contract。禁止让 service 拼接 PostgreSQL SQL 或感知 SQLSTATE。

是否增加批量 port 由 benchmark 决定，不在未测量前破坏现有单机接口。

### 6. SQLSTATE 只能在 adapter 边界映射

PostgreSQL adapter 将驱动错误映射为稳定 Repository 错误，至少覆盖：

- serialization failure/deadlock：有界全事务 retry，耗尽后统一 unavailable/retry-exhausted；
- lock timeout/query canceled：busy/timeout；
- unique/foreign-key/check violation：按具体约束名映射 idempotency conflict、fence conflict 或 corruption；
- connection reset/failover/read-only primary：database unavailable；
- bigint/JSON/boolean 解码漂移：corrupt persisted state，fail closed。

领域 service 不读取错误字符串、SQLSTATE、constraint name 或 driver class。retry 必须有次数和总时间上限，不能在事务 callback 内执行外部副作用。

### 7. 连接与查询默认有界

cluster-control adapter factory 必须显式配置：

- bounded pool min/max、acquire timeout 和 idle lifetime；
- statement timeout、lock timeout、idle-in-transaction timeout；
- application name、UTC session 与明确 search path；
- TLS 验证策略和 Secret-ref 连接配置；
- bigint 转换：只接受 JavaScript safe integer 范围，越界 fail closed；
- query log 默认不记录参数，尤其不记录 token、Secret、prompt 或 Tool payload；
- shutdown 先停止 admission/lifecycle、drain in-flight transaction，再有界关闭 pool。

edge/standalone 构建和启动不得 import、初始化或连接 PostgreSQL。依赖采用 profile lazy load 或独立 package/entrypoint，避免路由设备为 cluster driver 支付启动 RSS。

### 8. Contract suite 分四层

每个进入 cluster-control 的 Repository 必须通过：

1. **领域等价层**：SQLite 与 PostgreSQL 对相同 command 返回相同 record、错误和重放语义；
2. **双连接竞态层**：create、CAS、claim、renew、completion、revoke/consume/resolve 只有一个 winner；
3. **多副本压力层**：至少三个独立 pool 并发 claim，无重复副作用，吞吐、lock wait、retry 有界；
4. **故障层**：事务中断、连接 reset、primary failover、migration leader 竞争和 pod kill 后可恢复。

Approved Action 首批必须覆盖：

- approval consume + dispatch/execution baseline 原子性；
- pre-start takeover 与 post-start recovery-required；
- normal completion、automatic evidence resolution、human resolution 的 terminal winner；
- `run.create` Run/Attempt/Event/receipt 原子提交；
- Role revoke/Project archive 与 manual recovery authorization race；
- recovery-first lifecycle 在一个副本失败时不扩大副作用。

### 9. 依赖选择是单独门禁

本 ADR 不直接安装 `pg`、Drizzle ORM 或 Drizzle Kit。具体 exact version、Node/PostgreSQL 支持线和独立 package 交付边界由 ADR-0038 决定；依赖落锁前仍必须由 Maintainer 接受：

- 固定 Node 24 patch 与 PostgreSQL 最低/最高支持版本；
- exact `pg`、Drizzle ORM/Kit 版本和升级策略；
- Docker/Testcontainers 或外部 CI service 的测试拓扑；
- migration Job 与应用内 advisory-lock 两种部署方式的首选项；
- runtime/migration 最小权限 role；
- 基准和 failover 环境的 owner。

依赖加入后必须证明 edge/standalone 默认路径不 import cluster bundle，并记录安装体积、冷启动和 RSS 差异。

### 10. 实施顺序

1. 把 migration runner 抽象为 dialect-neutral history/transaction port，同时让现有 SQLite suite 零语义变化；
2. 建立 `pg-*` SQL 文件、checksum 与只读 schema capability audit；
3. 先实现 Run core + WorkerRegistry + RunDispatchLease，验证多副本 claim/lease/fencing；
4. 实现 Project/Identity/Policy 与 Approval/Approved Action；
5. 实现 shared Artifact、Secret/KMS、plan/receipt provider；
6. 通过多副本、failover、backup/restore 和资源门禁后，才允许 cluster-control readiness 成功。

任一阶段不得让未实现的 port 回退到 SQLite、进程内 Map 或本地文件唯一事实。

### 11. 当前孵化状态

`next` 已完成第一步的兼容切片，并开始第二步的 driver-neutral Store 切片：

- 新增不依赖数据库驱动的 migration stream core，统一校验 stream/dialect、ID scheme、checksum scheme、重放、事务内并发复验和 history 原子写入；
- ID scheme 显式区分既有 `sqlite-numbered` 与未来 `postgres-prefixed`，不重写任何 SQLite migration ID；
- checksum scheme 对既有 SQLite 使用 `legacy-opaque` 保持 runner 兼容，对未来 PostgreSQL 强制 64 位小写 SHA-256；
- `SequelizeSqliteMigrationStreamStore` 把现有 Sequelize transaction/query interface 映射到通用 core，并保持 `SchemaMigrations(id,checksum,applied_at)` 行结构；
- 原 `runMigrations()` 签名、`Migration` 接口、注册列表和 `[migration] Applied ...` 日志格式不变；
- 非 SQLite dialect 在 history 访问前拒绝，避免把 SQLite migration stream 误用于 cluster-control；
- contract tests 覆盖旧 history 精确重放、checksum mismatch、损坏 stream/dialect、并发 leader winner、migration/history 同回滚和完整 legacy fixture 升级。
- `PostgresMigrationStreamStore` 只依赖 QingLong 自有 Pool/Client 端口，以固定 transaction advisory lock 串行 history bootstrap 和 migration；竞争者 fail closed，work/history 同事务回滚；
- PostgreSQL transaction 固定 statement/lock/idle-in-transaction timeout，history bigint 时间超出 JavaScript safe integer 时按损坏状态拒绝。
- 通用 core 会在执行前枚举完整 history，未知 migration、重复 ID、非前缀缺口、stream/dialect 漂移和 checksum mismatch 均 fail closed；SQLite 默认完整 runner 同样执行 downgrade/ahead 审计，自定义 migration 子集只作为 scoped fixture seam。
- `pg-0001-schema-capability`、`pg-0002-run-core` 与 `pg-0003-run-retry-policy` 已定义首批不可变 stream；capability 对 history 的 deferred FK 保证 `control-core=1/2` 只和对应 `pg-0002/0003` history 同事务提交。
- ADR-0039 的只读 readiness auditor 已固定 PostgreSQL 16–18、完整 history、capability、精确 schema object 和最小权限 runtime-role 五层 gate；未知 `ql3` 对象和过度授权同样 fail closed。

后续切片已按 ADR-0038/0039/0041/0042/0043/0044 落入独立 package：`@qinglong/runtime-core` 公开 migration/activation/RunRepository contract，`@qinglong/cluster-postgres` 拥有真实 lazy `pg.Pool`、Run Repository、Drizzle schema、migration 和 readiness，`@qinglong/cluster-control` 在 readiness 后创建真实 Repository 并执行有序激活。package-local fake-client tests 与本机 PostgreSQL 13 真实 shared contract 已通过，PostgreSQL 16/18 × x64/arm64 最小权限 integration 也已接入 CI。远端矩阵成功证据、多 Pool 竞争/failover、完整 control-plane application stack 和独立发布产物仍未完成，因此 cluster-control 尚不可作为生产 ready 控制面。

## 影响

正面影响：

- 不修改已经应用的 SQLite migration checksum；
- cluster-control schema 不携带本机/legacy 数据模型；
- 领域状态机保持一致，同时允许真正的 PostgreSQL 并发算法；
- migration、runtime 和运维权限边界清晰；
- edge 不为集群 driver 付出依赖、连接或常驻内存。

代价与风险：

- 需要维护两条 migration stream 和 schema contract version；
- PostgreSQL adapter 不能通过“换 dialect”自动得到，工作量较大；
- 双方言 contract、多副本和 failover CI 增加维护成本；
- SQLite 到 PostgreSQL 迁移必须是独立离线产品，不是简单复制数据库文件；
- 在首个 PostgreSQL vertical slice 完成前，cluster-control 继续不可用。

## 未选择的方案

1. **给 `0001–0024` checksum 追加 PostgreSQL SQL**：会破坏已应用 SQLite history，拒绝。
2. **相同 migration ID 记录不同方言 checksum**：ID 失去不可变语义，拒绝。
3. **Sequelize 连接改成 postgres 即完成适配**：锁、重试、schema 和 local-only 表语义错误，拒绝。
4. **cluster-control 共享 NFS SQLite**：多副本 locking/可见性/故障语义不受支持，拒绝。
5. **所有 Profile 都安装并初始化 pg Pool**：增加 edge RSS、Secret 和连接面，拒绝。
6. **每个 pod 自动跑 migration 且失败继续 ready**：DDL 竞争和 schema drift 会污染运行时，拒绝。
7. **一个巨大 PostgreSQL baseline 一次创建全部能力**：难以审查、回滚和按 vertical slice 验证，拒绝。
8. **在 service 中判断 SQLSTATE**：泄漏 driver 语义并破坏 Repository contract，拒绝。
9. **先实现在线 SQLite→PostgreSQL 双写**：跨库事务、回放和回退复杂度过高，拒绝。

## 验证要求

- 已有 SQLite `0001–0024` checksum 在 PostgreSQL 工作开始后保持不变；
- PostgreSQL migration ID 使用独立前缀，history 重放、checksum mismatch 和 ahead schema fail closed；
- baseline 只包含声明的 cluster-control 表，local/legacy 表缺席；
- migration leader 竞争只有一个 writer，其余 pod not-ready；
- runtime role 无 DDL 权限，migration role 不作为常驻应用凭据；
- Repository contract 在 SQLite/PostgreSQL 返回同一领域结果和稳定错误；
- 三 pool 并发 claim/renew/complete 无重复 winner；
- serialization/deadlock/lock timeout retry 有次数和总时长上限；
- kill/failover 后 lease/recovery 状态可收敛，不从连接错误推导副作用结果；
- PostgreSQL bundle 在 edge/standalone 默认入口的 import graph 中不可达；
- cluster-control 在任一 schema capability、shared Artifact、Secret/KMS 或 adapter 缺失时拒绝 ready。
