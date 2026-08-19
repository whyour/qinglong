# ADR-0459：按需 Project CancellationDispatch 可用性汇总

- 状态：Accepted
- 日期：2026-08-19
- 关联 RFC：QL-RFC-0001 D-366、PR-5、PR-7
- 关联 ADR：ADR-0005、ADR-0456、ADR-0457、ADR-0458
- Amends：ADR-0005 的 blocked 指标出口、ADR-0458 的产品可见运维边界

## 上下文

ADR-0458 已提供单 Run 的低敏 inspect 和人工 rearm，但 operator 仍必须预先知道哪个 Run 被 blocked。直接依赖每个 `cluster-control` 副本的进程内计数会在重启、扩缩容和 failover 后丢失事实，也无法形成 Project 一致视图。新增 Prometheus server、扫描 timer 或聚合 daemon 又会制造第二个 cancellation cadence，并让低配部署为空闲可观测性持续付费。

QingLong 同时面对小型路由设备和多副本 Cluster。Local/Edge 不应引入 PostgreSQL、管理面或指标闭包；Cluster 则需要数据库事实驱动、可审计、可供 CLI/UI/告警共同消费的稳定出口。

## 决策

1. 在既有 `cluster-admin` Run management 协议增加 `run.cancellation.summary`，复用原 HTTPS/mTLS process、OIDC、固定路由、请求上限、连接池和 shutdown lifecycle，不新增 package、服务、端口、timer、队列、缓存或 Kubernetes 对象。
2. 请求只包含 Project、request/audit identity 和固定空 body schema，不接受 Run、Attempt、时间窗口、分页、状态过滤、指标标签或调用方时钟。transport 只注入强认证 User；service 使用既有 `run.read`，因此 viewer 可读取汇总，弱认证、agent 和 Policy fence drift 失败关闭。
3. Repository 在一个最长 5 秒的 SERIALIZABLE 短事务中，以 PostgreSQL `transaction_timestamp()` 观察 Project 当前快照，并在提交前原子写 allowed audit。它只使用 v66 已授予 Run manager 的 `runs` 与 `run_cancellation_dispatches` SELECT，不增加 migration 或数据库权限。
4. 响应只包含固定低基数投影：五个状态计数、due 与 expired-lease 两个信号、四个 blocking-result 计数、最早 blocked 时间，以及 `clear|converging|attention_required` assessment 和 `none|wait|inspect` 建议。永不返回 Run/Attempt/Worker identity、lease owner/token/digest、PID、handle、命令、环境、Secret、日志或错误原文。
5. assessment 由服务端确定：存在 blocked 即 `attention_required/inspect`；没有 blocked 但仍有 pending/leased/retry_wait 即 `converging/wait`；否则为 `clear/none`。due 或 lease expiry 是 caller-driven 交付可接管信号，不单独把整个服务 readiness 标记为不可用。
6. `total` 必须等于五态之和，blocked 必须等于四种 blocking result 之和，due 不得超过 pending+retry_wait，expired lease 不得超过 leased，最早 blocked 时间必须与 blocked 是否存在一致且不晚于数据库观察时间。Repository 和客户端分别做 exact-shape 与交叉不变量校验。
7. Project ID 只用于请求作用域和响应绑定，不被设计为常驻时序指标标签。CLI、产品 UI 或告警适配器可以按需请求该固定快照；若未来导出 Prometheus，只能由部署侧选择 Project allowlist，不能让本协议隐式制造无界 label cardinality。
8. 代码继续内聚在现有 `cluster-postgres/run-management` 与 `cluster-admin/run-management` 子域。聚合、inspect、rearm 共享同一个 management repository 与 authority，不为一个查询再拆微包，也不把文件铺到 package 的 `src` 根目录。

## 被拒绝的替代方案

### 每个 cluster-control 副本维护内存指标

拒绝。副本重启会清零，多副本结果无法精确合并，blocked durable state 与进程 counter 可能永久分叉。

### 新建扫描器或 Prometheus 服务

拒绝。扫描 cadence 会与 caller-driven Worker delivery 竞争，并增加空闲 CPU、连接、部署对象和低配运维成本。

### 把 blocked 直接映射到 `/readyz` 失败

拒绝。blocked 是一个 Run 的身份或协议处置事实，不代表数据库、管理面或其他 Project 不可服务。全局 readiness 失败会触发无效滚动并掩盖真正处置目标。

### 返回 blocked Run 列表

拒绝。列表需要分页、稳定 cursor、更多 identity 泄漏与更宽 UI 状态。本阶段先提供固定聚合；operator 从 `inspect` 精确诊断已知 Run，后续产品 drill-down 必须另行设计有界索引契约。

## 资源、安全与部署影响

- Edge/Standalone 不依赖 `cluster-admin`、`cluster-postgres` 或 `pg`，默认与启用态均为零新增常驻开销。
- Cluster 只在 operator/产品调用时使用既有单连接 Run manager pool；没有后台采集、写放大或 idle I/O。
- Project 查询可利用既有 `runs(project_id, created_at_ms, id)` 与 dispatch `run_id` 索引，并受 5 秒 statement timeout、1 秒 lock timeout 和事务 idle timeout 约束；超限失败关闭，不降级为部分或伪造的健康结果。
- summary 只有 allowed/denied audit 写入，不修改 Run、Attempt、dispatch 或 RunEvent，不改变 `cluster-control` readiness。

## 验证

- Repository、service、transport 和客户端聚焦测试覆盖三态 assessment、计数交叉不变量、viewer `run.read`、强认证、原子 audit、Project 绑定、未知字段与 capability 泄漏拒绝。
- `cluster-postgres` 为 `341 pass / 0 fail / 3 conditional skip`，`cluster-admin` 为 `397 pass / 0 fail / 3 conditional skip`；完整 backend 为 `1,487 pass / 0 fail / 2 conditional skip`，18-package clean build/test 退出 0。
- package boundary、cluster dependency、Edge import 和 cluster deployment 四项审计零 finding；workspace 仍为 18 包，`singleSourcePackages=[]`、`shallowSourcePackages=[]`。
- `14/14` Local artifact audit 通过且字节与 D-365 相同：基础 Edge/Standalone `2,589,998 / 2,590,076`，Application+AI `4,493,151 / 4,493,283`。
- PostgreSQL 18.6 arm64 HA `145/145`：真实 `ql3_run_manager` 在 blocked 状态读取 Project summary，再继续 inspect、CAS rearm、production delivery、WAL replication 与 promotion；timeline `1→2`，报告 SHA-256 `d763157b3a781e305add3c6f0c5080820b1d65b5feefe60be6fa7006c0050107`，独立证据审计零 finding。

## 后续

产品控制台可把该 summary 渲染为 Project 级状态卡和告警入口，并通过单 Run inspect/rearm 完成 drill-down。CloudNativePG live failover、多副本容量压力、固定 Linux x64/arm64 和物理 Edge 资源证据仍是独立发布门；本 ADR 不把 Docker HA 或按需汇总冒充这些现场证据。
