# ADR-0246：Worker 管理持久审计的独立只读证据

- 状态：Accepted（collector、离线审计器与权限门已实现；真实外部报告待采集）
- 日期：2026-08-01
- 关联 RFC：QL-RFC-0001 D-58、D-226、D-228、D-229、D-230
- 关联 ADR：ADR-0148、ADR-0242、ADR-0244、ADR-0245

## 背景

ADR-0245 的外部 OIDC ceremony 已证明 requester 自批得到 HTTP 403、不同 reviewer 可完成决定，且
最终 inspect 没有 dispatch/consume。但仅凭 HTTP 响应不能独立证明 PostgreSQL 中的 immutable plan、
approved request 和 security audit 彼此一致，也不能证明 self-decision 没有留下允许审计。

让 ceremony runner 使用 `ql3_worker_credential_manager` 查询数据库会把现场身份客户端与数据库写
authority 合并。新增常驻 evidence service、数据库连接池或 workspace package 又会把一次性发布证据
变成运行时成本，并把无关依赖带给路由设备。

## 决策

1. 新增 caller-driven `ql3-worker-credential-management-durable-audit-evidence.cjs`，它只接受 mode
   0600 ceremony report、原始 ceremony definition、libpq service file、service 名和 unused output
   path。连接凭据不允许通过 DSN、CLI 值或报告传入。
2. 数据库连接必须是部署侧临时创建的登录角色。collector 在一个显式 `READ ONLY` 事务内验证：
   - 非 superuser、非 create database/role、非 replication、非 bypass RLS；
   - 不能 `MEMBER`/`SET ROLE` 到 migration、runtime、admin、package、Worker ingress、Worker
     manager 或 executor 角色；
   - `ql3` 中只能 SELECT `worker_credential_management_plans`、`approval_requests`、
     `security_audit_events` 三张表；
   - 对所有 `ql3` 表均没有 INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER。
3. collector 精确关联 ceremony action/project/approval/decision/audit identity：plan digest、preview
   digest、requester/reviewer subject、approved@v2、reviewer decision、proposal audit 和 reviewer
   decision audit 必须一致。self-decision event 必须不存在，dispatch/consumption 必须为空。
4. `separation_of_duty` 的 self-decision 在 `decideApprovalRequest` 内、数据库 update/audit insert 前
   抛出，因此正确持久事实是两条审计而不是三条：
   `approval.request/approval_required` 和 `approval.decide/allowed`。HTTP 403 与 self event 缺失共同
   构成负证据；禁止伪造一条 denied audit 来凑数。
5. v1 report 只保留两个输入文件的原始 SHA-256、角色/identifier/subject/authentication ID 的域分离
   摘要、plan/preview digest、两条低敏 audit 事实和全真 gate。禁止原始 User、Worker、Project、
   approval、authentication ID、DSN、password、token、JWT、Secret 或 private key。
6. 独立 audit CLI exact-validate 报告并扫描敏感材料。报告以 mode 0600、no-replace 写入；collector
   完成后应撤销并删除临时证据角色。
7. 此能力不新增 migration、内建数据库角色、workspace package、第三方依赖、镜像、listener、
   controller、timer、watcher、Pool 或常驻连接。Edge/Standalone/Worker artifact 不导入这些脚本。

## 失败与恢复

- 输入权限、角色权限、PostgreSQL 18.4+ 且仍属于受审 18.x major、计划、审批、审计基数或任一
  digest 不匹配时不写报告；
- `psql` 仅通过 `PGSERVICEFILE` 和固定 service name 连接，SQL 从 stdin 提交，业务 identifier 不进入
  process argv；事务、statement、lock 与 idle-in-transaction 均有界；
- collector 失败不会回滚或修改 ceremony 已创建的事实。operator 必须只读检查原因，禁止用 manager
  角色替代 evidence role 绕过门禁；
- 输出不可覆盖。重新采集必须使用新路径，并保留旧失败证据的外部变更记录。

## 被拒绝的替代方案

### 复用 Worker manager 角色查询

拒绝。该角色拥有 plan/audit insert 和 approval update，无法证明证据采集本身无 mutation authority。

### 在 schema migration 中新增常驻 evidence role

拒绝。证据采集不是运行时能力；把一次性登录 credential 变成所有部署的长期角色会扩大 credential
inventory 和攻击面。部署侧短期角色可在收集后完整撤销。

### 要求三条 durable audit

拒绝。self-decision 在领域职责分离检查处失败，事务在 insert 前回滚。第三条记录既不是当前 contract，
也会把 HTTP 负路径误描述为成功 mutation。

### 把数据库原始行写进报告

拒绝。原始 subject、authentication/request/audit ID 对离线 gate 非必要。域分离摘要可关联同一现场，
同时降低人员身份与基础设施标识泄漏。

## 验证

- collector/audit 7/7：只读 happy path、PostgreSQL version floor/major、写权限、特权继承、额外表读取、
  self audit、dispatch、错误
  reviewer、审计缺失、ceremony/report 错配、widened/false/sensitive report、path-only CLI 与 SQL
  no-mutation；
- 独立 PostgreSQL 18.4 Docker smoke 已用真实临时 login 执行 production SQL，返回精确三表 SELECT、
  零 writable table、零 privileged membership、两条 audit 与 self event=0；临时容器/卷零残留；
- ADR-0245 ceremony 回归 7/7；输出均为 mode 0600，离线 audit 子进程 `compatible=true`；
- PostgreSQL 18.4 arm64 physical HA 已重新通过：`remote_apply`、timeline 1→2、旧主 fence、
  `pg_rewind` rejoin、双 fresh control replica 和最终 `gates.passed=true`；Docker 容器/卷零残留；
- 未新增 package、依赖、migration 或运行时资源。

## 尚未完成

- 在生产等价外部 OIDC/manager/PostgreSQL 上顺序采集 ADR-0245 ceremony report 和本 ADR durable
  report，并由两个离线 audit CLI 通过；
- 外部 client certificate 的运行时/客户端/Kubernetes 协议已由 ADR-0247 补齐；生产 PKI/ingress、
  certificate 或 IdP/assertion 撤销后的新请求拒绝以及证据保留/签名策略仍是更高层发布门，不能由本报告推导。
