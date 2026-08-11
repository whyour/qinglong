# ADR-0335：PostgreSQL Model Price Catalog Repository 领域归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-37、D-85、D-87、D-157、D-161、D-213、D-243、D-244、D-257
- 关联 ADR：ADR-0172、ADR-0173、ADR-0174、ADR-0276、ADR-0331、ADR-0333、ADR-0334

## 背景

ADR-0334 已把 Local SQLite Price Catalog repository 收敛为同包领域目录。其 Cluster 对应实现
`pricing/storage/postgresModelPriceCatalogRepository.ts` 有 1,074 行，并在两个公开 class 内同时拥有：

1. SQLSTATE/error mapping、identity、JSONB、bigint、nullable row codec；
2. publication、head、authorization 三类 durable projection、canonical integrity 与 append primitive；
3. runtime Reader 的 publication/current/active entry 读取与 cancellation；
4. publication、generation/hash-chain transition 两类普通事务；
5. 带强身份、Policy、authorization replay 与 separation-of-duty 的两类授权事务；
6. Pool checkout/release、`SERIALIZABLE`、advisory transaction lock、rollback 与公开 Reader/Repository composition。

这些职责共同形成一个 PostgreSQL Price Catalog adapter，共享一个注入 Pool、同一 schema/ACL、同一 advisory lock key 和
publication/head/authorization 原子协议，不具备拆成 workspace package、进程或公开 subpath 的部署价值；但继续平铺会让
runtime read、普通 mutation、授权 mutation、row integrity 与 client lifecycle 彼此携带完整文件上下文。

编辑前对文件内 27 个 function/class/method 逐一执行 GitNexus upstream impact：22 个 LOW、4 个 MEDIUM、1 个 HIGH、
0 个 CRITICAL。HIGH 是统一 `unavailable`（16 direct/19 total/0 process）；MEDIUM 是 storage error mapping、bigint codec、
publication parser 与 publication query。已在编辑前告警，并把本批限定为等价 ownership 重构。

## 决策

保持一个 `@qinglong/ai` package、一个 public subpath 和 4 行稳定 facade，在既有 Pricing storage 领域建立 package-private
owner 目录：

```text
postgresModelPriceCatalogRepository.ts             # stable public facade
postgres-model-price-catalog-repository/
├── authority.ts                                    # Pool、SQLSTATE、validation and transaction lifecycle
├── records.ts                                      # JSONB/bigint rows, queries and append primitives
├── readOperations.ts                               # authorization/publication/head/active entry reads
├── catalogMutationOperations.ts                    # publish and head transition transactions
├── authorizedMutationOperations.ts                 # authorized publish/transition and duty fences
└── repository.ts                                   # public Reader/Repository and narrow delegation
```

不按七个公开 method 建七个文件，也不把 transaction、records 或 Reader 升级为独立 package。公开
`PostgresModelPriceCatalogReader`、`PostgresModelPriceCatalogRepository` 的 class identity、继承关系、constructor、protected
Pool/row-query declarations、private authorization writer 和 method signature 保持；runtime module 仍只含这两个 class。

所有 mutation 继续从注入 Pool checkout fresh client，顺序固定为：

1. `BEGIN ISOLATION LEVEL SERIALIZABLE`；
2. 对 canonical `[provider, model]` 获取 `pg_advisory_xact_lock(hashtextextended(...))`；
3. exact replay、current/target/revocation/authorization 复验；
4. PostgreSQL database clock、publication/head/authorization append；
5. `COMMIT`，失败 best-effort `ROLLBACK`，finally release client。

本轮不添加自动 retry；`40001`/`40P01` 继续映射为显式 conflict，由上层决定是否生成新操作。普通与授权 transition 保持
revocation query 先于 database clock。授权 replay 继续绑定 stored authorization command/result digest，activate 继续要求唯一
publish authorization；`separation_of_duty` 仍拒绝同一 User 发布并激活。

本轮不修改 SQL table/column/index、migration、role/ACL、row projection、JSONB canonical integrity、bigint、database clock、
digest、generation、revocation permanence、error class/message、isolation、advisory lock、Pool 配置或 public package export。
PostgreSQL 与 SQLite 继续是独立 adapter，不引入条件 SQL或 ORM 共享层。

## 小设备与集群影响

