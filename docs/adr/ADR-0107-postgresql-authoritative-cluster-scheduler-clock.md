# ADR-0107：PostgreSQL 权威 Cluster Scheduler 时钟

- 状态：Accepted
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-05、D-19、D-53、D-56、D-104、D-106
- 关联 ADR：ADR-0054、ADR-0057、ADR-0103、ADR-0105
- Supersedes：ADR-0105 中由 Coordinator 提供 claim/decision observation 的局部协议

## 背景

ADR-0105 已用 owner/token/version/expiry 与 schedule state 建立完整行租约 fence，但最初的 `ClaimClusterScheduleCommand` 仍接受 control replica 的 `observedAtMs`。领取 SQL 用该值判断 due、claim expiry takeover 和 `updated_at_ms`，Coordinator 又用另一次节点 `Date.now()` 计算 cron 决策，commit 最后继续用调用方时间判断租约并写 Run/Event。

这会让 Pod 时钟漂移进入数据库 authority：快节点可以提前接管仍有效的 claim 或提前调度 occurrence，慢节点会延迟到期工作；NTP 回拨还可能让同一 replica 写出早于 claim 的状态时间。owner/token/version 只能阻止旧 owner 提交，不能修复由错误 observation 产生的错误 winner。

## 决策

1. `ClaimClusterScheduleCommand` 只接受 `ownerId`、UUID `claimToken` 与有界 `leaseMs`，拒绝 `observedAtMs` 及任何扩展字段。Coordinator 配置同样拒绝 `clock`，节点墙上时钟不得成为 scheduler authority。
2. 领取 SQL 在一个 `MATERIALIZED` CTE 中精确调用一次 PostgreSQL `clock_timestamp()`，以该 observation 同时裁决 due cursor、过期 takeover、未来 `updated_at_ms`，并写 `claim_expires_at_ms = observation + leaseMs`。
3. 活跃 claim 的既有 `trigger_schedules.updated_at_ms` 被解释为持久化 `claimAcquiredAtMs`。`pg-0014` 已要求 claim expiry 大于 updated time，因此无需新增列或迁移；公开 claim 必须满足 1–60 秒 lease 差值并把 acquired time 纳入 exact claim 比较。
4. cron/misfire 决策只能使用 claim 返回的 `claimAcquiredAtMs`。`resolveClusterScheduleDecision` 不再接受 observation 参数，commit normalization 要求 `decision.observedAtMs === claim.claimAcquiredAtMs`。
5. commit 的 `SERIALIZABLE` transaction 在锁定 schedule 的同一 statement 中再次精确采样一次数据库时间。该时间达到 expiry 时只返回 `raced`；早于 `claimAcquiredAtMs` 时以数据库时钟回退失败关闭；成功时作为 Run、Attempt、双 Event 与 schedule 的创建/更新时间。
6. cycle summary 只报告首尾 `claimAcquiredAtMs`，空轮次为 `null`。它不再伪造一个节点级 observation，也不改变每轮 16/256、30 秒 lease、非重叠 lifecycle 或 Profile 闭包。

## 被否决的替代方案

1. **保留调用方时间并配置 NTP 偏差容忍**：不能证明每个 Pod 同步，也会把容忍窗口变成提前 takeover 窗口，拒绝。
2. **只在 claim 使用数据库时间，commit 继续使用节点时间**：慢/快节点仍可错误判断 expiry 或写回倒退时间，拒绝。
3. **为 acquired time 新增列和 capability migration**：活跃 claim 的 `updated_at_ms` 已被 claim shape 约束为同一 durable acquisition fact；重复列会形成双事实，拒绝。
4. **使用 transaction timestamp 并跨多个 transaction 复用**：领取和提交是两个独立 transaction，必须分别取得实际 statement observation，拒绝。
5. **改用全局 scheduler leader**：时钟问题不会因单 leader 自动消失，并重新引入 ADR-0105 已拒绝的粗粒度故障域，拒绝。

## 验收证据

1. runtime-core contract 测试拒绝 caller-timed claim command，并绑定 `claimAcquiredAtMs`、lease 差值和 decision observation。
2. PostgreSQL repository 测试证明 claim SQL 使用一次数据库 `clock_timestamp()` 且参数中没有节点时间；commit 使用第二次数据库 observation 裁决 expiry、时钟回退和所有 durable timestamp。
3. Coordinator 测试证明配置中的 `clock` 被拒绝、多个 claim 的数据库时间被保留，且只为 fenced admission 分配 identity/发送通知。
4. 三个目标包 build 与 scheduler 定向测试 14/14 通过；runtime-core 116/116、cluster-postgres 66/66、cluster-control 73/73 通过，后两个包各有 1 个在未提供 PostgreSQL URL 时显式跳过的 integration。
5. 23 个 QL3 package 的完整 build/test、依赖闭包审计、edge import 审计全部通过；backend 669/669 通过。
6. PostgreSQL 16.10 真实实例完成全部 migration，并以最小权限 `ql3_runtime` role 验证 claim/commit。双角色完整 integration 18/18 通过，仅因未配置 admin/worker-ingress 独立 URL 显式跳过 2 项；CI 已补齐 Task/Trigger/Schedule 对 runtime/admin role 的最小授权。
7. 当前本机 arm64 PostgreSQL 18 四角色 integration 为 23/23、0 skip；两个独立 runtime pool 的 scheduler integration 又证明同一 occurrence 单赢家和持 claim 副本关闭后的数据库时间 expiry takeover。新增用例只补 active query 连接失效的 availability 报告，不重新引入节点 clock。
8. ADR-0125 的 physical-promotion 门禁在 primary 数据库时间 `1784824222846` 取得 15 秒 claim，WAL replay 到 standby 后于旧主 fencing 前再次由数据库观察到 14,641 ms 剩余且 occurrence 数为 0；timeline 1→2 promotion 的数据库时间为 `1784824223677`，fresh control 最终在 `1784824238338` 准入，晚于 claim expiry `1784824237846`。claim version 1→2、最终清空并只产生 1 Run/1 Attempt/2 Event，证明节点时钟没有参与跨 promotion takeover。
9. 同一 promotion fixture 在另一个到期 schedule 的 decision transaction 完成 `COMMIT` 后终止 transaction backend，并让 Coordinator 上层观察 `ECONNRESET`。该提交在 promotion 前已由 standby WAL replay，promotion 后仍只有 1 Run/1 Attempt/2 Event、claim 清空且 0 duplicate，证明不确定响应没有重新引入节点时间或绕过 durable idempotency fact。该证据不等同 raw-wire packet-loss。

## 后续约束

数据库权威时钟消除了 Pod 间墙上时钟作为调度 authority；本机 PostgreSQL 18、双独立 pool 与 ADR-0125 的 timeline 1→2 physical promotion 已证明短时多控制面竞争、claim 持有期间的 WAL 连续性、promotion 后数据库 expiry takeover、exact occurrence admission 和 PostgresClient 边界的 decision COMMIT-response-loss 收敛。尚未覆盖 raw-wire packet-loss、跨区域 leap/slew、真实 Kubernetes Pod 网络边界或网络分区安全。其余逐 mutation failover 与多 Pod 长时间竞争仍是发布门禁；测试不得通过重新注入调用方 `observedAtMs` 来伪造 takeover。
