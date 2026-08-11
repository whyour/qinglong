# ADR-0264：独立 Cluster Model Provider Credential 管理边界

- 状态：Accepted
- 日期：2026-08-02
- 关联：RFC D-08、D-12、D-85、D-159；ADR-0169、ADR-0263

## 背景

ADR-0263 已交付 append-only Provider credential catalog、durable use audit、只读
projected material 和显式 Cluster AI composition，但 binding 配置仍没有产品管理 ceremony。
直接让常驻 control 或通用 `ql3_ai_maintenance` 执行 binding mutation 都不合理：

- control 会从 runtime read/audit authority 升格为 credential mutation authority；
- `ql3_ai_maintenance` 同时拥有 Prompt output GC/key-retirement 权限，常驻管理服务复用它会
  取得与 credential binding 无关的 Artifact 删除能力；
- 只在 HTTP 层检查 Policy、再用 raw repository 写 transition，会留下授权撤销 TOCTOU 和
  mutation 已提交但允许审计缺失的窗口；
- 请求体自报 actor、Policy decision 或 fence 无法形成可信产品入口。

## 决策

### 1. 使用独立数据库角色但不新增 workspace package

CloudNativePG 增加 `ql3_ai_credential_manager`，connection limit 为 4。该角色只取得：

- `ql3.projects`、`ql3.project_role_bindings`、`ql3.security_audit_events` 的 SELECT；
- `ql3.security_audit_events` 的 INSERT；
- `ql3_ai.ai_schema_migrations`、credential binding/transition/use-audit 的 SELECT；
- credential binding/transition 的 INSERT。

它没有 UPDATE/DELETE、schema CREATE、Prompt output、price catalog、invocation、runtime、
Worker、Package 或 migration authority。`pg-9013` 只追加这一 ACL boundary，不修改
`pg-9001`–`pg-9012` checksum。`pg-9014` 再增加固定
`model-provider-credential-management` authority 的 identity keyset ledger；manager 只有
SELECT/INSERT/UPDATE，没有 DELETE，`ql3_ai_maintenance` 也不能读取或改写它。

### 2. Credential transition 与允许审计必须同事务

`@qinglong/ai/model-provider-credential-administration` 定义 authorized mutation：

- catalog command；
- server-derived User actor；
- exact Project/RoleBinding fence；
- operation/project/actor/authentication/fence-bound allowed SecurityAudit。

PostgreSQL repository 的 `commitAuthorized` 在同一 SERIALIZABLE transaction 中取得
Project+Provider advisory lock，复验 active Project 与当前 User binding fence，执行 generation
CAS，append immutable binding/transition 和 SecurityAudit，再统一 COMMIT。exact replay 必须
同时匹配 catalog command 与原 authorization audit；孤立 audit、孤立 transition、身份漂移、
generation 漂移和 fence 漂移都失败关闭。

raw `commit` 暂时保留给 migration/HA 证据和受控内部测试，但产品 composition 只能取得
`commitAuthorized` repository。

### 3. Cluster Admin facade 不接受调用方 authority

能力留在现有 `@qinglong/cluster-admin`：

- 只接受五分钟内的 MFA/hardware User；
- 固定对 exact Project 请求 `secret.manage`；
- actor、`changedBy`、Policy decision、reasons、fence 和 audit 全由服务端派生；
- bind 固定 `bearer` scheme 并要求 canonical Project-bound SecretRef；
- revoke 不接受 binding/material；
- transport 只返回 Project、Provider、generation、active revision/digest、transition digest 和
  时间，不返回 SecretRef、Secret name、token、header 或 raw error。

transport 暴露 `provider-credential.bind|revoke|audit.list`。audit query 复用同一强 User、
`secret.manage` 和 Project/RoleBinding fence，但只返回 bind/revoke 的 actor、fence、时间与游标；
查询访问审计与读取 snapshot 在同一 SERIALIZABLE transaction 中提交。inspect 和 test
connection 在取得同等级隔离执行、rate/quota 与 content-free response 门之前保持关闭。

### 4. 产品部署已实现但保持默认关闭

以下接受门已经全部完成：

1. ~~独立 TLS 1.3/mTLS + purpose-bound OIDC management process；~~ 已完成，断言使用独立
   JWT type/purpose/audience，keyset generation/revocation 由 `pg-9014` 耐久围栏；
