# ADR-0330：Local Model Invocation Repository 领域归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-37、D-85、D-87、D-157、D-213、D-244、D-257
- 关联 ADR：ADR-0164、ADR-0165、ADR-0166、ADR-0167、ADR-0276、ADR-0297、ADR-0321、ADR-0329

## 背景

ADR-0321 至 ADR-0329 已把 workspace package 边界与 package-private ownership 分开治理。继续审计
`@qinglong/ai` 时发现，公开 `local-model-invocation-storage` subpath 背后的
`model-invocation/localModelInvocationRepository.ts` 有 2,369 行，其中一个 repository class 同时拥有：

1. 单连接 operation authority、64 项 pending 上限、feature activation 与统一 SQLite error mapping；
2. Start、Completion、Usage、Quota、Pricing、Resolution 与 StepRun authority 的严格 row codec；
3. 八组 SELECT projection/query primitive 与 corrupt/duplicate row fail-closed；
4. StepRun/Run/Event/Mutation 写入、Start/Completion/Usage/Quota/Price/Resolution append primitive；
5. 十二类读取与 usage summary、recovery page 查询；
6. 普通、Quota、Pricing 三种 admission transaction；
7. 普通、Quota、Pricing、encrypted Prompt Output 四种 completion transaction；
8. outcome-unknown recovery inspection 与人工 resolution transaction。

这些能力共同形成一个 Local SQLite Model Invocation adapter，共享同一 connection queue、`BEGIN IMMEDIATE` 事务和
StepRun/Run CAS authority，不具备拆成新 workspace package、进程或公开 subpath 的独立价值；但继续平铺会让只读查询、
准入、结算、恢复、row codec 与底层写入原语共享完整文件上下文。

编辑前对文件 42 个 function、2 个 class 和 28 个 method 逐一执行 GitNexus upstream impact：13 个 CRITICAL、
13 个 HIGH、3 个 MEDIUM、43 个 LOW。高风险集中在共享 row parser、query primitive、StepRun mutation 与 error mapping，
最多命中 5 条执行流；公开 repository class 为 MEDIUM，23 个公开业务 method 均为 LOW。该结果要求保持实现等价并运行
完整 transaction/replay/crash regression，不能借目录重构改写 SQL 或协议。

## 决策

保持一个 `@qinglong/ai` package、一个 public subpath 和 2 行稳定 facade，在既有 Model Invocation 领域内建立
package-private owner 目录：

```text
localModelInvocationRepository.ts                  # stable public facade
local-model-invocation-repository/
├── authority.ts                                   # queue、feature fence、validation 与 error mapping
├── codec.ts                                       # row/select projection 与 durable record codec
├── queries.ts                                     # bounded SQLite query primitives
├── mutations.ts                                   # Run/StepRun/Event 与 invocation fact write primitives
├── readOperations.ts                              # invocation、usage、quota 与 pricing reads
├── admissionOperations.ts                         # base/quota/pricing admission transactions
├── completionOperations.ts                        # base/quota/pricing/output completion transactions
├── recoveryResolutionOperations.ts                # authority/recovery reads 与 manual resolution
└── repository.ts                                  # stable public class and narrow delegation
```

公开 class 保持原 constructor 和 23 个 method signature，只把调用委派给四个 operation owner。operation 显式接收唯一
`LocalModelInvocationOperationAuthority` 与同一 `DatabaseSync`，统一通过 `enqueueLocalModelInvocation` 进入原队列；不创建
第二个 client、连接池、timer、watcher、cache 或后台任务。`PrivateLocalAuthority` 仍使用原 64 pending hard cap 和同一
tail promise。

Admission、Completion、Resolution 的 `BEGIN IMMEDIATE`/COMMIT/ROLLBACK 边界、写入次序、existing replay 检查和失败回滚
保持原样。共享 mutation owner 仍以 StepRun CAS → Run CAS → RunEvent → StepRunMutation 的顺序提交；Prompt Output Artifact
仍与 Completion、Usage、Price/Quota settlement 同事务。公开 facade 只导出原 class 和 type-only Authority，不公开任何
operation、codec、query 或 mutation primitive，也不增加 `package.json#exports`。

本轮不修改任何 SQL text、table/index、migration、row mapping、digest、mutation/event identity、Quota window、Price
settlement、usage summary、feature activation、recovery limit、error code/message、transaction isolation 或 Prompt Output
加密/留存语义。

## 小设备与集群影响

