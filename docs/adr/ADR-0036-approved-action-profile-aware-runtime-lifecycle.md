# ADR-0036：Approved Action Profile-aware 有界 Runtime Lifecycle

- 状态：Proposed
- 日期：2026-07-19
- 关联：QL-RFC-0001、ADR-0008、ADR-0032、ADR-0033、ADR-0034、ADR-0035

## 上下文

ADR-0032/0033 已分别提供一页有界的 Approved Action dispatcher 和 evidence-only recovery reconciler，但它们故意不拥有 timer 或进程 hook。没有显式 lifecycle 时不会自动工作；直接为两者各启一个固定频率 timer，又会在小型路由器上造成并发 SQLite 写竞争、重复唤醒和停机难以 drain，在 cluster-control 上则可能误把单机 SQLite 编排当作多副本实现。

QingLong 的部署跨度从低内存路由/NAS 到独立服务器和集群控制节点。相同状态机可以共享，但 cadence、页大小和每周期预算不能共享一个无条件默认值。

因此需要一个默认不可达、profile-aware、单 timer、两阶段串行的 runtime lifecycle；它只编排现有有界能力，不扩大 handler、evidence provider 或数据库 adapter 的 authority。

## 决策

### 1. 一个本机 lifecycle 串行 recovery 与 dispatch

`ApprovedActionRuntimeSupervisor` 的单周期顺序固定为：

1. recovery phase：调用 `ApprovedActionRecoveryReconciler.reconcileBatch`；
2. dispatch phase：调用 `ApprovedActionDispatcher.dispatchBatch`。

recovery 优先是 fail-closed 边界。如果 recovery due index 无法读取或周期抛错，本周期停止，不继续领取并执行新的 Approved Action。单周期内两个 phase 不并发，避免 SQLite 上 recovery resolution 与新 start barrier 争夺写锁。

这不表示每次 recovery 必须清空积压。两个 phase 都有独立的 page size、max pages 和 keyset cursor，达到预算立即停止。

### 2. 页预算和 cursor 都有硬上限

每个 phase：

- page size 继续受现有 domain hard cap 64 约束；
- max pages 范围为 1..64；
- 每页汇总只累计固定数值字段，不收集 dispatch 列表、错误文本或证据内容；
- truncated 且 cursor 前进时继续下一页；
- cursor 缺失或不前进时以 `cursor_stalled` 停止并报告 remaining；
- 达到 max pages 时以 `page_limit` 返回下一 cursor。

lifecycle 只在成功周期后更新内存 resume cursor。周期失败保留原 cursor，下一 cadence 重试同一边界；进程重启后 cursor 可以从头恢复，因为 due 查询与 claim/fence 都是幂等、有界的，cursor 不是唯一持久事实。

### 3. edge 与 standalone 使用不同资源预算

本机 SQLite Profile 固定为：

| Profile | interval | recovery budget | dispatch budget | 单周期理论上限 |
| --- | ---: | ---: | ---: | ---: |
| edge | 30 秒 | 1 × 8 | 1 × 8 | 16 条 |
| standalone | 2 秒 | 2 × 16 | 4 × 32 | 160 条 |

两档 stop timeout 都为 5 秒，initial delay 为 0。这里的“条”是扫描/处理上限，不承诺每条都会写数据库；空页只做有界索引查询。

edge 的目标是限制唤醒、内存和 SQLite 写放大，不追求低延迟。standalone 提供更快收敛，但仍有硬页预算，不能因为积压进入无界循环。

### 4. lifecycle 只有一只非重叠 timer

`ApprovedActionRuntimeLifecycle`：

- 构造后 inert，只有显式 `start()` 才调度；
- 同时最多存在一只 timer 和一个 in-flight cycle；
- timer 调用 `unref()`，不单独阻止进程退出；
- 下一次 cadence 只在当前 cycle settle 后调度，不做固定间隔重叠；
- `stop()` 立即清 timer，并最多等待配置的 stop timeout；
- metrics/diagnostic callback 抛错只报告，不形成 scheduler failure loop；
- interval 最小 250 ms、最大 24 小时，stop timeout 最大 60 秒。

