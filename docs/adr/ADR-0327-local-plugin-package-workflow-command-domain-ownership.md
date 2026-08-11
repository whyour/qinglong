# ADR-0327：Local Plugin Package Workflow Command 领域归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-75、D-76、D-79、D-80、D-81、D-82、D-87、D-251、D-257
- 关联 ADR：ADR-0251、ADR-0270、ADR-0276、ADR-0326

## 背景

ADR-0321 至 ADR-0326 已将 workspace package 边界和 package 内部源码布局分开治理：只有 deployable、authority、
dependency、adapter、multi-consumer 或供应链边界才创建 package；同一产品边界内的多职责实现则进入 package-private
领域目录。继续审计 `@qinglong/local-owner-cli` 时发现，
`plugin-package/pluginPackageWorkflowCommand.ts` 的 980 行平铺实现同时拥有：

1. public command/result contract、runner contract 和稳定 configuration error；
2. command path、exact-shape request、page/cursor 与 private command-file codec；
3. dependency validation、failure audit 和 authenticated SQLite fence；
4. Workflow definition inspect/start/cancel 与 Run inspect/list 编排；
5. StepRun list、RunEvent list、数据库 lifecycle 和结果映射。

这些能力共同构成短生命周期的 `ql3-workflow` Owner 产品入口，不具备拆成新 workspace package、daemon 或 API service
的独立部署价值。但继续放在单一文件中会让纯 contract/codec 与审计、认证和 SQLite authority 混合，也让未来改动难以
区分解析、授权和执行责任。

编辑前已对原文件内 16 个 class、function 和 method（包括 interface method、构造器和 runner method）逐一执行
GitNexus upstream impact。`LocalPluginPackageWorkflowCommandConfigurationError` 为 MEDIUM（9 direct/12 total/
0 process），其余为 LOW，无 HIGH/CRITICAL。本轮只移动 ownership 并建立 delegation，不修改 Workflow 产品语义。

## 决策

保持一个 `@qinglong/local-owner-cli` package、既有 public subpath 和 20 行稳定 facade，在
`plugin-package/plugin-package-workflow-command/` 下建立 package-private DAG：

```text
pluginPackageWorkflowCommand.ts          # stable public facade
plugin-package-workflow-command/
├── contracts.ts                         # public command/result, runner contract and stable error
├── codec.ts                             # path, exact shape, page/cursor and command file
├── executionSupport.ts                  # dependency, failure audit and authenticated SQLite fence
├── runner.ts                            # operation dispatch and lifecycle composition
├── contractAuthority.ts                 # type/error contract bridge
├── codecAuthority.ts                    # private command-file bridge
├── supportAuthority.ts                  # authentication/audit/SQLite support bridge
└── runnerAuthority.ts                   # Workflow administration composition bridge
```

主依赖固定为 contracts→codec/execution support→runner。四个 authority bridge 均采用 exact file、exact specifier
allowlist：contract bridge 只投影 contract/error；codec bridge 只取得 private command reader；support bridge 才能取得
authentication、audit 和 SQLite fence；runner bridge 才能取得 Workflow administration composition。内部 owner 不直接
跨 package 导入 authority，也不开放目录 wildcard。

原 facade 显式 re-export 既有 public types、稳定 error、runner factory 和 command-file runner。三个 runtime export
与 owning module 保持同一个 object，维持 constructor、`instanceof`、错误 code/message、package export 和 CLI 调用
路径；没有新增 public subpath、workspace package、production dependency、进程或部署单元。

本轮不修改：command path/JSON/exact shape、page/cursor budget、strong User、permission、allowed/failure audit、Plugin
Package identity fence、Workflow definition/Run/StepRun/RunEvent 查询、start/cancel 事务语义、SQLite lifecycle、错误映射
或低敏输出。

## 边界门反馈

第一次 dependency audit 返回 18 条 finding，精确指出新 owner 尚未继承旧 facade 对 command-file、authentication、
audit、SQLite 和 Workflow administration subpath 的受审权限。本轮没有把整个内部目录加入 allowlist，也没有保留旧
facade 的跨包权限；而是把权限迁移到四个角色桥。`auditSourceImports` 编辑前为 LOW/0 affected process。最终 Local
Owner CLI 90 个源码文件全部受审，dependency findings 为空。

