# ADR-0331：PostgreSQL Model Invocation Repository 领域归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-37、D-85、D-87、D-157、D-161、D-213、D-243、D-244、D-257
- 关联 ADR：ADR-0164、ADR-0165、ADR-0166、ADR-0167、ADR-0168、ADR-0170、ADR-0171、ADR-0260、ADR-0261、ADR-0276、ADR-0330

## 背景

ADR-0330 已把 Local SQLite Model Invocation repository 从单一大文件收敛为同包领域目录。继续审计其 Cluster 对应实现时，
发现公开 `postgres-model-invocation-storage` subpath 背后的
`model-invocation/postgresModelInvocationRepository.ts` 有 2,304 行，其中一个 repository class 同时拥有：

1. PostgreSQL error/SQLSTATE、identifier、bigint、JSONB 与 nullable row codec；
2. Start、Completion、Usage、Quota、Pricing 与 Resolution 的 SELECT projection/query primitive；
3. StepRun/Run/Event/Mutation 与 invocation durable fact 的 append primitive；
4. 十二类读取、usage page/summary、quota window usage 与 Prompt Output metadata 查询；
5. 普通、Quota、Pricing 三种 admission transaction；
6. 普通、Quota、Pricing、encrypted Prompt Output 四种 completion transaction；
7. recovery authority、bounded incomplete page 与 manual resolution transaction；
8. Pool checkout/release、per-transaction timeout、SERIALIZABLE、rollback 与 serialization/deadlock retry。

这些能力共同形成一个 PostgreSQL Model Invocation adapter，共享同一注入 Pool、同一事务 client、advisory lock、StepRun/Run
CAS 与 append-only ACL，不具备拆成新 workspace package、进程或公开 subpath 的独立部署价值；但继续平铺会让 row codec、
底层 SQL、事务资源生命周期和业务 operation 共享完整文件上下文，也会掩盖真正的高风险共享点。

编辑前对原文件 43 个 function、1 个 class 和 25 个 method 逐一执行 GitNexus upstream impact：14 个 CRITICAL、
13 个 HIGH、1 个 MEDIUM、41 个 LOW。高风险集中在共享 row codec、query/mutation primitive 与 error mapping，最多命中
5 条执行流；公开 repository class 和 23 个公开业务 method 均为 LOW。该结果要求保持实现等价，并用完整 transaction、
replay、真 PostgreSQL HA 与 COMMIT-response-loss 门复核，不能借目录重构改写 SQL、ACL 或协议。

## 决策

保持一个 `@qinglong/ai` package、一个 public subpath 和 1 行稳定 facade，在既有 Model Invocation 领域内建立
package-private owner 目录：

```text
postgresModelInvocationRepository.ts                 # stable public facade
postgres-model-invocation-repository/
├── authority.ts                                     # validation、row primitives 与 error mapping
├── codec.ts                                         # durable record/authority codec
├── queries.ts                                       # bounded PostgreSQL query primitives
├── mutations.ts                                     # Run/StepRun/Event 与 invocation fact writes
├── transaction.ts                                   # Pool client、timeout、retry、commit/rollback lifecycle
├── readOperations.ts                                # invocation、usage、quota 与 pricing reads
├── admissionOperations.ts                           # base/quota/pricing admission transactions
├── completionOperations.ts                          # base/quota/pricing/output completion transactions
├── recoveryResolutionOperations.ts                  # authority/recovery reads 与 manual resolution
└── repository.ts                                    # stable public class and narrow delegation
```

公开 class 保持原 constructor 和 23 个 method signature，只把调用委派给四个 operation owner。所有事务仍通过注入的唯一
`PostgresPool` checkout client，并由 `runPostgresModelInvocationTransaction` 统一执行 `BEGIN ISOLATION LEVEL SERIALIZABLE`、
statement/lock/idle-in-transaction timeout、COMMIT、ROLLBACK、`40001`/`40P01` 最多三次 fresh-client retry 和 release；
不创建第二个 Pool、常驻连接、timer、watcher、cache 或后台任务。

Admission、Completion、Resolution 的锁、查询、写入与 existing replay 次序保持原样。Project quota window 的 advisory lock、
StepRun/Run CAS、RunEvent/StepRunMutation、Usage/Quota/Pricing settlement，以及 Prompt Output Artifact 与 completion 的原子提交
均不改变。公开 facade 只导出原 class，不公开 operation、codec、query、mutation 或 transaction primitive，也不增加
`package.json#exports`。

本轮不修改任何 SQL text、table/index、migration、role/ACL、row mapping、digest、mutation/event identity、Quota window、
Price settlement、usage summary、recovery limit、error code/message、transaction isolation、retry 次数、timeout 或 Prompt
Output 加密/留存语义。PostgreSQL 与 SQLite 继续是独立 adapter，不用条件分支强行共用方言实现。

## 小设备与集群影响

