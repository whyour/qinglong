# ADR-0108：Worker Pull Placement 与摘要化 Execution Offer

- 状态：Accepted
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-05、D-23、D-57、D-103、D-107
- 关联 ADR：ADR-0012、ADR-0013、ADR-0014、ADR-0057、ADR-0058、ADR-0104、ADR-0109

## 背景

QingLong 3.0 的 Worker 既可能是只有少量内存、连接不稳定且位于 NAT 后的路由设备，也可能是数据中心中的集群节点。PostgreSQL 已经拥有 Worker Session、Run Lease、不可变 `remote_worker` execution revision 和最小权限 Worker ingress，但此前仍缺少集群侧 candidate、Placement 与 offer 恢复闭环。

若控制面主动维护每节点推送队列、常驻 stream 或进程内 delivery timer，会把节点数量直接转换成控制面连接、timer 和恢复状态；若先把 `ExecutionSpec` 发给 Worker 再领取，又会让未获 Run Lease authority 的节点看到甚至执行任务。Run Lease 只保存 token digest 时，还必须解决 claim 成功但 HTTP 响应丢失后的安全恢复，不能把明文 bearer token 写回数据库。

## 决策

### 1. 首个集群分发协议采用认证 Worker Pull

已经建立 Session 的 Worker 主动向独立 Worker ingress 请求 offer。请求必须绑定 transport principal、当前 `workerId/sessionId/generation`，并携带：

- Worker 生成的稳定 `offerId`；
- 至少 256 bit 熵的不透明 `leaseToken`；
- 精确的 session generation。

transport 不信任请求体自报身份，必须先认证、授权和写低敏安全审计，再调用注入的 offer port。响应不得回显请求中的 token；Worker 已持有该 capability。没有注入 offer service 时入口返回 unavailable，不能临时从 handler 构造数据库 adapter。

Pull 不要求每个 Worker 一个服务端 timer、队列、长连接或内存 mailbox。低配设备可按自身网络与功耗预算退避轮询，集群节点可用更多并发的短请求扩展吞吐；两者共享相同 protocol 和硬上限。

### 2. Placement 是不可变执行修订的一部分

`qinglong/command@v1` 可声明有界 `placement`。发布 enabled cluster Task 时，compiler 把 normalized Placement 写入不可变 execution revision；未声明时自动要求 `remote-worker` executor。旧 execution revision 没有该可选字段时仍按原 digest 读取，禁止 migration 静默改写历史摘要。

WorkerCapabilities 与 Placement 都拒绝未知字段、重复项、控制字符、超限集合和非法 semver。能力 JSON 必须是规范化字节及其精确 SHA-256，required 条件全部满足后才可领取；preferred 只产生确定性 score。mismatch 只返回低基数类别，不持久化完整标签或 Secret。

### 3. Candidate discovery 使用数据库时钟和有界 keyset

PostgreSQL candidate source 只读取：

- runtime-owned、未取消、`queued|dispatching` 的 Run；
- 最新且仍为 `claimed`、executor 为 `remote_worker` 的 Attempt；
- 没有 Run Lease、已释放 Lease，或按 PostgreSQL `clock_timestamp()` 已过期且尚未启动的 Lease。

结果按 priority DESC、FIFO 和稳定 identity 做 keyset 分页，查询 `limit + 1` 后显式报告 truncated。单次 pull 默认最多读取 2×8 个 candidate、尝试 8 次 claim；硬上限分别为 16 页、64 条和 64 次。扩大集群吞吐通过更多无状态 pull 和数据库竞争完成，不通过无界放大单请求内存。

### 4. Run Lease 仍是唯一执行 authority

服务先读取 candidate，再读取请求 principal 对应的当前 Worker Session，校验 canonical capabilities、Session lease、状态和容量，解析 pinned execution revision 并执行 Placement。只有现有 PostgreSQL Run Lease repository 的原子 claim 返回 `claimed|idempotent` 才能构造 offer。

offer 精确绑定 Run、Attempt、Worker、session/generation、lease generation/version/expiry、offer ID、token digest、execution revision identity 和 content digest。任何 candidate、Session、Lease 或 revision fence 漂移都 fail closed。candidate 命中、Placement score、HTTP delivery 或 Worker 本地收包都不能代替 claim，也不能把 Run/Attempt推进到 starting/running。

### 5. 数据库只保存 token digest，重试从 authority 重建响应

claim 在进程内对 Worker 提供的 token 计算 SHA-256，数据库和 Event 只保存 digest。claim 响应丢失后，Worker 必须用完全相同的 `offerId + leaseToken + session authority` 重试。服务先查询 durable Lease 与 pinned execution revision，constant-time 比较 token digest，并在所有 fence 仍成立时重建同一个 offer。

因此不新增 `dispatch_offers` 表、明文 token outbox 或服务端 delivery queue。不同 token、不同 offer ID、替换 Session、过期/terminal Lease、Attempt 状态变化或 execution revision 漂移都返回 conflict；恢复不得创建第二条 Lease 或第二个 dispatch Event。

