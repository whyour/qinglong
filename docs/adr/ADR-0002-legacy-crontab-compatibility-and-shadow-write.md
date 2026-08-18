# ADR-0002：Legacy Crontab 兼容、影子写入与切换策略

- 状态：Proposed
- 日期：2026-07-18
- 决策者：QingLong Maintainers
- 关联 RFC：[QL-RFC-0001](../QINGLONG_3_0_ARCHITECTURE_RFC.md)
- 前置决策：[ADR-0001](./ADR-0001-run-state-and-transaction-boundaries.md)
- Amended by：[ADR-0445](./ADR-0445-schedule-service-origin-shadow-run-coverage.md)、[ADR-0446](./ADR-0446-system-crond-stable-shadow-admission.md)、[ADR-0447](./ADR-0447-boot-shadow-and-non-origin-boundaries.md)、[ADR-0448](./ADR-0448-bounded-legacy-shadow-startup-reconciliation.md)、[ADR-0449](./ADR-0449-versioned-legacy-shadow-startup-difference-report-and-metrics.md)

## 1. 决策摘要

QingLong 3.0 采用按执行来源渐进切换的三态兼容模式：

    off -> shadow -> primary

- off：只执行 2.x 路径，不创建 Run。
- shadow：2.x 的 Crontab、RunningInstance、Shell 回调和日志仍是用户可见事实源；系统旁路创建 Run、RunAttempt 和 RunEvent，用于验证，不参与调度与结果判定。
- primary：Run 聚合成为事实源，2.x 字段变为兼容投影；所有外部副作用由新 Runtime 发起，Legacy 路径不得再次执行同一任务。

切换按已被入口事实证明的 manual、scheduled、boot 与内部任务 execution origin 独立进行，不允许一次性全局切换。`once`、`grpc` 等保留值只有在未来具备独立
trigger/admission identity 后才形成切换单元，不能由 schedule 或 transport 名称推导。任何单次执行在被接受时即固定 owner 为 legacy 或 runtime，运行中不得切换执行引擎。

Shadow 写入必须 fail-open：新模型写入失败只产生有界日志、指标和对账记录，不改变 2.x 的执行结果。Primary 路径在产生 spawn、派发或其他外部副作用前必须 fail-closed；只有能够证明外部副作用尚未发生时，才允许受控回退到 Legacy。

新 Runtime 通过 run_id、attempt_id、短期 callback token 和 dedupe key 关联状态。Cron ID、PID 和 log path 只用于 Legacy 兼容与诊断，不能作为 3.0 状态关联主键。

## 2. 背景

### 2.1 当前执行链事实

当前实现存在多条执行入口，但最终大量依赖 Shell 回调更新状态：

1. PUT /crons/run 调用 CronService.run，先把多个 Crontab 标为 queued，再异步调用 runSingle。
2. runSingle 经进程内并发限制后 spawn task 命令，并把 Crontab 更新为 running、记录 PID 和 log path。
3. system crontab 与 Node scheduler 都执行带 ID 的 Shell 命令；Node scheduler 外层的 runCron 本身不负责最终状态。
4. task.sh/share.sh 在开始和结束时调用 /open/crons/status。
5. CronService.status 在 running 回调时创建 RunningInstance，在 idle 回调时按 cron ID、PID 和状态更新实例，并更新 Crontab 的最近状态。
6. CronService.stop 按 Crontab PID 和命令查杀进程，随后把活跃实例标记为 stopped，并把 Crontab 恢复为 idle。
7. 为降低旧执行的迟到回调覆盖新执行，现有代码在 log path 不匹配时跳过部分 Crontab 字段更新，但仍没有稳定的运行级关联键。

关键代码位置：

    back/api/cron.ts
    back/services/cron.ts
    back/services/schedule.ts
    back/shared/runCron.ts
    back/schedule/addCron.ts
    shell/api.sh
    shell/share.sh

### 2.2 现有模型的能力边界

Crontab.status 只表达任务最近状态，无法准确表示同一任务的多个并发实例。RunningInstance 提供实例记录，但仍存在以下限制：

- 记录在 Shell running 回调到达后才创建，spawn 与记录之间有空窗。
- 重复 running 回调可能创建重复实例。
- Cron ID、PID 和 log path 无法形成跨重启、跨节点、跨 Attempt 的稳定身份。
- queued 没有独立持久化实例，服务重启时难以恢复。
- stop 与自然退出并发时，迟到回调可能再次修改 Legacy 状态。
- Crontab 修改后无法说明历史执行使用的是哪个任务版本。

因此不能让 Legacy 状态和 Run 状态长期双向互相驱动，否则会形成循环覆盖和不可解释冲突。

