# ADR-0333：PostgreSQL Plugin Package Prompt Admission Repository 领域归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-37、D-85、D-87、D-157、D-161、D-213、D-243、D-244、D-257
- 关联 ADR：ADR-0168、ADR-0170、ADR-0171、ADR-0260、ADR-0261、ADR-0276、ADR-0331、ADR-0332

## 背景

ADR-0332 已把 Local SQLite Prompt Admission repository 从千行级单文件收敛为同包领域目录。继续处理其 Cluster 对应实现
时，发现公开 `postgres-plugin-package-prompt-admission-storage` subpath 背后的
`prompt/postgresPluginPackagePromptAdmissionRepository.ts` 有 1,257 行，其中一个 repository class 同时拥有：

1. SQLSTATE/constraint/error mapping、identity、canonical JSON、JSONB、boolean、bigint 与 nullable row codec；
2. admission/finalization query、plan/receipt 反序列化和完整 durable evidence 复验；
3. Run、RunEvent、model StepRun、StepRunMutation 与 Prompt Admission 写入；
4. SECURITY DEFINER admission snapshot、publication/materialized Prompt 精确复验与 mutation guard；
5. Completion/Resolution terminal evidence、父 Run CAS、final event 与 finalization receipt；
6. Pool checkout/release、SERIALIZABLE、transaction-local timeout、rollback 与 serialization/deadlock retry；
7. admission/finalization 四类读取和公开 repository composition。

这些能力共同形成一个 PostgreSQL Prompt Admission adapter，共享同一注入 Pool、同一 transaction client、同一 Run/StepRun
事实链、snapshot function 与 append-only ACL，不具备拆成新 workspace package、进程或公开 subpath 的独立部署价值；但继续
平铺会让错误/row authority、durable records、admission snapshot、finalization 生命周期和资源事务共享完整文件上下文。

编辑前对文件内 37 个 function/class/method 逐一执行 GitNexus upstream impact：29 个 LOW、7 个 MEDIUM、1 个 HIGH、
0 个 CRITICAL。HIGH 为统一 `unavailable`（17 direct/26 impacted/0 process）；公开 repository 为 LOW、4 direct/6
impacted/0 process。该结果要求集中保留错误语义，并通过真 PostgreSQL HA、COMMIT-response-loss、全包与制品门验证，不能
借 ownership 重构改写 SQL、ACL 或事务协议。

## 决策

保持一个 `@qinglong/ai` package、一个 public subpath 和 4 行稳定 facade，在既有 Prompt 领域内建立 package-private owner
目录：

```text
postgresPluginPackagePromptAdmissionRepository.ts       # stable public facade
postgres-plugin-package-prompt-admission-repository/
├── authority.ts                                        # SQLSTATE、validation、JSONB/row 与 error mapping
├── transaction.ts                                      # Pool client、timeout、retry、commit/rollback lifecycle
├── admissionRecords.ts                                 # admission durable reads/writes/evidence codec
├── admissionOperation.ts                               # snapshot guard、replay 与 admission transaction body
├── finalizationOperations.ts                           # terminal evidence、receipt 与 finalization transaction body
└── repository.ts                                       # stable public class and narrow delegation
```

不按六个公开 method 建六个文件，也不把 61 行 transaction owner 升级为独立 package。公开 class 保持原 constructor 和六个
method signature；`PostgresPluginPackagePromptAdmissionMutationGuard` 仍是 type-only export，runtime module 仍只含原 class。

所有 mutation 仍通过注入的唯一 `PostgresPool` 获取 fresh client；`runTransaction` 继续统一执行：

1. `BEGIN ISOLATION LEVEL SERIALIZABLE`；
2. transaction-local statement timeout 5s、lock timeout 2s、idle-in-transaction timeout 5s；
3. operation body 与 COMMIT；
4. 失败后的 best-effort ROLLBACK；
5. 仅 `40001`/`40P01` 最多三次 fresh-client retry；
6. 每次 attempt 都在 finally release client。

Admission 仍按 existing replay → mutation guard → SECURITY DEFINER snapshot → publication/materialized resource verification →
Run/Event/Step/Mutation/Admission writes 的原次序提交。Finalization 仍按 existing replay → admission/evidence read and lock →
counter fence → Run CAS → final event → finalization receipt 的原次序提交。

本轮不修改 SQL text、table/index/migration、SECURITY DEFINER function、role/ACL、row projection、JSON/digest、identity、event/
mutation sequence、Run/StepRun 状态机、mutation guard、Completion/Resolution 解释、error code/message、transaction isolation、
timeout、retry 次数或 Pool 配置。PostgreSQL 与 SQLite 继续是独立 adapter，不引入条件 SQL/ORM 共享层。

## 小设备与集群影响

