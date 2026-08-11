# ADR-0007：LocalProcess completion receipt 与日志存活

- 状态：Proposed
- 日期：2026-07-18
- 决策范围：本地进程跨控制面重启时的日志连续性、完成事实、timeout 恢复和有界清理
- 关联：QL-RFC-0001、ADR-0001、ADR-0003、ADR-0005

## 1. 上下文

当前 `LocalProcessExecutor` 通过父进程持有的 stdout/stderr pipe 写日志，并通过 `ChildProcess.close` 解析退出码后完成内存 Promise。正常运行时这条路径简单且能保持实时输出，但 HTTP worker 重启后存在两个不可恢复事实：

1. 内存 completion Promise、timeout timer 和 active-handle Map 消失。
2. 仍在运行的子进程虽然可以通过 durable PID identity 被证明存活，但旧 pipe 的读取者已经退出；进程随后退出时，新 worker 无法获得原始 exit code 或 signal。

仅轮询 PID 只能判断“此刻存在或不存在”，不能证明退出原因。读取日志尾部、文件 mtime 或脚本约定文本也不能作为可信完成事实。直接把这类 Attempt 标记 succeeded 会制造假成功；全部立刻标记 lost 又会丢失本可恢复的完成和日志。

协议必须同时满足：

- edge：SQLite、本地文件系统、低内存、低频扫描，无常驻重型 sidecar 和目录 watcher。
- standalone：控制面重启时本地任务可以继续运行并留下可恢复结果。
- cluster worker：完成事实可以在 Worker 断连后重放，但必须受 worker lease/fencing 约束。

## 2. 决策

### 2.1 事实所有权

- Run、RunAttempt 和 RunEvent 仍是最终业务事实源。
- 日志 Artifact 是追加写输出事实，不参与判断成功或失败。
- CompletionReceipt 是 Executor 在数据库终态提交前的本地恢复 journal，不是第二套 Run 状态表。
- PID、process group、文件存在和内存对象都只是证据，不能单独生成 succeeded。

receipt 采用至少一次发现，CompletionService 通过 Run version、Attempt 状态和 callback sequence 保证同一终态至多一次生效。

### 2.2 Spawn 前持久化

在产生本地进程副作用前，Runtime 必须为 Attempt 准备并持久化：

```text
run_id
attempt_id
executor_type = local_process
log_artifact_id
callback_token_hash
callback_sequence
deadline_at_ms nullable
```

明文 callback token 只交给本次执行包装层，数据库只存 hash。token 用于防止误关联和跨 Attempt 重放，不宣称能隔离与 QingLong 同一 OS 用户运行的恶意脚本；强安全隔离必须使用 Docker、Kubernetes 或 Remote Worker。

若持久化失败，不得 spawn。spawn 成功后仍按 ADR-0003 保存 durable handle；handle 持久化失败时执行 stop + lost 补偿，不把 receipt 当成绕过该边界的理由。

### 2.3 日志直接落盘

QingLong 在 spawn 前创建唯一日志 Artifact，规范化路径并限制在配置根目录内，文件权限默认 `0600`。stdout/stderr 直接继承该 Artifact 的追加写文件描述符，控制面不再是唯一 pipe reader。

结果：

- HTTP worker 重启不会关闭仍由子进程持有的日志 fd。
- 实时日志改为按需 tail Artifact；无订阅者时不创建 reader、timer 或额外缓冲。
- 慢 WebSocket/SSE 客户端只丢失实时推送或从 offset 续读，不能反压用户进程。
- 首版可以把 stdout/stderr 合并到同一 legacy-compatible 日志；若未来分流，必须额外记录稳定 stream/offset，不能用两个异步 pipe 猜测全局顺序。

日志文件不能承载 callback token、命令快照或环境。日志轮转和删除遵循 Artifact retention，不能因为 receipt 已消费就立即删除。

### 2.4 CompletionReceipt

执行包装层等待用户命令结束并发布固定 schema 的 receipt。首版上限 4 KiB：

```json
{
  "schemaVersion": 1,
  "runId": "uuidv7",
  "attemptId": "uuidv7",
  "callbackSequence": 1,
  "token": "opaque-random-value",
  "startedAtMs": 0,
  "finishedAtMs": 0,
  "exitCode": 0
}
```

约束：

- 只接受固定字段；未知字段、重复 JSON key、非整数时间、越界 exit code、错误 ID 或超限文件一律 quarantine，不尝试宽松修复。
- 不记录命令、参数、cwd、环境、Secret、stdout/stderr、任意用户 error text 或堆栈。
- `finishedAtMs >= startedAtMs`；数据库仍将时间钳制到 Run/Attempt 已提交时间之后。
- wrapper 被 signal 终止、磁盘写失败或文件系统不可用时可以没有 receipt；Reconciler 最终将其归类为 lost，而不是伪造 exit code。

