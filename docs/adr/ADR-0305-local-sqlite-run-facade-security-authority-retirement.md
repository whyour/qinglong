# ADR-0305：Local SQLite Run Facade 安全 Authority 兼容面退役

- 状态：Accepted
- 日期：2026-08-09
- 关联：D-85、D-87、D-213、D-257、ADR-0069、ADR-0276、ADR-0280、ADR-0290、ADR-0291、ADR-0292、ADR-0293、ADR-0294

## 上下文

ADR-0293 已把 Project Policy、Security Audit、Local Secret 与 authorized Secret mutation 的实现和生产装配从
`LocalSqliteRunRepository` 移入 package-private `LocalSqliteSecurityAuthorityStore`，但为分批迁移保留了八个 Run
Facade 兼容方法、lazy Store 和 credential pre-commit hook。ADR-0293 明确要求：只有在公开 consumer inventory 和迁移
证据齐备后，才能另立 ADR 删除这些兼容面。

当前全 workspace 源码清单证明，生产代码中只有 `openLocalSqliteRuntimeDatabase` 创建
`LocalSqliteRunRepository`，并仅把它用于 Run、Dispatch、Execution Control、Startup Recovery 与 Completion Receipt；
Policy、Audit、Secret、Identity、Task、Trigger、Workflow、Adoption 与管理 composition 均直接取得同一
`LocalSqliteSecurityAuthorityStore`。八个兼容方法中六个没有上游消费者；两个 authorized Secret 方法只有接口语义关联，
真实 `LocalSecretAdministration.put` 已直接调用 Security Store。继续保留这些方法会让公开类型和 Edge runtime artifact
仍宣称 Run 拥有 Security authority，也会允许新代码重新形成 god-repository 依赖。

编辑前 GitNexus 显示 `LocalSqliteRunRepository` 为 LOW（3 direct/4 total/0 process）；构造器和六个兼容方法为
LOW/0，两个 authorized Secret 方法各为 LOW 1 direct/1 total，并只关联既有 `put`；私有 `securityStore()` 为 MEDIUM
8 direct/9 total/1 process。没有 HIGH/CRITICAL 编辑目标。本批删除完整兼容链，不修改 Security Store 或其产品调用者。

## 决策

1. `LocalSqliteRunRepository` 不再实现 `LocalSecretEnvelopeRepository` 或 `LocalSecretAdministrationRepository`，并删除
   Policy、Audit、Secret 八个兼容方法。
2. 删除 Run Facade 的 lazy `LocalSqliteSecurityAuthorityStore`、credential hook 字段与构造参数；构造器只接受
   `DatabaseSync | LocalSqliteOperationAuthority`。Security Store 继续独立接收 hook 并拥有原子授权事务。
3. 保持 `@qinglong/local-sqlite` 与 `/runtime` specifier、`LocalSqliteRunRepository` class、Run/Dispatch/Recovery/
   Receipt 方法、`LocalSqliteOperationAuthority`、connection、queue、close fence 和 transaction 行为不变。此次有意缩小
   的是尚未发布稳定版的 QL3 alpha class capability，不保留 deprecated wrapper。
4. 新增双层负向门：运行时 prototype 不得出现八个安全方法；编译后的 `.d.ts` 与 `.js` 不得包含 Policy/Audit/Secret
   方法、类型或 `securityAuthorityStore` import。职责回流必须在测试阶段失败。
5. 不修改 Security Store、SQL、migration、表、索引、Project/RoleBinding fence、envelope+audit 原子事务、exact replay、
   Buffer wipe、错误类型、hook 顺序或任何产品路由。
6. 不新增 workspace package、生产依赖、connection、queue、timer、watcher、listener、进程、binary 或部署单元。

## 被拒绝的方案

- **永久保留 deprecated 委托**：没有生产消费者，且 QL3 尚处 alpha 孵化期；保留会让错误 authority 继续出现在公开类型和
  路由设备制品中，未来更难删除。
