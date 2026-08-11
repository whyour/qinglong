# ADR-0323：Local SQLite Adoption 领域归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-64、D-87、D-257
- 关联 ADR：ADR-0064、ADR-0095、ADR-0312、ADR-0321、ADR-0322

## 背景

ADR-0321/0322 已区分 workspace package 与 package-private module：package 表达部署、authority、依赖、adapter、
multi-consumer 或供应链边界，包内领域目录表达共同变化的 ownership。继续审计 `@qinglong/local-admin` 时发现，
`legacy-adoption/localSqliteAdoption.ts` 以 1,940 行同时拥有：

1. Legacy SQLite read-only 打开、catalog 证据与 crontab inventory/diagnostic；
2. reviewed decision receipt、authorization file、issuer 与 publisher bridge；
3. migration staging、backup、manifest 与 snapshot verification；
4. SQLite source `BEGIN IMMEDIATE` write fence；
5. activation document、prepare 与 acquire。

这不是“包太细”，而是同一 Local Admin 运行单元内的五类 ownership 被平铺在一个文件中。把这些职责各自发布成
workspace package 会制造部署和依赖噪声；继续维持单文件则会让 inspection、review、staging 与 activation 的安全边界
难以独立评审。

编辑前已对原文件内全部 49 个 function、class 和 method 执行 GitNexus upstream impact。稳定错误
`LocalSqliteAdoptionError` 为 CRITICAL（35 direct/55 total/0 flows）；共享 path/file/hash helper 与
`inspectLegacySqlitePath` 主要为 MEDIUM，其余多数为 LOW。CRITICAL 风险已先告警，本轮只移动实现归属和维持同一
export identity，不改变 SQLite、文件系统或 adoption 协议。

## 决策

保持一个 `@qinglong/local-admin` package、一个既有 public subpath 和 66 行稳定 facade，在
`legacy-adoption/local-sqlite-adoption/` 下形成以下 package-private ownership：

```text
localSqliteAdoption.ts                   # stable public facade
local-sqlite-adoption/
├── contracts.ts                        # schemas, types and stable error identity
├── filesystem.ts                       # path, file identity, hashing and atomic private writes
├── inspection.ts                       # legacy catalog and task inventory
├── staging.ts                          # backup, migration, manifest and verification
├── sourceFence.ts                      # shared SQLite source write fence
├── review.ts                           # reviewed receipt/authorization/publication bridge
└── activation.ts                       # activation prepare and acquire
```

内部依赖保持有向无环。`contracts.ts` 不取得文件系统或 SQLite authority；`filesystem.ts` 只拥有通用的严格文件证据；
`inspection.ts` 保持 legacy adoption module 的 lazy load；`staging.ts` 唯一拥有备份、migration 与 manifest；
`sourceFence.ts` 是 review 和 activation 共同依赖的安全 primitive，单独放置以避免二者形成循环；`review.ts` 保持
reviewed authorization/publisher bridge 的 lazy load；`activation.ts` 唯一拥有 activation 生命周期。

原 facade 只显式 re-export 既有公共类型和 13 个 runtime object。所有 runtime export 与 owner module 保持同一个
class/function identity，`instanceof`、错误 code/message、package export 与调用路径不变；package-private
`FileIdentity`、hash、atomic write 和 fence helper 不扩展为公共 API。没有新增 public subpath、workspace package、
dependency 或部署单元。

本轮不修改：SQLite read-only inspection、catalog/schema evidence、任务分类、decision receipt/authorization、source
file identity、hash、backup、migration、manifest、原子写入、no-follow/realpath fence、`BEGIN IMMEDIATE`、snapshot
verification、activation fence、错误映射或返回结构。

## 包与目录粒度规则

`packages/*/src` 不应长期用大量无领域归属的平铺实现文件承载系统，但修复方式也不是“一目录一 package”。后续统一采用：

