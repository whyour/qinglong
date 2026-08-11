# ADR-0026：本地 Artifact 硬配额、磁盘水位与可恢复 Retention

- 状态：Proposed
- 日期：2026-07-18
- 关联：QL-RFC-0001、ADR-0007、ADR-0021、ADR-0024、ADR-0025

> 2026-08-12：Local Run Attempt 日志 retention、durable tombstone、压力档位与 lifecycle 接线已由
> ADR-0378 接受；本 ADR 仍保持 Proposed，仅表示其余通用 Artifact quota/跨 Profile 扩展尚未整体关闭。

## 上下文

ADR-0024 已建立 Attempt-scoped opaque Artifact 和 direct-file durable output，但未限制单次运行能够写入的字节数，也没有终态清理证据。对小型路由设备，这意味着一个失控脚本可以填满系统盘；只按 timer 删除目录又可能误删仍在运行、等待 completion receipt 或无法证明进程退出的日志。standalone/cluster 虽然容量更高，同样需要可审计的配额和生命周期语义。

durable LocalProcess 不能只依赖 Node `ExecutionOutputSink`：stdout/stderr 使用继承的文件描述符，控制面崩溃后 launcher 和用户进程仍继续写。Linux/POSIX 没有通用的 per-file-descriptor byte quota；`RLIMIT_FSIZE` 会错误影响任务自己打开的其他文件，并可能用 `SIGXFSZ` 改变业务退出结果。

## 决策

### 1. 每个 Attempt 必须显式声明容量策略

`LocalArtifactCapacityPolicy` 包含：

- `maximumAttemptBytes`：单 Attempt 日志硬上限，允许范围 64 KiB～1 GiB；
- `minimumFreeBytes`：不得被新 Attempt 消耗的磁盘保留水位。

默认 profile 建议为：

| Profile | 单 Attempt 上限 | 最小空闲保留 |
| --- | ---: | ---: |
| edge | 4 MiB | 32 MiB |
| standalone | 64 MiB | 256 MiB |

3.0 本地 allocator 不再提供隐式无限配置。创建 Artifact 前先读取文件系统 `bavail × bsize`；只有 available bytes 至少覆盖 `minimumFreeBytes + maximumAttemptBytes` 才允许打开文件。检查发生在 Artifact 文件副作用前，失败返回稳定 capacity unavailable。它是 admission reserve，不是对同文件系统其他进程的空间租约，所以运行中写入仍必须处理 ENOSPC。

### 2. 普通 pipe 与 durable direct-file 共用同一硬上限

普通 pipe sink 串行维护剩余额度，越界 chunk 只写入尚可接受的前缀，绝不多写一个字节，然后返回 quota exceeded；Executor 继续排空 child stream 并产生 bounded output-sink diagnostic。

durable 模式把 `maximumBytes` 作为非枚举 adapter capability 交给 launcher。Node 仍以 `O_APPEND|O_NOFOLLOW` 安全打开日志并传递 FD；launcher 在同一私有 shard 创建确定性的 `0600` FIFO，启动一个有界 drainer：

1. `head -c remaining` 只把剩余额度写到继承的安全 FD；
2. 同一 reader 用 `wc -c` 排空剩余字节，只根据计数判断是否真正达到 quota，不保存用户内容；
3. stream 关闭后始终发布固定格式、不可覆盖的 truncation fact，记录 Run/Attempt/Artifact、实际 quota、`quotaReached=true|false` 和 observation time；fact 缺失只能解释为 `unknown`，禁止推断为未截断；
4. 用户进程不会因 reader 退出收到 SIGPIPE，退出码和 completion receipt 语义不因日志截断改变；
5. launcher 等待 child 与 drainer，再删除 FIFO。控制面进程提前退出不会中断 launcher、drainer 或用户进程。

fact 不包含 callback token、命令、环境、Secret 或用户输出，也不能授权 completion、retention 或调度状态变化。launcher 通过同目录临时文件和 hard-link/no-replace 发布；本地 reader 只读取 canonical 私有 shard 中的普通非 symlink 文件。事实文件可以被日志 API 解释为 `true|false|unknown`，但不能作为进程退出证明。

这增加至多一个轻量 POSIX drainer，不增加每任务 Node sidecar、watcher 或 timer。Alpine 镜像已有 coreutils；Debian 必须在镜像契约中持续验证 `head -c`、`wc -c` 与 `mkfifo`。遗留 manual Primary 未提供 `maximumBytes + logArtifactId` 时保持旧 direct-file 路径，不被本切片静默切换。

### 3. Retention 只相信数据库终态和 receipt settlement

