# ADR-0055: Cluster Recovery Evidence 与 Fenced Lost Transition

- 状态：Proposed
- 日期：2026-07-19
- 关联 RFC：QL-RFC-0001 D-03、D-06、D-18、D-25、D-26、D-42、D-52 至 D-54

## 上下文

ADR-0053/0054 已把失效 ownership 候选、有界 discovery、独立 recovery claim 和多副本 fencing 建立起来，但“取得 claim”只证明当前副本可以裁决，不能证明任务已经停止，更不能证明任务可以安全重放。尤其是 `starting/running` Attempt：执行 lease 过期只能证明控制面失去 authority，Worker、容器或外部执行器仍可能继续产生副作用。

另一方面，`claimed` Attempt 尚未越过 start barrier。只要持久化状态仍是 `claimed` 且 lease 已按数据库时间过期，就存在控制面内的 durable pre-start 证据，可以安全地把旧 Attempt 收敛为 `lost`，无需调用外部 provider。

本决策只补齐 recovery 的证据分类和 `lost` 状态推进，不创建下一次 Attempt、不排队、不调用 Executor，也不裁决成功、失败、取消或重试策略。

## 决策

### 1. 候选、claim、证据与 mutation 是四个独立边界

一次处理固定按以下顺序进行：

1. ADR-0053 source 只发现失去有效 ownership 的候选；
2. ADR-0054 repository 只授予短期、可接管的 recovery claim；
3. evidence processor 在 claim transaction 外重读 Run/Attempt，并只在必要时查询可信 provider；
4. resolution repository 重新锁定完整 claim fence、重读聚合并原子提交状态与事件。

任何一步都不得把前一步的结论扩大为任务执行 authority。外部 provider 调用期间不持有数据库连接、transaction 或行锁。

### 2. 证据矩阵必须保守且可枚举

| 持久化事实或外部证据 | 自动结果 | 理由 |
| --- | --- | --- |
| `claimed`、lease 已过期、未越过 start barrier | Attempt/Run `lost` | durable pre-start 事实证明没有被允许启动，不需要外部探测 |
| `starting/running`、可信 provider 返回 `not_running` | Attempt/Run `lost` | 精确执行身份的可信负证据证明当前执行不存在 |
| `starting/running`、provider 返回 `running` | bounded `retry` | 旧执行仍可能产生副作用，不能写 lost 或重放 |
| provider `provider_unavailable` | bounded `retry` | 暂时不可观察不等于任务不存在 |
| provider `identity_unverifiable` 或 `conflicting_evidence` | `manual` | 身份不完整或证据冲突不能靠自动重试消除歧义 |
| execution lease 已恢复有效 | `resolved` | 当前快照不再是 recovery 候选 |
| cancellation intent 未收敛 | bounded `retry` | recovery 不越权替代 cancellation coordinator |
| `created` Run、缺失 Attempt、Run/Attempt 终态矛盾或未知组合 | `manual` | 聚合不满足安全自动转换前提 |

provider 必须接收绑定 Run/Attempt、Attempt 状态、executor type、Worker/handle/PID、execution lease 的精确目标。它只能返回 `running | not_running | unknown(reason)`，不得执行 start、stop、retry、completion callback 或任意外部 mutation。

### 3. Lost 转换权限必须窄于通用状态机

runtime-core 只提供 recovery 专用的纯 `lost` 转换：

- 仅接受 `executionOwner=runtime`；legacy owner 不可达；
- cancellation intent 存在时拒绝转换；
- `claimed/starting/running` Attempt 才能转 `lost`；
- `dispatching/running` Run 才能随 Attempt 转 `lost`；
- 已 `lost` Attempt 可驱动仍 active 的 Run 补齐 `lost`；
- 保留原 execution lease、Worker、handle、PID 和 callback sequence 作为审计证据；
- 按顺序产生 `attempt.lost`、`run.lost`，每步独立推进 Run version/event sequence，并使用稳定 dedupe key。

该 primitive 明确不创建 Attempt N+1、不改变 RetryPolicy、不推断 terminal completion、不调用 Executor。自动重试仍必须由 ADR-0026 的冻结策略、安全性声明和新 Attempt 协议负责。

当前 legacy `transitionRun`、`transitionRunAttempt` 与版本冲突链路具有 CRITICAL blast radius。为避免以 cluster 恢复切片暗中重写 2.x 状态机，本阶段不修改这些符号；将来只有在共享 contract、调用方迁移和回退门禁齐备后，才通过独立 cutover ADR 合并实现。

### 4. PostgreSQL mutation 必须在完整 fence 下原子提交

`applyLost()` 使用短 `READ COMMITTED` transaction：

1. 以 `(target kind, target id, state=claimed, owner, token, version)` 和 PostgreSQL statement time 校验 claim 未过期，并 `FOR UPDATE` 锁定 control row；
2. 在锁内重读 Run 与精确/最新 Attempt；
3. 与 provider 前快照比较 status、version、event sequence、ownership、cancellation、执行身份、lease、callback sequence 和关键时间；
4. 使用 Run/Attempt CAS 提交每个状态转换，并在同一 transaction 追加对应事件；
5. 任一 CAS、事件或存储步骤失败时回滚全部业务状态。

