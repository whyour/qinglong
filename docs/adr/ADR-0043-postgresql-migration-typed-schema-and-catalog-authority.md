# ADR-0043：PostgreSQL Migration、Typed Schema 与 Catalog 权威边界

- 状态：Proposed
- 日期：2026-07-19
- 关联：QL-RFC-0001 D-17/D-34/D-35/D-36/D-41、ADR-0038、ADR-0039、ADR-0042

## 上下文

cluster-control 同时需要可审查的不可变升级、应用层类型安全和启动时 drift 检测。把 Drizzle schema 当作生产 migration 会产生第二套 history；只保留手写 SQL 又容易让 Repository 类型与实际列漂移；只核对 table/column/index 名称则会在 CHECK 或 FK 被删除后错误判定 ready。

Drizzle 0.45.2 的顶层类型声明还覆盖 Gel、MySQL、SingleStore 与 SQLite 等可选方言。为了让 PostgreSQL 专用 package 的依赖声明全部通过类型检查而安装这些无关 driver，会破坏 Profile 产物隔离和供应链预算。

## 决策

### 1. 单一生产 DDL 权威

reviewed、checksum 不可变的 QingLong `pg-*` migration stream 是唯一生产 DDL 执行入口。`drizzle-kit push`、应用启动自动同步和直接从 typed schema 修改生产库全部禁止。Drizzle Kit 只能生成待审查的候选 SQL；合并后仍转换为显式 migration ID、checksum、capability 与 rollback/roll-forward 评审。

### 2. 三层互证而非三套事实源

三层职责固定为：

1. migration stream：定义有序、事务化的实际变更；
2. schema contract + Drizzle schema：前者声明受 QingLong 严格拥有的对象集合，后者提供类型化查询 metadata；
3. PostgreSQL catalog readiness：验证目标数据库实际状态与 contract 精确一致。

当前 contract 覆盖 `ql3` 的 6 张表、全部 columns、18 个 index、39 个命名 CHECK 与 7 个命名 FK。Drizzle metadata 必须与该 contract lockstep；真实 runtime role readiness 必须从 `information_schema`、`pg_indexes` 和 `pg_constraint` 读取实际对象，任何缺失或额外核心对象都 fail closed。

约束名称一致不替代 migration checksum。特别是 `schema_capabilities → schema_migrations` 的 `DEFERRABLE INITIALLY DEFERRED` 仍由 reviewed migration 定义；当前 Drizzle builder 无对应表达能力时，不得为了让两个文本看起来相同而削弱数据库事务语义。

### 3. Driver 与 Core 边界

`@qinglong/runtime-core` 拥有 Profile-neutral activation/migration/RunRepository contract 和 PostgreSQL driver-neutral query/client/pool/resource shape，不依赖 `pg` 或 Drizzle。`@qinglong/cluster-postgres` 实现 Pool、typed schema、migration/readiness 和 PostgreSQL Repository adapter；legacy 根只在迁移期保留兼容副本，不得成为 cluster package 的反向依赖。

## 当前孵化状态

reviewed `pg-0001/0002/0003` migration、schema contract、readiness auditor 与六表 Drizzle schema 已全部迁入 `@qinglong/cluster-postgres` 并从公开 package export 使用。公开 `runtime` 子入口只加载 metadata-only history manifest、readiness、Pool 与 Repository，`migration` 子入口才加载 executable DDL stream；静态测试同时锁定 manifest/stream ID/checksum，并精确核对 6 表、18 个索引、39 个 CHECK 和 7 个 FK。package integration 直接运行自身 migration/readiness/Repository，不再 deep import legacy 根实现。PostgreSQL 16/18 × x64/arm64 的真实 catalog 与 runtime-role CI 已接线，远端成功证据仍待运行。

### 4. 第三方声明检查边界

`@qinglong/cluster-postgres` 对自身源码保持 `strict`、`noUncheckedIndexedAccess` 与 `exactOptionalPropertyTypes`。package-local `skipLibCheck: true` 只跳过已发布依赖的 `.d.ts` 复核，以避免安装未使用的可选方言 peer；本包 build、schema metadata contract、真实 PostgreSQL integration 和 exact dependency audit 仍是强制门禁。

## 影响

正面影响：

- migration、类型访问和实际 catalog 的责任清晰；
- CHECK/FK drift 不会在滚动升级中静默通过；
- edge/standalone 不为 Drizzle 或 PostgreSQL driver 支付安装成本；
- 不因第三方多方言声明面污染 cluster 产物。

代价与风险：

- 每个 migration 必须同步 schema contract、Drizzle schema 和 integration test；
- contract 当前精确验证对象集合与权限，但约束表达式和 index expression 的全文规范化仍主要由 immutable checksum 保证；
- Drizzle 升级需要重新评估 metadata API、可选 peer 和 SQL 生成差异。

## 未选择的方案

1. **生产执行 `drizzle-kit push`**：绕过 migration identity、checksum 与角色隔离，拒绝。
2. **只保留 Drizzle schema**：不能表达全部 reviewed PostgreSQL 语义，拒绝。
3. **只检查 migration history**：无法发现应用后被人工修改的 catalog，拒绝。
4. **安装所有 Drizzle 可选方言 peer**：增加无关 driver 与供应链面积，拒绝。
5. **全局放宽 TypeScript strictness**：会掩盖本包源码错误，拒绝。

## 验证

- Drizzle 6 表 metadata 与 contract 的 columns/index/CHECK/FK 集合精确相等；
- readiness fake-query tests 能拒绝额外对象和约束；
- PostgreSQL 16/18 × x64/arm64 integration 用 runtime role 执行完整 catalog/权限 readiness；
- cluster importer exact audit 拒绝额外依赖、错误版本、错误 workspace link、`pg-native`、SQLite peer 污染和 package 源码边界逃逸；
- root edge importer/import closure 继续不包含 `pg`、Drizzle 或 cluster package。