## 3. 目标

1. 在不改变 2.x API、CLI、Shell 和常用脚本行为的前提下验证新 Run 模型。
2. 每个执行只由一个 owner 产生外部副作用，避免双跑。
3. 允许按执行来源小步切换和快速停止扩大影响面。
4. 对重复、乱序、迟到和缺少关联 ID 的回调给出确定行为。
5. 允许 Shadow 与 Legacy 状态自动对账，并量化差异。
6. Primary 模式下继续为 2.x UI/API 提供可接受的兼容投影。
7. 保持 edge 模式的写入、内存和后台任务开销有界。

## 4. 非目标

- 本 ADR 不决定 Executor 接口和进程隔离细节。
- 本 ADR 不决定 SQLite/PostgreSQL Repository 的具体驱动。
- 本 ADR 不把历史 RunningInstance 自动伪造成完整、可信的 RunEvent 历史。
- 本 ADR 不在 Shadow 阶段替换现有 UI、日志 API 或停止 API。
- 本 ADR 不承诺把 Crontab 的单值状态无损映射为并发 Run 状态。
- 本 ADR 不允许双执行后再通过结果去重来弥补 owner 不明确。

## 5. 术语

### 5.1 Execution origin

触发执行的兼容来源：

    manual
    scheduled_system
    scheduled_node
    once
    boot
    grpc
    subscription
    system
    script

Runtime 实现可以归并内部枚举，但必须保留足够信息区分人工、定时和内部任务。

### 5.2 Execution owner

单次执行的唯一拥有者：

- legacy：现有 CronService、scheduler 或 Shell 链负责执行。
- runtime：RunService、RunQueue 和 Executor 负责执行。

owner 在接受触发时写入执行上下文，并贯穿日志、指标和回调。Feature Flag 后续变化不影响已接受的执行。

### 5.3 Compatibility projection

从 Run/Attempt 派生到 Crontab、RunningInstance 和 2.x response 的有损视图。Projection 不是 3.0 事实源。

## 6. 模式与事实源

| 模式 | 外部副作用 owner | 用户可见事实源 | Run 数据用途 | 新模型失败行为 |
| --- | --- | --- | --- | --- |
| off | Legacy | Legacy | 不创建 | 不适用 |
| shadow | Legacy | Legacy | 旁路验证与对账 | fail-open |
| primary | Runtime | Run/Attempt/Event | 调度、状态、审计 | 副作用前 fail-closed |

同一 origin 在任一时刻只能处于一个模式。配置加载失败或出现未知值时回退到 off，不能默认进入 primary。

## 7. Feature Flag 模型

建议配置结构：

    type CompatibilityMode = 'off' | 'shadow' | 'primary';

    interface RuntimeRolloutConfig {
      defaultMode: CompatibilityMode;
      origins: Partial<Record<ExecutionOrigin, CompatibilityMode>>;
      allowLegacyFallbackBeforeStart: boolean;
    }

约束：

1. 具体 origin 配置覆盖 defaultMode。
2. 3.0 Alpha 初始默认全部为 off。
3. primary 只有在 migration、状态机、Executor contract 和对账门禁通过后才可配置。
4. 配置变更必须写审计日志，包含 actor、旧值、新值和时间。
5. edge 不启动远程配置 watcher；配置刷新使用已有配置机制或显式 reload。
6. 禁止使用“数据库写失败就自动把全局模式改为 Legacy”这种隐式降级。

### 7.1 `next` Alpha Shadow 开关

当前孵化实现只开放观察型 Shadow，不通过该环境变量提供 primary：

    QL3_SHADOW_ORIGINS=manual,scheduled_node,scheduled_system,boot,subscription,system,script

- 未设置或设置为空时全部为 off。
- ADR-0447 后当前接受 `manual`、`scheduled_node`、`scheduled_system`、`boot`、`subscription`、`system` 与 `script`；未知 origin 被忽略并记录
  有界配置告警。`once` 与 `grpc` 仍是保留领域值：现有 `@once` 只是 schedule 标记，gRPC 只是传输入口，两者都不能单凭该字段推导 execution origin。
- 配置在进程内首次使用时读取；edge 不启动 watcher，变更后需要通过既有进程重启或未来的显式 reload 生效。
- 兼容观察器在实际 HTTP/gRPC worker 中按需加载；关闭时不构造 Shadow 事实或任务摘要、不增加 ChildProcess 监听器、不初始化 Repository、不创建后台任务，也不引入额外数据库写入。
- `manual/scheduled_node/boot/subscription/system/script` 只监听 Legacy 已创建的同一个 ChildProcess。`scheduled_system` 不持有 Node ChildProcess，
  只接受 system crond 显式标记后由 Shell start/finish 共用的稳定 execution ID；finish-only 回调可以幂等补齐 accepted→terminal 聚合。Shadow
  代码不得调用 Executor 或第二次 spawn；`subscription/system/script` 仅在 `ScheduleService` 已选中执行且 `onBefore` 成功后 accepted。
