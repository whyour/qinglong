# ADR-0109：PostgreSQL Remote Run 原子启动 ACK

- 状态：Accepted
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-23、D-57、D-107、D-108
- 关联 ADR：ADR-0013、ADR-0014、ADR-0057、ADR-0058、ADR-0108

## 背景

ADR-0108 已让认证 Worker 用稳定 `offerId` 和自己持有的高熵 lease capability 领取经过 Placement 的 Execution Offer，但 claim 只证明某个 Session 暂时拥有 Attempt。若 delivery、Worker 收包或 spawn 被直接解释成 running，控制面就无法区分“尚未接受”“正在建立执行器”和“已取得可恢复 handle”三个崩溃窗口。

QingLong 3.0 还必须同时服务低配路由设备和集群节点。ACK 协议不能要求 Worker 维持额外 stream、服务端 mailbox 或 per-run timer，也不能为了三个短命令再增加 workspace package。多副本控制面则必须让 Worker Session、Run Lease、Run、Attempt 和 Event 在同一个 PostgreSQL authority 下裁决。

## 决策

### 1. 三个 ACK 是独立、认证且有界的命令

Worker ingress 增加 `starting`、`running` 和 `start-failure` 三个显式操作。transport 先绑定 credential principal 与路径中的 `workerId/sessionId`，完成 durable security audit 后才调用注入的 activation port。请求体不能自报 Worker ID，响应不得回显 lease token 或 callback token digest。

每个命令必须携带 Run、Attempt、Session generation、offer ID、lease generation、lease token 和 expected lease version。`running` 还必须携带最多 512 字节的稳定 executor handle、可空的 log artifact ID、callback sequence 和 lowercase SHA-256 callback token digest。所有字符串都有固定上限；协议不建立常驻连接、队列、timer 或新增 package。

### 2. PostgreSQL 是唯一启动状态 authority

每个 ACK 使用一个短事务，并按 Attempt advisory fence、Worker Session、Run/Attempt、Run Lease 的固定顺序加锁。完成锁定后才读取 PostgreSQL statement time，并验证：

- Worker Session 仍是同一 session/generation，状态为 `online|draining` 且 lease 未过期；
- Run 为 runtime-owned，Attempt executor type 为 `remote_worker`；
- Run Lease 与 Attempt 投影中的 worker/session/generation/offer/generation/token digest/version 完全一致；
- 非终态 ACK 的 Lease 仍为 leased 且按数据库时间未过期。

Worker 的本机时钟不进入 Run/Attempt 时间事实。任何 fence、状态或重放元数据漂移都以低基数 conflict 失败，事务内任何 SQL 失败都回滚全部状态和 Event。

### 3. starting 与 running 具有不同提交边界

首次 `starting` 只把 Attempt 从 `claimed` 推进为 `starting`，Run 保持 `dispatching`，并追加一条 `attempt.starting` Event。完全相同 authority 的重放返回 `already_starting`；若已正确 running，迟到 starting 返回 `already_running`。

首次 `running` 要求 Attempt 已 starting，并在同一事务中：

- 把 Attempt 与 Run 推进为 running；
- 使用数据库时间写两者的 started time；
- 固化 executor handle、可选 log artifact、callback sequence 与 callback token digest；
- 连续追加 `attempt.running`、`run.running` 两条 Event。

running 不推进 Run Lease version；renewal 仍是 active Lease version 的唯一推进者。重放只有在 handle、artifact、callback sequence、callback digest 和完整 Lease authority 都一致时才返回 `already_running`。

### 4. start-failure 原子终结并关闭晚到回调

首次 `start-failure` 只接受 starting/dispatching，并在同一事务中：

- 按 cancellation fact 选择 `failed|cancelled|timed_out`；
- 写固定错误码与低敏摘要；
- 推进 callback sequence，关闭晚到 completion receipt；
- 终结 Attempt 与 Run，追加两条对应 Event；
- 将 Run Lease 标记 completed 并推进 version，同时更新 Attempt 的 lease version 投影。

