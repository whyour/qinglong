# ADR-0466：有界 Worker Session 兼容性观察

- 状态：Accepted
- 日期：2026-08-20
- 关联 RFC：QL-RFC-0001 D-373、D-14、D-16、D-107
- 关联 ADR：ADR-0012、ADR-0146、ADR-0464、ADR-0465
- Amends：ADR-0465 的 Worker 管理只读面后续边界

## 上下文

ADR-0465 已让 Worker Session 持久化 canonical architecture、support Tier 与 protocol version，并让 Scheduler
按 Tier 1 默认和显式 Placement 执行准入。但 operator 仍只能从数据库或日志拼接状态，无法通过受认证管理面回答：

- 当前 Session 是在线、draining、offline，还是 lease 已过期；
- Worker 是否可进入默认 Placement、必须显式选择，还是协议不兼容；
- 运行时、并发和声明容量是否足以解释“注册成功但没有领取任务”；
- 一个指定 Worker 的 generation/session version，或按稳定顺序查看下一小页 Worker。

另建 package、服务或轮询器会扩大低配部署和 Cluster 运维成本；直接返回 `capabilities_json`、labels、GPU model、
credential 或 lease token 又会把不必要的调度与 Secret 事实暴露到管理客户端。现有 Worker credential manager 已拥有
独立 TLS 1.3/mTLS/OIDC、强 User、`worker.manage`、耐久 quota、单独 PostgreSQL role 与固定 HTTP 路径，可以承载
同一 Worker 管理域的按需只读观察，但它的历史命名仍偏向 credential。

## 决策

1. 在既有三个职责边界内实现，不新增 workspace package：
   - `@qinglong/runtime-core/worker-session-observation` 拥有低敏投影和状态推导；
   - `@qinglong/cluster-postgres` 的 `remote-execution` 领域拥有只读 repository；
   - `@qinglong/cluster-admin` 的既有 Worker management service/transport/client 暴露管理操作。
2. 增加两个精确 operation：`worker-session.inspect` 与 `worker-session.list`。alpha 阶段继续复用固定
   `/api/v3/worker-credentials/management` listener、进程、连接池和客户端协议，不创建第二个 Worker 管理进程。
   该 URI 与 binary 的 credential 命名是明确的产品债务；Beta 前必须决定兼容 alias/通用 Worker management 路径，
   不能长期让通用 Worker 观察依附于误导性名称。
3. 两个操作都要求 fresh 强认证 User、authority Project 上的 `worker.manage`，并使用单一耐久 quota operation
   `worker-session.observe`。默认窗口上限为 600；inspect/list 以各自 `inspectionId` 派生幂等 receipt，caller 不能
   选择 quota operation、窗口或 limit。
4. PostgreSQL `pg-0069-worker-session-management-observation` 把 `control-core` 升至 capability v68，并只给
   `ql3_worker_credential_manager` 增加 `SELECT` on `ql3.worker_sessions`。迁移先 `REVOKE ALL` 再精确 `GRANT SELECT`；
   manager 不取得 INSERT/UPDATE/DELETE/TRUNCATE，executor、runtime 及其它管理角色不因本能力扩权。
5. point inspect 只按 canonical `workerId` 查询，最多接受一条 Session；list 固定读取 17 行、最多返回 16 行，按
   `workerId` 升序 keyset 分页。caller 只能提供 nullable `afterWorkerId`，不能提供 limit、排序、过滤表达式、自动翻页
   或任意 SQL 字段。
6. 每次 repository 调用用 PostgreSQL `statement_timestamp()` 取得一个数据库观察时间。生命周期与兼容性是投影，
   不是新的持久状态机：
   - lifecycle 为 `online|draining|offline|lease_expired`；
   - compatibility 为 `default_placement|explicit_placement_required|protocol_incompatible`；
   - protocol v1 且 Tier 1 才是 default placement；其它受支持 Tier 必须显式 Placement；不满足全局协议范围则不兼容。
7. list 只返回 Worker/Session/generation/version、lifecycle/compatibility、architecture/Tier/protocol、OS、并发与时间；
   point inspect 额外返回最多 32 个 runtime 及 `{cpuCores,memoryBytes,diskBytes,gpuCount}`。任何响应都不得返回 raw
   capability JSON/hash、labels、features、GPU model、credential、Secret、authentication identity 或 lease capability。
8. PostgreSQL row、runtime-core projection 和远程 client 分别执行严格校验。客户端拒绝未知字段、负数/越界容量、
   时间关系漂移、无序 page、cursor 漂移、observedAt 不一致和 secret-bearing widening，不能把受攻击的管理响应作为
   可信事实呈现。
9. 本能力是 caller-driven one-shot read：不新增 listener、Deployment、Service、连接池、timer、watcher、queue、cache
   或后台扫描。Edge/Standalone 与未启用 Worker manager 的 Cluster 路径不加载这些入口，也不创建 PostgreSQL authority。

