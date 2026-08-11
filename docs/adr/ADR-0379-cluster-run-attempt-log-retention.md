# ADR-0379：Cluster Run Attempt 日志多副本保留与条件删除

- 状态：Accepted
- 日期：2026-08-12
- 关联 RFC：QL-RFC-0001 D-291
- 前置决策：ADR-0026、ADR-0027、ADR-0377、ADR-0378

## 上下文

Local retention 已证明 durable tombstone、删除后收敛和读取 410 的通用语义，但 Cluster 不能复用 Local cursor + unlink 模型。多个控制面副本可能同时发现同一 remote Worker 日志；对象删除需要跨 S3 网络，PostgreSQL 事务不能覆盖该网络调用；删除响应也可能丢失。若没有 durable ownership fence，副本会重复删除或把另一个副本的结果写成自己的证据；若删除前写 tombstone，则可能把仍存在的对象声明为 retired。

Cluster 还必须保持与低配 Local 部署的物理隔离：本能力不得让 Edge/Standalone closure 引入 PostgreSQL、AWS SDK、额外连接或后台任务。

## 决策

### 1. 不新增 package

共享多副本 claim contract 放在 `runtime-core` 的既有 Run log-retention 目录；PostgreSQL authority 放在 `cluster-postgres`；S3 条件删除和调度 lifecycle 放在 `cluster-control`。不创建单文件 retention 微包，也不把 Cluster 依赖加入 Local closure。

### 2. PostgreSQL v54 是唯一 ownership authority

`pg-0055-run-attempt-log-retention` 将 control-core 升至 v54，并声明 `run_attempt_log_retention` capability：

- `run_attempt_log_retention_controls` 保存精确 Project/Run/Attempt/Artifact identity、eligibility、claim owner/token/version/expiry、retry time、failure count 与最后失败分类；
- `run_attempt_log_artifact_tombstones` 保存 immutable `qinglong/run-attempt-log-retirement@v1` 标量证据与 canonical digest；
- terminal remote Worker Attempt 增加局部候选索引；
- `ql3_runtime` 对 control 拥有 `SELECT/INSERT/UPDATE/DELETE`，对 tombstone 仅拥有 `SELECT/INSERT`，其他运行角色继续零权限。

候选必须同时满足 runtime-owned Run、Run/Attempt 均为非 `lost` 终态、`remote_worker` executor、canonical `wlog-*` identity、Run/Attempt 均超过 retention cutoff 且不存在 tombstone。claim 在短 `READ COMMITTED` 事务中以 `FOR UPDATE ... SKIP LOCKED` 获取；冲突更新再次校验 immutable identity、retry due/lease expiry 与单调 version。

### 3. S3 调用不进入数据库事务

每个副本先取得有界 durable claim，提交并释放 PostgreSQL client 后才执行 S3：

1. validated HEAD 校验 content type、metadata identity、checksum、byte length，并取得 ETag 与可用的 VersionId；
2. 对 versioned object 使用精确 VersionId，对未版本化对象使用 ETag `If-Match` 条件删除；
3. upload promotion 的临时对象也必须先取得精确 VersionId 或 ETag authority，再按同一规则清理；无法证明临时对象身份时宁可留下可诊断对象，不得执行无条件删除；
4. 412/对象身份变化失败关闭并进入 retry/manual，不得删除新对象；
5. 删除成功或 HEAD 已不存在后，开启第二个短 PostgreSQL 事务；
6. 事务重验 owner/token/version/expiry、terminal Run/Attempt 与 immutable identity，插入 exact tombstone 后删除 control；
7. 删除响应丢失时，lease 过期后的新 claim 以 HEAD absent 写入 `already_absent`，最终收敛。

### 4. 有界调度与退避

每轮 claim 不超过 16 条，lease 范围 5 秒至 5 分钟；retry delay 最大 24 小时。副本不得持有跨 sweep cursor，也不得为每个 Attempt 建 timer。`ClusterRunAttemptLogRetentionLifecycle` 只拥有一个 `unref` timer，重叠 tick 合并为同一轮，单轮共享一个 wall-clock `AbortSignal`；停机先 abort、再在上限内 drain，且位于 application reverse-stop 的最前端。`artifact_unavailable`、`artifact_integrity_mismatch`、`retirement_record_unavailable` 是持久化失败分类；达到策略阈值后转 manual，避免坏对象形成热循环。

