# ADR-0293：Local SQLite Security Authority Store 与 Run Facade 解耦

- 状态：Accepted
- 日期：2026-08-09
- 关联：D-85、D-87、D-213、D-257、ADR-0069、ADR-0276、ADR-0280、ADR-0290、ADR-0291、ADR-0292

## 上下文

ADR-0290 至 ADR-0292 已把 Completion Receipt、Run Reader 和 Run persistence support 从
`LocalSqliteRunRepository` 的单文件实现中分离，但生产装配仍把同一个 Run Facade 同时当作
`ProjectPolicyRepository`、`SecurityAuditSink`、`LocalSecretEnvelopeRepository` 与
`LocalSecretAdministrationRepository`。因此 Security Audit Query/Retention、Identity、Project Policy、Task/Trigger
Administration 和 Secret Administration 会仅为 Policy/Audit/Secret 能力实例化一个 Run Repository；Run 文件仍持有
Project/RoleBinding/Audit/Secret SQL 及 authorized Secret 的原子授权围栏。

这不是 package 数量问题，而是 authority ownership 错位。Project Policy、Security Audit 与 authorized Secret mutation
共享同一个 `BEGIN IMMEDIATE`、Project/RoleBinding fence 和 Security Audit 原子写入，不能按接口机械拆成互不协调的
repository；但它们也不应继续由 Run aggregate 命名和承载。

强制完整 GitNexus 基线为 43,173 nodes/98,227 edges/1,693 clusters/265 flows。`LocalSqliteRunRepository` 为
CRITICAL（30 direct/64 total）；`localRoleBindingFromRow`、`localSecurityAuditFromRow`、
`sameSecurityAuditSemantic` 与 `insertLocalSecurityAudit` 均为 CRITICAL，最大 24 direct/72 total，覆盖两条执行流和
7 个 module。八个待迁移的产品方法本身最高 MEDIUM，生产 composition/open 函数及四个 audit `record` adapter 均 LOW。

## 决策

1. 在既有 `@qinglong/local-sqlite/src/security/` 下建立 package-private
   `LocalSqliteSecurityAuthorityStore`。它共同实现 Project Policy、Security Audit、Local Secret 与 authorized Local
   Secret Administration contract，因为 authorized Secret mutation 必须在一个事务中重验 Project/RoleBinding fence、
   写 envelope 并写 allowed audit。
2. 把 Project/RoleBinding/Audit/Secret 的 SELECT projection、row mapping、semantic replay 比较与 audit insert 移到
   `security/securityPersistence.ts`；不得从 package root、公开 subpath、`index.ts` 或 `runtime.ts` 导出。
3. Store 只接收既有 `LocalSqliteOperationAuthority` 和可选的 credential pre-commit hook，复用同一
   `DatabaseSync`、同一 enqueue queue 和同一 `BEGIN IMMEDIATE`；不得创建或关闭 connection，也不得创建第二 queue、
   transaction owner、timer、watcher、listener、cache 或后台工作。
4. 所有生产 composition、Project Policy adapter 和 Security Audit adapter 改为直接使用 Security Authority Store；
   `runRepository` 不再是生产 Security/Secret 能力的装配来源。
5. 为避免在 QL3 孵化期静默破坏既有公开 `LocalSqliteRunRepository` class，本批保留其 Policy/Audit/Secret 方法，但只作
   无 SQL 的兼容委托；后续移除前必须先证明 package export consumer 已迁移，并另立删除 ADR。兼容委托不得形成双重
   enqueue。
6. 被迁移的方法体、SQL、列序、NULL/empty/JSON/Buffer 清零、exact replay、错误类型与错误文本逐字保持；
   authorized Secret 的 credential hook 仍在 `BEGIN IMMEDIATE` 之后、Project/RoleBinding 查询之前执行。
7. 本批不泛化 Run 与 Security 共享的 scalar/query helper。其当前错误语义包含 RunRepository error contract，改造成
   package-wide codec 必须先冻结 corruption contract，不能借 ownership 重构改变错误边界。
8. 不新增 workspace package、生产 dependency、migration、表、索引、公开 specifier、进程或部署单元；19-package
   ledger 与 Edge/Standalone 制品和 RSS 上限保持不变。

## 被拒绝的方案

- **为 Policy、Audit、Secret 各建独立事务 repository**：authorized Secret 必须把授权 fence、envelope 和 audit 原子提交，
  拆开会产生 TOCTOU 或半提交。
- **继续把 Run Repository 当万能本机数据库**：虽然共用 connection，但命名、调用图和 production composition 都把
  Security authority 错归到 Run，后续无法独立演进或审计最小权限。
- **直接删除 Run Facade 上的兼容方法**：QL3 package 已公开导出该 class，先迁移生产消费者和保留一批可验证委托，比
  无迁移证据的同步删除更可审计。
- **新建 workspace security-storage package**：没有独立部署、依赖、权限进程或版本责任，只会扩大低配设备 importer、
  lockfile 和 SBOM。
- **同时重写 scalar/query helper error contract**：会把 ownership 修复与 corruption/error 语义变化混批，无法归因。

## 接受条件

