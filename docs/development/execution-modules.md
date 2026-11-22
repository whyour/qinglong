# 执行链路的模块边界

业务实现统一位于 `back/cron`，按调度、执行、结算和查询分组，保持现有 API、CLI 和服务方法的调用约定。

```text
back/cron/
├── scheduling/   # 路由、规则发布、表达式、计划审计和调度就绪
├── execution/    # 入队、启动、停止、进程身份与等待队列
├── settlement/   # 回执核实、冲突处理和统计入账
├── queries/      # 历史、日志、展示投影及调度诊断
├── compatibility/ # 旧客户端、Shell 上报和升级实例接管
├── history.ts    # TriggerHistory 组合入口及保留策略
├── schema.ts     # 触发历史表、索引和已有结构升级
├── identity.ts   # 执行标识和回执时间
└── types.ts      # 共用类型
```

内部代码和测试直接导入 `back/cron` 下的所属模块，不增加统一的 `index.ts` 聚合入口。原 `back/shared` 下的 19 个历史转发，以及本轮新拆模块在中间目录的转发均已移除；后端内部模块的旧导入路径不再提供兼容。`back/services/cron.ts` 保留服务入口；API、数据模型和调度进程入口仍位于各自的层级目录。

`back/shared/managedExit.cjs` 保留为 supervisor 独立启动的回执进程入口，不再作为库导入。回执格式、持久化、目录锁和安全回收位于 `back/cron/settlement/exitReceipt.cjs`；该模块只依赖 Node 内置模块，不加载服务、数据库或历史协调器。执行模块同时维护源码和编译产物中的 supervisor、回执脚本路径。目录迁移不改变文件格式、事务、状态判断或重试策略。

移除内部文件路径不改变现有 API、CLI 或 HTTP/gRPC 上报协议。直接导入旧后端模块的自定义代码需要改用 `back/cron`；已编译代码对应 `static/build/cron`。独立回执进程根据 `cron/history.js` 判断是否加载编译产物。源码目录迁移后需一并清除旧 `.js` 和 `.js.map`，TypeScript 构建不会主动删除这些残留文件；正常升级会停服、替换整个 `static` 目录并在失败时回滚。

| 模块 | 当前职责 |
| --- | --- |
| `back/cron/queries/triggerQueries.ts` | 按任务和触发 ID 查询历史、游标分页、延迟指标及调度审计聚合 |
| `back/cron/queries/cronViews.ts` | 任务展示状态、当前日志所属触发的 SQL 投影 |
| `back/cron/queries/cronLog.ts` | 按任务、触发或实例读取日志；文件切换、增量读取和日志列表 |
| `back/cron/types.ts` | 触发来源、状态和历史记录类型 |
| `back/cron/identity.ts` | 执行标识转换、计划槽位 ID 和回执时间解析 |
| `back/cron/scheduling/cronScheduling.ts` | Node/system 路由、特殊任务识别、三种执行入口共用的命令格式、Node 注册参数 |
| `back/cron/scheduling/systemCron.ts` | 生成系统规则文件，暂存计划、安装和确认，以及发布失败后的就绪状态与保存标记处理 |
| `back/cron/execution/cronExecution.ts` | 手动与开机执行提交、进程启动、终态回报、批量及单实例停止、待完成停止恢复 |
| `back/cron/execution/triggerLifecycle.ts` | 持久化入队、认领、实例绑定、停止请求、终态状态迁移和工作进程中断恢复 |
| `back/cron/execution/cronLimit.ts` | 每个进程内共享的定时与手动队列、并发配置、重复执行预算及等待取消 |
| `back/cron/queries/queueDiagnostics.ts` | 队列占用采样、等待原因和排队诊断查询 |
| `back/cron/settlement/triggerSettlement.ts` | 退出回执核实、冲突记录与撤销、实例结算、统计入账和提交后的证据清理 |
| `back/cron/settlement/exitReceipt.cjs` | 独立于服务与数据库的回执校验、持久化、扫描和安全回收 |
| `back/cron/settlement/cronStatistics.ts` | 统计认领与每日聚合写入，沿用结算方传入的事务和保留条件 |
| `back/cron/compatibility/legacyClient.ts` | 无触发 ID 的旧上报、带 ID 的 Shell 上报、实例关联和升级对账 |

`TriggerHistory.visibleTriggers/recent/metrics` 和 `CronService.log/logs` 保留现有方法签名，转发给读取模块。触发类型和 `slotId` 仍由 `back/cron/history.ts` 重导出。新查询调用可直接使用 `new TriggerQueries(database)`，无需依赖执行生命周期类。日志读取模块接收已有的任务查询函数，沿用任务不存在时的行为。

