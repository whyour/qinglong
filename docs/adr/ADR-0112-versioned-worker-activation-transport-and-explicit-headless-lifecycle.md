# ADR-0112：版本化 Worker Activation Transport 与显式 Headless Lifecycle

- 状态：Accepted
- 日期：2026-07-23
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-85、D-108、D-109、D-110、D-111
- 关联 ADR：ADR-0013、ADR-0059、ADR-0061、ADR-0109、ADR-0110、ADR-0111

## 背景

ADR-0111 已把 delivery inbox 原位升级为执行 authority，但 Processor 仍只依赖抽象
activation port。控制面 `starting|running|start-failure` 此前直接返回内部
`RemoteRunActivationResult`，没有版本字段、exact shape 或 response byte 上限；Worker
若各自实现 Offer 和 Activation HTTPS，会重复 Agent、证书读取、超时和错误语义。生产
组合若在 import 时启动 poll timer，又会让默认关闭失效，并让低配路由器承担不可见的
常驻资源。

## 决策

### 1. Activation response 使用版本化 exact wire contract

`@qinglong/runtime-core/remote-activation-delivery` 定义
`qinglong/remote-run-activation@v1`，response 最大 16 KiB，固定为：

- `schema`；
- `status`：`applied|already_starting|already_running|already_terminal`；
- 完整 `snapshot`：Run/Attempt identity、status、Lease version/generation、callback
  sequence，以及受限的时间、executor、artifact 和 error 字段。

parser 拒绝未知字段、缺失 fence、未知状态、越界整数、控制字符、错误 schema、非法 JSON
和超限字节。Cluster ingress 必须先从内部结果构造受审 response；内部 repository 返回坏
projection 时映射为 503，而不是把不可信内部数据直接发给 Worker。

Worker request 不发送 `workerId/sessionId` body 字段，由认证路径绑定；Processor 的
event ID 也不跨 wire，控制面 service 继续生成数据库事件 ID。lease token 是必要的短期
capability，只出现在请求，永不出现在 response、日志或 activation snapshot。

### 2. Offer 与 Activation 共用一个 Worker ingress HTTPS authority

`WorkerIngressHttpsClient` 是 `worker-runtime` 同一 subpath 内的受限原语：

- TLS 1.3、mTLS、canonical `ql3w` authorization；
- 默认对唯一 origin 保持单 keep-alive socket，`maxSockets/maxFreeSockets=1`；
- 4 KiB request、调用方给定且不超过 128 KiB 的 response 上限；
- 只允许受审 Worker ingress path；拒绝重定向、压缩、非 JSON、非 200、错误长度和流式
  越界；
- 每次调用重新从同一 credential provider 取材，默认 Agent 使用包含 certificate、key 与 trust
  anchors 的 SHA-256 指纹作为不可变池键，不把随后清零的 TLS Buffer 内容作为池身份；临时
  certificate/key/body 副本在结束后清零，显式 `close()` 释放自有 Agent。Node 会在 socket
  回收时重新计算 HTTPS 池键，因此自定义受审 Agent 也必须保证池键不引用可变凭据 Buffer。

Offer transport 保留旧构造方式，同时允许注入共享 client。Activation client 只接受共享
client，不能隐式创建第二个 Agent。IP origin 不发送 SNI，DNS origin 才发送 servername。
集群型 Worker 若确有连接并发需求，可显式注入受审 Agent；该 Agent 必须按 origin 与凭据
generation 隔离连接、对排队和空闲连接设界，协议与 capability authority 不随规模变化。

### 3. Headless lifecycle 默认关闭且不拥有 timer

`WorkerRemoteExecutionHeadlessLifecycle` 只组合注入的 journal、Pull coordinator、
Processor 和当前 Session provider。模块 import 与 constructor 不取得 lock、不打开 socket、
不创建 timer；只有显式 `start()` 才取得唯一 journal ownership。

首次启动以最多 64 条一页、默认 16 条一 tick 的 keyset 分页扫描历史 inbox。完整扫描结束
前不 Pull 新任务。可继续的 `accepted|starting_acknowledged|launching|started|start_failed`
交给同一 Processor；任何既有或新产生的 `recovery_required` 都使 lifecycle fail closed，
后续 tick 不再 Pull。历史扫描完成后，每 tick 最多 Pull 一个 offer，并在同一显式调用中
交给 Processor。并发 tick 合并为一个 Promise。

`stop()` 先切换为 stopping、Abort 当前 Pull、等待 in-flight 工作结束，再释放 journal
ownership。lifecycle 本身不设置 drain timeout；最终部署组合根使用既有全局 shutdown budget
裁决超时，避免每个小组件各建 timer。

### 4. Profile 与包边界不变

本决策不新增 workspace package。wire contract 位于 runtime-core subpath；共享 HTTPS、
Activation adapter 与 lifecycle 位于既有 worker-runtime remote-offer-delivery subpath。
Worker 根入口继续不导出或 eager-load 网络、journal、runtime-core 与 Executor 组合。

本 ADR 只开放可测试的生产组合 seam，不启用默认 Remote Worker 执行。Secret/Artifact/log
materializer、具体 Executor、completion/lease-loss/cancellation/retry/recovery authority 未闭合
前，Profile 入口不得自动调用 `start()`。

## 被否决的替代方案

1. **直接返回内部 activation object**：没有版本、exact shape 和内部坏数据隔离。
2. **Offer 与 Activation 各建 HTTPS client**：重复 Agent、证书 authority 与资源预算。
3. **把 Worker/event identity 全放 body**：形成路径、认证 Principal 与 body 三份可漂移身份。
4. **lifecycle constructor 自动启动 interval**：禁用后仍有 timer/lock/socket，破坏 Profile
   可裁剪性。
5. **启动扫描未完成就 Pull**：可能在后页已有 ambiguous spawn 时继续接收新工作。
6. **为 activation transport 或 lifecycle 新拆 package**：没有独立部署、权限或供应链责任，
   只会回退 ADR-0087/0106 的 package 收敛。

## 影响与剩余门禁

已完成：版本化 activation response、严格 parser、Cluster ingress 投影、共享单 Agent 的
Offer/Activation client、真实 TLS 1.3 mTLS exchange、authority mismatch/unknown field/size
负向测试，以及显式 ownership、分页 startup reconciliation、tick coalescing、Abort-before-
release 与 recovery fail-closed lifecycle。

ADR-0113 已完成有界 Secret/Artifact/log materializer seam 与 log identity handoff。仍未完成：
受审的具体 Secret/Artifact provider、具体 Executor、completion transport、
heartbeat/certificate/lease renewal 组合、lease-loss 与 cancellation/retry recovery、终态 inbox
retention/GC、Profile shutdown 总预算，以及 Edge/集群节点长期资源与故障注入证据。因此默认
Worker 入口仍关闭远端执行。

## 验收证据

1. activation contract round-trip，并拒绝 schema drift、未知字段、空终态 snapshot 和超限响应。
2. Offer 与三种 activation 请求观察到同一 Agent；event ID、Worker path identity 不进入 body。
3. 真实回环 server 只接受 TLS 1.3 受信 client certificate，并观察 canonical Worker credential。
4. lifecycle 未 `start()` 时零副作用；启动扫描未完成或存在 recovery 时 Pull 调用数为零。
5. 并发 tick 合并；stop 的顺序为 Abort Pull、等待、释放 owner。
6. workspace package 数不增加，默认 Worker root import 仍不加载 remote execution subpath。
