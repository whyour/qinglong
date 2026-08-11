# ADR-0216：实例 Owner 围栏化、有界的 Local Security Audit 诊断压缩

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-05、D-27、D-37、D-65、D-72、D-73、D-175、
  D-198、D-201、D-205、D-206
- 关联 ADR：ADR-0049、ADR-0074、ADR-0211、ADR-0215

## 背景

ADR-0215 完成了有界、脱敏的本机安全审计查询，但 Edge/Standalone 的
`QingLong3SecurityAuditEvents` 仍只增不减。低容量路由设备不能依赖人工直接 SQL，
也不能承担常驻 retention daemon、定时器或无界扫描。

安全审计又不是可以按时间一刀切的日志。大量 mutation、dispatch、execution、
credential 与 package receipt 通过外键或语义 identity 引用 audit event。删除这些
行会破坏 exact replay、恢复、取证或启动围栏。当前 schema 还没有覆盖全部语义引用的
统一外键，因此 v1 不能声称提供通用审计保留期。

## 决策

### 1. 复用既有 package、binary 和 authority

在既有 package 内新增：

- `@qinglong/runtime-core/local-security-audit-retention`；
- `@qinglong/local-sqlite/security-audit-retention`；
- `@qinglong/local-admin/security-audit-retention`；
- 既有 `ql3-audit` 的 `security.audit.compact` operation。

不新增 workspace package、binary、生产依赖、daemon、timer、watcher、listener、
连接池、缓存或端口。命令一次启动、执行一个有界 batch 后退出。

### 2. v1 只压缩可证明安全的诊断事件

候选行必须早于显式 `eligibleBeforeMs`，并满足以下二者之一：

1. outcome 不是 `allowed`；
2. outcome 为 `allowed`，且 operation 在精确只读白名单：
   `identity.inspect`、`credential.inspect`、`policy.project.inspect`、
   `policy.project.list`、`policy.role_binding.inspect`、
   `policy.role_binding.list`、`security.audit.list`。

同时，候选行不得被任何已知外键或语义 ledger 引用。实现显式排除：

- Credential administration/delivery；
- Identity administration/provisioning；
- legacy adoption；
- Owner bootstrap/recovery/acknowledgement GC/pepper GC；
- Plugin Package admission；
- Project administration；
- Tool execution audit/start barrier；
- security audit compaction receipt。

允许的 mutation、dispatch、execution 和 package operation 即使超过期限也保留。
这是“诊断审计压缩”，不是通用审计销毁或合规 retention。

### 3. 保留期、batch 和资源硬上限

- retention 只能为 30 天至 10 年；
- `eligibleBeforeMs + retentionMs` 不得晚于受信时钟；
- Edge 每 batch 最多 64 条；
- Standalone 每 batch 最多 512 条；
- 删除摘要的规范 payload 最多 16 MiB；
- 排序固定为 `(occurredAtMs ASC,eventId ASC)`；
- 不支持 offset、任意 SQL、模糊条件或调用方排序。

需要继续收敛时，operator 使用新的 mutation/request/failure identity 重复执行，直到
`deletedCount` 为 0。不存在后台自动循环。

### 4. 删除、allowed audit 与不可变 receipt 原子提交

SQLite 在同一 `BEGIN IMMEDIATE` 内：

1. 重验 authenticated credential、Identity、pepper、instance authority anchor、
   authority Project 和 actor 最新 Owner binding；
2. 检查 exact replay；
3. 有界选择候选行；
4. 对规范化的完整候选记录计算 domain-separated SHA-256 与 payload bytes；
5. 写 `security.audit.compact` allowed audit；
6. 写不可变 compaction receipt；
7. 删除精确候选 event ID；
8. commit。

receipt 保存 mutation/request/authority、retention/cutoff/limit、删除数量/bytes、
首尾 cursor、records digest、audit event 与创建时间。receipt 外键引用本次 allowed
audit，因此压缩证据本身不可成为候选。

相同 mutation 只有在 request、authority、retention、cutoff、limit 和 audit 语义完全
一致时返回 `existing`；任意漂移均冲突。失败使用独立 `failureAuditEventId`，避免一次
拒绝占用未来可成功重放的 mutation identity。

### 5. SQLite contract 升至 v38

新增：

- `0075-security-audit-compactions`；
- `0076-capability-v38`；
- `QingLong3SecurityAuditCompactions`；
- capability `local_security_audit_compaction`。

镜像、预检、rollout 写契约和物理 Edge evidence 必须统一要求 v38。Edge 继续使用
rollback journal，Standalone 继续使用 bounded WAL。

### 6. 不自动执行 VACUUM

删除后的 SQLite page 可由后续写入复用，但文件大小可能不会立即下降。命令不执行
`VACUUM`、`auto_vacuum` 切换或长事务 rewrite。需要物理缩容时必须走独立、可备份、
可恢复、具备空间预检的离线维护 RFC。

## 不采用方案

### 按时间删除全部 audit

拒绝。当前存在未统一为外键的 mutation/event 语义引用，会破坏 exact replay、恢复和
安全取证。

### 只依赖数据库外键发现引用

拒绝。外键只能覆盖直接关系，Tool start barrier 和多个领域 ledger 还存在语义 identity
引用。v1 使用“诊断 operation 白名单 + 显式引用排除”的双重保守策略。

### 常驻 retention daemon 或启动时自动清理

拒绝。它增加低配设备空闲 RSS、启动路径失败面和不可预测 I/O，并在没有 operator
选择的情况下销毁证据。

### 每次压缩后 VACUUM

拒绝。VACUUM 的额外空间、持续时间和写放大不适合作为路由设备在线管理动作。

## 影响

正向影响：

- Edge/Standalone 可通过受支持产品入口回收可证明安全的诊断审计；
- 每次最多 64/512 条，内存、锁时长和终端输出有硬上限；
- authority、credential 与 Policy TOCTOU 在最终事务内再次收敛；
- digest、首尾 cursor 与 immutable receipt 为删除 batch 提供可重放证据；
- 低配设备没有新增常驻进程或空闲资源开销。

代价与限制：

- allowed mutation/execution/package 审计仍会增长；
- 删除后文件不保证立即变小；
- compaction receipt 和本次 allowed audit 会新增少量永久记录；
- 当前不提供签名 export、远端归档、合规销毁证明或 Cluster retention。

## 验证

- SQLite 临时真库迁移到 contract v38，67 张受审表，capability 绑定
  `0075-security-audit-compactions`；
- 隔离 strict TypeScript 通过；
- runtime digest 3/3；
- local-admin authority/retention/failure fence 4/4；
- 真实 SQLite 4/4，覆盖诊断白名单、允许 mutation 保留、外键引用保留、
  cutoff、receipt、digest、exact replay、drift、batch 推进和 foreign authority；
- Owner CLI 5/5，覆盖原查询回归、压缩低敏输出、Edge 65 拒绝和独立 failure identity；
- SQLite rollout 7/7；database 契约已同步 v38；
- workspace 仍为 22 package，本能力未增加 package；
- 完整 package closure 与 PostgreSQL HA Docker 门仍受未物化锁定依赖阻断。