## 小设备与集群影响

`ql3-workflow` 是显式调用、短生命周期的 Owner 管理面，不进入 Edge、Standalone、Adopted、Application、AI 或
Application AI 十档稳态 Profile artifact。十档 closure、bytes、physical files 与 loaded modules 相对 ADR-0326
精确不变；最小 Edge/Standalone 仍为 49 loaded modules。没有新增常驻连接、Pool、timer、watcher、listener、缓存、
后台进程或自动发现。

Cluster 使用独立 PostgreSQL、TLS、RBAC、quota 与多副本 Workflow transport，不导入本机 SQLite command runner。本轮
没有 SQL、migration、PostgreSQL、Cluster runtime、Kubernetes resource 或部署拓扑变化，因此虽已获准，仍不重复执行
与本次源码 ownership 无关的 PostgreSQL HA Docker 门。

## 被否决方案

1. **为 contract/codec/support/runner 各建 workspace package**：没有独立部署或生产消费者闭包，会制造微包，拒绝。
2. **继续保留 980 行平铺模块**：纯协议和 authentication/audit/SQLite 高权限实现继续耦合，拒绝。
3. **用一个全权限 internal barrel**：未来 codec 或 contract 可间接获得全部执行 authority，拒绝。
4. **为内部目录开放 wildcard allowlist**：新增文件可静默取得跨包权限，拒绝。
5. **每个 Workflow operation 拆一个文件**：会形成一操作一文件并分散共享 fence/failure/database lifecycle，拒绝。
6. **趁拆分重写事务或查询语义**：会把 ownership 重构和产品行为变化混在一起，拒绝。

## 验收证据

- facade 980→20 行；contracts 232、codec 435、execution support 132、runner 202 行；四个 role bridge 分别为
  9/4/22/5 行，总计 1,061 行，新增行主要是显式 import/export 权限边界。
- facade 与 owner 的三个 runtime export identity 全部相同；Owner CLI 134/134。
- 完整 16-package clean topology build/test 退出 0；所有执行测试 0 fail，外部 PostgreSQL/S3 与 Linux `/proc` 条件项
  保持显式 skip。
- package boundary 为 16 package、863 source、25 root、838 nested，`singleSourcePackages=[]`、
  `shallowSourcePackages=[]`、findings 为空；Owner CLI 为 90 source、1 root binary/89 nested。Edge import 为 121
  modules 且无 forbidden；Cluster dependency 与 deployment 全部 compatible/findings 为空。
- 十档 artifact 与 ADR-0326 精确相同：Edge/Standalone 3,644,543/3,644,579 bytes、342 files、49 modules；
  Adopted 4,265,052/4,265,112 bytes、394 files、50 modules；Application 4,762,901/4,763,021 bytes、453 files、
  116 modules；AI 5,039,854/5,039,902 bytes、421 files、50 modules；Application AI
  6,158,278/6,158,410 bytes、532 files、115 modules。
- 最终强制索引为 44,114 nodes/100,455 edges/1,730 clusters/273 flows。post-impact 中配置 error 为 MEDIUM
  （12 direct/16 total/0 process）；command reader、failure audit、SQLite fence、runner factory/file runner 与边界
  审计函数均为 LOW，且 0 process。内部引用增加使共享错误的静态 blast radius 更完整，但没有产生执行流风险。
- `detect_changes` all/compare `develop` 仍只映射已跟踪 Legacy baseline 的 12/31 与 14/34、low/0 process；当前 QL3
  孵化树尚未完整进入 Git baseline，因此该结果只作补充，不能替代逐 symbol impact、强制全索引、完整测试与制品门。

## 后续约束

Workflow Command 后续修改必须落入明确 owner。contracts/codec 不得取得 authentication、audit 或 SQLite mutation
authority；execution support 不得分派 operation；runner 不得把内部 bridge 暴露为 public subpath。跨包依赖只能经四个
精确角色桥，不得扩大为目录 wildcard。继续审计真正多职责实现，但清晰单责的小文件、schema declaration、normalizer
或 repository 不按 LOC 机械拆分。