查询模块只解释已经保存的证据。`unknown/restart`、待核实退出和冲突回执继续隐藏尚未确认的退出码与结束时间。日志的 `completed` 表示日志读取状态，不能用来判断脚本执行成功；执行结果仍来自触发记录。指定 `triggerId` 后，即使记录被清理，也不会回退到其他执行的日志。

任务状态和当前日志归属仍通过同一条 SQL 读取。审计仍使用原有数据库快照；历史排序、分页、指标口径和日志游标均沿用现有实现。

## 依赖方向

服务层组合 `cron` 能力，执行模块通过显式的 host 接口接收服务回调，不导入服务实现。通用 `shared` 库不反向导入 `cron` 或 `services`。`shared/managedExit.cjs` 是独立进程入口这一例外：它组合回执存储与历史结算，但不会被后端模块导入，也不提供转发导出。

`CronLimit` 保持每个进程一个实例，HTTP 手动执行、定时执行及并发设置使用同一个所属进程内的队列。`shared/pLimit.ts` 仅管理订阅、系统、脚本和依赖安装等通用队列，不再加载任务队列、数据库配置或通知服务。重复执行告警继续通过原 gRPC 客户端发送，排队去重、取消与占用采样不变。

数据库迁移由 `back/data/schemaMigrations.ts` 组合，直接调用 `cron/schema.ts` 的建表与升级逻辑，无需加载执行协调器。`history.ts` 继续导出同一个安装函数，迁移 ID、SQL 顺序与外层事务不变。通用文件存在检查与文件锁位于 `shared/utils.ts`，`config/util.ts` 保留原导出并复用实现，消除两者相互加载。

通知服务通过 `back/data/notificationSettings.ts` 读取已保存的通知配置，不再反向依赖用户服务；原查询条件、缺失配置错误、空配置回退及显式配置覆盖规则不变。类型引用不计为运行时依赖。回归检查 TypeScript 编译后实际产生的本地导入及字面量 `require()`，覆盖循环依赖、模块边界和独立回执进程加载。

## 调度适配

`CronService` 保留路由和命令构造的转发入口。创建、更新、启用和启动恢复使用同一个 `nodeCron` 构造注册参数，继续携带补跑时间窗、等待上限、跳过积压和定义版本。`QL_SCHEDULER` 的覆盖行为、crond 探测，以及扩展表达式和特殊任务的路由规则保持原样。

`SystemCronAdapter.publish` 在调用方已有的调度变更锁内工作。系统模式依次暂存计划、写 `crontab.list`、执行 `crontab` 安装、确认计划；Node 模式暂停系统审计覆盖并更新兼容文件，不安装系统 crontab。失败仍返回 503 并使调度器失去就绪状态；系统模式下原先受影响的任务会被标记为未保存，gRPC 进程继续发送安装失败通知。服务仅在发布成功后确认本次操作实际注册的任务。

Node 定时器的批量校验、停止态预构造、注册顺序和补跑仍由现有 `back/schedule/addCron.ts`、`registeredPlans.ts` 承接，并进入 `runCron`。系统 crond 保留 `system-cron.sh` 和 `back/bootstrap/systemCron.ts` 的启动及回执协议。手动和开机任务继续通过 `CronService.run/runSingle` 的原事务与队列；适配层不增加启动、重试或结算逻辑。

Node/system 切换时移除旧规则、登记新规则以及失败回滚的次序仍由 `CronService` 协调。命令中的 `QL_CRON_REVISION`、`real_time`、`ID`、前后置脚本、工作目录和日志路径保持原格式，系统规则仍携带派发时间和规则文本。

## 执行生命周期

`CronService.run/stop/stopInstance/resumePendingStops` 与原 `runSingle` 入口转发给同一个 `CronExecution` 实例。单实例停止和批量停止的进行中请求缓存随该实例保留，单次请求不会创建新的去重缓存。原有任务查询、命令构造和调用入口通过 `CronExecutionHost` 接口连接，避免模块反向导入服务类。

`TriggerHistory` 的生命周期方法保留原参数和默认值，转发给 `TriggerLifecycle`。Node 调度、手动执行和系统 crond 继续使用同一套入队去重、启动认领、停止标记和终态写入条件。只有尚未启动且因重启跳过的记录允许恢复入队；已进入 `unknown` 或已有终态的触发不会被重复执行。

事务边界保持原样：手动提交在同一事务内保存触发记录与队列令牌，提交成功后才派发进程；停止批次在立即事务内捕获实例快照与取消队列；配置版本检查和启动认领在同一事务内完成。调用方传入的事务直接传递到状态写入，不另行提交。

