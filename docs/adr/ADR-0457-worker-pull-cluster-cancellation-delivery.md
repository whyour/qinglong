# ADR-0457：Worker 拉取路径上的 Cluster 取消交付

- 状态：Accepted
- 日期：2026-08-19
- 关联 RFC：QL-RFC-0001 D-364、PR-5、PR-7
- 关联 ADR：ADR-0005、ADR-0117、ADR-0238、ADR-0456
- Amends：ADR-0005 的 Cluster 生产组合边界、ADR-0456 的后续拓扑描述

## 上下文

ADR-0456 已建立数据库计时、可接管且 capability 不落库的 PostgreSQL CancellationDispatch，但没有决定由哪个生产入口完成真实 Worker 停止交付。现有 Remote Worker 已通过认证 ingress 持有精确的 Session、RunDispatchLease、Attempt 和 lease fence，并以 caller-driven lease-control tick 获取续租或停止结果。另建 cluster-control 扫描 timer 会产生第二调度 authority；由 cluster-control 直接控制远端 PID 又会违反 ADR-0117 的 Worker 本机执行边界。

Run 取消与 Workflow Task timeout 还存在语义差异：前者具有 `Run.cancel_requested_at_ms`，应进入 durable CancellationDispatch；后者只终止当前 StepRun/Attempt，不得伪造父 Run 取消事实。

## 决策

1. `ClusterRemoteWorkerCancellationDispatchControl` 包装既有 `ClusterRemoteWorkerLeaseControlService`，而不新增扫描器。Worker 每次已认证的 lease-control 请求仍是唯一触发入口。
2. `renewed`、`terminal` 等非停止结果完全绕过 CancellationDispatch。只有既有 lease-control 已产生精确 `stop_requested` 时，包装层才以同一 Run/Attempt 和停止时间 claim PostgreSQL CancellationDispatch。
3. `claimed` 必须先以 `termination_requested` 原子结算 dispatch 与 `run.cancel_dispatched` 事件，验证 durable 结果后才向 Worker 释放原 `stop_requested`。Worker 随后在本机复验 durable handle 并执行停止；cluster-control 不接触 PID、进程组或本地 journal。
4. `dispatched` 是可重放成功，直接释放相同停止结果；`leased` 与 `not_due` 表示另一副本仍拥有交付权，当前请求失败关闭并撤回可用性；`blocked` 同样失败关闭并进入低敏错误观察面。
5. `not_eligible` 保留原停止结果，但仅记录 `untracked`。这是 Workflow Task timeout 或终态竞态的受审路径：不得为了统一表象写入不存在的 Run 取消意图。
6. dispatch owner 复用 cluster-control recovery runtime 的稳定 replica owner ID。lease/event capability 默认由 CSPRNG 生成；生产回调只发布固定状态、错误 code 和 scope，不包含 Run、Worker、Attempt、token、错误原文或数据库细节。观察与诊断回调不是 authority，失败不得改变控制结果。
7. 不新增 lifecycle。Worker ingress 已在 cluster-control shutdown 中先停止接收并 drain in-flight 请求，随后既有 application runtime 才停止 scheduler/recovery 并关闭数据库；包装层不拥有 timer、listener、queue、connection 或后台 Promise。
8. 包能力只从 `@qinglong/cluster-control/cancellation-dispatch-control` 显式子路径发布；不扩大 runtime-core 根入口、不新增 workspace package 或生产依赖。

## 被拒绝的替代方案

### 新建 CancellationDispatch 扫描 cadence

拒绝。它会与 Worker lease-control 形成双触发面，无法证明扫描 owner 与实际持有 RunDispatchLease 的 Worker 是同一执行权，并增加 timer、分页游标和 shutdown 协调成本。

### cluster-control 直接终止远端进程

拒绝。远端 durable handle、PID namespace 和本机进程身份只对 Worker 可验证。控制面只能交付停止意图，不能越过 Worker 执行边界。

### Workflow Task timeout 伪装成 Run cancellation

拒绝。它会错误终止父 Workflow，并污染 Run 事件与取消审计。`not_eligible + untracked` 是有意的语义分支，不是漏记。

### 先返回停止，再异步补记 dispatch

拒绝。进程或节点在响应后崩溃会留下不可证明的副作用；durable settlement 必须先于停止响应。

## 资源、安全与部署影响

- Edge/Standalone 闭包不变化，也不引入 `pg`；Cluster 复用现有连接池、HTTP/mTLS ingress 和 Worker cadence。
- Cluster 每次 Run-level 停止最多增加既有 claim/result 短事务，无空闲扫描、常驻内存、端口、Kubernetes 对象或新连接。
- 多副本 winner 仍由 PostgreSQL owner/token/version fence 决定；HTTP 重放只能得到 durable `dispatched`，不能生成第二个结果事件。
- 数据库不可用、外国 live lease、retry 未到期或 blocked 时不释放停止响应，避免把未记账副作用表述为已交付。

## 验证

- 新增包装层契约 `8/8`，覆盖续租旁路、settle-before-stop、重放、foreign lease、blocked、Workflow timeout、结果失败与配置失败。
- cluster-control 完整包 `269 pass / 0 fail / 2 conditional skip`；生产 process 回调只输出低敏枚举和稳定错误 code。
- 完整 backend `1,487 pass / 0 fail / 2 conditional skip`（总计 1,489）；18-package clean/build 与顺序测试单次退出 0。
- package boundary、Edge import、cluster dependency、cluster deployment 与 service-manager bridge import 审计均通过；workspace package 仍为 18，`cluster-control` 新文件位于 `remote-execution` 子域，根目录计数不变。
- `14/14` Local Profile artifact audit 通过；基础 Edge/Standalone 保持 `2,589,998 / 2,590,076` bytes，闭包不含 `pg` 或 Cluster package。
- PostgreSQL 18.6 arm64 HA 门 `144/144`：原双连接单 claim、租约接管、stale fence、retry due、WAL/promotion 证据保留，并新增真实 cluster-control 包装层 `termination_requested` settle-before-stop；timeline `1→2`，报告 SHA-256 为 `4313b405c2ea56a3d44bc4907d5299b6e5c0d3062bb9c9f1522749d1021bd462`。

## 后续

仍需用户可见的 blocked/availability 指标、诊断与人工处置入口，以及 CloudNativePG live failover、多副本容量压力、固定 Linux x64/arm64 与物理 Edge 资源门。Local legacy raw-token 存量迁移继续保持独立议题。