发布步骤：

1. 在同一目录创建不可覆盖的临时文件。
2. 写入完整、有界的 canonical payload，并在实现支持时 flush 文件。
3. 通过 rename-no-replace、同目录 hard-link publication 或等价原语发布到最终 receipt 路径；目标已存在时不得覆盖。普通会覆盖目标的 rename 不满足该约束。
4. 在实现支持且资源预算允许时同步父目录元数据。

原子 publication 只保证读者看到“缺失”或完整新状态，不承诺抵抗所有断电和损坏场景。

### 2.5 CompletionService

正常 `ChildProcess.close` 快速路径和 receipt 恢复路径必须调用同一个 CompletionService。服务在单一数据库事务内：

1. 校验 Run/Attempt 关系、runtime owner、executor type、callback token hash 和严格递增的 callback sequence。
2. 读取当前 Run/Attempt；已经终态时返回 already-terminal，不追加第二个终态事件。
3. 若 Run 已有 cancel request，则按 ADR-0001 收敛为 cancelled；timeout 也是先持久化的取消意图，不能仅由进程 exit code 推断。
4. CAS Run version/event sequence，更新 Attempt 终态并追加低敏 RunEvent。
5. 提交成功后才允许标记 receipt consumed 并进入清理。

receipt 已发布、事务未提交时重启，下一轮可以重放。事务已提交、receipt 尚未删除时重放，返回 already-terminal 后安全清理。禁止先删 receipt 再提交数据库。

`next` 的实现已将原有 Orchestrator 实时 completion 切换到该服务。服务在一个 Repository transaction 中提交 Attempt 状态/sequence、Run 状态和两个有序 Event；token 使用常量时间 SHA-256 比较，错误 token、错误 sequence、非 runtime owner 或不匹配 executor type 均在写入前拒绝。timeout 取消意图已提交时，迟到的成功 receipt 收敛为 `timed_out`。receipt consumer 只在 `applied` 或一致的 `already_terminal` 后清理文件；事务失败时保留文件，清理失败时允许下次无重复 Event 地重放。对于数据库已知 Attempt，确定性的 codec/schema、token、sequence、owner 或状态错误会先持久化 `quarantined`，再将原文件以确定性 hard-link/no-replace + unlink 移入 `0700` 私有分片 quarantine；原内容不写日志，启动恢复与周期扫描只上报计数和有界相对引用。数据库/CAS/普通文件系统错误仍保留原 receipt 重试。

### 2.6 Startup 与周期 Reconciler

恢复顺序固定为：

1. 从数据库按稳定 cursor 分页读取 runtime-owned active Attempt；不得遍历整个 receipt 根目录作为主索引。
2. 若对应 receipt 存在，先校验并交给 CompletionService。
3. 无 receipt 时检查 durable process identity。
4. identity 仍运行：保持 running，并由周期 Supervisor 后续复查。
5. identity 已退出：等待短且有上限的 receipt publish grace；仍缺失则标记 `RECOVERY_PROCESS_EXITED_WITHOUT_RECEIPT`/lost。
6. identity 不支持、歧义或不匹配：fail closed，按稳定错误分类 lost 或 blocked，绝不按裸 PID 操作。

Supervisor 复用 ADR-0005 的生命周期约束：显式 start/stop、timer unref、每轮完成后再调度、无重叠、分页和页数硬上限、shutdown 有界 drain。edge 默认低频串行检查，不启动文件 watcher。

### 2.7 Timeout 与取消

内存 timeout timer 只是快速路径。`deadline_at_ms` 必须在 spawn 前持久化：

- Reconciler 发现 deadline 已过期且 Run 未终态时，先事务提交 `run.cancel_requested(reason=timeout)`。
- durable cancellation dispatcher 取得 Attempt-bound lease 后才允许 TERM/KILL。
- completion receipt 先到时由事务竞争决定：deadline 前已发布且可验证的完成可以正常收敛；已接受 timeout 意图后到达的普通完成收敛为 timed_out/cancelled 的具体映射由 ADR-0001 固定，不能由扫描顺序决定。

用户取消、策略取消和 shutdown 使用相同原则。receipt 不携带“我是被取消的”自我声明；权威取消原因来自已提交 Run 意图。

### 2.8 edge 与 cluster 映射

edge/standalone：

- 每个 active Attempt 只有一个日志 Artifact 和最多一个最终 receipt。
- receipt 目录按 Attempt ID 前缀分片，避免单目录无界增长。
- 不为每个任务启动 Node runtime sidecar；launcher 的具体实现必须经过 RSS、信号转发、架构和供应链评审。
- 在线清理器只处理 Journal 已索引的 Attempt，不遍历目录。非 Journal 文件交给独立维护任务，默认只读且不能递归盲删。

