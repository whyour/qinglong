# ADR-0034：Approved Run 创建与原子恢复回执

- 状态：Proposed
- 日期：2026-07-19
- 关联：QL-RFC-0001、ADR-0031、ADR-0032、ADR-0033、ADR-0014

## 上下文

ADR-0032 已经建立 Approved Action 的 durable start barrier，ADR-0033 也规定恢复只能读取可信证据，不能再次调用 `execute`。但在没有真实 handler 和 evidence provider 时，这套协议只能证明何时不得重放，不能证明任何一种业务动作如何安全收敛。

Run 创建适合作为第一个内部数据库动作：它有稳定的 Project/Task/revision 身份、数据库唯一幂等键和明确的持久化成功边界。不过，仅把 `dispatchId` 写入 `Runs.idempotency_key` 仍不足以成为恢复证据。其他写入者可能抢占同一 key，Run 也没有保存 approval/action digest/execution fence；根据一条碰巧存在的 Run 推导审批动作成功会造成身份混淆。

因此需要一个与 Run 聚合同事务提交、完整绑定审批和 execution identity 的专用 receipt，并让恢复 provider 同时验证 receipt 与 Run 事实。

## 决策

### 1. 首个真实 action 类型是 `run.create`

`ApprovedRunCreationPlan` 是版本化、exact-shape、无 Secret 的不可变计划，首版只包含：

- `schemaVersion=1`、opaque `actionRef`、Project ID；
- Task ID、固定 Task revision；
- Executor type、priority；
- 可选低敏 task name、task snapshot ref 和 input ref。

canonical digest 使用固定字段顺序和显式 null 表示缺失可选字段，并把 `actionType=run.create` 纳入 SHA-256。inspect 只能解析计划、校验 Project/actionRef 并返回 digest；它不能创建 Run。execute 会再次解析同一 immutable plan，防止 inspect 与 start barrier 之间发生内容漂移。

创建出的 Run 使用：

- `trigger_type=approved_action`、`execution_origin=system`、`execution_owner=runtime`；
- `request_id=approvalRequestId`；
- `idempotency_key=dispatchId`；
- `accepted_at=execution.startedAtMs`。

本 action 的成功只表示 Run 聚合与初始 Attempt 已原子创建、Run 已进入 `queued`，不表示任务最终执行成功。

### 2. `0023` receipt 与 Run 在同一事务提交

`ApprovedRunActionReceipts` 以 `dispatch_id` 为主键，并通过唯一 `(resource_type,resource_id)` 防止一条 Run 被多个 dispatch 声明。receipt 固定绑定：

- schema version、dispatch/approval/Project；
- action type 和 canonical action digest；
- execution attempt、实际提交时看到的 execution version、start time；
- `idempotency_key=dispatchId`；
- `outcome=succeeded`、bounded result code；
- `resource_type=run`、Run ID、finish/create time；
- 对以上全部 canonical 字段计算的 evidence SHA-256。

SQLite adapter 使用一个 `BEGIN IMMEDIATE`：先在事务内复验当前 execution 仍为 `executing`，Project、attempt、startedAt、owner/token 均匹配，再创建 Run/Attempt/Event，最后插入 receipt。任一 Run、Event、receipt、约束或 commit 失败都会整体回滚，不允许留下“Run 已存在但可信 receipt 缺失”的合法成功路径。

### 3. renew 可以前进 version，但不能改变 execution identity

handler 获得的 context 可能在执行期间发生同 owner/token renew。事务内复验允许数据库 execution version 大于 handler context version，但必须保持：

- 同一 dispatch、Project 和 attempt；
- 同一 `startedAtMs`；
- 同一 owner/token；
- 状态仍是 `executing`。

receipt 保存事务实际读取到的当前 version。若 recovery/manual resolution 或 normal completion 已先推进终态，状态复验会在任何 Run 写入前拒绝旧 handler。这样 renew 不会把真实 receipt 误判为旧 attempt，终态也不会被陈旧 execute 绕过。

### 4. recovery provider 只读 receipt 和 Run

`LegacySequelizeApprovedRunRecoveryEvidenceProvider` 没有 execute 能力，只执行有界主键/唯一键读取：

