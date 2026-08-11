# ADR-0004：SQLite/PostgreSQL Repository、驱动与 Migration 策略

- 状态：Proposed
- 日期：2026-07-18
- 决策者：QingLong Maintainers
- 关联 RFC：[QL-RFC-0001](../QINGLONG_3_0_ARCHITECTURE_RFC.md)
- 前置决策：[ADR-0001](./ADR-0001-run-state-and-transaction-boundaries.md)、[ADR-0002](./ADR-0002-legacy-crontab-compatibility-and-shadow-write.md)
- 后续细化：[ADR-0037](./ADR-0037-postgresql-cluster-control-storage-incubation.md)

官方参考：

- [Node.js 24 node:sqlite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
- [Drizzle Node SQLite](https://orm.drizzle.team/docs/sqlite/connect-node-sqlite)
- [Drizzle PostgreSQL](https://orm.drizzle.team/docs/get-started-postgresql)
- [Drizzle migration generate](https://orm.drizzle.team/docs/drizzle-kit-generate)
- [SQLite WAL](https://www.sqlite.org/wal.html)
- [SQLite Online Backup API](https://www.sqlite.org/backup.html)
- [PostgreSQL SELECT locking](https://www.postgresql.org/docs/current/sql-select.html)

## 1. 决策摘要

QingLong 3.0 的领域层只依赖 Repository port，不依赖 Sequelize、Drizzle、SQLite 或 PostgreSQL API。

最终持久化组合为：

| Profile | 数据库 | Query/Schema 工具 | Driver |
| --- | --- | --- | --- |
| edge | SQLite | Drizzle typed schema | Node.js node:sqlite |
| standalone | SQLite | Drizzle typed schema | Node.js node:sqlite |
| cluster-control | PostgreSQL | Drizzle typed schema | node-postgres |
| worker | 无控制面数据库 | 本地有界 spool 另行决定 | 不适用 |

新代码不得把 Drizzle query object 或 Sequelize Model 暴露到 service/domain 层。SQLite 与 PostgreSQL adapter 可以使用不同的 SQL 并发算法，但必须通过同一 Repository contract suite，产生相同的领域状态与错误语义。

迁移采用“生成、审查、提交、由应用 runner 执行”的方式：

- Drizzle Kit 只在开发/CI 中生成或校验 SQL。
- 生产环境不执行 drizzle-kit push。
- SQLite 与 PostgreSQL migration 都必须进入版本控制、具有稳定 ID 和 checksum。
- 应用继续使用单一 SchemaMigrations 历史表，不同时维护一套不可见的 Drizzle runtime migration 历史。
- 2.x SQLite 使用 baseline + incremental migration 原地升级；PostgreSQL 3.0 首版从空库 baseline 创建，不声称可以直接打开 2.x SQLite 文件。
- migration 前必须完成一致性备份，失败时停止启动，不能吞掉 schema error。

为避免“大爆炸”式替换，允许一个明确临时的 SequelizeRunRepository adapter：

1. PR-1/PR-2 使用现有 Sequelize connection 实现 Run Repository，只存在于 adapter 层。
2. Shadow Runtime 稳定后，按数据域迁移旧 Sequelize 调用。
3. DrizzleSQLiteRunRepository 通过同一 contract suite 后替换临时 adapter。
4. keyv.sqlite 完成迁移后，才能移除 sqlite3、Sequelize 和 @keyv/sqlite。
5. 临时 adapter 不得成为插件 API，也不得新增领域层对 Sequelize 的依赖。

当前官方 Node 24 文档仍把 node:sqlite 标为 Stability 1.2 Release candidate，Drizzle 的 node:sqlite 文档也仍建议 RC 包。因此依赖必须锁定精确版本，并在 Alpha 期保留 Legacy adapter 回退；不能只依据“内置模块”三个字直接删除现有驱动。ADR-0063 已把 Drizzle RC 限制为 SQLite adapter 的开发期 schema 工具，edge/standalone production graph 不安装它。

2026-07-18 的包元数据审计进一步确认：`drizzle-orm@0.45.2` 稳定版没有导出 `node-sqlite`，该导出存在于 `1.0.0-rc.4`；`@keyv/sqlite@4.0.8` 稳定版仍依赖 `sqlite3`，而 `6.0.0-beta.4` 虽要求 Node `>=22.18.0`，仍直接依赖 `better-sqlite3`。因此本 ADR 接受目标组合，但不授权当前直接升级这些预览依赖。

## 2. 当前状态

### 2.1 主数据库

主数据库位于：

    data/db/database.sqlite

当前 back/data/index.ts 创建 Sequelize 6 SQLite connection：

- sqlite3 实现来自 @whyour/sqlite3。
- pool max 5、min 2。
- SQLITE_BUSY 最多重试 10 次。
- transactionType 使用 IMMEDIATE。
- 各 service 直接调用 Model.findAll/findOne/create/update/destroy 等 API。
- 显式业务事务目前较少，但 Run 状态机将显著增加事务要求。

### 2.2 第二个 SQLite 数据库

back/shared/store.ts 通过 @keyv/sqlite 打开：

    data/db/keyv.sqlite

其中至少保存：

- apps
- authInfo
- lang

因此仅迁移主数据库不能移除 sqlite3 原生依赖，也不能得到单文件一致备份。SQLite 官方说明，在 WAL 模式下涉及多个 ATTACH 数据库的事务只保证每个数据库单独原子，不保证多个数据库作为整体原子。

### 2.3 启动与迁移

现有启动顺序为：

    model sync
      -> explicit SchemaMigrations runner
      -> initData
      -> API/scheduler

PR-0 已将吞掉所有 ALTER 错误的逻辑替换为带 checksum 的显式 runner。当前 runner 仍使用 Sequelize QueryInterface，这是 2.x 兼容引导实现，不是 3.0 最终数据库边界。

### 2.4 多架构与低资源约束

当前镜像覆盖 amd64、arm/v6、arm/v7、arm64、ppc64le、s390x、386 等架构。最终采用 node:sqlite 虽可消除 npm native addon，但仍必须证明：

- 每个承诺架构的固定 Node 24 运行时实际包含 node:sqlite。
- Alpine/musl 与 Debian/glibc 上数据库行为一致。
- 旧宿主 seccomp、文件系统和 SQLite VFS 行为通过测试。
- DatabaseSync 的同步查询不会让低性能路由设备出现不可接受的 event-loop stall。
- Node 运行时镜像本身不会因升级而失去原有架构。

“没有 node-gyp”不等于“自动获得多架构兼容”。

### 2.5 旧库结构审计

对当前工作区 `database.sqlite` 的只读 introspection 发现，实际数据库可能同时包含：

- 当前 Sequelize model 管理的核心表。
- 3.0 孵化 migration 新增的 Run、Attempt、Event 与取消派发表。
- 历史版本、分支或外部扩展留下但当前 model 未声明的表，例如 Scenario、User、CronLog 类结构。
- 当前 model 未声明的兼容列，例如重复命名风格的 pinned 字段或 userId。

这说明“根据当前 model 或 Drizzle schema 重建整库”会有真实数据丢失风险。迁移必须使用 ownership manifest：只修改明确声明为 QingLong 3.0 所有的对象，unknown table/column/index 默认保留并由诊断报告。CI fixture 必须包含未知表和未知列，证明增量 migration 不会删除它们。

## 3. 目标

1. 让 Run 状态机在 SQLite 与 PostgreSQL 上保持相同领域语义。
2. 为 edge 保留单文件、低内存、零外部服务部署。
3. 为 cluster-control 提供多副本 claim、锁和一致性能力。
4. 通过 typed schema、受限动态查询和 reviewable migration 降低维护风险。
5. 原地升级已有 2.x database.sqlite，不重命名历史表和字段。
6. 最终移除 Sequelize、sqlite3 与 @keyv/sqlite 的运行时依赖。
7. 在迁移期间保持每一步可测试、可观测、可回退。
8. 数据库故障不能造成重复任务、状态和事件分离或静默 schema 漂移。

## 4. 非目标

- 不设计一个模拟 Sequelize Model API 的兼容 facade。
- 不强求 SQLite 与 PostgreSQL 使用完全相同的 SQL。
- 不允许 cluster-control 多副本共享 SQLite/NFS 文件。
- 不在 3.0 首版提供任意 SQLite 到 PostgreSQL 的在线双向复制。
- 不使用数据库触发器承载 Run 领域状态机。
- 不让插件获得任意 SQL connection。
- 不用 drizzle-kit push 修改生产数据库。
- 不把 database.sqlite 和 keyv.sqlite 的普通文件复制称为一致性在线备份。

## 5. 分层边界

建议目录边界：

    back/runtime/domain/
      Run state, commands, errors

    back/runtime/ports/
      RunRepository and transaction contracts

    back/db/schema/sqlite/
      Drizzle SQLite schema

    back/db/schema/postgres/
      Drizzle PostgreSQL schema

    back/db/adapters/sqlite/
      node:sqlite connections and repositories

    back/db/adapters/postgres/
      pg pool and repositories

    back/db/adapters/legacy-sequelize/
      temporary transition adapters

    back/db/migrations/
      reviewed manifests and dialect SQL

领域层使用 camelCase 与明确类型，数据库层负责 snake_case、JSON、boolean、timestamp 和 error 映射。

禁止：

- service 直接 import sqliteTable、pgTable、Op 或 Model。
- Repository 返回 ORM entity/proxy。
- API route 接收排序字段后直接拼 SQL identifier。
- adapter 以 any 绕过字段映射。
- 为“少改代码”实现 findAll/update 风格的通用仓储。

## 6. 为什么选择 Drizzle

选择 Drizzle 的目的不是隐藏 SQL，而是获得：

- TypeScript schema 与查询字段类型。
- SQLite/PostgreSQL 方言支持。
- 可生成并审查的 SQL migration。
- 明确表达索引、约束和字段映射。
- 避免继续把领域对象继承自 ORM Model。

官方文档确认 Drizzle 原生支持 node:sqlite，也支持 node-postgres。当前两条文档仍使用 RC 安装版本，因此必须：

- package.json 和 lockfile 锁定经过验证的精确版本。
- 禁止使用不受控的 latest、next 或浮动 rc tag。
- 每次升级重新生成 schema diff，并运行两个方言的 contract/migration suite。
- 在依赖进入 Stable 前保留版本升级评审项。

Drizzle 是 adapter 工具，不是 Repository contract。若未来替换 Drizzle，领域层不应变化。

### 6.1 依赖稳定性门槛

当前版本事实不能被文档示例替代：

| 包 | 2026-07-18 审计结果 | 决策 |
| --- | --- | --- |
| `drizzle-orm@0.45.2` | stable，但无 `node-sqlite` export | 不可用于目标 adapter |
| `drizzle-orm@1.0.0-rc.4` | 有 `node-sqlite` driver/session/migrator export | 只允许锁定 exact version 的不可达 spike，接受前不得接生产流量 |
| `@keyv/sqlite@4.0.8` | 依赖 `sqlite3`，Keyv peer 为 5.x | 迁移窗口继续保留，不宣称已移除 native addon |
| `@keyv/sqlite@6.0.0-beta.4` | 依赖 `better-sqlite3`，Keyv peer 为 6 beta | 不作为移除 native addon 的路径，也不直接升级生产数据 |

进入实现时必须重新查询并记录版本状态；若 stable 已支持 `node-sqlite`，优先重新评审 stable。若仍只能使用 RC，spike 必须同时锁定 ORM、Kit 和 Node patch，lockfile 不允许浮动 tag。

## 7. SQLite Adapter

### 7.1 连接模型

edge/standalone 只允许 ql-core 主进程持有控制面数据库写连接：

- 使用一个 DatabaseSync connection。
- enableForeignKeyConstraints 为 true。
- enableDoubleQuotedStringLiterals 为 false。
- allowExtension 为 false。
- allowUnknownNamedParameters 为 false。
- defensive 为 true。
- busy timeout 使用显式、可配置、有限值。
- 关闭时先停止新请求、完成有界事务，再关闭连接。

Node.js 官方文档说明 DatabaseSync 的 API 全部同步执行。初始实现允许在主线程使用，但必须满足：

- 请求路径只执行有索引、结果有上限的短查询。
- migration、backup、integrity_check、VACUUM 和大批量清理不在服务请求中执行。
- 慢查询与 event-loop lag 有指标。
- edge 基准不通过时，必须把 SQLite adapter 移入专用 Worker Thread；不能通过放宽延迟门禁掩盖阻塞。

专用 Worker Thread 不是默认值，因为它会增加低内存设备的常驻开销和 RPC 复杂度。

### 7.2 写事务

SQLite 写命令使用短 BEGIN IMMEDIATE 事务：

1. 读取 Run 与 version。
2. 验证状态转换。
3. 条件更新 Run/version/event_sequence。
4. 插入 RunEvent。
5. 必要时更新 Legacy projection。
6. 立即提交。

事务中禁止：

- spawn。
- 网络请求。
- 文件上传。
- 等待 Worker。
- 模型调用。
- 大日志写入。
- 无界循环或分页扫描。

SQLITE_BUSY 只对明确可重试、尚未产生外部副作用的事务进行有界退避。达到上限后返回统一 RepositoryBusyError，由调用者决定重试，不在 adapter 内无限等待。

### 7.3 Queue claim

SQLite 不模拟 PostgreSQL SKIP LOCKED。单 ql-core writer 使用：

1. BEGIN IMMEDIATE。
2. 以 priority、queued_at_ms、id 的确定顺序选择一个或有界批次 queued Run。
3. 以 status + version 条件更新为 dispatching。
4. 创建 Attempt/Event。
5. COMMIT。

SQLite Profile 不支持多个控制面副本同时 claim。同一部署若检测到第二个 ql-core writer，启动必须失败。

### 7.4 Journal mode

不全局硬编码 WAL：

- edge 初始默认沿用 rollback journal，减少额外文件与 checkpoint 不确定性。
- standalone 可以显式启用 WAL，并在本地文件系统基准通过后成为建议值。
- 网络文件系统、共享卷或无法确认 VFS shared-memory 能力时禁止 WAL。
- cluster-control 不使用 SQLite。

SQLite 官方说明 WAL 支持读写并发，但不能用于网络文件系统，仍只有一个 writer，并需要管理 checkpoint 与 WAL 增长。任何默认值变化都必须测量：

- 空闲和任务运行时写入量。
- WAL/shm 峰值。
- checkpoint 延迟。
- 断电恢复。
- 闪存写放大。
- SQLITE_BUSY 比例。

### 7.5 时间和整数

- 时间统一存 epoch milliseconds。
- 当前可预见的 epoch milliseconds 与事件 sequence 必须处于 JavaScript safe integer 范围。
- adapter 显式决定 number/BigInt 转换，禁止依赖驱动隐式行为。
- 若字段可能超过 safe integer，领域类型必须使用 bigint 或字符串，不静默截断。

## 8. PostgreSQL Adapter

### 8.1 Driver 与 pool

cluster-control 使用 Drizzle node-postgres adapter 与 pg Pool：

- pool 大小由 Profile 资源预算和副本数共同决定。
- 每个请求/事务必须有 timeout。
- edge 构建不得初始化或连接 PostgreSQL。
- 连接失败不得自动降级到本地 SQLite。
- schema 使用 PostgreSQL 原生 boolean、jsonb 和 bigint，但映射到同一领域类型。

选择 node-postgres 而非 postgres.js 的首要原因是显式 pool 生命周期、成熟生态和按 query 配置类型解析。最终精确版本同样必须锁定。

### 8.2 Queue claim

多副本 claim 使用 PostgreSQL 行锁语义：

- 候选查询具有完整、唯一的 ORDER BY。
- 使用 FOR UPDATE SKIP LOCKED 获取有界批次。
- 在同一事务创建 Attempt、更新 Run、递增 version/sequence、追加 Event。
- Worker lease/fencing 仍按 ADR-0009 实现，不能只依赖数据库行锁。
- 隔离级别与 serialization/deadlock 错误映射为有限重试。

PostgreSQL 官方文档明确指出 SKIP LOCKED 会给出不一致视图，不适合通用查询，但适合多个消费者访问 queue-like table。本项目只在 claim 端口内使用，不用于普通 Run 列表。

### 8.3 Migration lock

cluster-control 多副本启动时只能有一个 migration leader：

- 通过 PostgreSQL advisory lock 或部署级 migration Job 获得排他权。
- 非 leader 等待有界时间并重新检查 schema version。
- migration 失败时所有新版本副本保持 not-ready。
- 不允许多个副本同时自动执行 DDL。

具体 advisory lock key、超时和部署 Job 由实现 ADR/PR 决定。

## 9. 跨方言语义契约

### 9.1 必须相同

SQLite 与 PostgreSQL 必须对以下行为给出相同结果：

- Run/Attempt/Event 创建。
- 合法和非法状态转换。
- version CAS 冲突。
- Event sequence 单调和唯一。
- dedupe key 幂等。
- terminal state 不可覆盖。
- cancel 与 exit 并发。
- idempotency key。
- 分页顺序。
- 错误码和可重试分类。
- task snapshot 与 Secret 规则。

### 9.2 允许不同

以下实现可以按方言不同：

- claim locking SQL。
- busy/deadlock/serialization retry。
- JSON 存储为 TEXT/JSON 或 jsonb。
- boolean 存储为 integer 或 boolean。
- migration DDL。
- pool/connection 数。
- journal/checkpoint。
- 索引实现细节。

### 9.3 统一错误

Repository adapter 至少映射：

    RepositoryBusyError
    VersionConflictError
    DuplicateIdempotencyKeyError
    ConstraintViolationError
    MigrationChecksumError
    DatabaseUnavailableError
    SerializationRetryExhaustedError

领域服务不得解析 SQLite 文本错误或 PostgreSQL SQLSTATE 来决定状态机行为。

## 10. Repository Transaction Contract

RunRepository 的 mutation API 必须强制事务上下文。目标形态：

    repository.transaction(async (tx) => {
      const run = await tx.findRunForUpdate(runId);
      const decision = transition(run, command);
      await tx.compareAndSetRun(decision);
      await tx.appendEvent(decision.event);
      await tx.updateLegacyProjection(decision.projection);
    });

要求：

- appendEvent 不提供绕过 transaction 的 public mutation API。
- compareAndSetRun 必须携带 expectedVersion。
- event sequence 在事务内分配。
- adapter 不能自行决定合法状态转换。
- transaction callback 不能泄漏到事务结束后使用。
- 所有 adapter 运行同一 contract suite。
- 只读列表有最大 limit 和稳定 cursor，不提供任意 offset 全表扫描作为默认 API。

## 11. Schema 与 Migration

### 11.1 Source of truth

TypeScript Drizzle schema 是目标结构的 typed source；提交到仓库的 migration SQL/manifest 是生产变更的审计事实。两者必须由 CI 检查一致，不能只保留其中一个。

SQLite 与 PostgreSQL 分别维护 schema 文件和生成配置，因为：

- 自增、boolean、JSON、partial index 和锁语义不同。
- 强行共享一个方言 schema 会隐藏真实差异。
- 领域 contract，而不是相同 DDL，保证可移植性。

### 11.2 生成和审查

每次 schema 变更：

1. 修改两个方言 schema。
2. 使用锁定版本的 Drizzle Kit generate 或 custom migration 生成候选。
3. Maintainer 审查 SQL、锁范围、表重建、索引和数据转换。
4. 为旧版 fixture 增加 migration test。
5. 运行空库、升级、重复执行、失败恢复和 downgrade-read 测试。
6. 将 migration 与 checksum 提交。
7. 应用 runner 执行，不在生产调用 Kit CLI。

Drizzle 官方支持生成普通或 custom migration，也允许外部 runner 执行生成结果。QingLong 使用这一模式，不使用 push。

### 11.3 Baseline

2.x SQLite：

- 保留现有表名和字段名。
- 使用 introspection 区分已有 baseline 与待增量字段。
- SchemaMigrations 记录已确认的 baseline/incremental migration。
- 不对已有生产库执行全量 CREATE 或 blind push。
- baseline manifest 只声明项目拥有的 required table/column/index；未知对象不参与 destructive diff，默认保留。
- 旧库异常必须明确报错并提供修复说明，不能 catch 后继续。

PostgreSQL：

- 3.0 首版只支持空库 baseline 或受支持的 3.x migration。
- SQLite 到 PostgreSQL 的导入是独立、可校验、可回滚的离线工具，不是应用启动隐式行为。

### 11.4 Checksum

- migration ID 永久唯一。
- checksum 覆盖该 migration stream 的方言 SQL、数据转换代码和 manifest；ADR-0037 冻结现有 SQLite `0001–0024`，PostgreSQL 使用独立 `pg-*` stream，通过 schema contract version 表达跨方言逻辑兼容，禁止为追加另一方言内容而修改已应用 checksum。
- 已应用 migration 内容不得修改；修复使用新 migration。
- 当前未发布的 0001/0002 可以在 next Alpha 前调整，一旦预发布即冻结。
- checksum mismatch 阻止启动并输出 migration ID，不自动覆盖数据库记录。

### 11.5 Schema drift

启动时只验证 migration history 和必要 capability，不做全库昂贵 diff。CI/诊断命令负责完整 schema drift 检查。

`next` 的正式 Local 3.0 只读诊断必须显式选择数据库与部署 Profile：

    pnpm audit:schema:ql3 -- --database=/opt/qinglong3/qinglong3.sqlite --profile=edge

它在 Node 24 中复用 `@qinglong/local-sqlite/readiness-inspection`，以 defensive、query-only
`node:sqlite` 验证正式 migration checksum/history、capability、required schema、foreign key、
quick-check 和 repository integrity，同时要求 edge=`DELETE`、standalone=`WAL`。数据库必须是
当前 UID 的 canonical `0600` regular file；结果不含路径或业务数据，也不执行自动修复。

历史 `back/migrations` ownership drift 工具保留为显式 legacy/Shadow 命令：

    pnpm audit:legacy-schema:ql3 -- --database=/absolute/legacy.sqlite --json

它不再默认打开 `data/db/database.sqlite`。报告依据 legacy ownership manifest 区分 missing owned、
unmanaged 和 unknown objects；`--fail-on-drift` 可让 CI 严格拒绝未知对象。该报告不能作为
fresh/adopted 3.0 readiness 证据。

生产禁止：

- sync alter。
- drizzle-kit push。
- 自动 drop/recreate。
- 忽略未知列或约束错误。
- 在没有备份时执行破坏性重建。

### 11.6 单一 migration 历史

Drizzle schema 是 typed query/schema source，Drizzle Kit 是开发期候选 SQL 生成器；现有应用 runner 是生产 migration authority。两者不能各自写一套互不知情的历史表：

1. Kit 生成的 SQL 先经过人工审查和兼容 fixture 验证。
2. 审查后的方言 SQL、数据转换和 ownership manifest 共同计算 checksum。
3. 应用 runner 以现有 `SchemaMigrations` 记录稳定 ID、checksum 和应用时间。
4. 已有 `0001` 至 `0005` 继续属于同一线性历史，不重新标记为 Drizzle baseline，也不静默跳过。
5. 运行时不得调用 Kit CLI；诊断可比较 schema，但默认不执行修复。

## 12. Legacy Sequelize 迁移

### 12.1 临时 Run adapter

为了先验证 Run Runtime，允许实现 SequelizeRunRepository：

- 位于 legacy-sequelize adapter 目录。
- 使用现有 sequelize connection 和 transaction。
- 返回纯 RunRecord/Attempt/Event 类型。
- 实现 CAS、sequence、dedupe 和错误映射。
- 通过 SQLite RunRepository contract suite。
- 默认只服务 off/shadow 阶段。
- 文件头和 tracking issue 明确删除条件。

它不能：

- 让 Runtime service import Sequelize。
- 暴露 Model。
- 成为 Package/plugin SDK。
- 为新功能扩展通用 Sequelize 基础设施。
- 阻止后续 Drizzle adapter 替换。

这不是最终方向，而是避免在 Run Runtime 验证前一次性迁移全部旧 CRUD 的风险隔离层。

### 12.2 数据域迁移顺序

建议顺序：

1. Run/RunAttempt/RunEvent。
2. App/System/Auth/CronView。
3. Dependence/Env/Subscription。
4. Crontab/RunningInstance/CronStats。
5. Keyv store。
6. 删除 Sequelize/sqlite3/@keyv/sqlite。

每一组：

- 建立 Repository port 或明确 service query。
- 增加旧库 fixture 与 contract test。
- 切换读取。
- 切换写入。
- 观察一个版本窗口。
- 删除旧调用。

禁止构造一个兼容 Model.findAll/Op 的新 facade。

## 13. Keyv 数据迁移

keyv.sqlite 必须进入迁移范围，否则：

- native sqlite3 依赖仍存在。
- 备份仍跨两个数据库。
- Auth/App/Language 状态与主库无法原子更新。

目标：

- authInfo 进入明确的 auth/system typed table。
- apps 以现有 Apps 表或新的 typed projection 为事实源。
- lang 进入系统设置表。
- 通用短期 KV 如仍需要，使用主 database.sqlite 的 KeyValueStore 表，带 namespace、version、updated_at 和可选 expires_at。

迁移步骤：

1. 只读解析 keyv.sqlite。
2. 校验 key、JSON shape 和主库冲突。
3. 在主库事务写入。
4. 写 migration marker 与数据摘要。
5. read-through 验证一个窗口。
6. 停止写 keyv.sqlite。
7. 备份并保留旧文件一个弃用周期。
8. 移除 @keyv/sqlite。

在两个数据库并存期间，升级备份 manifest 必须同时列出两个文件，并在短暂停写窗口获取一致版本；不能声称普通并行复制是原子快照。

`@keyv/sqlite` v6 beta 当前仍引入 `better-sqlite3`，且其 namespace、TTL 和表结构能力相对现有 v4 有变化，因此不使用“直接升级 v6”替代上述数据迁移。若未来稳定版提供纯 `node:sqlite` 路径，也必须先在 key/value serialization、namespace、TTL、并发和旧 `keyv(key,value)` 表 fixture 上通过兼容测试，不能自动接受 schema migration。

## 14. Backup 与 Restore

### 14.1 SQLite

升级前使用 SQLite Online Backup API，而不是直接 cp 正在写入的文件。Node 24 node:sqlite 提供 backup(sourceDb, path)，返回 Promise 并支持分批进度。

流程：

1. 拒绝新的 mutation，等待有界事务完成。
2. 在线备份到同文件系统临时路径。
3. 对备份执行 quick_check/integrity_check。
4. 写 manifest：源版本、migration IDs、大小、hash、时间、Node/SQLite 版本。

`next` 当前增加了两个仅在 Node 24 执行的兼容 spike：Online Backup/restore 测试使用分批 `backup()` 复制 WAL 源库，在备份过程中从同一连接追加事实，随后对备份执行 `integrity_check`、restore、`quick_check`、行数与 SHA-256 校验；schema 测试先由当前 Sequelize runner 执行 0002 至 0005，再用启用 defensive、关闭 extension 且 read-only 的 `DatabaseSync` 打开同一文件，核对表列、完整性和拒绝写入。二者已在 macOS arm64 的临时 Node 24.18.0 进程实跑通过，Node 20/22 测试明确 skip；CI 和 Linux 多架构未实际跑通前不能把它记为发布能力。该 spike 也不替代正式的停写协调、双数据库 manifest、权限和容量检查。
5. fsync 文件与目录后原子 rename。
6. 运行 migration。
7. 启动后执行核心读写 smoke test。
8. 失败时停止服务并给出 restore 命令，不在运行中覆盖原库。

备份保留策略考虑小容量路由设备：

- 先检查可用空间。
- 峰值空间预算至少包含原库、WAL/journal、临时备份和 migration 重建。
- 超出预算时拒绝升级并明确原因。
- 自动保留数量有上限。

### 14.2 PostgreSQL

应用不自行复制 PostgreSQL 数据目录。集群部署依赖：

- 平台 snapshot、pg_dump/pg_restore 或托管备份。
- migration 前 backup precondition hook。
- 恢复演练和 RPO/RTO 由部署文档定义。

### 14.3 Restore 兼容

forward migration 默认不自动 down。应用回滚版本必须能：

- 忽略新增表/可空列。
- 在 schema capability 不兼容时拒绝启动。
- 通过备份恢复到旧 schema，而不是尝试逆向猜测数据转换。

## 15. 资源与性能门禁

### 15.1 edge/standalone

至少测量：

- 打开 connection 后额外 RSS。
- 空闲 event-loop lag。
- Run create + two Event transaction p50/p95/p99。
- 1、10 个并发 API 请求下的 stall。
- 100、1000、10000 个 Run 查询。
- migration 峰值 RSS、时间、临时磁盘。
- backup 吞吐和 API 延迟。
- rollback journal 与 WAL 的写入量。
- 意外断电/kill -9 后恢复。
- SQLITE_BUSY 与 retry 次数。

所有 query 必须有 statement timeout 或可证明的 bounded input。SQLite 同步 API 的 p99 超出预算时，评估 Worker Thread，而不是增加并发 connection。

`next` 提供 `pnpm benchmark:db:node-sqlite`：在 Node 24 上使用 rollback journal、`synchronous=FULL` 和短 `BEGIN IMMEDIATE` 事务写入一条 Run 与两条 Event，报告 transaction p50/p95/p99、最大同步 batch、RSS、文件大小和 `integrity_check`。它只测 runtime/host 边界，不是生产手写 SQL adapter，也不能替代固定路由设备基准。

### 15.2 cluster-control

至少测量：

- 多副本 claim 吞吐。
- 重复 claim 为零。
- lock wait、deadlock、serialization retry。
- pool saturation。
- primary/replica failover。
- migration leader 竞争。
- 连接断开时的 lost/lease 协调。

## 16. Security

- 所有值使用参数绑定。
- 动态排序字段通过 schema-column allowlist。
- SQLite extension 永久默认关闭。
- defensive mode 开启。
- 数据库文件与备份权限不宽于现有 data 目录。
- PostgreSQL 使用最小权限账号；runtime 与 migration 账号可分离。
- callback token hash、Secret ref 与加密材料不进入普通 query log。
- 生产默认不记录完整 SQL 参数。
- 插件只能调用受 Policy 控制的领域 API，不能获取 db handle。
- migration SQL 属于受审代码，禁止远程 Package 注入。

## 17. Rollout

### Stage A：当前基线

- 显式 SchemaMigrations runner。
- 0001 Legacy columns。
- 0002 Run schema。
- Sequelize 仍为唯一 active driver。

### Stage B：Run Runtime 验证

- 实现临时 SequelizeRunRepository。
- 完成纯状态机与 Repository contract。
- 只启用 manual shadow。
- 不引入第二个 SQLite connection。

### Stage C：Drizzle/node:sqlite spike

- 锁定 Node 24 和 Drizzle 精确版本。
- 建立 Drizzle SQLite schema。
- 在 fixture copy 上验证与 0001 至 0005 schema 完全兼容，并证明未知表、列和索引保持不变。
- 完成 Node 24 多架构、seccomp、WAL、backup、event-loop 基准。
- 通过显式 test factory 注入，不修改生产默认 driver，不接生产流量，也不对同一 live database 启用双写。

`next` 的 ADR-0063 已完成一个面向全新 3.0 数据库的独立 `@qinglong/local-sqlite` vertical slice：Node 24 `DatabaseSync`、typed schema、reviewed migration、readiness、完整 RunRepository contract 与 edge/standalone storage-only 组合均已通过本机测试。该实现没有接管 legacy `database.sqlite`，也不满足本 Stage 对旧 fixture、backup、全架构和物理 edge 基准的全部要求，因此仍属于 Incubating，而不是 Stage D 生产切换。

### Stage D：SQLite adapter 切换

- DrizzleSQLiteRunRepository 通过相同 contract suite。
- 小范围 Shadow 切换。
- 按数据域迁移旧查询。
- 同一进程禁止长期并存两个写 connection；切换必须明确 connection owner。

### Stage E：PostgreSQL cluster

- 按 ADR-0037 建立独立 `pg-*` PostgreSQL schema/migration stream，不修改 SQLite migration checksum。
- DrizzlePostgresRunRepository 通过相同 contract。
- 多副本 claim/lease/fencing 测试通过。
- cluster-control Profile 才能启用。

### Stage F：移除 Legacy DB stack

只有同时满足：

- 所有 Sequelize import 清零。
- keyv.sqlite 数据迁移完成。
- sqlite3/@keyv/sqlite 无运行时调用。
- 支持架构 Node 24 镜像与恢复测试通过。
- 至少一个预发布观察窗口无阻塞问题。

才移除依赖。

## 18. 进入 Drizzle 实现的门禁

1. Maintainer 接受本 ADR。
2. 选择并锁定 exact Drizzle ORM/Kit 版本。
3. 明确 Node 24 exact patch，记录 node:sqlite stability 状态。
4. node:sqlite 在全部承诺架构上启动和读写通过。
5. database.sqlite fixture introspection 完成。
6. 0001/0002 与 Drizzle schema diff 为零或有已审查解释。
7. backup/restore spike 通过。
8. DatabaseSync event-loop benchmark 在 edge 预算内。
9. 临时 Sequelize adapter 的删除计划和 owner 明确。
10. 不使用 drizzle-kit push。
11. ownership manifest 与包含未知表/列/索引的 fixture preservation test 通过。
12. D-14/D-16 的正式支持架构冲突已经由 Maintainers 选择并记录，不能用本机单架构测试代替。

## 19. 被拒绝的方案

### 19.1 直接把 sqlite3 换成 better-sqlite3

Sequelize 6 与 @keyv/sqlite 依赖 sqlite3 风格 API，driver-only 替换不能解决 ORM/Keyv 迁移，也保留 native addon 的 ABI/架构风险。

### 19.2 只迁移 Run 表，永久保留 Sequelize

这会形成两套长期数据访问范式，继续携带 sqlite3 和 Keyv 原生依赖，违背 typed schema 与多架构目标。

### 19.3 先写一个 ORM 兼容 facade

模拟 findAll、Op 和 Model 会把旧抽象永久复制到新系统，动态查询仍难以约束，后续维护更差。

### 19.4 所有 Profile 都用 PostgreSQL

会破坏路由、NAS 和单机用户的零外部服务部署路径。

### 19.5 cluster 多副本共享 SQLite 卷

WAL 不能跨网络文件系统提供所需 shared memory 语义，SQLite 也只有一个 writer，不满足控制面多副本一致 claim。

### 19.6 SQLite 与 PostgreSQL 强制共享一份 DDL

两种数据库的 JSON、boolean、索引、锁和 migration 行为不同。共享领域 contract，分别维护方言 schema 更诚实、更可测。

### 19.7 生产 drizzle-kit push

push 会直接比较并修改 live schema，不符合已有用户库需要的 review、backup、checksum 和可重复升级要求。

### 19.8 直接 cp 活跃 SQLite 文件

活跃数据库可能处于写入/WAL 状态，普通复制不能替代 Online Backup API 和一致性检查。

### 19.9 同时打开 Sequelize sqlite3 与 node:sqlite 长期双写

两个连接栈会增加锁竞争、SQLite 版本差异和状态不一致风险。过渡期优先使用同一 Sequelize connection；最终以明确 owner 切换到 node:sqlite。

### 19.10 直接升级到 @keyv/sqlite v6 beta

当前 beta 仍直接依赖 better-sqlite3，不能消除原生 addon 风险，同时带来 Keyv major、schema 和序列化迁移。它不满足“低风险移除 sqlite3”的目标。

## 20. 影响

### 正面

- 新 Runtime 不再绑定 ORM。
- edge 与 cluster 共享领域语义但不伪装 SQL 相同。
- 依赖替换可按数据域推进。
- 现有用户库、Keyv 和多架构风险都进入正式计划。
- backup 与 migration 成为发布门禁。
- 临时 adapter 允许更早验证 Run 状态机。

### 负面

- 迁移期存在额外 adapter 和 contract tests。
- SQLite/PostgreSQL 需要维护两份 schema/migration。
- node:sqlite 与 Drizzle 当前仍有 RC 风险。
- DatabaseSync 需要严密 event-loop 性能门禁。
- 移除 sqlite3 必须等 Keyv 和全部 Legacy CRUD 完成，周期较长。

## 21. 验证矩阵

| 场景 | SQLite | PostgreSQL |
| --- | --- | --- |
| 空库 migration | 必须 | 必须 |
| 2.x 原地升级 | 必须 | 不适用 |
| migration 重复执行 | 必须 | 必须 |
| checksum mismatch | 必须失败 | 必须失败 |
| Run/Event 原子事务 | 必须 | 必须 |
| CAS 并发冲突 | 必须 | 必须 |
| dedupe callback | 必须 | 必须 |
| queue claim | 单 writer | 多副本 SKIP LOCKED |
| cancel/exit race | 必须 | 必须 |
| backup/restore | Online Backup | 平台/pg 工具 |
| 断电/进程崩溃 | 必须 | failover |
| edge 资源预算 | 必须 | 不适用 |
| 多架构镜像 | 必须 | adapter/client 必须 |

## 22. 接受标准

- 接受 Repository port 为领域唯一数据库边界。
- 接受 edge/standalone 使用 SQLite、cluster-control 使用 PostgreSQL。
- 接受最终 SQLite 为 Drizzle + node:sqlite，PostgreSQL 为 Drizzle + node-postgres。
- 接受方言 schema/SQL 分开、领域 contract 统一。
- 接受生产禁用 drizzle-kit push。
- 接受 baseline + incremental migration 与单一 SchemaMigrations 历史。
- 接受 keyv.sqlite 必须迁移后才能移除 sqlite3。
- 接受临时 SequelizeRunRepository 只作为受限过渡 adapter。
- 接受 DatabaseSync 同步阻塞、多架构和 RC 状态属于发布门禁。
- 接受 SQLite Online Backup 与 PostgreSQL 外部备份分别实现。
- 接受 ownership manifest 与 unknown-object preservation 是旧库原地升级的强制边界。
- 接受当前不以 `@keyv/sqlite` v6 beta 替代正式 Keyv 数据迁移。