## 升级与回滚

- 先用 migration role 执行 `pg-0069`，再滚动升级 Worker manager；旧 manager 不使用新增 SELECT，混合窗口安全。
- 回滚应用时可以保留 v68 schema 与只读 GRANT；旧应用 readiness 不接受 ahead-of-code schema，因此完整回滚必须使用
  对应数据库备份/受审降级流程，不能手工改写 migration history 或 capability JSON。
- 两个 operation 不修改 Session，也不影响 Worker heartbeat、Scheduler placement 或 execution revision digest；关闭
  Worker manager 即可撤销网络可达性。

## 被拒绝的替代方案

### 新建 `worker-observability` package 和常驻服务

拒绝。这里只有一个投影契约、一个 repository 与两个管理操作，没有独立部署、扩缩容或权限生命周期；拆包会重新
制造用户已指出的单文件/浅层 package，并让路由设备与供应链承担无收益边界。

### 直接返回 capability JSON 或 labels

拒绝。它会扩大响应、把未来字段默认公开，并泄露调度标签、硬件型号或可用于定向攻击的细节。管理面只返回明确评审的
固定投影。

### list 接受 caller limit、任意 filter 和自动轮询

拒绝。caller-controlled query 会使低配管理节点承担不可预测扫描，自动轮询会引入空闲网络、数据库和 CPU 成本。固定
16 项 keyset 页面需要 operator 显式发起下一次读取。

### 为观察结果新建数据库表

拒绝。lifecycle 与 compatibility 都能由 immutable capability、Session 状态、lease 和数据库时钟确定；复制一份状态会
产生跨副本漂移和额外写放大。

## 验证与证据

- runtime-core 聚焦测试覆盖四种 lifecycle、三种 compatibility、Tier/协议、详细/摘要投影和非法数据库时间。
- Cluster PostgreSQL repository 测试覆盖 point、masked absence、固定 16+1 keyset、同一数据库时钟、身份/排序/行上限
  与 canonical capability fail-closed。
- Cluster Admin service/transport/client 测试覆盖强 User + `worker.manage`、耐久 quota、六种现有 Worker management
  operation、严格响应交叉不变量与 secret-bearing widening 拒绝。
- PostgreSQL migration/readiness 聚焦门 `76/76`；Cluster PostgreSQL 全量 `351 total / 348 pass / 3 conditional skip /
  0 fail`；Cluster Admin 全量 `421 total / 418 pass / 3 conditional skip / 0 fail`。
- 完整 backend 工作区为 `1,503 total / 1,501 pass / 2 conditional skip / 0 fail`；总数包含工作树中既有且不进入
  本阶段提交的用户测试，本提交没有修改或暂存该文件。
- PostgreSQL 18.6 arm64 physical HA 门 `146/146`、timeline `1→2`，报告 SHA-256 为
  `c4cf0189b68d7af18169cd8f8de726e26a970af703f28d4ffe0ad3ace96fa596`。主库 readiness 使用真实
  `ql3_worker_credential_manager` 连接复验 v68 migration 与精确 Worker manager ACL；promotion、旧主 fencing、
  `pg_rewind` 和只读 rejoin 全绿。
- package boundary、Cluster dependency、Edge import、Cluster deployment 与 Worker deployment 审计全部 compatible；
  workspace 保持 18 packages，`singleSourcePackages=[]`、`shallowSourcePackages=[]`。runtime-core 为 `171 source / 170
  nested`，Cluster PostgreSQL 为 `175 source / 174 nested`，没有新增外部 dependency。
- 14 档 Local artifact audit 全部 compatible；基础 Edge/Standalone 为 `2,598,669 / 2,598,747` bytes 且都只加载
  57 modules，Application+AI 为 `4,501,822 / 4,501,954` bytes，MCP 为 `7,324,601 / 7,324,709` bytes。新增子路径被
  artifact projection 裁剪，没有进入低配 Profile 启动闭包。

## 后续边界

- Beta 前提供不误导的通用 Worker management 路径/CLI 命名及兼容迁移，不复制 listener 或 authority。
- Console/UI 若接入，必须保持显式点击、固定 16 项、无轮询/自动翻页，并隔离短期 assertion；不能把管理 capability
  放入普通 Project API credential。
- 如需按 Project、label、资源池或健康历史查询，必须先定义 ownership、索引、保留期、响应预算与隐私边界；不得把
  本次 cluster-wide 当前 Session 读取悄悄扩成无界 inventory/metrics 系统。
- 当前沿用既有 Worker credential management 的 quota/认证模型；若统一管理面引入持久化 read-access audit，应对
  credential inspect 与 Session observe 一并设计事务和 retention，不能只给其中一个操作制造不一致的审计语义。