停止目标树仍在发送信号前持久化。重复停止使用原实例和原批次快照，后续产生的执行不会被纳入旧请求。退出证据结算失败时，事务内的状态写入回滚，事务外已保存的目标树继续保留供重试。

`TriggerLifecycleEvidence` 明确连接四项现有证据处理：停止前核查退出、结算命令退出、恢复脚本入口时间、重放已发布回执。需要写入的回调接收当前事务，保持状态、实例和统计一致提交。进程身份失效时仍提交 `unknown/restart` 给证据处理，不推测成功；工作进程中断时先重放证据，再处理尚在排队或运行的记录。

## 退出证据与结算

`TriggerSettlement` 聚合回执核实、冲突处理、实例结算和统计入账，并实现 `TriggerLifecycleEvidence`。它通过 `TriggerSettlementLifecycle` 接口使用原有 `finish` 和 `shouldStop` 条件，不反向导入 `TriggerHistory`。文件格式核验与安全回收复用 `exitReceipt.cjs`，统计认领和每日聚合继续复用 `cronStatistics.ts`。

`TriggerHistory.complete/retryPendingExits/replayPublishedExits/recordShellResult` 保留原签名。生命周期与旧 Shell 适配传入的事务继续用于同一组状态和结算写入。旧客户端上报、实例关联和升级对账由兼容适配层承接；保留策略清理仍在 `TriggerHistory`，`countExpired` 与 `deleteExpired` 继续共用保留条件。

所有已验证的版本 1 回执具有相同证据权重，不因文件路径不同而优先采信。退出码、信号或结束时间冲突时，保留冲突记录，并只撤销该执行实际记入的统计贡献；同日其他执行、固定最大耗时和已删除的统计日不受重复回放影响。旧格式回执仍需独立观察相互印证；损坏或缺失的证据不能把未知结果推断为成功，也不会触发自动重跑。

状态、实例、冲突记录、统计认领及每日计数保持在同一事务中。停止目标树尚未核实结束时，退出结果继续暂存，不能提前完成实例结算。回执清理仍注册在原事务的 `afterCommit` 中，并再次读取独立的已提交快照；即使 Sequelize 在 COMMIT 失败后调用该钩子，也不能删掉唯一的持久化结果。重复回执和重启回放沿用原有去重条件。

## 旧客户端兼容

`LegacyClientAdapter` 负责 `shellReport`、`reportLegacy`、`reportInstance`、`recordShellResult` 和 `reconcileInstances`，`TriggerHistory` 保留这五个公开入口及原参数、默认值和返回值。适配层通过 `LegacyClientLifecycle` 和 `LegacyClientSettlement` 接收已有模块的能力，不反向导入历史门面。

无触发 ID 的回执继续按任务、PID、启动秒和日志路径生成同一个标识；已绑定到 supervisor 的旧 Shell 上报仍归属于原受管命令。带 ID 的上报保持原有来源识别、历史保留条件及开始与结束乱序处理。已结束的旧执行不能抢占新实例，未知结果不能因重试开始上报或成功的 wrapper 退出而变为成功。

`shellReport` 沿用调用方事务，其余原有事务入口继续在适配层开启同样的事务。实例关联、任务摘要、状态更新和统计认领共享该事务；失败时一起回滚，重试不会重复计数。升级对账继续接管未关联的旧实例，保留已入账的历史结果和待完成停止请求，不启动任何执行。

验证包括只读 SQLite 下的历史与诊断查询、未知和冲突结果的投影、同时间戳分页，以及现有恢复、结算、日志和运行回执回归。CLI 的等待和指定触发日志继续复用同一组接口。

调度回归覆盖扩展与旧版表达式的路由、队列策略、发布各阶段失败、保存标记、变更锁、失败回滚、恢复替换、命令协议、手动执行和运行回执。路由测试通过真实服务转发到适配模块执行，避免从服务源码截取实现片段。

生命周期回归包含直接调用新模块的事务回滚、重启去重和结算失败注入，以及现有并发停止、持久化停止重试、PID 身份、启动门控、短进程退出、日志存活、退出证据恢复与历史清理测试。

结算模块回归直接组合 `TriggerLifecycle` 与 `TriggerSettlement`，覆盖调用方回滚、实际 COMMIT 失败后的证据保留、重建模块后的重复回放、退出码与时间冲突的精确撤销，以及损坏回执从未知到可靠结果的修复。现有回归继续验证旧客户端、跨日修正、历史清理、磁盘故障和多进程恢复。

兼容适配层回归直接组合适配层、生命周期和结算模块，覆盖调用方回滚、统计写入失败回滚、重复和乱序回执、PID 复用后的新实例保护、先退出后启动、未知结果的可靠结算，以及升级对账不重复入账和不清除待停止实例。
