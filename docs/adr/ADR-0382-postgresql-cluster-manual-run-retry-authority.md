# ADR-0382：PostgreSQL Cluster 手动 Run retry 原子 Authority

- 状态：Accepted
- 日期：2026-08-12
- 关联 RFC：QL-RFC-0001 D-294
- 前置决策：ADR-0039、ADR-0047、ADR-0119、ADR-0361、ADR-0381

> 产品装配说明：ADR-0383 已 supersede 本文“复用 `ql3_runtime` 且不新增 role/migration”的决策。本文的共享 retry 语义、原子 repository 与 HA 证据继续有效；生产入口改由强认证的独立 Run Management Plane 和 `ql3_run_manager` 承载。

## 上下文

ADR-0381 已冻结手动 retry 的共享语义并完成 Local SQLite/CLI 纵向切片，但 Cluster 尚缺少可在多副本下工作的 PostgreSQL authority。不能把 Local 的进程内状态或单连接假设复制到 Cluster，也不能让每个 `cluster-control` 副本各自维护限流 bucket。

现有 Cluster Control bearer 只建立 `single_factor` User。即使数据库事务能够安全创建新 Run，也不能因此把该 bearer 宣称为强认证产品入口。存储 authority、可信认证 transport 与 HTTP route 必须分层交付。

## 决策

### 1. PostgreSQL adapter 复用共享领域契约

`@qinglong/cluster-postgres/run-manual-retry` 实现 ADR-0381 的 `RunManualRetryRepository`，不定义第二套 Cluster 请求或结果。它只接受五分钟内且未过期的 `multi_factor|hardware` User，并在单个 `SERIALIZABLE` 事务内：

1. 取得 Project 行锁并重验 Project/RoleBinding fence；
2. 精确检查 mutation replay；
3. 锁定源 Run，重验终态、版本、顶层/runtime-owned/非 Workflow 与 remote Worker execution revision；
4. 重验 current Task enabled 与 immutable execution digest；
5. 消耗持久全局配额；
6. 原子插入新 queued Run、claimed remote Worker Attempt、两个 Event 与 allowed security audit。

源 Run 保持终态；新 Run 以 `retry_of_run_id` 关联源 Run，不继承 `run_retry_policies`。相同 mutation 的精确重放返回原 Run/Attempt identity；字段漂移返回 `mutation_conflict`。

### 2. Project 行锁是跨副本序列化点

同一 Project 的授权管理 mutation 已使用 Project 行锁。手动 retry 复用该锁来序列化 Policy fence、Task current head 和 append-only RoleBinding 观察；RoleBinding/Task 查询不使用 `FOR SHARE`，因为 PostgreSQL 行锁语法会额外要求 UPDATE table privilege，不能为了读取证明扩大 runtime role。

事务使用既有 `ql3_runtime` 最小权限：读取 Project/RoleBinding/Task/execution，读写 Run aggregate，并只 INSERT security audit。不会新增数据库角色、迁移、表、索引或函数。

### 3. 全局限流复用 Run ledger

Cluster 固定为同 Project、同 User 每分钟最多 64 个新 `run_manual_retry` Run。事务取得 Project 锁后，使用既有 `(project_id, created_at_ms, id)` Run ledger/index 查询窗口；因此多个 Pod、进程重启和主备切换共享同一额度。精确 replay 不消耗额度，也不新增 quota table、cache、timer、listener 或 sidecar。

### 4. 存储可用不等于产品入口可用

本 ADR 只接受 PostgreSQL authority。现有 Cluster Control bearer 仍是 `single_factor`，不得连接该 mutation。公开 HTTP/UI 必须等待 purpose-bound OIDC MFA 或 hardware-backed User transport，并在 route admission 与事务提交前分别完成认证/Policy/audit fence；MCP、Worker、AI Tool 不取得该 authority。

## 验收

- SQL 契约测试覆盖原子五类写入、精确 replay、认证/授权 fence、持久配额和 serialization retry；
- 真实 PostgreSQL 必须使用两个独立 Runtime Pool 并发竞争同一 mutation 与最后一个 quota slot；
- 同步 standby 必须在 promotion 前观察 64 个 retry Run/Attempt、128 个 Event、64 条 allowed audit、零继承 policy；
- promotion 后必须保留相同事实，源 Run 仍为 failed；
- 完整 package、backend、dependency/package/Edge import 与 Profile artifact 门通过后才允许阶段性提交。

### 验收证据（2026-08-12）

- Cluster PostgreSQL package：308 项中 307 通过、1 项按外部数据库条件跳过；新增 5 项专项测试全部通过；
- PostgreSQL 18.4 arm64 physical HA：119 gates，timeline `1→2`，两个独立 Runtime Pool 完成 exact concurrent replay 与全局 quota 竞争；报告 SHA-256 `ca5d33a30f2768072223fb22346d962866948b0c0c970b62a6338d25a3ac9dda`；
- promotion 前后均为 64 retry Run、64 claimed remote Attempt、128 Event、64 allowed audit、0 retry policy，源 Run 保持 failed；
- 18-package clean build/test 完整退出 0；backend 1,165 项中 1,163 通过、2 项环境条件跳过、0 失败；
- package/dependency/Edge import audit 零 finding；workspace 为 18 package、1,061 source、1,043 nested，`singleSourcePackages=[]`、`shallowSourcePackages=[]`；
- 14 种 Local Profile artifact 与 Local image static audit 全部 `compatible:true`，最小 Edge 仍只有 Local SQLite/Runtime Core/SemVer、53 个 loaded module，不包含 Cluster/PostgreSQL/pg；
- 本批没有新增 workspace package、第三方依赖、migration、数据库对象或常驻资源。

## 被否决的替代方案

1. **每副本内存 token bucket**：重启可绕过且总额度随副本数增长，拒绝。
2. **新增 quota 表或定时清理器**：既有 Run ledger 足以裁决，会增加迁移与低配/集群共同维护成本，拒绝。
3. **为 `FOR SHARE` 授予 RoleBinding/Task UPDATE**：只是满足 SQL 语法，不是业务写权限，会破坏最小权限，拒绝。
4. **使用 superuser 或 migration Pool 执行 retry**：掩盖生产角色缺口并扩大事故半径，拒绝。
5. **直接接入 Cluster bearer HTTP**：当前只有单因子认证，不满足恢复执行的强认证边界，拒绝。
6. **为 adapter 新建 workspace package**：能力属于既有 PostgreSQL driver domain，不具备独立制品或依赖隔离收益，拒绝。

## 后续工作

- 为 Cluster 管理面接入 purpose-bound OIDC MFA/hardware transport，再装配 `run.retry` route；
- 增加受审 UI 的 source/new Run linkage、terminal reason 与 retry preview；
- 为 Workflow/StepRun 独立冻结 recovery 语义，不复用顶层 Run retry；
- 在真实 Kubernetes 多节点门中补充管理 transport、Pod 重调度与数据库 failover 的组合证据。