- 任意初始化、接受或后续写入失败都退化为 no-op，只记录不含命令、环境变量和 Secret 的稳定错误类型与有界计数。
- `bootTask` 只把启用的 `@boot` 条目以固定 `boot` origin 交给 `runSingle`；普通 HTTP/gRPC `run` 仍使用 `manual`。`@once` 不会因 schedule
  字符串被改记为 `once`，gRPC 请求也不会因 transport 被改记为 `grpc`。

该环境变量是 Alpha 兼容桥，不替代最终可审计的 `RuntimeRolloutConfig`。进入 primary 前必须改用具备配置校验、审计和 owner 固化语义的正式配置面。

### 7.2 `next` manual Primary manifest 门禁

孵化实现已提供严格的 `data/config/qinglong3-rollout.json` loader，并在 HTTP worker 接入默认关闭、按需加载的 manual Primary bootstrap：

- 文件缺失、不可读、超过 64 KiB、JSON 非法、字段未知、审批过期或 gate 缺失时返回 off，不构造或安装 router。
- `defaultMode` 固定为 off，当前只允许 `origins.manual`；Primary 不得通过环境变量、通配 origin 或隐式默认值开启。
- enabled manifest 必须记录 revision、approvedBy、approvedAtMs、expiresAtMs 和 rollbackPlanRef；审批窗口最长 30 天。
- `durableCancellation`、`startupReconciliation`、`atomicLegacyProjection`、`rollbackDrill`、`edgeBudget` 必须全部为 passed。
- ADR-0453 后 enabled manifest 还必须绑定可由 loader 独立重算的 manual capture/terminal/resource Primary gate bundle；ADR-0454 的一次性目标实例仪式进一步绑定
  exact Profile/admission 计划、原始文件摘要、短期审批、selection receipt 与 rollback intent/completion。配置选择只表示 `primary_selected`，不能冒充当前 worker
  已经完成 `selected → reconciled → activated`。
- 审计只包含 source path/hash、revision、时间和稳定判定。接受审计先于 router 安装；安装后审计失败立即调用 disposer，恢复原 owner。
- edge 不启动 watcher；当前 bootstrap 只在 HTTP worker 启动时读取一次，未来显式 reload 必须复用同一校验和审计边界。

bootstrap 接入不代表 Primary 已默认开放。文件缺失、disabled、rejected 或 `manual` 非 primary 时保持 Legacy，且不加载完整 Runtime stack、不创建 router 或 timer。只有 accepted 且全部 gate 通过的 manifest 才按 startup reconciliation、cancel lifecycle、router 的顺序激活；任一步失败都会撤销 router 并停止 lifecycle。ADR-0454 已提供部署配置写入、只读选择状态与操作回滚仪式，但首次真实目标实例执行、运行态 durable activation receipt、固定 edge 基准和 ADR-0007 的完整实机恢复仍需继续评审。

## 8. Legacy 到 Run 的身份映射

### 8.1 Task 身份

在 TaskDefinition 完成迁移前：

- legacy_cron_id 保存 Crontab 数字 ID。
- task_id 使用稳定的兼容 namespace，例如 legacy-cron:<id>。
- task_revision 由影响执行的字段生成稳定摘要，至少包括 command、schedule、task_before、task_after、work_dir、log_name、环境引用版本和 Package/Subscription 来源。
- Run 创建后保存 revision 或不可变 snapshot 引用；Crontab 后续修改不得改变历史 Run。

不得把 Run 外键设置为随 Crontab 删除级联删除。任务删除后，历史 Run 仍须可查询并展示保存的名称和摘要。

### 8.2 一次触发对应一个 Run

- 批量手动执行多个 Cron 时，每个 Cron 创建独立 Run。
- 同一个 Cron 的多实例执行各自创建独立 Run。
- API 批量请求可以使用 request_id 关联，但不创建共享生命周期的“批量 Run”。
- 自动重试在同一 Run 下创建新 RunAttempt；用户再次点击运行创建新 Run。

### 8.3 Trigger 信息

在 Trigger 表落地前，Run 仍需记录：

    trigger_type
    triggered_by
    scheduled_for_ms nullable
    request_id nullable
    legacy_schedule nullable

这些字段或受限 payload 不能包含 Secret 和完整环境变量值。

## 9. Shadow 写入规则

