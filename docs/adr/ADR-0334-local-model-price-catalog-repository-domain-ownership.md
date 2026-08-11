# ADR-0334：Local Model Price Catalog Repository 领域归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-37、D-85、D-87、D-157、D-161、D-213、D-243、D-244、D-257
- 关联 ADR：ADR-0172、ADR-0173、ADR-0174、ADR-0175、ADR-0276、ADR-0330、ADR-0331、ADR-0332、ADR-0333

## 背景

完成 Model Invocation 与 Plugin Package Prompt Admission 两组 Local/PostgreSQL repository ownership 后，继续审查
AI Pricing storage。公开 `local-price-catalog-storage` subpath 背后的
`pricing/storage/localModelPriceCatalogRepository.ts` 有 1,093 行，其中一个 repository class 同时拥有：

1. SQLite constraint/error mapping、identity validation、JSON 上限与 scalar/nullable row codec；
2. publication、head、authorization 三类 durable row 读取、canonical projection 复验和 authorization 写入；
3. authorization/publication/current/active entry 四类读取与 cancellation 处理；
4. publication 创建和 generation/hash-chain transition 两类普通事务；
5. 带强身份、Policy、decision mode、fresh reauthentication replay 与 separation-of-duty 的两类授权事务；
6. 单连接 64-pending authority queue、`BEGIN IMMEDIATE`、rollback、mutation fence hook 和公开 repository composition。

这些职责属于同一个 SQLite Price Catalog adapter，共享一个注入的 `DatabaseSync`、一条 serialization authority、同一组
publication/head/authorization 表及原子提交边界，不具备拆成 workspace package、进程或公开 subpath 的部署价值；但继续平铺
会要求读取、普通变更和授权变更彼此携带完整实现上下文。

编辑前对文件内 31 个 function/class/method 逐一执行 GitNexus upstream impact：22 个 LOW、9 个 HIGH、0 个 MEDIUM、
0 个 CRITICAL。公开 repository 为 HIGH（3 direct/4 total/2 process）；Private authority enqueue、统一 unavailable、
text/integer/nullable/JSON codec 及 publication/head row parser 也为 HIGH。已在编辑前告警，并把本批限定为等价 ownership
重构；64-pending 上限、durable hash chain、授权重认证 replay、`BEGIN IMMEDIATE`、mutation hook 与审计原子性均作为必保
行为。

## 决策

保持一个 `@qinglong/ai` package、一个 public subpath 与 4 行稳定 facade，在既有 Pricing storage 领域建立 package-private
owner 目录：

```text
localModelPriceCatalogRepository.ts                 # stable public facade
local-model-price-catalog-repository/
├── authority.ts                                    # queue、identity 与 SQLite error boundary
├── records.ts                                      # durable row query/codec/integrity 与 authorization append
├── readOperations.ts                               # authorization/publication/head/active entry reads
├── catalogMutationOperations.ts                    # publish 与 head transition transactions
├── authorizedMutationOperations.ts                 # authorized publish/transition and replay fences
└── repository.ts                                   # public interface implementation and narrow delegation
```

不按八个公开 method 建八个文件，也不把 queue、records 或 operation 升级为独立 package。公开 class 保持原 constructor、options
与八个 method signature；`LocalModelPriceCatalogRepositoryOptions` 继续在公开 owning module 内以原 callback shape 声明，
runtime module 仍只有原 class。

所有 operation 继续经同一个 authority queue 串行进入注入连接，pending hard cap 仍为 64，未知 SQLite 错误仍映射为
`ModelPriceCatalogUnavailableError`，constraint 仍映射为 conflict。Publication 与 head mutation 继续使用 `BEGIN IMMEDIATE`，
并在失败时 best-effort rollback；authorization fence hook 仍在事务开始后、任何 replay 或 mutation 判断前执行。

普通 publish/transition 保持 mutation/price-revision/generation 的 exact replay 与 conflict 规则。授权 publish/transition 保持
authorization identity 或 catalog command digest 的唯一性、fresh reauthentication replay、结果 digest 绑定，以及 activate 时
对发布 authorization 的唯一复验；`separation_of_duty` 仍拒绝发布人与激活人为同一 User。Publication、head 与 authorization
继续在一个 SQLite 事务中提交。

本轮不修改 SQL table/column/index、migration、row projection、canonical JSON、byte bound、identity pattern、database clock、
digest、generation、revocation permanence、decision mode、error class/message、queue policy、事务顺序或 public package export。
PostgreSQL counterpart 继续独立保留，后续单独处理，不引入条件 SQL 或 ORM 共享层。

## 小设备与集群影响

