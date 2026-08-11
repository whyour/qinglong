# ADR-0121：Production Worker Headless Execution Composition

- 状态：Accepted（执行平面具体装配已实现；Session heartbeat、证书/credential 产品流程、部署入口与 retention 仍为发布 Gate）
- 日期：2026-07-23
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-14、D-85、D-108、D-111、D-114、D-115、D-116、D-120
- 关联 ADR：ADR-0061、ADR-0087、ADR-0110–ADR-0120

> ADR-0122 当前增量：`@qinglong/worker-runtime/product` 已在不新增 package 的前提下接入 exact Session
> wire、共享 Agent、journal-derived capacity 与单 cadence shutdown；本 ADR 下方 98/98、294 sources 是
> D-120 接受时快照。当前累计证据为 Worker 122/122、runtime-core 159/159、Cluster Control 129 pass/2
> external skip、23 importer/303 TypeScript sources。credential material provider 已由 ADR-0123 实现，
> 远端 recovery 和设备证据仍未完成。

## 背景

ADR-0110 至 ADR-0118 已分别完成 Offer、单一 inbox、Activation、Secret、日志、POSIX Executor、
Artifact/completion 与 Lease control，但都只提供默认关闭的原语。继续由最终部署入口逐个手工实例化会
产生多个 HTTPS Agent、不同 storage root、遗漏 completion-first supervision 或错误 shutdown 顺序。

原 `WorkerRemoteExecutionHeadlessLifecycle.stop()` 还会直接 Abort Pull 并释放 journal owner。如果 Pull
已经取得 Offer，或本地进程仍在运行，部署进程可能在没有 durable drain 证明时退出；这不是可接受的
production shutdown。

## 决策

### 1. 不新增 package，只开放显式 production subpath

具体执行平面放在 `@qinglong/worker-runtime/production`。默认 package 根入口继续只暴露证书 store 与
续期原语，不加载 `runtime-core` remote execution、`proper-lockfile`、HTTPS client 或 POSIX Executor。

`enabled=false` 在读取 Profile、路径、credential、Session 或创建对象前返回。启用只接受 `worker`
Profile，并要求三个互不相同、互不嵌套、非文件系统根的绝对 storage authority：

- Offer/inbox journal；
- 本地日志 spool；
- completion receipt。

Edge 默认 4 条 startup/supervision page、64 条 journal、2 秒 cadence、4 MiB Attempt/32 MiB reserve；
Node 默认 16/32 条 page、256 条 journal、500 ms cadence、64 MiB Attempt/256 MiB reserve。所有值仍受
1–64 page、1024 journal、100 ms–60 s cadence 等硬上限约束，不能由部署无限放大。

### 2. 一个 stack 装配全部现有具体能力

production factory 只使用现有 package 和 public subpath，装配：

1. 单 owner `WorkerRemoteOfferFileJournal`；
2. 单一 `WorkerIngressHttpsClient` 与 keep-alive Agent；
3. Offer、Activation、Secret、Artifact upload、Completion 与 Lease-control adapters；
4. Secret-before-Artifact materializer 与 Edge/Node 文件日志 policy；
5. reviewed launcher 的 POSIX Executor、同一 receipt root 和 `LocalProcessController`；
6. completion-first control coordinator、Processor 与 headless lifecycle。

stack 不导入 cluster-control、PostgreSQL 或 legacy root，也不创建第二个 Agent、数据库连接、per-Run timer
或新 schema。credential provider 与 Session lifecycle 由更外层注入，因为证书签发、`ql3w` credential
恢复和 heartbeat 是独立部署 authority。

### 3. 返回 active 前必须完成有界 startup reconciliation

显式启动先取得 journal owner，再按配置 page 完整扫描历史 inbox。只有得到 `reconciled` 才创建一个
`unref` 全局 cadence；`recovery_required` 或超过由 journal hard cap 推导的最大 tick 数立即清理并拒绝
启动。启动扫描期间不 Pull 新任务。