1. Project/RoleBinding/Audit/Secret SQL 和 row mapper 不再存在于 `runRepository.ts`；Security 专用实现只位于
   `src/security/`，无复制。
2. 所有生产 composition 和 audit/policy adapter 不再仅为 Security/Secret 实例化 Run Repository；Run Facade 兼容方法
   只委托 Store，且同一次操作只进入一次 authority queue。
3. authorized Secret 的 hook 顺序、Project/RoleBinding fence、envelope+audit 单事务、rollback、exact replay 与 Buffer
   wipe 由定向测试证明不变。
4. Project Policy、Security Audit Query/Retention、Identity、Task/Trigger、Package/Workflow、Secret 与 Run 定向测试，
   Local SQLite 全量、完整 19-package clean build/test 和 backend 回归全部通过。
5. 六项架构/部署审计与十档 artifact/RSS 门通过；package 仍为 19 个、`singleSourcePackages=[]`，公开 exports、生产依赖、
   migration chain 与部署 closure 不变。
6. 强制完整 GitNexus 后重查 CRITICAL helper、Run Facade、新 Store、兼容委托与 production composition，并运行
   `detect_changes` all/compare `develop`；若出现新生产执行流、双 authority 或风险等级扩大，ADR 不得 Accepted。

## 接受证据

- `runRepository.ts` 从 1,457 行降至 685 行；新增 `securityAuthorityStore.ts` 714 行和
  `securityPersistence.ts` 255 行。Project/RoleBinding/Audit/Secret SQL、row mapper、Buffer wipe 与事务实现已从 Run
  文件清零，Facade 的八个兼容方法只通过 lazy `securityStore()` 单层委托，没有双重 enqueue。
- production source 中只有基础 runtime 为真实 Run/Dispatch/Execution/Recovery 创建一个
  `LocalSqliteRunRepository`；Secret、Policy、Audit、Identity、Task、Trigger、Workflow、Adoption 与 optional feature
  composition 均直接使用同一 `LocalSqliteSecurityAuthorityStore`。Store 接收既有
  `LocalSqliteOperationAuthority`，不创建/关闭 connection、第二 queue 或任何后台资源。
- Security/Policy/Secret/Run/Workflow/Task/Trigger 定向回归 55/55、Local SQLite 192/192、完整 19-package clean
  build/test 与 backend 1,110（1,108 pass/2 skip）通过；authorized Secret 的 credential fence、envelope+audit 原子提交、
  rollback、exact replay 与 audit failure 回滚测试均通过。
- cluster dependency、package boundary、Edge import、cluster deployment、CloudNativePG 与 local image 六项审计均
  `compatible:true`。workspace 仍为 19 个 package、767 个 source、49 个受审根入口和 718 个领域内嵌套实现，
  `singleSourcePackages=[]`；Local SQLite 为 155/3/152。公开 exports、生产依赖、migration、表、索引、进程和部署单元
  均未改变。
- 十档制品/RSS 门全部 compatible。最小 Edge 为 3,629,838 bytes/331 files/47 loaded modules，RSS delta
  12,058,624 bytes；最大 Standalone Application AI 为 6,117,459 bytes/490 files/103 loaded modules，RSS delta
  21,200,896 bytes，均低于硬上限。
- 强制完整索引为 43,207 nodes/98,365 edges/1,695 clusters/270 flows。Run Facade 从 CRITICAL（30 direct/64 total）
  降为 LOW（3/28/0 process）；风险集中到正确 ownership 的 Security Authority Store，后者为 CRITICAL（30/75，只有
  既有 Secret `put` 产品根）。四个 Security persistence helper 保持 CRITICAL，最大 24 direct/74 total；直接调用数
  没有扩大。索引新增的五条 flow path 全部是同一既有 `put` 根到此前被 Facade/函数对象遮蔽的 sqlite error、enqueue、
  audit insert 与 row query 边，不是新产品入口、运行资源或状态机。
- 本批次只改变 Local SQLite 内部 ownership，不触及 PostgreSQL、Cluster、migration 或 HA 状态，因此不重复执行与变更
  无关的物理 PostgreSQL HA；结构、依赖和部署审计已证明 Cluster closure 未改变。
- `detect_changes` all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均为 low/0 affected process；QL3
  孵化树大部分仍 untracked，因此该结果只作为逐符号 impact、完整测试、审计和制品证据的补充。

## 后续边界

- Run Facade 的兼容 Policy/Audit/Secret 方法只有在公开 consumer inventory 和迁移证据齐备后才能删除。
- Run 与 Security 当前共享的 row/query primitives 仍需独立 corruption-contract ADR，不能用函数名相同推断语义相同。

## 后续状态（2026-08-09）

ADR-0305 已完成第一项后续边界：全 workspace production consumer inventory 证明八个兼容方法无人使用，clean
19-package build 证明没有隐藏的类型消费者，因此 Run Facade 已删除 Policy/Audit/Secret interface、委托、lazy Store 与
credential hook。prototype、declaration 与编译 JS 三层负向门防止职责回流；Security Store、共享 operation authority 和
原子事务保持。第二项 corruption/error contract 已由 ADR-0294 的 domain-neutral SQLite primitives 冻结，后续不得借
进一步 collaborator 提取改变双方错误边界。
