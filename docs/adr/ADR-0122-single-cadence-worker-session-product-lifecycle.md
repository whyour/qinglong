# ADR-0122：单 Cadence Worker Session 产品生命周期

- 状态：Proposed（exact wire、共享 client、Session coordinator、capacity oracle、product/process composition、credential material provider 与单身份部署基线已实现；远端 credential recovery、真实 Cluster 全链、Linux/固定设备证据仍是发布 Gate）
- 日期：2026-07-23
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-14、D-85、D-108、D-120、D-121
- 关联 ADR：ADR-0012、ADR-0057–ADR-0061、ADR-0108、ADR-0110、ADR-0112、ADR-0121、ADR-0123、ADR-0234

## 背景

本 ADR 提出时，Cluster Control 已在独立 mTLS/`ql3w` ingress 上提供 Worker Session 的
`register|heartbeat|transition` 路由，PostgreSQL repository 也已拥有 generation/version/lease
fencing，但 route 仍直接解析手写 JSON，Worker Runtime 也没有 Session client。当前增量已用共享
runtime contract 和 Worker product composition 收敛这两处缺口；后续 Gate 仍不得回退到第二套协议。

旧 `back/runtime/application/workerHeartbeatLifecycle.ts` 只用于早期单控制面孵化：它依赖 legacy
Worker domain，自建 heartbeat timer，并由另一个 `HeadlessWorkerRuntime` 拼接 execution drainer。
ADR-0121 已建立单 journal owner、单 mTLS Agent 和单 Profile cadence 的 production execution plane。
直接复用旧 lifecycle 会重新产生两套 Session shape、两个 timer、两个 client ownership，并可能在
Session offline 或 Agent close 后仍留下需要 completion/lease supervision 的本地进程。

## 决策

### 1. Session wire 必须 exact、versioned 且 path-bound

在现有 `@qinglong/runtime-core` 增加一个懒加载 Session transport subpath，不新增 package。三个
request/response schema 固定为：

- `qinglong/worker-session-register@v1`；
- `qinglong/worker-session-heartbeat@v1`；
- `qinglong/worker-session-transition@v1`。

Worker/Session identity 只来自既有 path；body 不重复 principal，也不携带 credential。register request
最多 20 KiB，以容纳 16 KiB canonical capability snapshot；heartbeat/transition request 与所有 response
最多 4 KiB。未知字段、未知 schema、非 canonical capability、generation/version/status/lease 漂移均
fail closed。register 的 replacement fact 只在 response 中表达，HTTP status 保持统一且可重放的 200。

Cluster ingress 必须调用 contract parser/serializer，不再维护第二套 ad-hoc key list。现有认证和耐久
audit 仍先于 body；PostgreSQL repository 仍是 generation、version 和数据库时钟的唯一 authority。

### 2. Session 与 execution 必须共享一个 HTTPS client/Agent

Session adapter 留在 `@qinglong/worker-runtime`，并消费 ADR-0121 的同一个
`WorkerIngressHttpsClient`。不得为 register/heartbeat/transition 创建第二个 Agent、第二套 credential
provider 或独立 socket budget。client path allowlist 扩展必须精确到三个 Session operation，不放宽
Artifact stream 或通用 URL。

credential provider 仍在每个请求前惰性加载 certificate、private key、trust 与 `ql3w` token；本 ADR
不允许把这些材料复制进 Session journal。ADR-0123 已实现 active certificate + 原子 token 文件的具体
读取/轮换消费与 Buffer dispose；Session transport 已把 401/403/409 分为 credential rejected/session fenced，
使 Pull 立即暂停并允许同一 Session 在 token 修复后 heartbeat 恢复。远端 credential issue/revoke/recovery、
delivery acknowledgement 和管理面失败编排仍是后续 Gate，缺失时 product bootstrap 保持默认关闭。

### 3. Session coordinator 不拥有 timer

新增 caller-driven Session coordinator，只拥有以下显式操作：

1. `register()`：生成新 UUIDv7 Session，提交 canonical capability 与初始 capacity；
2. `tick(now)`：仅在到达 heartbeat due time 时提交一次 heartbeat，禁止重叠；
3. `beginDrain()`：持久化 `draining + availableSlots=0`；
4. `disconnect()`：只在 execution plane 已证明 settled 后持久化 `offline`。

它不得调用 `setTimeout/setInterval`。ADR-0121 的唯一 Profile cadence 同时驱动 Session due check 和
execution tick；Edge/Node 可使用不同 cadence，但 heartbeat 频率独立受 5 秒–5 分钟硬边界约束。临时
transport failure 只能在现有 lease 内由后续 cadence 重试；fence、credential rejection 或本地已观察
lease expiry 必须立即停止 Pull，不能自动用新 Session 接管旧 Session 下仍活动的 execution。

### 4. Capacity 必须来自单一 execution oracle

部署不得注入与 journal 无关的任意 available-slots 数字。production composition 必须从同一 owner
journal、当前 in-flight Pull reservation 与最大并发预算派生 `availableSlots`，范围始终为
`0..maxConcurrentRuns`。startup reconciliation 未完成、recovery required、draining 或 Session
unavailable 时必须为 0。

能力快照使用 runtime-core 的 canonical Remote Worker capabilities；capability JSON/hash、Profile、
架构、Runtime 和 Executor 不能由 HTTP response 临时改写。Edge 默认并发与 page 更小，Node 可提高
有界预算；两者都不增加 per-Run timer 或 socket。

### 5. 启停顺序由一个 product composition root 拥有

启动顺序固定为：