普通失败使用 `EXECUTOR_START_FAILED`；已有普通取消使用 `EXECUTION_CANCELLED`；timeout 取消优先使用 `EXECUTION_TIMED_OUT`。丢失成功响应后的 retry 允许同一原始 expected version 精确命中 `completed version = expected + 1`，但仍必须证明同一 token、offer、Session、generation 和终态映射；否则拒绝，且绝不重复 Event。

### 5. 权限与包边界不扩大

contract 放在 `@qinglong/runtime-core/remote-activation`，PostgreSQL adapter 放在既有 `@qinglong/cluster-postgres/runtime`，应用服务放在 `@qinglong/cluster-control/remote-activation`。总包数保持 23。

独立 Worker-ingress application 只持有注入 port，且 `ql3_worker_ingress` role 继续没有 Run、Attempt、Run Lease mutation 权限。权威事务由受审 runtime role 执行；transport 与 runtime 的产品装配仍必须显式建立受保护的内部边界，不能让 HTTP handler 临时获取 runtime Pool。

## 被否决的替代方案

1. **claim 或 delivery 后直接标记 running**：无法证明执行器已建立，也无法安全恢复 handle。
2. **信任 Worker startedAt**：不同路由器和集群节点的时钟漂移会污染权威顺序。
3. **只校验 token，不校验 offer/session/version**：旧 Session、renewal 前请求或 ABA Lease 可以迟到覆盖。
4. **running 只保存 handle，不保存 callback digest**：后续 completion 与 recovery 无法证明同一回调 capability。
5. **给 worker-ingress role 表级写权限**：认证 transport 会获得绕过应用 fence 的宽 Run mutation authority。
6. **为 ACK 新增 package、队列或 stream**：没有新的发布/权限/平台边界，却会扩大低配安装闭包和常驻资源。

## 影响

正向影响：

- offer、starting、running 和 start-failure 成为可区分、可恢复的 durable facts；
- 多副本 ACK、renewal、Session replacement 和 cancellation 在同一数据库 authority 下竞争；
- 明文 lease/callback capability 均不落库、不进 Event、不出现在响应；
- 路由设备只需三个短请求，集群 Worker 可按自身并发扩展，服务端不保留 per-worker 内存状态；
- 不新增 migration、package 或 edge/standalone 依赖。

仍未完成：

- 认证 ExecutionSpec delivery 与 Worker durable admission 已由 ADR-0110 完成；仍缺 package inbox 到执行 Receiver 的单 journal 状态迁移，以及 Artifact/log/completion transport；
- PostgreSQL completion、lease expiry/lost、cancellation/retry 的对等远端生命周期；
- runtime ACK port 与独立 Worker listener 之间的生产内部调用边界、过载保护和 telemetry；
- 多 Pod/failover、PostgreSQL 18、真实路由设备网络抖动和断电证据。

因此 ACK 门禁已经完成，但 Pull/Remote Worker 仍不默认进入生产组合根。

## 验收证据

1. runtime contract 拒绝越界 handle、非法 callback digest、弱 lease capability 和不完整 fence。
2. cluster-control 测试证明服务端生成 Event ID、principal/session 绑定、三个认证 ingress operation、冲突映射以及响应不回显 capability/digest。
3. PostgreSQL 16.10 真实实例以独立 migration/runtime/worker-ingress role 验证 Pull offer、digest-only 丢响应恢复、starting/running 精确重放、启动失败与 timeout 优先终态；Run/Attempt/Lease/Event/callback fence 原子提交且 token 明文不落库。
4. `ql3_worker_ingress` 保持原最小权限；ACK repository 只从 runtime entrypoint 导出。
5. 23 个 package clean build/全量测试、backend 兼容回归、cluster/edge dependency audit、六档本地 Profile 制品与 GitNexus change detection 全部通过；制品最大 2,346,992 bytes/395 files、最大抽样 RSS delta 12,419,072 bytes，QL3 production importer 为 0 high/0 critical。GitNexus 对已跟踪 diff 为 LOW/0 affected process；当前 QL3 孵化树仍是未跟踪文件，因此该结果只作补充证据。