2. ~~bounded HTTP body/concurrency/peer/rate limit 和 caller-driven client；~~ 已完成，固定
   `/api/v3/provider-credentials/management`，认证先于 body，客户端零自动 retry；
3. ~~opt-in Kubernetes Deployment、NetworkPolicy、PDB、独立 Secret/CA 与 digest-pinned admin
   image；~~ 已完成，双副本 manager 与 caller-driven Job 均不进入默认 operations；
4. ~~PostgreSQL 真库最小 ACL、COMMIT-response-loss、并发单赢家和 physical HA 晋升证据；~~
   已由 PostgreSQL 18.4 arm64 HA 门完成；
5. ~~content-free audit query 与明确不保存/返回 SecretRef 的检查；~~ 已完成，固定只读
   bind/revoke operation，单页 1–32、降序 keyset；响应删除 Provider/SecretRef、binding/transition
   digest 与 authentication identity，查询访问审计和 authorization fence 复验同事务；
6. ~~test connection 的 provider allowlist、deadline、零 retry、audit-before-network 和费用/限流
   预算，或继续保持关闭。~~ 已由 ADR-0265 完成：manager 只签发 server-derived content-free
   plan，独立 one-shot tester 才能读取投影 Secret 和访问 exact provider endpoint。

## 被否决方案

1. **复用 `ql3_ai_maintenance`**：把 credential manager 扩权到 Prompt Artifact 删除。
2. **复用 Cluster Control runtime role**：让常驻请求处理进程取得 binding mutation。
3. **新建 credential-manager workspace package**：部署差异由同一 admin image 的独立
   entrypoint/Deployment 表达，代码仍属于已有能力包，不满足第 20 个 importer 门。
4. **只写 transition、不写允许审计**：无法证明谁在什么 Project fence 下授权。
5. **先 audit 后独立写 transition**：崩溃会产生虚假允许事实或未审计 mutation。
6. **提前开放 inspect/test**：会绕过尚未完成的审计、网络和 Provider 费用边界。

## 当前验证

- AI 全量 176 项：173 通过、3 条外部 PostgreSQL 条件跳过；
- Cluster Admin 全量 242 项：240 通过、2 条外部条件跳过；
- 新增 administration/facade/transport/process/HTTP/client 定向门全部通过；
- dependency audit `findings=[]`，workspace 保持 19；
- CloudNativePG deployment/backup/DR 静态门 24/24；
- `pg-9013` checksum：
  `c02a4c6b2953cc331580b6287283d33739c30c2e189d011f392c13ecea497224`；
- `pg-9014` checksum：
  `02098fad764199bc5a7750483d050be5e5acdbcecd05c0975c3fe4e5be03c782`；
- PostgreSQL 18.4 arm64 physical HA 门完成 `remote_apply`、timeline 1→2、旧主 fencing、
  `pg_rewind` 只读重入和 fresh controls，总 gate `passed=true`；credential management 子门
  证明 4 条 content-free SecurityAudit、bind/revoke/rebind、同 generation 双 manager 并发单赢家、
  陈旧 CAS 拒绝、COMMIT-response-loss exact replay、专用 manager ACL 和旧 maintenance deny，
  且晋升后全部存活；同轮还证明两个 manager 对 identity generation 竞争收敛、回滚/同代改写/
  隐式移除拒绝、COMMIT-response-loss 恢复和 generation 3 跨晋升存活；
- manager 与 client 两套 Kustomize 均可渲染；独立 deployment audit 正向与 pool 扩权负向
  2/2，dependency audit `findings=[]`；
- content-free audit query 定向 3/3，facade/transport/client/process 联合定向 18/18；PostgreSQL
  18.4 arm64 HA 进一步证明 4 条管理记录的两页 keyset、2 条访问审计、COMMIT-response-loss
  exact replay，以及 timeline 1→2 后重放不新增 WAL/审计且响应仍不含 SecretRef、Provider、
  authentication identity 或 transition/binding digest；
- 首次真库运行发现并修复 migration plan 已登记 `pg-9013`、history identity 白名单漏登记的
  fail-closed 漂移；
- ADR-0265 的受预算 test connection 已完成纯协议、manager plan/quota、one-shot executor、
  Kubernetes 静态部署边界和 PostgreSQL 18.4 physical HA 证据；真实外部 IdP、证书轮换、
  provider 网络与多节点 Kubernetes 纵切面仍是发布证据，因此 Accepted 只表示架构决策与当前
  实现门闭合，不表示 credential management 已可生产使用。