不含 AI 的 Edge、Standalone、Adopted 与 Application Profile 制品逐字节不变，最小 Edge 仍为 3,658,234 bytes、358
files、49 loaded modules。启用 AI 的四档各固定增加 4,711 bytes 和 6 个物理 JavaScript 文件：Edge/Standalone AI 为
5,088,105/5,088,153 bytes、467 files、50 modules；Edge/Standalone Application AI 为
6,206,529/6,206,661 bytes、578 files、115 modules，仍低于对应 5/6 MiB hard cap。运行时 loaded modules 增量为 0，
没有新增路由设备常驻对象、连接、timer、watcher、listener 或网络 authority。

Cluster 仍使用原 Pool、schema、migration、runtime role 与 deployment topology。真实 PostgreSQL 18.4 arm64 physical-streaming
HA 门重新执行并通过：`remote_apply`、timeline 1→2、旧主 fencing、`pg_rewind` 后只读同步 rejoin、AI/Prompt 事实跨晋升
存活、COMMIT response loss 收敛，最终 `gates.passed=true`。没有新增 Pool、Pod、Service、Kubernetes resource、数据库
角色或故障转移权威。

## 被否决方案

1. **把 admission/finalization/transaction 拆成新 workspace package**：它们共享同一 Pool、schema、ACL 与部署闭包，会制造发布碎片。
2. **继续保留 1,257 行 repository class**：row/error、记录、snapshot、两个事务生命周期和资源管理无法独立审阅。
3. **按六个公开 method 一方法一文件**：四个 read method 共享 durable evidence，两个 mutation method 各拥有完整事务。
4. **公开内部 record/operation/transaction subpath**：会允许调用方绕过 timeout、retry、snapshot guard 与统一错误映射。
5. **给每个 operation 新建 Pool 或长期持有 client**：会扩大 Cluster 连接预算并破坏 attempt 级释放与失败隔离。
6. **与 SQLite adapter 合并为通用 SQL/ORM 层**：会隐藏隔离级别、snapshot function、JSONB/bigint、SQLSTATE 与 HA 差异。
7. **趁拆分修改 migration、ACL、SQL 或状态机**：会把 ownership 与协议/安全/部署变化混批，无法可靠归因。

## 验收证据

- facade 1,257→4 行；authority 125、transaction 61、admission records 446、admission operation 158、finalization
  operations 439、repository 114 行，总计 1,347 行；最大 owner 446 行，没有一方法一文件。
- public runtime module 只含 `PostgresPluginPackagePromptAdmissionRepository`，与 owning module 为同一 class object；mutation
  guard 仍为 type-only export，无 missing、extra 或 runtime identity drift。
- Cluster Prompt 定向门 6 pass/1 条外部 PostgreSQL URL 条件 skip；AI package 212 项为 209 pass/3 条件 skip/0 fail；
  完整 16-package clean topology build/test 在允许 loopback TLS/mTLS 的环境退出 0。
- PostgreSQL HA Docker 门退出 0，证明 PostgreSQL 18.4 arm64 physical streaming、timeline promotion/rewind、旧主 fence、
  AI/Prompt durable facts 与 response-loss convergence；四项 package boundary、Edge import、Cluster dependency、Cluster
  deployment audit 均 compatible。
- package boundary 为 16 package、909 source、25 root、884 nested，`singleSourcePackages=[]`、
  `shallowSourcePackages=[]`、findings 为空；AI 为 107 source、1 root public export/106 nested。Edge import 仍为 121
  modules。
- 十档串行 artifact 全部 compatible；非 AI 六档相对 ADR-0332 精确不变，AI 四档固定 +4,711 bytes/+6 files、loaded
  modules +0。
- 强制索引为 44,340 nodes/101,155 edges/1,731 clusters/296 flows。post-impact 中公开 repository 为 LOW
  （4 direct/7 total/0 process），admit/finalize operation 为 LOW（各 1/1/0），transaction runner 为 LOW（2/2/0）。
  统一 `unavailable` 为 HIGH（17/29/0），`mapStorageError` 为 HIGH（5/8/0），但均集中在 package-private authority；
  JSON/row/admission lookup 为 MEDIUM，无跨执行流扩散。
- `detect_changes` all/compare `develop` 只作为 Git 基线补充；当前 QL3 孵化树尚未完整进入默认分支索引，因此不能替代逐
  symbol impact、强制索引、完整测试、HA 与制品门。

## 后续约束

公开 repository 只负责稳定 interface implementation、输入 normalization 与 delegation，不重新吸收 SQL、codec 或事务
body。`authority.ts` 集中保留错误和 row/JSON 语义，不取得业务决策；`admissionRecords.ts` 不自行 checkout Pool 或开事务；
`admissionOperation.ts` 必须保持 snapshot guard 与 writes 同事务；`finalizationOperations.ts` 必须保持 evidence lock、Run
CAS、event 与 receipt 同事务；`transaction.ts` 只拥有 client 生命周期、timeout 与 retry，不取得业务重放判断。新增能力按
records、admission、finalization、transaction 的共同变化原因聚合，不按 method 数、LOC 或 schema 名机械建文件或 package。
