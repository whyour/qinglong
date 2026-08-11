# ADR-0222：按 generation 绑定的 Plugin Package 自动化发布账本

- 状态：Proposed
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-144、D-145、D-147、D-175、D-207、D-211
- 关联 ADR：ADR-0150、ADR-0151、ADR-0153、ADR-0221

## 背景

ADR-0150 已把 Package 中的 Workflow 与 Prompt 解析成同一份 immutable
materialized revision，但“已经物化”不等于“已经发布给运行时”。如果运行时直接读取
materialized revision，会出现以下问题：

- active generation 切换时，Workflow 与 Prompt 可能分别可见；
- disable/enable 只撤出 Task 与 Tool，自动化定义仍可被新执行消费；
- 集群多副本无法证明读取的是同一 generation、同一 publication head；
- 路由设备若用 watcher、目录扫描或常驻缓存弥补，会增加空闲内存、I/O 和恢复状态。

Secret binding 具有独立授权、密文材料和审计边界，不能与只包含低敏定义的
Workflow/Prompt publication 合并。

## 决策

### 1. Workflow 与 Prompt 使用同一 publication

`qinglong/plugin-package-automation-publication@v1` 一次发布同一 Package generation
中的完整 Workflow 与 Prompt 定义：

- target 精确绑定 Project、Package、installation、lock、generation、
  generation digest 与 materialized revision digest；
- definitions 分别按 ID 排序并拒绝重复；
- Workflow 与 Prompt 各最多 128 项；
- canonical publication JSON 最大 12 MiB；
- publication 使用 domain-separated SHA-256 digest。

同一 generation 不拆成 Workflow head 与 Prompt head。消费者只能看到完整 generation
或旧完整 generation，不能看到半批定义。

### 2. append-only digest chain

每个 `(Project, Package)` 只有一个 CAS head，历史 publication 永不 update/delete。

- 每个 active Package generation 都必须拥有一条 publication；包含 Workflow/Prompt
  时状态为 `active`，不包含时状态为 `absent` 且 definitions 为空；
- `absent` 是 generation tombstone，禁止旧 generation 的自动化 head 跨过一个空
  generation 继续可见；
- 首条 publication 固定为 `active|absent`、version 1、无 predecessor；
- Package generation 升级从任意 current head 追加更高 generation 的
  `active|absent` publication；允许恢复直接跨过已不再 active 的中间 generation，
  但 generation 必须严格前进；
- lifecycle disable 追加 `active → withdrawn`；
- lifecycle enable 追加 `withdrawn → active`；
- `absent` 不参与 lifecycle toggle；
- lifecycle successor 必须保留同一 target 与同一 definitions，并绑定 lifecycle
  event digest；
- version、predecessor digest 与 `publishedAtMs` 单调递增。

uninstall 只能从 disabled 进入，因此 automation head 已是 withdrawn。v1 不再追加
“retired” publication，保留 withdrawn immutable history；物理回收由独立 retention
协议处理。

### 3. 双方言 durable repository

SQLite 使用：

- `QingLong3PluginPackageAutomationPublications`；
- `QingLong3PluginPackageAutomationPublicationHeads`；
- migration `0079-plugin-package-automation-publications`；
- capability `local-core@40`。

PostgreSQL 使用：

- `ql3.plugin_package_automation_publications`；
- `ql3.plugin_package_automation_publication_heads`；
- migration `pg-0043-plugin-package-automation-publications`；
- publication capability `control-core@42`；
- runtime-only start guard migration
  `pg-0044-plugin-package-automation-start-guard`；
- current capability `control-core@43`。

publication 表 append-only，head 只允许 CAS 推进。双方言 repository 都支持
`findCurrent`、`findByDigest`、`publish` 与有界 keyset `listPendingPage`。pending
source 只返回“active install 已有 materialized revision，但 automation head 缺失或
generation 不匹配”的 Package。materialized revision fence 不匹配、fork、
JSON/index projection 漂移或缺失 predecessor 均失败关闭。

PostgreSQL runtime、manager 与 package executor 可 SELECT；只有 package executor
可 INSERT publication，并对 head INSERT/UPDATE。没有业务角色取得 DELETE。

### 4. 生命周期同事务联动

ADR-0221 lifecycle repository 不调用另一个自带事务的 repository。automation
repository 提供显式 transaction-bound writer，由 lifecycle 已持有的 SQLite
`BEGIN IMMEDIATE` 或 PostgreSQL `SERIALIZABLE` transaction 调用。