cluster worker：

- receipt/journal 保存在执行 Worker，控制面数据库不引用其他节点不可访问的本地绝对路径。
- Worker 向控制面提交 completion 时携带 worker lease/fencing token；控制面确认前 Worker 不删除 journal。
- 断线后可以重放；stale worker 的 completion 被 fencing 拒绝，不能覆盖新 Attempt。
- 日志上传到共享 ArtifactStore 时记录可续传 offset/checksum；本地日志在远端确认前不得作为唯一副本删除。

### 2.9 非 Journal 孤儿文件维护

目录 watcher、启动时全量 `readdir` 和无上限递归清理均不进入 Runtime 热路径。`next` 提供独立 `audit:receipts:ql3` 命令，契约如下：

1. 数据库使用 Node 24 defensive read-only 连接，只批量读取 `RunAttempts` 与 `CompletionReceiptJournals`，不启动 Sequelize、HTTP worker 或 Runtime lifecycle。
2. 默认从显式 shard cursor 审计 8 个十六进制分片、每分片最多 32 条；硬上限为 32 个分片和每分片 64 条。扫描使用 `opendir` 增量迭代，不读取文件内容。
3. Journal 已登记或 Attempt 仍 active 的 receipt 永不由该命令移动。未登记的 terminal/unknown receipt、临时文件和未知普通文件必须先超过 minimum age。
4. 默认模式只输出分类和 `nextShard`。只有显式 `--quarantine` 才允许将 eligible 普通文件通过同文件系统 hard-link + unlink 移到私有 `0700` `.orphan-quarantine`；不提供直接删除。
5. symlink、目录及其他非普通文件只报告 unsafe；分片目录和隔离目录必须通过 canonical root 复验，symlink escape 直接失败。分片出现第 `limit + 1` 个条目时标记 overflow，该分片本轮全部禁止移动，避免局部枚举导致误判和饥饿。
6. edge 可由低频 cron 使用 `nextShard` 轮转；standalone 或 cluster Worker 可作为节点维护 Job 执行。cluster-control 不扫描 Worker 本地路径。

该工具不把“文件不在 Journal”直接等同于可删除：active Attempt 是升级兼容保护，minimum age 是 publication/清理竞态保护，quarantine 是可恢复保护。隔离区的最终保留、人工确认和删除策略在 Artifact retention 运维面统一处理。

## 3. 不采用的方案

### 3.1 仅依赖 ChildProcess.close

父进程重启后监听器和 Promise 消失，无法恢复，拒绝。

### 3.2 仅轮询 PID 或 `/proc`

只能证明进程身份和当前存活状态，不能恢复退出码、signal 或完成时间，拒绝作为成功事实。

### 3.3 从日志尾部解析退出码

日志由用户命令控制，可能伪造、截断或缺失；日志内容也可能被 retention 修改，拒绝。

### 3.4 每个任务启动完整 Node sidecar

实现直接但会显著放大 edge 并发任务的 RSS 和启动成本，首版拒绝。若未来基准证明可接受，仍需满足同一 receipt 契约。

### 3.5 控制面监听整个 receipt 目录

文件 watcher 在不同文件系统和容器挂载上的语义不一致，也会让 edge 为禁用或空闲能力支付常驻成本。允许作为未来 best-effort 唤醒优化，但不能代替数据库索引和周期扫描。

### 3.6 receipt 直接替代数据库 Run 状态

本地文件没有 Run version、跨节点 fencing、权限和查询事务，拒绝。它只是可重复消费的 Executor 事实。

## 4. 影响

正面影响：

- 控制面重启不再必然中断本地日志，正常退出码可以在 receipt 存在时恢复。
- 正常完成和恢复完成共享事务入口，减少双写和竞态分叉。
- edge 不需要外部数据库、队列、对象存储或常驻重型 supervisor。
- cluster Worker 获得同构的 journal + ack 重放模型。

代价：

- 每个 Attempt 增加一个小 receipt 文件和若干文件系统元数据操作。
- 需要持久化 deadline，并调整 LocalProcess 的 stdio 与实时日志实现。
- launcher 的信号转发、shell/argv 语义、多架构发布和异常退出需要单独验证。
- 恶意本地脚本与控制面使用同一 OS 身份时，callback token 不是强隔离边界。

## 5. 当前孵化边界

