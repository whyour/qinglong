# ADR-0326：Local Plugin Package Prompt Command 领域归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-75、D-76、D-79、D-80、D-81、D-82、D-87、D-255、D-257
- 关联 ADR：ADR-0176、ADR-0255、ADR-0274、ADR-0276、ADR-0325

## 背景

ADR-0321 至 ADR-0325 已固化：workspace package 表达部署、authority、依赖、adapter、multi-consumer 或供应链边界，
package-private 领域目录表达内部 ownership。继续审计 `@qinglong/local-owner-cli` 时发现，
`plugin-package/pluginPackagePromptCommand.ts` 的 1,535 行平铺实现同时拥有：

1. public command/result contract 与五个稳定 error identity；
2. path、exact-shape request、output retention 与 private command-file codec；
3. strong User、Project Policy、multi-permission fence 与 allowed audit；
4. Provider authority、Encrypted Secret、credential binding 与 gateway lifecycle；
5. Prompt catalog inspect、execution inspect、durable output read 与 Prompt execute/replay；
6. SQLite credential/Policy transaction fence、failure audit、gateway drain 和 database close。

这些能力属于同一个短生命周期 `ql3-prompt` 产品入口，不具备拆成新 workspace package、daemon 或 API service 的独立
交付价值；但继续平铺在一个文件内会混合纯协议、鉴权、Secret/Provider authority 和执行编排，使低权限代码可以在同一
模块中触达全部高权限依赖。

编辑前已对文件内 39 个 class、function 和 method（包括 interface method、构造器与 runner 内联 callback）逐一执行
GitNexus upstream impact。`LocalPluginPackagePromptCommandConfigurationError` 为 MEDIUM（13 direct/15 total/
1 process），`LocalPluginPackagePromptUnavailableError` 为 MEDIUM（5/5/1），其余为 LOW，无 HIGH/CRITICAL。本轮只移动
ownership 和建立 delegation，不修改 Prompt 产品语义。

## 决策

保持一个 `@qinglong/local-owner-cli` package、既有 public subpath 和 26 行稳定 facade，在
`plugin-package/plugin-package-prompt-command/` 下建立 package-private DAG：

```text
pluginPackagePromptCommand.ts            # stable public facade
plugin-package-prompt-command/
├── contracts.ts                         # public command/result and stable errors
├── codec.ts                             # path, exact shape, output and command file
├── authorization.ts                     # strong User, Policy fence and allowed audit
├── executionSupport.ts                  # Provider loader, dependency/replay/drain support
├── runner.ts                            # operation dispatch and lifecycle composition
├── contractAuthority.ts                 # type-only contract bridge
├── codecAuthority.ts                    # private command-file bridge
├── authorizationAuthority.ts            # Policy/security/audit bridge
├── supportAuthority.ts                  # Provider/Secret support bridge
└── runnerAuthority.ts                   # execution and SQLite composition bridge
```

主依赖固定为 contracts→codec/authorization/execution support→runner。五个 authority bridge 均为 exact file、exact
specifier allowlist：contract bridge 只暴露类型；codec bridge 只暴露 private command reader；authorization bridge
只暴露 Policy/security/audit；support bridge 才能取得 Provider credential 与 Secret；runner bridge 才能取得 Prompt
repository、gateway、output、authentication 和 SQLite transaction fence。内部 owner 不直接跨 package 导入 authority，
也不开放目录 wildcard。

原 facade 显式 re-export 既有 public types、五个 error、runner factory 和 command-file runner。7 个 runtime export
与 owning module 保持同一个 object，维持 constructor、`instanceof`、错误 code/message、package export 和 CLI 调用
路径；没有新增 public subpath、workspace package、production dependency、进程或部署单元。

本轮不修改：command path/JSON/shape、参数与 retention budget、strong User、三权限合取、Policy fence、allowed/failure
audit、AI feature active fence、Provider manifest、Secret keyring、credential binding、catalog/inspection/output read、
Prompt plan/replay、publication selection、gateway concurrency/recovery、durable output、deadline、transaction callback、
stop-before-database-close、错误映射或低敏输出。

## 边界门反馈

第一次 dependency audit 返回 17 条 finding，精确指出新 owner 尚未继承旧 facade 对 command-file、authentication、
SQLite optional runtime、Secret 和 Runtime security subpath 的受审权限。本轮没有把整个目录加入 allowlist，也没有恢复
旧 facade 权限；而是将权限分别迁移到五个角色桥。`auditSourceImports` 编辑前为 LOW/0 affected process。最终 Local
Owner CLI 82 个源码文件全部受审，dependency findings 为空。

