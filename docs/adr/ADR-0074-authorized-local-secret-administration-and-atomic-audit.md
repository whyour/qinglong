# ADR-0074：授权的本机 Secret 管理与原子安全审计

- 状态：Proposed
- 日期：2026-07-20
- 关联 RFC：QL-RFC-0001 D-05、D-17、D-27、D-37、D-48、D-62、D-65、D-72、D-73
- 关联 ADR：ADR-0028、ADR-0029、ADR-0047、ADR-0049、ADR-0050、ADR-0063、ADR-0073

## 上下文

ADR-0073 已让全新本机 application 具备可达的加密 SecretStore，但只提供 envelope、keyring 和运行期解析能力。若直接把 plaintext 写入口放进常驻 application、数据库迁移 authority 或 legacy Controller，就会同时扩大 HTTP 漏洞、DDL 凭据和 Secret 明文的 blast radius；若只在 service 层先查权限、再单独写 envelope 和日志，RoleBinding 撤销及审计失败又会留下 TOCTOU 或“已写密文但没有授权事实”的崩溃窗口。

本机默认 Project 仍是 ownerless。迁移或首次启动自动授予 owner 虽然方便，却会绕过 D-27 的本机强认证 ceremony。目标用户还包括低性能路由设备，因此 Secret 管理不能增加常驻连接、timer、watcher、sidecar 或明文 cache。

## 决策

### 1. Secret 管理使用独立、短生命周期 authority

新增 `@qinglong/local-secret-admin`，生产只依赖 `@qinglong/local-secret` 与 `@qinglong/runtime-core`。它不得进入 `@qinglong/local-application`、edge/standalone application tarball 或任何常驻 Profile 组合根；依赖审计对所有其他 3.0 package 的反向导入 fail closed。

`local-admin` 继续只负责 SQLite migration/adoption，不能同时取得 Secret plaintext 管理 authority。数据库结构变更与业务密钥管理分离，避免一个运维入口同时拥有 DDL、keyring 和密文写入能力。

### 2. SQLite capability v5 提供最小 Policy 与审计事实

`0009-local-project-policy-audit` 新增：

- ownerless 的 `QingLong3Projects` 默认 Project；
- append-only、versioned 的 `QingLong3ProjectRoleBindings`；
- 低敏 `QingLong3SecurityAuditEvents`。

`0010-capability-v5` 声明 `local_project_policy`、`local_security_audit` 和 `local_secret_authorized_mutation`。migration、typed schema、manifest、readiness 与真实 catalog 必须 lockstep；默认 migration 不创建 owner，也不复用 legacy Sequelize 的 `0017/0018` bootstrap 表。

### 3. 认证和 Policy 必须先于 keyring/Secret 访问

管理请求只接受 exact-shape、UUIDv4 mutation/request identity、Project-bound Secret name、expected version、plaintext 和 `AuthenticatedPrincipal`。User 必须具备 `multi_factor`、`hardware` 或 `local_console` assurance；system/service 仍须是稳定 subject。弱认证先写 `authentication_rejected` 审计，且不得读取 keyring、查询 Secret 或执行密码学操作。

强认证主体经 `ProjectPolicyEngine` 检查 `secret.manage`。owner/admin 可允许，ownerless、operator/viewer、archived、损坏或依赖不可用均 fail closed。拒绝、需要审批和依赖不可用使用低敏审计，不记录 plaintext、密文、key material 或可还原值。

### 4. 最终授权、envelope 与 allowed audit 在一个事务裁决

service 层的 Policy 结果不是最终写权限。repository 在同一个 `BEGIN IMMEDIATE` transaction 中重新验证精确 Project version 与 RoleBinding subject/version/state/role fence，然后验证 Secret current version，最后同时追加 encrypted envelope 和 `allowed` 安全审计。

RoleBinding 在 Policy 判断后被撤销时，旧请求必须得到 `LocalSecretAuthorizationFenceConflictError`，不能写 envelope 或 allowed audit。audit insert 失败时整个 envelope mutation 回滚；不得以 best-effort 日志替代原子事实。实现复用唯一 `LocalSqliteRunRepository` 的 DatabaseSync、256 operation 队列和 close fence，不创建第二 SQLite authority。