- **只删 TypeScript `implements`**：运行时方法和 lazy Store 仍存在，调用方仍可继续把 Run 当 Security repository。
- **在 Run Facade 中返回一个 Security 子对象**：仍由 Run 命名和构造 Security authority，只是把八个方法换成一个入口。
- **拆成第二 SQLite connection 或 workspace package**：会破坏单 authority transaction/close fence，并增加低配设备资源、
  importer、lockfile 与 SBOM 成本。
- **同时重写 Security transaction**：本批目标是移除错误兼容能力；混入 SQL/事务行为变化会让回归无法归因。

## 接受条件

1. production source 与 clean `dist` 中的 Run Facade 均无 Policy/Audit/Secret method、type、field、hook 或 Store import。
2. `LocalSecretAdministration.put` 的既有 Security Store 调用、原子 fence/audit/envelope 测试与五条产品流程保留。
3. Local SQLite check/full test、完整 19-package clean build/test 和 backend 回归通过。
4. dependency/package boundary、Edge import、Local/Cluster image/deployment 审计与十档 artifact/RSS 门通过；Edge 制品不得增长。
5. 强制 GitNexus 不增加产品流程；Run Facade 调用半径不扩大，`detect_changes` 保持 low/0 affected process。

## 接受证据

- `runRepository.ts` 从 685 行降到 567 行，Local SQLite 总 source lines 48,358→48,240；package 仍为 156 source、
  1 root/31 root lines/155 nested，workspace 保持 19 package/768 source、32 root/736 nested。
- 新 `runRepositoryAuthorityBoundary.test.cjs` 同时检查 prototype、`.d.ts` 和 `.js`，证明八个方法与
  `securityAuthorityStore`/Policy/Audit/Secret import 均不存在。Local SQLite check 通过，full test 197/197；完整
  19-package 从空 `dist` 重建并测试退出 0。
- backend 1,113 项为 1,111 pass/2 条件 skip/0 fail；dependency、package boundary、Edge import、Local image、
  Cluster deployment 与 image release 均 compatible/零 finding。
- 十档 artifact/RSS 全部 compatible，且每档相对 ADR-0304 精确减少 2,143 bytes，package/file/module closure 不变。
  Edge 为 3,633,133 bytes/332 files/48 modules；最大 Standalone Application AI 为
  6,121,726 bytes/491 files/104 modules，均低于硬上限。
- 最终 GitNexus 为 43,361 nodes/98,534 edges/1,697 clusters/269 flows。Run Facade 保持 LOW
  3 direct/4 total/0 process；Security Store 为 HIGH 28/37/0，真实 `LocalSecretAdministration.put` 仍有五条
  `put → enqueue/audit/query` 流程并直接调用 Store 的 authorized Secret 方法。删除的是兼容中继节点，不是产品流程。
- `detect_changes` all/compare `develop` 为 12 files/31 symbols 与 14/34，均 low/0 affected process。本批不触及
  PostgreSQL、Cluster、migration 或 HA 状态，复用紧邻且已通过的 PostgreSQL 18.4 arm64 HA 证据，不重复制造无关门禁。

## 后续边界

- `LocalSqliteRunRepository` 仍同时承担 Run aggregate、Dispatch definition、Execution Control、Startup Recovery 与
  Completion Receipt。后续是否继续提取 collaborator，必须以共享事务不变量和真实消费者为依据，不能仅按类行数拆分。
- Run 与 Security 已共享 domain-neutral SQLite primitives；任何进一步泛化都必须保持双方既有 corruption/error contract。

## 后续状态（2026-08-09）

ADR-0306 已完成本节的消费者与 authority 复核：Run aggregate、Dispatch、Execution Control、Startup Recovery 和
Completion Receipt 继续共享一个 SQLite operation authority，但生产装配不再共享同一个宽对象。四个非 Run contract 已被
投影为冻结且方法集合互斥的 package-private capability view，`LocalSqliteRunRepository` 只保留 Run contract；该后续结论不
改变本 ADR 的历史验收证据。
