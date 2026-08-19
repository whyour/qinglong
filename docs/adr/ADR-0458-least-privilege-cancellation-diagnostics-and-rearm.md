# ADR-0458：最小权限 CancellationDispatch 诊断与人工 Rearm

- 状态：Accepted
- 日期：2026-08-19
- 关联 RFC：QL-RFC-0001 D-365、PR-5、PR-7
- 关联 ADR：ADR-0005、ADR-0383、ADR-0456、ADR-0457
- Amends：ADR-0005 的 blocked 人工处置边界、ADR-0456 的 PostgreSQL Run manager authority

## 上下文

ADR-0456/0457 已让 Cluster Run cancellation 具备数据库计时、跨副本 fencing 和真实 Worker 交付，但 `identity_mismatch`、`pid_mismatch`、`unsupported`、`invalid` 会有意进入 `blocked`，禁止自动重试。没有受权诊断与人工 rearm 时，operator 只能直接查询或修改数据库；这既容易泄露 lease capability，也绕过 Project Policy、强认证、RunEvent 和安全审计。

QingLong 同时面向低配路由器与集群。该能力只属于 Cluster operator plane，不能扩大 Local Profile 闭包，也不应为了两个 operation 新建微包、HTTP 服务、扫描 timer 或数据库连接池。

## 决策

1. 复用既有隔离 `cluster-admin` Run management HTTPS/mTLS process、固定 `/api/v3/runs/management` 路径、OIDC assertion、速率限制、连接池和 shutdown lifecycle。新增 operation 为 `run.cancellation.inspect` 与 `run.cancellation.rearm`，不新增服务或部署对象。
2. inspect 只接受强认证 User，授权使用既有 `run.read`。因此 viewer 可诊断，agent、弱认证、过期认证和 authorization fence drift 均失败关闭。
3. diagnostic 只投影 Project/Run 状态、取消意图、Attempt ID、dispatch status/version/count、受限时间戳、固定 last result 与 `none|wait|rearm` 建议。lease owner、raw token、token digest、PID、handle、命令、环境、Secret 和错误原文永不进入 SQL projection、transport schema 或客户端结果。
4. rearm 继续使用 `run.stop`，不新建更宽 permission。请求必须精确匹配 `blocked`、expected dispatch version 和 expected blocking result，并提供 1 秒至 24 小时的 retry delay；服务端生成 RunEvent ID，调用方不能塑造 event identity。
5. Repository 使用 SERIALIZABLE 短事务和 PostgreSQL `transaction_timestamp()`。它重新锁定 Project Policy fence 与 Run，验证非终态 Run、既有 cancellation、同 Run active Attempt 和精确 dispatch CAS；绝对 `next_attempt_at_ms` 只能由数据库计算。
6. 成功 rearm 在同一事务中推进 Run version/event sequence，把 dispatch 切换为 `retry_wait` 并递增 version，追加 `run.cancel_dispatch_rearmed` 和 allowed security audit。事件 payload 只包含 mutation、前后 version、固定 blocking result、delay、due time 与 Run version。
7. mutation replay 先读取 immutable RunEvent，只有 actor、mutation、version、result、delay 和 receipt 全部相同时返回原 receipt；任何漂移返回 conflict，不重复更新 dispatch。
8. rearm 保留原 blocking `last_result` 作为历史，因此 canonical/SQL 状态约束允许 `leased|retry_wait` 携带 blocking 或 retryable history；新 claim/result 仍按当前 status 与精确 fence 决定，不把历史结果当作新的 controller verdict。
9. `pg-0067-cancellation-dispatch-management` 把 capability 提升至 v66。`ql3_run_manager` 只新增 dispatch SELECT 与四列 UPDATE：`status`、`version`、`next_attempt_at_ms`、`updated_at_ms`；没有 INSERT、DELETE、TRUNCATE、lease 字段 UPDATE 或 schema authority。
10. Attempt active check 在已有 SERIALIZABLE 事务与 Run 行锁后执行普通 SELECT。PostgreSQL 的 `FOR KEY SHARE` 也隐含要求至少一列 UPDATE 权限；为行锁扩大 Run manager 的 Attempt UPDATE authority 被拒绝。并发终态变化由 Run 锁与 serializable ordering 收敛。
11. 新 repository 留在现有 `cluster-postgres/run-management` 子域，协议留在现有 `cluster-admin/run-management` 子域。新增两个文件不会成为拆分 package 的理由；workspace 继续精确为 18 包。

