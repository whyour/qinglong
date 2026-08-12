# ADR-0384：强认证的 Cluster Run Stop Management

- 状态：Accepted
- 日期：2026-08-12
- 关联 RFC：QL-RFC-0001 D-296
- 前置决策：ADR-0005、ADR-0039、ADR-0056、ADR-0372、ADR-0383
- Supersedes：ADR-0383 中“`ql3_run_manager` 没有更新既有 Run 权限”的最小权限定义；其余进程、认证、部署与 package 决策保持有效

## 上下文

ADR-0383 已建立独立、强认证、显式启用的 Cluster Run Management Plane，但产品面只暴露 `run.retry`。Cluster Control 已有内部 cancellation repository，直接把它接到产品 route 会留下三个缺口：允许审计与取消意图不在同一事务、专用管理角色没有精确写权限、调用方可能绕过 Run Management 的 purpose-bound OIDC 与五分钟强认证。

QingLong 同时面向低资源路由设备和多节点集群。本能力不能给 Edge/Standalone 增加常驻成本，也不能为单个命令新增浅 package、独立进程、连接池或部署 overlay。

## 决策

### 1. 扩展既有内聚领域，不新增 package 或进程

`run.stop` 与 `run.retry` 复用 `@qinglong/cluster-admin/run-management` 的 service、discriminated transport、HTTPS route、client、OIDC keyset、mTLS listener、PostgreSQL Pool 和 `operations/run-management` 部署。PostgreSQL adapter 继续由 `@qinglong/cluster-postgres/run-manager` 发布。

默认 Edge、Standalone、Cluster base overlay 均不加载该能力；关闭 Run Management 时仍为零新增进程、listener、Pool、timer、watcher、cache、sidecar 与 Cluster dependency。这里以“领域内聚 + 独立部署生命周期”决定 package 粒度，不以文件数量决定 package 数量。

### 2. 固定强认证命令与服务端身份

transport 只接受 `operation=run.stop`、Project/Run identity、UUID mutation identity 和低敏 request/audit identity，不接受 caller 提供 Event ID、时间、取消原因、Run version 或状态。服务端生成 canonical `qinglong/run-cancellation@v1` Event ID，并固定 `cancel_reason=user`。

操作必须同时满足 mTLS、`run-management` purpose-bound OIDC、五分钟内 `multi_factor|hardware` User 和 `run.stop` Policy。route admission 与 PostgreSQL 事务分别重验身份和 Project/RoleBinding fence；不存在继续遮蔽，终态或 durable fence 漂移稳定映射为 conflict。

### 3. 取消意图与允许审计原子提交

PostgreSQL repository 在一个 `SERIALIZABLE` 事务中使用数据库时钟，锁定 Run，重验 `lock_run_management_policy_fence`，写入 `cancel_requested_at_ms`、`cancel_reason`、Run `version`、`event_sequence`，追加 immutable cancellation Event 和 `run.stop` allowed security audit。任一写入失败都整体回滚；拒绝或不可用由 service 写独立 failure audit。

相同 mutation 的重放必须返回 `already_requested`，并验证已有 Event 与 allowed audit 的精确语义；不同 mutation 不能覆写既有取消意图。terminal Run 不接受新的 stop。该操作只记录 durable intent，实际 Attempt/Run 收敛仍由既有 cancellation dispatch、lease/fencing 与 recovery authority 完成。

### 4. PostgreSQL 权限按列收窄

Migration `pg-0057-run-management-stop-boundary` 把 control-core contract 提升到 v56，并添加 `run_management_stop` capability。`ql3_run_manager` 不获得 Runs 表级 UPDATE，只获得以下四列的 column-level UPDATE：

- `cancel_requested_at_ms`
- `cancel_reason`
- `version`
- `event_sequence`

readiness 同时证明四列可更新、`status` 不可更新、表级 UPDATE 仍为 false。角色不得改变 Run 状态、Project/RoleBinding、Task、execution revision，且继续没有 DELETE、migration、Worker、AI 或 Approval authority。

## 验收

- service/transport/client 测试覆盖 stop、强身份、命令 shape、response drift、原子 allowed audit 与稳定错误映射；
- PostgreSQL 测试覆盖 v56 checksum/capability、精确列权限、事务顺序、exact replay、fence 漂移和回滚；
- 真实 PostgreSQL 18.4 physical HA 以两个独立 `ql3_run_manager` Pool 证明跨 Pool replay、允许审计同步复制与 promotion 后写入；
- 完整 18-package clean build/test、backend、dependency/package/deployment/Profile artifact、GitNexus change scope 全部通过后才允许阶段性提交。

## 被否决的替代方案

1. **新增 `@qinglong/run-stop` package**：没有独立依赖、制品或部署生命周期，只会制造浅 package。
2. **新增 stop listener/Pool/overlay**：与 retry 共享同一认证和资源边界，会重复常驻成本。
3. **授予 Runs 表级 UPDATE**：会允许管理角色修改状态与其他控制字段，超出产品操作所需。
4. **先写 allowed audit、再写取消意图**：可能留下“审计显示成功但意图未提交”的错误事实。
5. **由调用方提交 Event ID 或 cancel reason**：扩大重放和语义漂移表面。

## 验收证据（2026-08-12）

- `@qinglong/cluster-admin`：284 pass、2 个外部集成条件 skip、0 fail；`@qinglong/cluster-postgres`：311 pass、1 个外部数据库条件 skip、0 fail；完整 18-package clean build/test 全部退出 0；
- backend 1,167 项中 1,165 pass、2 个环境条件 skip、0 fail；package/dependency/Edge import/Cluster deployment/CloudNativePG/Local image 静态门均 compatible、零 finding；
- workspace 保持 18 个 package、1,071 个 source、1,053 个 nested，`singleSourcePackages=[]`、`shallowSourcePackages=[]`；`cluster-postgres` 为 153/152，v56 migration 归入既有 `run-management` 领域，没有新增浅 package；
- 14 档 Edge/Standalone Profile artifact 全部 compatible；最小 Edge 仍仅包含 Local SQLite、Runtime Core 与 `semver`，产物 2,459,624 bytes、53 个 loaded module，未引入 Cluster/PostgreSQL；
- PostgreSQL 18.4 arm64 physical HA 通过 123 gates、timeline `1→2`，证明列级 UPDATE readiness、双 Run Manager Pool exact replay、allowed audit 同步复制、既有 cancellation convergence、旧主 fencing，以及恢复 `remote_apply` 同步冗余后的 promotion stop；报告 SHA-256 `2e5759d3b5e62cd571f6c31450aec0d7f611fa8cafd727b7bb25471792e83c29`，独立离线审计 `compatible:true`、零 finding。

## 影响

- PostgreSQL schema contract 从 v55 升至 v56；启用新版 Run Management 前必须先运行 migration 和 readiness；
- Cluster Run Management route 成为 `retry | stop` 的严格判别联合，但既有 retry envelope/response 保持兼容；
- 低配设备默认资源与依赖闭包不变；集群只在已选择的 Run Management workload 内增加同一 Pool 上的一类短事务；
- UI 后续可以复用同一 transport 展示 durable cancellation intent，但不得直接写 Run 状态或绕过强认证。
