# ADR-0021：Worker Execution Offer Inbox 与启动崩溃恢复

- 状态：Proposed
- 日期：2026-07-18
- 关联：QL-RFC-0001、ADR-0003、ADR-0012、ADR-0013、ADR-0014

## 上下文

ADR-0014 已让控制面从 Run Lease 恢复稳定 `offerId`，但“控制面可以重复投递”不等于“Worker 可以安全重复接收”。如果 Worker 只用内存 Map 去重，进程重启后仍会出现以下风险：

1. offer 已收包，但 starting ACK 尚未提交；
2. starting ACK 已提交，但 Worker 尚未调用 Executor；
3. Worker 正在调用 Executor，无法确认 spawn 是否发生；
4. Executor 已返回稳定 handle，但 running ACK 丢失；
5. 相同 `offerId` 被错误地复用到不同 `ExecutionSpec` 或 Worker Session。

低配路由设备不能为每个任务增加 Node sidecar，也不应为了 inbox 强制部署 PostgreSQL、Redis 或另一个 SQLite 连接；集群 Worker 又必须与 edge 使用相同的幂等和 fencing 语义。因此接收状态机需要与 transport、数据库和部署规模解耦。

## 决策

### 1. Worker 在任何 spawn 前持久化 offer 状态

Worker 的处理顺序固定为：

1. 认证 transport 将消息交给已绑定的 Worker runtime；
2. 接收器重新验证 `offerId`、规范化 `ExecutionSpec` digest、Run/Attempt/Project/Task/revision、Worker ID/session/generation、Run Lease 和当前 Worker Session；
3. 将完整 offer 以 `accepted` 写入 Worker 私有 journal；
4. 调用 ADR-0013 `acknowledgeStarting`，成功后写入 `starting_acknowledged`；
5. 把最新 Run Lease 交给单 timer lifecycle；
6. `WorkerExecutionContextFactory.prepare()` 只准备可回收的输出/回调能力，不得 spawn 或产生不可逆业务副作用；completion token 必须是每 Attempt 独立的高熵随机 capability；
7. 校验 callback token/sequence，只把 sequence 与 token SHA-256 写入 journal，并在调用 `Executor.start()` **之前**原子写入 `launching`；原 token 只保留在内存 `ExecutionContext` 并交给 launcher；
8. Executor 返回稳定 handle 后写入 `started`；
9. 使用 lifecycle 中最新 lease version 提交 `acknowledgeRunning`；
10. running ACK 成功或幂等重放后写入 `running_acknowledged`。

启动准备或 `Executor.start()` 明确拒绝时，先持久化 `start_failed`，再重放 `failStart`，最后写入 `start_failure_acknowledged`。同一进程内的并发重复 delivery 合并成一个 operation。

### 2. `launching` 是禁止盲目重试的 crash barrier

无法把文件写入与 OS spawn 做成一个跨资源原子事务。因此 Worker 重启后若看到 `launching`，不能再次调用 Executor。当前实现把它推进为 `recovery_required: launch_outcome_unknown`，等待后续 Reconciler 结合 durable process identity、completion receipt 和控制面事实判断。

该策略偏向 at-most-once：在无法证明 ownership 时允许任务被标记 lost 并由控制面创建新 Attempt，但不允许同一 Attempt 静默双跑。不得用“超时后直接再 spawn”替代恢复判断。

其他窗口具有确定重放语义：

- `accepted`：可重放 starting ACK；
- `starting_acknowledged`：可继续首次启动；
- `started`：只能重放 running ACK，不能再次启动；
- `running_acknowledged`：返回幂等成功；
- `start_failed`：只能重放失败 ACK；
- 控制面已 running 但本地没有匹配 handle，或控制面意外 terminal：进入 `recovery_required`。

### 3. 本地 journal 是 delivery 状态，不是新的执行 authority

Run Lease 仍是唯一远程执行 authority，Run/Attempt 仍是控制面事实源。Worker journal 只保存：

- 完整且经校验的 offer，包括 Worker 所拥有的不透明 lease capability；
- 状态、单调 revision、接收/更新时间；
- `started` 后的稳定 executor handle、start time 和可选 log artifact；
- `launching` barrier 后可选的 completion callback sequence 与 64 字符小写 SHA-256；不得保存原 completion token；
- 需要人工或 Reconciler 处理的低敏恢复原因。

