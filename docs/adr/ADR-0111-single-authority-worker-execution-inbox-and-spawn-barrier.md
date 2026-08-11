# ADR-0111：单一 Worker 执行 Inbox 与可判定 Spawn Barrier

- 状态：Accepted
- 日期：2026-07-22
- 关联 RFC：QL-RFC-0001 D-24、D-85、D-108、D-109、D-110
- 关联 ADR：ADR-0021、ADR-0058、ADR-0061、ADR-0108、ADR-0109、ADR-0110

## 背景

ADR-0110 已让认证 Pull 在清理 pending claim 前，把完整 offer 原子写入
`@qinglong/worker-runtime` 的私有 inbox。但仓库此前另有一套
`back/runtime` Worker execution journal，且两者使用不同的 Offer 模型：新
Cluster contract 固定 immutable execution revision，旧模型使用临时
`ExecutionSpec/contextRef`。用一次性 adapter 把新记录复制到旧 journal 会产生双
authority；直接转换又会丢失 Secret/environment/revision 语义。

生产 Worker 还必须区分两类完全不同的启动失败：Executor 明确证明没有 spawn，和
调用抛错但副作用可能已经发生。后者若上报 start-failure，控制面可能重试并产生双
执行。

## 决策

### 1. 现有 package inbox 原位升级，不新增 package 或第二 journal

`@qinglong/worker-runtime/remote-offer-delivery` 在原有 offer 文件上扩展状态：

`accepted → starting_acknowledged → launching → started → running_acknowledged`

并保留 `start_failed → start_failure_acknowledged`、
`completion_acknowledged` 与 `recovery_required`。每次更新必须：

- 使用单调 `revision + expectedRevision` CAS；
- 保持 offer、candidate、immutable revision、Session、Lease generation 与 token
  authority 不变；
- Lease 只允许版本单调前进，同版本内容必须完全一致；
- 保持 `acceptedAtMs` 不变、`updatedAtMs` 不回退；
- 只允许显式 transition graph，终态不能回退；
- 通过同一单 owner、`0700/0600`、fsync + atomic rename 文件 authority 写入。

Inbox 提供最多 64 条一页的稳定 offerId keyset 列表。默认/硬容量仍为 64/1024，
不增加 timer、数据库或后台扫描。

### 2. ACK 与 spawn 共用同一记录

package-owned Processor 只接受已存在于 inbox 的 offerId：

1. 完整复验当前 Worker Session、drain/offline、Worker lease 与 Run Lease expiry；
2. 调用受保护的 `acknowledgeStarting` port；
3. 物化 public/Secret environment，逐项匹配 immutable revision；
4. 生成 32-byte completion capability，只在 `launching` 前持久化 callback
   sequence 与 SHA-256，原 token 不落 journal；
5. `launching` 持久化成功后才调用注入的 Executor；
6. Executor handle 持久化为 `started` 后，才调用 `acknowledgeRunning`；
7. ACK 成功后持久化 `running_acknowledged`。

Processor 不拥有 HTTP、PostgreSQL、poll timer、Session heartbeat 或进程实现；这些
能力由 headless Profile 组合根通过窄 port 注入。`worker-runtime` 继续不依赖
cluster-control、pg、SQLite、Express 或 legacy root。

### 3. 只有可证明的 no-spawn 才能上报 start-failure

Executor port 返回 tagged result：

- `rejected` 明确证明没有用户执行产生，允许进入 `start_failed` 并调用
  `failStart`；
- `started + executorHandle` 允许进入 `started`；
- Promise rejection、未知 tagged result、无效 handle、spawn 后 journal 写入不确定，
  一律进入或保持 `recovery_required(launch_outcome_unknown)`，不得调用
  `failStart`。

重启看到 `launching` 时不调用 materializer、Executor 或 ACK，直接转入
`recovery_required`。看到 `started` 只重放 running ACK，不再次 spawn。

### 4. Secret 与 completion capability 不进入持久状态

materializer 必须返回与 revision 环境变量同名、同数量的已解析值。public 值必须
逐字一致；Secret 值只在内存传给 Executor。completion token 固定 32 bytes，在
Processor 完成启动尝试后清零局部 Buffer；journal 仅保留 callback sequence 与
lowercase SHA-256。Executor 若已启动，应自行复制其完成回调所需的瞬时材料。

## 被否决的替代方案

1. **把 package accepted 文件复制到旧 journal**：制造 crash window、双清理和双
   authority。
2. **把 Cluster offer 强转旧 ClaimedExecutionOffer**：两套 digest/context 模型不
   等价，会隐藏 revision 与 Secret 漂移。
3. **Executor 抛错一律 start-failure**：无法证明错误发生在 spawn 前。
4. **先 spawn 后写 launching**：崩溃后没有禁止二次 spawn 的 durable barrier。
5. **把 completion token 写入 inbox**：扩大本地 bearer capability 暴露面。
6. **另拆 execution-inbox package**：没有独立部署、权限或供应链责任，只增加包碎片。

## 影响与剩余门禁

已完成：delivery 与执行准入共用一个 package authority；状态 transition、分页、
callback digest、ACK 顺序、明确拒绝、模糊 spawn、重启 launching 与环境漂移有目标
测试。总 workspace package 仍为 23。

ADR-0112 已完成真实 activation HTTPS client、版本化 response contract、共享 TLS authority
与默认关闭的显式 headless lifecycle seam。仍未完成：Secret/Artifact/log materializer、
具体 Executor、completion transport、receipt-first recovery、Lease loss/expiry、
cancellation/retry lifecycle 与 production Profile 组合。故 Processor 与 Pull 仍只通过显式
subpath 可达，默认 Worker 入口不自动启动任务。

## 验收证据

1. 同一 offer 文件按 revision 经过 ACK/spawn barrier，非法回退和 stale revision 拒绝。
2. 分页稳定、有界，delivery replay 只推进同 authority Lease 版本。
3. Executor `rejected` 才触发 failStart；异常进入 recovery 且 failStart 调用数为零。
4. restart-visible `launching` 不调用任何 materializer、Executor 或 activation side effect。
5. public environment drift 在 spawn 前失败，completion token 在调用后清零且不落盘。
