# ADR-0329：Local SQLite Identity Credential Administration 领域归属

- 状态：Accepted
- 日期：2026-08-10
- 关联 RFC：QL-RFC-0001 D-05、D-27、D-37、D-65、D-72、D-73、D-175、D-197、D-198、D-199、D-200、D-201、D-257
- 关联 ADR：ADR-0209、ADR-0210、ADR-0211、ADR-0276、ADR-0325、ADR-0328

## 背景

ADR-0321 至 ADR-0328 已将 workspace package 边界和 package-private ownership 分开治理。继续审计
`@qinglong/local-sqlite` 时发现，公开 subpath 背后的 `security/identityCredentialAdministration.ts` 有 1,501 行，
其中一个 900 行 repository class 同时拥有：

1. SQLite scalar/row codec、三组 SELECT projection 和 replay semantic comparison；
2. strong User authorization、allowed audit binding、实例 Authority Project 与事务内 RoleBinding fence；
3. Identity resolve/inspect/append、Owner continuity 和 mutation replay；
4. API Credential resolve/inspect/issue/rotate/revoke、Pepper binding 和 current credential fence；
5. Delivery Acknowledgement resolve/append 与 digest/audit replay；
6. database readiness、Operation Authority、Project Policy projection、credential fence activation 和 close lifecycle。

这些能力共同实现一个 Local SQLite adapter，不具备拆成新 workspace package、daemon 或 public subpath 的独立价值；但把
三套事务、row codec、authorization fence 和 database composition 放在同一 class，会让 Identity、Credential 和
Delivery 的变更共享完整持久化上下文，也难以单独审阅事务边界。

编辑前对文件全部 38 个 class、function 和 method 逐一执行 GitNexus upstream impact。`integer`、`text`、
`sameSubject`、authorization/audit normalization 和 transaction fence 为 MEDIUM；repository class、全部业务方法、
database factory 和其余 helper 为 LOW。只有 database interface 的 `activateUserCredentialFence` 影响 1 条执行流，
无 HIGH/CRITICAL。

## 决策

保持一个 `@qinglong/local-sqlite` package、一个 public subpath 和 5 行 facade，在原 Security 目录内建立 package-private
领域目录：

```text
identityCredentialAdministration.ts           # stable public facade
identity-credential-administration/
├── codec.ts                                  # row/select/semantic and command/audit codec
├── authorization.ts                          # transaction-time authority and continuity queries
├── commonOperations.ts                       # audit recorder and Authority Project resolver
├── identityOperations.ts                     # Identity inspect/append/replay transactions
├── credentialOperations.ts                   # Credential inspect/lifecycle/replay transactions
├── deliveryOperations.ts                     # Delivery acknowledgement/replay transaction
├── repository.ts                             # stable public class and narrow delegation
└── database.ts                               # readiness, fence activation and close composition
```

公开 repository class 保持原 constructor 与 11 个 method signature，只将每个调用委派到对应 operation owner。operation
函数显式接收 `LocalSqliteOperationAuthority` 和需要时的 `beforeMutation` fence，不拥有全局 client，不新增连接，也不能
绕过原串行队列。Identity、Credential、Delivery 仍各自在同一个 `BEGIN IMMEDIATE`/COMMIT/ROLLBACK 边界内完成最终
authorization recheck、业务写入、audit 与 replay。

facade 只导出原 repository class、database factory 和 database type。两个 runtime export 与 owning module 保持同一
object；没有公开内部 codec/operation、没有新增 package export、workspace package、production dependency、进程或
部署单元。

本轮不修改任何 SQL text、table/index、migration、row mapping、mutation ID、digest、Owner continuity、Pepper state、
credential version、delivery acknowledgement、allowed audit、instance Authority Project、RoleBinding fence、transaction
ordering、error identity/mapping、readiness、active credential fence 或 close lifecycle。

## 小设备与集群影响

