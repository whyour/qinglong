# ADR-0103：有界本机 Cron 调度与 Run 原子准入

- 状态：Accepted（本机 schedule state、一次性协调器、Profile cadence 与 Run 原子准入已实现；PostgreSQL/cluster 对等实现由 ADR-0104/0105 完成，物理设备长期抖动证据待完成）
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-08、D-23、D-61、D-62、D-85、D-86、D-91、D-93、D-94、D-97、D-100、D-101、D-102
- 关联 ADR：ADR-0068、ADR-0071、ADR-0087、ADR-0092、ADR-0093、ADR-0094、ADR-0098、ADR-0102

## 背景

TaskDefinition、execution revision 与 Trigger 已成为不可变、摘要绑定的正式事实，Legacy adoption 也能在一个目标事务中发布这些事实，但此前没有任何生产 Scheduler 把到期 Trigger 转换为 Run。仅有 Trigger 表不等于执行接管；若直接在内存 cron callback 中启动进程，又会丢失重启恢复、幂等和并发围栏。

该切片还必须同时服务低配路由器与本机单节点。路由器不能为调度能力常驻大依赖、无界扫描或后台 watcher；单节点则必须在进程竞争和崩溃时保持同一到期时刻最多产生一个 durable Run。

## Package 决策

不新增第 28 个 workspace package。Package 是部署、依赖或权限边界，不是每个 use case 的默认边界：

- Profile-neutral schedule contract、严格输入归一化和 cron 决策位于 `@qinglong/runtime-core/local-scheduler` 显式子入口；根入口不 re-export，未使用者不会 eager-load。
- SQLite 状态与事务 authority 位于既有 `@qinglong/local-sqlite` 的 runtime adapter。
- 一次性协调器与显式生命周期位于既有 `@qinglong/local-execution/scheduler` 子入口；它们与 dispatch 总是共同部署，但仍保持源码依赖方向。
- application 只组合上述端口，不拥有 cron 计算、SQL 或进程启动语义。

`croner@7.0.8` 固定精确版本并只在首次 cron 计算时加载。选择它是因为离线 pack 约 124 KiB 且无运行时传递依赖；曾评估的 `cron-parser` 会带入约 4.5 MiB 的 Luxon，直接突破 4 MiB Edge 制品预算。制品审计会显式拒绝启动 import closure 中出现 `croner`，防止 lazy 边界回退。

## 持久化状态

SQLite migration `0035-local-scheduler` 新增 `QingLong3LocalTriggerSchedules`，每个 Trigger head 恰有一行：

- `trigger_revision` 把状态绑定到当前 immutable Trigger revision；
- `next_fire_at_ms` 是 durable cursor，`NULL` 只表示需要初始化；
- `last_scheduled_at_ms` 记录最后一次实际准入的 occurrence；
- `state_version` 为 compare-and-set fence；
- due 与 initialize 均有独立 partial index。

新建或追加内建 `qinglong/cron@v1` Trigger 时，在同一事务计算并 upsert 下一时刻；extension Trigger 保留状态行但 `next_fire_at_ms=NULL`，在对应 scheduler provider 出现前不会进入内建 cron 候选。Legacy adoption 同样在原 publication transaction 内为每个已审 cron Trigger 写入非空 cursor，避免 100,000 行迁移后依赖低速懒初始化。

`0036-capability-v18` 把 local-control-core 推进到 contract v18，并显式声明 `local_scheduler_admission`。readiness 同时校验新表、两个索引、migration checksum、owned trigger 和精确 capability；不得通过自动建表或降低检查绕过 migration ceremony。

## 调度与 misfire 语义

协调器只提供显式 `scheduleOnce()`，核心层不创建 timer、watcher 或后台线程，因此单元测试、CLI 和未来 cluster lease scheduler 能复用同一轮次语义，而不会因 import 产生隐式常驻工作。`@qinglong/local-execution/scheduler` 另提供显式 start/stop 的 Profile lifecycle：Standalone 每 1 秒、Edge 每 5 秒执行至多一页，timer `unref`、轮次不重叠、诊断失败隔离，shutdown 等待受 5/10 秒硬上限约束。

application 只在 startup recovery、既有 execution lifecycles 与 admission 全部成功后启动 Scheduler lifecycle。shutdown 先撤销 admission，再停止 Scheduler，之后才 drain execution control、stack 与 storage，保证停止期间不会继续创建新 Run。

