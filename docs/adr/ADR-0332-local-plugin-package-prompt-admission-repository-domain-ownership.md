# ADR-0332：Local Plugin Package Prompt Admission Repository 领域归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-37、D-85、D-87、D-157、D-161、D-213、D-243、D-244、D-257
- 关联 ADR：ADR-0168、ADR-0170、ADR-0171、ADR-0260、ADR-0261、ADR-0276、ADR-0330、ADR-0331

## 背景

ADR-0330 与 ADR-0331 已把双方言 Model Invocation repository 从千行级单文件收敛为同包领域目录。继续审计
`@qinglong/ai` 的 Prompt 执行链时，发现公开 `local-plugin-package-prompt-admission-storage` subpath 背后的
`prompt/localPluginPackagePromptAdmissionRepository.ts` 有 1,261 行，其中一个 repository class 同时拥有：

1. SQLite 单连接队列、64 pending hard cap、错误映射与 identity/row/JSON codec；
2. Run、RunEvent、model StepRun、StepRunMutation 与 Prompt Admission 写入；
3. admission plan/receipt 查询、反序列化和完整 durable evidence 复验；
4. active publication、installation、lifecycle、quarantine 与 materialized Prompt 的当前目标复验；
5. feature fence、mutation guard、exact replay 与 `BEGIN IMMEDIATE` admission transaction；
6. Completion/Resolution terminal evidence 解析、父 Run CAS、final event 与 finalization receipt 原子提交；
7. admission/finalization 的四类读取和公开 repository composition。

这些能力共同形成一个 Local SQLite Prompt Admission adapter，共享同一 `DatabaseSync`、同一 Model Invocation operation
authority、同一 Run/StepRun 事实链和事务边界，不具备拆成新 workspace package、进程或公开 subpath 的独立价值；但继续
平铺会让资源 authority、admission record、目标复验、finalization 生命周期和公开 delegation 共享完整文件上下文。

编辑前对文件内 35 个 function/class/method 逐一执行 GitNexus upstream impact：31 个 LOW、4 个 MEDIUM、0 个 HIGH/
CRITICAL。MEDIUM 为 identity、row text、canonical JSON 和单连接 queue；queue 为 1 direct/47 impacted/0 process，公开
repository 为 LOW、2 direct/2 impacted/2 process。该结果允许等价 ownership 拆分，但要求保留队列上限、事务、exact replay、
durable evidence 和 crash recovery 语义。

## 决策

保持一个 `@qinglong/ai` package、一个 public subpath 和 4 行稳定 facade，在既有 Prompt 领域内建立 package-private owner
目录：

```text
localPluginPackagePromptAdmissionRepository.ts          # stable public facade
local-plugin-package-prompt-admission-repository/
├── authority.ts                                        # queue、validation、row/JSON 与 error mapping
├── admissionRecords.ts                                 # admission durable reads/writes/evidence codec
├── admissionOperation.ts                               # target guard、replay 与 admission transaction
├── finalizationOperations.ts                           # terminal evidence、receipt 与 finalization transaction
└── repository.ts                                       # stable public class and narrow delegation
```

不按六个公开 method 建六个文件，也不把 64 pending queue 单独升级为 package。公开 class 保持原 constructor 和六个 method
signature；`LocalPluginPackagePromptAdmissionMutationGuard` 仍是 type-only export，runtime module 仍只含原 class。

`authority.ts` 继续复用注入的 `LocalModelInvocationOperationAuthority`；只在调用方直接传入 `DatabaseSync` 时创建原有
process-local queue。所有 read/admit/finalize operation 仍进入同一 queue，并使用同一 client，不创建第二个连接、timer、
watcher、cache 或后台任务。

Admission 仍按 existing replay → feature fence → mutation guard → current publication/materialization guard → Run/Event/Step/
Mutation/Admission writes 的原次序在一个 `BEGIN IMMEDIATE` 中提交。Finalization 仍按 existing replay → feature fence →
admission/evidence read → counter fence → Run CAS → final event → finalization receipt 的原次序提交。异常仍只在已开启事务时
best-effort rollback，并保留原 fail-closed error。

本轮不修改 SQL text、table/index/migration、row projection、JSON/digest、identity、event/mutation sequence、Run/StepRun
状态机、Prompt target guard、feature activation、mutation guard、Completion/Resolution 解释、error code/message 或 transaction
mode。PostgreSQL Prompt Admission adapter 保持独立，下一批按同一原则审计，不强行共用双方言 SQL。

## 小设备与集群影响