SQLite candidate source 只返回同时满足以下条件的记录：

- Run `execution_owner=runtime`，Run 与 Attempt 均为 `succeeded|failed|cancelled|timed_out`；
- Executor 为 `local_process`，`log_artifact_id` 是 canonical `local-*`；
- Attempt `finished_at_ms` 已超过当前 retention cutoff；
- 不存在 CompletionReceiptJournal，说明 completion receipt 已消费/隔离处理完成；
- 不存在该 Attempt 的 retention tombstone。

`lost` 明确排除：lost 只表示控制面无法证明 ownership，不证明底层进程已经退出。没有 durable execution settlement 证据时删除 lost Artifact 可能 unlink 一个仍被孤儿进程写入的 inode。以后若引入 `execution_settled` 事实，应通过独立 ADR 扩展，而不能从 error code 猜测。

候选按 `(finished_at_ms, attempt_id)` keyset 排序，默认 16、最多 64；每次 sweep 默认最多删除 8、最多 64。单页 service 无全目录扫描、递归分页、timer 或每 Task 状态；cadence 由后述显式 lifecycle 管理。

### 4. 低水位只能缩短到显式 pressure retention

Retention service 每个 sweep 只采样一次 clock 和 capacity：

- 空闲空间不低于水位时使用 `normalRetentionMs`；
- 低于水位时使用显式配置的 `pressureRetentionMs`，且必须在 1 分钟到 normal retention 之间；
- 即使磁盘承压，也只删除满足 terminal/receipt 条件的 Artifact，不删除 active、lost 或未知文件。

压力模式不是“扫目录删最老文件”。持续低水位必须产出指标/告警，并允许调度 admission 暂停低优先级任务或拒绝新任务。

### 5. Lifecycle 只运行单页并持久化 CAS cursor

`0016-local-artifact-maintenance-cursor` 增加单行 `LocalArtifactMaintenanceCursors` checkpoint，保存 `(finished_at_ms,attempt_id)`、version 和更新时间。lifecycle 每次 tick 只读取一个 checkpoint、执行一个 sweep page，再按 expected version CAS 推进或清空：

- `page_complete|deletion_budget_exhausted` 必须持久化 resume cursor；到达尾部后清空 cursor，下个 tick 从头重试此前失败候选；
- 当前 cursor 和目标 cursor 都为空时不写数据库，避免空闲路由器周期性改写 SQLite/WAL；
- CAS 失权只输出 `fenced` 摘要，不假装持有 cadence ownership；文件删除和 tombstone 本身仍按幂等协议收敛；
- 一个 `unref` timer、无重叠 cycle、显式 start/stop、stop wait 有上限；observer 只收到无 Attempt/Artifact ID 的聚合值，statfs bigint 转成十进制字符串以便 JSON exporter 安全处理。

默认资源建议为：

| Profile | cadence | page | 每周期最多删除 | normal retention | pressure retention |
| --- | ---: | ---: | ---: | ---: | ---: |
| edge | 5 分钟 | 8 | 4 | 7 天 | 1 天 |
| standalone | 1 分钟 | 32 | 16 | 30 天 | 7 天 |

这些是代码级安全默认值，不替代 Project policy；当前 lifecycle 仍未接入生产 startup。

### 6. 删除后写 tombstone，崩溃可收敛

`0015-local-artifact-retention` 增加 `LocalArtifactRetentions`，每 Attempt 一条不可覆盖记录，保存 Artifact ID、finished/eligible/recorded time、`deleted|already_absent` 和 reclaimed bytes；同时为 RunAttempt terminal candidate 增加 `(status, finished_at_ms, id)` 索引。

操作顺序固定为：

1. 验证 root/shard 都是非 symlink 私有目录；日志与 truncation fact/temp 必须是有界普通文件，遗留 quota 辅助项必须是 FIFO；
2. 先删除日志，成功或已缺失后再删除 FIFO 与 truncation fact/temp，最后 fsync shard directory；日志删除失败时必须保留解释它的 truncation fact；
3. 写入 tombstone。

不能先写 tombstone：断电后数据库可能永久声称已清理，但文件仍存在。若在 unlink 后、tombstone 前崩溃，下一 sweep 将文件识别为 already absent 并补写 tombstone。并发清理时第一条同 Attempt/Artifact/finished identity 的证据获胜；身份不同稳定冲突。

Retention 不清空 `RunAttempt.logArtifactId`。历史 Run 仍保留 opaque ownership 和“已过期”解释能力，日志读取端可通过 tombstone 区分从未产生、暂时缺失和已执行 retention。

