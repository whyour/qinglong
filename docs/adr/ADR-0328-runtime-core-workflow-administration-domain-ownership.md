# ADR-0328：Runtime Core Workflow Administration 领域归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-08、D-09、D-12、D-70、D-85、D-87、D-207、D-212、D-213、D-250、D-251、D-257
- 关联 ADR：ADR-0270、ADR-0276、ADR-0277、ADR-0282、ADR-0283、ADR-0284、ADR-0285、ADR-0286、ADR-0327

## 背景

ADR-0321 至 ADR-0327 已明确：workspace package 表达可部署、authority、依赖、adapter、multi-consumer 或供应链
边界，package-private 目录表达同一发布单元内的领域 ownership。继续审计 `@qinglong/runtime-core` 时发现，公开 subpath
背后的 `pluginPackageWorkflowAdministration.ts` 虽然不持有数据库或网络 authority，但 1,604 行单文件同时定义并校验：

1. Workflow admission 与 repository contract；
2. cancellation contract、result 和稳定错误；
3. Run inspection command/result；
4. Run history 的 page/cursor/item/result；
5. StepRun page/cursor/item/result；
6. RunEvent sequence page/item/result；
7. 共享 exact-shape、identity、Package、resource、fence、actor/audit binding codec。

这些 contract 都属于一个稳定的 `plugin-package-workflow-administration` public subpath，不应拆成新 workspace package
或多个 public subpath；但继续平铺会让五类读取协议、两类 mutation 和共享安全 codec 无法独立演进、审阅和测试。

编辑前对原文件全部 38 个 class、function 和 method（包括 7 个 repository method 与 4 个 constructor）执行 GitNexus
upstream impact。三个稳定 error、`exactKeys` 以及 admission/inspection/list repository method 为 HIGH，其中两个冲突
错误与 admission method 影响 1 条执行流；共享 subject/fence/identifier helper 为 MEDIUM，其余为 LOW，无 CRITICAL。
本轮仅移动 ownership，不修改任何公开 contract 或 normalization 语义。

## 决策

保持一个 `@qinglong/runtime-core` package、一个 public subpath 和 7 行 facade，在原 Workflow 目录内建立 package-private
领域目录：

```text
pluginPackageWorkflowAdministration.ts        # stable public facade
plugin-package-workflow-administration/
├── contracts.ts                              # all public types, schemas and budgets
├── errors.ts                                 # four stable runtime error identities
├── support.ts                                # shared exact-shape/identity/fence codec
├── runInspection.ts                          # one Run inspection normalization
├── runList.ts                                # newest-first Run keyset page
├── stepRunList.ts                            # ordered StepRun keyset page
├── runEventList.ts                           # contiguous RunEvent sequence page
└── mutation.ts                               # admission and cancellation normalization
```

`contracts.ts` 只使用 type-only domain imports，避免仅消费接口时加载实现。`support.ts` 是 package-private 共享 codec，
不从 facade 或 package manifest 导出。五个 operation owner 只能依赖 contracts、errors、support 和各自必要的 Run/Security/
Workflow plan contract；它们不取得 filesystem、process、timer、network、SQLite 或 PostgreSQL authority。

facade 只 re-export 原有公开集合。26 个 runtime export 与 owning module 保持同一个 object，包括四个 error constructor、
四个 schema、六个 page budget、cancellation status 和十一项 normalizer；没有新增 public subpath、workspace package、
production dependency、进程或部署单元。

本轮不修改 exact keys、identifier/Package/resource pattern、page limit、cursor order、Run/StepRun/Event 状态约束、连续
sequence、low-sensitive projection、strong User、allowed audit、authentication/fence binding、admission time binding、
cancellation reason/result、错误 code/message 或 repository method shape。

## 小设备与集群影响

所有本机 Profile 都携带裁剪后的 Runtime Core 文件，因此目录拆分为每档增加固定 5,801 bytes 和 8 个物理 JavaScript
文件；loaded modules 完全不变：Edge/Standalone 49、Adopted 50、Application 116、AI 50、Application AI 115。
最小 Edge 产物为 3,650,344 bytes，仍低于 4 MiB hard cap；没有新增常驻连接、Pool、timer、watcher、listener、缓存
或后台进程。

