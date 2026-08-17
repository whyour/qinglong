# ADR-0445：ScheduleService 执行来源的 Shadow Run 覆盖

- 状态：Accepted
- 日期：2026-08-18
- 关联 RFC：QL-RFC-0001 D-02、D-353、PR-4
- 关联 ADR：ADR-0001、ADR-0002、ADR-0003
- Amends：ADR-0002 的当前 Alpha Shadow origin allowlist，不改变 Legacy owner 或 Primary 门禁
- Follow-up：[ADR-0446](./ADR-0446-system-crond-stable-shadow-admission.md) 已完成本文保留的 `scheduled_system` 稳定准入 Gate

## 上下文

QingLong 3.0 已能旁路观察 `manual` 与 `scheduled_node` 的 Legacy ChildProcess，但
`ScheduleService.runTask` 仍是 Subscription 更新、System maintenance 和一次性 Script 的共同执行入口。三类调用都由现有
`cross-spawn` 子进程真实执行，却不创建 Run、RunAttempt 或 RunEvent；因此 3.0 的“原有任务继续运行且每次执行可观察”产品闭环只覆盖了 Cron
主路径，没有覆盖同一进程内的其他用户可达任务。

直接把 `ScheduleService` 切为 Primary 会同时影响七个调用点，并绕过仍未完成的 rollout approval、reconciliation、2.x API parity 和回滚门。
另一方面，只在 callback 或日志层推断任务又会丢失 accepted/spawn 边界，并可能把一次执行关联到错误来源。

## 决策

1. `QL3_SHADOW_ORIGINS` 的封闭 allowlist 增加 `subscription`、`system`、`script`；默认仍为全部 `off`，未知 origin 仍被忽略并记录有界配置
   计数。`scheduled_system`、`once`、`boot`、`grpc` 不因本决定自动开放。
2. `ScheduleService.runTask` 只在既有并发限制已选中任务且 `onBefore` 成功后尝试创建 Shadow accepted fact；随后把观察器附着到同一个
   Legacy ChildProcess。Shadow 路径不得调用 Executor、改变 task limit、延迟 Legacy admission 或产生第二次 spawn。
3. Shadow Run 固定 `executionOwner=legacy`、Project `default`、原 execution origin 与
   `triggeredBy=legacy:schedule-service`。task revision 只摘要业务 command 与可选 schedule；task ID 使用
   `legacy-schedule:<origin>:<25-hex>`，其中摘要输入为 Legacy caller ID。任意脚本路径、System command 或 caller ID 原文不得进入 task ID。
4. origin 未启用时，accepted factory 不执行：不计算 task/revision digest、不附加 ChildProcess listener、不加载 Repository、不写数据库，也不新增
   timer、watcher、queue 或重试。启用后只增加同一子进程的 spawn/error/exit 观察与既有有界 Shadow 写入。
5. Shadow observer 初始化、accepted 或后续持久化失败继续退化为 no-op；Legacy callback、stdout/stderr、返回 PID、完成结果和用户可见事实源均不受
   影响。`script` 的 `completionTime=start` 仍在 spawn 后返回原 PID，终态观察异步跟随同一进程。
6. 本决定不为 `scheduled_system` 伪造 accepted fact。system crond 由 Shell 在另一执行边界启动，目前只有可能重复、乱序或丢失的 status callback，
   缺少 response-loss-safe 的 accept identity；该来源必须在独立 Gate 中先建立稳定触发 ID 与幂等准入。
7. 本决定不开放任何 Primary origin，不修改 rollout manifest，也不把 Shadow Run 变成 2.x API 成功条件或执行 authority。

## 故障与恢复

- Shadow origin 未配置或拼写错误：Legacy 正常执行，不构造 fact；未知值只增加低敏配置计数。
- `onBefore` 失败：执行尚未 accepted/spawn，因此不创建伪 Run；沿用 Legacy 错误行为。
- observer 初始化或数据库写失败：观察退化为 no-op，同一个 Legacy 子进程继续执行并返回原结果。
- 子进程启动错误、非零退出或 signal：复用共同 ChildProcess observer 和 Shadow writer，分别收敛为稳定 start-failed/failed 事实；不改变 Legacy
  callback。
- 进程在 `completionTime=start` 返回后结束：已绑定的 observer 继续消费 exit；调用方无需持有 Run authority。
- 进程重启：环境 allowlist 重新读取；本决定没有 watcher，也不尝试把没有 accepted fact 的历史执行补造成可信 Run。

## 部署与资源影响

- 不新增 workspace package、生产依赖、schema、migration、SQL、Kubernetes object、端口或常驻进程。
- 默认 Edge/Standalone/路由设备路径只多一次缓存后的 origin Set 查询；accepted factory 不执行，产物依赖闭包与空闲资源不变。
- 显式启用的实例为每次匹配执行创建一个 Run、一个 Attempt 和有界事件；这是迁移观测成本，不得默认在低写入寿命设备上启用全部 origin。
- Cluster Control/Worker 和 Cluster PostgreSQL 路径不导入 Legacy `ScheduleService`，本决定不改变它们的连接、Pool 或部署拓扑。

## 被拒绝的替代方案

### 直接把 ScheduleService 切到 Primary LocalExecutor

拒绝。现阶段缺少这三类来源的正式 rollout approval、用户可见状态、2.x API parity 与回滚演练；直接替换会把观察切片变成执行 owner 切换。

### 默认观察所有 ExecutionOrigin

拒绝。默认开启会增加低配设备写入，并把尚未具备稳定 accept identity 的 system crond、boot 与 gRPC 路径错误纳入。

### 把 caller ID 或完整 command 写进 task ID

拒绝。Script ID 可能是路径，System ID 甚至可能来自命令；稳定摘要既保留同一 caller 的关联能力，也避免在 Run 索引和诊断中复制原文。

### 只根据结束 callback 补造 Run

拒绝。结束事实不能可靠证明 accepted/spawn 时间、唯一执行或 task revision；在 status retry 下还会产生重复 Run。

## 验证

- 27/27 项专项测试通过；独立真实子进程测试覆盖三类 origin、默认环境 allowlist、未启用零 fact、observer 失败开放，以及 Script
  start-completion 后的终态观察；
- SQLite 集成测试证明一个 System child 形成 legacy-owned succeeded Run、Attempt 和八个有序 Event，且 caller ID 原文不进入聚合；
- `build:back` 与完整 backend 回归通过（1,408 pass、2 条条件 skip、0 fail），18 个 QL3 package clean build/test 退出 0；
- 14/14 静态审计与 14/14 Edge/Standalone artifact 档位均 compatible；package-boundary 门证明根 `src` 只保留公共 `index.ts`，其余实现位于
  领域子目录；
- 本决定不改变数据库 schema/adapter 或 Kubernetes/容器拓扑，因此不重跑物理 PostgreSQL HA/K3s 门，也不声称产生新的部署面证据；
- `scheduled_system` 仍作为明确未完成项，不以本测试替代 Shell/response-loss/idempotency 证据。
