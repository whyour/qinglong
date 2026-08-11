# ADR-0023：不可变 Task Execution Revision 存储

- 状态：Proposed
- 日期：2026-07-18
- 关联：QL-RFC-0001、ADR-0004、ADR-0014、ADR-0022、ADR-0024

## 上下文

ADR-0022 已规定 Dispatcher 必须用 Run 固定的 Project/Task/revision 三元组重建执行模板，禁止回退当前 Task。只有内存接口还不够：控制面重启、Task 后续编辑或自动重试创建 Attempt N+1 时，都需要一个可校验、精确读取且不会被覆盖的持久化事实。

部署范围同时包含资源受限路由设备与 cluster-control。edge 需要低常驻开销、单行写入和 SQLite 本地恢复；cluster-control 需要共享 PostgreSQL、多副本一致性和独立保留策略。不能让两者通过共享 SQLite 或各自解释可变 Task 行获得看似相同、实际漂移的语义。

## 决策

### 1. revision 身份是复合主键

`TaskExecutionRevisions` 使用 `(project_id, task_id, task_revision)` 作为主键，并保存：

- `executor_type`；
- canonical `execution_template`；
- opaque `context_ref`；
- `content_digest`；
- 首次成功写入的 `created_at_ms`。

不建立到当前可变 Task 行的级联外键。删除或修改当前 Task 不能使历史 Run 的 revision 消失或改变。表不保存 Secret 明文、环境值、Run/Attempt identity、Worker lease、callback token、PID/handle 或日志写句柄。

### 2. 写入是 append-only

Repository 只暴露 `insert()` 和精确 `resolve()`，不提供 update/upsert/delete：

- 新身份写入返回 `inserted`；
- 同身份、同规范化内容的并发或崩溃重放返回 `idempotent`，保留第一次时间；
- 同身份、不同内容返回稳定的 immutable conflict，禁止 last-write-wins。

未来 retention 删除必须先证明没有 Run、Attempt、审计保留或恢复窗口仍引用该 revision；该能力不属于当前切片，不能用通用 CRUD 绕过。

### 3. 摘要基于已知字段的 canonical 表示

写入前复用 `ExecutionSpec` 边界校验，剥离未知字段，深拷贝 command/resource policy，并按固定字段顺序生成 canonical JSON。SHA-256 覆盖 Project/Task/revision、executor、执行模板和 `contextRef`。

读取时重新解析、规范化并核对 canonical bytes 与摘要。非法 JSON、非 canonical 模板、非法 executor、越界字段、时间损坏或 digest 不一致均 fail closed，不把可疑记录交给 context materializer 或 Executor。返回值及嵌套命令/资源结构被冻结，调用方不能修改共享事实。

摘要用于损坏检测和幂等比较，不代替数据库访问控制、备份校验或发布者签名。

### 4. edge 与 cluster 共享 contract，不共享 adapter

当前 `next` 的 `0012-task-execution-revisions` migration 和 Sequelize adapter 是 SQLite edge/standalone 孵化实现：

- 每个 revision 一次单行写入，没有常驻 timer、后台索引器或外部服务；
- 读取只有复合主键点查；
- 为未来按 Project 和创建时间执行有引用证明的保留扫描提供索引；
- adapter 在非 SQLite dialect 构造时直接拒绝。

cluster-control 必须实现 PostgreSQL repository，并用共享数据库事务、冲突语义和独立 retention worker；不能挂载共享 `database.sqlite`，也不能假设单进程锁。两种 adapter 必须通过同一 contract suite，并产生同一 canonical digest。

### 5. 当前仍不接入生产 Dispatcher

ADR-0024 已进一步建立 content-addressed context recipe、Secret provider port 和 attempt-scoped 本地 Artifact/output allocator。动态 `ExecutionContext` 仍需要生产 SecretStore、运行中日志 quota/retention 和 callback capability adapter；可信 retry policy provider、Dispatcher lifecycle、管理/API 写入入口、PostgreSQL/object Artifact adapter、指标告警和备份门禁也未完成。

因此默认 manual Primary 仍不构造该 repository，local Dispatcher 仍保持 production unreachable。不能因为 `0012` 已随 migration chain 建表就默认开启自动重试或切走 Legacy 调度。

## 影响

正面影响：

- Task 编辑或删除不会改变历史 Run 与 Attempt N+1 的执行模板；
- 同 revision 的并发发布可以安全收敛，内容碰撞显式失败；
- SQLite edge 只增加一次有界单行写入和主键点查；
- cluster 可以替换 adapter，而不改变 materializer 和 Dispatcher 语义。

代价与风险：

- revision 表随 Task 修改增长，需要引用感知 retention、备份和容量指标；
- SHA-256 不能证明内容发布者身份，Package/插件签名仍需独立协议；
- `contextRef` 也属于摘要覆盖内容，引用方案迁移必须创建新 revision，不能原地改写；
- 当前 Sequelize adapter 是孵化桥接层，最终 node:sqlite/PostgreSQL 实现仍需 contract 与并发压力验证。

## 未选择的方案

1. **只在 Run 保存一段任意 JSON**：缺少共享规范化、精确复用和保留边界，拒绝。
2. **相同 key 使用 upsert 覆盖**：历史执行事实会被改写，拒绝。
3. **只比较调用方提供的 revision 字符串**：无法检测同名不同内容和存储损坏，拒绝。
4. **把 Secret 环境写入 execution template**：扩大静态泄漏与备份暴露面，拒绝。
5. **cluster-control 复用共享 SQLite**：没有多副本事务与运维边界，拒绝。
6. **读取失败时回退当前 Task/latest**：不可审计且可能执行错误内容，拒绝。

## 验证要求

- migration chain 与 schema ownership manifest 覆盖新表、复合主键、索引和约束；
- 精确三元组命中，错误或不存在的 revision 返回 unavailable；
- 输入在写入后修改不影响存储，读取结果嵌套冻结；
- 多个并发同内容写入恰好一次 inserted，其余 idempotent；
- 同 key 异内容稳定冲突，不覆盖首次记录；
- 非 canonical template、非法 JSON、摘要或字段损坏 fail closed；
- SQLite adapter 拒绝 cluster dialect；
- Node 22、Node 24 构建与全量回归通过；
- 后续 PostgreSQL/node:sqlite adapter 复用同一 contract 和 digest vectors。
