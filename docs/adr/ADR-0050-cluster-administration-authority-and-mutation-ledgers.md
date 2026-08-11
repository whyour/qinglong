# ADR-0050: Cluster Administration Authority 与 Mutation Ledgers

- 状态：Proposed
- 日期：2026-07-19
- 关联 RFC：QL-RFC-0001 D-06、D-17、D-39 至 D-42、D-47 至 D-49
- 延伸：ADR-0037 至 ADR-0049

## 上下文

ADR-0049 已把 cluster API credential 认证和安全审计从 legacy token list 提升为 PostgreSQL 权威事实，并严格限制常驻 runtime role：它只能读取 Identity/credential、追加低敏 audit，不能签发 credential 或读取审计历史。但如果签发、轮换、撤销和 Identity disable 继续通过 cluster-control 的普通 HTTP 进程完成，运行时仍会间接取得管理数据库权限；任一 handler、依赖或路由漏洞都可能同时造身份、造 credential、读取安全历史并执行任务。

另一问题是管理动作跨越多个事实。只写 `identity_subjects` 或 `api_credentials` 再 best-effort 写 audit，会留下“权限已改变但没有操作者证据”的崩溃窗口；只依赖当前表又无法区分合法重放、mutation ID 碰撞和并发覆盖。credential secret 与服务端时间戳还会使字节级命令重放天然不同，若把随机 digest 当作幂等比较输入，合法重试会被错误判定为冲突。

因此管理面必须成为独立 authority，并以不可变 mutation ledger、版本 fence 和同事务 audit 定义其事实边界。

## 决策

### 1. 独立、短生命周期的管理组合根

新增私有包 `@qinglong/cluster-admin`。它是显式调用的短生命周期 composition root，不由 `cluster-control` 导入、启动或暴露路由：

- 只依赖公开的 `@qinglong/runtime-core` port 与 `@qinglong/cluster-postgres/admin` 子入口；
- 启动时先验证 exact-shape 配置和 32-byte canonical base64url pepper，再打开 Pool；
- 只接受强认证 User（`multi_factor / hardware / local_console`）或受审 System service principal；
- readiness、assembly 或调用失败时关闭 Pool，`close()` 幂等；
- 首个切片只提供 application service，不提供默认监听端口、CLI、UI 或 cluster-control route。

部署方必须把 admin credential 与 runtime/migration credential 分开注入。管理任务结束后必须关闭 admin 进程和 Pool，不能把 admin role 作为常驻控制面环境变量。

### 2. 三个 PostgreSQL role 互不包含

`migration`、`runtime` 与 `admin` 是并列 authority，不是逐级超集：

| 对象 | runtime | admin |
| --- | --- | --- |
| schema history/capability | SELECT | SELECT |
| Project/RoleBinding/Run/Attempt/Event/RetryPolicy | 按运行契约读写 | 无权限 |
| IdentitySubject | SELECT | SELECT/INSERT/UPDATE |
| API Credential | SELECT | SELECT/INSERT |
| Security Audit | INSERT，禁止 SELECT | SELECT/INSERT |
| Identity/Credential Mutation Ledger | 无权限 | SELECT/INSERT |

两种非 migration role 都不得拥有 schema、表，不得 `CREATE` schema object，不得 UPDATE/DELETE append-only credential、audit 或 mutation history。readiness 必须对每张表的 SELECT/INSERT/UPDATE/DELETE 与 ownership 逐项精确核对；权限过多和权限不足同样阻止 ready。

### 3. capability v5 与不可变管理流水

`pg-0006-identity-credential-administration` 从精确 capability v4 predecessor 推进 v5，新增：

- `identity_subject_mutations`：register/enable/disable 的 mutation ID、subject version fence、目标状态、强 actor、audit identity 和原 Identity 创建时间；
- `api_credential_mutations`：issue/rotate/revoke 的 mutation ID、credential version fence、不可变 subject/status、强 actor 和 audit identity。

capability 为：

```json
{"api_credential":1,"api_credential_admin":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1}
```

升级时，v4 已有 Identity/credential 生成确定性的 `import` mutation 与低敏 migration audit。该事实明确表示“由 pg-0006 导入”，不伪造原始操作者。mutation ID 与 audit event ID 相同；所有外键、CHECK、唯一版本索引、reviewed SQL、Drizzle metadata、checksum、schema contract 和真实 catalog 必须 lockstep。

### 4. 每个管理动作是一个 `SERIALIZABLE` 原子提交

Identity 与 credential Repository 对目标 identity/credential 取得 transaction-scoped advisory lock，并使用 expected-current-version fence：

1. 检查已有 mutation；
2. 锁定并复验当前 Identity/credential 事实；
3. INSERT 低敏 security audit；
4. INSERT/UPDATE 当前 Identity 或 INSERT 新 credential version；
5. INSERT mutation ledger；
6. COMMIT。

