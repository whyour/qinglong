# ADR-0161：Tool Execution Start 与 Artifact 的不可变绑定

- 状态：Accepted
- 日期：2026-07-26
- 关联：ADR-0158、ADR-0159、ADR-0160；RFC D-123/D-149/D-150

## 背景

Tool invocation input 与 redacted preview 已成为独立不可变 Artifact，plan、
admission 和 start barrier 只携带 reference。若数据库只保存 start barrier JSON，
数据库无法证明该 start 实际引用哪一对已持久化 Artifact；历史缺行、镜像列漂移或
相同 ID 的错误内容可能在重启、重放或 PostgreSQL promotion 后被误接受。

同时，直接扩展既有 start-barrier 表会要求 SQLite 重建热表，并把 Artifact identity
复制到所有 start 查询路径。低配设备需要保持单次短事务和零后台进程，集群则需要让
复合身份随 PostgreSQL WAL 原生复制并维持最小权限。

## 决策

### 1. 使用独立的一对一绑定表

- SQLite：`ToolExecutionStartArtifactBindings`；
- PostgreSQL：`ql3.tool_execution_start_artifact_bindings`。

每个 `start_id` 只能有一行。该行保存 Project、action、input/preview Artifact ID 与
Artifact digest，以及 input/action/preview/redaction digest。`bound_at_ms` 必须与
barrier 的 `started_at_ms` 一致。

input 与 preview 父表增加受审复合唯一索引。绑定表通过两个复合外键精确引用完整
Artifact 镜像身份，并通过第三个外键引用 start barrier。Artifact digest 已覆盖
key ID、algorithm、大小等完整 envelope，因此绑定表不再复制这些可由 digest 证明的
字段。

### 2. 同一事务先写 barrier，再写绑定

SQLite 继续复用共享 `BEGIN IMMEDIATE` authority；PostgreSQL 继续复用现有短
`SERIALIZABLE` start transaction。Trace、Audit、StepRun/Run CAS、RunEvent、
mutation、barrier 和 Artifact binding 任一失败，整个 start 都必须回滚。

Artifact pair 必须在 start 前已经持久化。缺少 Artifact、Project/action 不一致或
任一 digest 漂移均由复合外键失败关闭，不能在 start 事务里补造 Artifact。

### 3. 读取时以关系事实反证 JSON

Repository 查询使用 `LEFT JOIN` 读取绑定镜像，并把每个字段与规范化 barrier
reference 对比。使用 `LEFT JOIN` 是刻意的：升级前已存在但没有绑定行的 barrier
仍能被发现，随后明确返回 unavailable；若使用 inner join，它会被误判为“不存在”，
重试写入后才以唯一键冲突结束，无法区分历史不完整事实。

不对旧 barrier 进行推测性 backfill。缺少绑定就是不可恢复的执行证据缺口，必须由
后续 inspect/manual recovery 处理。

### 4. Capability、readiness 与权限锁步

- SQLite：`0059-tool-execution-artifact-bindings` 建表，
  `0060-capability-v30` 发布 `tool_execution_artifact_binding:1`；当前 60 条
  migration、capability v30、52 张 typed owned table；
- PostgreSQL：`pg-0032-tool-execution-artifact-bindings` 建表、安装 ACL 并发布
  capability v31；当前 32 条 migration、capability v31、51 张表。

PostgreSQL runtime 对绑定表只有 `SELECT, INSERT`；`UPDATE, DELETE` 必须由数据库
拒绝。admin、Package manager、Package executor 和 Worker ingress 均无表权限。
双方言 migration manifest/checksum、Drizzle schema、readiness table/index/CHECK/FK
contract 必须同时前进。

## 低配与集群影响

- Edge/Standalone 每次 Tool start 只增加一个 12 列有界关系行，无新 package、
  进程、连接、timer、watcher 或缓存；
- 查询只增加一次主键 `LEFT JOIN`，不会扫描 Artifact JSON 或解密 input；
- Cluster 绑定行与三组外键随 PostgreSQL WAL 复制，不实现应用层复制协议；
- start 热路径不解析明文，Artifact key material 仍不进入数据库。

## 被否决方案

1. **把完整 Artifact JSON 写进 barrier**：复制 ciphertext、扩大热行和恢复读取面。
2. **只把 Artifact ID 写进 barrier JSON**：数据库无法证明 ID 对应的 digest、
   Project 和 action。
3. **迁移时从 barrier JSON 回填绑定**：把未经关系外键证明的历史 JSON 升格为可信
   数据库事实。
4. **用 inner join 隐藏缺失绑定**：把损坏历史伪装成不存在，降低故障可诊断性。
5. **给 runtime UPDATE 权限**：不可变绑定无需更新，扩大 authority 没有正确性收益。

## 验证

- runtime-core 全量 313/313；
- SQLite 全量 116/116，其中 migration/schema/readiness/start repository 定向
  18/18；
- PostgreSQL package 175 pass/1 条件 skip，其中
  migration/schema/readiness/start repository 定向 35/35；
- Cluster Control 最小权限与应用组合测试 139 pass、2 条条件 skip；
- PostgreSQL 真实集成覆盖 Artifact 先持久化、start 与 binding 原子提交、exact replay
  和 durable row 计数；
- PostgreSQL 18 物理 HA 门覆盖 capability v31/51 表、runtime append-only、四个隔离
  角色拒绝、promotion/readiness 与旧主 rejoin。

## 后续门禁

1. 遗失 key、损坏 Artifact/绑定行的 inspect/manual recovery；
2. 首个 trusted built-in adapter 在 durable start 后解封并重新通过 Registry；
3. adapter response-loss、进程崩溃与副作用幂等恢复证据。
