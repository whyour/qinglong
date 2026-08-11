# ADR-0031：ApprovalRequest 与 Durable Action Dispatch

- 状态：Proposed
- 日期：2026-07-19
- 关联：QL-RFC-0001、ADR-0028、ADR-0030

## 上下文

ADR-0028 已规定 Agent 的写、Secret、管理和 Tool call 即使角色允许也只能得到 `require_approval`，但此前没有持久化审批状态机。若调用端把 `require_approval` 当成 allow，或只保存一个可修改的 prompt/preview，Agent 可以在人工确认后替换参数；若审批后直接执行外部副作用，进程在“标记已消费”和“真正执行”之间崩溃，又会在重复执行与永久丢失之间二选一。

审批还必须同时适配资源很小的路由设备和集群控制面。edge 不能依赖常驻 expiry timer、全表扫描或大型 JSON；cluster 则必须能够用事务、行锁、版本和 fencing 裁决多个控制面节点。审批后发生 Project archive、RoleBinding revoke 或角色变更时，旧授权也不能继续穿透当前 Policy。

## 决策

### 1. Approval 绑定不可变动作身份，不保存动作明文

`ApprovalRequest` 保存：

- Project ID、request ID 和单调 version；
- 精确 `ProjectPermission`；
- 有界 `actionType` 与 opaque `actionRef`；
- canonical action payload 的 SHA-256 `actionDigest`；
- 用户可见安全预览的 SHA-256 `previewDigest`；
- `low|medium|high|critical` risk；
- requester ActorRef、请求时间和绝对过期时间。

数据库不保存 prompt、Tool arguments、Shell、Secret 值或任意 `preview: unknown`。产品层需要展示预览时，必须从独立、受授权的 Artifact/plan 读取安全预览，并验证 `previewDigest`；真正消费时由执行计划重新计算 `actionDigest` 并精确匹配。`actionRef` 只是定位 durable plan，不是授权本身。

request ID 同时是创建幂等身份。相同 ID 与相同不可变字段返回当前资源；ID 相同但 action/risk/requester/时间漂移返回 conflict。

### 2. 持久状态与有效过期分离

持久状态机为：

```text
pending@v1 -> approved@v2 -> consumed@v3
           -> rejected@v2
```

`expired` 是 `now >= expiresAt` 且持久状态仍为 `pending|approved` 时的有效状态，不需要后台 timer 写库。决定和消费都在精确边界前完成；`now == expiresAt` 已过期。首版审批寿命最大 24 小时，审批不会延长原 expiry。

`rejected`、`consumed` 为终态。未来若增加 cancel、supersede 或 re-open，必须新增显式 version/state 和 migration，不能覆盖历史决定。

### 3. 决定只能来自当前被授权的稳定 User

决定审批必须同时满足：

1. `decidedBy` 是稳定 `user` ActorRef；
2. requester 与 decider 不同；
3. 当前 Project Policy 对 decider 的 `approval.decide` 返回 `allow`；
4. 写事务内 Project version 和 decider RoleBinding version 仍等于 Policy 读取时的 fence。

Agent、API App、MCP Client、Worker 和 System 首版不能决定审批。Agent 即使拥有高角色也不能形成递归“审批自己的审批”。身份认证、MFA/rate limit 与 wire 层审计仍是生产接入门禁，本 ADR 不把一个裸 ActorRef 当成认证证据。

### 4. 创建和消费都重新验证 Policy fence

创建只接受 Policy effect 为 `require_approval` 的动作；`deny` 和 `allow` 都不创建冗余审批。消费前重新对原 requester、Project 和原 permission 求值：只有 `allow|require_approval` 可以继续，`deny` 或 unavailable fail closed。

每次 mutation 都携带同一次 Policy resolve 返回的 `{projectVersion,bindingVersion}`。SQLite adapter 在 `BEGIN IMMEDIATE` 事务内重新读取当前 Project/RoleBinding version；不一致返回 fence conflict。这样审批与 Role revoke/archive 竞争时，只有一个顺序能提交。所有受支持的 Project/Role mutation 都必须递增或 append version，否则属于存储损坏。

PostgreSQL adapter 必须保持相同 contract，可用行锁或等价条件更新实现；不得只在 application 层先查后写。

### 5. 消费审批必须同事务创建 durable dispatch

`approved` 不等于副作用已执行。一次性消费在同一数据库事务完成两件事：

1. `ApprovalRequest approved@v2 -> consumed@v3`；
2. 创建唯一 `ApprovedActionDispatch`，复制 Project、permission、action identity、requester、consumer 和时间。

