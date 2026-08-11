# ADR-0152：Generation 绑定的原子 Plugin Package Task Reconciliation

- 状态：Accepted（双方言原子仓库、ownership、receipt、最小权限入口与真实
  PostgreSQL 门已实现；生产 materialization coordinator、故障注入级 HA receipt
  证明和引用感知 retention 尚未实现）
- 日期：2026-07-26
- 关联：ADR-0089、ADR-0091 至 ADR-0093、ADR-0149 至 ADR-0151、
  QL-RFC-0001 D-144/D-145/D-146

## 背景

ADR-0151 已能按 `generationDigest` 持久化一份完整、不可变的 Package semantic
revision，但 TaskDefinition consumer 仍有三个未关闭的错误窗口：

- 一代包含多个 Task 时，逐条调用通用 Task repository 会暴露部分 generation；
- upgrade 删除一个 Task 时，直接删除历史会破坏 Run、execution revision 和审计引用，
  不处理又会让旧任务继续可调度；
- Package publisher 与人工/其他 publisher 竞争同一个 `taskId` 时，只有 revision CAS
  不足以表达长期 ownership。

此外，active pointer、materialized revision、Task head 和 execution revision 位于不同
耐久边界。publisher 必须在同一提交内证明“正在提交的仍是当前 active generation”，
并保存可精确重放、可恢复、可审计的 generation receipt。

## 决策

### 1. 不新增 workspace package

纯规划与共享 repository contract 放入既有
`@qinglong/runtime-core/plugin-package-task-reconciliation`。SQLite adapter 放入
`@qinglong/local-sqlite/plugin-package-task-reconciliation` 显式 subpath；
PostgreSQL adapter 只从 `@qinglong/cluster-postgres/package-executor` 导出。

该切片没有独立部署、依赖、版本或供应链生命周期，因此不创建只有一两个文件的新
workspace importer。它不新增第三方依赖、timer、watcher、socket、连接池或常驻缓存；
`packages/` 仍保持 21 个 importer。

### 2. generation 是唯一批次，receipt 是提交事实

新增 `qinglong/plugin-package-task-reconciliation@v1` receipt。每份 receipt 精确绑定：

- Project、Package、generation、lock digest 和 previous lock digest；
- active `generationDigest` 与 materialized revision digest；
- 该 generation 的完整 Task item 集合；
- 每项最终 `taskId`、revision、content digest 与 disposition；
- domain-separated receipt digest 和数据库提交时间。

任务 identity 固定为 `pkg:<packageName>:<resourceId>`。单次 reconciliation 最多处理
512 项；输入 facts 必须与“当前 materialized Task 集合 ∪ 上一代 receipt item 集合”
完全相等，少项、多项、重复项或外来项均失败关闭。

disposition 只有：

- `created`；
- `retained`；
- `updated`；
- `disabled`；
- `already_disabled`。

upgrade 中消失的 Task 不删除，而是以新不可变 revision 设置 `enabled=false`；已禁用
任务不重复写 revision。语义未变的 Task 保留原 revision，不因 generation 变化制造
写放大。

### 3. 规划是纯函数，提交重新复验全部 fence

runtime-core planner 只接受规范化 materialized revision、上一代 receipt 和数据库
观察到的 Task/ownership facts，产生确定性 mutation ID、TaskDefinition writes、
execution plans 与 receipt。它不取得数据库、文件、网络或 active pointer authority。

adapter 在提交前和事务内都要复验：

1. materialized revision identity；
2. active install 的 installation、generation、lock 与 previous lock；
3. 上一代 receipt chain；
4. Task head revision/content digest；
5. Package ownership；
6. 完整 item/write/execution-plan coverage。

任何 fence 漂移都必须整体回滚。相同 generation、相同 receipt 是 exact replay；同一
generation 绑定不同 receipt 是 conflict。

### 4. Task ownership 是长期数据库事实

双方言新增 `plugin_package_task_ownerships`，以
`Project + taskId` 为主键并保存 `packageName`、首次 claim generation digest 与时间。
ownership 不随 disable、upgrade 或安装历史回收而删除。

首次 create 必须在创建 Task head 的同一事务 claim ownership；后续只有相同 Package
可以更新。其他 Package、人工 publisher 或通用 Task repository 不得接管。SQLite 和
PostgreSQL 的通用 TaskDefinition append 入口都在事务内拒绝已被 Package claim 的
Task，避免绕过专用 publisher。

### 5. SQLite 使用一个 `BEGIN IMMEDIATE`

SQLite 新增：

- `QingLong3PluginPackageTaskOwnerships`；
- `QingLong3PluginPackageTaskReconciliations`；
- `QingLong3PluginPackageTaskReconciliationItems`。

`0047-plugin-package-task-reconciliations` 安装三表、索引、CHECK、FK 和 owned trigger；
`0048-capability-v24` 把 local capability 推进至 v24。catalog 当前为 43 张 owned
table。

repository 复用既有单 operation authority，在一个 `BEGIN IMMEDIATE` 中完成：