不含 AI 的 Edge、Standalone、Adopted 与 Application Profile 制品逐字节不变，最小 Edge 仍为 3,658,234 bytes、358
files、49 loaded modules。启用 AI 的四档各固定增加 13,262 bytes 和 9 个物理 JavaScript 文件：Edge/Standalone AI 为
5,066,807/5,066,855 bytes、446 files、50 modules；Edge/Standalone Application AI 为
6,185,231/6,185,363 bytes、557 files、115 modules，仍低于对应 5/6 MiB hard cap。没有新增常驻对象、连接、timer、
watcher、listener 或网络 authority。

Cluster 使用独立 PostgreSQL Model Invocation repository，不导入本地 SQLite owner。本轮没有修改 schema、migration、
PostgreSQL、ACL、Cluster runtime、Kubernetes resource 或部署拓扑；已获准的 PostgreSQL HA Docker 门不因无关的包内移动
重复执行，Cluster dependency/deployment audit 继续证明边界 compatible。

## 被否决方案

1. **把 Invocation、Quota、Pricing、Output 各拆 workspace package**：四者共享同一 SQLite transaction 与部署闭包，
   会制造 importer、lockfile、SBOM 和发布碎片。
2. **继续保留 2,369 行平铺 repository**：读取、准入、结算、恢复和底层持久化无法按 ownership 独立审阅。
3. **按 23 个公开 method 一方法一文件**：会把同一事务的 replay、commit 与 rollback 生命周期切碎。
4. **公开内部 operation/codec subpath**：会扩大兼容面并允许调用方绕过 repository queue 与 error mapping。
5. **给每个 operation 自建 SQLite client**：会破坏单连接串行化、transaction fence 与 close ownership。
6. **趁拆分引入 ORM、改写 SQL 或统一 Local/PostgreSQL repository**：会把 ownership 重构与持久化语义、方言和部署变化混批。

## 验收证据

- facade 2,369→2 行；authority 161、codec 342、queries 142、mutations 479、reads 356、admission 305、completion 538、
  recovery/resolution 198、repository 328 行，总计 2,851 行；没有一方法一文件。
- public runtime module 只含 `LocalModelInvocationRepository`，与 owning module 为同一 class object；Authority 仍为
  type-only export，无 missing、extra 或 runtime drift。
- AI package 212 项为 209 pass/3 条外部 PostgreSQL条件 skip/0 fail；完整 16-package clean topology build/test 退出 0。
  SQLite admission/completion/usage/quota/pricing/recovery/manual resolution、Prompt Output Artifact 与两组 crash matrix 全绿。
- package boundary 为 16 package、888 source、25 root、863 nested，`singleSourcePackages=[]`、
  `shallowSourcePackages=[]`、findings 为空；AI 为 86 source、1 root public export/85 nested。Edge import 仍为 121 modules，
  Cluster dependency/deployment 均 compatible。
- 十档串行 artifact 全部 compatible；非 AI 六档相对 ADR-0329 精确不变，AI 四档固定 +13,262 bytes/+9 files、loaded
  modules +0。
- 强制索引为 44,237 nodes/100,835 edges/1,718 clusters/284 flows。post-impact 中公开 repository 为 LOW
  （3 direct/13 total/2 process）；四个 operation owner 代表函数均为 LOW（1 direct/1 total/0 process）；共享 queue
  helper 为 HIGH（23 direct/47 total/0 process），统一 unavailable error 为 CRITICAL（30 direct/65 total/0 process），
  row/query/mutation helper 降为 MEDIUM。高风险被限制在单一 package-private owner 内，没有新增跨包 process hit。
- `detect_changes` all/compare `develop` 仍只映射已跟踪 Legacy baseline 的 12/31 与 14/34、low/0 process；当前 QL3
  孵化树尚未完整进入 Git baseline，因此它只作补充，不能替代逐 symbol impact、强制索引、完整测试与制品门。

## 后续约束

公开 repository 只负责稳定 interface implementation 与 delegation，不重新吸收 SQL、codec 或 transaction body。
`authority.ts` 不取得业务决策权；`codec.ts` 不取得 client；query/mutation primitive 不能自行 enqueue 或开事务；四个
operation owner 必须使用注入的唯一 Authority/client 并保持各自 replay/commit/rollback 生命周期。新增能力按 read、
admission、completion、recovery/resolution 的共同变化原因聚合，不按方法数量、LOC 或 schema 名机械建文件或 package。
