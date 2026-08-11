# ADR-0049: Cluster API Credential 与 Durable Security Audit

- 状态：Proposed
- 日期：2026-07-19
- 关联 RFC：QL-RFC-0001 D-08、D-27 至 D-32、D-36、D-39、D-43 至 D-48

## 上下文

ADR-0046 至 ADR-0048 已固定 `/api/v3` 的 route、Authentication、Policy、audit、body 与 handler 顺序，也把授权输入收敛到受审 route registry 和 PostgreSQL Project Policy。但此前 cluster-control 的 authenticator 与 audit sink 仍由 application factory 注入；测试 double 可以证明顺序，不能证明多副本控制面如何解析、撤销和审计真实 credential。

直接复用 2.x `Auths.authConfig`、`shareStore` token list 或 Open API scope 会重新引入三类问题：credential 与可变用户名/进程内 session 混合，token 自带 scope 变成授权事实，以及每个 pod 对撤销状态的观察不一致。把安全审计写成普通日志或异步 best-effort 事件，则会让“外部副作用已允许但审计丢失”成为正常路径。

该切片只建立 cluster API App、MCP Client、Agent 和 User bearer 的认证/审计底座，不替代 Worker mTLS/session fencing。credential 管理 authority、mutation ledger 与有界 audit query 后续由 ADR-0050 补齐；这不改变本 ADR 对常驻 runtime 最小权限的决定。

## 决策

### 1. Identity、credential 与 authentication principal 分离

`@qinglong/runtime-core/api-credential` 定义稳定 `IdentitySubject` 引用和 versioned `ApiCredentialRecord`：

- subject vocabulary 复用 Project Policy 的 `user / api_app / mcp_client / agent / system / worker`；
- 通用 bearer 只允许 `user / api_app / mcp_client / agent`，`system / worker` 必须使用各自的受审内部或节点认证协议；
- credential 保存 `credentialId/version/state/subject/secretDigest/notBefore/expires`，不保存 role、permission、Project 或明文 secret；
- subject disable、credential revoke、未生效和过期均返回同一个未认证结果，不向 wire 暴露存在性；
- repository 损坏、驱动失败和取消不是“密码错误”，统一作为 authentication unavailable fail closed。

Authentication 只产生有界 TTL 的 `AuthenticatedPrincipal`。Policy 必须重新读取 Project/RoleBinding 权威事实，不能信任 bearer 自报 scope。

### 2. Bearer secret 使用 peppered digest，不落可逆材料

wire token 固定为：

```text
Bearer ql3c_<credentialId>_<base64url-32-byte-secret>
```

cluster-control 使用 32-byte canonical base64url deployment pepper，对 domain-separated `credentialId + secret` 计算 HMAC-SHA-256，并与数据库 64 位小写十六进制 digest constant-time 比较。pepper 通过部署 Secret 注入，不进入 PostgreSQL、日志、audit 或错误响应；格式错误必须在打开 Pool 和监听 HTTP 前失败。

认证实现必须清零临时 secret/digest buffer。首版只允许最长 60 秒、绝不超过 5 分钟的 principal TTL，避免 adapter 演变为长期授权缓存；credential revoke 的严格跨 pod 生效窗口由未来 version invalidation/短 TTL 决策继续收紧。

### 3. `pg-0005` 推进 capability v4

reviewed migration 新增：

- `ql3.identity_subjects`：稳定 subject 与 active/disabled 状态；
- `ql3.api_credentials`：以 `(credential_id, version)` 为主键的 append-only digest 事实；
- `ql3.security_audit_events`：低敏、append-only 的安全决策事实。

capability 从精确 v3 predecessor 推进为：

```json
{"api_credential":1,"project_policy":1,"run_core":1,"run_retry_policy":1,"security_audit":1}
```

Drizzle metadata、reviewed SQL、checksum、schema contract 和 readiness catalog 必须保持 lockstep。`identity_subjects` 保留六类主体以便 Policy/audit 共用；数据库 CHECK 仍禁止 `system/worker` 获得通用 API credential。

### 4. Runtime role 使用不对称最小权限

cluster runtime role 只能：

- SELECT `identity_subjects` 和 `api_credentials`；
- INSERT `security_audit_events`。

它不得 INSERT/UPDATE/DELETE identity 或 credential，不得 SELECT/UPDATE/DELETE security audit。签发、轮换、撤销与审计查询属于不同的管理/运营 authority，不能因为运行时要验证 token 就合并到同一数据库角色。

### 5. 安全审计是 admission 同步门禁

`@qinglong/runtime-core/security-audit` 固定 exact-shape 记录：server-generated event ID、request/operation/Project、subject/authentication ID、outcome、bounded reason codes、Project/RoleBinding fence 和 occurred time。

