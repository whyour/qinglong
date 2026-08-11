# ADR-0324：Local Owner Secret Delivery 领域归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-75、D-76、D-79、D-80、D-81、D-82、D-87、D-257
- 关联 ADR：ADR-0075、ADR-0079、ADR-0081、ADR-0082、ADR-0083、ADR-0276、ADR-0323

## 背景

ADR-0276、ADR-0321 至 ADR-0323 已固化：workspace package 表达部署、authority、依赖、adapter、multi-consumer
或供应链边界，package-private 目录表达共同变化的 ownership。继续审计 `@qinglong/local-owner-console` 时发现，
`delivery/secretDelivery.ts` 在 1,633 行和一个公开 class 中同时拥有：

1. stable public contract、error identity 与严格 acknowledgement codec；
2. 私有 POSIX 目录/file identity、bounded read、no-follow、no-replace、fsync 与 pending→ready 发布；
3. 从 credential/challenge delivery 完成首次 Owner claim；
4. Bootstrap 与 Credential Recovery 两套 file/database acknowledgement convergence；
5. pending、ready、acknowledged 与 orphan temporary record 的 crash recovery。

这些职责属于同一个短生命周期 Local Owner Console 部署单元，不应拆成新 workspace package；但继续塞在一个 class
中会让 POSIX store、数据库事实协调与 recovery 无法独立评审。

编辑前已对文件内全部 function、class 和 method 执行 GitNexus upstream impact。稳定错误
`LocalOwnerSecretDeliveryError` 为 HIGH（20 direct/35 total/1 process）；`verifyDirectory` 为 HIGH
（2/19/1），`entries` 为 HIGH（7/16/1）；`syncDirectory`、record read/optional 为 MEDIUM，其余 coordinator
主要为 LOW。HIGH 风险已先告警，本轮只移动 ownership 和建立 delegation，不修改协议。

## 决策

保持一个 `@qinglong/local-owner-console` package、一个既有 public file seam 和 7 行稳定 facade，在
`delivery/secret-delivery/` 下形成以下 package-private DAG：

```text
secretDelivery.ts                       # stable public facade
secret-delivery/
├── contracts.ts                        # public types and stable error identity
├── ceremonyContracts.ts                # exact reviewed bootstrap/recovery bridge
├── codec.ts                            # names, strict shapes and acknowledgement mapping
├── privateFilesystemStore.ts           # POSIX identity and two-phase file publication
├── bootstrapClaim.ts                   # delivery-bound first Owner claim
├── acknowledgement.ts                  # bootstrap/recovery acknowledgement convergence
├── recovery.ts                         # bounded crash recovery
└── fileSecretDelivery.ts               # public class composition and delegation
```

依赖只允许从 contracts/ceremony bridge 向 codec、private store、claim/acknowledgement、recovery、composition
单向展开。只有 `ceremonyContracts.ts` 可以导入 sibling `bootstrap` 与 `credential-recovery` ceremony area；其余
owner 必须经该精确桥获得类型或 normalization，不得使用目录 wildcard 或任意 cross-area import。

`privateFilesystemStore.ts` 唯一拥有 UID/mode/device/inode、目录项预算、O_NOFOLLOW、bounded read、temporary file、
hard-link no-replace、file/directory fsync 与 pending→ready 生命周期；`bootstrapClaim.ts` 只拥有 secret delivery 到
Owner claim 的协调；`acknowledgement.ts` 只拥有 file/database acknowledgement convergence；`recovery.ts` 只拥有
启动时有界收敛；`fileSecretDelivery.ts` 保持原 public class method surface 并委托上述 owner。

原 facade 只显式 re-export 既有三个 public type、稳定 error 和 public class。两个 runtime export 与 owner module
保持同一个 object，维持 constructor、`instanceof`、错误 code/message、package export 和调用路径；没有新增公共
subpath、workspace package、production dependency 或部署单元。

本轮不修改：record/acknowledgement JSON shape、文件命名与 digest domain、4 KiB/64-entry budget、0700/0600、UID、
symlink/device/inode fence、pending→ready→acknowledged 顺序、temporary cleanup、secret zeroing、Owner claim、Pepper
digest、database fact matching、exact replay、ack-first recovery、orphan counting、错误映射或返回结构。

## 边界门反馈

第一次 dependency audit 准确拒绝了七个新 owner 对 `bootstrap`/`credential-recovery` 的直接导入，返回
`FORBIDDEN_LOCAL_OWNER_CEREMONY_CROSS_AREA_IMPORT`。本轮没有放宽为目录通配，而是新增唯一 9 行
`ceremonyContracts.ts` 并把审计 allowlist 从旧 facade 精确迁移到该桥；审计函数 `auditSourceImports` 编辑前为
LOW/0 affected process。最终所有其他 owner 均不直接跨 ceremony area，dependency findings 为空。