不含 AI 的 Edge、Standalone、Adopted 与 Application Profile 制品逐字节不变，最小 Edge 仍为 3,658,234 bytes、358
files、49 loaded modules。启用 AI 的四档各固定增加 13,740 bytes 和 10 个物理 JavaScript 文件：Edge/Standalone AI 为
5,080,547/5,080,595 bytes、456 files、50 modules；Edge/Standalone Application AI 为
6,198,971/6,199,103 bytes、567 files、115 modules，仍低于对应 5/6 MiB hard cap。新增文件来自 source map 的目录路径和
物理模块，不增加路由设备运行时加载模块、常驻对象、连接、timer、watcher、listener 或网络 authority。

Cluster 仍使用原 Pool、原 schema/migration 与原运行角色。本轮真实 PostgreSQL 18.4 arm64 physical-streaming HA 门重新执行并
通过：`remote_apply`、timeline 1→2、旧主 fencing、`pg_rewind` 后只读同步 rejoin、AI schema 与 Plugin Package Prompt
执行跨晋升存活，COMMIT response loss 仍收敛，`gates.passed=true`。没有新增 Pod、Service、Kubernetes resource、数据库
连接池、部署组件或故障转移权威。

## 被否决方案

1. **把 Invocation、Quota、Pricing、Output 各拆 workspace package**：它们共享同一 PostgreSQL transaction、Pool 与部署闭包，
   会制造 importer、lockfile、SBOM 和发布碎片。
2. **继续保留 2,304 行平铺 repository**：codec、SQL、资源生命周期、准入、结算与恢复无法按 ownership 独立审阅。
3. **按 23 个公开 method 一方法一文件**：会把同一事务的 replay、locking、commit、rollback 与 retry 生命周期切碎。
4. **公开内部 operation/codec/transaction subpath**：会扩大兼容面并允许调用方绕过统一 timeout、retry 与 error mapping。
5. **给每个 operation 自建 Pool 或长期持有 client**：会扩大集群连接预算，并破坏 checkout/release 与失败隔离。
6. **与 SQLite repository 合并为通用 SQL/ORM 层**：会隐藏双方言在锁、隔离级别、bigint/JSONB、错误和 HA 上的真实差异。
7. **趁拆分修改 migration、ACL 或 SQL**：会把 ownership 重构与持久化/安全/部署语义混批，无法可靠归因。

## 验收证据

- facade 2,304→1 行；authority 118、codec 367、queries 146、mutations 490、transaction 64、reads 366、admission 258、
  completion 459、recovery/resolution 183、repository 269 行，总计 2,721 行；没有一方法一文件。
- public runtime module 只含 `PostgresModelInvocationRepository`，与 owning module 为同一 class object，无 missing、extra
  或 runtime identity drift。
- AI package 212 项为 209 pass/3 条外部 PostgreSQL 条件 skip/0 fail；完整 16-package clean topology build/test 在允许
  loopback TLS/mTLS 的环境退出 0。首次沙箱运行的 3 个 Worker 用例仅因 `listen EPERM 127.0.0.1` 失败，提升权限后全绿。
- PostgreSQL HA Docker 门退出 0，证明 timeline promotion/rewind、旧主 fence、AI schema、Model Invocation、Package Prompt
  与 response-loss convergence；四项 package boundary、Edge import、Cluster dependency、Cluster deployment audit 均 compatible。
- package boundary 为 16 package、898 source、25 root、873 nested，`singleSourcePackages=[]`、
  `shallowSourcePackages=[]`、findings 为空；AI 为 96 source、1 root public export/95 nested。
- 十档串行 artifact 全部 compatible；非 AI 六档相对 ADR-0330 精确不变，AI 四档固定 +13,740 bytes/+10 files、loaded
  modules +0。
- 强制索引为 44,293 nodes/101,004 edges/1,720 clusters/296 flows。post-impact 中公开 repository 为 LOW
  （2 direct/4 total/0 process）；三个 operation owner 代表函数均为 LOW（1 direct/1 total/0 process）；transaction、
  row/query/mutation helper 为 MEDIUM。统一 `unavailable` error 为 CRITICAL（32 direct/66 total/0 process），但已限制在
  PostgreSQL Model Invocation package-private owner 内，并由全包与 HA 门覆盖。
- `detect_changes` all/compare `develop` 只作为 Git 基线补充；当前 QL3 孵化树尚未完整进入默认分支索引，因此不能替代逐
  symbol impact、强制索引、完整测试、HA 与制品门。

## 后续约束

公开 repository 只负责稳定 interface implementation 与 delegation，不重新吸收 SQL、codec 或 transaction body。
`authority.ts` 不取得业务决策权；`codec.ts` 不取得 client；query/mutation primitive 不能自行 checkout Pool 或开启事务；
operation owner 必须使用注入的同一 transaction client。`transaction.ts` 虽然只有 64 行，但它完整拥有一个高内聚的资源
生命周期，不是独立 package，也不是一方法一文件，应保留为显式基础设施边界。新增能力按 read、admission、completion、
recovery/resolution 的共同变化原因聚合，不按方法数量、LOC 或 schema 名机械建文件或 package。
