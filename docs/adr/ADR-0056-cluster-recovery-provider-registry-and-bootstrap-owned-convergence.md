# ADR-0056: Cluster Recovery Provider Registry 与 Bootstrap-Owned Convergence

- 状态：Proposed
- 日期：2026-07-19
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-25、D-37、D-39、D-42、D-52 至 D-55

## 上下文

ADR-0055 已规定只有 durable pre-start 事实或可信 `not_running` 证据才能推进 `lost`，但 processor 仍接受一个任意 evidence provider，cluster bootstrap 仍把 raw recovery source/claim/transition repository 交给 application，并相信 application 自己编排恢复。这个边界有三个问题：

1. application 可以使用 wildcard/default provider，把未知 Executor 当成某个已知实现；
2. provider 可以看到 recovery owner/token，或因 timeout 后被反复调用而积累无界悬挂探测；
3. application 持有 raw claim/mutation authority，bootstrap 只能事后 verifier，无法证明执行过受审的标准 recovery 链。

此外，LocalProcess、Remote Worker、Container 与 Kubernetes 的执行身份位于不同 authority。cluster-control Pod 上的 `/proc` 不能证明 Worker 节点上的进程状态，Worker offline、HTTP timeout 或 Kubernetes API 暂时不可用也不能证明执行已经停止。

## 决策

### 1. Provider registry 只做 exact executor-type 路由

runtime-core 提供有硬上限的 `ClusterControlRecoveryEvidenceRegistry`：

- 最多注册 32 个 provider，不接受 wildcard、重复或不规范 executor type；
- 每个 provider 必须声明至少一个 required identity 字段：`workerId`、`executorHandle`、`pid`、`leaseToken`；
- Run ID、Attempt ID、Attempt 状态、executor type 与 callback sequence 始终属于 probe target；
- 缺失 provider、缺失 required identity 或畸形 target 返回 `identity_unverifiable`，进入 manual，而不是尝试其他 provider；
- provider 注册时绑定 `inspect` capability，后续修改注册对象不能改变已安装 authority；
- provider 只收到冻结的 probe target、相对 timeout 和 `AbortSignal`，不接收 recovery owner、claim token/version，也不取得 start/stop/retry/completion capability。

provider 返回值被重新规范化，只允许 `running | not_running | unknown(reason)`。异常和 timeout 映射为 `provider_unavailable`；不合法结果映射为 `conflicting_evidence`。错误文本、transport detail 和 provider 私有字段不进入 disposition、事件或 wire response。

### 2. Timeout 不得制造无界 abandoned probe

每个 executor type 同时最多一个 provider inspection。默认 timeout 为 5 秒，硬上限 30 秒，timer 使用 `unref`，不会阻止进程退出。

timeout 后 registry 向 processor 返回 `provider_unavailable` 并发送 abort signal，但在底层 Promise 真正结束前保留该 provider 的 in-flight slot。后续同类 probe 直接返回 unavailable，不再启动第二个外部调用。这样即使 provider 忽略 abort 或永久挂起，每个 provider 也只保留一个 abandoned operation，不会按 candidate、pass 或 timer tick 无界累积。

registry dispose 会取消 timer、abort active provider，并让等待中的调用 fail closed；它不等待不合作的外部 Promise。

### 3. Provider budget 必须小于 recovery claim lease

cluster recovery 配置必须在打开 PostgreSQL 前验证：owner ID、claim page、lease、retry delay、provider timeout 和 startup pass 全部有硬边界。provider timeout 必须至少为 fenced mutation/settle 留出 250 ms，不能配置为等于或超过 claim lease。

该 250 ms 只是本地资源预算，不是 fencing authority。Pod wall clock 和 provider deadline 都不能证明 claim 有效；probe 返回后仍必须由 PostgreSQL statement time 重新锁定 owner/token/version/expiry fence。

### 4. Core Run recovery 由 bootstrap 拥有

cluster-control bootstrap 在 readiness 后自行构造：

`PostgreSQL source → claim repository → provider registry → evidence processor → resolution repository → supervisor → startup coordinator → convergence verifier`

业务 application 不再收到 raw PostgreSQL Pool、recovery source、claim repository 或 transition repository，只能消费受审领域 port。标准启动顺序为：

1. 用只读 `limit=1` verifier 预检；没有遗留时不创建 claim、不写 recovery control；
2. 有遗留时运行有限多轮 supervisor，默认最多 8 轮、硬上限 64 轮，每轮仍只有一页且页内串行；
3. 任一 retry/manual/fenced/store failure 立即保持 unsafe，不运行 application recovery；
4. core Run recovery 安全后才运行 application 的其他受审 reconciliation；
5. application 自报安全后再用独立数据库 verifier 复核，之后才能启动 lifecycle 和 admission。