定时 tick 继续使用 lifecycle 内部 coalescing；异常只进入低敏 diagnostic，不重叠创建另一轮。每轮先
completion/lease supervision，再在 Session available 时最多 Pull 并处理一个 Offer。

### 4. Draining 必须在释放 owner 前关闭 Pull 竞态

lifecycle 增加显式 `beginDrain()`：

1. 原子标记本地 draining；
2. Abort 在途 Pull 并等待其结束；
3. 替换请求 AbortController，但继续持有 journal owner；
4. 后续 tick 只做既有执行监督，永不 Pull。

production stop 随后要求外层 `Session.beginDrain()` 已耐久关闭新工作，并复验当前 Session 不再
`available`。它在固定 1 秒–10 分钟总预算内重复 completion-first supervision 和最多 64 条一页的
journal 检查。只有全部记录进入 `start_failure_acknowledged|completion_acknowledged`，才按
cadence → lifecycle/owner → Offer transport → shared Agent 顺序关闭。

drain timeout 返回 `drain_timed_out`，保留 owner 并继续 draining cadence，允许稍后重试；durable
`recovery_required` 返回同名状态并保留 authority，禁止自动假装停止。Session drain 调用失败或不能
证明离开 available 也不得释放 owner。shutdown 等待 timer 保持 ref，防止进程在证明完成前自然退出；
只有常驻 cadence 使用 `unref`。

### 5. 本 ADR 不开放完整 Worker 发布

该入口完成的是 execution plane，而不是完整 Worker Profile。发布仍要求外层提供并验证：

- Worker Session register/heartbeat/drain/offline lifecycle；
- certificate enrollment/renewal 与 `ql3w` credential provision/recovery；
- deployment config、私有路径创建、告警和进程 shutdown budget；
- 本地 spool retention/delete 与对象存储 temporary lifecycle；
- 固定 Edge/Node x64/arm64、休眠、断网、断电和磁盘压力证据。

缺少任一项时部署入口继续默认关闭，不能把注入式测试 provider 当作产品配置。

## 被否决的替代方案

1. **新建 worker-application package**：没有新依赖或发布责任，违反 D-85。
2. **每个 client 自建 Agent**：重复 TLS credential authority、socket 与关闭状态。
3. **stop 直接释放 journal**：运行进程和丢响应 Offer 会失去唯一监督 owner。
4. **Session drain 后仍允许 Pull**：控制面和本地状态存在竞态，可能在 shutdown 接收新任务。
5. **drain timeout 后强制 close**：把“预算耗尽”伪造成“副作用已停止”。
6. **嵌套 journal/log/receipt root**：扩大扫描、清理和路径 capability 的误伤范围。
7. **production 子入口从 package 根导出**：让证书-only steady state eager-load 网络与文件锁依赖。

## 验收证据

1. lifecycle 测试证明 `beginDrain` Abort Pull、draining tick 不再 Pull、最终 stop 前 owner 不释放。
2. production 测试证明 disabled 零 option access、错误 Profile/重叠路径在文件系统前拒绝、空 execution
   plane 真实取得并释放 owner、Session drain 失败保持可重试。
3. 独立进程证明 package 根不加载 journal/`proper-lockfile`，只有 `/production` 加载执行图，且该入口
   不加载任何 `ql3-cluster-*`。
4. Worker Runtime 98/98 通过，包含显式 enabled factory gate 与两个真实 TLS 1.3 mTLS 回环集成；
   严格类型检查通过。
5. workspace 仍为 23 个 importer、294 个 TypeScript source file，dependency/source audit
   `findings=[]`，没有新增依赖、schema、migration、数据库连接或 per-Run timer。
6. 23 package clean build 与全量测试通过；六种本机制品再次通过真实 pack/offline install/import，
   最大仍为 2,457,770 bytes、409 files、72 loaded modules，当前抽样 RSS delta 最大
   12,566,528 bytes，且均不安装 `@aws-sdk/*`。
