# ADR-0035：Approved Action 人工恢复授权与强认证事实

- 状态：Proposed
- 日期：2026-07-19
- 关联：QL-RFC-0001、ADR-0028、ADR-0029、ADR-0030、ADR-0031、ADR-0033

## 上下文

ADR-0033 只允许人工把 post-start unknown action 显式终结为 succeeded、failed 或 blocked，禁止把旧 dispatch 重置后再次执行。这个操作会改变审计事实，也可能掩盖一个已经发生但无法验证的外部副作用，因此普通登录、可变 username、Agent 身份或仅在应用层判断一次角色都不足以授权。

人工服务先做 Policy 判断、随后 Repository 写终态时还存在撤权竞态：如果 owner/admin binding 或 Project version 在两步之间变化，旧的 allow 结果不能继续生效。授权记录若在终态提交之后另写，又会留下“动作已经被人裁决，但无法证明当时认证与授权上下文”的崩溃窗口。

因此人工恢复必须把稳定 User、近期强认证、Project Policy version fence 和低敏授权事实绑定到同一个终态事务。

## 决策

### 1. `approval.recover` 是独立的 Project permission

人工恢复只请求 `approval.recover`，不复用 `approval.decide`、`project.manage` 或通配 Tool 权限。固定角色矩阵为：

- owner、admin：允许；
- operator、viewer：拒绝；
- 未绑定、已撤销或 archived Project：默认拒绝。

首版继续使用静态 Policy Core；未来接 OPA 或自定义策略时也必须返回 Project/RoleBinding version fence，不能只返回一个布尔 allow。

### 2. 只接受仍有效的稳定 User principal

应用服务接收 ADR-0029 的 exact-shape `AuthenticatedPrincipal`，并在读取 recovery storage 前验证：

- `subject.type=user`；
- principal 在服务时钟上满足 `authenticatedAtMs <= now < expiresAtMs`；
- assurance 为 `multi_factor`、`hardware` 或 `local_console`；
- `now - authenticatedAtMs <= 5 分钟`。

`single_factor`、`service`、Agent、API App、MCP Client、Worker 和 System 均不能进行人工恢复。legacy `twoFactorActivated` 仍不是 MFA 事实；只有未来可信 authentication adapter 验证真实 ceremony 后才能产生上述 assurance。本 ADR 不定义 MFA 协议、恢复码或 local-console issuer。

### 3. Policy 判断必须携带可提交的 version fence

服务从 recovery snapshot 取得 immutable Project ID，以稳定 User 请求 `approval.recover`。只有 `allow` 且 Project version、当前 RoleBinding version 都存在时才构造授权事实。

SQLite Repository 在同一个 `BEGIN IMMEDIATE` 中重新读取最新 Project 与该 User 的 RoleBinding version：任一 version 不一致即以 fence rejection 失败，且在写 recovery resolution 或 execution 终态前退出。这样 revoke、role change、Project archive 或其他 version mutation 无法穿透已经计算出的 allow。

### 4. `0024` 授权事实与人工终态原子提交

`ApprovedActionRecoveryAuthorizationFacts` 与 human resolution 一对一，保存：

- dispatch、Project、manual mutation ID 和稳定 User ID；
- authentication ID、强 assurance、认证时间；
- Policy 判断使用的 Project/RoleBinding version；
- 授权时间；
- 对以上 canonical 字段计算的 SHA-256 fact digest。

表只允许 User 和三种强 assurance，要求正 version、认证时间不晚于授权时间且间隔不超过五分钟，并通过外键绑定 recovery resolution 与 Project。它不保存 cookie、JWT、MFA secret、recovery code、请求 header 或无界理由。

Repository 在一个事务内依次复验 execution/recovery fence、复验 Policy version、插入 human resolution、推进 execution/control 终态并插入授权事实。任一约束、trigger 或 commit 失败全部回滚，不能留下“有终态无授权事实”或“有授权事实无终态”。automatic evidence resolution 不创建人工授权事实。