不含 AI 的 Edge、Standalone、Adopted 与 Application 六档制品逐字节不变，最小 Edge 仍为 3,658,234 bytes、358 files、
49 loaded modules。启用 AI 的四档相对 ADR-0333 固定增加 1,879 bytes 与 6 个物理 JavaScript 文件：Edge/Standalone AI 为
5,089,984/5,090,032 bytes、473 files、50 modules；Edge/Standalone Application AI 为
6,208,408/6,208,540 bytes、584 files、115 modules，仍低于对应 5/6 MiB hard cap。运行时 loaded modules 增量为 0，
没有新增路由设备常驻对象、连接、timer、watcher、listener 或网络 authority。

Cluster 依赖、Pool、schema、migration、role、Pod、Service 和部署拓扑均未变化。四项 Cluster/Edge/Package 审计通过；本批只
移动 Local SQLite owner，不重复执行 ADR-0333 已通过的 PostgreSQL HA Docker 门。PostgreSQL Price Catalog counterpart 将在
其 ownership 批次用真实 HA 门独立验证。

## 被否决方案

1. **把 Pricing storage 再拆成 workspace package**：没有新部署、authority、依赖、adapter、multi-consumer 或供应链边界，只会产生第 17 个发布单元。
2. **继续保留 1,093 行 repository class**：读取、普通 mutation、授权 mutation、row integrity 和 queue/error 无法按变化原因独立审阅。
3. **按八个公开 method 一方法一文件**：会产生多个只有一个 operation 的文件，反而稀释 publication/head/authorization 的共同事务语义。
4. **公开 records/operation/authority subpath**：会允许调用方绕过 queue、error mapping、transaction 与授权 fence。
5. **给每个 operation 新建连接或 queue**：会破坏同一 SQLite connection 的 serialization 与 64-pending 背压。
6. **与 PostgreSQL adapter 合并为条件 SQL/ORM**：会隐藏 SQLite `BEGIN IMMEDIATE`、单连接 queue 与 PostgreSQL 隔离/重试差异。
7. **趁拆分修改 schema、SQL、hash chain 或授权规则**：会把 ownership 与协议/安全变化混批，无法可靠归因。

## 验收证据

- facade 1,093→4 行；authority 101、records 257、read operations 112、catalog mutation 209、authorized mutation 316、
  repository delegation 156 行，总计 1,155 行；最大 owner 316 行，没有一方法一文件。
- public CommonJS runtime module 与 owning module 均只含 `LocalModelPriceCatalogRepository`，且为同一 class object；options
  保持 type-only、内联 callback shape，无 missing、extra 或 runtime identity drift。
- Price Catalog 定向测试 9/9；AI package 212 项为 209 pass/3 条件 skip/0 fail；完整 16-package clean topology
  build/test 在允许 loopback TLS/mTLS 的环境退出 0。
- 四项 package boundary、Edge import、Cluster dependency、Cluster deployment audit 均 compatible。Package boundary 为
  16 package、915 source、25 root、890 nested，`singleSourcePackages=[]`、`shallowSourcePackages=[]`、findings 为空；
  AI 为 113 source、1 root public export/112 nested。Edge import 仍为 121 modules。
- 十档串行 artifact 全部 compatible；非 AI 六档相对 ADR-0333 精确不变，AI 四档固定 +1,879 bytes/+6 files、loaded
  modules +0。
- 最终索引为 44,373 nodes/101,268 edges/1,731 clusters/296 flows。post-impact 中公开 repository 为 HIGH
  （4 direct/5 total/2 process），enqueue operation 为 HIGH（8/19/0），统一 unavailable 为 HIGH（12/26/0），
  publication/head parser 为 HIGH（6/15/0、3/8/0）；authorization parser 与具体 read/mutation operation 为 LOW。
- `detect_changes` all/compare `develop` 只作为 Git 基线补充；当前 QL3 孵化树尚未完整进入默认分支索引，因此不能替代逐
  symbol impact、强制索引、完整测试和制品门。

## 后续约束

公开 repository 只负责稳定 interface implementation、options validation 与 delegation，不重新吸收 SQL、row codec 或事务
body。`authority.ts` 只拥有 serialization/backpressure/error boundary；`records.ts` 只拥有 durable projection、integrity 与
append primitive；`readOperations.ts` 不取得 mutation authority；普通与授权 mutation 必须继续分别保持 publication/head 与
authorization 原子协议。新增能力按 records、read、catalog mutation、authorized mutation 的共同变化原因聚合，不按 method
数量、LOC 或 schema 名机械建文件或 package。下一批 PostgreSQL Price Catalog owner 必须继续保留方言、Pool、isolation、retry
和 HA 差异，并重新执行 PostgreSQL HA 门。