- receipt 缺失且同 idempotency key 的 Run 也不存在：`missing`；
- receipt 缺失但存在 key collision：`conflict`，不能把碰撞 Run 当成功；
- receipt exact-shape、digest、approval/action/attempt/start/version 边界任一不匹配：`conflict`；
- receipt 匹配但 Run/Attempt、Project、request、origin/owner/trigger 不匹配：`conflict`；
- 全部匹配：`verified_succeeded` 并返回 receipt evidence digest；
- 数据库不可用或查询失败：抛出，由 reconciler 转成 `unavailable`。

provider 允许 receipt version 小于当前 recovery snapshot version，因为同一 execution identity 可以在 receipt 提交后续租；receipt version 大于当前 snapshot 则视为 conflict。它不从 Run 最终状态推导本 action 的结果，因为本 action 只负责创建 Run。

### 5. 重放只接受完整 receipt

相同 dispatch 再次进入 repository 时，只有完整 receipt 和绑定 Run/Attempt 全部匹配才返回原 Run 引用。只存在 `Runs(project_id,idempotency_key)` 而没有 receipt 时稳定冲突，不补写 receipt、不重新解释历史来源，也不创建第二条 Run。

### 6. 当前仍保持 production unreachable

本切片新增了真实 `run.create` handler、SQLite 原子 repository 和 automatic evidence provider，但没有把它们注册到 app、loader、service、API 或任何 lifecycle。生产启用仍至少需要：

- immutable plan 的真实持久化 resolver、preview builder 和管理入口；
- dispatcher/reconciler 的 profile-aware lifecycle、指标、告警和积压门禁；
- 真实强认证 adapter、人工恢复 API/UI、rate limit 和审计产品入口；
- PostgreSQL action/receipt/provider adapter 与多副本 contract；
- SQLite 断电、磁盘满、WAL、损坏与固定 edge 设备资源门禁；
- Run admission、Secret/Artifact policy 与实际 Executor 产品入口的联合验证。

`run.create` 的内部数据库原子性不能推广为任意 Tool、Shell 或外部 API 的 exactly-once；其他 action 仍必须各自提供可认证 receipt/query contract，无法提供时保持 `manual_only`。

## 影响

正面影响：

- 首次以真实业务 mutation 验证了 start barrier、atomic receipt 和 evidence-only recovery 的完整闭环；
- receipt 缺失不会被误判为失败或成功，幂等 key collision 明确 fail closed；
- 同事务写入适合 edge/standalone，无 watcher、每动作 timer 或全表扫描；
- renew 和终态并发具备清晰 fence，不依赖 wall clock 猜测 winner。

代价与风险：

- 每次 Approved Run 创建增加一行小型 receipt 和一次同事务 insert；
- receipt 表与 Run 生命周期形成保留关系，后续 retention 必须按 dispatch/audit 规则设计；
- 当前只有 SQLite adapter，cluster-control 不能共享本地数据库或本地 receipt；
- 仅证明 Run 创建成功，不证明 Run 执行结果或下游任务副作用。

## 未选择的方案

1. **只查询 `Runs.idempotency_key=dispatchId`**：没有 approval/action/fence 绑定，拒绝。
2. **Run 提交后另一个事务补 receipt**：崩溃窗口会产生不可判定的合法成功，拒绝。
3. **receipt 缺失时补写或重新 create**：无法证明原 Run 来源且可能重复动作，拒绝。
4. **receipt 绑定固定 start version 并要求永远相等**：合法 renew 会制造假 conflict，拒绝。
5. **根据 Run 最终 succeeded/failed 裁决创建动作**：混淆“创建 Run”和“执行任务”两种 action 结果，拒绝。
6. **立即接入 production dispatcher**：缺 lifecycle、强认证、PostgreSQL 和设备门禁，拒绝。

## 验证要求

- canonical plan 对字段顺序稳定，未知字段、非法版本和越界内容 fail closed；
- `0023` 被 migration/schema ownership 覆盖，索引和 tuple constraints 可审计；
- Run/Attempt/Event/receipt 同事务，receipt 插入故障时 Run 全部回滚；
- 相同 dispatch 精确重放只返回一条 Run 和一条 receipt；
- receipt/action/resource/digest 任一篡改返回 conflict；
- receipt 缺失返回 missing，幂等碰撞返回 conflict；
- 同 owner/token renew 后写入实际 execution version，并可被 recovery snapshot 验证；
- execution 已终结时，陈旧 handler 在 Run 写入前被 fence；
- production reachability 搜索证明 app/loaders/api/services/shared/data 未导入 handler、repository 或 provider；
- Node 22/24 全量测试、build、fresh migration 和 schema audit 通过。