1. 只有独立 deployable、authority、dependency、adapter、multi-consumer 或供应链边界才能新建 workspace package；
2. 同一 package 内按业务领域和共同变化原因建立私有目录，根 `src` 只保留受审 public facade、composition root 或 bin；
3. 一个领域允许多个内聚文件，也允许一个纯 schema/codec 文件较大；不按 LOC、函数数或单文件 package 机械拆合；
4. 共享 helper 只有在具有稳定语义和两个以上真实 owner 时才提取，禁止建立 `utils/` 杂物层；
5. 拆分必须保持依赖 DAG、公共 export identity、Profile closure、制品预算与部署拓扑。

## 小设备与集群影响

本轮只影响包含 Local Admin adoption 能力的六档制品，分别增加 10,417 bytes/7 physical files，实际 loaded module 数
不变：Adopted 为 50、Application 为 116、Application AI 为 115。最小 Edge/Standalone 和基础 AI Profile 不包含
Local Admin，因此低配路由设备不会因为包内目录化增加其安装闭包或常驻模块。

六档 pack/install/import/RSS 门全部 compatible；本机 RSS 样本保持在现有 Profile 门限内。物理文件增加用于源码和
制品 ownership，不等于增加进程、线程、listener、timer、数据库连接或服务发现。

Cluster 继续通过原 Local Admin/Runtime contract 组合集群能力；本轮没有 SQL、migration、PostgreSQL、Cluster
runtime、Kubernetes resource 或部署拓扑变化，因此不重复 PostgreSQL HA Docker 门。

## 被否决方案

1. **七个 owner 各建 workspace package**：不存在七个独立部署或消费者闭包，拒绝。
2. **维持 1,940 行平铺文件**：inspection、review、staging、fence 与 activation 无法独立评审，拒绝。
3. **每个 function 一个文件**：破坏同一协议的内聚性并增加导航成本，拒绝。
4. **把所有 helper 放进 `utils.ts`**：隐藏 file identity 与安全 fence 的真实 ownership，拒绝。
5. **把 source fence 归 review 或 activation**：另一侧会反向依赖并可能形成循环，拒绝。
6. **趁拆分重写 adoption 协议**：CRITICAL blast radius 下无法区分 ownership 回归与语义回归，拒绝。

## 验收证据

- facade 1,940→66 行；contracts 229、filesystem 172、inspection 290、review 446、staging 504、sourceFence 117、
  activation 311 行。
- facade 与 owner 的 13 个 runtime export identity 全部相同；Local Admin 91/91。
- 完整 16-package clean topology build/test 在允许 loopback TLS 与 crash 子进程的门环境退出 0。
- package boundary 为 16 package、830 source、25 root、805 nested，`singleSourcePackages=[]`、
  `shallowSourcePackages=[]`、findings 为空；Local Admin 为 43 source、1 root/42 nested。Edge import、Cluster
  dependency 与 Cluster deployment 全部 compatible。
- Adopted Edge/Standalone 为 4,265,052/4,265,112 bytes、394 files、50 loaded modules；Application 为
  4,762,901/4,763,021 bytes、453 files、116 modules；Application AI 为 6,158,278/6,158,410 bytes、532 files、
  115 modules。相对 ADR-0322 各增加 10,417 bytes/7 files，loaded module 数不变，六档均 compatible。
- 最终强制索引为 44,038 nodes/100,277 edges/1,729 clusters/274 flows。post-impact 中稳定错误保持 CRITICAL
  （40 direct/54 total/0 flows），`sha256Text` 与 inspection 保持 MEDIUM（7/24、8/13），source fence 为 LOW
  （3/3），staging/review/activation 代表 coordinator 为 LOW（0/0）；高风险调用关系没有因 facade re-export 被隐藏。
- `detect_changes` all/compare `develop` 仍只映射已跟踪 Legacy baseline 的 12/31 与 14/34、low/0 process；当前
  QL3 孵化树尚未完整进入 Git baseline，因此该结果只作补充，不能替代强制全索引、完整测试和六档制品门。

## 后续约束

Local SQLite Adoption 后续修改必须落入明确 owner，并继续保持 source fence 为共享安全 primitive、公共 facade identity
和现有 adoption contract tests。下一轮仍只处理确有多个变化原因的实现；纯 schema、normalizer 或单一 repository
authority 不因文件较大机械拆分，也不因包内文件较少机械合并 workspace package。
