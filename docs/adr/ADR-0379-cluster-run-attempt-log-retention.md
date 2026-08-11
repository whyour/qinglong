# ADR-0379：Cluster Run Attempt 日志多副本保留与条件删除

- 状态：Proposed（PostgreSQL authority 已实现，S3/lifecycle/HA 验收待完成）
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
3. 412/对象身份变化失败关闭并进入 retry/manual，不得删除新对象；
4. 删除成功或 HEAD 已不存在后，开启第二个短 PostgreSQL 事务；
5. 事务重验 owner/token/version/expiry、terminal Run/Attempt 与 immutable identity，插入 exact tombstone 后删除 control；
6. 删除响应丢失时，lease 过期后的新 claim 以 HEAD absent 写入 `already_absent`，最终收敛。

### 4. 有界调度与退避

每轮 claim 不超过 16 条，lease 范围 5 秒至 5 分钟；retry delay 最大 24 小时。副本不得持有跨 sweep cursor，也不得为每个 Attempt 建 timer。调度复用 Cluster control application 既有 lifecycle，并受每轮 claim 数、删除数和 wall-clock budget 共同限制。`artifact_unavailable`、`artifact_integrity_mismatch`、`retirement_record_unavailable` 是持久化失败分类；达到策略阈值后转 manual，避免坏对象形成热循环。

### 5. 读取收敛

PostgreSQL claim repository 同时实现 retention state reader。Cluster 日志读取在 S3 前检查 tombstone，并在 S3 missing 后二次检查：已 retired 返回 410；没有 tombstone 的 missing 继续保持 503，而不是伪造 retention。tombstone identity 或 digest 漂移失败关闭。

## 阶段验收

第一阶段已完成 PostgreSQL authority：共享 claim contract、v54 migration、typed Drizzle/schema/readiness、最小权限、短事务 claim、完整 lease fence、retry/manual settlement、exact tombstone finalize/replay、tombstone state read。定向 63 项 migration/schema/readiness/repository 门通过；`runtime-core` 498 项全通过，`cluster-postgres` 302 项通过、1 项条件跳过，`cluster-control` 216 项通过、2 项条件跳过。

阶段收口还通过 18 个 QL3 workspace package 的完整 build/test 门，以及后端兼容回归 1163 项通过、2 项条件跳过、0 失败/取消。v54 readiness 引入的两张表已同步进入 `cluster-control` 测试数据库的最小权限 fixture，避免旧 v53 fixture 把正常启动误判为 `runtime_role_invalid`。

结构门保持 18 个 workspace package，`singleSourcePackages=[]`、`shallowSourcePackages=[]`。新 repository 只从明确的 Cluster runtime entrypoint 导出，不扩大 package root；PostgreSQL migration append-only `ordered_ledger` 的 reviewed hard cap 随 pg-0055 由 57 精确推进到 58，不把版本账本伪拆为子目录。

ADR 保持 Proposed，只有以下剩余项全部完成后才转 Accepted：

1. S3 validated HEAD + ETag/VersionId 条件删除和失败矩阵；
2. Cluster service 的 bounded claim/delete/backoff/manual 策略；
3. production composition、lifecycle drain 与读取 410；
4. MinIO versioned/unversioned 集成、响应丢失重放；
5. PostgreSQL 18 HA failover 中 lease takeover/tombstone 收敛；
6. 完整 package/backend/boundary/Profile/image gates，证明 Local closure 无 PostgreSQL/AWS SDK 回归。

## 被否决的替代方案

1. **复用 Local durable cursor**：无法形成多副本 ownership，拒绝。
2. **在 PostgreSQL 事务中调用 S3**：把网络停顿扩大为数据库锁和故障域，拒绝。
3. **删除前写 tombstone**：可能把仍存在的对象声明为 retired，拒绝。
4. **无条件 DeleteObject**：无法防止对象身份变化或运维侧替换，拒绝。
5. **授予 tombstone UPDATE/DELETE**：破坏 immutable evidence，拒绝。
6. **新增 Cluster retention 微包**：现有聚合边界足够，且会继续放大 package 碎片化，拒绝。
