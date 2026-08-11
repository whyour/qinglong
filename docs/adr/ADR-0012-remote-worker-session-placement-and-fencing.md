# ADR-0012：Remote Worker Session、能力放置与 Fencing

- 状态：Proposed
- 日期：2026-07-18
- 关联 RFC：QingLong 3.0 Architecture RFC D-05、D-06、D-23，7.6、14.6、26.12

## 上下文

QingLong 3.0 既要运行在低内存路由设备上，也要支持多个控制面副本和异构执行节点。TCP 连接、gRPC stream、内存中的 Worker map 或裸 hostname 都不能同时解决以下问题：

- 控制面重启或水平扩展后恢复 Worker 存活和容量；
- 区分同一 Worker ID 的新旧进程，阻止旧进程继续心跳或提交完成；
- 在架构、Runtime、Executor、内存、磁盘、GPU 和标签不匹配时拒绝调度；
- 在小设备上保持固定的消息、候选页、timer 和内存上限；
- 区分“节点在线”与“某个 RunAttempt 已被原子授权执行”。

当前 `next` 已有 Run/Attempt 状态、LocalProcess Executor、durable cancellation fencing 和 Profile 边界，但没有生产可用的 Remote Worker transport。本 ADR 先稳定 Worker Session、Run Lease 和 Placement 边界，避免后续由 HTTP、gRPC 或数据库实现反向定义领域语义。

## 决策

### 1. 身份由认证传输绑定

控制面从 mTLS 证书、短期签名 token 或等价认证机制得到 `WorkerPrincipal`。请求体可以携带 `workerId` 供一致性校验，但不能自行建立身份。应用层使用绑定 principal 的 client；principal 与请求 Worker ID 不一致时在访问 Repository 前拒绝。

本 ADR 不选择 HTTP、gRPC 或消息队列。任何 transport adapter 在完成身份认证、授权、重放限制、消息大小限制和速率限制前不得暴露注册 endpoint。

### 2. 每次进程启动建立新 Session

Worker 每次启动生成 UUIDv7 session ID，并注册以下有界快照：

- canonical capabilities 及 SHA-256；
- `maxConcurrentRuns` 和当前 `availableSlots`；
- Worker 软件版本和后续协议版本；
- 控制面签发的 session lease。

控制面持久化 `workerId + sessionId + generation + version`：

- 首次注册使用 generation 1、version 0；
- 相同 session 和相同注册内容是幂等重放；内容冲突时拒绝；
- 经 transport 授权的新 session 原子替换旧 session，generation 和 version 单调递增；
- 心跳、drain、offline 以及未来 Run claim/completion 必须携带 session、generation 和 expected version；
- 任一字段不匹配、lease 过期或 Worker 已 offline 时 fail closed。

被 fencing 的进程停止 heartbeat，不在后台自动重新注册或抢回 Worker ID。管理员显式重启可以建立新 session，但生产 transport 必须为 takeover 增加凭证轮换、单次 enrollment 或等价的重放防护，防止持有旧长期凭证的进程反复替换当前 session。

### 3. Session Lease 与 Run Lease 分离

Worker Session Lease 只表达“这个认证节点最近仍在报告状态和容量”。它不授权执行任何具体任务。

Run Lease 必须由 RunQueue 对单个 RunAttempt 原子 claim，并绑定：

- Worker ID、session ID 和 generation；
- Attempt ID 和 fencing token；
- lease expiry、续租 version 和 completion sequence。

只有 Run Lease 的 claim 事务提交后，RemoteWorkerExecutor 才能下发 ExecutionSpec。Worker 接受、Executor 建立所有权和最终完成是后续三个独立事实，分别遵循 ADR-0013 的启动 ACK 与本 ADR 的双重 fencing。完成提交必须同时验证 Worker Session 和 Run Lease fencing，并通过现有 Run CAS/CompletionService 原子写入。候选查询或 Placement 命中不能代替 claim。

### 4. 能力与 Placement 都必须有硬上限

