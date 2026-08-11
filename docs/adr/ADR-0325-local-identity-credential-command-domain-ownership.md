# ADR-0325：Local Identity Credential Command 领域归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-75、D-76、D-79、D-80、D-81、D-82、D-87、D-257
- 关联 ADR：ADR-0075、ADR-0076、ADR-0081、ADR-0082、ADR-0083、ADR-0209、ADR-0276、ADR-0324

## 背景

QingLong 3.0 已把 workspace package 收敛到 16 个，并用 package boundary gate 禁止单文件和浅层源码 package。
当前问题不再是继续合并 package，而是部分既有 package 内仍有单文件同时拥有多个安全职责。审计
`@qinglong/local-owner-cli` 时发现，`security-management/identityCredentialCommand.ts` 的 1,226 行实现同时拥有：

1. public command/result contract 与三个稳定 error identity；
2. command path、exact-shape request codec 和 private command-file read；
3. dependency、clock、failure audit、current credential 与 transaction fence；
4. Identity inspect/register/enable/disable；
5. API Credential inspect/issue/rotate/revoke；
6. credential delivery acknowledgement 与最终 runner composition。

这些能力共享同一个短生命周期 Owner CLI deployment/authority boundary，不具备拆成新 workspace package 的独立交付
价值；但继续平铺在一个文件内会让协议、低权限解析和高权限执行无法独立评审，也会诱导未来修改取得超过职责所需的
数据库、Pepper、Secret delivery 或管理服务权限。

编辑前已对文件内 26 个 function、class 和 method 逐一执行 GitNexus upstream impact。稳定
`LocalIdentityCredentialCommandConfigurationError` 为 HIGH（15 direct/17 total/1 process，覆盖 5 条 run flow）；
其余两个 error 与所有 helper/coordinator 为 LOW。HIGH 风险已先告警，本轮只移动 ownership、建立 delegation 和精确
依赖边界，不修改命令或执行语义。

## 决策

保持一个 `@qinglong/local-owner-cli` package、既有 public file seam 和 23 行稳定 facade，在
`security-management/identity-credential-command/` 下建立 package-private DAG：

```text
identityCredentialCommand.ts            # stable public facade
identity-credential-command/
├── contracts.ts                         # public types and stable error identity
├── contractAuthority.ts                 # type-only reviewed contract bridge
├── codec.ts                             # path, exact-shape request and command-file codec
├── codecAuthority.ts                    # command-file and pure validator bridge
├── executionSupport.ts                  # dependencies, clock, audit and auth fence
├── executionAuthority.ts                # database/auth/Pepper/admin authority bridge
└── runner.ts                            # identity/credential/delivery orchestration
```

依赖固定为 contracts→codec/execution support→runner。`contractAuthority.ts` 只导出 contract 所需类型；
`codecAuthority.ts` 只导出 command-file reader 和纯 validator；`executionAuthority.ts` 才拥有真实数据库、认证、Pepper、
Secret delivery 和 administration authority。三个桥都是精确文件、精确 specifier allowlist，不允许目录 wildcard。

不建立一个 all-in-one internal barrel。Node CommonJS 的聚合 barrel 会在只解析 command 时 eager load 数据库、Pepper、
delivery 和管理服务，扩大启动 RSS、加载时间和 authority closure；角色桥使低配路由设备的一次性 CLI 只加载当前阶段
需要的模块。Cluster 节点也复用相同源码边界，但不把本机 SQLite/credential file CLI 误当成 PostgreSQL 管理协议。

原 facade 只显式 re-export 既有 public types、三个稳定 error、runner factory 和 command-file runner。5 个 runtime
export 与 owning module 保持同一个 object，维持 constructor、`instanceof`、错误 code/message、package export 和
调用路径；没有新增 public subpath、workspace package、production dependency、进程或部署单元。

本轮不修改：command JSON/path/shape、private-file fence、Identity/Credential operation、认证、Pepper、entropy、token
digest、credential lifetime、current credential、delivery、acknowledgement、failure audit、SQLite transaction fence、
exact replay、错误映射或低敏输出。

## 边界门反馈

