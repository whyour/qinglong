# ADR-0032：Approved Action Dispatch 执行租约与 Start Barrier

- 状态：Proposed
- 日期：2026-07-19
- 关联：QL-RFC-0001、ADR-0031、ADR-0033、ADR-0034、ADR-0005、ADR-0014

## 上下文

ADR-0031 已保证 Approval 的一次性消费与 immutable `ApprovedActionDispatch` 同事务提交，但 durable handoff 本身不等于外部副作用已执行。若 lease 过期后无条件让另一个 Dispatcher 再次调用 Tool、Package installer 或资源写入，旧执行可能已经产生副作用，只是结果尚未写回；自动 takeover 会把一次审批变成重复写入。

另一方面，只用内存队列会让控制面重启后丢失 pending 动作，只有一个全局进程锁又无法支持 cluster-control 多副本。执行侧需要与 Run cancellation/dispatch 一致的短事务 claim、owner/token/version fencing，同时必须比普通“至少一次消息”更严格地区分副作用前和副作用后故障。

## 决策

### 1. Immutable dispatch 与 mutable execution control 分表

`0021-approved-action-dispatch-executions` 新增一对一 `ApprovedActionDispatchExecutions`：

- `dispatch_id` 引用 immutable `ApprovedActionDispatch`；
- Project、status、version、attempt/max-attempt；
- 单一 `eligible_at_ms`、可选 retry time；
- lease owner/token/expiry；
- execution start、result mutation、低敏 result code 和 completion time；
- 创建/更新时间。

`0021` 为升级窗口中已经存在的 dispatch 回填 `pending@v0`。此后 Approval consume 必须在同一事务写 Approval `consumed@v3`、immutable dispatch 和 execution baseline；任一步失败全部回滚。dispatch 不承担 lease/result 更新，避免审批证据被执行器覆盖。

### 2. 状态机区分副作用前和副作用后

```text
pending
  -> leased
      -> retry_wait -> leased
      -> blocked
      -> executing
          -> succeeded
          -> failed
          -> blocked (indeterminate)
```

- `pending/retry_wait` 到期后可 claim；
- `leased` 表示尚未跨越副作用 start barrier，lease 过期可以安全 takeover；
- `executing` 表示 start barrier 已提交，handler 可能已经产生副作用；
- `executing` lease 过期只产生有效状态 `recovery_required`，不得回到 due queue；
- `succeeded/failed/blocked` 为终态；
- 只有明确发生在 start barrier 前的失败可以 retry；attempt budget 耗尽后 blocked。

`eligible_at_ms` 只在 `pending/leased/retry_wait` 非空，使 edge 和 cluster 都可以用同一有界索引扫描。`executing` 不进入普通 due scan，防止一个通用 worker 把不确定副作用自动重放。

### 3. Claim、renew、start 和 result 均使用 fencing

SQLite adapter 使用短 `BEGIN IMMEDIATE` transaction 和 `(dispatch_id,status,version,lease_owner,lease_token)` 条件更新：

- claim 增加 attempt/version 并写 lease；
- 同 owner/token 的未过期 claim 精确重放；
- 过期且尚未 start 的 lease 可以由另一个 token takeover；
- start 必须匹配 ApprovalRequest ID、action digest、owner/token/version，并发生在 lease expiry 前；
- renew 只允许当前 leased/executing fence；
- preflight release 和 execution completion 使用 result mutation ID 幂等；
- stale owner、token、version 或 action identity 全部 fail closed。

`executing` 不允许 takeover，因此原 owner 的可信结果可在 lease 到期后提交，只要它仍匹配没有被替换的 execution fence。未来 recovery resolver 与迟到结果竞争时也必须由同一数据库事务裁决，不能根据 wall clock 覆盖可信终态。

PostgreSQL adapter 必须保持相同 contract，可使用行锁、条件更新和 `SKIP LOCKED`；不得让多个控制面共享本地 SQLite。

### 4. Handler 在 start barrier 前只能 inspect

`ApprovedActionHandler` 分为：

1. `inspect(dispatch)`：必须 side-effect-free，解析 immutable action plan 并返回实际 canonical action digest；
2. `execute(context)`：只在 `executing` 已持久化后调用，接收 dispatch ID idempotency key 和 owner/token/version fence。

inspect 返回 digest 漂移、显式 blocked 或 extensible/非法结果时，不调用 execute。handler 缺失和 inspect 暂时失败可以在 start 前有界重试。execute 一旦被调用：