WorkerCapabilities 使用严格字段、确定性排序的 canonical JSON，拒绝未知字段、控制字符、重复项和超限内容。首个实现将完整快照限制为 16 KiB，并分别限制 Executor、Runtime、标签、GPU 和 feature 数量。

PlacementSpec 分为：

- `required`：架构、操作系统、Executor、Runtime semver、标签、最小内存/磁盘、GPU vendor 和 feature；任一不满足即不可调度；
- `preferred`：有界标签权重，只影响候选排序，不可绕过 required；
- 候选页：最多 64 个节点，先对 Placement 归一化一次，再确定性按 score、available slots 和 Worker ID 排序。

没有匹配节点时，Run 保持 pending，并保留低基数、可解释的 mismatch 分类，不把完整标签或 Secret 写入事件。

### 5. Headless Worker 是独立启动拓扑

Worker Profile 不加载 Web 面板、Scheduler、SQLite 控制面或本机 Primary router。bootstrap 默认关闭；关闭时不得调用依赖、建立连接、创建 timer 或后台进程，并且只允许显式 `worker` Profile 激活。

生命周期遵循：

1. 注册后只保留一个不重叠、可 `unref` 的 heartbeat timer；
2. 动态上报可用槽位，但不能超过声明的最大并发；
3. shutdown 先进入 `draining` 且容量归零；
4. draining 期间继续 heartbeat，等待本地执行面在固定上限内排空；
5. 只有执行面已排空，才请求 offline；
6. 排空超时或 disconnect 失败必须显式返回，不能把节点伪报为已安全停止。

### 6. 存储边界

SQLite `Workers` 与 `RunDispatchLeases` Repository 仅服务单控制面协议孵化、standalone 兼容路径和竞争测试。注册/claim 使用 SQLite immediate transaction，并对 `SQLITE_BUSY`/唯一竞争做有界重试；Run Lease adapter 显式拒绝非 SQLite 方言，避免被误用于 cluster-control。

cluster-control 必须提供 PostgreSQL adapter，使 session replacement、heartbeat CAS、候选发现和未来 Run claim 在多副本下具备清晰的事务与锁语义。共享 SQLite 卷、内存 map 或“最后写入获胜”不能作为集群实现。

## 当前实现边界

`next` 当前具备：

- Worker 领域值、canonical capabilities、session fencing 错误；
- WorkerControlService 和绑定 principal 的 transport-neutral client；
- SQLite/Sequelize 临时 Registry adapter 与 `0008-worker-registry` migration；
- Attempt-scoped `0009-run-dispatch-lease`、lease generation/token/version、expiry/Worker 索引和 token 唯一约束；
- `0010-run-dispatch-candidates` priority/FIFO partial index，以及最多 64 条、稳定 keyset cursor 的 SQLite Run candidate source；
- required/preferred Placement 匹配和有界确定性候选选择；
- 默认关闭的 headless heartbeat/drain bootstrap；
- 指定 runtime-owned Run/claimed Attempt 的原子 claim、幂等重放、续租、释放、Worker 并发上限和未启动 expiry takeover；
- Worker 侧单 timer Run Lease lifecycle：无重叠续租、仅在现租期内重试、session replacement/fencing fail closed，并把 shutdown release 串行化到 in-flight renewal 之后；
- ADR-0013 的 starting/running ACK、executor handle 一致性校验、启动失败终结事务和 dispatching timeout 语义；
- ADR-0014 的单周期有界 Dispatcher：先按 2×8 页恢复 active lease，再按 candidate → Worker snapshot → plan → Placement → 原子 claim 顺序生成内存 offer；pinned Project/Task/revision 必须与 `ExecutionSpec` 一致，相同 lease generation 派生稳定 offer ID；
- Remote completion 在一个事务中验证 Worker Session 与 Run Lease，并复用 CompletionService 提交 lease completed、Attempt、Run 和双 Event；
- PostgreSQL capability v8 的独立 `worker_sessions`/`run_dispatch_leases`、数据库锁后取时、Session replacement fencing、Worker 行锁容量 claim、token digest-only 存储与精确 Attempt fence 投影；
- ADR-0108 的 PostgreSQL Worker Pull 切片：Task 的 Placement 随 immutable execution revision 固定，candidate 使用数据库时钟和有界 keyset，认证 Worker 自带稳定 offer ID 与高熵 token；claim 只持久化摘要，同一 capability 可从 durable Lease 重建丢失响应；
- ADR-0109 的 PostgreSQL starting/running/start-failure 短事务：数据库权威时间、完整 Session/offer/Lease fence、callback digest、精确重放和 timeout 优先终态；
- 双 SQLite 连接竞争、候选分页/过滤、lease expiry、旧 session/token fencing、错误完成 token、completion crash rollback、renew/release 竞态、Placement 和生命周期测试。

