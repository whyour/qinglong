# ADR-0322：Trusted Tool Invocation 领域归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-87、D-150、D-151、D-257
- 关联 ADR：ADR-0159、ADR-0162、ADR-0219、ADR-0303、ADR-0321

## 背景

ADR-0321 固化了 package 与内部 module 的不同判据：workspace package 表达部署、authority、依赖、adapter、
multi-consumer 或供应链边界；package-private 目录表达共同变化的 ownership。下一轮大文件审计发现，Runtime Core 的
`trustedToolInvocation.ts` 并非单一 schema declaration，而是在 1,597 行中同时拥有：

1. Trusted Tool handler/plan/admission 的公开 contract 与稳定错误 identity；
2. exact-shape validator、SemVer identity、canonical digest 与 security fence codec；
3. snapshot-bound handler binding 与 registry；
4. redacted preview、encrypted input Artifact、plan seal 与 approval dispatch binding；
5. current Policy revalidation、durable start evidence 与 execution admission coordinator。

这些职责共享一个公开 subpath，却有不同的消费者、依赖和演进原因。继续放在单文件会让修改 handler registry 时同时
触碰 policy admission，或让 plan/Artifact 变更无意影响稳定错误与 contract。

编辑前已对文件内全部 function、class 和 method 执行 GitNexus upstream impact。共享 `invalid` helper 为 HIGH：
25 个直接上游、40 个累计上游、影响 2 条 Tool 执行流程；错误 class、共享 codec 与 registry resolve 主要为 MEDIUM，
plan/admission coordinator 主要为 LOW，没有 CRITICAL。HIGH 风险已先告警，本轮只逐字移动 ownership，不重写协议。

## 决策

保持一个 `@qinglong/runtime-core` package、一个现有 public subpath 和 19 行稳定 facade，在
`tool-execution/trusted-tool-invocation/` 下形成单向依赖层次：

```text
trustedToolInvocation.ts                 # stable public facade
trusted-tool-invocation/
├── contracts.ts                         # schemas, types, error identities
├── codec.ts                             # validators, identity and digest codec
├── binding.ts                           # handler binding and registry
├── plan.ts                              # preview, Artifact, plan and approval binding
└── admission.ts                         # Policy revalidation and execution admission
```

内部依赖固定为：

```text
contracts <- codec <- binding <- plan <- admission
```

`contracts.ts` 不取得 crypto、SemVer、Artifact factory、Policy authorizer 或 registry runtime authority；`codec.ts`
唯一拥有 digest domain 与严格共享 validator；`binding.ts` 唯一拥有 snapshot-bound handler registry；`plan.ts` 唯一创建
input/preview Artifact reference 并绑定 Approval；`admission.ts` 唯一执行 current Policy revalidation 和 durable start
evidence admission。不得反向导入或把 executable adapter authority 带回该 public contract seam。

原 facade 只 re-export 既有公共对象。29 个 runtime export 与 owning module 是同一个 object，保持 class constructor、
`instanceof`、function identity、schema constant、错误 code/message、package export 和调用路径不变。没有新增公共 subpath、
workspace package、dependency 或部署单元。

本轮不修改：canonical JSON/digest domain、SemVer provider、binding snapshot/definition fence、Profile availability、
Artifact encryption/reference、redaction contract、Approval dispatch、Policy decision/fence、start evidence、admission digest、
timeout、错误映射或返回结构。

## 小设备与集群影响

五个内部 owner 会增加制品中的物理文件，但没有增加任何受测 Profile 的实际 loaded module 数：Edge/Standalone 基础档
仍为 49、Adopted 为 50、Application 为 116、AI 基础档为 50、Application AI 为 115。说明未使用 Trusted Tool
subpath 的低配路由设备不会因源码 ownership 拆分扩大常驻模块闭包。

十档 pack/install/import/RSS 门全部 compatible；最大本机 RSS delta 为 21,364,736 bytes，仍低于 24 MiB Application
门限。该 RSS 是本机门禁样本，不替代目标路由设备和集群节点的物理性能验收。

Cluster 继续通过同一 Runtime Core contract 组合 PostgreSQL storage/execution adapter；没有新增连接、角色、进程、
timer、listener、route 或 Kubernetes 资源。本轮不改 SQL、migration、PostgreSQL/Cluster runtime 或部署资源，因此不
重复 PostgreSQL HA Docker 门。

## 被否决方案

1. **五个职责各建 workspace package**：没有独立 deployment/dependency/consumer closure，拒绝。
2. **只给原文件换目录或名字**：职责仍混合，拒绝。
3. **每个 validator/function 一个文件**：拆断同一 codec 或 plan 协议，拒绝。
4. **binding 与 admission 放在同一 owner**：把静态信任注册与动态 Policy authority 重新耦合，拒绝。
5. **为减少 loaded module 使用动态 import**：当前 loaded module 未增长，引入异步 contract 与新失败面没有收益，拒绝。
6. **趁拆分修改 digest/Policy/Artifact 语义**：HIGH blast radius 下无法区分 ownership 回归与协议变更，拒绝。

## 验收证据

- facade 1,597→19 行；contract 251、codec 284、binding 258、plan 601、admission 341 行。
- facade 与 owner 的 29 个 runtime export identity 全部相同；Runtime Core 445/445。
- 完整 16-package clean topology build/test 在允许 loopback TLS 与 crash 子进程的门环境退出 0。
- package boundary 为 16 package、823 source、25 root、798 nested，`singleSourcePackages=[]`、
  `shallowSourcePackages=[]`、findings 为空；Runtime Core 为 124 source、1 root/123 nested。Edge import、Cluster
  dependency 与 Cluster deployment 全部 compatible。
- Edge/Standalone 为 3,644,543/3,644,579 bytes、342 files、49 loaded modules；Adopted 为
  4,254,635/4,254,695 bytes、387 files、50 modules；Application 为 4,752,484/4,752,604 bytes、446 files、
  116 modules。AI 基础档为 5,039,854/5,039,902 bytes、421 files、50 modules；Application AI 为
  6,147,861/6,147,993 bytes、525 files、115 modules。相对 ADR-0321 各增加 7,575 bytes/5 files，loaded
  module 数不变，十档均 compatible。
- 最终强制索引为 44,017 nodes/100,225 edges/1,726 clusters/274 flows。post-impact 中 `invalid` 保持 HIGH
  （25 direct/40 total/2 flows），公开 invalid error 为 MEDIUM（6/49/2），binding registry 为 LOW（3/11），
  plan create 与 admission coordinator 为 LOW（0/0）；高风险调用关系没有因 facade re-export 被隐藏。
- `detect_changes` all/compare `develop` 仍只映射已跟踪 Legacy baseline 的 12/31 与 14/34、low/0 process；当前
  QL3 孵化树尚未完整进入 Git baseline，因此该结果只作补充，不能替代强制全索引、完整测试和十档制品门。

## 后续约束

Trusted Tool Invocation 已形成 contract → codec → binding → plan → admission 的单向 ownership。后续修改必须继续保留
同一 public subpath 与 runtime identity，并分别通过 binding/plan/admission 现有 contract tests。下一轮继续审计真正
混合多种 ownership 的实现；5,715 行 Cluster schema 和 4,840 行 Local schema 仍是单一 declaration，不因 LOC 机械拆分。