不含 AI 的 Edge、Standalone、Adopted 与 Application Profile 制品逐字节不变，最小 Edge 仍为 3,658,234 bytes、358
files、49 loaded modules。启用 AI 的四档各固定增加 2,847 bytes 和 5 个物理 JavaScript 文件：Edge/Standalone AI 为
5,083,394/5,083,442 bytes、461 files、50 modules；Edge/Standalone Application AI 为
6,201,818/6,201,950 bytes、572 files、115 modules，仍低于对应 5/6 MiB hard cap。运行时 loaded modules 增量为 0，
没有新增常驻对象、连接、timer、watcher、listener 或网络 authority。

Cluster PostgreSQL Prompt Admission repository、schema、migration、Pool、ACL、Pod、Service 与部署拓扑均未修改。完整 package
门仍覆盖 Cluster 包，Cluster dependency/deployment audit 均 compatible；上一批 ADR-0331 已在同一工作树基线上重跑并通过
PostgreSQL 18.4 physical HA，本批不因纯 Local owner 移动重复执行 Docker failover。

## 被否决方案

1. **把 admission/finalization 拆成新 workspace package**：二者共享同一 SQLite queue、数据库事务和部署闭包，会制造发布碎片。
2. **继续保留 1,261 行 repository class**：资源 authority、记录 codec、目标复验和两个事务生命周期无法独立审阅。
3. **按六个公开 method 一方法一文件**：四个 read method 共享相同 admission evidence，两个 mutation method 各自拥有完整事务。
4. **公开内部 record/operation subpath**：会允许调用方绕过 queue、feature fence、target guard 与统一错误映射。
5. **给 Prompt adapter 创建独立 SQLite client**：会破坏 AI feature 与 Model Invocation 共用的串行 authority。
6. **与 PostgreSQL adapter 合并为条件 SQL/ORM**：会隐藏双方言的事务、锁、row type、错误与 HA 差异。
7. **趁拆分修改 SQL、digest 或状态机**：会把 ownership 重构与协议变化混批，无法可靠归因。

## 验收证据

- facade 1,261→4 行；authority 151、admission records 441、admission operation 221、finalization operations 471、
  repository 116 行，总计 1,404 行；最大 owner 471 行，没有一方法一文件。
- public runtime module 只含 `LocalPluginPackagePromptAdmissionRepository`，与 owning module 为同一 class object；mutation
  guard 仍为 type-only export，无 missing、extra 或 runtime identity drift。
- 定向 admission/execution/crash 测试 13/13；Edge/Standalone 各 10 个 admission/finalization crash point，共 20 场景，
  16 个 commit 前窗口无部分事实、4 个 commit 后窗口 exact replay，`integrity_check`/foreign key check 均通过。
- AI package 212 项为 209 pass/3 条外部 PostgreSQL 条件 skip/0 fail；完整 16-package clean topology build/test 在允许
  loopback TLS/mTLS 的环境退出 0。
- package boundary 为 16 package、903 source、25 root、878 nested，`singleSourcePackages=[]`、
  `shallowSourcePackages=[]`、findings 为空；AI 为 101 source、1 root public export/100 nested。Edge import 仍为 121
  modules，Cluster dependency/deployment 均 compatible。
- 十档串行 artifact 全部 compatible；非 AI 六档相对 ADR-0331 精确不变，AI 四档固定 +2,847 bytes/+5 files、loaded
  modules +0。
- 强制索引为 44,319 nodes/101,102 edges/1,728 clusters/296 flows。post-impact 中公开 repository 为 LOW
  （3 direct/3 total/2 process），admit/finalize operation 均 LOW（1 direct/1 total/0 process）；共享 identity、row text、
  canonical JSON、queue 和 admission lookup 为 MEDIUM，最高 8 direct/16 total/1 process，无 HIGH/CRITICAL。
- `detect_changes` all/compare `develop` 只作为 Git 基线补充；当前 QL3 孵化树尚未完整进入默认分支索引，因此不能替代逐
  symbol impact、强制索引、完整测试、crash matrix 与制品门。

## 后续约束

公开 repository 只负责稳定 interface implementation、输入 normalization 与 delegation，不重新吸收 SQL、codec 或事务
body。`authority.ts` 不取得业务决策；`admissionRecords.ts` 不自行 enqueue/开事务；`admissionOperation.ts` 必须保持 target
guard 与 admission writes 同事务；`finalizationOperations.ts` 必须保持 terminal evidence、Run CAS、event 与 receipt 同事务。
新增能力按 admission record、admission transaction、finalization lifecycle 的共同变化原因聚合，不按 method 数、LOC 或
schema 名机械建文件或 package。