对 current automation head 为 `active|withdrawn` 的 Package：

- disable 要求 current automation head 精确匹配 active Package generation 且为
  active，然后在 lifecycle event/receipt、Task revision 与 Tool snapshot 的同一事务
  追加 withdrawn publication；
- enable 要求同一 generation 的 current head 为 withdrawn，在同一事务追加 active
  publication；
- uninstall 要求 current head 已 withdrawn，不创建新的定义版本；
- 第二次 authorization fence 失败、外键失败、head CAS 失败或任一 capability 写失败
  时，整笔事务回滚。

`absent` tombstone 没有可撤出的定义，因此 lifecycle transaction 不为其追加空 toggle；
消费者仍以 Package lifecycle/quarantine authority 作为外层准入围栏。

publication 的 lifecycle event 外键要求 lifecycle event 先在事务中插入，再写
publication，最后才允许 COMMIT。这个顺序不改变原子可见性。

### 5. Profile 与资源边界

- 不新增 workspace package；
- 不新增 daemon、timer、watcher、listener、socket 或常驻缓存；
- Edge/Standalone 复用单 SQLite operation authority；
- Cluster 复用 caller-driven package executor 与单连接 transaction；
- 禁用 AI 的 Profile 不因该账本引入 AI provider、SDK 或 credential；
- Secret material、SecretRef、Prompt 渲染输入与模型输出均不得进入 publication。

### 6. caller-driven publication 与恢复顺序

initial/next publication 已由 profile-neutral coordinator 发布，并在双方言启动链路中
固定为：

`install recovery → Task materialize/reconcile → Workflow/Prompt publication → Tool snapshot → admission`

- coordinator 在发布前后各观察一次 active generation；换代返回 `superseded`，不把
  旧 generation 冒充 current；
- 同 generation exact replay 返回 existing，并保留 lifecycle 已写入的
  `withdrawn` 状态；
- conflict/invalid 进入 `manual_required`，availability 失败进入 `retry`；
- 每页和每轮硬上限均为 64；Local Edge/Standalone 无显式配置时使用 8×8；
- 不创建 resident reconciler，Local 复用一个 SQLite operation authority，Cluster
  复用 caller-driven package-executor Job。

### 7. 安全事实优先的启动门

publication head 只表达 generation 与正常 lifecycle，不把 quarantine 或 publisher
revocation 重写成虚假的 `withdrawn`。启动必须通过独立、精确的
`PluginPackageAutomationPublicationStartGuard`：

- 输入固定为 Project、Package 与 current publication digest；旧 digest、非 active
  publication、非 current active install、non-active lifecycle 一律返回 false；
- SQLite 在同一 operation authority 内同时检查 current publication/install、
  lifecycle 与精确 installation/lock quarantine event；
- PostgreSQL 只向 `ql3_runtime` 暴露
  `SECURITY DEFINER plugin_package_automation_start_allowed`，runtime 不取得
  quarantine、provenance 或 revocation 表的直接读取权；
- PostgreSQL guard 与 publisher revocation 使用同一 transaction-level signer
  advisory lock。若启动观察先完成，它发生在撤销提交之前；若撤销先取得锁，启动等待
  后必定观察到 receipt 并返回 false；
- pending-source 与 publication writer 同样排除 security-fenced generation，避免
  recovery 在隔离或撤销后重新发布能力；
- 不新增 safety-state 镜像表、daemon、timer、watcher 或常驻 denylist。quarantine
  event 与 publisher revocation receipt 始终是事实源。

调用方必须在“记录一次自动化启动”的同一数据库事务内消费 PostgreSQL guard；把一次
boolean 查询缓存后再异步启动仍属于 TOCTOU，不能视为生产执行门已经关闭。

### 8. 尚未关闭的产品门

本 ADR 已关闭 durable publication、lifecycle overlay、双方言 quarantine 启动收敛，
以及双方言 publisher revocation 的即时启动收敛：Local 由文件型不可变撤销
receipt 桥接到 SQLite 精确 installation/lock quarantine，Cluster 由 PostgreSQL
receipt 直接参与启动判定。但不把定义解释为可执行能力。D-211 继续 Proposed，
直到至少完成：

