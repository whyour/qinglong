# ADR-0045：Cluster HTTP Readiness、Admission 与 Drain

- 状态：Proposed
- 日期：2026-07-19
- 关联：QL-RFC-0001 D-36/D-37/D-39/D-43、ADR-0039、ADR-0040、ADR-0042、ADR-0044

## 上下文

仅有 database readiness 和 composition root，Kubernetes 仍无法区分“进程未启动”“正在审计 schema”“恢复未收敛”和“可以接收业务请求”。但如果先启动完整 API router，旧 schema、过度授权 role 或未完成 recovery 的副本可能在 ready 前产生副作用。

停止阶段也存在隐藏竞态：同步卸载 router 只能拒绝新请求，不能证明已经进入 handler 的请求结束。若随后停止 lifecycle、关闭 Repository/Pool，在途请求会与资源关闭竞争；若 handler 无视 Abort 却从 in-flight 集合移除，系统会伪报已 drain。

## 决策

### 1. Probe Listener 与业务 Admission 分离

只有显式 `enabled=true` 且 Profile 为 `cluster-control` 时才能绑定 HTTP listener。listener 可以早于数据库 readiness 启动，但此时只允许：

- `GET/HEAD /livez` 返回进程 listener 存活；
- `GET/HEAD /readyz` 返回 503 `not_ready`；
- `/api/v3` 在读取 request body 前返回 503。

只有 schema/history/role readiness、startup recovery 和全部 lifecycle 成功后，才原子安装 `/api/v3` admission handler，并让 `/readyz` 返回 200。readiness failure 必须关闭 listener 与数据库，不能回退 SQLite。

### 2. HTTP Surface 必须硬性有界

首个 host 使用 Node 核心 HTTP，不引入 Express 或 legacy Controller。固定上限覆盖：

- URL、header bytes/count、每 socket 请求数；
- JSON request/response bytes；
- in-flight admission 数；
- request timeout 与 shutdown drain timeout。

只接收 `/api/v3`、受限 method 和 JSON body；压缩 request、非法 length/content-type/JSON、超限 body/response 均返回稳定低敏错误。handler 异常不得把 SQL、连接 URI、Secret 或用户 payload 写入 response/diagnostic metadata。

### 3. Admission Disposer 是异步所有权边界

撤销 admission 的顺序固定为：

1. 同步清除全局 handler，使 `/readyz` 立即变 503，新 `/api/v3` 立即拒绝；
2. 向每个在途 handler 传播 AbortSignal；
3. 等待 handler 的真实 Promise settle，而不是只等待超时 response 已发送；
4. drain 成功后才允许 activation 停止 stack 和 Pool。

客户端可以在 request timeout 或 draining 时提前收到稳定 503/504，但该 response 不等于 handler 已结束。忽略取消的 handler 会产生显式 `ClusterControlAdmissionDrainTimeoutError`；activation 仍执行 best-effort 反向清理并报告失败，不能宣称 clean stop。

### 4. Runtime 配置先 Gate、后 Secret

公开 config loader 先读取 `QL_DEPLOYMENT_PROFILE` 与 `QL3_CLUSTER_CONTROL_ENABLED`。禁用时返回 disabled config，不读取 `QL3_POSTGRES_RUNTIME_URL`。启用时必须：

- Profile 精确为 `cluster-control`；
- 使用 runtime role opener，不导出 migration role 默认值；
- PostgreSQL TLS 默认 `verify-full`；
- 禁用 TLS 同时要求 `QL3_POSTGRES_TLS_MODE=disable` 与 `QL3_POSTGRES_ALLOW_INSECURE=true`；
- HTTP/Pool 参数全部在硬上限内。

application/config 导入闭包只能经过 `@qinglong/cluster-postgres/runtime`，不得加载 executable migration、Drizzle schema、legacy `back/**` 或 UI。

## 当前孵化状态

`@qinglong/cluster-control/http` 已实现 probe、bounded JSON admission、低敏错误、容量拒绝、request Abort 和真实 handler drain；`@qinglong/cluster-control/application` 已把 listener、readiness-first bootstrap、真实 PostgreSQL RunRepository、recovery/lifecycle/admission 和反向关闭串联；`@qinglong/cluster-control/config` 已实现 Profile-first、TLS-safe runtime 配置。真实 loopback tests 覆盖 starting not-ready、active admission、oversized/invalid request、handler error、容量耗尽、cooperative drain、non-cooperative drain timeout、readiness failure 和 listener/Pool 关闭顺序。

当前没有可公开的认证业务 router。`ClusterControlApplicationStack.handleAdmission` 仍是必须由后续 Identity/Policy/API vertical slice 注入的端口；在该实现、独立镜像和 PostgreSQL 16/18 远端证据完成前，cluster-control 继续 production unreachable。

## 影响

正面影响：

- Kubernetes 可以观察启动过程而不提前开放业务流量；
- readiness、admission 和数据库证据属于同一次 activation；
- 在途请求不会因同步 router removal 被误判为已排空；
- cluster host 不继承 legacy Express/Controller/Sequelize 依赖；
- URL/body/concurrency/time budget 可审计。

代价与风险：

- handler 必须响应 AbortSignal，并使自身副作用保持幂等/可恢复；
- 不合作 handler 会让 shutdown 显式失败或超时；
- 当前核心 HTTP adapter 只支持 bounded JSON，不覆盖 Artifact 流式下载、SSE 或 WebSocket；
- probe listener 早于 DB ready 存在端口占用，需要在启动失败时可靠关闭。

## 未选择的方案

1. **readiness 前启动完整 Express router**：业务中间件或 controller 可能提前产生副作用，拒绝。
2. **数据库 ready 后才监听任何端口**：无法区分启动中与进程死亡，也不能提供 liveness，拒绝。
3. **同步删除 router 后立即关 Pool**：忽略在途请求，拒绝。
4. **超时 response 即视为 handler 完成**：会伪造 drain 证据，拒绝。
5. **无界读取 JSON body 或 response**：放大内存和 DoS 风险，拒绝。
6. **默认明文 PostgreSQL**：破坏 cluster Secret/网络边界，拒绝。

## 验证

- disabled/错误 Profile 不监听端口、不打开 Pool、不读取数据库 Secret；
- readiness 期间 live=200、ready=503、API=503 且 body 不被读取；
- recovery/lifecycle 完成后 ready 与 API admission 同步开放；
- invalid/oversized body、超限并发和 handler error 返回稳定低敏响应；
- stop 先 ready=503，再等待真实 handler，之后 stack→Pool→listener；
- handler 忽略 Abort 时 drain timeout 可见且不得报告 clean stop；
- application/config import closure 不含 migration DDL、Drizzle schema 或 legacy 根；
- Node 24、PostgreSQL 16/18、x64/arm64 CI 继续通过。