所有本机 Profile 都携带裁剪后的 Local SQLite 文件，因此拆分为每档增加固定 7,890 bytes 和 8 个物理 JavaScript 文件；
loaded modules 完全不变：Edge/Standalone 49、Adopted 50、Application 116、AI 50、Application AI 115。最小 Edge
产物为 3,658,234 bytes，仍低于 4 MiB hard cap；没有新增连接、timer、watcher、listener、缓存或后台进程。

Cluster 不导入 Local SQLite adapter，继续使用独立 PostgreSQL Identity/Credential authority。本轮没有修改 schema、
migration、PostgreSQL、Cluster runtime、Kubernetes resource 或部署拓扑，因此虽已获准，仍不重复执行无关的 PostgreSQL
HA Docker 门。

## 被否决方案

1. **为 Identity/Credential/Delivery 各建 workspace package**：三者共享同一 SQLite transaction authority 和部署闭包，
   不形成独立 package 边界。
2. **继续保留 900 行 repository class**：三类 mutation 和 replay authority 无法独立审阅。
3. **让 operation 自行打开 SQLite client**：会破坏单连接队列、事务 fence 和统一 close ownership。
4. **公开 operation/codec subpath**：会扩大兼容面并允许调用方绕开 repository contract。
5. **按每个 method 拆文件**：会形成一方法一文件并分散同一事务的 replay/failure lifecycle。
6. **趁拆分改写 SQL 或提取通用 ORM abstraction**：会把 ownership 重构与持久化语义变化混在一起。

## 验收证据

- facade 1,501→5 行；codec 342、authorization 115、common 21、Identity 346、Credential 402、Delivery 240、
  repository 137、database 127 行，总计 1,735 行；新增行主要是显式 import 和 delegation contract。
- 2/2 runtime export identity 相同，无 missing、extra 或 drift；Local SQLite 203/203。
- 完整 16-package clean topology build/test 退出 0；Local Admin/Owner CLI 的真实 Identity/Credential/Delivery 生命周期、
  Owner fence、Pepper、replay、transaction rollback 与 audit 测试全部通过，外部 PostgreSQL/S3 与 Linux `/proc` 条件项
  保持显式 skip。
- package boundary 为 16 package、879 source、25 root、854 nested，`singleSourcePackages=[]`、
  `shallowSourcePackages=[]`、findings 为空；Local SQLite 为 168 source、1 root public export/167 nested。Edge import
  为 121 modules 且无 forbidden；Cluster dependency/deployment 全部 compatible/findings 为空。
- 串行十档 artifact 全部通过。Edge/Standalone 3,658,234/3,658,270 bytes、358 files、49 modules；Adopted
  4,278,743/4,278,803 bytes、410 files、50 modules；Application 4,776,592/4,776,712 bytes、469 files、116
  modules；AI 5,053,545/5,053,593 bytes、437 files、50 modules；Application AI 6,171,969/6,172,101 bytes、
  548 files、115 modules。相对 ADR-0328 每档固定 +7,890 bytes/+8 files、loaded modules +0。
- 最终强制索引为 44,189 nodes/100,630 edges/1,722 clusters/274 flows。post-impact 中 row integer 为 MEDIUM
  （9 direct/26 total/0 process），authorization、allowed audit 与 transaction fence 均为 MEDIUM
  （5/15/0）；三个 mutation owner、公开 repository 和 database factory 为 LOW，无 HIGH/CRITICAL。
- `detect_changes` all/compare `develop` 仍只映射已跟踪 Legacy baseline 的 12/31 与 14/34、low/0 process；当前 QL3
  孵化树尚未完整进入 Git baseline，因此它只作补充，不能替代逐 symbol impact、强制索引、完整测试与制品门。

## 后续约束

公开 repository 只负责 delegation，不重新吸收 SQL 或 authorization。codec 不取得 SQLite client；authorization 只做
事务内 fence/continuity 查询；operation owner 必须通过注入的唯一 Operation Authority 执行，并保持 audit 与业务事实
同事务。database composition 不暴露内部 operation。新增方法按 Identity、Credential、Delivery 领域归属聚合，不按方法
数量或 LOC 机械建文件。