startup coordinator 没有 timer、递归分页、全表 backlog 或并行 provider fan-out。pass budget 耗尽时返回最后一个 remaining lower bound，不能伪报收敛。

### 5. Profile 与执行位置必须匹配

registry/coordinator 位于无 driver 的 runtime-core，PostgreSQL repository 与默认装配只存在于 cluster-control artifact。edge/standalone 不引入该路径，继续使用各自 SQLite recovery lifecycle。

不得把现有 Linux `/proc` LocalProcess inspector 直接注册到 cluster-control，因为它只能观察当前 Pod/主机，不能证明远端 Worker 的执行。生产 provider 必须按执行位置分别实现：

- Remote Worker：认证 transport、Worker session/generation、Run lease、offer/callback sequence 与 Worker durable receipt/identity；
- Kubernetes：cluster/namespace/Pod UID/container ID 或 Job UID/resourceVersion 的精确绑定；
- Container：daemon identity、container immutable ID 与宿主 authority；
- LocalProcess：只允许在实际执行该进程且持有 durable boot ID/PID/start ticks 的同一节点 Profile 使用。

## 被否决的替代方案

### 未知 Executor 使用 default provider

拒绝。默认 provider 会把新增插件 Executor 静默纳入旧证据语义，形成权限与副作用旁路。未知类型必须 manual，直到注册专用 provider。

### Timeout 后释放 slot 并立即重试

拒绝。AbortSignal 不是强制取消；不合作 provider 仍在执行，按 pass 重试会造成连接、Promise 和远端请求无界堆积。

### 继续让 application 持有 claim/transition repository

拒绝。业务 stack 不需要恢复协调 authority；它会允许绕过 registry、标准 processor 或 pass budget，并迫使 bootstrap 仅依赖事后检查。

### cluster-control 直接读取本机 `/proc` 判断 Remote Worker

拒绝。PID namespace、boot identity 和进程位置不匹配；“本机没有该 PID”对远端执行没有任何负证据意义。

## 影响

### 正向

- 未知 Executor、缺失身份和 provider 漂移默认 fail closed；
- provider 看不到 recovery claim capability，也无法通过 registry 调用执行副作用；
- 慢/失控 provider 的在途数量和 timer 数量有固定上限；
- normal startup 只做一次只读候选点查，不产生 recovery control 写放大；
- core Run recovery 不再依赖 application 自选实现，admission 前的标准链可由真实 PostgreSQL 集成测试证明；
- application assembly 的 authority 面缩小，edge/cluster 依赖方向不变。

### 代价与未完成项

- enabled cluster-control 现在必须显式提供 recovery owner/config；
- executor provider 缺失时 active Attempt 会进入 manual 并阻断 admission，这是安全默认值；
- 仍需 Remote Worker/Kubernetes/Container 的真实认证 provider，当前 registry 不等于这些证据已存在；
- ADR-0057 已补齐 Remote Worker provider 所需的 PostgreSQL Session/Run Lease 精确 authority 与 Attempt fence 投影，但认证 attestation ingress/provider 仍未实现，session offline 或 lease expiry 仍不得当作 `not_running`；
- application 其他领域仍使用一个通用 reconcile seam，后续应演进为受审 reconciler registry 与各自 verifier；
- 仍需持续 lifecycle、指标/告警、manual recovery API、PostgreSQL lost-retry/cancellation 协调和大 backlog/failover 基准。

## 验证

1. runtime-core contract test 覆盖 exact routing、required identity、claim capability 隔离、注册后 mutation 隔离、异常/畸形输出、timeout、single-flight abandoned probe、dispose 和配置硬上限。
2. startup coordinator contract test 覆盖多页收敛、retry/manual 立即停止、pass budget exhaustion 与畸形 summary fail closed。
3. cluster-control test 证明无候选时不打开 repository connection，配置错误在 PostgreSQL 前拒绝，core recovery 不安全时不调用 application reconcile/admission，stop 会释放 registry。
4. PostgreSQL 16–18 三角色 CI 通过真实 bootstrap 证明未启动 aggregate 在 application/admission 前原子 lost，execution lease 保留、双事件有序且最终 verifier 为空。
5. Node 22/24 package test、edge import audit、cluster dependency audit、frozen lockfile 与 GitNexus detect-changes 继续作为合并门禁。
