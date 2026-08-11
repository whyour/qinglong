# ADR-0163：原子加密 Tool 成功完成协议

- 状态：Accepted
- 日期：2026-07-26
- 关联：ADR-0156 至 ADR-0162；RFC D-149 至 D-152

## 背景

ADR-0162 已能在 durable start barrier 后执行首个受信只读 Tool，并返回经过当前
Definition Registry 规范化的内存结果，但该结果还不是可恢复的 durable fact：

- 进程在 adapter 成功后、StepRun 完成前崩溃时，无法证明 exact output 是否已经完成；
- 只更新 StepRun 会让 result、RunEvent 和 mutation ledger 出现部分提交；
- 把明文 output 存入 StepRun、RunEvent 或普通 JSON 会扩大数据库泄露面；
- 只读 `retry_safe` 只能说明重试不会重复副作用，不能重放同一次 exact result。

该缺口必须同时适配单 SQLite 的低配路由设备和 PostgreSQL 多副本节点，且不能为一个
协议继续增加只有单文件的 workspace package。

## 决策

### 1. Result Artifact 是密文，不是 StepRun payload

`@qinglong/runtime-core/tool-execution-completion` 定义三个 exact-shape v1 contract：

- `qinglong/tool-execution-result-artifact@v1`；
- `qinglong/tool-execution-completion@v1`；
- `qinglong/tool-execution-completion-command@v1`。

成功 output 必须先通过同一 current Tool Definition Registry 规范化，再以
AES-256-GCM 密封。AAD、Artifact digest 和 completion digest 绑定：

- Project、Run、StepRun 与 start barrier；
- Tool、adapter、output digest 与 execution result digest；
- key ID、算法、密文长度和完成时间。

数据库只保存密文 Artifact，不保存 output 明文。output 上限为 256 KiB，Result
Artifact JSON 上限为 384 KiB，Completion JSON 上限为 24 KiB。key provider 仍只
返回 owned 32-byte key；加解密持有的 byte buffer 在成功和失败路径都覆零。

### 2. 成功完成与 StepRun/Run 事实同事务提交

双方言 repository 的 `commit(command)` 必须在一个事务中完成：

1. 读取并复验 exact durable start barrier；
2. 复验 start mutation 对应的 Run version/event sequence；
3. 锁定并复验当前 `running` Tool StepRun 与非 terminal Run；
4. 把 StepRun 原子迁移为 `succeeded`，且 `outputRef` 必须等于 Result Artifact ID；
5. CAS 递增 Run version/event sequence；
6. 插入 RunEvent、StepRunMutation；
7. 插入不可变 Result Artifact 与 Completion record。

任一身份、digest、version、event sequence、时间或 output reference 漂移均失败关闭。
同一个 start、Artifact、mutation、event 或 `(Run, StepRun, completed version)` 不能
绑定到第二组事实。完整命令重放返回 `existing`；部分相同或内容漂移返回 conflict。

SQLite 使用 `BEGIN IMMEDIATE`。PostgreSQL 使用既有 SERIALIZABLE 有界重试事务，
并对 StepRun/Run 使用行锁；读取 `jsonb` barrier 后必须先通过领域 normalizer
规范化，不能依赖 PostgreSQL 保留 JSON 对象键顺序。

### 3. 表与权限保持追加式

SQLite migration 0061 新增 `ToolExecutionCompletions`，0062 将 local capability
推进至 v31。PostgreSQL migration `pg-0033-tool-execution-completions` 新增
`ql3.tool_execution_completions`，将 `control-core` 推进至 v32。

单表同时保存 Artifact JSON、Completion JSON、关键 mirror 列、复合唯一约束和到
start barrier、StepRun mutation、RunEvent 的外键。这样避免再为 Result Artifact
创建一个单用途表和一套不完整提交协议。

PostgreSQL `ql3_runtime` 对该表只有 `SELECT, INSERT`；admin、Package manager、
Package executor、Worker ingress 与 PUBLIC 均无权限。repository 不提供 update 或
delete。

### 4. 不新增 package，按部署边界使用显式 subpath

共享协议留在现有 `runtime-core`，SQLite/PostgreSQL adapter 分别留在现有
`local-sqlite` 与 `cluster-postgres`。三个入口均为显式 subpath，不从 package root
聚合导出。

workspace 继续保持 21 个 QL3 package，没有新增第三方依赖、进程、连接池、timer、
watcher、socket 或后台队列。Edge/Standalone 每次成功调用只增加一次有界 AES/JSON
工作和一个现有 SQLite 事务；Cluster 复用现有 PostgreSQL Pool。

## 当前边界

本 ADR 只关闭 `running → succeeded`：

- `failed`、`timed_out` 和 cancellation 的 Tool-specific result/error envelope 尚未
  建立；
- trusted adapter 的产品 composition 尚未把 execute→seal→commit 串成公开路径；
- Result Artifact key 的持久 catalog、rotation、retention/rekey 仍由后续决策完成；
- key lost、Artifact/关系损坏和 result ambiguity 仍需 inspect/manual recovery；
- HA 门已验证 schema/ACL/复制与既有领域提交响应丢失，但尚未对新的
  Tool completion transaction 注入 COMMIT-response-loss。

因此 Tool execution production admission 继续关闭。

## 被否决方案

1. **把明文 output 写入 StepRun 或 RunEvent**：扩大敏感结果的持久化与读取面。
2. **先保存 Artifact、再更新 StepRun**：崩溃窗口会产生无完成事实的孤立结果。
3. **只保存 output digest**：无法在重启或响应丢失后重放 exact output。
4. **复用 invocation Artifact 表**：输入与结果具有不同身份、生命周期和授权方向。
5. **拆成新的 result package**：没有独立部署、依赖或权限生命周期，只会继续增加
   单文件 package。
6. **赋予 runtime UPDATE/DELETE**：破坏 append-only 证据边界。
7. **直接比较 PostgreSQL `jsonb` 字符串**：对象键顺序不是语义，可能误报 conflict。
8. **把成功协议宣传为全 terminal completion**：会掩盖 failed/timed_out 的恢复缺口。

## 验证

- runtime-core：320/320；
- local-sqlite：117/117，真实内存 SQLite 覆盖原子提交与 exact replay；
- cluster-postgres unit：178 pass / 1 条件 skip；
- 全新 PostgreSQL 18 六角色真库 integration：41 pass / 1 条件 skip，直接覆盖加密
  Result Artifact、`running → succeeded`、Run version/event sequence、exact replay
  和无明文持久化；
- PostgreSQL 18.4 arm64 双节点物理 HA：streaming、`remote_apply`、旧主隔离、晋升、
  `pg_rewind` 回归只读、双控制副本恢复及全部报告 gate 通过；
- 21 个 QL3 workspace package 全量 build/test 通过；
- edge import、cluster dependency、edge artifact 审计通过；edge artifact
  3,554,497 bytes、40 个加载模块、RSS 增量 10,731,520 bytes；
- 临时 PostgreSQL 容器已删除，无测试资源残留。

## 后续门禁

1. 在 edge/standalone 与 cluster-control composition 中装配
   start→execute→seal→commit，并保持公开入口默认关闭；
2. 定义 failed/timed_out 的低敏、可恢复、不可伪造完成 envelope；
3. 增加 SQLite crash、PostgreSQL COMMIT-response-loss 与 Tool completion 的物理 HA
   故障注入；
4. 建立 result key catalog/rotation/retention/rekey 与人工恢复流程；
5. 完成物理 Edge idle/fault/scale 证据后再评审 production admission。