旧 owner、过期 claim 或 takeover 必须在读取和修改 Run/Attempt 前返回 `fenced`。快照变化返回 `stale`，由后续 discovery/verifier 重新裁决，不能套用旧证据。

业务 mutation 与 ADR-0054 的 control settle 故意不是一个 transaction：外部 processor 崩溃可能发生在 mutation 已提交、claim 尚未 settle 之间，但底层 Run/Attempt 已不再满足原候选，后续 verifier/discovery 会安全收敛；反向顺序会制造“claim 已 resolved、业务事实未落库”的危险窗口。

### 5. Profile 和资源边界不变

该 processor 位于无 driver 的 runtime-core；PostgreSQL transaction 实现只存在于 `@qinglong/cluster-postgres`，并由 `cluster-control` assembly 显式注入。edge/standalone 的依赖树、启动 importer、SQLite lifecycle 和资源预算不得因此引入 `pg`、Drizzle PostgreSQL、control table 或 cluster supervisor。

集群节点通过小页、短 transaction、页内串行和每项 claim fencing 控制单副本成本，再依靠多副本横向处理；不得用单个无界 leader loop、全表常驻缓存或跨 provider I/O 的长 transaction 换取吞吐。

### 6. 当前仍不开放生产 recovery

ADR-0056 已增加 exact-type、identity-declared、timeout/single-flight 有界的 production registry，并由 cluster bootstrap 默认拥有；但仍没有 Remote Worker、Kubernetes 或 Container 的真实认证 provider。LocalProcess、Remote Worker、Container 与 Kubernetes 必须分别证明什么是“精确身份”和“可信 not-running”，不能用通用 `process missing`、网络超时或 Worker offline 冒充负证据。

默认 startup 多轮 lifecycle、取消协调、lost 后 retry PostgreSQL adapter、指标/告警、manual recovery API/UI 和强认证审计也仍未完成。因此 cluster-control 仍不能因为本 ADR 的集成测试通过就宣称具备生产自动恢复或开放 mutation admission。

## 被否决的替代方案

### Lease 过期一律写 lost 并自动重跑

拒绝。`starting/running` 已越过 start barrier，lease 只证明失权，不证明副作用停止；重放会产生 split-brain 和重复业务写。

### Provider 不可用时按 not-running 处理

拒绝。观察系统故障与执行不存在是不同事实；前者只能 bounded retry，身份不可验证或证据冲突必须进入 manual。

### 外部探测后直接调用通用 Repository 多次写入

拒绝。探测期间 Run、Attempt 或 claim 都可能变化，缺少重新 fencing、快照比较和单 transaction CAS 会留下半转换聚合或让旧 owner 晚到覆盖。

### Recovery processor 直接创建 retry Attempt

拒绝。lost 判定与 retry eligibility 是两种 authority。后者还需要冻结策略、次数预算、幂等/去重声明和 Attempt N+1 原子创建，不能由 evidence provider 决定。

## 影响

### 正向

- pre-start 与 post-start 使用不同证明标准，不把 lease expiry 当成统一死亡证明；
- 多副本旧 owner 在 probe 后仍无法越过 PostgreSQL fence；
- Run/Attempt/双事件要么全部提交，要么全部回滚；
- execution identity 与 lease 证据被保留，便于后续人工取证；
- runtime-core contract 可被不同 provider/数据库复用，同时保护 edge 安装与启动闭包。

### 代价与未完成项

- `starting/running` recovery 依赖每种 Executor 的可信 evidence provider；
- 暂时故障会保守 retry，歧义会进入 manual，可能延长 admission 阻塞；
- 状态 mutation 后、control settle 前存在可恢复窗口，需要 verifier 与指标证明最终收敛；
- 通用 legacy 状态机仍有重复实现，必须在单独高风险 cutover 中消除；
- 仍需 PostgreSQL 16/18 多 Pool、failover、provider 延迟/故障注入和大 backlog 资源基准。

## 验证

1. runtime-core contract test 覆盖 claimed 不调用 provider、可信 `not_running`、`running`/provider unavailable retry、身份不可验证/证据冲突 manual、有效 lease/stale/fence 和纯转换版本/事件语义。
2. PostgreSQL unit test 覆盖完整 control lock fence、快照重读、Run/Attempt CAS、双事件顺序、部分 CAS 回滚，以及失权后不读取/修改 Run。
3. PostgreSQL 13.3 真实集成测试证明未启动 aggregate 在无 provider/无重放下原子 lost；provider 返回后 claim 被另一副本接管时旧 owner 被 fence，Run/Attempt 保持不变。
4. Node 22/24 package test、cluster assembly test、edge import audit、cluster dependency audit 与 GitNexus detect-changes 继续作为本地门禁；正式支持结论仍以 Node 24.18+ 和 PostgreSQL 16/18 CI 为准。