### 9.1 触发时

Legacy owner 接受执行后，Shadow Adapter 尝试：

1. 创建 Run，初始状态为 created。
2. 追加 run.created。
3. 当 Legacy 进入队列时转换为 queued 并追加 run.queued。
4. 创建 attempt 1，用于关联后续 spawn 与回调。

Shadow Adapter 不得：

- 改变 Legacy 是否执行。
- 等待无界重试后才返回 Legacy 请求。
- 获取会改变 Legacy 并发顺序的长时间锁。
- 把 Shadow Run ID 暴露成 2.x API 的成功必要条件。

### 9.2 启动和结束映射

| Legacy 事实 | Shadow 事实 |
| --- | --- |
| Crontab queued | Run queued |
| spawn 已获得 PID | Attempt starting；记录本地 executor handle |
| Shell running callback | Attempt running；Run running |
| Shell idle，exit code 0 | Attempt succeeded；Run succeeded |
| Shell idle，exit code非 0 | Attempt failed；Run failed |
| 用户 stop 已接受 | Attempt/Run cancelled，并记录 kill 结果 |
| 进程消失且无结束回调 | Attempt lost；由协调器决定 Run 结果 |

Shadow 转换仍必须遵守 ADR-0001。无法合法映射时追加 compat.transition_mismatch，不能强行覆盖终态。

当前 Alpha 切片对已审 Node worker origin 直接观察同一 ChildProcess 的 spawn、error 和 exit 事件，因此不依赖 Shell callback 才能形成基本终态。下述两级关联已补充 Shell callback、stop/cancel 和乱序/迟到回调；ADR-0448 又补充了监听前一次性启动恢复，ADR-0449 将其投影为 origin-bounded、版本化的差异报告与固定字段 metric batch。ADR-0450 再提供显式、只读、Profile-bounded 的闭合窗口终态审计；ADR-0451 已在 128 MiB router stress 与 256 MiB Edge release cgroup 中证明有界查询、SQLite 零增长和进程重启后的 Shadow-off 回滚。ADR-0453 不再从 2.x RunningInstance 猜测反向分母，而是在默认 Legacy bridge admission 建立 process-epoch 守恒 token，并把 capture/startup、terminal 与 resource/rollback 三类低敏 source report 打包；rollout v2 loader 会独立重算 bundle 后才允许 manual Primary。

### 9.4 `next` Alpha callback 与 stop 关联

当前实现已为 `manual` 与 `scheduled_node` 增加两级、失败开放的兼容关联：

1. 同一 worker 内使用最多 256 条 active execution 的内存注册表，保持 stop/callback 与 ChildProcess exit 的入队顺序；终态、启动失败和取消后立即移除，不启动清理定时器。
2. callback 或 stop 落到其他 worker 时，按 `legacy_cron_id + enabled origins + legacy owner + active status` 查询持久化候选；单次最多读取 64 个，超限只处理有界集合并记录 truncated，不能无界扫描。
3. 单实例匹配依次使用 opaque log artifact、PID 和唯一候选兜底。日志与 PID 各自唯一但指向不同 Run 时视为冲突；零候选、多候选和冲突都只记录 unmatched/ambiguous，不猜测更新。
4. log path 只在进程内转换为不超过 36 字符的稳定摘要；原始路径、命令和环境变量不进入关联告警。
5. stop all 取消该 Cron 的全部有界 active Shadow Run；stop instance 只在强字段或唯一候选能够确定一个 Run 时取消。
6. 取消事实在 Legacy kill 前投递；同 worker 的后续 exit 排在取消之后。跨 worker 使用持久化定位器尽力关联，任何查询或写入失败都不能阻断 kill 或改变 2.x API 响应。
7. 乱序 finished 可以从 queued/claimed 补齐 dispatching、starting、running 和终态；重复终态 callback、取消后的迟到成功 callback 不覆盖终态，也不追加重复完成事件。

ADR-0453 已补齐 manual origin 的正式 Shadow→Primary 判定契约：process-local admission/capture/failure/pending 守恒、clean-shutdown 一次性 exporter、capture/startup + terminal + resource/rollback 自包含 bundle，以及 rollout v2 loader 的独立重算。它仍不会自动启用 Primary；目标实例必须产生真实 manual canary bundle，其他 origin 也必须独立评审。后续能力不得让 edge 增加常驻 watcher 或无界内存队列。

### 9.3 Shadow 写失败

Shadow 写失败时：

1. Legacy 执行继续。
2. 写结构化错误日志和有界计数指标。
3. 若已经存在 Run，尽力追加 compat.shadow_write_failed；数据库不可用时不做无界内存缓存。
4. 对账器可以在数据库恢复后标记缺失或不完整记录，但不得伪造未知的精确时间和事件顺序。
5. Shadow 完整率低于门禁时禁止进入 primary。

