# ADR-0038：Cluster Driver 独立交付与 PostgreSQL 依赖基线

- 状态：Proposed
- 日期：2026-07-19
- 关联：QL-RFC-0001、ADR-0006、ADR-0037

## 上下文

QingLong 3.0 必须同时覆盖低性能路由设备和多副本集群。当前仓库只有一个根 `package.json`，Alpine/Debian 镜像都把根生产依赖完整安装到 `/ql/node_modules`。因此仅使用动态 `import('pg')` 只能避免启动时加载，不能避免 edge 镜像下载、解压和保存 PostgreSQL driver。

当前交付基线还有三项不一致：

- legacy Alpine builder 使用 Node 18，Debian 使用 Node 20；两者都不是 QL3 的 Node 24 目标；
- `ql3-ci.yml` 同时运行 Node 20/24，Node 20 只能作为迁移期兼容观察，不能继续定义 QL3 cluster runtime；
- 根后端使用 CommonJS、TypeScript 5.2 和旧 `@types/node`，直接把新 ORM 类型面扩散到全部 `back/**` 会扩大迁移范围。

截至 2026-07-19 的上游事实是：

- Node 24.18.0 是 LTS；Node 20 已 EOL；
- `pg` 8.22.0 的官方兼容矩阵包含 Node 24，且 CommonJS 仍受支持；
- Drizzle ORM 0.45.2 是稳定版本，包含 identifier/alias escaping 安全修复；1.0 仍为 RC；
- Drizzle Kit 0.31.10 是对应稳定工具线；
- PostgreSQL 官方仍支持 14–18，但 14 将于 2026-11 EOL，16–18 更符合新 3.0 产品的维护窗口。

参考：