### 6. 保持 Profile、权限与包边界

该能力加入现有 `runtime-core`、`cluster-postgres` 与 `cluster-control` 子入口，不新增 workspace package。为让 Task 声明和 Worker capability 在写入/领取边界共享完整、可维护的 SemVer 语义，`runtime-core` 精确依赖 `semver@7.7.4`，而不是内置不完整解析器或再拆微包。它会给 edge/standalone 安装闭包增加约 268 KiB 文件，但 Profile import audit 必须证明 steady-state 入口不加载 `semver`，且总制品仍满足 4 MiB、512 文件和 16 MiB RSS delta 硬门禁；PostgreSQL adapter 与 cluster composition 则完全不得进入 edge/standalone 产物。

Worker ingress application 只依赖注入 port，不 import PostgreSQL adapter。runtime role 沿用已经受审的 Session/Lease/Run 读写权限；worker-ingress role 不获得 Run、Attempt 或 Lease mutation 权限。ADR-0109 已完成 starting/running/start-failure PostgreSQL 事务；后续 ADR-0231 已在认证 ExecutionSpec/Artifact transport 完成后，以同进程 capability port 将这些能力装入 production composition。

## 被否决的替代方案

1. **控制面主动为每个 Worker 推送**：需要每节点连接、队列、timer 和重连状态，不适合 NAT 后路由设备，也扩大多副本恢复面。
2. **先发送 ExecutionSpec，再由 Worker claim**：泄露未授权任务内容，并留下先执行后授权窗口。
3. **把原 token 存入 PostgreSQL/outbox**：数据库读取、备份或诊断泄漏即可获得执行 capability。
4. **只按 Worker ID 恢复 offer**：旧 Session 或攻击者可探测并接管已有授权；恢复必须证明同一 token capability 和完整 fence。
5. **新增 package 或 durable offer authority 表**：当前差异只是现有领域包的子入口和 Lease 派生视图，新增边界会复制版本、依赖和事实源。
6. **一次读取全部候选或 Worker**：会让单次请求内存随队列/节点规模增长，破坏 edge 和控制面过载门禁。

## 影响

正向影响：

- 路由设备和集群节点共享无状态、可退避的 pull 协议；
- 多副本只在 PostgreSQL 原子 claim 上竞争，不依赖进程内调度状态；
- 明文 token 不落库，丢响应仍可安全恢复；
- Placement 与 execution revision 一起固定，历史 Run 可解释；
- 没有新增 package、migration、常驻 timer、连接或 edge 运行时加载；代价是 edge 安装闭包增加一个受审的约 268 KiB SemVer 依赖。

代价与未完成项：

- Worker 轮询 cadence、jitter、服务端限流和大集群空轮询写/读放大仍需实测；
- 当前 pull endpoint 只有显式注入时可达，尚未默认装入 production cluster profile；
- delivery telemetry、Artifact/日志传输、Worker 本地 inbox 网络装配仍未完成；
- PostgreSQL `starting/running/start-failure` ACK 已由 ADR-0109 完成；completion、expiry/lost、cancellation 和 retry 仍需各自的原子事务，delivery 成功不得冒充这些事实。

## 验收证据

1. runtime-core 测试覆盖 canonical capabilities、required/preferred Placement、非法 semver、default `remote-worker` placement、candidate/page/offer fence 和 token digest 比较。
2. PostgreSQL repository 测试覆盖数据库时钟 candidate、priority/FIFO keyset、released/expired-unstarted 可见性和 active lease 隐藏。
3. cluster-control 测试覆盖有界扫描、Placement mismatch、原子 claim、同 token recovery、不同 token conflict，以及 ingress principal/session 绑定和响应不回显 token。
4. PostgreSQL 16.10 真实实例以独立 migration/runtime role 执行全部 migration 后，成功领取一次 offer；重放从 digest-only Lease 重建相同 offer，数据库中没有明文 token，且没有重复 Lease/Event。
5. 23 个 QL3 package、backend、cluster dependency 和 edge import/profile artifact 审计通过。ADR-0109 后六种本地 Profile 制品仍未在启动闭包加载 `semver`：edge 为 1,797,811 bytes、296 files、9,306,112 bytes RSS delta；最大 standalone-application 为 2,346,992 bytes、395 files，六档最大抽样 RSS delta 为 12,419,072 bytes，均低于发布硬门禁；QL3 production importer advisory 为 0 high/0 critical。
6. GitNexus 对已跟踪 diff 的 change detection 为 LOW、0 affected process；由于当前 QL3 孵化树仍是未跟踪文件，该结果不替代上述完整 build、test、artifact 和真实 PostgreSQL 证据。

## 后续门禁

ADR-0109 已实现 PostgreSQL starting ACK、running ACK 与 start-failure 原子状态推进；ADR-0231 又完成认证 ExecutionSpec/Artifact transport 之后的 Worker listener、生产进程/部署和 runtime ACK capability port。当前仍需补齐 Cluster Secret provider、expiry/lost/retry lifecycle 及多 Pod/failover 产品证据。
