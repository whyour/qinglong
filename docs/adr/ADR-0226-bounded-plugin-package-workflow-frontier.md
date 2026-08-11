# ADR-0226：有界 Plugin Package Workflow Frontier

- 状态：Proposed
- 日期：2026-07-30
- 关联 RFC：QL-RFC-0001 D-03、D-207、D-212
- 关联 ADR：ADR-0156、ADR-0223、ADR-0224、ADR-0225

## 背景

ADR-0223 至 ADR-0225 已把 generation-bound Workflow DAG 原子展开为一个
runtime-owned Workflow Run、全部 StepRun、Event/mutation 与 admission receipt。
准入后的 Workflow Run 固定为 `running`，而 Task root StepRun 为 `ready`、其余
StepRun 为 `pending`。

首次 PostgreSQL HA 重跑暴露出一个恢复边界错误：通用 Cluster Run recovery 把没有
RunAttempt 的 Workflow 聚合 Run 识别成孤儿执行。该判断对普通 Task Run 成立，但
Workflow Run 本身是编排聚合，不应直接进入普通 Task dispatcher，也不应伪造一个
RunAttempt 或终态绕过恢复。

同时，低配 Edge 不能为每个 dormant Workflow 建立 timer、watcher 或内存队列；Cluster
多副本也不能依赖进程内 frontier。

## 决策

### 1. 通用恢复器排除 Workflow 聚合

PostgreSQL 通用 recovery source 必须排除
`trigger_type='plugin_package_workflow'`。这不是忽略孤儿工作，而是明确 ownership：

- 普通 Task Run/RunAttempt 继续由既有 Cluster recovery 处理；
- Workflow 聚合 Run 只由专属 Workflow frontier/recovery 处理；
- Workflow 的 Task Step 后续仍必须通过既有 RunAttempt/Executor fence 启动，不能把
  聚合 Run 作为普通 Task 分发。

### 2. 纯 frontier 契约留在现有 runtime-core

新增显式 subpath
`@qinglong/runtime-core/plugin-package-workflow-frontier`，不新增 workspace package、
第三方依赖、进程或连接。一次 resolution 只接受：

- exact normalized immutable plan；
- exact runtime-owned `plugin_package_workflow` Run fence；
- 与 plan 一一对应的最多 128 个 durable StepRun；
- 单调的存储 observation time。

契约对完整 StepRun 集合、Run/Project/Workflow/publication identity、Task
definition ref/digest 和 record digest 失败关闭。

### 3. 一次纯计算收敛依赖 frontier

resolution 使用确定性规则：

1. pending Step 的所有 `needs` 都为 `succeeded` 时生成 `pending → ready` mutation；
2. 任一祖先为 `failed|skipped|cancelled|timed_out` 时，依赖失败可在同一 pass 传递，
   下游生成 `pending → skipped`，result code 固定为
   `dependency_not_succeeded`；
3. mutation 按 canonical Step key 顺序绑定连续 Run version/event sequence；
4. frontier event ID 不超过双方言共有的 36 字节，mutation ID 由 plan、StepRun
   identity/version 与目标状态做 domain-separated digest；
5. resolution 返回 projected ready StepRun ID，但不把读取结果解释为执行 claim。

当全部 required StepRun 终结时，纯契约给出固定的 Run terminal 建议：
`failed/skipped → failed`，其次为 `timed_out`、`cancelled`，全部成功才为
`succeeded`。terminal transition 同时绑定 expected Run version/event sequence、
固定 error code、finished time 和不超过 36 字节的确定性 RunEvent identity；storage
adapter 必须把它与本轮 StepRun mutation 原子提交。

### 4. 双方言使用同一 port，不新增 package

同一显式 subpath 公开最多 64 条的 keyset candidate page 和
`listCandidates/advance` repository port：

- SQLite adapter 位于既有 `@qinglong/local-sqlite`，复用单
  `LocalSqliteOperationAuthority` 和 `BEGIN IMMEDIATE`；candidate SQL 只返回可推进
  pending dependency 或全部 StepRun 已终结但聚合 Run 未终结的 Workflow，不为 root
  ready 或等待中的 Workflow 制造空写；
