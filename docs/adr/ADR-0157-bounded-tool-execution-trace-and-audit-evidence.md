# ADR-0157：有界 Tool Execution Trace 与 Audit Evidence

- 状态：Accepted
- 日期：2026-07-26
- 关联：ADR-0049、ADR-0074、ADR-0133、ADR-0154、ADR-0155、ADR-0156；
  RFC D-03/D-29/D-131/D-148/D-149

## 背景

ADR-0155 已定义 Tool execution admission 必须绑定耐久 StepRun、Trace 和 Audit
evidence；ADR-0156 已完成 StepRun aggregate 与双方言 Run fence，但仍缺少可以在崩溃、
响应丢失和多副本重放后验证的 Trace/Audit 事实。

仅在 OpenTelemetry exporter、RunEvent payload 或普通日志中记录 trace/span id 不足以
形成启动门禁：

- exporter 可以关闭、采样、延迟或失败；
- RunEvent 不能证明独立 Trace 与审计事实的完整内容和摘要；
- `security_audit_events` 在 PostgreSQL runtime 角色下是 insert-only，不能为了重放而
  扩大为全表可读；
- 低配路由器不能为了这项能力引入常驻 collector、额外 workspace package 或新的第三方
  依赖。

## 决策

### 1. 使用 profile-neutral、digest-bound evidence bundle

`@qinglong/runtime-core/tool-execution-evidence` 是 `runtime-core` 的显式 subpath，不新增
workspace package。它定义：

- `qinglong/tool-execution-trace-anchor@v1`；
- `qinglong/tool-execution-audit-receipt@v1`；
- `qinglong/tool-execution-evidence-bundle@v1`；
- 32 位小写十六进制 Trace ID、16 位 Span ID，与 W3C Trace Context 的 identity
  形状兼容；
- Project、Run、StepRun、invocation plan、binding、adapter、redaction contract 和
  audit contract 的完整摘要绑定；
- 固定 `tool.invoke.start`、`allowed`、非空 Policy fence 的 SecurityAuditRecord；
- domain-separated SHA-256 trace、audit record 与 receipt digest。

Bundle 的 canonical JSON 总量上限为 16 KiB，单页最多 128 条。输入、Secret、handler、
异常对象、execute seam 和 Tool 结果都不得进入该 bundle。

### 2. 两个 durable identity 与 exact replay

repository 同时以 `(trace_id, span_id)` 和 `audit event_id` 作为唯一 identity。第一次
prepare 原子写入，完全相同的重放返回 `existing`；任一 identity 复用到不同内容必须
返回 semantic conflict。按 Run 查询使用
`(created_at_ms, trace_id, span_id)` 稳定 keyset pagination。

读取时必须重新执行领域规范化，并把 canonical JSON 与每个镜像列逐一比对。数据库内
JSON、digest、identity 或时间镜像发生漂移时失败关闭，不能返回部分可信 evidence。

### 3. SQLite 使用共享 operation authority

SQLite `0053-tool-execution-evidence` 新增：

- `ToolExecutionTraceAnchors`；
- `ToolExecutionAuditReceipts`。

`0054-capability-v27` 将 `local-control-core` 推进到 v27，并声明
`tool_execution_evidence:1`。repository 复用 `LocalSqliteOperationAuthority` 与
`BEGIN IMMEDIATE`，只允许绑定同 Project、同 Run、状态为 `ready` 或
`waiting_approval` 的 Tool StepRun。SecurityAuditEvent、Trace anchor 和 receipt
在同一事务中提交或回滚。

数据库 CHECK 完整绑定 JSON 与镜像列；foreign key 将 receipt 绑定到既有审计事件、Trace
和同 Run StepRun。

### 4. PostgreSQL 保持 Audit insert-only

PostgreSQL `pg-0029-tool-execution-evidence` 将 `control-core` 推进到 v28，并新增：

- `ql3.tool_execution_trace_anchors`；
- `ql3.tool_execution_audit_receipts`。

