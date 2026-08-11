# ADR-0230：Cluster Workflow 复用单一 Scheduler cadence

- 状态：Accepted
- 日期：2026-07-30
- 关联 RFC：QL-RFC-0001 D-18、D-19、D-71、D-104、D-118、D-207、D-212—D-214
- 关联 ADR：ADR-0105、ADR-0118、ADR-0125、ADR-0225—0229

## 背景

Cluster 已有完整的 PostgreSQL Workflow admission、frontier、generation-bound
Task Attempt admission、Remote Worker lease/activation/completion 和取消收敛
repository，也已有正式 `cluster-control` production process、唯一 cron scheduler
lifecycle 与独立的全局 cancellation lifecycle。

此前 frontier 和 Task Attempt admission 只由测试或外部 caller 直接驱动，生产
Scheduler cadence 没有调用它们。结果是合法 Workflow 可以停在 admitted 或 ready，
无法自动进入 Remote Worker dispatch。另建 Workflow package、timer、连接或进程会
扩大多副本资源成本，也会与 D-207 的 package 边界规则冲突。

## 决策

### 1. 在既有 Scheduler cadence 中组合，不新增 lifecycle

新增无 timer 的 `ClusterWorkflowSchedulerCoordinator`，由既有
`ClusterSchedulerLifecycle` 持有。每轮固定执行：

1. 普通 cluster cron schedule；
2. Workflow frontier；
3. Workflow Task Attempt admission。

整体 Workflow cancellation 继续由既有单一全局 cancellation lifecycle 承载。它与
Scheduler 是不同的故障域，不为每个 Workflow 或 Step 创建 timer。

### 2. 所有扫描都必须有硬上限

frontier 与 Task Attempt admission 均固定为 32 条一页、每轮最多 4 页。单轮每阶段
最多观察 128 个候选，页内串行执行。repository 返回超过 page size 的结果或不前进的
continuation 时立即失败关闭。

同一 cadence 的重入请求复用当前 in-flight promise，不允许重叠扫描。任一阶段失败时
不伪造后续成功；durable 已提交事实由下一轮 exact replay 收敛。

### 3. 复用同一 Pool，但保持 repository 能力入口最小

组合根复用 readiness 后的同一个 runtime Pool，不创建额外 Pool 或长连接。Workflow
frontier 与 Task Attempt repository 仍只能从
`@qinglong/cluster-postgres/plugin-package-workflow-frontier` 和
`@qinglong/cluster-postgres/plugin-package-workflow-task-attempt-admission` 两个显式
子路径导入，不进入宽泛的 `/runtime` 聚合出口。

这使 production composition 能使用所需能力，同时保留入口级权限审计。常驻
`ql3_worker_ingress` 仍不获得 Run、Attempt、Lease mutation authority。

### 4. 启动与停止顺序不变

production bootstrap 仍按 readiness → recovery → application lifecycle →
Scheduler/cancellation lifecycle → admission 开放。停止时先撤 admission，再 drain
cancellation、Scheduler、application，最后关闭 Pool 和 listener。

Workflow coordinator 不拥有 listener、watcher、queue、per-Workflow state 或
stop hook，因此不会增加新的停止竞态。

## 不采用的方案

### 新建 `cluster-workflow` workspace package

拒绝。它没有独立部署、权限角色或重依赖边界，只是现有 control cadence 与两个显式
repository port 的组合。新包只会增加单文件 importer 和发布审计成本。

### 新建第二个 Workflow scheduler timer

拒绝。多副本下会增加唤醒、扫描与 shutdown 顺序；既有 Scheduler lifecycle 已提供
非重叠、诊断隔离、`unref` 与有界 drain。

### 把 repository 加入 `cluster-postgres/runtime`

拒绝。宽聚合出口会让不需要 Workflow admission authority 的 runtime importer 也能
取得这些实现。显式 subpath 能在不拆 package 的情况下保持能力隔离。

### 让 Worker ingress 直接推进 frontier 或创建 Attempt

拒绝。Worker ingress 只负责认证后的内部 transport，不应获得控制面 Run mutation
权限；frontier 与 admission 是 runtime-role 的数据库权威。

## 当前验证

1. coordinator 行为测试覆盖两页 frontier/Task admission、created/existing 计数、
   重入 coalescing、停滞 continuation 和非法上限，3/3 通过；
2. production bootstrap 测试启动真实既有 250 ms Scheduler lifecycle，观察到
   schedule → frontier → Task Attempt 三段扫描，并完成 connection release 与
   stop-and-drain；
3. `cluster-control` 全量 145 项为 143 pass、2 条外部服务条件 skip、0 fail；
4. `cluster-postgres` 全量 238 项为 237 pass、1 条真库条件 skip、0 fail；显式
   repository subpath 隔离测试通过；
5. Linux arm64 Node 24.18.0 `cluster-control-ci` 门在 512 MiB、2 CPU、256 PID、
   零 swap、非 root、只读 root/workspace 下通过；模块加载 RSS 增量
   `23867392` bytes，memory/OOM 事件增量为零；
6. `QL3_HA_SKIP_IMAGE_PULL=true` 的 PostgreSQL 18.4 arm64 HA 门通过
   `remote_apply`、timeline 1→2、旧主 fencing、两个 fresh control replica、
   `pg_rewind` 只读同步重入，以及 Workflow admission/frontier/Task
   Attempt/cancellation 的复制与晋升后重放；总 `gates.passed=true`；
7. workspace 仍为 20 个 package，没有新增 migration、表、生产依赖、timer、
   watcher、listener、Pool 或数据库连接。

## 尚未关闭

1. Worker ingress production process/deployment 与内部 runtime capability port
   已由 ADR-0231 关闭；
2. Remote Worker expiry/retry 的生产 lifecycle 与部署启动装配；
3. Cluster Secret provider、真实 Kubernetes 多 Pod 分区、operator/proxy、STONITH
   与容量证据。