不含 AI 的 Edge、Standalone、Adopted 与 Application 六档制品逐字节不变，最小 Edge 仍为 3,658,234 bytes、358 files、
49 loaded modules。启用 AI 的四档相对 ADR-0334 增加 6 个物理 JavaScript 文件但减少 98 bytes：Edge/Standalone AI 为
5,089,886/5,089,934 bytes、479 files、50 modules；Edge/Standalone Application AI 为
6,208,310/6,208,442 bytes、590 files、115 modules。没有新增路由设备常驻对象、连接、timer、watcher、listener 或网络
authority；不含 AI 的小设备不携带该实现。

Cluster 继续使用原 Pool、schema、migration、roles 与 deployment topology，没有新增连接池、Pod、Service 或 Kubernetes
resource。真实 PostgreSQL 18.4 arm64 physical-streaming HA 门通过 `remote_apply`、timeline 1→2、旧主 fencing、
`pg_rewind` 后只读同步 rejoin、AI schema/ACL 跨晋升存活和 COMMIT-response-loss convergence，最终 `gates.passed=true`。
另以隔离 PostgreSQL 18、独立 migration/admin/runtime role 运行 Price Catalog 专属集成 2/2，直接覆盖 repository mutation、
并发、permanent revoke、authorization 与 ACL，而不把 HA schema 证据冒充 repository 行为证据。

## 被否决方案

1. **把 PostgreSQL Pricing storage 拆成新 workspace package**：没有独立部署、authority、依赖、adapter、multi-consumer 或供应链边界。
2. **继续保留 1,074 行双 class 文件**：runtime read、普通/授权 mutation、records 与 transaction lifecycle 无法独立审阅。
3. **按公开 method 一方法一文件**：会产生多个单 operation 文件并切碎 publication/head/authorization 事务语义。
4. **公开 records/operation/authority subpath**：会允许调用方绕过 isolation、advisory lock、rollback/release 和授权复验。
5. **给每个 operation 新建 Pool 或长期持有 client**：会扩大 Cluster 连接预算并破坏 attempt 级释放。
6. **新增 serialization/deadlock 自动 retry**：属于调用语义变化，不应混入 ownership 重构。
7. **与 SQLite adapter 合并为条件 SQL/ORM**：会隐藏 JSONB/bigint、SQLSTATE、Pool/isolation/advisory lock 和 HA 差异。

## 验收证据

- facade 1,074→4 行；authority 93、records 335、reads 137、catalog mutation 146、authorized mutation 244、repository
  delegation 157 行，总计 1,116 行；最大 owner 335 行，没有一方法一文件。
- public CommonJS facade 与 owning module 均只含 Reader/Repository，两个 class object 与继承关系完全相同；protected/private
  declaration shape 保留。
- Price Catalog mock/read 定向 2 pass/1 条件 skip；隔离 PostgreSQL 18 专属集成 2/2；AI package 212 项为
  209 pass/3 条件 skip/0 fail；完整 16-package clean topology build/test 退出 0。
- PostgreSQL HA Docker 门退出 0；四项 package boundary、Edge import、Cluster dependency、Cluster deployment audit 均
  compatible。Package boundary 为 16 package、921 source、25 root、896 nested，`singleSourcePackages=[]`、
  `shallowSourcePackages=[]`、findings 为空；AI 为 119 source、1 root public export/118 nested。Edge import 仍为 121。
- 十档串行 artifact 全部 compatible；非 AI 六档相对 ADR-0334 精确不变，AI 四档 -98 bytes/+6 files，loaded modules +0。
- 强制代码索引成功，保持 1,731 clusters/296 flows。post-impact 中两个公开 class、transaction runner 和
  具体 operations 为 LOW；统一 unavailable、error mapping、bigint、publication parser/query 为 MEDIUM，无执行流扩散。
- `detect_changes` all/compare `develop` 只作为 Git 基线补充；当前 QL3 孵化树尚未完整进入默认分支索引，因此不能替代逐
  symbol impact、强制索引、真实 PostgreSQL、全包、HA 与制品门。

## 后续约束

公开 Reader/Repository 只负责稳定 interface implementation、Pool validation 与 delegation，不重新吸收 SQL、row codec 或
事务 body。`authority.ts` 不取得业务 replay 决策；`records.ts` 不 checkout Pool 或开启事务；read operations 不取得 mutation
authority；普通与授权 mutation 必须继续分别保持 publication/head 与 authorization 原子协议。新增能力按 records、read、
catalog mutation、authorized mutation、transaction 的共同变化原因聚合，不按 method 数、LOC 或 schema 名机械建文件或
package。