- active generation 与上一代 receipt 复验；
- Task head/revision CAS；
- command Task 的 local execution revision；
- ownership claim；
- receipt 和 item 明细。

事务中任一步失败都不得留下 Task、execution plan、ownership 或 receipt 的部分状态。

### 6. PostgreSQL 只允许 Package executor 调用受审函数

PostgreSQL `pg-0026-plugin-package-task-reconciliations` 增加同义三表，并把
`control-core` capability 推进至 v25；migration stream 为 26 条，catalog 为 41 张表。

`ql3_package_executor` 没有对 Task head/revision、execution revision、ownership 或
receipt 表的原始 INSERT/UPDATE/DELETE authority。唯一写入口是：

```sql
ql3.commit_plugin_package_task_reconciliation(
  char(64), char(64), jsonb, jsonb, jsonb
)
```

该 `SECURITY DEFINER` 函数固定 `search_path`、复验 `session_user` 属于
`ql3_package_executor`、锁定 active install/Task heads，并在一个数据库事务内执行与
SQLite 同义的 fence、CAS、ownership、execution revision 和 receipt 提交。

runtime、admin、package-manager、worker-ingress、PUBLIC 均无函数执行权和新表写权；
manager 不能把公开管理请求提升为 execution authority，常驻 runtime 也不能直接发布
Package Task。

### 7. 当前只关闭 TaskDefinition 发布缺口

本 ADR 不注册 Tool handler，不激活 Workflow/Prompt，不绑定 Secret，也不把
materialized revision 自动接入生产启动。生产 coordinator 仍须按以下顺序显式装配：

1. 读取 active generation；
2. 精确读取 immutable materialized revision；
3. 调用专用 reconciliation repository；
4. 再次观察 active generation；
5. 只有 receipt 与当前 generation 一致时才允许后续 consumer admission。

在 coordinator、startup recovery 与用户可见状态完成前，该能力保持显式 subpath、
默认不可达。

## Profile 影响

- edge/standalone：没有后台 reconciliation；每次显式安装/恢复只使用一个 SQLite
  writer transaction。未变化 Task 不新增 revision，适合低性能路由设备。
- cluster：多个 executor 可竞争，但数据库锁、CAS、ownership 和 generation receipt
  使同一代只产生一个结果。executor 无原始表写权限。
- worker：不导入 planner/repository，不读取 receipt，不取得 Package 发布 authority。

## 被否决方案

1. **为 planner、receipt 或双方言 adapter 分别新建 package**：没有独立生命周期，
   会继续把 `packages/` 拆成单文件包；现有 package 的显式 subpath 已满足隔离。
2. **逐 Task 调用通用 repository**：一代中途失败会产生部分可见状态，也无法原子保存
   generation receipt。
3. **删除 upgrade 中移除的 Task**：会破坏历史 Run/execution/audit 引用；禁用新
   revision 保留审计连续性。
4. **以 namespace 字符串代替 ownership 表**：字符串约定不能阻止通用 publisher 或
   并发 Package 抢占。
5. **给 executor 原始表写权限**：应用层校验可被绕过，无法证明 item/write/receipt
   同成同败。
6. **把 Task revision 直接嵌入 materialized revision 当作已发布**：语义事实不等于
   当前 Task head，也不能给 scheduler/executor 提供既有 CAS 和 execution revision。

## 验证

- runtime-core：两代 create/retain/update/disable 规划、receipt digest、完整 coverage、
  ownership collision、head drift 和确定性 mutation identity；
- SQLite：真实 `DatabaseSync` 共享 contract、exact replay、第二代 retain/disable/create、
  active generation 漂移整体回滚、通用 Task publisher 旁路拒绝；
- PostgreSQL 18.4 arm64 真库：26 条 migration 后两代 reconciliation 与 exact replay
  通过，完整集成测试 34 pass、0 fail、1 个环境能力相关 skip；
- PostgreSQL package：146 pass、0 fail、1 个真库条件 skip；
- PostgreSQL physical HA：timeline 1→2、`remote_apply`、旧主先 fencing、standby
  promotion、旧主 `pg_rewind` 只读重入以及 promotion 前后 package-executor v25
  readiness/ACL 均通过，最终 `gates.passed=true`。

上述 HA 结果证明 schema、函数 identity 和最小权限契约可随 WAL/promotion 保持 ready，
但本轮没有在分区或 COMMIT-response-loss 窗口中提交 reconciliation receipt，因此不能
宣称已经取得 Task reconciliation 事务级故障注入证明。

## 后续

1. 实现唯一 production materialization coordinator 与 bounded startup recovery；
2. 把 reconciliation receipt 纳入 PostgreSQL HA 的 COMMIT-response-loss 与 promotion
   durable inspection matrix；
3. 建立 immutable Tool registry generation snapshot；
4. 建立 Workflow/Prompt 版本仓库和 activation contract；
5. 在 Run/execution 引用图完整后设计 Package Task 与 materialized revision 的
   retention/GC；此前禁止删除 ownership、receipt 或历史 revision。