Cluster 继续通过原 public subpath 共享同一纯 contract/normalizer，并使用独立 PostgreSQL repository、TLS、RBAC、quota
和多副本 transport。dependency/deployment audit 未出现新依赖或 authority。本轮没有 SQL、migration、PostgreSQL、
Kubernetes resource 或部署拓扑变化，因此虽已获准，仍不重复执行与本次纯 Runtime Core ownership 重构无关的
PostgreSQL HA Docker 门。

## 被否决方案

1. **为 inspection/list/event/mutation 各建 workspace package**：没有独立部署、依赖或 authority 边界，会制造微包。
2. **为每个 normalizer 建文件**：共享协议会退化成一函数一文件，增加导航成本而不提升 ownership。
3. **新增五个 public subpath**：扩大长期兼容面，并允许消费者绕过统一 Workflow Administration contract。
4. **公开 `support.ts`**：会把内部 exact-shape helper 变成可依赖 API，阻碍未来实现替换。
5. **趁拆分改变 page budget、regex 或 error mapping**：会把结构重构与协议版本变更混在一起。
6. **继续保留 1,604 行单文件**：读取、mutation 和共享安全 codec 继续互相遮蔽，拒绝。

## 验收证据

- facade 1,604→7 行；contracts 265、errors 41、support 86、Run inspection 228、Run list 282、StepRun list 339、
  RunEvent list 254、mutation 206 行，总计 1,708 行；新增行主要是显式 import/export ownership。
- 26/26 runtime export identity 相同，无 missing、extra 或 identity drift；Runtime Core 445/445。
- 完整 16-package clean topology build/test 退出 0；Cluster PostgreSQL、Local SQLite、Local Admin、Owner CLI 和 Local
  Application 的 Workflow 调用链全部通过，外部 PostgreSQL/S3 与 Linux `/proc` 条件项保持显式 skip。
- package boundary 为 16 package、871 source、25 root、846 nested，`singleSourcePackages=[]`、
  `shallowSourcePackages=[]`、findings 为空；Runtime Core 为 132 source、1 root public export/131 nested。Edge import
  为 121 modules 且无 forbidden；Cluster dependency/deployment 全部 compatible/findings 为空。
- 串行十档 artifact 全部通过。Edge/Standalone 3,650,344/3,650,380 bytes、350 files、49 modules；Adopted
  4,270,853/4,270,913 bytes、402 files、50 modules；Application 4,768,702/4,768,822 bytes、461 files、116
  modules；AI 5,045,655/5,045,703 bytes、429 files、50 modules；Application AI 6,164,079/6,164,211 bytes、
  540 files、115 modules。相对 ADR-0327 每档固定 +5,801 bytes/+8 files、loaded modules +0。
- 制品门不能并行共享构建目录：一次并行尝试因相互清理 `dist` 出现无效 `.d.ts` 编译结果，已废弃该批证据并按十档
  串行重跑全部通过。
- 最终强制索引为 44,160 nodes/100,542 edges/1,727 clusters/274 flows。post-impact 中 invalid error 为 CRITICAL
  （32 direct/32 total/0 process），两个冲突 error 为 HIGH（10/29/1 与 22/31/1），`exactKeys` 为 HIGH
  （16/16/0）；五个 operation 代表 normalizer 为 LOW。显式内部引用使共享错误的 blast radius 更完整，没有新增行为。
- `detect_changes` all/compare `develop` 仍只映射已跟踪 Legacy baseline 的 12/31 与 14/34、low/0 process；当前 QL3
  孵化树尚未完整进入 Git baseline，因此它只作补充，不能替代逐 symbol impact、强制索引、完整测试与制品门。

## 后续约束

Workflow Administration 的公开兼容面继续由单一 facade 管理。contracts/errors 不得取得运行 authority；support 不得
公开；各 operation owner 不得互相调用或修改其他 operation 的预算。新增 use case 只有在具备完整 command/result、独立
审计语义和明确分页/状态不变量时才建立领域 owner，不按函数数量或 LOC 机械拆分。