- [Node.js release schedule](https://nodejs.org/en/about/previous-releases)
- [Node.js 24.18.0 LTS](https://nodejs.org/en/blog/release/v24.18.0)
- [node-postgres compatibility](https://node-postgres.com/)
- [Drizzle PostgreSQL with node-postgres](https://orm.drizzle.team/docs/get-started-postgresql)
- [Drizzle releases](https://github.com/drizzle-team/drizzle-orm/releases)
- [PostgreSQL versioning policy](https://www.postgresql.org/support/versioning/)

## 决策

### 1. 固定首个 cluster vertical slice 的版本

首个可执行 vertical slice 使用 exact version，不使用 `^`、`~` 或 prerelease tag：

| 组件 | 固定版本 | 用途 |
| --- | --- | --- |
| Node.js | `24.18.0` | cluster build、migration Job 与 runtime |
| `pg` | `8.22.0` | 纯 JavaScript Pool/Client driver |
| `drizzle-orm` | `0.45.2` | typed schema 与 Repository query builder |
| `drizzle-kit` | `0.31.10` | 仅开发期 schema diff、SQL export/check |
| `typescript` | `5.9.3` | cluster package 独立严格类型构建 |
| `@types/node` | `24.13.3` | cluster package 的 Node 24 类型边界 |
| `@types/pg` | `8.20.0` | cluster package 开发类型 |
| PostgreSQL | `16`–`18` | 生产支持范围；CI 覆盖最低与最高版本 |

不安装 `pg-native`，避免为 cluster driver 增加 libpq、编译器、musl/glibc 和多架构 native prebuild 边界。版本升级必须是独立 PR，附带生成 SQL diff、migration checksum 审计、双方言 contract suite、安装体积和 RSS 对比。

Node 20 只作为 2.x 兼容迁移的临时测试输入；新的 `pg-*` migration、cluster package 和 cluster-control readiness 不支持 Node 20。正式 QL3 镜像必须统一到固定 Node 24 patch，不能继续从发行版包管理器取得未固定的 `nodejs`。

### 2. Cluster driver 是独立 package，不是根 optional dependency

目标 workspace 至少拆出：

```text
@whyour/qinglong                 legacy compatibility app / edge / standalone
@qinglong/cluster-postgres      pg + Drizzle adapter 与 pg-* migration binding
@qinglong/cluster-control       显式组合 core 与 cluster-postgres 的集群入口
```

根 package 不把 `pg`、`drizzle-orm` 或 `@qinglong/cluster-postgres` 放入 `dependencies`、`optionalDependencies` 或自动安装的 peer。edge/standalone 发布物只能安装根 importer；cluster-control 发布物显式安装 cluster assembly importer。

动态 import 仍用于延迟初始化，但它不是依赖隔离的证据。隔离必须由 lockfile importer、profile-specific image stage 和产物内容审计共同证明。

在 workspace 拆分完成前，driver-neutral PostgreSQL migration Store 可以保留在公共 core 中，但只能依赖 QingLong 自己定义的 `Pool/Client/QueryResult` 端口；实际 `pg.Pool` 绑定只能存在于 cluster package。

### 3. Drizzle 管 schema/query，不接管生产 migration history

Drizzle schema 是类型与 SQL 生成输入，Drizzle Kit 只允许在开发/CI 执行：

- `generate`/`export` 产生待审查 SQL；
- `check` 验证 snapshot 分支和生成结果；
- 生成 SQL 经 canonical 化后固定为 `pg-*` migration 内容并计算 SHA-256；
- 生产 migration Job 只调用 QingLong 的 dialect-neutral migration stream。

生产环境禁止 `drizzle-kit push`、自动 introspection 后写库或独立 Drizzle migration history。否则会出现两个 history、不可审查 schema alter 和 runtime/migration role 混权。

### 4. Migration 与 runtime 使用不同 entrypoint 和 role

Cluster package 至少导出两个不共享 Secret 默认值的入口：

- `migration`：允许 DDL，取得固定 advisory lock，执行 `pg-*` stream 后退出；
- `runtime`：无 DDL 权限，只验证 history/schema capability，然后创建有界 Pool。

两者都必须配置 TLS 验证、`application_name`、固定 `search_path`、statement/lock/idle-in-transaction timeout。连接 URI 不进入日志、错误详情、RunEvent 或诊断 bundle。

### 5. Profile-specific 构建是发布门禁

edge/standalone 产物必须证明：

- `node_modules` 不包含 `pg`、Drizzle PostgreSQL entrypoint 或 cluster assembly package；
- import graph 和 `require.cache` 不出现 cluster package；
- 未创建 PostgreSQL DNS、socket、Pool、retry timer 或 Secret read；
- 与加入 cluster workspace 前相比，安装体积、冷启动和 RSS 回归在预算内。

cluster-control 产物则必须证明它包含 exact 版本、没有 `pg-native`，并能在 PostgreSQL 16 与 18 上通过 migration/contract/fencing 测试。

## 当前孵化状态

`next` 已新增 driver-neutral `PostgresMigrationStreamStore`：

- 公共代码不 import `pg`；
- history bootstrap 与每条 migration 都在 PostgreSQL transaction 中取得固定双 int32 advisory lock；
- lock 使用 `pg_try_advisory_xact_lock`，竞争者 fail closed，不无限等待；
- transaction 内设置 statement、lock 与 idle-in-transaction timeout；
- history 表使用 `pg-*` ID、64 位小写 SHA-256、非负 bigint 时间；
- migration work 与 history insert 同事务提交，失败回滚；
- bigint 时间只允许 JavaScript safe integer，损坏 history fail closed。
- core 在任何新 DDL 前枚举 history，拒绝未知 ahead ID、非前缀缺口、重复记录和 checksum/stream/dialect 漂移；
- `pg-0001-schema-capability`、`pg-0002-run-core` 和 `pg-0003-run-retry-policy` 已建立首批 SQL stream，只创建 Run、RunAttempt、RunEvent、RunRetryPolicy 与 bounded indexes，不复制 local/legacy 表；
- 本机一次性 PostgreSQL 13 实例已实际验证三条 migration 的 SQL 语法、deferred capability/history 提交和最终 6 表集合；目标支持证据仍必须来自 PostgreSQL 16/18 CI。

当前 `next` 已创建 `packages/ql3-runtime-core`、`packages/ql3-cluster-postgres` 与 `packages/ql3-cluster-control` 三个独立 importer，并 exact pin/lock 全部 dependency section。workspace 禁止从根解析 peer，避免 Drizzle 因 legacy 根 `sqlite3` 形成隐式 native peer；`@types/pg` 被定向固定到 Node 24 类型。根 importer 仍不声明 runtime-core、`pg`、Drizzle 或 cluster package。

`@qinglong/cluster-postgres` 已实现真实 `pg.Pool` 结构绑定和 lazy database opener：构造 opener/Resource 不建连接，readiness/Repository 首次 query 才连接；runtime/migration 使用独立 application name、Pool 上限、timeout 与显式 TLS 配置，固定 `search_path`，bigint 继续按字符串解析，`pg-native` 未安装。本机 PostgreSQL 13 已额外通过完整共享 RunRepository contract 和双角色验证：runtime 可读取 history/capability 并执行 Run DML，但 DDL 以 `42501` 拒绝。PG13 仍只是额外语法/driver 下限，不改变 PostgreSQL 16/18 integration gate。

`@qinglong/cluster-postgres` 已增加六表 Drizzle typed schema，并与 reviewed schema contract 的 columns、18 个 index、39 个 CHECK 和 7 个 FK 做精确 metadata lockstep。包级 TypeScript 继续严格检查自身源码，但对 Drizzle 发布包中未安装的 Gel/MySQL/SQLite 可选方言声明启用 `skipLibCheck`；不得为消除第三方可选声明错误而把无关 driver 安装进 PostgreSQL 产物。生产仍只执行 QingLong `pg-*` migration stream。

PostgreSQL 16/18 × x64/arm64 CI matrix、真实 `pg.Pool` Repository contract、readiness 和双角色最小权限测试已经接线，远端矩阵成功证据仍待 CI 实际运行。`@qinglong/runtime-core` 已公开 migration/activation/RunRepository contract；PostgreSQL migration、readiness 与 RunRepository 已迁入 `@qinglong/cluster-postgres`，cluster integration 不再引用 legacy 根实现。cluster-postgres 使用受 `exports` 限制的 `runtime`/`migration` 子入口：前者只装入 history manifest、readiness、Pool 和 Repository，后者才装入 executable DDL stream；lockstep test 固定两者 ID/checksum 一致。`@qinglong/cluster-control` 已声明独立 build/export，并实现 readiness-first 可执行组合根，在 readiness 成功后创建真实 PostgreSQL RunRepository，再把已证明的资源交给 production stack factory。当前缺口是完整 control-plane stack、admission/API、独立镜像/SBOM 和多副本故障演练，而不是 driver 或 Repository package 边界。typed schema 权威关系由 ADR-0043、兼容副本退出条件由 ADR-0044 继续约束。

## 影响

正面影响：

- edge 不为 cluster driver 支付磁盘、安装时间、RSS 或 native 供应链成本；
- 新 cluster 代码可以采用现代类型和 Node 24，而不一次性改写全部 legacy 后端；
- SQL 生成、不可变 history 和生产权限边界各自清晰；
- exact 版本与独立升级 PR 便于多架构复现和回滚。

代价与风险：

- 仓库从单 package 走向 workspace，镜像、缓存和发布流程必须同步改造；
- core/cluster assembly 的 API 边界需要稳定导出，不能依赖跨 package 深层相对路径；
- Drizzle 0.x 到未来 1.x 需要独立评估，不自动随 minor/RC 漂移；
- fake driver 测试无法发现 PostgreSQL catalog、锁、权限、TLS 和 failover 差异。

## 未选择的方案

1. **把 `pg`/Drizzle 直接加入根 dependencies**：所有 edge 镜像都会安装，拒绝。
2. **只做 dynamic import**：只能降低启动加载，不能降低产物体积，拒绝。
3. **把 driver 放 optionalDependencies**：当前所有镜像默认仍安装 optional dependency，拒绝。
4. **采用 Drizzle 1.0 RC**：基础契约仍可能破坏性变化，首个稳定 vertical slice 不采用。
5. **生产执行 `drizzle-kit push`**：绕过不可变 migration review/history 与最小权限，拒绝。
6. **安装 `pg-native` 获取约 10% 性能收益**：收益未经 QingLong workload 证明，却扩大多架构 native 风险，拒绝。
7. **继续支持 Node 18/20 cluster runtime**：与 QL3 Node 24 能力、上游生命周期和新镜像目标冲突，拒绝。

## 验证要求

- package manager lock 中上述版本完全固定且没有 prerelease；
- edge/standalone 与 cluster-control 使用不同 importer/产物审计；
- Node 24.18.0 下 x64/arm64 的 CJS build、migration 和 runtime smoke test 通过；
- PostgreSQL 16 与 18 均通过空库 migration、重放、checksum drift、leader competition 和 rollback；
- runtime role 创建 schema/table/index 必须失败，但 history/capability audit 成功；
- migration role 不作为常驻 runtime Secret；
- `pg-native` 在依赖图和产物中缺席；
- Drizzle 生成 SQL 只有经人工审查、canonical checksum 固定后才能进入 `pg-*` stream；
- edge import/RSS/安装体积门禁和 cluster 多 Pool/failover 门禁同时通过。