- authentication rejected/unavailable 不保存 subject 或 authentication identity；
- deny/approval/allow 必须保存已认证主体；
- reason 只能来自受控 vocabulary，不接受驱动错误、token 或自由文本；
- audit repository 只执行一次 INSERT，不 read-back、不在未知提交结果后自动重试；
- audit 写入失败返回稳定 503，handler 不得运行。

这使 HTTP → credential repository → Policy repository → audit INSERT → handler 成为同一个 fail-closed admission 纵向链路。它不把业务 transaction 和 audit INSERT 伪装成跨资源原子事务；handler 自身的 durable command/event 仍按各领域 ADR 提交。

### 6. Profile 与资源边界保持隔离

credential/audit PostgreSQL adapter 只由 `cluster-control` composition root 在 capability v4 readiness 后创建。edge/standalone artifact 不安装或导入该 bundle，仍可使用本机 session/identity adapter。每次请求只做有界 token 解析、单条 credential point lookup、Policy point lookup 和单条 audit INSERT；不引入后台 timer、全表扫描或无界 cache。

## 被否决的替代方案

### 复用 legacy token list 与 Open API scope

拒绝。token membership 是 2.x 兼容认证事实，scope 不能成为 3.0 Project Policy，且进程内列表无法为多 pod 提供权威撤销。

### JWT/bearer 自带 subject、role 和 Project

拒绝。签名只证明 issuer，不证明当前 subject/credential/RoleBinding 仍 active；长 token 会放大撤权延迟，也让 route/Policy 输入回到请求自报。

### 保存明文、可逆密文或普通 SHA-256(secret)

拒绝。数据库泄漏会直接暴露或允许低成本离线验证 credential。deployment pepper 与 domain-separated HMAC 把数据库和部署 Secret 分离。

### 审计异步发送到日志或消息队列

拒绝作为安全事实源。可以异步导出已经持久化的 audit event，但 admission 的 authoritative append 必须同步完成；否则允许动作与审计之间存在正常丢失窗口。

### 让 runtime role 同时签发 credential 和查询 audit

拒绝。被 HTTP 业务漏洞驱动的 runtime role 会同时获得造身份、删改撤销状态和读取安全历史的能力，破坏最小权限与职责分离。

## 影响

### 正向

- cluster-control 不再依赖 allow-all 或 legacy session authenticator；
- credential 不携带 role/Project，Authentication 与 Authorization 保持独立；
- revoke/disable/expiry 与多副本数据库观察共享同一权威事实；
- audit 为 append-only、低敏、write-only runtime fact，业务错误不能静默吞掉；
- edge artifact 继续不安装 PostgreSQL/cluster credential bundle。

### 代价与未完成项

- 每个受保护请求至少增加 credential lookup、Policy lookup 和 audit INSERT；后续缓存只能绑定 version/短 TTL 并证明撤销上界；
- deployment 必须管理独立 pepper Secret，轮换协议尚未实现；
- ADR-0050 已建立默认不可由 cluster-control 到达的 provisioning/rotation/revocation application service 与 PostgreSQL adapter；ADR-0051 已为常驻 `/api/v3` 建立认证前 process-local overload shield，但管理入口仍没有受审 CLI/API/UI、独立速率限制、negative cache 或异常登录告警；
- ADR-0050 已建立独立 admin role 的有界 audit query adapter，但尚无 retention、partition、export、备份恢复和告警产品面；
- User bearer 当前只形成 single-factor assurance；MFA、hardware/local-console 与 mTLS 各自需要独立 adapter；
- Worker enrollment/session 继续遵循 ADR-0012/0013，不能复用通用 bearer。

## 验证

1. runtime-core contract 覆盖 exact shape、subject 类型、digest、时间窗和低敏错误。
2. authenticator 覆盖 token/pepper canonical encoding、constant-time digest、revoke/disable/not-before/expiry、abort 与 unavailable。
3. migration checksum、精确 v3 predecessor、capability v4、Drizzle/schema/catalog lockstep 全部通过。
4. fake Pool adapter test 覆盖 latest credential lookup、损坏 row、单次 audit INSERT 和驱动错误脱敏。
5. application test 覆盖真实 HTTP bearer → PostgreSQL credential → fenced Policy → durable audit → handler，并证明未认证请求在读取大 body 前结束。
6. 真实 PostgreSQL 证明 latest version 解析、audit 落库、`system` bearer 与身份不一致 audit 被 CHECK 拒绝。
7. readiness/CI 证明 runtime role 对 identity/credential 只读、对 audit 只写且无 schema DDL；PostgreSQL 16–18 仍是 production readiness 支持范围。
8. Node 22/24、Profile dependency/import audit、migration manifest 和 GitNexus detect-changes 继续作为合并门禁。
