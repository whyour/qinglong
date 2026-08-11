# ADR-0047: PostgreSQL Project Policy 与 RoleBinding Fence

- 状态：Proposed
- 日期：2026-07-19
- 关联 RFC：QL-RFC-0001 D-27 至 D-32、D-34 至 D-44、D-45

## 上下文

ADR-0046 已强制 `/api/v3` 在读取 body 前完成 Authentication、Policy 与安全审计，但当时 cluster-control 只有 Policy port，没有 PostgreSQL 权威实现。若直接注入 allow-all stub、复用进程内 role Map，或 deep-import legacy Sequelize adapter，都会让 readiness 已通过的多副本控制面在授权事实上一致性失效。

既有 SQLite `0017-project-policy` 已定义 ownerless `default` Project、append-only versioned RoleBinding、六类 subject、固定 role matrix、mutation replay 与 expected-version CAS。PostgreSQL 必须保持相同领域结果，但不能逐字复制 SQLite 较弱的数据库约束或单写者事务假设。

## 决策

### 1. Profile-neutral Policy contract 进入 runtime-core

`@qinglong/runtime-core/project-policy` 冻结：

- `user / api_app / mcp_client / agent / system / worker` 六类 subject；
- Project status、owner/admin/operator/viewer role 与 permission vocabulary；
- Project、RoleBinding、snapshot 与 append command exact-shape normalizer；
- `ProjectPolicyRepository` port；
- role matrix、archived read-only、Agent `require_approval` 和 Project/Binding version fence。

legacy 与 runtime-core 由 parity test 比较 vocabulary、effect、reason 和 fence。过渡期可以存在实现副本，但不得产生两套 Policy 语义。

### 2. `pg-0004-project-policy` 推进 capability v3

reviewed migration 新增：

- ownerless `ql3.projects`，只创建无隐式 owner 的 `default` baseline；
- `ql3.project_role_bindings`，复合主键包含 Project/subject/version；
- Project 内 mutation 唯一索引、current lookup 与 subject lookup 索引；
- active 必须携带有效 role，revoked 必须为 `role IS NULL`；
- Project timestamp、subject、mutation 和版本使用数据库 CHECK；
- capability 从精确 v2 predecessor 推进为：
  `{"project_policy":1,"run_core":1,"run_retry_policy":1}`。

Drizzle metadata、schema contract、migration checksum 和真实 catalog 必须 lockstep。readiness 看到 capability/history/table/index/CHECK/FK 任一漂移都保持 not-ready。

### 3. Runtime role 只能 append RoleBinding

精确 runtime privilege 为：

- `projects`: SELECT、INSERT、UPDATE，禁止 DELETE；
- `project_role_bindings`: SELECT、INSERT，禁止 UPDATE、DELETE；
- schema CREATE 继续禁止。

Role revoke 通过 append 新 version 表达，禁止覆盖或删除旧授权事实。migration role 仍是唯一 DDL authority。

### 4. PostgreSQL append 使用数据库 fence

`PostgresProjectPolicyRepository.append()` 固定：

1. `SERIALIZABLE` transaction 与硬 statement/lock/idle timeout；
2. `SELECT Project ... FOR UPDATE`，同时证明 Project 存在并串行化该 Project 的 Policy mutation；
3. 先按 `(project_id, mutation_id)` 检查精确 replay；不同 payload 使用同 mutation ID 时冲突；
4. 读取 subject 最新 version，并与 `expectedCurrentVersion` 精确比较；
5. 只 INSERT version N+1；serialization/deadlock/lock conflict 有界重试；
6. 行畸形、重复 identity、未知 SQL 错误与连接失败统一映射为低敏 unavailable。

两个并发 expected-version writer 只能有一个 winner。winner 的精确 replay 返回原事实，loser 不得通过最后写覆盖改变 role。

### 5. Readiness 后同时装配 Run 与 Policy Repository

cluster-control 只有在 capability v3、catalog 和 runtime role 全部通过后，才向 application factory 提供同一 Pool 上的 `RunRepository` 与 `ProjectPolicyRepository`。admission 使用共享 `ProjectPolicyEngine` adapter 产生 allow/deny/approval 与 fence；无 Project scope 的 operation 默认 deny。

## 被否决的替代方案

### 复用 legacy Sequelize Policy adapter

拒绝。该 adapter 明确 SQLite-only，并会让 cluster artifact 反向加载 legacy root、Sequelize 与本地数据库假设。

### 用 upsert 保存 subject 当前 role

拒绝。会丢失撤权历史，使旧 approval/fence 无法解释，也无法区分精确 replay 与覆盖写。

### 只靠唯一索引竞争，不锁 Project

拒绝。mutation identity 与 subject version 是两个约束域，仅处理 `23505` 不能证明 Project 存在检查、replay 和 version winner 在同一快照内成立。

### 缓存 role 并异步失效

当前拒绝。未定义可靠 version invalidation 前，缓存会让 revoke 后的旧 allow 在其他 pod 继续生效。首版先走有界数据库点查。

## 影响

### 正向

- cluster-control 不再需要 allow-all Policy seam；
- SQLite/PostgreSQL 对相同 snapshot 返回相同 effect/reason/fence；
- RoleBinding 为 append-only durable fact，支持审计、撤权和并发裁决；
- runtime role 即使被业务 bug 驱动，也不能 UPDATE/DELETE binding history；
- Project row lock 将同一 Project 的低频权限 mutation 与高频 Policy read 分离，不阻塞普通 read。

### 代价

- 同一 Project 的 RoleBinding mutation 被串行化；这是权限管理低频路径的有意选择；
- runtime role 对 Project 需要 UPDATE 权限以执行 `FOR UPDATE` 和后续 Project 管理，必须继续由 Repository/Policy 限制；
- 当前 ADR 只完成 Project/RoleBinding core；后续 ADR-0048/0049 已补齐受审 route registry、cluster credential authentication 与持久化安全审计，Project/Role/credential 管理 API、audit retention/query 和 Approval PostgreSQL tables 仍未完成；
- `runs.project_id` 到 `projects.id` 的跨历史 backfill/FK 尚未决策，不能在已有 alpha 数据上盲加约束。

## 验证

1. runtime-core normalizer/engine unit test覆盖 exact shape、role matrix、archived、Agent approval 和 fail-closed。
2. legacy/runtime parity test覆盖 vocabulary、effect、reason 与 fence。
3. migration checksum、capability predecessor、Drizzle/schema/catalog lockstep test全部通过。
4. fake Pool test覆盖 resolve、SERIALIZABLE 顺序、exact replay、version/mutation conflict、rollback/retry 和 corrupt row。
5. 真实 PostgreSQL 双连接测试证明同 expected version 只有一个 winner，winner 可精确 replay。
6. 真实数据库直接 INSERT 证明 revoked+role 与逆序 timestamp 被 CHECK 拒绝。
7. 独立 runtime role 证明 Project 无 DELETE、RoleBinding 无 UPDATE/DELETE、schema 无 CREATE。
8. PostgreSQL 16/18 × x64/arm64 CI 继续作为正式 server/readiness 证据；较旧 PostgreSQL 必须被 production readiness 拒绝。