只有 `ql3_runtime` 取得两张 evidence 表的 SELECT/INSERT，禁止 UPDATE/DELETE；其他
产品角色保持零权限。`ql3_runtime` 对 `security_audit_events` 继续只有 INSERT，没有
SELECT。

因此 PostgreSQL repository 不 JOIN 审计表读取：它在同一个 `SERIALIZABLE` 事务中先写
immutable SecurityAuditEvent，再写 Trace 和保存完整 `audit_json` 的 receipt；receipt
以 foreign key 证明审计行存在。运行时没有修改或删除审计行的权限，重放通过 receipt
内的完整规范化 audit 与 digest 校验，不需要扩大低敏审计表的读取面。

事务使用固定 statement/lock/idle timeout、最多三次 serialization/deadlock/并发唯一
冲突收敛，并以共享锁固定同 Project ready Tool StepRun，避免状态检查与提交之间漂移。

### 5. evidence 仍不是副作用启动授权

双方言显式 `tool-execution-evidence` subpath 只提供存储能力，root、通用 runtime、
admin、worker ingress 不重新导出 repository。它没有连接真实 Tool adapter，也不会
启动进程、HTTP、MCP、Worker 或任意外部副作用。

production execution 继续不可达，直到一个后续 start-barrier authority 能在同一
可判定事务中绑定或精确证明：

1. immutable plan/dispatch；
2. ready Tool StepRun；
3. Trace anchor；
4. allowed Audit receipt；
5. handler binding 与 adapter-specific recovery evidence。

## 低配与集群资源影响

- 不新增 workspace package、依赖、timer、watcher、socket、线程或常驻进程；
- 没有 exporter/collector 才能运行的前置条件；
- 每次 Tool 启动只增加一条 Trace、一条 receipt 和既有一条 Audit；
- 所有读取都有唯一索引或有界 keyset page；
- Edge 与 Cluster 使用同一领域摘要和重放语义，数据库机制和权限模型按 profile
  分别实现。

## 被否决方案

1. **只依赖 OpenTelemetry**：采样和 exporter 可用性不能成为耐久启动证据，拒绝。
2. **把完整 evidence 塞进 RunEvent**：失去独立 identity、retention 和 ACL，拒绝。
3. **允许 runtime SELECT 全部 Audit**：扩大低敏审计读取面，拒绝。
4. **Trace、Audit、receipt 分三个事务提交**：产生可见半提交窗口，拒绝。
5. **只保存 digest，不保存规范化 JSON**：无法在恢复时重建并验证完整绑定，拒绝。
6. **为 Trace/Audit 新拆 workspace package**：没有独立部署或依赖生命周期，拒绝。
7. **prepare 时允许 running/terminal StepRun**：无法证明 evidence 在副作用开始前
   建立，拒绝。

## 验证

- runtime-core Tool evidence 定向测试：7/7，完整 runtime-core：304/304；
- local-sqlite 完整测试：106/106；
- cluster-postgres package：160 pass、1 条件 skip；
- PostgreSQL 18.4 arm64 新增 evidence 真实 integration：migration/runtime 独立角色
  下 1/1；
- PostgreSQL 18.4 arm64 六角色完整 integration：40 pass、1 条件 skip；
- PostgreSQL 18.4 arm64 physical HA：physical streaming、`remote_apply`、旧主隔离、
  timeline 1→2 promotion、`pg_rewind`、同步复制恢复、两代双 control replica，
  `gates.passed=true`；
- 所有单实例和 HA 临时 Docker 资源均由 gate 清理。

## 后续门禁

1. 实现 opaque/encrypted invocation plan 与 redacted preview Artifact；
2. 实现 plan/dispatch、StepRun、Trace、Audit 的双方言同事务 start barrier；
3. 定义 built-in、isolated process、MCP、HTTP 和 Worker adapter 的启动后恢复证据；
4. 增加 receipt retention/compaction，不得破坏未终结 Run 的恢复可验证性；
5. 完成物理 Edge 故障与规模证据后，再评审 production adapter composition。