journal 不得自行延长 Lease、改派 Worker、创建新 Attempt 或宣称 Run 已 running。相同 `offerId` 的新 delivery 只允许携带同一 authority、candidate 和 digest；lease version 可以单调推进。不同 digest、Session、generation、token 或 Task revision 必须作为冲突拒绝。

### 4. edge 默认采用私有原子文件 adapter

首个 adapter 每个 offer 使用一个 JSON 文件：

- root 必须是绝对路径并由单个 Worker runtime 独占；目录权限 `0700`，文件权限 `0600`；
- 临时文件写入后 `fsync`，再以 hard-link 原子首次发布；状态更新使用同文件系统临时文件加 atomic rename；
- 默认最多 64 条，硬上限 1024 条；单条最多 192 KiB；扫描一页最多 64 条并使用稳定 `offerId` cursor；
- journal 满时 fail closed，不能驱逐 active/unknown offer 给新任务让路；
- journal 本身不创建 watcher、扫描 timer、额外数据库连接或每任务 sidecar；ownership lease 只使用一个 `unref` 刷新 timer；
- 同一 owner 内的 `create/replace/remove` 经过一个 Promise mutation queue 串行化，避免不同 offer 并发容量检查越界，也让 revision-conditional remove 与 replace 具有确定顺序；读取仍可并发；
- 不支持目录 `fsync` 的文件系统只保证重启一致性，断电持久性为 best effort，必须在设备矩阵实测。

adapter 必须在任何 list/read/create/replace/remove 前显式取得 root ownership：使用 root 内私有 lock directory 原子竞争，默认 stale window 为 30 秒，可配置范围为 5 秒至 5 分钟，并按一半窗口刷新。第二个进程不能读取或写入；lock 被删除、mtime 被替换或刷新超过窗口时，旧 owner 立即进入 `compromised`，此后所有 journal 操作 fail closed，不能自动重新 acquire。释放成功后另一个进程才能接管。

多 Worker 进程共享同一 root、NFS/对象存储目录或不支持同目录原子 rename/lock directory 的文件系统不在支持范围内。cluster Worker 可以提供等价的本地 SQLite/系统服务 adapter，但必须通过同一 port contract，不能把网络队列 ACK 当作 journal。

### 5. 启动审计有界且不执行恢复副作用

取得 ownership 后先运行只读 startup auditor。edge 默认每页 16 条、最多 4 页；硬上限为每页 64、16 页和总计 1024 条。cursor 重复、倒退、跳页、超页或预算耗尽必须显式 fail closed。

`WorkerExecutionOfferInboxLifecycle` 固定执行 acquire → audit → optional bounded recovery → re-audit → hold：未注入 recovery 时保持 acquire → audit → hold；完整审计为 `ready` 或 `reconciliation_required` 时持续持锁，直到显式 stop。扫描预算、recovery action 预算耗尽、journal 损坏或审计异常时先释放 ownership，再拒绝启动。该 lifecycle 不创建自己的 timer，也不启动 delivery transport。

审计结果只包含 offer ID、Attempt ID、journal state 和低敏分类，不返回 lease token、命令或 `ExecutionSpec`：

- `accepted/starting_acknowledged/start_failed`：没有已知本地执行，可等待认证 transport 重投或 Lease 过期；
- `start_failure_acknowledged`：启动失败 delivery 已收敛；
- `completion_acknowledged`：控制面完成已成功或精确幂等重放，本地可进入回执清理与后续 retention；
- `launching/recovery_required`：launch 结果未知，必须进入 launch Reconciler；
- `started/running_acknowledged`：已经或可能建立本地执行 ownership，必须进入 execution Reconciler。

`running_acknowledged` 只说明控制面持久化了 running，并不是执行终态，也不能按 terminal retention 清理。`completion_acknowledged` 单独归类为 `settled_completion`，不会阻塞 Worker 启动；startup auditor 本身仍不得重放 ACK、调用 Executor、停止进程或删除记录。

#### 5.1 恢复先建立可信证据，不从“不确定”推导“已退出”

`next` 已增加 transport-neutral 的 `WorkerExecutionOfferRecoveryReconciler` 作为 startup auditor 后的证据层。单条恢复顺序固定为：

1. 先按 Attempt ID 读取 immutable completion receipt；
2. 同时校验 Run/Attempt、已持久化 start time 和 Worker 本地 completion capability；
3. 只有 receipt 缺失时，才用 `PersistedExecutionInspector` 检查 durable handle；
4. 若 handle 已退出，立即重读 receipt，并可配置最多 5 秒的有界发布宽限后再读一次；
5. receipt 仍缺失、handle 无效/identity mismatch、平台不支持或探测失败时保留明确 unknown，不据此重启、signal 或宣称 lost。

