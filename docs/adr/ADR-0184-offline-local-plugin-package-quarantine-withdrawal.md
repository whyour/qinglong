# ADR-0184：本机 Plugin Package 离线隔离与能力撤出

- 状态：Accepted
- 日期：2026-07-28
- 关联：RFC D-133、D-149、D-150、D-169、D-170、D-171、D-172、D-173、
  D-174；ADR-0149、ADR-0150、ADR-0179、ADR-0180、ADR-0181、ADR-0182、
  ADR-0183

## 背景

ADR-0183 在 compromise proposal durable 后阻断目标 signer 的新 catalog publication
和 queued stage，并在确认后删除 trust key、保存受影响 lock 集合。它刻意没有声称
已撤下 active Package：

- install head 的 `activeLockDigest` 仍可指向旧 lock；
- Package Task 已成为独立、不可变 TaskDefinition revision 和 current head；
- Tool 已进入 Project active-vector snapshot；
- 已批准的历史 Run/Tool invocation 可能绑定旧 revision/snapshot。

因此只给 install state 增加 `quarantined`，或只让 source query 忽略一个 lock，都无法
关闭完整执行面。热卸载还会与正在执行的脚本、进程和 Tool adapter 竞态。本机模型应
先停 application，再由短生命周期 Owner authority 原子撤出耐久能力。

## 提议决策

### 1. 使用永久 quarantine overlay，不改写安装历史

不扩展 `queued|staged|activating|active|failed` 的既有 install event history。新增本机
SQLite capability v35，以 append-only `QingLong3PluginPackageQuarantineEvents`、
immutable `QingLong3PluginPackageWithdrawalReceipts` 和逐 Task
`QingLong3PluginPackageWithdrawalTasks` 覆盖目标
`projectId/packageName/installationId/lockDigest`。quarantine target 通过
`project/package/installation/lock/install record digest` 复合外键冻结到原安装事实，
不另建可变 quarantine head。

`plugin-package.quarantine.apply` 只接受受管 trust root 中 ADR-0183 的 exact
revocation receipt，不接受调用方自报 lock 集合。命令必须绑定 receipt/proposal/
impact digest、当前 install head、Owner、mutation、SecurityAudit 和数据库时间。
quarantine 是永久 tombstone；恢复只能安装由非撤销 key 签名的新 lock，不能把旧
head 改回 active。

对 `queued|staged|activating` head，overlay 使 recovery source 不再选中目标 lock，
且既有精确安装事实不能被改写；不新增伪造的 install settled enum。对 `active` head，
overlay 进入同一事务的 capability withdrawal。

### 2. Active withdrawal 必须同时处理 Task、Tool 与准入

一个 `BEGIN IMMEDIATE` 事务固定执行：

1. 复验 target lock 仍是 install head 或 head 的 active lock；
2. 插入 exact quarantine event，目标与 mutation 都唯一，重复 mutation 只允许 exact
   replay；
3. 对仍由该 Package/generation 拥有的 current Task 追加 `enabled=false` revision，
   不删除旧 revision、Run 或审计；
4. 从 Project Tool active vector 排除该 lock，按 Profile 基于其余最多 edge 4 个、
   standalone 16 个 active source 生成 immutable snapshot；空 vector 是合法
   snapshot；
5. 写 withdrawal receipt，绑定 quarantine、Task revision 列表、新 Tool snapshot、
   原/新 active-vector digest 和计数；
6. 在事务取得写锁后、提交前执行授权 callback；callback 以同一连接复验 credential
   未失效、确认者仍是 current Owner，dual-control 时提案者也仍是 current Owner；
7. 提交前再次复验 install、Task、未受影响 source vector 和授权 fence。

任一步冲突或越界整体 rollback。Task/Tool 数据继续使用现有表和 pure planner；仅为
quarantine event/receipt/task 明细只增加三张事实表，不复制一套 Package 安装状态机。

### 3. 历史 revision 仍可读，但所有新 start 必须事务内失败关闭

仅更新 current Task head 或 current Tool snapshot 不足以阻止一个已经绑定历史事实的
新 start。下列本机 transaction 必须读取同一 quarantine head：

- Run `dispatching/running` CAS：若 Task reconciliation generation 能回溯到已
  quarantine 的 lock，在推进 Run 前拒绝；
- Tool execution start barrier：从绑定 snapshot 的 source 找到 Package lock，若已
  quarantine，在写 barrier/调用 adapter 前拒绝；
- Package stage/activation/recovery：queued/staged/activating 的精确目标被 recovery
  source 排除，外键与 tombstone 阻止安装事实变体重写。

已持久进入 running 的 Run 或已经创建 start barrier 的 Tool invocation 保留原
completion/recovery 语义，不能删除或改写历史来伪造“从未执行”。D-173 的
`stop_required` 仍是撤出前的操作前置条件；本 ADR 不承诺从 SQLite 证明宿主进程已
被操作系统停止，也不实现任意脚本的安全热杀。

### 4. Crash recovery 与启动门

quarantine、Task disable、Tool snapshot 和 withdrawal receipt 在同一 SQLite 事务，
所以进程崩溃只能看到全部旧事实或完整新事实。COMMIT response loss 由 mutation/
receipt digest exact replay 返回 `existing`。

application startup 在 Package recovery 前执行 capability v35 readiness relation
probe：

- quarantine event 必须精确对应一张 withdrawal receipt；
- Task 明细数量、内容 digest、Project/time 与 receipt 必须一致；
- active withdrawal 的新 snapshot retained source 数量必须一致，且不得再包含目标
  lock；