第一次 dependency audit 拒绝了四个新 owner 对外部 authority 的直接导入。该反馈证明“只移动到子目录”仍可能扩大
权限面。本轮没有给整个目录增加 allowlist，而是建立三个按角色分离的精确 bridge，并把旧 facade 的许可分别迁移到
exact file/exact specifier。`auditSourceImports` 编辑前为 LOW/0 affected process；最终 Local Owner CLI 72 个源码文件
全部受审，dependency findings 为空。

## 小设备与集群影响

Identity Credential Command 是显式调用、短生命周期的 Owner 管理面，不进入 Edge、Standalone、Adopted、Application、
AI 或 Application AI 十档稳态 Profile artifact。十档 closure、bytes、physical files 与 loaded modules 相对
ADR-0324 精确不变；最低配 Edge/Standalone 仍为 49 loaded modules。没有新增常驻连接、Pool、timer、watcher、listener、
缓存、目录扫描或后台进程。

Cluster 使用独立 PostgreSQL、RBAC、TLS 和职责分离管理面，不导入本机 command runner。本轮没有 SQL、migration、
PostgreSQL、Cluster runtime、Kubernetes resource 或部署拓扑变化，因此虽然已获准运行 PostgreSQL HA Docker 门，
仍不制造与本次变更无关的新 HA 证据。

## 被否决方案

1. **为 Identity、Credential、Delivery 各建 workspace package**：没有独立部署或消费者闭包，会重新制造微包，拒绝。
2. **继续保留 1,226 行平铺文件**：协议、低权限解析和高权限执行继续耦合，拒绝。
3. **一个聚合 internal barrel**：会 eager load 高权限 adapter，扩大低配 CLI 启动闭包，拒绝。
4. **为整个内部目录开放 wildcard allowlist**：未来文件可静默获得全部 authority，拒绝。
5. **按每个 operation 拆一个文件**：会形成一函数一文件并分散共享 transaction/audit fence，拒绝。
6. **趁拆分重写状态机、鉴权或 delivery 协议**：HIGH blast radius 下无法区分 ownership 与语义回归，拒绝。

## 验收证据

- facade 1,226→23 行；contracts 252、contract bridge 9、codec 452、codec bridge 7、execution support 198、
  execution bridge 45、runner 369 行；总计 1,355 行，新增行主要是显式 import/export 边界。
- facade 与 owner 的 5 个 runtime export identity 全部相同；Owner CLI 134/134。
- 完整 16-package clean topology build/test 退出 0；所有执行测试 0 fail，外部 PostgreSQL/S3 与 Linux `/proc` 条件项
  保持显式 skip。
- package boundary 为 16 package、845 source、25 root、820 nested，`singleSourcePackages=[]`、
  `shallowSourcePackages=[]`、findings 为空；Owner CLI 为 72 source、1 root binary/71 nested。Edge import 为 121
  modules 且无 forbidden；Cluster dependency 与 deployment 全部 compatible/findings 为空。
- 十档 artifact 与 ADR-0324 精确相同：Edge/Standalone 3,644,543/3,644,579 bytes、342 files、49 modules；
  Adopted 4,265,052/4,265,112 bytes、394 files、50 modules；Application 4,762,901/4,763,021 bytes、453 files、
  116 modules；AI 5,039,854/5,039,902 bytes、421 files、50 modules；Application AI
  6,158,278/6,158,410 bytes、532 files、115 modules。
- 最终强制索引为 44,076 nodes/100,398 edges/1,730 clusters/274 flows。post-impact 中配置 error 保持 HIGH
  （18 direct/21 total/1 process）；codec read、failure audit、auth fence、runner factory/file runner 与边界审计函数均为
  LOW，高风险关系没有被 facade 或桥隐藏。
- `detect_changes` all/compare `develop` 仍只映射已跟踪 Legacy baseline 的 12/31 与 14/34、low/0 process；当前 QL3
  孵化树尚未完整进入 Git baseline，因此该结果只作补充，不能替代逐 symbol impact、强制全索引、完整测试与制品门。

## 后续约束

Identity Credential Command 后续修改必须落入明确 owner。纯 contract 不得取得 runtime authority，codec 不得取得
数据库/Pepper/admin authority，execution authority 不得泄漏为新 public subpath；跨包引用只能经三个精确角色桥，
不得扩大为目录 wildcard。下一轮继续审计 package 内真正的多职责平铺实现；单一 schema、normalizer、repository 或
很小但拥有清晰共享边界的 package 不按 LOC/文件数机械拆分或合并。