### 5. 幂等重放必须包含相同授权事实

相同 manual mutation 只有在 decision、reason、evidence、User、时间和 authorization fact 全部精确一致时返回原结果。字段漂移、digest 不匹配或一条旧 human resolution 缺少 `0024` fact 时不补写、不重新解释，稳定返回 terminal/conflict 语义。

服务在重放前仍验证当前 principal 和当前 Policy；历史 allow 事实只用于审计与精确幂等，不成为永久授权 capability。

### 6. 当前保持 production unreachable

本切片已经实现 permission matrix、强认证应用服务、`0024` migration、SQLite 原子 Repository 和 contract tests，但没有注册到 app、loader、legacy service、API、CLI、MCP 或 UI。生产启用仍需要：

- 真实 MFA/hardware/local-console authentication adapter 与 credential 生命周期；
- 人工恢复列表、低敏证据预览、二次确认、rate limit 和审计 API/UI；
- 对外错误屏蔽，避免未授权调用者区分 dispatch 是否存在；
- profile-aware recovery lifecycle、指标、告警与积压门禁；
- PostgreSQL adapter 与多副本 revoke/resolve 竞争 contract；
- edge 设备和 cluster 节点上的故障注入与资源门禁。

## 影响

正面影响：

- 高风险 unknown 终结不能由 Agent、普通 session 或 operator 越权执行；
- 授权撤销竞态由数据库 version fence 关闭；
- 认证、授权与终态形成一个可验证、低敏、原子的审计事实；
- edge 只增加一次人工操作时的短事务和单行事实，不增加 watcher、timer 或常驻连接；
- cluster adapter 可以复用相同语义，通过 PostgreSQL row lock 实现多副本一致裁决。

代价与风险：

- 单用户部署若没有可信强认证入口，将不能使用人工恢复；这是安全门禁，不应降级为密码确认；
- 每条人工 resolution 增加一行保留事实和关联索引；
- authentication ID 虽非 Secret，仍属于安全审计标识，API 默认不得向普通读取者暴露；
- 当前只有 SQLite adapter，不能据此宣称 cluster-control 已可用。

## 未选择的方案

1. **owner/admin 登录即可恢复**：single-factor session 不足以授权未知副作用终结，拒绝。
2. **复用 `approval.decide`**：审批新动作与裁决已发生但未知的动作风险不同，拒绝。
3. **只在应用层检查 Policy**：检查与提交之间存在 revoke/archive 竞态，拒绝。
4. **终态提交后异步写审计日志**：崩溃会产生不可证明的人工裁决，拒绝。
5. **把完整 JWT/MFA 证明写数据库**：扩大 Secret 与隐私暴露面，拒绝。
6. **旧单用户环境自动提升为 local console**：UID、TTY 或私有文件本身不能证明可信 ceremony，拒绝。
7. **授权事实缺失时自动补写**：无法还原历史认证与 Policy snapshot，拒绝。

## 验证要求

- owner/admin 允许，operator/viewer/未绑定/revoked/archived 拒绝；
- 非 User、过期 principal、single-factor/service 或超过五分钟的强认证在 storage read 前拒绝；
- Project/RoleBinding 在 Policy allow 后变化时，Repository 在任何终态写入前 fence rejection；
- resolution、execution/control 终态与 authorization fact 同事务提交，fact 插入失败全部回滚；
- fact exact-shape、强 assurance、时间窗口、version、digest 或 identity 任一漂移均 fail closed；
- 精确 manual mutation 重放返回同一结果，变形重放不得覆盖原事实；
- automatic evidence resolution 不依赖或伪造人工授权事实；
- migration/schema ownership 覆盖表、索引、约束和外键；
- production reachability 搜索证明服务和 Repository 未被旧 app/loader/API/service 路径导入；
- Node 22 兼容门禁与固定 Node 24 目标门禁均通过。
