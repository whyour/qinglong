# ADR-0376：Policy 与 TaskDefinition digest 双栅栏的 Task Start

- 状态：Accepted
- 日期：2026-08-12
- 关联 RFC：QL-RFC-0001 D-288
- 前置决策：ADR-0367、ADR-0368、ADR-0375

## 上下文

ADR-0375 已向 Local/Cluster HTTP 与本机只读 MCP 提供 current Task point read，并明确 `contentDigest` 只作为后续写请求的 optimistic fence，不能替代执行授权。当前定时调度能够原子创建 Run、Attempt 与前两个 RunEvent，但产品 HTTP 尚不能以一个受认证、可重放、可审计的请求手动启动 current Task。

Task Start 同时横跨 Project Policy、TaskDefinition current head、已发布执行 revision、Run/Attempt/Event 三张表和两种数据库方言。如果先读 Task 再在另一个事务创建 Run，会在定义更新、禁用、权限撤销或执行 revision 发布失败时执行错误内容。若把 command、environment、placement、SecretRef、Run/Attempt/Event ID 或时间交给调用方，又会绕过 TaskDefinition 和执行计划的既有 authority。

## 决策

### 1. 唯一协议与产品入口

Local 与 Cluster 提供同构入口：

`POST /api/v3/projects/{projectId}/tasks/{taskId}/runs`

- operation：`task.start`
- permission：`run.start`
- wire schema：`qinglong/task-start@v1`
- request 只允许 `schema`、`mutationId`、`expectedRevision`、`expectedContentDigest`
- 新建返回 `202`/`accepted`；精确重放返回 `200`/`existing`

`mutationId` 必须为小写 canonical UUID；revision 为 1..2147483647；digest 为 64 位小写 SHA-256。请求体拒绝未知字段。调用方不得提供 Run/Attempt/Event identity、时间、priority、origin、executor、command、environment、placement、SecretRef 或任意输入 Artifact。本批不虚构尚未冻结的 ad-hoc input 语义。

### 2. 单事务双栅栏

Local 使用既有单 SQLite authority/queue 与 `BEGIN IMMEDIATE`；Cluster 使用既有 runtime Pool 与 SERIALIZABLE transaction。事务按固定顺序：

1. 锁定/读取 active Project，并重验 admission 返回的 `projectVersion`；
2. 读取 subject 的最新 active RoleBinding，重验 `bindingVersion` 且角色仍为 owner/admin/operator；
3. 按 `ql3:task-start:v1:{mutationId}` 查询 Project-scoped idempotency key；精确一致则返回原持久化 identity，任何漂移返回 `mutation_conflict`；
4. 锁定 current Task head/revision，重验 project/task、expected revision/content digest 与 enabled；
5. 验证同一 Task revision 已发布且 digest 正确的 `local_process` 或 `remote_worker` execution revision；缺失/损坏失败关闭；
6. 由服务端生成 Run、Attempt、两条 Event ID 和数据库时间，原子写入 queued Run、claimed Attempt、`run.created` 与 `run.queued`；
7. commit 后只返回有界低敏结果。

Run 固定 `execution_origin=manual`、`execution_owner=runtime`、`trigger_type=task_start`、`priority=0`、`version=2`、`event_sequence=2`。`task_revision`/`task_snapshot_ref` 固定为 `qltd:v1:{revision}:{contentDigest}`；Attempt 由 Profile 固定为 `local_process` 或 `remote_worker`。Event actor 从已认证 Security subject 派生，payload 只保留 definition/execution digest、mutation 与 Policy fence，不复制 command/environment/SecretRef。

### 3. 错误与重放

- `400 invalid_task_start_request`：wire shape/schema/UUID/revision/digest 非 canonical；
- `404 task_not_found`：Task 不存在或不属于 Project；
- `409 task_start_fence_rejected`：`authorization_changed`、`definition_changed`、`task_disabled`、`task_not_executable` 或 `mutation_conflict`；
- `503 task_start_unavailable`：连接、事务、数据库时钟、执行 revision 损坏/缺失或无法证明一致。