receipt authenticator 是必需 port，不能把“私有目录里存在一个 JSON 文件”等同于可信完成事实。Receiver 在 `launching` barrier 之前从 ephemeral callback 派生 SHA-256；journal 只允许 sequence/digest 成对出现，且 `accepted/starting_acknowledged` 不得提前携带。`Sha256WorkerExecutionCompletionReceiptAuthenticator` 同时比较 callback sequence，并对 32-byte digest 做 constant-time 比较；缺失元数据的旧记录仍可读取，但不能认证 receipt。Reconciler 的结果只返回 callback sequence、时间、exit code 和 outcome，不返回 receipt token、Run Lease token、命令或 ExecutionSpec。receipt 冲突、认证器不可用和读取 I/O 错误都会在 process probe 前 fail closed。

每次 pass 使用一个固定 observation time，区分 `current`、`session_fenced`、`worker_offline`、`worker_session_expired` 和 `run_lease_expired`。即使旧 Attempt 的 receipt 可以证明完成，新 Worker Session 也不能代替旧 Session 提交 Lease completion；控制面已经 terminal 时同样只保留证据，不重复提交。该层不依赖 Executor 的进程内 `WeakMap`，也不注入 `start/stop/ACK/remove` port，因此无法产生二次 spawn 或 PID 误杀。

Reconciler 只恢复可信 ownership/completion **事实**，不执行控制面 mutation。`WorkerExecutionOfferRecoveryCoordinator` 在同一 journal ownership 下重新读取 record，且只对 `completion_observed + completionSubmission: ready` 提交完成；不得把 `ready` 当作已提交。

#### 5.2 恢复副作用按不可逆顺序收敛

完成恢复固定为：

1. 使用 journal 中原 Worker Session、Run Lease generation/token/version 和可信 receipt 的 callback sequence/result 提交 `RemoteRunCompletion`；
2. 控制面首次完成或返回语义完全一致的 `already_terminal` 后，以 journal revision CAS 写入 `completion_acknowledged` 和 `completionAcknowledgedAtMs`；
3. 只有终态 journal 已持久化，才按 Attempt ID 删除本地 receipt。

控制面完成成功但 journal 写失败时，receipt 必须保留，下一次以相同命令幂等重放；journal 已终态但 receipt 删除失败时，终态不能回退，后续 pass 只重试清理。并发恢复按 offer ID 在进程内合并，journal revision 仍是最终本地 CAS。结果只暴露低敏状态和清理结果，不返回任一 capability。

控制面的 `completeWithLease` 只对“相同 Run/Attempt、Worker/session/generation、lease generation/token，且当前 lease 已 `completed`、version 恰为请求版本 + 1”的精确重放绕过 Worker 当前在线性与观测时间单调检查；事务内 CompletionService 仍校验 callback sequence 和终态 outcome。首次完成、改变 callback/outcome 或改变任一 fence 都继续要求当前有效 Worker/Lease 或直接拒绝。这关闭了“控制面已提交，Worker 在本地终态写入前重启/被替换”的收敛窗口，而没有让旧 Session 获得新的完成权。

running ACK 恢复只在 receipt 缺失、durable identity 明确 running、authority 为 current 且 journal 为 `started` 时执行；成功后写 `running_acknowledged`，控制面已经 terminal 时只写 `recovery_required: control_plane_terminal`，不能伪造完成。恢复使用 journal 已持久化的 lease version；若 renewal version 更新但尚未通过 recovery delivery 合并回 journal，version mismatch 必须保留原状态并等待新 authority，不允许猜测或无限重试。

#### 5.3 启动恢复与终态保留都必须有硬预算

`WorkerExecutionOfferStartupRecoverySupervisor` 只消费一次完整 startup audit，按 audit 的稳定顺序串行驱动 `settled_completion`、launch recovery 和 execution recovery；默认最多 64 个 action，硬上限 1024。scan 未完成或 action 超预算时在任何副作用前 fail closed；单项失败不暴露异常文本，并继续处理同一有界批次的其他记录，但整体保持 `reconciliation_required`。它不创建 timer，生产 headless lifecycle 仍需显式决定何时重审并开放 delivery transport。