每轮只读取一页：Edge 为 4，Standalone 为 16，协议硬上限 256。所有时间、revision、摘要、cron、timezone 和页面形状先做严格验证。cron macro 和隐式主机 timezone 继续拒绝。

- 正常到期：准入当前 durable `next_fire_at_ms`，随后把 cursor 推进到观察时刻之后。
- `skip`：超过 Profile grace 后不创建 Run，只把 cursor 推进到观察时刻之后。
- `fire_once`：无论漏过多少 occurrence，只补偿最老的一个 durable occurrence，然后直接推进到观察时刻之后；不会扫描或回放 backlog。
- 新建 Trigger 的首次 occurrence 从激活时间开始计算；migration 遗留的 `NULL` 状态只初始化 cursor，不虚构历史执行。

Edge grace 为 30 秒，Standalone grace 为 5 分钟；全局最大值固定为 5 分钟。

## 原子 Run 准入

SQLite adapter 对每个 decision 使用 `BEGIN IMMEDIATE`，并在写入前重新读取 Project、Trigger head/revision、schedule version、Task revision 和 local execution revision。任一事实漂移都返回 `raced`，不产生部分 Run。

一次成功 admit 在同一事务内完成：

1. 创建固定 Task revision/digest、Trigger revision/digest 和 `scheduled_for_ms` 的 queued Run；
2. 创建 `local_process` claimed Attempt；
3. 追加 `run.created` 与 `run.queued` 两个事件；
4. 以 schedule revision/version/next cursor 作 CAS，更新 next/last/state version；
5. commit 后才通知现有 bounded dispatcher 执行一次 dispatch。

幂等键为 `ql3:cron:v1:<triggerId>:<triggerRevision>:<scheduledForMs>`。Scheduler 不直接 spawn，不在 callback 中拼接命令，也不把 event delivery 或内存锁当成 durable claim。

## 资源与验收证据

1. runtime-core 109/109、local-sqlite 54/54、local-execution 27/27、local-application 13/13 目标测试通过；覆盖 on-time、skip、fire-once、迁移初始化、严格上限、原子 Run/Attempt/Event、竞争重放、非重叠 cadence、诊断隔离和有界 shutdown。
2. adoption 测试要求每个已发布 cron Trigger 在同一事务拥有非空 schedule cursor，并在失败路径一起回滚。
3. 六类离线 production artifact 均通过 4 MiB、512 files、16 MiB RSS 门禁。最大为 standalone-application 2,181,590 bytes/323 files；base/adopted/application 启动闭包为 36/39/69 modules 且不 eager-load `croner`，本轮抽样最大 RSS delta 为 12,042,240 bytes。
4. ADR-0106 收敛后 importer 为 23；本切片没有新增 package、binary、watcher 或数据库连接。只有 active application 拥有一个显式、可停止、`unref` 的 Scheduler timer，base/adopted importer 仍无该 timer。
5. 23 个 QL3 importer 全量测试和 backend 669/669 回归通过；依赖/源码边界审计保持零 finding。

## 未包含

- PostgreSQL schedule claim/lease 与 cluster Run admission 已由 ADR-0105 完成，不属于本 ADR 的 SQLite 证据范围；
- interval/event/webhook/AI Trigger provider；
- Project/Task 配额和 retry admission；
- 固定物理路由设备的长期时钟跳变、休眠唤醒、抖动、写放大及断电证据；
- Legacy scheduler cutover 与旧 `ScheduleService.runTask` 下线。
- Scheduler 指标、积压告警与管理面健康投影。

在上述 Gate 完成前，本 ADR 只证明本机 cron occurrence 到 durable Run 的原子准入，不宣称 cluster scheduler 或 Legacy 全量接管。

## ADR-0218 后续修正

ADR-0218 已 supersede 本 ADR 的两个实现细节，但不改变 misfire、CAS 或 Run 原子准入：

- Croner adapter 从 `runtime-core` 移到现有 `local-execution` 部署 owner；
- SQLite Trigger append 与 Legacy adoption 不再预计算非空 cursor，而与 PostgreSQL
  一致写入 `NULL` sentinel，由首次 schedule cycle 基于原
  `triggerUpdatedAtMs` 计算并执行 initialize/skip/admit。

因此上文“adoption transaction 写非空 cursor”及对应历史验收记录只描述当时实现，
不再是当前 contract。新的实现避免 base/adopted-only、Worker 与 cluster-admin 安装
Croner；物理 Profile 资源证据以 ADR-0218 后续重跑为准。