### 5. 管理结果不回显明文

成功只返回 canonical SecretRef、version 和 `created|existing`。mutation replay 必须解密既有 envelope 后做 timing-safe 语义比较：同一 plaintext 返回 `existing`，不同 plaintext 作为 mutation identity collision 失败；任何响应、错误和审计都不返回输入 plaintext。

同一 mutation identity 一旦用于 authentication/policy 拒绝，不得随后被复用为 allowed mutation；调用方必须生成新的 mutation，以保留每次安全决策的唯一审计身份。

### 6. 首 owner 与产品入口继续保持不可达

当前 package 是可测试的领域/存储核心，不是可发布管理入口。首次 owner bootstrap 必须由后续本机控制台 ceremony 使用新的 Node 24 SQLite authority 原子建立，不能自动授予、复用默认密码或把 legacy session 直接当强认证。

CLI/HTTP/UI、独立速率限制、Secret 创建/轮换审批、keyring provision/rotation 编排、备份/rekey/retirement 和恢复流程完成前，默认部署不得暴露 Secret mutation。

## 被否决的替代方案

1. **把 Secret 写入口放入常驻 local-application**：扩大长期 plaintext 与远程攻击面，拒绝。
2. **把 Secret 管理并入 migration local-admin**：让 DDL authority 同时持有 keyring 和业务 mutation，拒绝。
3. **只在 service 层检查权限**：无法关闭撤权与写入之间的 TOCTOU，拒绝。
4. **先写 envelope、再 best-effort audit**：崩溃或审计故障会产生无授权事实的密文，拒绝。
5. **migration 自动建立默认 owner**：绕过首 owner 强认证 ceremony，拒绝。
6. **为管理请求增加专属连接、队列或 watcher**：给 edge 增加常驻成本并产生第二 SQLite authority，拒绝。

## 影响与未完成项

已完成：

- runtime-core 的本机 Secret 管理 repository/fence contract；
- Node 24 SQLite v5 migration/schema/readiness、ownerless Project、RoleBinding 与安全审计；
- 强 Principal、`secret.manage` Policy、拒绝先审计且 key-access-after-allow；
- Project/RoleBinding fence、Secret version、envelope 和 allowed audit 的单事务提交；
- 撤权竞态、审计回滚、语义 replay 与不回显测试；
- 二十二个 3.0 importer 的依赖/source/lock/advisory 注册，管理包不进入 application 产物。

仍未完成：

- Node 24 SQLite 首 owner bootstrap、可信 local-console issuer 与 production authentication wiring；
- 不回显 CLI/HTTP/UI、独立 rate limit、审批与 break-glass 流程；
- Project/RoleBinding 正式管理入口、审计 query/retention/export/alert；
- 数据库/keyring 配对备份、历史 envelope rekey、key retirement proof 和 crash-resume journal；
- `secret.use` 对 Task/Workflow/Agent 的完整 Policy/Approval 装配与已知值日志治理；
- PostgreSQL/KMS/Vault 管理 authority、Remote Worker 临时 Secret delivery 与多副本契约。

因此本 ADR 只关闭本机 Secret mutation 的授权、撤权竞态和原子审计断层；它不使 ownerless 默认部署获得管理能力，也不表示 QingLong 3.0 Secret 产品链已完成。

## 验证

1. owner 可以在一个事务中写 encrypted envelope 和 allowed audit，原始 row/响应均无 plaintext。
2. ownerless Project 被拒绝并审计，且 key provider 未被访问。
3. 弱认证被审计，Policy、Secret repository 与 key provider 均未被访问。
4. Policy 判断后撤销 RoleBinding 会触发 fence conflict，envelope/audit 均不写入。
5. 强制 audit insert 失败会回滚 envelope。
6. 同 mutation/same plaintext 返回 `existing`，不同 plaintext 冲突。
7. capability v5 的十条 migration、十四张 owned table、schema/readiness/manifest 与真实 catalog 一致。
8. application tarball 仍为十二个 package，且不包含 `@qinglong/local-secret-admin`。