若 dispatch 插入、状态更新或 fence 校验任一步失败，事务整体回滚，Approval 仍可安全重试。`consumptionId` 与 `dispatchId` 都是有界幂等身份；完全相同的重放返回同一 dispatch，任一字段漂移返回 conflict。每个 Approval 只能关联一个 dispatch。

这提供的是“一次性授权消费 + durable handoff”，不是外部副作用的 exactly-once 保证。后续 Dispatcher/Executor 必须从 durable dispatch claim，使用 lease、owner/token/version fencing，并要求下游 action identity 幂等；不得在 Approval transaction 内直接调用网络、Shell 或 Tool。

### 6. Edge 与 Cluster 使用同一语义、不同 adapter

edge/standalone 使用 SQLite 点查、唯一索引和短 `IMMEDIATE` 事务；过期按读时计算，空闲时零 timer、零周期写。pending/actor/dispatch 索引为后续 UI 与 dispatcher 提供有界 keyset 查询，不能做无界 offset 扫描。

cluster-control 使用 PostgreSQL adapter、同一状态/version/幂等 contract 和适合多节点 claim 的行锁；`ApprovedActionDispatch` 的后续 claim schema 由 ADR-0032/`0021` 以独立 execution control 增量演进。edge 不因此依赖 PostgreSQL、消息队列或外部缓存。

### 7. 当前切片保持 production unreachable

本切片实现 `0020`、domain/port、Policy fenced SQLite repository、application service 和 contract tests，但没有：

- `/api/v3` Approval route、UI、SSE/Event 或审计 exporter；
- legacy session/identity 到 `AuthenticatedPrincipal` 的生产装配；
- owner bootstrap 的可信 issuer，因此默认 Project 仍没有 owner；
- preview Artifact/plan resolver 和 canonical action digest builder；
- 真实 ApprovedAction handler、下游 idempotency receipt 和 `recovery_required` resolver；
- PostgreSQL adapter、跨方言 contract suite、rate limit 和 MFA 产品策略；
- Run `waiting_approval` 的事务性暂停/恢复装配。

因此生产代码不得导入或调用该 service，也不得把 pending dispatch 直接交给现有 `ScheduleService`、Shell 或 Tool。完成 wire、审计、digest builder、dispatch executor 与部署门禁前，现有 2.x 行为保持不变。

## 影响

正面影响：

- 人工审批精确绑定不可变动作，参数替换会被 digest 拒绝；
- Role revoke、Project archive 与审批 mutation 有事务 fence；
- 消费后崩溃不会丢失已授权动作，durable dispatch 可恢复；
- edge 无常驻 expiry timer，表和索引均有界；
- 创建、决定和消费均支持精确幂等重放与并发裁决。

代价与风险：

- Approval 与 dispatch 各增加一张表和短写事务；
- 产品层必须建立 canonical action/preview 生成规范，digest 不能由 Agent 自报后直接信任；
- durable dispatch 已由 ADR-0032 增加独立 claim/lease/result 状态机，但仍缺真实 handler、recovery resolver 和生产 lifecycle，当前不能执行副作用；
- Policy version discipline 成为安全不变量，绕过 Repository 直接改表会破坏 fence。

## 未选择的方案

1. **直接保存 `preview: unknown` 并批准该 JSON**：可能泄漏 Secret、形状无界且难以 canonicalize，拒绝。
2. **批准 Tool 名，不绑定参数 digest**：审批后可替换目标和参数，拒绝。
3. **审批后同步调用 Tool/Shell**：数据库事务无法覆盖外部副作用，崩溃窗口不可恢复，拒绝。
4. **先标记 consumed，再投递内存队列**：进程崩溃会永久丢失动作，拒绝。
5. **审批永久有效**：Role/plan/风险会漂移，拒绝。
6. **Agent 或 System 自动决定审批**：绕过人工边界并产生递归授权，首版拒绝。
7. **每秒 timer 把过期行改成 expired**：edge 空闲写放大且没有必要，拒绝。

## 验证要求

- migration/schema ownership 覆盖两张表、唯一索引和 tuple/state constraint；
- 明文 preview、参数和 Secret 不进入 Approval/dispatch 行；
- 创建只接受 `require_approval`，决定只接受有 `approval.decide` 的 User；
- request/decision/consumption ID 的精确重放成功，漂移冲突；
- `now == expiresAt` 的决定和消费被拒绝；
- Policy version 变化使同事务 fence 失败；
- 双 SQLite 连接竞争决定或消费时只有一个提交；
- dispatch 冲突会回滚 Approval consumption；
- consume 后恰好存在一个匹配 digest 的 pending durable dispatch；
- Node 22/24 全量测试、类型检查、完整 migration chain schema audit 与 GitNexus reachability 通过；
- `app/loaders/api/services/shared/data` 不得导入 Approval core。