## 小设备与集群影响

Local Owner Console、Owner CLI 和 Maintenance 是显式调用、短生命周期的管理面，不进入 Edge、Standalone、Adopted、
Application 或 AI 十档稳态 Profile artifact。十档制品相对 ADR-0323 的 package closure、bytes、physical files 与
loaded modules 全部精确不变；最小 Edge/Standalone 仍为 49 loaded modules，Adopted 为 50、Application 为 116、
AI 为 50、Application AI 为 115。低配路由设备不会因本轮源码 ownership 增加常驻模块、连接、timer、watcher、
listener 或目录扫描；执行 Owner ceremony 时仍使用原有有界 64-entry/4 KiB 文件协议。

Cluster 使用独立 PostgreSQL/Cluster Admin ceremony，不导入本机 Secret Delivery。本轮没有 SQL、migration、
PostgreSQL、Cluster runtime、Kubernetes resource 或部署拓扑变化，因此不重复 PostgreSQL HA Docker 门。

## 被否决方案

1. **每个 owner 建 workspace package**：没有独立部署、authority 或生产消费者闭包，拒绝。
2. **保留 1,633 行 public class**：POSIX store、claim、acknowledgement 与 recovery 继续耦合，拒绝。
3. **把 private store 放进 `utils.ts`**：隐藏高风险 file identity/fsync ownership，拒绝。
4. **所有内部文件直接导入 Bootstrap/Recovery**：扩大 ceremony cross-area seam，已被机器门拒绝。
5. **为新目录开放 wildcard allowlist**：无法证明每个未来跨域 import 经评审，拒绝。
6. **趁拆分重写异步状态机或文件协议**：HIGH blast radius 下无法区分 ownership 与语义回归，拒绝。

## 验收证据

- facade 1,633→7 行；contracts 31、ceremony bridge 9、codec 272、private store 593、bootstrap claim 85、
  acknowledgement 462、recovery 252、class composition 115 行。
- facade 与 owner 的 2 个 runtime export identity 全部相同；Local Owner Console 55/55。
- 完整 16-package clean topology build/test 在允许 loopback TLS 与 crash 子进程的门环境退出 0；Owner CLI
  134/134、Local Admin 91/91、Application 40 pass/3 skip。
- package boundary 为 16 package、838 source、25 root、813 nested，`singleSourcePackages=[]`、
  `shallowSourcePackages=[]`、findings 为空；Local Owner Console 为 19 source、0 root/19 nested。Edge import、
  Cluster dependency 与 Cluster deployment 全部 compatible。
- 十档 artifact 与 ADR-0323 精确相同：Edge/Standalone 3,644,543/3,644,579 bytes、342 files、49 modules；
  Adopted 4,265,052/4,265,112 bytes、394 files、50 modules；Application 4,762,901/4,763,021 bytes、453 files、
  116 modules；AI 5,039,854/5,039,902 bytes、421 files、50 modules；Application AI
  6,158,278/6,158,410 bytes、532 files、115 modules；十档均 compatible。
- 最终强制索引为 44,067 nodes/100,395 edges/1,727 clusters/275 flows。post-impact 中稳定错误保持 HIGH
  （26 direct/51 total/2 process），directory identity 与 entries 保持 HIGH（2/14/2、7/14/2），公开 class 为
  LOW（3/5/0），claim/acknowledgement/recovery coordinator 与边界审计函数为 LOW（0/0/0）；模块化后图谱显式识别
  acknowledge 与 recover 两组流程，高风险关系没有因 facade/delegation 被隐藏，也不能解释为风险下降。
- `detect_changes` all/compare `develop` 仍只映射已跟踪 Legacy baseline 的 12/31 与 14/34、low/0 process；当前
  QL3 孵化树尚未完整进入 Git baseline，因此该结果只作补充，不能替代逐 symbol impact、强制全索引、完整测试和
  十档制品门。

## 后续约束

Secret Delivery 后续修改必须落入明确 owner；任何 Bootstrap/Credential Recovery cross-area dependency 只能通过
精确 `ceremonyContracts.ts`，不得扩大 allowlist。公开 class/error identity、POSIX fence、digest/shape、两阶段发布、
acknowledgement convergence 与 crash recovery 测试必须继续保持。下一轮继续审计真实多职责实现，不按 LOC 或文件数
机械拆分纯 schema、normalizer 或单一 repository。