生产配置使用显式 `QL3_CLUSTER_LOG_RETENTION_*` 边界控制 retention、claim、lease、cycle budget、retry、manual threshold、cadence 与 stop timeout。能力默认启用，但只有 Worker ingress/S3 store 已激活时才装配，不为没有远端日志的 Cluster 进程增加 timer。

### 5. 读取收敛

PostgreSQL claim repository 同时实现 retention state reader。Cluster 日志读取在 S3 前检查 tombstone，并在 S3 missing 后二次检查：已 retired 返回 410；没有 tombstone 的 missing 继续保持 503，而不是伪造 retention。tombstone identity 或 digest 漂移失败关闭。

## 阶段验收

本 ADR 已完成从 PostgreSQL ownership 到对象删除、生产 lifecycle 和读取 410 的纵向闭环：

- PostgreSQL v54 authority 已覆盖 typed schema/readiness、最小权限、短事务 claim、完整 lease fence、retry/manual settlement、exact tombstone finalize/replay 与 state read；`cluster-postgres` 为 302 pass/1 条件 skip。
- S3 单元矩阵覆盖 versioned/unversioned 条件删除、412 identity drift、对象已不存在、删除响应丢失收敛、malformed HEAD，以及临时对象的 VersionId/ETag 精确清理；真实 MinIO 在强制 SSE-S3 下分别通过 versioning disabled/enabled，versioned 路径最终为零旧版本、零 delete marker。
- production composition 已把 reader、retirement store、coordinator 与 lifecycle 接入唯一 Cluster application；生产 HTTP 读取可由 durable tombstone 返回 410。`cluster-control` 为 230 pass/2 外部条件 skip。
- PostgreSQL 18.4 arm64 physical HA 在 timeline `1→2` 下通过 113 gates：旧主 claim 已 `remote_apply` 到 standby，提升且同步冗余恢复后旧 owner settlement 被 fenced，新主以 claim version 2 接管，随后原子写唯一 tombstone 并把 control count 收敛为 0。报告 SHA-256 为 `4be3053fc1af9ad6304715f5398292ba9a31ec5b3d49f64787510e2f2645ec5f`。
- 18 个 QL3 workspace package 的 clean build/test 门退出 0；后端兼容回归为 1163 pass/2 条件 skip/0 fail。package boundary 保持 18 package、1054 source、1036 nested、18 个受审 root entry，`singleSourcePackages=[]`、`shallowSourcePackages=[]`；`cluster-control` 为 51 source，其中 49 个 nested、2 个 root binary entry。
- dependency 与 Edge import audit 零 finding；Edge closure 的 121 个实际 imported module 不包含 PostgreSQL、AWS SDK 或 Cluster package。14 档 Local Profile artifact 与 Local image static audit 保持 compatible，因此本能力不会改变路由设备的默认数据库、连接、timer 或对象存储负担。

这些证据满足原六项收口条件，ADR 转为 Accepted。真实生产对象存储厂商矩阵、Kubernetes 多节点分区、基础设施 STONITH 与长期容量基准仍属于 Release Gate，不由本地 MinIO/PostgreSQL Docker 合约代替。

## 被否决的替代方案

1. **复用 Local durable cursor**：无法形成多副本 ownership，拒绝。
2. **在 PostgreSQL 事务中调用 S3**：把网络停顿扩大为数据库锁和故障域，拒绝。
3. **删除前写 tombstone**：可能把仍存在的对象声明为 retired，拒绝。
4. **无条件 DeleteObject**：无法防止对象身份变化或运维侧替换，拒绝。
5. **授予 tombstone UPDATE/DELETE**：破坏 immutable evidence，拒绝。
6. **新增 Cluster retention 微包**：现有聚合边界足够，且会继续放大 package 碎片化，拒绝。
