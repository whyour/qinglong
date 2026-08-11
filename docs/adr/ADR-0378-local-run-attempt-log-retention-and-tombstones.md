# ADR-0378：Local Run Attempt 日志有界保留与 durable tombstone

- 状态：Accepted
- 日期：2026-08-12
- 关联 RFC：QL-RFC-0001 D-290
- 前置决策：ADR-0026、ADR-0027、ADR-0377

## 上下文

ADR-0377 已让 Local/Cluster 能在 Project、Run、Attempt、executor 与 Artifact identity 全部可信后读取日志，但故意没有把缺失文件解释成 retention。若没有 durable tombstone，文件被清理、文件损坏、错误路径和未发布 Artifact 对读取方都是同一个 `missing`；若只在删除前写标记，又会把仍存在的数据错误暴露为已清理。

Local Profile 还必须覆盖两类差异很大的设备：128 MiB/64 PID 级路由设备不能承担目录全扫、每任务定时器或无界删除；Standalone 可以提高吞吐，但仍应复用单连接和既有 lifecycle。Cluster 的 PostgreSQL 多副本 claim、S3 条件删除和外部网络失败语义与本机 unlink 不同，不能为了表面复用而塞进同一个事务或 adapter。

## 决策

### 1. 共享不可变证据，不共享删除实现

`runtime-core` 在既有 Run 能力内增加 `qinglong/run-attempt-log-retirement@v1`，不创建新 package。每条记录精确绑定：

- `projectId`、`runId`、`attemptId`、`logArtifactId`；
- `executorType`、`finishedAtMs`、`eligibleAtMs`、`retiredAtMs`；
- `deleted | already_absent`；
- 删除前观测到的 `byteLength` 与 `true | false | unknown` truncation；
- 覆盖全部语义字段的 canonical SHA-256 `recordDigest`。

读取 repository 必须重新计算摘要并验证精确身份；持久化行被原地修改时失败关闭。`already_absent` 的 byteLength 固定为 0，不伪造回收字节。

### 2. 读取与删除竞态

读取仍先完成 HTTP authentication、Policy、durable audit、credential confirmation 和 Run/Attempt metadata 验证。获得 canonical Artifact identity 后：

1. 在访问文件/对象前检查 tombstone；
2. 已 retired 直接返回 `410 artifact retired`，不触碰存储；
3. active 时执行原有 Range read；
4. 存储返回 missing 后再次检查 tombstone；
5. 二次检查发现 retired 返回 410，否则保持 503 unavailable/pending 语义。

打开文件后发生 unlink 的并发读取可完成该已打开快照；这是以安全打开的 inode 为线性化点。删除完成但 tombstone 尚未提交的极短崩溃窗口由下次 `already_absent` sweep 收敛，不能预写“已删除”tombstone。

对外 `retired` 只包含 Project/Run/Attempt、retired time、原 byte length 与 truncation，不返回路径、Artifact ID、bucket 或 key。Policy deny、不存在和跨 Project 继续在此之前遮蔽为 404。

### 3. Local SQLite 44 号契约

追加 `0087-run-attempt-log-retention` 与 `0088-capability-v44`：

- `QingLong3RunAttemptLogArtifactTombstones` 保存不可变精确证据；
- `QingLong3RunAttemptLogRetentionState` 保存唯一 Local maintenance cursor；
- `RunAttempts` 增加局部候选索引；
- runtime readiness 仍只读取冻结 manifest，不加载可执行 DDL。

候选必须同时满足：

- Run `executionOwner=runtime`；
- Run 和 Attempt 都是 `succeeded | failed | cancelled | timed_out`，明确排除 `lost`；
- Attempt 为 `local_process` 且绑定 canonical `local-*` 日志；
- Run/Attempt 都有终态时间且早于当前 retention cutoff；
- 不存在任何 completion receipt journal；
- 不存在同 Attempt 或 Artifact 的 tombstone。

删除后写 tombstone 的事务会重新验证上述持久化事实。若 receipt 或状态在文件删除后改变，写入失败，后续 sweep 以 absent 重新收敛，不能绕过 completion 协议。

### 4. 私有文件删除顺序

Local store 只接受：

- 绝对且非文件系统根的 Artifact root；
- 当前 owner、模式 0700、非 symlink 的 root/shard；
- 当前 owner、模式 0600、普通文件、单 hard link、最大 1 GiB 的主日志；
- 唯一允许的 `.<artifact>.log.truncated.json` helper，且其 identity 与主记录完全一致。

顺序固定为：验证目录和 fact → 打开并验证主日志 inode → 删除主日志 → 删除允许的 fact → fsync shard directory → SQLite 写 tombstone。禁止递归删除、扫描任意目录、跟随 symlink 或清理未知 helper。若主日志已不存在但 exact fact 仍在，只删除该 fact、fsync 并记录 `already_absent`。

