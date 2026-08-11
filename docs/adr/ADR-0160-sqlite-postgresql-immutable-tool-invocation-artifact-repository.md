# ADR-0160：SQLite/PostgreSQL 不可变 Tool Invocation Artifact 仓库

- 状态：Accepted
- 日期：2026-07-26
- 关联：ADR-0043、ADR-0063、ADR-0125、ADR-0158、ADR-0159；
  RFC D-29/D-30/D-123/D-149/D-150

## 背景

ADR-0159 已把 Tool input 与审批 preview 从 plan 移到两个不可变 Artifact，但只有领域
envelope 和 Repository port 仍不足以支持重启、集群派发或主库晋升。双方言必须用同一
身份和重放语义持久化，同时保持低配设备不引入新进程或依赖，并避免 Cluster 的
admin、Package 与 Worker authority 取得敏感调用材料。

## 决策

### 1. 使用现有 Profile adapter package

- SQLite adapter 位于 `@qinglong/local-sqlite/tool-invocation-artifact`；
- PostgreSQL adapter 位于
  `@qinglong/cluster-postgres/tool-invocation-artifact`；
- 不增加 workspace package、第三方依赖、常驻进程、timer、watcher 或缓存。

每个方言各有 input/preview 两张表。表保存受审 mirror column 和完整有界 Artifact
JSON；input JSON 只有 AES-256-GCM envelope，数据库永不保存 key material 或明文。

### 2. 双 Artifact 必须原子提交并精确重放

Repository 一次只接受具有相同 Project、action 和 sealing time 的 input/preview
pair。SQLite 使用共享 `BEGIN IMMEDIATE` operation authority；PostgreSQL 使用短
`SERIALIZABLE` transaction。任一行失败必须回滚两行。

相同 Artifact ID 只有完整规范化内容一致才能返回 `existing`。部分 pair、mirror
column 漂移、非法 JSON、digest 漂移或相同身份不同内容均失败关闭。PostgreSQL 并发
唯一键竞争在事务回滚后重读：赢家内容完全一致时收敛为 exact replay，否则为
conflict。

### 3. PostgreSQL 不以行锁换取扩大权限

Artifact 行不可变，因此 replay 读取不得使用 `FOR SHARE`。PostgreSQL 对行锁读取会
要求更新类权限，这与 append-only authority 冲突。runtime 只取得两张表的
`SELECT, INSERT`；`UPDATE, DELETE` 必须由数据库拒绝。admin、Package manager、
Package executor 和 Worker ingress 对两表均无 `SELECT/INSERT/UPDATE/DELETE`。
迁移 authority 继续独占 DDL。

### 4. Capability 与 schema 必须锁步

- SQLite：`0057-tool-invocation-artifacts` 建表，
  `0058-capability-v29` 发布 `tool_invocation_artifact:1`；当前 58 条 migration、
  capability v29、51 张 typed owned table；
- PostgreSQL：`pg-0031-tool-invocation-artifacts` 原子建表、安装 ACL 并发布
  capability v30；当前 31 条 migration、capability v30、50 张表。

双方言 readiness、Drizzle schema、migration manifest/checksum、table/column/index/
CHECK/FK contract 必须一起前进，不能只修改 migration SQL。

## 低配与集群影响

- Edge 仍是单 SQLite 文件和现有共享写 authority；每次调用只增加两个有界行和一次
  短事务，不增加后台工作；
- input 明文上限 64 KiB，完整 envelope 上限 96 KiB；preview 内容上限 8 KiB，完整
  envelope 上限 16 KiB；
- Cluster 的两个 Artifact 随 PostgreSQL WAL 复制，不在应用层再造复制协议；
- retention/rekey 不进入 runtime 热路径，后续必须由短生命周期 maintenance
  authority 实现。

## 被否决方案

1. **给 runtime 授予 UPDATE 以继续使用 `FOR SHARE`**：为不可变表扩大权限，且不能
   提供额外正确性。
2. **分别 autocommit 两个 Artifact**：崩溃会留下无法判定的半 pair。
3. **把 Artifact 写入 start barrier JSON**：扩大热表和恢复读取面，并复制
   ciphertext。
4. **让 admin/Package executor 代写**：混淆执行 authority 与管理/发布 authority。
5. **新增 Artifact workspace package**：没有独立部署、依赖或权限生命周期。

## 验证

- SQLite database/schema/Artifact repository 定向测试 16/16；
- PostgreSQL migration/schema/readiness/Artifact repository 定向测试 33/33；
- Artifact repository 额外覆盖 concurrent unique winner exact replay、半 pair
  rollback、损坏 mirror fail-closed 与禁止 `FOR SHARE`；
- PostgreSQL 18.4 arm64 双节点物理 HA：
  - runtime 原子写入并 exact replay；
  - input JSON 不含测试明文；
  - admin、Package manager、Package executor、Worker ingress 均被数据库拒绝；
  - `remote_apply` standby 已观察两行；
  - timeline 1→2 promotion 后 runtime 可读取并重放；
  - 旧主经 `pg_rewind` 只读同步重入，总 gate `passed=true`。

## 后续门禁

1. retention、key rotation/rekey、遗失 key 和损坏 row 的 inspect/manual recovery；
2. 首个 trusted built-in adapter 在 durable start 后解封并再次验证 Registry；
3. adapter response-loss/进程崩溃的无重复副作用恢复证据。

Artifact reference 与最终 start barrier 的双方言原子绑定已由 ADR-0161
完成，不再属于开放项。