以下能力尚未实现，相关入口必须保持不可达：

- mTLS/token enrollment 与生产网络 transport；
- PostgreSQL completion、expiry/lost、cancellation 与 retry 原子事务；
- delivery attempt/退避状态、认证 ExecutionSpec transport 和 headless runtime 装配；
- Remote ExecutionSpec/Artifact/日志传输；
- 已开始运行的 Attempt 失租后标记 lost、创建新 Attempt 和按重试策略重新派发；
- cancellation、shutdown 与 Run Lease 的协调协议；
- Worker 管理 API、升级、撤销和审计 UI。

## 影响

正面影响：

- 领域协议独立于 gRPC/HTTP 和具体 ORM；
- 新旧进程具有可验证边界，控制面重启后可以恢复节点视图；
- capability 和候选规模有硬上限，适合路由设备与异构集群共享实现；
- Worker 模块默认关闭，不增加 edge/standalone 常驻成本。

代价与风险：

- Session、Run 两层 lease 增加协议和测试复杂度；
- 心跳会产生持续数据库写入，必须按 Profile 调整 cadence，并在 PostgreSQL adapter 中批量化或抑制无变化字段；
- 仅凭同一长期 principal 允许 session takeover 仍有旧凭证重放风险，生产 transport 必须补 enrollment/rotation；
- SQLite adapter 不能证明多副本正确性，不能用于宣称 cluster-control 可用。

## 被拒绝的方案

1. **只用连接是否存在表示 Worker 在线**：控制面重启后丢失，且多副本视图不一致。
2. **请求体直接携带可信 Worker ID**：未认证调用者可以冒充或 fencing 正常节点。
3. **只有时间 lease，没有 generation/version**：时钟和迟到请求无法可靠区分新旧进程。
4. **候选命中即视为任务领取成功**：并发 Dispatcher 会重复分配同一 Attempt。
5. **Worker 复用完整控制面进程**：把面板、Scheduler、数据库和插件常驻成本带到边缘节点，也扩大攻击面。
6. **失联后自动以同一 ID 无限重注册**：旧进程可能与新进程形成 session 抢占风暴。

## 验证与进入生产的门禁

- 两个控制面连接竞争替换同一 Worker 时 generation 单调，旧 session 全部被拒绝；
- heartbeat 不重叠，lease 过期节点不可见，draining/offline 节点不进入候选；
- drain 与 stop 并发时仍先归零容量，disconnect 失败不返回成功；
- capability/Placement 未知字段、超限集合、非法 semver 和超限候选页全部 fail closed；
- PostgreSQL contract suite 覆盖多副本 claim、锁等待、lease expiry、重复 completion 和 fencing；
- 认证 transport 覆盖身份冒充、凭证撤销、replay、限流、超限消息和断线重连；
- 固定 256 MiB edge 设备验证禁用 Worker 时无新增 timer/连接，轻量 Worker 的 RSS、heartbeat 写放大和空闲 CPU 达到发布预算；
- Node 24 支持矩阵中的每个 Worker 架构完成注册、执行、断线恢复和 Artifact smoke test。
