# ADR-0044：Runtime Core 抽离与 Legacy 兼容副本退出

- 状态：Proposed
- 日期：2026-07-19
- 关联：QL-RFC-0001 D-40/D-42、ADR-0037、ADR-0040、ADR-0041、ADR-0042

## 上下文

QingLong 2.x 的根应用同时承载 Controller、Sequelize、SQLite、本机执行、Web UI 和正在孵化的 3.0 Runtime。若 cluster package 直接读取 `back/**`，新的 package 名称不会改变依赖方向，2.x 根应用仍会成为事实上的 service locator。反之，立即把全部旧调用者切到新 package，会一次触碰高风险的 Cron、App 启动和 migration 链，难以维持现有兼容性。

抽离期间还会出现 JavaScript 类型身份问题：源码相同的 Error class 在 legacy 根和 runtime-core package 中是两个 constructor。若共享 contract 固定引用其中一方，另一方会因为 `instanceof` 身份而伪失败，即使 wire code 和语义完全一致。

## 决策

### 1. 按 Vertical Slice 抽离，不做目录大搬迁

抽离顺序固定为：

1. 纯 domain、port、稳定错误和 migration/activation contract；
2. 具体数据库 driver、SQL adapter 和 catalog readiness；
3. Profile composition root；
4. 完整 application stack 与发布产物；
5. legacy 调用者经兼容 adapter 切换，随后删除副本。

每个 slice 必须独立 build/test，且新 package 不得 deep import legacy 根。没有真实 consumer 的 placeholder export 不算完成抽离。

### 2. 兼容副本是临时迁移机制

legacy 根可以暂留 migration、activation 和 Repository 副本，以保护 2.x 调用链；但必须满足：

- 新实现的权威位置是公开 package；
- cluster integration 只测试 package 实现；
- 共享行为由 contract suite 或等价 parity test 覆盖；
- 禁止继续向根副本新增仅供 3.0 使用的能力；
- RFC 明确记录剩余调用者、切换门禁和删除条件。

### 3. Contract 不绑定实现侧 Constructor Identity

共享 Repository contract 允许 adapter 注入稳定错误 constructor 和资源上限常量。legacy adapter 使用根兼容 export，3.0 adapter 使用 runtime-core export；断言相同 error code、行为和边界，而不是要求两个 module instance 是同一个对象。

这不允许随意替换错误语义。公开错误 code、分页上限、payload 上限和 CAS 行为仍是 contract 的一部分。

### 4. 旧调用链切换必须满足退出门禁

只有以下条件全部满足，才允许把 legacy 根的高风险调用者切向 package：

- edge/standalone 与 cluster-control 各自有独立 Profile artifact/entrypoint；
- SQLite 与 PostgreSQL 通过同一完整 contract；
- migration history、checksum 和既有日志/错误兼容已证明；
- Node 24、多架构、升级和回滚测试通过；
- GitNexus impact 对每个被切换入口重新评估并审阅；
- 切换后依赖/导入审计证明没有反向边或双实现调用。

删除兼容副本应在独立变更中完成，不能与首次生产启用、schema 升级或 release history rewrite 混在同一提交。

## 当前孵化状态

`@qinglong/runtime-core` 已独立导出 migration stream/manifest、cluster activation、异步 admission disposer、Run/RetryPolicy domain、Repository port、稳定错误和 PostgreSQL resource shape，并新增细粒度 `migration-stream`/`run-repository` 子入口，避免本机 importer 求值整个 cluster barrel；`@qinglong/cluster-postgres` 已独立实现 migration、readiness、typed schema、Pool 与 RunRepository，并用受限 `runtime`/`migration` export 隔离常驻代码与 executable DDL；`@qinglong/cluster-control` 已在 readiness 后创建真实 Repository 并持有 Pool 生命周期，并通过独立 `application`/`http`/`config` export 提供不读取 legacy 或 DDL 的有界启动 host。

ADR-0063 进一步抽出 `@qinglong/local-sqlite`、`@qinglong/local-profile`、`@qinglong/edge` 与 `@qinglong/standalone`。SQLite 与 PostgreSQL 已运行同一 RunRepository contract，edge/standalone 的真实 production tarball closure 不再包含 legacy/cluster/ORM/native driver，常驻 SQLite runtime 也不会加载 executable migration SQL。以上 package 均可严格构建且不读取 legacy `back/**`。

legacy 根副本和调用链目前仍保留。原因是 root `RunRepository` 上游涉及大量 2.x service，history auditor 也参与 SQLite migration/App 启动；当前阶段不以新 package 已存在为由直接切换。下一门禁是 2.x database adoption/backup/rollback、完整本机 Profile application stack、真实 PostgreSQL 矩阵成功证据和双方言更多数据域 parity 后，再逐入口迁移。

## 影响

正面影响：

- 新架构不继承 2.x Controller/Sequelize/UI 耦合；
- 小设备与 cluster 可分别安装自己的 importer；
- 高风险旧调用链可以在证据完整后逐步切换；
- 双实现风险有明确退出条件，而不是永久兼容借口。

代价与风险：

- 过渡期有重复源码与两套 module identity；
- 修复跨越公共契约时可能需要同步兼容副本；
- contract suite 必须覆盖 wire code、边界值和错误语义，不能只验证 happy path。

## 未选择的方案

1. **cluster-control deep import 根 `back/**`**：固化反向依赖，拒绝。
2. **一次性迁移全部 root caller**：爆炸半径过大且难以回滚，拒绝。
3. **永久保留两套实现**：会持续漂移并增加安全修复成本，拒绝。
4. **共享 contract 固定 `instanceof` 根错误类**：让 package 实现产生伪失败，拒绝。
5. **用 symlink 或构建期路径别名隐藏 deep import**：只掩盖依赖图，拒绝。

## 验证

- runtime-core 在无 `pg`、Drizzle、SQLite、Sequelize 和 legacy 根依赖下独立构建；
- cluster-postgres/cluster-control 只使用公开 package export；
- exact dependency/source audit 无反向边或 package escape；
- legacy SQLite 与 package PostgreSQL 都通过完整 Repository contract；
- package-local fake driver 测试覆盖事务、row codec、错误映射和 payload 边界；
- Profile artifact 落地后逐入口记录 impact、parity、切换和兼容副本删除证据。