1. disabled/Profile/config gate，且 disabled 在读取路径和 credential 前返回；
2. 创建单 credential provider 与单 HTTPS client；
3. 取得 journal owner并完成全部有界 startup reconciliation；
4. 只有无 recovery fact 才注册 Session，并发布由 execution oracle 计算的 capacity；
5. 启动唯一 `unref` Profile cadence，之后才允许 Pull。

关闭顺序固定为：

1. execution `beginDrain()` 先 Abort Pull，但保留 journal owner与 shared Agent；
2. Session `beginDrain()` 在控制面耐久写入 0 capacity；
3. 唯一 cadence 继续 heartbeat 与 completion-first supervision；
4. 所有 inbox record settled 后才 transition `offline`；
5. 最后释放 journal owner、关闭 transport 与 shared Agent。

drain timeout、Session fence、heartbeat lease expiry、offline 失败或 recovery fact 都不得强制 close。
进程仍有可能产生 completion 时，不能为了满足 shutdown 时限丢弃唯一 owner。等待 shutdown proof 的
timer 必须保持 ref；只有常驻 cadence unref。

## 被否决的替代方案

1. **直接复用 `back/**` heartbeat lifecycle**：引入 legacy domain、第二 timer 和第二 shutdown owner。
2. **Session 与 execution 各建一个 HTTPS client**：重复证书、Agent、socket 与 credential rotation 状态。
3. **每 500 ms 都发 heartbeat**：Node cadence 会把副本和路由设备的空闲成本放大。
4. **先 register available 再做 startup recovery**：控制面会把未证明安全的 Worker 当成可调度候选。
5. **drain timeout 后 offline/释放 owner**：把预算耗尽伪装成副作用已经停止。
6. **允许部署直接上报 availableSlots**：容量与本地 durable execution authority 可漂移。
7. **为 Session lifecycle 新建 workspace package**：没有独立部署、依赖或权限责任，违反 D-85。

## 验收 Gate

1. runtime exact contract 覆盖三个 schema、byte cap、unknown field、authority drift 与 canonical capability。
2. Cluster ingress 继续证明 auth/audit-before-body，并以 PostgreSQL 16 最小权限角色验证完整 fence/replay。
3. Worker 真实 TLS 1.3 测试在同一 Agent 连续执行 register、heartbeat、Offer、completion 与 transition。
4. startup recovery 前零 register；recovery required 时零 Session/零 Pull。
5. 单 cadence、heartbeat due coalescing、in-flight 不重叠和本地 lease expiry fail closed 有确定性测试。
6. shutdown 证明 drain capacity 0 → execution settled → offline → owner/Agent release；所有失败路径保留 authority。
7. Edge/Node 固定设备资源证据证明没有新增 package、数据库、per-Run timer 或第二常驻 socket。

## 当前实现证据

1. `@qinglong/runtime-core/worker-session-transport` 已提供三个 exact v1 schema、20 KiB/4 KiB
   request cap、4 KiB response cap、canonical capability 与 authority drift 校验；Cluster ingress 已复用
   parser/serializer，并继续在 body 前完成认证与耐久 audit。
2. `@qinglong/worker-runtime/session-transport` 和 `/session-lifecycle` 已在同一
   `WorkerIngressHttpsClient` 上实现 register/heartbeat/transition；coordinator 无 timer、请求串行、按 due
   heartbeat，并在本地 lease expiry 后停止暴露可执行 Session。
3. `WorkerExecutionCapacityOracle` 只读取 owner journal 与 durable pending claim；reconciling、draining、
   recovery 和 offline 一律发布 0，不接受部署直接注入 slots。
4. `@qinglong/worker-runtime/product` 在 startup reconciliation 后注册 Session，复用 execution 的唯一
   cadence；真实 TLS 1.3 测试证明 register → draining → offline 共用一个 socket/Agent，且历史未结算
   journal 在零 register 时失败关闭。
5. 确定性顺序测试证明 Session tick 与 execution tick 不重叠，shutdown 按 execution drain → Session
   drain → heartbeat/supervision → offline → owner/transport release 收敛，并覆盖 offline 后 owner release 首次
   失败的幂等重试。当前 Worker 129/129；D-218 本切片未改动共享 contract 或 Cluster
   ingress，后者继续由 D-216/D-217 的完整回归与 PostgreSQL HA 门覆盖。
6. ADR-0234 已增加 `ql3-worker` production binary、disabled-before-secret process config、
   direct-file identity bootstrap、持久 certificate store、信号先行和 incomplete-drain 持续持权；
   独立 Worker 镜像闭包为 3 个 workspace package/24 个 runtime external，Kubernetes 固定
   单身份单副本、Recreate、PVC 和 projected authority 私有物化。产品入口仍必须由明确
   Worker Profile 配置激活，不能由其他部署默认开启。
7. macOS arm64/Node 24.18 真实进程+mTLS资源门测得 edge active/peak
   `67,616,768/71,090,176` bytes、node `67,911,680/71,286,784` bytes，均为一个
   TLS 1.3 socket并完成 register/drain/offline；64 MiB 被明确否决，edge 暂按至少
   96 MiB 规划。尚未完成 Gate：真实 Cluster ingress/PostgreSQL 全链、
   credential issue/revoke/recovery、Linux image/cgroup 与固定设备断网/休眠/断电证据。
   因此本 ADR 与 D-121 仍保持 Proposed。
8. 历史 23 package dependency/source audit 为 `findings=[]`，Edge import audit 为 `compatible=true`；六种本机
   制品均通过 pack/offline install/import，最大 standalone-application 为 2,474,124 bytes、411 files、
   72 loaded modules，且制品闭包不包含 `@qinglong/worker-runtime`。runtime-core 新 contract 使本机制品比
   D-120 快照增加两个文件，作为“不新增细碎 package”的显式可见成本保留。