## 被拒绝的替代方案

### 直接暴露数据库记录

拒绝。原始表包含 lease owner/token digest 等 capability-adjacent 字段，也没有逐请求 Policy、强认证、审计和响应 shape 验证。

### blocked 自动重试

拒绝。身份、PID 或协议不匹配不是瞬时可用性问题；自动循环可能向错误执行实例重复交付停止。

### 新建 cancellation-admin 服务或 package

拒绝。既有 Run management plane 已拥有完全相同的用户身份、Project Policy、mTLS、连接和生命周期边界。另建服务会增加低价值微包、端口、Secret 和部署成本。

### 给 Run manager 增加 RunAttempt UPDATE 权限

拒绝。该权限只为满足 PostgreSQL 行锁语法，而不是业务 mutation。SERIALIZABLE + Run lock + 普通读取足以表达合法顺序，不能为了实现细节扩大 authority。

## 资源、安全与部署影响

- Edge/Standalone package closure 不包含 `cluster-admin`、`cluster-postgres` 或 `pg`；14 个 Local Profile 预算不变化。
- Cluster 复用既有 caller-driven management request，没有扫描 timer、后台队列、缓存、额外连接或空闲写入。
- 每次 inspect/rearm 最多一个 5 秒 statement timeout 的 SERIALIZABLE 短事务；rearm 只在人工明确操作时写一条 RunEvent 和一条 audit。
- response 与客户端都做 exact-shape 验证；未知字段、目标漂移、version/result/delay 漂移和 lease capability 泄漏失败关闭。

## 验证

- Repository 聚焦测试 `5/5`，service `6/6`，transport/client `12/12`；覆盖低敏 inspect、viewer/read 与 operator/stop 分权、exact replay、stale fence、失败审计和 secret-field tampering。
- `cluster-postgres` 完整包 `339 pass / 0 fail / 3 conditional skip`；`cluster-admin` 完整包 `394 pass / 0 fail / 3 conditional skip`。
- 完整 backend `1,487 pass / 0 fail / 2 conditional skip`；18-package clean build/test 退出 0。
- package boundary、cluster dependency、Edge import、cluster deployment 四项审计零 finding；workspace 仍为 18 包，Cluster PostgreSQL 为 172 source/171 nested，根入口计数不变。
- `14/14` Local artifact audit 通过：基础 Edge/Standalone `2,589,998 / 2,590,076` bytes，Application+AI `4,493,151 / 4,493,283` bytes，均不包含 PostgreSQL closure。
- PostgreSQL 18.6 arm64 HA `144/144`：真实 `ql3_run_manager` 执行 blocked→inspect→rearm，验证 retry not-due、最终 production dispatch、同步 WAL、主库隔离与 standby promotion；timeline `1→2`，报告 SHA-256 `58f43327f426c286aaa1764aa6dd9f5963a462304716e09b933f326991442b8a`。

## 后续

ADR-0459 已用既有管理面完成数据库事实驱动的 Project 级 blocked/availability 汇总；ADR-0460 已增加一次性产品状态卡、稳定 JSON 与告警退出码。有界 blocked drill-down 和 Console 可选接入仍待实现。CloudNativePG live failover、多副本容量压力、固定 Linux x64/arm64 与物理 Edge 资源证据继续作为发布最终化门，不由单机 Docker HA 结果替代。