## 10. Primary 执行规则

### 10.1 触发接受

Runtime owner 必须先完成以下持久化事务，再进入队列或 spawn：

1. 创建 Run 和 run.created。
2. 将 Run 转换为 queued 并追加 run.queued，或以等价的单事务命令完成。
3. 写入唯一 idempotency key 或 trigger delivery key。
4. 确认事务提交成功。

事务失败时不得 spawn。API 返回稳定错误，定时触发记录 delivery failure 并按 Trigger 策略重试。

### 10.2 外部副作用边界

以下任一事件发生后都视为外部副作用可能已发生：

- 调用 Executor.start。
- spawn 返回结果未知或超时。
- 已向 Worker 发送可接受的派发请求。
- 已把执行消息提交到外部队列。

进入该边界后禁止自动回退到 Legacy，因为无法证明不会双跑。系统必须把 Attempt 标记为 failed 或 lost，并交由协调器处理。

### 10.3 有限 Legacy 回退

只有同时满足以下条件，才允许 allowLegacyFallbackBeforeStart：

- 错误发生在外部副作用边界前。
- 该执行尚未创建 claimed/starting Attempt。
- idempotency key 明确属于本次触发。
- 回退决策写入审计日志；若 Run 数据库可用，追加 compat.legacy_fallback。
- Legacy 接受同一 request/delivery key，避免重复回退。

默认值为 false。Beta 前是否保留该选项由运行数据决定。

## 11. 回调关联与幂等性

### 11.1 新回调信封

Primary Runtime 启动 Shell 时注入：

    QL_RUN_ID
    QL_ATTEMPT_ID
    QL_CALLBACK_TOKEN
    QL_CALLBACK_SEQUENCE

推荐回调信封：

    interface AttemptCallback {
      runId: string;
      attemptId: string;
      token: string;
      sequence: number;
      event: 'started' | 'heartbeat' | 'finished';
      pid?: number;
      logRef?: string;
      exitCode?: number;
      occurredAtMs: number;
    }

每个回调生成稳定 dedupe key，例如 <attempt_id>:<sequence>:<event>。重复回调返回已提交结果；小于已提交序列的迟到回调只记录受限诊断，不修改终态。

### 11.2 Legacy 回调

不包含 Run/Attempt ID 的旧回调：

- 在 off/shadow 模式继续更新 Legacy 状态。
- Shadow Adapter 可以按 cron ID、PID 和 log path 尝试关联，但只有唯一候选时才更新 Shadow Run。
- 存在零个或多个候选时记录 compat.unmatched_callback，不能猜测。
- 在 primary 模式，新 Runtime 发起的执行必须携带新信封；缺少信封视为协议错误。
- 非 Runtime 发起的旧任务仍按其固定 owner 走 Legacy，不得写入任意 Primary Run。

### 11.3 Token

Callback token：

- 仅授权更新一个 Attempt。
- 使用高熵随机值，数据库保存哈希或可轮换验证材料。
- 有明确失效时间，Attempt 终态后只允许幂等重放已接受事件。
- 不写入普通日志、RunEvent payload 或进程列表可见的命令参数；优先通过受限环境或本地凭据文件传递。

## 12. Compatibility Projection

### 12.1 单向投影

数据方向固定：

    shadow: Legacy -> Run shadow facts
    primary: Run facts -> Legacy projection

禁止同一 execution 同时启用两个方向，禁止用 Crontab watcher 反向覆盖 Primary Run。

### 12.2 Crontab 投影

Primary 模式下，2.x 字段按以下规则投影：

| Legacy 字段 | 投影规则 |
| --- | --- |
| status | 有 active Run 时按 running 优先于 queued；无 active Run 时为 idle |
| pid | 最近启动且仍 active 的本地 Attempt PID；远程执行为空 |
| log_path | 最近用户可见 Run 的兼容日志路径 |
| last_execution_time | 最近 Run started_at，保持 2.x 时间单位契约 |
| last_running_time | 最近终态 Run 的 duration 投影 |

Crontab 无法表达 succeeded、failed、cancelled 和并发实例，因此不能用于 3.0 结果查询或恢复。

### 12.3 RunningInstance 投影

- 每个本地或可表示的 Attempt 投影一个 RunningInstance。
- 保存稳定的 run_id 和 attempt_id 扩展列后，更新必须按这些 ID 完成。
- 旧 API 返回结构保持兼容，新增字段必须是可选字段。
- 远程 Worker 没有可用 PID 时 PID 为空，停止由 Executor handle 完成。