### 5. Edge 与 Standalone 资源档位

每次 sweep 先用 `statfs` 采样可用空间，根目录尚未创建时只检查最近存在父目录，不主动创建路径。

| Profile | 正常保留 | 压力保留 | 压力阈值 | page | 最大删除 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Edge | 7 天 | 24 小时 | 64 MiB | 4 | 2 |
| Standalone | 30 天 | 24 小时 | 256 MiB | 16 | 8 |

cursor 持久化到 SQLite；失败候选会被本轮越过，并在游标回绕后重试，避免一个坏文件永久阻塞队首。容量证据以十进制字符串进入 lifecycle summary，避免 JSON 对 BigInt 失败。

### 6. 不新增常驻资源

Artifact sweep 复用 `LocalExecutionControlLifecycle` 已有 completion cleanup cadence：先清 completion receipt，再做一次有界 Artifact sweep。它不新增 timer、listener、SQLite connection、watcher、cache 或 background thread；stop drain 不额外执行 Artifact 删除，避免扩大关停超时。

### 7. Cluster 留给 D-291

Cluster 路由和共享读取服务已经能注入 retention state 并映射 410，但 D-290 不授予 S3 DeleteObject 权限、不新增 PostgreSQL tombstone/claim，也不宣称 Cluster retention 已完成。D-291 必须独立解决：

- 多副本 durable claim、lease/backoff 与 bounded scheduler budget；
- validated HEAD 后基于 ETag/version 的条件删除；
- PostgreSQL 事务不得跨 S3 网络调用；
- delete 成功/对象已不存在后的 exact tombstone finalize；
- MinIO/S3 失败矩阵与 PostgreSQL HA failover。

## 被否决的替代方案

1. **删除前写 tombstone**：可能把仍存在的数据声明为已删除，拒绝。
2. **把 missing 直接映射 410**：无法区分损坏、误配和 retention，拒绝。
3. **递归扫描 Artifact root**：I/O 无界且目录内容成为隐式 authority，拒绝。
4. **每个 Run/Attempt 启动 retention timer**：常驻资源随任务数增长，拒绝。
5. **Local/Cluster 共用一个删除事务 adapter**：会把外部 S3 调用放入数据库事务并模糊多副本 ownership，拒绝。
6. **新建 retention 微包**：现有 runtime-core、local-sqlite、local-execution ownership 已足够，拒绝。

## 验收

1. 共享 contract 覆盖 digest tamper、精确 identity、压力策略、删除预算和 durable cursor；
2. 读取覆盖 tombstone-before-storage 与 missing-after-storage 二次检查；
3. SQLite migration、typed schema、readiness、candidate、receipt fence、replay/tamper 全部通过；
4. 文件 adapter 覆盖权限、symlink/hard-link、fact drift、unlink-before-tombstone 与 statfs；
5. 完整 Local application 证明启动 sweep 删除真实文件、写 tombstone，并在产品读取前返回 retired；
6. Runtime Core、Local SQLite/Execution/API/Application/Admin/Owner CLI、Cluster Control 与完整 18-package/backend/boundary/Profile/Local image 门全部通过后才改为 Accepted。

2026-08-12 验收完成：Runtime Core 498/498、Local SQLite 220/220、Local Execution 39/39、Local API
45/45、Local Application 46 pass/4 skip、Local Admin 91/91、Local Owner CLI 157 pass/5 skip、Cluster
Control 216 pass/2 skip；完整 18-package 门退出 0，backend 1,163 pass/2 skip/0 fail。package boundary 保持
18 个 workspace package，`singleSourcePackages=[]`、`shallowSourcePackages=[]`；dependency 与 Edge import 审计
均 compatible。14 个 Local Profile artifact 全部在文件数、体积与 RSS 预算内，最小 Edge 为 2,450,378 bytes，
Edge Application 为 3,482,708 bytes，未引入 Cluster/PostgreSQL/AWS SDK 闭包。

真实 arm64 Local image 以 repo digest
`sha256:73a93094ebc53effbbe619e29ea866e59872211bf840db86509c011389ed10b8` 完成 Edge/Standalone
Compose preflight，均观测 SQLite contract v44；两档 rollout 的备份、恢复、响应丢失重放、证据收集与优雅清理
全部 compatible。PostgreSQL 18.4 arm64 HA 回归通过 112 gates、timeline `1→2`，私有报告 SHA-256 为
`6a205d8bc596097f91a900d7cdabef21c6ff3ad61152e8dfb31291cb8a356b12`，独立审计
`compatible=true/findings=[]`。发布镜像、静态审计和 CI 的 SQLite compatibility label 已统一为 v44。