`next` 已实现 durable process identity、启动时有界扫描、running 验证、无证明时 lost、cancel lease/fencing、manifest-gated manual Primary boot、严格 CompletionReceipt codec/原子文件 Store，以及 `0006-run-attempt-deadline` 和 `0007-completion-receipt-journal` 两个增量 schema。Primary 在 spawn 前登记 Journal，登记失败不得 spawn；启动恢复为升级前 active Attempt 幂等补登记。周期 completion scanner 已改由 Journal 驱动，所以 Run 终态后残留 receipt 仍可返回 `already_terminal` 并清理。Journal 只保存 pending/quarantined、本地相对引用和 retention 游标，不改变 Run/Attempt 聚合。终态 missing 记录按 edge 2 分钟、standalone 1 分钟清理；quarantine 按 edge 5 分钟、standalone 1 小时精确删除。timeout lifecycle 已接入 manual Primary canary：显式 start/stop、timer unref、无重叠、有界 drain、每轮固定观察时间，并按 edge（30 秒、2×8）与 standalone（5 秒、4×32）选择资源上限；cluster-control/worker 拒绝误装该 SQLite 本机栈。统一 CompletionService 已接管实时 Executor completion，spawn 前写入 token hash，receipt consumer 复用同一事务入口并通过两个 crash-window 测试。manual Primary 使用受限 POSIX launcher 和同一 `0600` append fd；正常 live cleanup、重启 replay、隔离和 purge 都会收敛 Journal。Startup Reconciler 在 identity 前和非 running 结论前消费 receipt；identity 明确 exited 且 PID 未失配时按 edge 50 ms、standalone 100 ms 再等待一次。所有周期扫描都有页大小/页数上限、跨周期 resume cursor、timer unref、无重叠和有界 stop。普通 LocalProcess pipe 与 Legacy owner 路径保持不变。

因此当前 manual Primary canary 已能在 HTTP worker 强制退出后继续写同一日志、生成可验证 receipt，并由新 worker 在启动或周期扫描中消费；确定性非法 receipt、终态残留和 retention 均有数据库索引且不依赖目录扫描。非 Journal 文件已有独立的只读优先、有界审计和显式隔离策略；代码门禁也验证了 ENOSPC 不暴露半成品，以及 receipt 存储失败不篡改用户任务退出码。固定 edge/多架构实机资源门禁和真实磁盘压力演练未关闭前，仍不得把 Primary 扩大到 boot、schedule、subscription 或默认 manual 流量。

建议实施切片：

1. 已增加不可达的 CompletionReceipt port、严格 codec、路径和原子发布 contract tests。
2. 已增加 `deadline_at_ms` 兼容 migration、Repository 映射、Primary spawn 写入与 timeout source，不修改既有 baseline checksum。
3. 已在 manifest-gated manual canary 中切换 direct-file stdio 与受限 POSIX launcher，保持 Legacy 默认路径和普通 pipe Executor 不变。
4. 已合并正常 completion 与 receipt completion 的事务服务，并加入两个 crash-window 测试。
5. timeout、Journal 驱动的 completion Supervisor、profile 化 publish grace、确定性隔离、retention 和非 Journal 运维 CLI 已接入；继续完成真实 worker crash、HTTP restart、真实磁盘压力和 edge 资源演练后再新增 rollout gate。

## 6. 验证门禁

1. HTTP worker 在任务运行中被强制退出后，任务继续向同一日志 Artifact 追加输出。
2. receipt publish 后、终态事务前崩溃，重启只生成一个终态 Event。
3. 终态事务后、receipt 清理前崩溃，重放返回 already-terminal 且安全清理。
4. 临时文件、半写、超限、未知字段、错误 token/sequence/Attempt 全部 fail closed，不改变 Run。
5. 进程已退出且 receipt 缺失时只能 lost，不能从日志或 PID 猜测 succeeded。
6. deadline 跨重启仍触发先持久化、后 signal 的 timeout 流程。
7. 取消与 completion 两种提交顺序都遵循 ADR-0001，迟到 receipt 不能覆盖已接受取消。
8. 无日志订阅者时不创建 tailer；慢订阅者不阻塞用户进程。
9. 单轮扫描、文件大小、目录分片、quarantine 和清理数量均有硬上限。
10. edge 基准验证 launcher、direct-file log 和 Supervisor 的 RSS、启动时延、磁盘写放大。
11. ARM64/AMD64 以及声明支持的 libc/架构通过 signal、exit code、断电近似和文件系统语义测试。
12. receipt、Event、审计日志均不包含命令、环境、Secret 或用户输出。
13. 非 Journal 审计默认只读，单次 shard/entry 数有硬上限；overflow、symlink、目录和 active Attempt 全部 fail closed。
14. ENOSPC 不产生可见最终 receipt；receipt publication 失败不改变用户进程原始退出码。