当前 `0003-running-instance-run-reference` migration 已增加 nullable `run_id`、`attempt_id`，建立 `(run_id, started_at)` 查询索引与 `attempt_id` 唯一索引。旧行保持 null，旧 API 无需提供新字段。孵化实现已经增加 Primary 专用的组合 Repository：它跟踪同一事务内变更的 Run/Attempt，在提交前按 `attempt_id` 幂等投影 RunningInstance，并按“running 优先于 queued、无 active Run 时 idle”聚合 Crontab。任一投影参与者失败时，Run、Attempt、Event 与 Legacy projection 一起回滚；Shadow Repository 不注册该参与者。

### 12.4 事务边界

当 Run、Event 和 Legacy projection 位于同一控制面数据库时，状态转换和必要的兼容投影应在同一事务完成。投影失败不得提交一个对 2.x API 不可解释的 Primary 状态。

若未来 projection 跨存储，必须使用 transactional outbox 和幂等消费者；不能在事务提交后仅做一次 best-effort 更新。

### 12.5 `next` manual Primary 孵化装配

当前 manual 入口已经具备一个默认关闭的 owner seam：未安装 `ManualPrimaryExecutionRouter` 时继续执行原 Legacy 路径；显式安装且 rollout policy 将 manual 判定为 primary 后，`runSingle` 只调用 Runtime，不再创建 Legacy ChildProcess。真实本机装配由 Primary 专用组合 Repository、LocalProcessExecutor、受限日志适配器和 ManualPrimaryRuntime 组成；严格 manifest loader 与可回滚 assembly 也已存在，但生产 boot 不调用安装入口，因此仍不可由部署配置启用。

约束：

- boot 虽复用 `runSingle`，不参与 manual owner seam。
- Runtime 一旦被选为 owner，准备日志、创建 Run 或 Executor 启动失败均 fail-closed，禁止回落到 Legacy 再次 spawn。
- 新触发 owner 与 in-flight owner 分离；关闭新触发不应卸载仍持有 active handle 的 Runtime。
- stop all/stop instance 优先按进程内 Run/Attempt owner 调用 Executor。数据库中存在 `attempt_id`、但当前 worker 无法证明 ownership 时拒绝 PID-only stop，等待跨 worker cancel 或 Reconciler 能力。
- 该装配不等于 Primary rollout Gate 已通过；正式启用仍需要可审计配置、跨 worker cancel、重启后 supervisor、固定 edge 预算和回滚演练。

## 13. Stop 与迟到退出

### 13.1 Shadow 模式

Legacy stop 行为不变。Shadow Adapter 观察 stop 结果：

- 能唯一关联时，将对应 Attempt/Run 转为 cancelled。
- Shell 后续 exit callback 只能追加 late callback 诊断，不能把 cancelled 改为 succeeded/failed。
- kill 失败与状态更新失败分别记录，不把“数据库已 stopped”等同于“进程一定已退出”。

### 13.2 Primary 模式

1. Cancel command 在同一事务读取 Run/Attempt，使用 Run version/CAS 写入首次 `cancel_requested_at_ms`、受限 reason 和 `run.cancel_requested`；此时不提前把实际进程标记为已退出。
2. 事务提交成功后才允许 Executor 执行 cancel/kill；提交失败不得发送 signal。
3. 重复取消不追加第二个请求事件，但可以幂等重试 stop；stop 失败保留 durable request，由 Reconciler 继续检查。
4. Attempt 终态先提交时，取消返回 already-terminal 且不发送 signal；取消请求先提交时，迟到 exit code 0 或其他非 cancel 完成结果收敛为 cancelled。
5. 实际完成后 Attempt/Run 转为 cancelled，并由同事务 Projection 更新 RunningInstance；kill 结果和后续核验事件不得包含原始命令、环境或 Secret。

2.x /crons/stop 仍可返回兼容响应，但内部语义是异步 cancel，不承诺响应时进程已退出。

当前 manual 孵化实现已覆盖独立 durable cancel command、stop-before-signal、首次请求幂等、cancel/complete 获胜裁决、待取消 Run 的有界恢复查询、最多 64 条一页的 cross-worker source、独立 dispatch lease/fencing Repository、指数退避、低敏结果 Event、单周期有界 supervisor、Linux durable handle 身份复验与 TERM/KILL controller、进程内 active handle stop 路由、Attempt 终态投影与 stop/prepare 竞争时的 abort。HTTP worker 已接入轻量、默认不激活的 manifest bootstrap：只有 accepted 且 manual=primary 才惰性加载真实 stack，先完整有界 Reconcile，再启动 cancel lifecycle 和安装 router；失败自动撤销，shutdown 先停止 router/lifecycle。ADR-0007 的 completion/log supervisor 仍未完成；找不到可证明的 owner/handle 时不会用 PID 猜测补偿。