- PostgreSQL adapter 位于既有 `@qinglong/cluster-postgres`，由 caller 驱动有界
  keyset page；`advance` 使用短 `SERIALIZABLE` transaction，锁定聚合 Run 和完整
  StepRun 集合，使用数据库 transaction clock，并对 serialization/deadlock 做有界
  fresh-client retry；
- 两者都先验证 immutable plan、Run identity 和所有 StepRun canonical JSON/mirror，
  再按 StepRun version/digest/status CAS；一轮只更新一次聚合 Run，version/event
  sequence 按 mutation 数加 terminal event 数整体推进；
- StepRun、RunEvent、StepRunMutation 和 terminal Run/Event 同事务提交，任一 drift、
  fence 或写入冲突整体回滚；已终态 aggregate 重放只读收敛为 `settled`。

没有新增 migration、workspace package、第三方依赖、连接、timer、watcher 或后台
scanner。ready Task 的执行 admission 仍必须在后续原子绑定 StepRun 与
RunAttempt/Executor fence，frontier 的 ready projection 本身不是执行 claim。

### 5. admission replay 只冻结准入证据，不冻结当前执行状态

双方言 admission exact replay 继续严格验证 immutable plan、receipt、初始 RunEvent、
初始 StepRun mutation 与 admission step ledger，但不再要求当前 Run/StepRun 永远停在
准入初态。当前 aggregate 只允许合法运行/终态、identity 不变、canonical record
完整且 version/event sequence 单调；初始 Event 查询固定截止 admission final sequence。
因此合法 frontier/Executor 推进后仍可 inspect/exact replay，而历史准入证据缺失或漂移
仍失败关闭。

## 不采用方案

### 把 Workflow 聚合 Run 交给普通 dispatcher

拒绝。聚合 Run 的 `taskId` 是 Workflow ID，revision 是 publication digest，不是一个
普通 Task execution revision；直接分发会错误解释定义并把一个 DAG 当成一次 Task。

### 为恢复器伪造 RunAttempt 或把聚合 Run提前置为终态

拒绝。伪造 Attempt 会制造不存在的执行事实；提前终结会隐藏尚未执行的 ready/pending
StepRun。

### 每 Workflow 常驻 coordinator

拒绝。它给低配路由器增加空闲内存、唤醒与写放大，并让 Cluster 正确性依赖进程内
ownership。

### 新建 workflow package

拒绝。纯契约没有独立部署、重依赖或权限域，另拆会违反 D-207 的 package 粒度标准。

## 当前验证

1. 通用 PostgreSQL recovery SQL 影响评估为 LOW，新增 Workflow trigger exclusion；
2. runtime-core 405/405，包含 frontier 纯契约 6/6 与后续 Attempt admission 4/4；
3. `local-sqlite` 180/180；真实 SQLite frontier 覆盖 dependency ready、失败向下游
   skipped、成功/失败 aggregate terminal、bounded page、drift rollback、settled 与
   admission-after-progress exact replay；
4. `cluster-postgres` 223 pass、1 条无测试 URL 条件 skip；mock 契约覆盖
   `SERIALIZABLE`、Run/StepRun row lock、单 aggregate CAS、terminal 原子写、
   40001 fresh-client retry、settled 与显式 subpath；
5. PostgreSQL 18.4 arm64 physical HA 在禁止 image pull 下完整通过，包含
   `remote_apply`、timeline 1→2、旧主 fencing、promotion、`pg_rewind` 和两 fresh
   control replicas；新增
   `pluginPackageWorkflowFrontierTerminalizesAtomically`、
   `pluginPackageWorkflowFrontierExactlyReplays`、
   `pluginPackageWorkflowFrontierSurvivesPromotion` 三项 gate，总
   `passed=true`；
6. HA durable facts 为 1 个 Workflow admission、5 个 Workflow RunEvent、3 个
   StepRunMutation；promotion 后 frontier 返回同一 `succeeded/settled` winner，
   admission 仍 exact replay；
7. workspace 仍为 20 个 package，未新增生产依赖或常驻资源。

## 尚未关闭

1. ready Task StepRun 到 RunAttempt/Executor 的原子执行 admission；
2. Workflow 取消、超时和 Task post-start recovery；
3. frontier caller 与 Local application/Cluster control 生命周期装配；
4. Edge/Standalone 真实断电、资源门和产品 API/CLI/UI。