`WorkerExecutionOfferJournalRetentionService` 每次只读取一页，默认 16 条、最多 64 条，默认最多执行 8 次删除、硬上限 64；调用方持有并持久化 cursor 与 cadence。它只处理超过显式 retention 的 `completion_acknowledged` 和 `start_failure_acknowledged`：前者必须先幂等清理 receipt，再以 record revision 条件删除 journal；receipt 清理失败、revision 变化或文件删除失败都保留 journal。最小 retention 为 1 分钟、最大 30 天，生产值必须覆盖 transport redelivery/诊断窗口。该服务无 watcher、无 timer、无目录递归和额外数据库连接。

#### 5.4 运行中失租先停止旧本地身份，不赋予旧 Worker lost 写权

`WorkerRunLeaseLifecycle.onLost` 只是同步失权通知，不能直接承担异步 stop 或控制面状态转换。`WorkerExecutionLeaseLossCoordinator` 接收其中的 lease snapshot，并重新按该 authority 计算稳定 offer ID、读取 journal；只有 Run/Attempt、Worker/session/generation、lease generation/token 全部与记录一致，且记录仍可能拥有本地执行时，才调用 `PersistedExecutionController.stop({ durableHandle, reason: reconcile })`。journal 中的旧 lease version 可以落后于 lifecycle 的 renewal version，但 authority capability 不允许变化。

controller 必须自行解析和复验 durable identity；`termination_requested/already_exited` 写为 `recovery_required: lease_lost_local_execution_stopped`，handle 缺失、identity/pid mismatch、unsupported 或 invalid 写为 `lease_lost_local_execution_unverified`。controller 抛错时不写“已停止”，以便显式重试；同 offer 的进程内并发通知合并，journal revision CAS 仍裁决与 completion coordinator 的竞态。`completion_acknowledged` 永远优先，两个失租原因也保持幂等。它们不是可 retention 的业务终态，transport redelivery 不得再次 spawn。

该协调器刻意不持有 Remote completion、RunRepository 或 RunCommandService，旧 Worker 因此无法在 fence 失效后把 Run/Attempt 标为 lost。控制面使用独立的 server-owned `expireWithLease`：事务内锁定当前 Lease；live/completed/其他 release 不改写，确已过期时写入 `released: lease_expired`。未启动的 claimed Attempt 只释放以便 Dispatcher 后续生成新 generation；运行中的 starting/running Attempt 与 Run 在同一事务转为 lost 并写两个 reconciler Event；已有取消/超时意图时只撤销旧执行 authority，把终态留给取消链。renew、completion 与 expiry 的竞争由同一 Lease 行事务串行化，任一步异常都回滚 lease、Run、Attempt 和 Event。

SQLite `RunDispatchLeaseExpirySource` 使用现有 `(status, expires_at_ms, attempt_id)` 索引，只返回 runtime-owned active Run/Attempt；`RunDispatchLeaseExpiryScanner` 固定一次 observation，每页默认 16、硬上限 64，按 `(expiresAtMs, attemptId)` 稳定 cursor，逐条串行且隔离单项失败。失败时停止当前页并只返回连续成功前缀的 cursor，失败项留在下一轮，禁止为了继续批次而跳过它。它无 timer、无多页递归，调用方负责 cadence 和 cursor 持久化，适合 edge 小批次运行；cluster-control 必须提供等价 PostgreSQL adapter。当前 `next` 的 Worker 本地协调器与控制面 expiry scanner 都保持生产不可达；lifecycle 装配和 PostgreSQL adapter 仍是 Gate，lost retry/new Attempt 由下一节的独立控制面协调器处理。

#### 5.5 lost 后只按 admission 策略创建新的 Attempt

`next` 新增一对一的 `RunRetryPolicies`，由 Primary 建单事务在可信 admission provider 返回策略时与 Run、Attempt 1 一起提交。没有策略记录是安全默认值：不自动重试。策略固定最大 Attempt 数、是否处理 lost、`unknown/idempotent/deduplicated` 安全等级、退避上下限、下一次尝试时间和独立 version。Primary 只向 provider 发送冻结的 Task revision 身份子集；Run 命令自带策略会在任何写库或 spawn 前拒绝。启用自动 lost retry 必须由固定 Task revision 证明幂等，或绑定已经强制执行的业务去重契约；策略不从 Worker 请求、失租回调或运行中可变 payload 推导。