重放以已持久化 Run、Attempt 和两条 Event 为 authority，不使用本次请求新生成的 ID。相同 mutationId 绑定不同 Task、definition fence、subject 或事件形状时失败关闭，不能返回已有 Run 掩盖冲突。

### 4. Profile 与 package 边界

- 不新增 package、第三方依赖、migration、table、index、Pool、listener、timer、watcher 或 cache；复用两种 Run 表已有 `(project_id,idempotency_key)` 唯一索引。
- 共享 contract 放入 `runtime-core/task-start`；SQLite/PostgreSQL adapter 放入各自现有 Task/Run owning package；HTTP route 放入既有 Local API/Cluster Control task 目录。
- 默认 headless Local 不加载 Task Start adapter；只有可选 Local API product surface 启用时才通过既有 SQLite authority 惰性构造。
- Cluster 复用唯一 runtime Pool。MCP 继续只读，不在本批取得 `run.start` mutation authority。
- Edge 保持 4 个 in-flight 与 512-byte mutation body；Cluster 继续使用受认证后读取的既有有界 JSON body，不引入额外常驻资源。

## 被否决的替代方案

1. **只传 taskId，服务端盲用 current head**：调用方无法 fence 刚读到的定义，拒绝。
2. **把 command/input/placement 放入请求**：绕过 TaskDefinition、Secret 与 execution revision authority，拒绝。
3. **先创建 Run，再异步验证 Task/Policy**：留下不可执行或越权 Run，拒绝。
4. **为 Task Start 新建 workspace package 或数据库 ledger**：既有领域包和 Run idempotency index足以承担责任，拒绝。
5. **同步向 MCP 开放写工具**：扩大低配设备与 Agent 权限面，且没有独立审批/用户确认契约，拒绝。

## 验收

1. Runtime contract 覆盖 exact shape、canonical values、result/error normalization。
2. SQLite 与 PostgreSQL 覆盖 accepted/existing、mutation conflict、权限撤销、definition 更新/禁用、execution revision 缺失/损坏、事务回滚和并发唯一胜者。
3. Local/Cluster 真实 HTTP 覆盖 route、认证、`run.start` Policy、持久审计、body 顺序、202/200/400/404/409/503。
4. 默认 headless Local 的 import/resource closure 不增加；MCP 仍无 mutation route/tool。
5. 完整 package/backend、dependency/package boundary、14 个 artifact、真实 Local image 与 PostgreSQL HA 门通过后，状态才可改为 Accepted。

## 验收证据（2026-08-12）

- Runtime Core 489/489、Local SQLite 217/217、Cluster PostgreSQL 295 pass/1 conditional skip、Local API 42/42、Local Application 45 pass/4 skip、Cluster Control 207 pass/2 skip；完整 18-package clean build/test 退出 0，backend 1,163 pass/2 skip/0 fail。
- SQLite 真实 HTTP 链证明 202 accepted、200 exact replay、持久审计与同一 Run；PostgreSQL 18 live integration 证明单事务创建 queued Run、claimed Attempt、两条 Event 与 exact replay。
- workspace 保持 18 package；1,040 个 TypeScript source 中 1,022 个位于能力目录，18 个根文件均为受 manifest 约束的公开或 binary entry；无 single-source/shallow package，package/dependency/Edge import boundary 均无 finding。
- 14 个 Edge/Standalone artifact 全部 compatible；默认 Profile 为 2,411,741/2,411,819 bytes，API 为 3,570,008/3,570,152 bytes，Application+AI 为 4,238,047/4,238,179 bytes，MCP 为 7,161,579/7,161,687 bytes，均未放宽预算。
- 真实 arm64 Local image 的生产闭包为 10 package/382 files/3,311,562 bytes，AI excluded；Edge 在 128 MiB/64 PIDs，Standalone 在 256 MiB/256 PIDs 下均完成 active、20 events、graceful stop 与 SQLite integrity `ok`。
- PostgreSQL 18.4 arm64 HA 通过 112 gates、timeline `1→2`，报告 SHA-256 为 `48a68dd97f768d5a6d1dfba2ce325a52e2d9377d677ec4f74944f75e43f994a7`；独立 Task Start live integration 与 HA 门的临时 Docker 资源均已清理。