### 7. cluster 共享语义，不共享本地文件实现

- edge/standalone：SQLite candidate/tombstone + 私有本地文件 + statfs capacity；
- cluster-control：PostgreSQL metadata/fencing + object-store lifecycle/delete marker + Project policy；
- worker：本地 spool quota 与上传 ACK 必须先于删除，不能把控制面 tombstone 当作 Worker 本地清理证明。

对象存储 adapter 必须复用 terminal settlement、pressure policy、bounded page、delete-before-marker 和 immutable identity contract；共享挂载本地 Artifact root 不是 cluster 实现。

### 8. 当前保持 production unreachable

quota-aware 3.0 allocator、durable FIFO drainer、正/负 truncation fact、capacity probe、`0015/0016` migration、SQLite candidate/tombstone/CAS checkpoint、文件 retirement、单页 service、profile policy 和显式 lifecycle 已实现，但没有接入默认 Dispatcher/Primary startup。生产启用前仍需：

- 配置/API 中的 Project/Profile policy 与变更审计；
- lifecycle startup/shutdown 装配、指标 exporter、持续低水位告警和 admission 联动；
- 真实 Alpine/Debian 多架构验证 `head`/`wc`/FIFO/信号/父进程退出；
- loopback/tmpfs 上的 ENOSPC、inode 耗尽、断电/fsync 和并发外部写入测试；
- 日志读取 API 对 tombstone、`quotaReached=true|false|unknown` 和权限的稳定响应；
- PostgreSQL/object store/Worker spool contract suite。

因此 migration 和 adapters 存在不代表 retention timer 已启动，也不改变现有 2.x/manual Primary 的日志策略。

## 影响

正面影响：

- 单 Attempt 无法把本地日志写过明确上限，durable 模式在控制面崩溃后仍受限；
- edge 在创建任务前保留系统盘安全余量，并能在低水位使用更短但显式的保留期；
- retention 不扫描未知目录，不误删 active/lost/未结算 receipt，并能从 unlink→DB 崩溃窗口恢复；
- 历史 Run 保留 opaque Artifact identity 和不可变清理证据。

代价与风险：

- durable quota 依赖 POSIX FIFO、`head -c` 和 `mkfifo`，必须持续进入镜像 contract；
- quota 后继续排空会消耗少量 CPU/pipe I/O，但避免改变用户任务退出结果；
- statfs admission 不是空间预留锁，其他进程仍可能导致 ENOSPC；
- tombstone 与 RunAttempt 同生命周期增长，未来删除 Run 时由外键级联，不能独立无限保留；
- lost Artifact 暂不自动清理，可能需要人工审计或后续 settlement 协议。

## 未选择的方案

1. **只限制 Node sink**：控制面崩溃后的 durable FD 绕过，拒绝。
2. **使用 `RLIMIT_FSIZE`**：影响任务自己的其他文件并可能改变退出结果，拒绝。
3. **quota 达到后关闭 FIFO reader**：向用户进程制造 SIGPIPE，拒绝。
4. **递归扫描日志目录并按 mtime 删除**：没有 Run/Attempt/receipt ownership，拒绝。
5. **把 lost 当作可清理终态**：无法证明孤儿进程退出，拒绝。
6. **先写 tombstone 再 unlink**：断电可能形成永久泄漏，拒绝。
7. **低水位时删除 active 或无最短保留**：破坏恢复和用户契约，拒绝。
8. **cluster 共享本机目录/SQLite**：无多副本 fencing 和对象生命周期，拒绝。

## 验证要求

- 普通 sink 和 durable launcher 对 oversized/replay 输出都精确停在最大字节；
- quota 后 child 继续完成、退出码/receipt 不变，capability 环境不进入 child；
- 未超额发布 `quotaReached=false`、超额发布 `true`、fact 缺失保持 `unknown`，不得从文件大小推断；
- capacity reserve 在创建日志文件前拒绝，非法 policy/snapshot fail closed；
- candidate 排除 active、legacy、non-local、pending receipt、tombstoned 和 lost；
- normal/pressure retention、stable cursor、page/delete budget 可重复验证；
- lifecycle 单 timer、无重叠、有界 stop、CAS fencing、idle 零 checkpoint 写和低敏 JSON-safe summary 可重复验证；
- symlink/非普通文件/非 FIFO 辅助项 fail closed，不影响外部目标；
- unlink 后 tombstone 失败可在下一 sweep 收敛为 already absent；
- migration、ownership、Node 22/24 全量测试通过；
- 真实 edge 文件系统补充 ENOSPC、inode、断电和写放大报告后才允许生产装配。