控制面 Reconciler 先将符合条件的 lost Run 转为 `retry_wait` 并原子保存退避时间。到期事务重新验证 runtime ownership、取消意图、最新 Attempt 仍为 lost、策略 version 与次数预算，然后创建 Attempt N+1；Run queued、policy cursor 清理、Attempt claimed 和两个 Event 要么全部提交，要么全部回滚。新 Attempt 不继承旧 Worker/Session、Run Lease、handle/PID、callback capability 或 completion sequence。旧 Attempt 永远保持 lost，`retry_of_run_id` 也不参与自动重试。

本地 Primary 的 claimed activation seam 可读取并复验这个 Attempt N+1，要求它是未取消 queued Run 的最新 claimed Attempt、属于 runtime 且 executor type 一致，再复用既有的 starting/spawn/running/completion 协议。Run CAS 在 spawn 前关闭同机并发激活窗口；旧 Attempt、非最新 Attempt 和不同 Executor ownership 均在副作用前拒绝。其外层本地 Dispatcher 每周期最多激活一个 Attempt，默认只扫 1×8，硬上限 16×64；它固定 observation、验证稳定 cursor、跳过其他 Executor，且必须在激活前规范化并深拷贝 pinned `ExecutionSpec`。两者都不自行解析任务内容，也不构造 Secret、日志或回执 context。

SQLite source/scanner 每次默认 16、最多 64 条，无 timer、无递归分页；异常候选保留并上报，其他同页候选仍可收敛。外层 profile-aware lifecycle 使用一个 `unref` timer、禁止重叠、停机等待有上限，并固定每 tick 一页：edge 30 秒×8，standalone 5 秒×32。它与 expiry scanner 一样仍是单控制面 adapter，PostgreSQL 多副本实现是生产 Gate。ADR-0022 已提供 pinned revision 与动态 context 的组合 materializer contract。当前实现仍保持 production unreachable：default manual Primary 未配置可信 provider，也没有 Task revision persistence、SecretStore、Artifact/output adapter；有界本地 Dispatcher 无 lifecycle/startup 装配。只有 Task/API 安全声明与去重契约、具体 materializer adapters、Dispatcher cadence、startup 装配、指标告警、PostgreSQL contract 和 edge 写放大验证完成后才能启用。

### 6. Session、draining 和 Lease 继续 fail closed

- delivery 必须精确命中当前 Worker ID/session/generation；
- offline、Worker Session Lease 过期或 Run Lease 过期时，在写 journal 前拒绝；
- `draining` 拒绝 `new_claim`，但允许同一 active Lease 的 `lease_recovery`，以便完成已有 ownership；
- starting 后才开始跟踪 Run Lease；running/fail ACK 从 lifecycle 读取最新 version；version mismatch 只允许小次数有界重试，不能循环忙等；
- journal 中原始 token 不进入普通日志、诊断、Event 或 API，备份与本地加密策略仍需安全 ADR。

### 7. 当前仍不开放生产 transport

当前实现提供 domain、port、原子文件 adapter、绑定的 activation/completion client、transport-neutral receiver、证据 Reconciler 和 side-effect coordinator，并保持旧 Controller、HTTP、gRPC 与 headless bootstrap 不可达。进入生产还必须完成：

- 控制面身份认证、enrollment、双向 TLS/token rotation 和消息大小/速率限制；
- 生产 `WorkerExecutionContextFactory` 的高熵 capability 生成与安全轮换；
- Worker 本地失租 coordinator、控制面 expiry scanner 与 lost retry lifecycle 的 startup 装配，以及消费重试 queued Attempt 的 Dispatcher；
- Artifact 获取、校验、日志上传和 completion transport；
- terminal retention cadence/cursor 的 headless 装配、敏感备份和安全擦除策略；
- PostgreSQL 多控制面 contract 与固定 edge/多架构资源门禁。

## 影响

正面影响：

- 控制面重投不再依赖 Worker 进程内存；
- ACK 丢失只会重放 ACK，不会重放 spawn；
- edge 无新增常驻服务，集群仍能替换 adapter；
- Worker Session replacement、digest drift 和过期 Lease 在执行前被拒绝；
- crash window 被显式持久化，后续 Reconciler 有可审计输入。
- 完成提交、journal 终态和 receipt 清理之间的两个 crash window 都可幂等收敛。

代价与风险：