- 明确 success/failure 记录对应终态；
- handler throw、transport 消失或无法证明结果时记录 `indeterminate -> blocked`；
- completion 持久化失败时保持 executing/recovery-required，不调用 preflight retry，也不再次 execute。

handler 仍必须让下游接受 dispatch ID 作为幂等键或提供可查询 receipt。start barrier 只能阻止 QingLong 自动重放，不能单独提供跨数据库和外部系统的 exactly-once。

### 5. Bounded Dispatcher 不拥有 timer

当前 `ApprovedActionDispatcher.dispatchBatch()` 每次只读取一页，页上限 64，固定一次 due observation，并逐条 claim/inspect/start/execute/complete。它没有内部 timer、递归翻页、后台进程或生产注册；调度 cadence、页数上限、shutdown 和 profile 资源预算由后续 lifecycle owner 决定。

edge/standalone 可以用较慢 cadence 和小页；cluster-control 使用 PostgreSQL 多节点 claim。二者共享状态机，但不共享 adapter 或本地文件。

### 6. 当前切片保持 production unreachable

当前已经具备 execution migration、SQLite repository、handler port、bounded dispatcher，以及 ADR-0033/`0022` 的 recovery control/resolution repository 和 evidence-only reconciler。ADR-0034/`0023` 已提供第一个默认不可达的 `run.create` handler、同事务 Run receipt 和 SQLite evidence provider，但仍没有：

- Tool/Package/Secret 等外部 mutation handler，或 `run.create` 的 production plan resolver；
- 通用 canonical action plan/Artifact resolver 和其他下游 idempotency receipt；
- 强认证人工处置 API、production lifecycle 或 PostgreSQL evidence provider；
- lifecycle timer、startup/shutdown、Profile cadence、指标和告警；
- `/api/v3` Approval UI/Event/Audit；
- PostgreSQL adapter 与跨方言 contract suite；
- 可信 owner bootstrap issuer 和生产 authentication wiring。

因此 app/loaders/api/services/shared/data 不得导入该 dispatcher/repository。当前 `run.create` 只能在显式 contract test 中执行，现有 Shell、Scheduler、Tool 和 HTTP 路径均不可达。

## 影响

正面影响：

- pending 动作可跨重启恢复且支持多 Dispatcher fencing；
- pre-start crash 可安全 takeover，post-start crash 不会自动重复副作用；
- digest drift 在任何 handler 副作用前阻断；
- completion 丢失显式进入 recovery，而不是猜测成功或重新执行；
- edge 只有有界索引扫描和短事务，空闲时零内部 timer。

代价与风险：

- 每个 approved dispatch 增加一行 execution control 和多个短事务；
- `recovery_required` 需要后续 receipt/query resolver，否则需要人工处置；
- handler 必须满足 inspect 无副作用、actionRef 不可变和下游 idempotency contract；
- 当前没有生产 handler，功能仍不可达。

## 未选择的方案

1. **leased 过期一律重新 execute**：无法区分副作用是否已发生，拒绝。
2. **Approval consumed 后直接同步调用 handler**：崩溃后无 durable claim/result，拒绝。
3. **把 mutable lease/result 写回 immutable dispatch**：混淆审批证据和执行控制，拒绝。
4. **handler exception 自动 retry**：异常可能发生在副作用之后，拒绝。
5. **用内存队列或进程锁去重**：重启丢失且不支持 cluster 多副本，拒绝。
6. **一个后台 timer 扫完整表**：edge 写放大和停机不可控，拒绝。

## 验证要求

- `0021` 能回填已有 dispatch，schema ownership 覆盖表、索引和 migration；
- Approval consume 的三表写入原子，execution insert 失败时 Approval/dispatch 回滚；
- due 查询使用稳定 keyset、固定页上限且不返回 executing/terminal；
- 双 SQLite 连接对一个 due dispatch 只有一个 claim，其余看到 live lease；
- expired leased 可以 takeover，expired executing 只能 recovery-required；
- start 精确绑定 ApprovalRequest/action digest/owner/token/version；
- preflight retry 有 attempt budget，耗尽后 terminal blocked；
- success/failure/indeterminate result 有 fencing 和精确 mutation replay；
- handler execute 只发生在 durable start barrier 后；
- execute 后异常、completion 写失败都不进入自动 retry；
- Node 22/24 全量测试、类型检查、migration chain、schema audit 和 GitNexus reachability 通过；
- 生产目录不得导入或装配本切片。