## 小设备与集群影响

`ql3-prompt` 是显式调用、短生命周期的 Owner 管理面，不进入 Edge、Standalone、Adopted、Application、AI 或
Application AI 十档稳态 Profile artifact。十档 closure、bytes、physical files 与 loaded modules 相对 ADR-0325
精确不变；最小 Edge/Standalone 仍为 49 loaded modules。没有新增常驻连接、Pool、timer、watcher、listener、缓存、
后台进程或自动 Provider 发现。

Cluster 使用独立 PostgreSQL、TLS、RBAC、quota 与多副本 Prompt transport，不导入本机 SQLite command runner。本轮没有
SQL、migration、PostgreSQL、Cluster runtime、Kubernetes resource 或部署拓扑变化，因此不重复 PostgreSQL HA Docker 门。

## 被否决方案

1. **为 codec/auth/Provider/operation 各建 workspace package**：没有独立部署或生产消费者闭包，会制造微包，拒绝。
2. **继续保留 1,535 行平铺模块**：纯协议和 Provider/Secret/SQLite 高权限实现继续耦合，拒绝。
3. **用一个全权限 internal barrel**：未来 codec 或 contract 可间接获得全部执行 authority，拒绝。
4. **为内部目录开放 wildcard allowlist**：新增文件可静默取得 Secret/SQLite/Provider 权限，拒绝。
5. **每个 operation/inline callback 拆一个文件**：会形成一函数一文件并分散共享 transaction/failure lifecycle，拒绝。
6. **趁拆分引入动态 Provider 加载或重写 runner 状态机**：会把 ownership 重构与启动/失败语义变化混在一起，拒绝。

## 验收证据

- facade 1,535→26 行；contracts 251、codec 531、authorization 147、execution support 103、runner 535 行；五个
  role bridge 分别为 10/4/13/13/36 行，总计 1,669 行，新增行主要是显式 import/export 权限边界。
- facade 与 owner 的 7 个 runtime export identity 全部相同；Owner CLI 134/134。
- 完整 16-package clean topology build/test 退出 0；所有执行测试 0 fail，外部 PostgreSQL/S3 与 Linux `/proc` 条件项
  保持显式 skip。真实 Edge Prompt 资源证据保持 exact replay/content-free、2 次 provider call、1 次 key load，RSS 增量
  15,515,648 bytes。
- package boundary 为 16 package、855 source、25 root、830 nested，`singleSourcePackages=[]`、
  `shallowSourcePackages=[]`、findings 为空；Owner CLI 为 82 source、1 root binary/81 nested。Edge import 为 121
  modules 且无 forbidden；Cluster dependency 与 deployment 全部 compatible/findings 为空。
- 十档 artifact 与 ADR-0325 精确相同：Edge/Standalone 3,644,543/3,644,579 bytes、342 files、49 modules；
  Adopted 4,265,052/4,265,112 bytes、394 files、50 modules；Application 4,762,901/4,763,021 bytes、453 files、
  116 modules；AI 5,039,854/5,039,902 bytes、421 files、50 modules；Application AI
  6,158,278/6,158,410 bytes、532 files、115 modules。
- 最终强制索引为 44,097 nodes/100,434 edges/1,730 clusters/274 flows。post-impact 中配置 error 为 HIGH
  （17 direct/20 total/1 process），unavailable error 为 MEDIUM（9/10/1）；codec read、replay、runner factory/file
  runner 与边界审计函数均为 LOW。模块化使共享错误的真实跨 owner 风险更清晰，没有通过 facade 隐藏风险。
- `detect_changes` all/compare `develop` 仍只映射已跟踪 Legacy baseline 的 12/31 与 14/34、low/0 process；当前 QL3
  孵化树尚未完整进入 Git baseline，因此该结果只作补充，不能替代逐 symbol impact、强制全索引、完整测试与制品门。

## 后续约束

Prompt Command 后续修改必须落入明确 owner。contract/codec 不得取得 Provider、Secret 或 SQLite mutation authority；
authorization 不得创建 gateway；Provider support 不得改写 command；runner 不得把内部 bridge 暴露为 public subpath。
跨包依赖只能经五个精确角色桥，不得扩大为目录 wildcard。下一轮继续审计真正多职责实现；单一 schema declaration、
normalizer、repository 或具有明确职责的小文件不按 LOC 机械拆分。