没有 watcher、每 action timer、递归翻页、无界 Promise 集合或后台子进程。

### 5. cluster-control 与 worker 不使用本 lifecycle

`localPrimaryResourcePolicy()` 继续只接受 edge/standalone；cluster-control 和 worker 会在取得配置前拒绝。cluster-control 未来复用 Supervisor 的 phase 语义，但必须使用 PostgreSQL repository、共享 evidence、独立多副本 ownership/leader 策略和集群指标；不能装配 SQLite lifecycle。worker 不拥有 ApprovalRequest、dispatch 或 recovery control-plane 表。

### 6. 当前仍不接 production activation

本切片只增加 Supervisor、Lifecycle、Profile resource policy 和 contract tests，没有修改 manual Primary activation stack、`back/app.ts`、loader、API 或 legacy service。生产装配前仍需要：

- immutable plan resolver、handler/provider registry 与显式启用 manifest；
- startup ordering，确保 migration、authentication、Policy、Artifact/Secret gate 先完成；
- backlog、oldest age、phase duration、cursor stalled、manual-required 和 unavailable 指标/告警；
- admission gate，在 recovery/manual backlog 或存储异常时停止新增高风险动作；
- 有界 drain 的真实 shutdown 编排与失败审计；
- edge 实机 CPU/RSS/SQLite 写放大/断电门禁；
- PostgreSQL cluster-control adapter 与多副本竞争 contract。

## 影响

正面影响：

- 路由器只付出一只 timer 和严格有界的周期成本；
- recovery 故障不会继续扩大新的不确定副作用；
- standalone 可以在相同状态机下使用更高吞吐预算；
- keyset cursor 防止单周期无界扫描，并能跨周期继续积压；
- cluster-control/worker 误装本机 SQLite 控制面继续 fail closed。

代价与风险：

- recovery-first 意味着 recovery 存储持续失败时新动作也会暂停；这是有意的安全降级；
- cursor 只在内存保存，重启会从 due index 起点重新扫描，依赖 claim/fence 幂等；
- edge 积压收敛较慢，需要产品显示 backlog 和 oldest age；
- 当前没有 production registry/activation，代码存在不代表 Approved Action 已自动运行。

## 未选择的方案

1. **dispatcher/reconciler 各一只 timer**：小设备产生重叠唤醒和 SQLite 写竞争，拒绝。
2. **先 dispatch 后 recovery**：恢复面故障时仍扩大新副作用，拒绝。
3. **每周期清空所有页**：积压可形成无界 CPU、内存和写放大，拒绝。
4. **固定 1 秒适配所有部署**：路由器资源预算不成立，拒绝。
5. **cursor 持久化到业务表**：cursor 不是正确性事实，额外写放大和 fencing 复杂度暂不值得，拒绝。
6. **cluster-control 直接复用 SQLite lifecycle**：多副本可见性和锁语义错误，拒绝。
7. **构造时自动 start**：无法保证 migration、Policy、Secret/Artifact 和 shutdown 顺序，拒绝。

## 验证要求

- recovery phase 总在 dispatch 前；recovery list/read 失败时 dispatch 调用数为 0；
- phase page size/max pages、cursor 前进和 stalled 都有 contract tests；
- edge/standalone cadence 与预算不同，返回 policy 是深拷贝；
- cluster-control/worker 请求本机 policy 时拒绝；
- lifecycle 构造后无 timer，重复 start 不重复调度；
- 慢 cycle 不重叠，下一 timer 只在 settle 后建立并调用 unref；
- page-limit cursor 在下一周期恢复，完整周期清除 resume cursor；
- stop 清理 pending timer，并对 in-flight cycle 有硬等待上限；
- callback 抛错不形成 hot loop，非法 interval/page/timeout fail closed；
- production reachability 搜索证明 lifecycle 未被 app/loader/API/service 导入；
- Node 22 兼容门禁与固定 Node 24 目标门禁均通过。
