# ADR-0053: Cluster Startup Recovery Source 与 Convergence Gate

- 状态：Proposed
- 日期：2026-07-19
- 关联 RFC：QL-RFC-0001 D-06、D-36 至 D-41、D-52

## 上下文

cluster-control 的激活顺序已经固定为 readiness → assembly → recovery → lifecycle → admission，但此前 `reconcile()` 的安全摘要完全由调用方提供。一个空实现可以直接返回 `safe: true`，bootstrap 没有独立的 PostgreSQL 事实可以复核。与此同时，直接扫描全部非终态 Run 既可能拖垮大库，也会把正常 queued/running 工作误判为启动遗留，使有业务流量的集群无法滚动扩容。

本决策只补齐“恢复候选发现与恢复后收敛证明”，不伪装成已经实现了修改 Run/Attempt 的生产 Reconciler。

## 决策

### 1. Recovery Source 是 runtime-core 端口

`ClusterControlRecoverySource` 接受 `limit`，返回由 durable source 自己选择的 `observedAtMs`、按稳定时间/身份排序的候选页与 `hasMore`。页大小硬上限为 128；实现不得内部递归翻页、执行 `COUNT(*)`、创建 timer、持有全表结果或导入 legacy SQLite recovery。PostgreSQL adapter 必须在同一条 statement 内用数据库 `statement_timestamp()` 冻结 observation，Pod 本机时钟和调用方输入都不能决定 lease 是否过期。

source 通过 `ClusterControlAssemblyInput.recovery` 暴露给后续真实 Reconciler。它只授予候选读取能力，不授予绕过 RunRepository fence 的状态修改能力。

### 2. 候选只表示失去有效 ownership 的工作

PostgreSQL source 只返回：

- 持久化停在 `created` 的 runtime-owned Run；
- 状态为 `dispatching/running`，但不存在 lease 仍晚于同一 `observedAtMs` 的 active Attempt 的 Run；
- 状态为 `claimed/starting/running` 且 lease 缺失或已经到期的 Attempt。

正常 `queued`、`waiting_approval`、`retry_wait`、`lost` 以及仍有有效 Attempt lease 的运行任务不是本副本的启动遗留，不得阻塞滚动扩容。终态 Run/Attempt 也不得进入候选。

该定义是保守的恢复入口，不是最终状态机裁决。真实 Reconciler 仍须通过 transaction、lease/fencing 和可信执行证据决定 lost、重试或终态，不能因候选出现就重放执行。

### 3. SQL 与索引都必须有硬读取上限

`pg-0007-cluster-recovery-indexes` 为 runtime-owned `created/dispatching/running` Run 和 active Attempt 建立部分索引；Attempt 索引以 lease expiry 开头。查询的 Run、Attempt 两个分支各自先 `ORDER BY ... LIMIT limit+1`，再合并并执行同一上限，因此一次调用最多从两个候选分支各取得 129 行，不会把全部 backlog 拉进 Node.js 内存。

schema capability 推进到 `control-core` v6，并增加 `cluster_recovery: 1`。reviewed migration、冻结 checksum manifest、Drizzle schema、catalog contract 和 readiness 必须 lockstep；runtime role 继续只使用既有 Run/Attempt SELECT 权限，不新增 DDL 或管理权限。

### 4. Bootstrap 独立复核恢复摘要

调用方 application stack 先执行自己的 `reconcile()`。只有它返回精确的 `safe=true, remaining=0, failed=0`，bootstrap 才使用独立 `ClusterControlRecoveryConvergenceVerifier` 以 `limit=1` 查询 PostgreSQL：

- 无候选且 `hasMore=false`：返回安全收敛；
- 存在候选：返回 `safe=false`，`remaining` 只是至少还存在多少项的低成本下界；
- source、数据库 observation 或 row contract 异常：抛出并让 activation fail closed。

因此调用方不能用一个恒真的摘要绕过数据库事实。未收敛或验证失败时不得启动 lifecycle、安装 `/api/v3` admission 或让 `/readyz` 返回 ready，并按既有顺序停止 stack 和 Pool。

### 5. 当前仍不是完整生产恢复

本切片没有实现候选 claim、lease takeover、执行证据探测、状态推进、重试策略、告警或多副本 Reconciler lifecycle。当前默认 production application stack 仍不存在，`run.get` route 也仍未自动注册。只有后续恢复实现能处理所有候选并通过本 verifier，cluster Profile 才能继续进入 lifecycle/admission。

## 被否决的替代方案

### 扫描所有非终态 Run 并要求清空

拒绝。queued/等待/有效 lease 都是正常集群状态；这种门禁会使活跃集群无法扩容，并把启动时间绑定到业务 backlog。

### 用 `COUNT(*)` 返回精确 remaining

拒绝。激活只需要知道是否存在遗留。精确计数会在最坏时扩大数据库扫描和锁压力；低成本下界足以 fail closed，精确 backlog 应由异步指标维护。

### 信任 application stack 返回的 `safe: true`

拒绝。composition 回调不是数据库权威，空实现、遗漏状态或测试替身都可能在恢复未完成时开放 admission。

### 在 bootstrap 内直接把过期 Attempt 标记 lost

拒绝。候选发现不等于拥有状态推进 authority；未经 lease/fence、执行证据和 retry policy 裁决直接改状态可能制造重复执行或覆盖其他副本。

## 影响

### 正向

- 激活门首次能从 PostgreSQL 独立证明恢复摘要不是恒真占位；
- 正常活跃工作与真正失权遗留被明确区分，支持滚动扩容；
- 单次查询、单页内存和索引范围都有硬上限；
- edge/standalone 不引入 PostgreSQL source、额外 timer 或 cluster 依赖；
- capability/readiness 可以拒绝缺少恢复索引的旧 schema。

### 代价与未完成项

- 新增两个部分索引及 capability v6 migration；
- source 只提供候选，真实多副本恢复 claim/supervisor 仍需后续 ADR；
- lease writer 必须使用与 PostgreSQL observation 兼容的数据库时间语义，生产仍应监控数据库节点间时钟漂移；
- 需要 PostgreSQL 16/18 `EXPLAIN`/大 backlog 基准证明查询计划稳定使用部分索引。

## 验证

1. runtime-core contract test 证明 verifier 固定只请求一项并拒绝不一致页/非法 durable observation。
2. PostgreSQL adapter test 证明两个分支和合并层都使用 `limit+1`，并拒绝越界 limit、终态或畸形 row。
3. migration/manifest/schema/readiness tests 证明 capability v6、两个部分索引与冻结 checksum lockstep。
4. bootstrap test 证明 application 返回 false-safe 时仍不能安装 admission，并按 stack → Pool 关闭。
5. 正常 queued、等待状态和有效 lease 不进入 SQL 候选条件；过期或缺失 lease 才进入。
6. Node 22/24、PostgreSQL integration、edge import audit、cluster dependency audit 与 GitNexus detect-changes 继续作为合并门禁。