任一步失败整体 rollback。序列化失败、deadlock、lock unavailable 和唯一键竞态最多重试三次；稳定 version/mutation/subject conflict 使用低敏领域错误，未知驱动错误统一 unavailable。Identity disable 不改写历史 credential；认证时同时读取最新 credential 与 Identity 状态，因此 disable 立即使其 fail closed。

### 5. credential secret 一次返回，语义重放不恢复

issue/rotate 在进程内生成 32-byte CSPRNG secret，使用 ADR-0049 的同一 domain-separated HMAC 计算 digest，随后在 `finally` 清零可变 Buffer。PostgreSQL、mutation、audit、日志和错误都不保存 secret；token 只在新 mutation 成功提交的单次结果返回。

mutation 重放按调用方语义比较，而不比较服务端生成字段：

- 必须相同：mutation ID、operation、expected version、credential/subject、caller、authentication ID、request ID、显式 not-before 与 expiry；
- 不参与等价判断：随机 secret/digest、服务端 created/occurred timestamp；
- 语义一致时返回已存事实与 `token: null`，并且预检路径不再次生成 secret；
- 任一调用方语义字段不同即 mutation conflict，不能用同一 ID 覆盖或探测已有 secret。

调用者若丢失首次 token 响应，只能用新的 mutation ID 执行 rotate，不能从存储或重放接口恢复 secret。`notBeforeAtMs` 必须显式提供，避免默认当前时间使幂等请求含义漂移。

### 6. Security audit query 有界且只属于 admin authority

admin 子入口提供 descending `(occurred_at_ms, event_id)` keyset query：最多 200 条，只允许 exact-shape project/subject/outcome filter，不接受 offset、任意 SQL、自由文本搜索或无界导出。返回值继续通过低敏 audit contract 归一化，损坏 row 和数据库错误 fail closed。

本 ADR 不实现 retention/delete。未来 retention 必须先证明 archive/export 已持久化并以独立运维 authority 执行，不能把 DELETE 授给当前 admin role。

## 被否决的替代方案

### 把管理路由加入 cluster-control

拒绝。常驻业务进程将同时持有认证、签发、审计读取与运行 authority，破坏职责分离并扩大远程攻击面。

### 让 migration role 兼任日常管理

拒绝。DDL owner 权限远大于 credential 管理所需权限，任何管理输入错误都可能越过 schema contract 和 append-only 约束。

### 只保存当前 Identity/credential，不保存 mutation ledger

拒绝。无法证明 actor、版本来源、精确重放和并发 winner，也无法把管理事实与 audit 外键绑定。

### 保存加密 secret 以支持重放返回

拒绝。可恢复 secret 会把数据库/KMS 读取权提升为 bearer 签发权，并扩大备份、日志和运维面的泄漏范围。

### 以随机 digest 做完整命令相等比较

拒绝。每次重试都会产生不同随机值，使合法幂等请求必然冲突。幂等 identity 必须绑定调用方语义，不绑定一次性生成材料。

## 影响

### 正向

- cluster-control compromise 不再直接获得 credential 签发或 audit read authority；
- Identity/credential 变更、actor 与 audit 在同一事务中可追溯；
- 语义重放、并发版本冲突与 mutation ID 碰撞有明确且可测试的结果；
- 管理包、PostgreSQL driver 和运行包继续不进入 edge/standalone importer；
- audit query 有硬页界限，不把运营查询变成控制面内存风险。

### 代价与未完成项

- 部署需要第三套最小权限数据库凭据，并负责短生命周期调用与 Secret 注入；
- 首个切片没有 CLI/API/UI、审批 ceremony、rate limit、break-glass 或双人复核；
- pepper rotation、credential 批量吊销、异常认证告警仍未实现；
- audit partition、retention、archive/export、备份恢复和 SIEM adapter 仍需后续 ADR；
- 远端 CI 必须提供 PostgreSQL 16/18 × x64/arm64 的三角色证据。

## 验证

1. runtime-core 覆盖 Identity/credential mutation、版本 fence、强 actor、audit coupling、token digest 与有界 query exact shape。
2. cluster-admin 覆盖 pepper-before-Pool、强认证、未知字段拒绝、一次 token 返回、Buffer 清零、语义重放不再生成 secret 与 collision fail closed。
3. migration test 冻结 pg-0006 checksum、精确 v4 predecessor、capability v5、13 表和所有 CHECK/FK/index。
4. readiness test 同时证明 runtime 对两张 mutation ledger 零权限，以及 admin 的精确允许/拒绝矩阵。
5. PostgreSQL integration 覆盖 Identity 并发单 winner、issue/rotate/revoke、语义重放、audit keyset query 与 admin 无 Run/Project/RoleBinding 权限。
6. package entrypoint/dependency audit 证明 admin 不加载 migration DDL/Drizzle schema，cluster-control 不依赖 admin，edge 不安装 cluster bundle。
7. Node 22/24、本机 SQL 验证和 PostgreSQL 16/18 × x64/arm64 CI 继续作为合并门禁。