- `launching` 无法自动区分“尚未 spawn”和“已 spawn”，需要 durable identity/receipt 恢复；
- durable handle 只能证明已记录的进程 identity；`launching` 在没有 receipt/handle 时仍必须保持 unknown；
- 文件 journal 持有 lease capability，部署必须保护目录、备份和诊断输出；
- completion 前清理会丢失去重与执行 ownership，清理过晚会占用容量；
- ownership lease 依赖本地文件系统 mtime/atomic mkdir 语义，设备 suspend 和异常时钟跳变必须实测。

## 未选择的方案

1. **只用内存 LRU 去重**：Worker 重启后会重复执行。
2. **先 spawn，再写 journal**：最危险的重复执行窗口没有 barrier。
3. **`launching` 超时后自动重试**：无法证明旧进程不存在。
4. **为每个任务启动 Node guardian**：不满足 edge RSS/PID 预算。
5. **新增控制面 DispatchOffers authority 表**：与 Run Lease 形成双重真相；Worker 本地 delivery journal 也不能取代 Lease。
6. **让消息队列 exactly-once 保证执行**：delivery exactly-once 不等于外部进程副作用 exactly-once。

## 验证要求

- journal 原子首次发布、revision replacement、重启读取、权限、容量和分页通过测试；
- 未 acquire 时拒绝所有操作；双 owner 竞争只有一个成功，释放后可接管，lock compromise 后旧 owner 全面 fail closed；
- startup audit 对所有状态稳定分类，输出不含 token/命令，预算耗尽和非法 cursor 显式拒绝；
- 相同 offer 并发/串行重放只调用一次 Executor；
- 相同 ID 不同 digest/Task revision/Session authority 在 spawn 前拒绝；
- 过期 Lease、替换 Session、draining 新 claim 在写 journal 前拒绝；draining recovery 可继续；
- `launching` 重启只进入 `recovery_required`，调用 Executor 次数为 0；
- `started` 重启只重放 running ACK；
- `running_acknowledged` 仍被视为待恢复的本地执行 ownership，不得作为清理终态；
- 恢复必须 receipt-first；可信 receipt 不再探测进程，进程 exited 后在有界 grace 内重读 receipt；
- receipt Run/Attempt/start time/capability 冲突或读取失败时不得继续 process probe；恢复结果不得包含 receipt/lease token；
- callback sequence/token digest 必须在 `launching` 前成对落盘，原 callback token 不得进入 journal；旧记录无 digest 时必须拒绝 receipt 认证；
- durable identity 的 running/exited/invalid/mismatch/unsupported 和探测异常均稳定分类，任何分支都不调用 start、stop、ACK 或 remove；
- 相同完成事实遇到替换 Session、offline、Worker Session Lease 过期、Run Lease 过期或控制面 terminal 时只报告 blocked，不借用新 authority 提交；
- 可信完成必须先提交控制面，再写 `completion_acknowledged`，最后清理 receipt；journal 写失败不得清理，清理失败不得回退终态；
- 控制面完成后的精确 fence/callback/outcome 重放可在 Worker 被替换后返回 `already_terminal`，任何变体继续拒绝；
- running ACK 恢复只允许 current `started` + running identity，控制面 terminal 只能进入恢复状态；
- 失租 stop 只能命中同 offer authority 的 durable handle；完成已确认时不得 stop，identity 无法复验时必须写 unverified 而不能声称已停止；
- 失租本地记录不得被 terminal retention 清理或被 transport redelivery 再次 spawn，旧 Worker 不得直接写控制面 lost；
- lost 自动重试必须在 admission 拒绝 unknown safety；无策略、禁用和次数耗尽分别稳定收敛，取消意图必须先于新 Attempt 生效；
- retry_wait 到期只能创建 Attempt N+1；Run queued、policy cursor 清理、Attempt claimed 与有序 Event 任一步失败必须整事务回滚，重放不得创建 Attempt N+2；
- lost retry source/scanner 必须限制为一页最多 64 条，不启动 timer 或递归翻页，未来到期项不得提前返回；
- startup recovery action 超预算时不得执行部分副作用；单项异常只能返回低敏失败结果；
- terminal retention 必须先清理 completion receipt，再按 journal revision 删除；并发 replace、清理失败和超预算均不得误删 active/新版本记录；
- Executor 明确拒绝后 failure ACK 可重放且不二次启动；
- 控制面已 running/terminal 但 journal 缺少一致 ownership 时不得 spawn；
- Node 22、Node 24 全量测试通过，并在真实 edge 文件系统验证断电、ENOSPC、inode 耗尽和权限模型。