## 14. 修改、删除与历史

### 14.1 运行中修改 Crontab

Run 使用创建时的 task revision/snapshot。更新 Crontab 只影响后续 Run，不修改正在排队、运行或已结束的 Run。

### 14.2 删除 Crontab

- 删除不级联删除 Run、Attempt、Event、日志或审计记录。
- active Run 默认继续使用 snapshot；若产品选择“删除即取消”，必须作为显式、可审计命令实现。
- v2 API 删除响应不因历史 Run 保留而改变。

### 14.3 历史导入

3.0 首次升级不自动把所有 RunningInstance 伪造成完整 Run。可以提供独立、可重跑的 import 工具，生成标记为 legacy_import 的只读记录，并明确：

- 原始时间精度和状态可能不完整。
- 不生成没有证据的中间事件。
- import 记录不参与调度、重试和资源计费。

## 15. 启动与恢复

### 15.1 off/shadow

Legacy 启动归一行为保持。HTTP worker 在归一之后、Primary activation 与 listen 之前运行一次 Shadow Reconciler：

- 使用 `(created_at_ms, run_id)` keyset，只扫描 enabled origin 的 queued/dispatching/running legacy-owned Run；单页最多 64。
- 每个 Cron 最多读取 8 条 RunningInstance，只有唯一 PID/log/实例终态证据才补齐 succeeded/failed/cancelled；冲突与截断保持 ambiguous。
- Node worker-owned dispatching/running 在 owner 重启且无终态证据时标记 lost；queued/claimed 收敛为 abandoned cancellation。
- scheduled_system 无终态证据时保持 pending，等待稳定 execution ID callback，不把 HTTP worker 生命周期误当成 system crond 生命周期。
- edge 每次启动最多 `8 × 1 page`，standalone 最多 `32 × 4 pages`，不启动 timer/watcher；cluster-control/worker 拒绝本机 SQLite 装配。

### 15.2 primary

启动时不得像 2.x 一样把所有 Run 批量重置为 idle。系统按 ADR-0001 协调 dispatching/running/lost Attempt，并通过 Executor handle、Worker lease 和 callback 序列恢复。

## 16. 对账与可观测性

### 16.1 对账维度

Shadow 阶段至少记录：

    shadow_run_create_total
    shadow_run_create_failed_total
    shadow_callback_unmatched_total
    shadow_transition_mismatch_total
    shadow_terminal_mismatch_total
    shadow_transition_lag_ms
    shadow_active_run_delta
    legacy_fallback_total

标签必须有界，只允许 origin、profile、executor type 和错误分类；禁止使用 cron ID、run ID、command 或用户名作为指标 label。

### 16.2 终态对账

终态对账比较：

- Legacy RunningInstance status/exit code。
- Shadow Run/Attempt terminal status/exit code。
- start/finish 时间是否在允许误差内。
- 日志引用是否存在。
- 是否发生重复执行或缺失 Run。

差异记录保存受限摘要和关联 ID，不复制完整命令、环境变量或日志内容。

## 17. Rollout 顺序

    1. Schema only
    2. manual shadow
    3. scheduled_node shadow
    4. scheduled_system shadow
    5. boot shadow
    6. future source-proven trigger shadow（只有独立 once/grpc trigger 存在时）
    7. manual primary for opt-in users
    8. manual primary default
    9. scheduled_node primary
    10. scheduled_system primary
    11. remove Legacy as execution owner

每一步必须独立通过门禁，不能因为 manual 路径稳定就直接切换 scheduled/system crontab。

## 18. 进入 Primary 的门禁

一个 origin 进入 primary 前必须满足：

1. Shadow 完整率达到维护者接受的阈值，并公布测量窗口。
2. 没有未解释的重复执行。
3. terminal status 和 exit code 对账达到阈值。
4. stop/exit、重复 callback、乱序 callback 和重启场景测试通过。
5. 关闭 Feature Flag 后新触发立即回到 Legacy，已有执行保持 owner 不变。
6. edge 基准的额外 RSS、写放大和启动时间处于预算内。
7. 新 migration 从支持的 2.x 数据库升级、备份恢复和重复执行通过。
8. 2.x API、CLI、Shell 和 UI 契约测试通过。
9. 日志与指标不泄漏 callback token、Secret 或完整命令敏感参数。

## 19. 回滚策略

### 19.1 Shadow 回滚

将对应 origin 设置为 off 即可。已有 Shadow Run 标记为验证数据，不需要驱动 Legacy；不得删除以掩盖差异。