- probe 使用 `LIMIT 1` 找出首个损坏关系并失败关闭，不把全表物化进路由设备内存；
- readiness 通过后，Package recovery、Task/Tool source 和后续 Run/Tool start 仍各自
  执行 transaction fence。

不增加 timer、watcher、poller 或自动 GC。一次 Owner command 的 edge/standalone
目标 lock 上限为 4/16，每个 active withdrawal 的 source 上限也为 4/16，单 receipt
最多 128 个 Task；超限要求人工拆分或停机处置，不允许无界事务。

### 5. 包边界

继续复用：

- `@qinglong/runtime-core` 的显式 quarantine/withdrawal contract subpath；
- `@qinglong/local-sqlite` 的 migration、repository 和 start fence；
- `@qinglong/local-owner-cli` 的现有 Package command binary；
- `@qinglong/local-application` 的 startup recovery composition。

不新增 workspace package 或第三方生产依赖。owner-cli 对 runtime-core 的既有源码
导入从 devDependency 纠正为 production dependency，并由 lockfile/源码边界门精确
允许。Cluster 对等能力必须在 PostgreSQL
advisory lock、multi-replica admission、admin/runtime ACL 和 HA promotion 门全部实现
后单独接受，不能把本机 SQLite command 暴露为 Cluster transport。

## 已知限制与后续风险

1. 当前 Run 不直接保存 Package lock provenance，start fence 通过 immutable Task
   reconciliation item/generation 回溯；未来应把 lock provenance 提升为 Run 建单事实；
2. quarantine 与随后 replacement install 的 previous-active/rollback 语义需要独立
   恢复 ADR；
3. 本轮 `SIGKILL` 覆盖 SQLite transaction window，但真实设备断电、ENOSPC、文件系统
   损坏和完整 application 停机仍需要实机演练；
4. 本 ADR 只接受本机 SQLite 能力；PostgreSQL HA 门通过不代表 Cluster 已具备
   quarantine adapter、ACL 或多副本管理 transport。

## 接受门禁

- pure contract：exact replay/conflict、永久 tombstone、bounded withdrawal receipt；
- SQLite migration/readiness/schema audit 与 capability v35；
- queued/staged/activating 三状态不再被 recovery source 选中；
- active Package 的 Task 全部 disabled、Tool source 全部排除，事务失败零部分事实；
- 历史 Task revision/Tool snapshot 可读，但新 Run/Tool start 在写前被 fence；
- application readiness 在 withdrawal relation incomplete/tampered 时失败关闭；
- 非 Owner、identity drift、impact/receipt 漂移和超限全部在可见变更前拒绝；
- Edge/Standalone `DELETE/FULL`、`WAL/FULL` 的 pre-COMMIT/post-COMMIT `SIGKILL`
  matrix 和 `integrity_check=ok`；
- 22-package dependency/edge import、application artifact/RSS 预算不回归；
- 实现触及 Cluster 时重跑 PostgreSQL 18 physical HA Docker 门，否则不声明 Cluster
  能力。

## 验收结果

- `@qinglong/runtime-core/plugin-package-quarantine` 已提供 event/receipt schema、
  exact replay/conflict、永久 tombstone、128 Task receipt 上限和确定性 mutation ID；
  runtime-core 349/349 通过；
- reviewed migration `0069-plugin-package-quarantine` 和
  `0070-capability-v35` 已落地，contract v35、62 张 owned table、migration checksum、
  typed schema 和 readiness relation probe 一致；
- `@qinglong/local-sqlite/plugin-package-quarantine` 在一个 `BEGIN IMMEDIATE` 中完成
  exact install validation、Task consecutive disable、Tool snapshot、event/receipt/
  task facts以及提交前授权 callback；exact replay 在返回前再次复验 durable facts；
- Package recovery source、Task/Tool current source、Run CAS 与 Tool start barrier
  均已读取 quarantine overlay；历史 revision/snapshot 仍可读；
- `ql3-package-trust revoke-confirm` 从 ADR-0183 receipt 的 impacted lock 导出目标，
  在 trust snapshot 前逐项 quarantine；新建、已有 receipt 和已完成 snapshot 的精确
  重放都会先执行该 hook，关闭“receipt 已存在却跳过撤出”的恢复窗口；
- credential/Owner 的完整认证在事务外完成，事务内再以同连接执行当前 credential、
  confirmer Owner 和 proposer Owner fence，避免共享 authority transaction 的重入
  死锁；
- crash matrix 覆盖 edge `DELETE/FULL`、standalone `WAL/FULL`，在 Task disable 后、
  event 后、receipt 后、COMMIT 前和 COMMIT 后各 `SIGKILL`，共 10/10；8 个 pre-COMMIT
  场景完整 rollback 后恢复为 `created`，2 个 post-COMMIT 场景完整保留并重放为
  `existing`，`integrity_check=ok`、foreign key check 通过；
- 全量测试通过：runtime-core 349、local-sqlite 136、local-admin 63、
  local-application 32、local-owner-cli 22；
- dependency/source boundary 无 finding，Edge import closure 为 121 modules；四种
  application 产物门通过：edge 4,915,362 bytes/615 files/90 modules，standalone
  4,915,506/615/90，edge+AI 5,593,183/659/89，standalone+AI
  5,593,339/659/89；
- 本轮未实现 Cluster quarantine，但按授权额外重跑 PostgreSQL 18.4 physical HA
  Docker contract：physical streaming、`remote_apply`、partition promotion guard、
  old-primary fence/`pg_rewind` rejoin、scheduler/credential/Run/tool-result
  COMMIT-response-loss convergence 和 optional AI schema promotion gate 全部通过。