1. Workflow Run/StepRun executor 与 admission fence；
2. Prompt 产品入口、参数绑定、Policy/Audit 与内容治理；
3. Secret binding consumer。

在这些门关闭前，消费者必须同时检查 Package lifecycle/quarantine authority，不能只因
automation head 为 active 就执行。

## 不采用方案

### 直接读取 materialized revision

拒绝。materialization 是 immutable source fact，不是运行时 publication head。

### Workflow 与 Prompt 分别发布

拒绝。会引入同 generation 部分可见和双 head 恢复协议。

### 把 Secret binding 放入 publication

拒绝。低敏定义发布不能取得 Secret 授权和密文材料 authority。

### 生命周期提交后异步撤出 automation

拒绝。崩溃窗口会留下 Task/Tool 已撤出但 Workflow/Prompt 仍 active。

### 新建 automation workspace package 或 watcher

拒绝。现有 runtime-core 与双方言 storage subpath 足够，额外部署边界没有独立价值，
并会增加路由设备供应链和空闲资源。文件数量不是 package 边界；本能力没有独立部署、
权限域、重依赖或发布责任，因此即使代码增长也继续使用现有 package 的显式 subpath。

## 当前验证

1. runtime-core publication/coordinator 定向 9/9，通过 canonical digest、跨
   generation successor、`absent` tombstone、lifecycle withdraw/restore、并发换代
   与有界 recovery 分类；
2. SQLite repository 定向 8/8，覆盖 exact current start guard、quarantine 后
   pending-source 收敛、publication 拒绝、跨 generation `absent` tombstone 与损坏
   失败关闭；
3. SQLite lifecycle 定向测试证明第二次 authorization 检查失败时，Task、Tool
   snapshot、lifecycle facts 与 automation head 全部回滚；
4. Local application startup 固定执行 Task→automation→Tool，定向启动回归 14/14；
   SQLite runtime 只在调用时惰性加载 publication repository；
5. PostgreSQL 18.4 arm64 HA fixture 中，同一 Package publication 从 v1 经四次
   disable/enable 原子推进到 v5，包含 1 Workflow 与 1 Prompt；5 条 publication 和
   active head 经 `remote_apply`、timeline 1→2 promotion、旧主 fencing、
   `pg_rewind` 及 fresh control replicas 后保持一致；
6. PostgreSQL `pg-0044` 把 control-core 推进至 v43；start function 只授予 runtime，
   package executor/admin/manager/worker ingress 均无执行权；迁移、checksum、
   schema/readiness 与 repository 定向 43/43；
7. HA gates
   `pluginPackageAutomationPublicationTransitionsAtomically=true`、
   `pluginPackageAutomationPublicationSurvivesPromotion=true`、
   `pluginPackageAutomationRecoverySourceConverges=true`、
   `pluginPackagePublisherRevocationImmediatelyFencesAutomation=true`、
   `pluginPackageAutomationSecurityFenceSurvivesPromotion=true`、
   `pluginPackageAutomationStartGuardIsRuntimeOnly=true` 且总
   `gates.passed=true`；撤销前 current publication 允许，revocation receipt 提交后、
   quarantine 后和 promotion 后均拒绝；
8. 调度器 COMMIT-response-loss 同轮修复为“发送 COMMIT 后绝不透明重试”，回归 7/7，
   HA 证明只产生 1 Run、1 Attempt、2 Event、0 duplicate occurrence。
9. Cluster caller-driven recovery 已把 automation publication 放在 Task publication
   与 Tool snapshot 之间；Cluster PostgreSQL 全量 211 pass/1 条无 DSN 条件 skip，
   最新 HA 总
   `gates.passed=true`，且未访问 registry、未拉取镜像。
10. Local 签名 catalog 已覆盖 active install → materialized Task/Workflow/Prompt →
    active automation 的完整链路；撤销 publisher key 后，不可变 receipt callback
    以精确 installation/lock provenance 写入 SQLite `withdrawn` quarantine，raw
    automation publication 仍保持原 generation/lifecycle 事实，但 exact start guard
    立即返回 false。测试在 quarantine 与 snapshot 已 durable、文件型 trust current
    generation 尚未 promotion 的边界注入崩溃，观察到 current generation 3、
    pending generation 4、`recoveryRequired=true` 且启动已拒绝；重放同一命令收敛为
    generation 4，随后为 `existing`，SQLite 始终只有 1 条精确 quarantine event。