### 19.2 Primary 回滚

- 配置变更只影响新触发。
- 已由 Runtime 接受的 Run 继续由 Runtime/Executor 完成或取消。
- 禁止把 in-flight Run 重新提交给 Legacy。
- Legacy 投影保持到所有 Primary Run 终态。
- 若 Runtime 完全不可用，管理员只能执行显式、带风险提示的恢复操作；系统不得自动双跑。
- 数据库 migration 默认 forward-only；应用回滚必须能忽略新增表和可空扩展列。

## 20. Schema 对后续 PR 的要求

PR-1 至少需要支持：

- Run 的 legacy_cron_id、trigger_type、task_revision、status、version、时间字段和 idempotency key。
- RunAttempt 的 attempt number、status、executor identity、PID/handle、时间与 exit code。
- RunEvent 的 sequence、dedupe key、actor、attempt reference、受限 payload 和时间。
- 必要唯一索引和查询索引。
- Legacy 表新增 run_id/attempt_id 时必须可空，不破坏旧版本读取。
- 所有新增表和列通过显式、可重跑、带 checksum 的 migration 创建。

PR-1 只建 schema 和 Repository contract，不修改 CronService、Shell 或调度执行路径。

## 21. 被拒绝的方案

### 21.1 一次性替换所有运行路径

手动、system crontab、Node scheduler、once、boot、gRPC 和内部 ScheduleService 的生命周期不同，一次切换无法隔离风险，也无法快速回退。

### 21.2 永久双向同步

Crontab 单值状态无法无损表达并发 Run。双向同步会形成循环、迟到覆盖和不可解释的冲突。

### 21.3 以 PID 作为 Attempt ID

PID 会复用、仅在单机有意义、spawn 前不存在，也不能跨 Worker 或容器稳定关联。

### 21.4 Shadow 写失败阻断 Legacy

Shadow 的目的就是观察，不应改变生产执行结果；阻断会让验证机制成为新故障源。

### 21.5 Primary 失败时无条件回退 Legacy

在 spawn/派发结果不明确时回退会导致重复执行，任务可能包含通知、支付、删除等不可逆副作用。

### 21.6 全量历史自动回填

Legacy 数据没有完整事件顺序和稳定关联，自动构造会制造虚假的审计精度并增加 edge 升级成本。

## 22. 影响

### 正面影响

- 可以用真实 2.x 流量验证新状态机，而不立即切换生产事实源。
- 执行 owner 明确，降低迁移期间双跑风险。
- Run ID 和 Attempt ID 消除 PID/log path 猜测。
- 回滚只影响新触发，in-flight 行为可解释。
- 兼容投影为 UI/API 渐进迁移提供窗口。

### 负面影响

- Shadow 阶段增加数据库写入和对账复杂度。
- 一段时间内需要维护 Legacy 与 Runtime 两套读取模型。
- 旧 Shell 回调无法提供强关联，只能有限对账。
- Primary 兼容投影仍是有损的，2.x UI 看不到完整并发与终态语义。

## 23. 验证场景

实现必须覆盖：

1. manual off 不创建 Run，2.x 行为不变。
2. manual shadow 新模型写失败时 Legacy 仍只执行一次。
3. 批量 manual 为每个 Cron 创建一个 Run。
4. 同一 Cron 并发两次时两个 Run/Attempt 不串回调。
5. 重复 running/finished callback 不重复创建 Attempt/Event。
6. finished 先于 running 到达时按协议拒绝或记录 mismatch，不回退终态。
7. stop 与 exit code 0 并发时 cancelled 不被覆盖。
8. spawn 返回未知时不自动 Legacy fallback。
9. Feature Flag 从 primary 改为 off 后，旧 Run 继续由 Runtime 完成，新触发走 Legacy。
10. Crontab 在 Run 中途修改或删除时，历史 Run snapshot 不变。
11. 重启后不把 Primary Run 批量重置为 idle。
12. edge 上 Shadow 写入与对账保持有界。
13. v2 status/log/instances API 在兼容窗口内保持契约。
14. callback token 不出现在普通日志和 RunEvent payload。

## 24. 接受标准

- 明确接受 off/shadow/primary 三态模型。
- 明确接受按 origin 而非全局一次切换。
- 明确接受单次 execution owner 固定且禁止中途切换。
- 明确接受 Shadow fail-open、Primary 副作用前 fail-closed。
- 明确接受 Run/Attempt ID 为强关联，PID/log path 仅作兼容诊断。
- 明确接受 Primary 到 Legacy 的单向有损投影。
- 明确接受 in-flight Primary Run 不因回滚而重新提交 Legacy。
