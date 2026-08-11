# ADR-0374：共享、有界的 Task Discovery HTTP API

- 状态：Accepted
- 日期：2026-08-11
- 关联：QL-RFC-0001 D-05、D-06、D-08、D-13、D-17、D-28、D-75、D-85、D-87、D-157、D-257、D-262、D-279、D-280、D-285、D-286，ADR-0350、ADR-0367、ADR-0368、ADR-0373

## 背景

Local、Cluster 与 MCP 已能观察 Run、RunEvent 和 StepRun，但通用 HTTP 客户端仍不能先发现当前 Project 的 Task。面板、CLI 或 API client 因此必须从内部数据库或 MCP 复制 `taskId`，还不能形成“发现 Task → 选择 Task → 后续启动 Run”的产品链。

本机 MCP 已实现低敏 `qinglong.task.list`，SQLite 与 PostgreSQL 的 `TaskDefinitionSource` 也都拥有按 `taskId` 严格递增的 current-head keyset 分页。继续在 HTTP 端复制投影会形成字段、游标和失败语义漂移；把 MCP Tool/Registry 引入普通 HTTP 又会污染默认 Local 和 Cluster 制品。

## 决策

1. Runtime Core 在 `task-definition/projection` 拥有唯一 `executeBoundedTaskListProjection`。输入为 `{after?: {taskId}, limit?}`，默认 32、最大 64；输出为 `{tasks,hasMore,next?}`，顺序固定为 `taskId ASC`。
2. 每项只公开 `taskId`、current `revision`、`name`、`kind`、`specSchema`、`enabled`、`updatedAtMs`。不得返回 Project、description、spec config/command、labels、mutationId、contentDigest、Secret reference 或存储 row。
3. disabled Task 必须保留并显式返回 `enabled=false`，不得在投影层过滤后无界补页。投影拒绝跨 Project、越过 cursor、乱序、重复、超量、错误 continuation、畸形 current record 与 repository failure。
4. Local 与 Cluster 增加同构 `GET /api/v3/projects/{projectId}/tasks`，固定 operation `task.list`、permission `task.read`。query 只允许 `after_task_id` 和 `limit`；不存在 body，非法 query 在 authentication 前拒绝。
5. Local 复用 loopback listener、Edge 4/Standalone 32 admission concurrency、Bearer、Project Policy、durable audit、credential/Pepper confirm 与 application 已打开的唯一 SQLite authority。Local Application 只向 product surface 暴露 `TaskDefinitionSource.listTaskDefinitions`。
6. Cluster 复用 route registry、两阶段 admission、durable audit、现有 PostgreSQL Pool 与 `ClusterControlAssemblyInput.taskDefinitions`；不新增管理 listener、Pool 或缓存。
7. MCP `qinglong.task.list` 保持名称、版本、输入输出和 admission 不变，但降为共享投影的协议 adapter；Runtime Core projection 不导入 Tool Registry、MCP SDK 或 SemVer。
8. 不新增 workspace package、第三方依赖、migration、表、索引、数据库连接、listener、sidecar、timer、watcher、cache 或写 authority。Task point read、spec 展示、Task start 和任何 mutation 仍需独立 ADR。
9. D-285 的 14 Profile、可达 JavaScript、文件、flash、module、RSS 与真实 Local image 门不得放宽；完整 backend/packages、package/dependency boundary 和 PostgreSQL HA 必须继续通过。

## 实现证据

- Runtime Core 已实现唯一 `executeBoundedTaskListProjection`；Local API、Cluster Control 和既有 MCP Tool 均只作协议 adapter。SQLite 真实 HTTP 路径覆盖 Bearer、`task.read` Policy、durable `task.list` audit、credential confirm 与同一 TaskDefinition authority；Cluster production composition 复用既有 PostgreSQL source/Pool。
- Runtime Core `481/481`、Local MCP `41/41`、Local Application `45 pass/4 skip`、Local API `36/36`、Cluster Control `200 pass/2 skip`；完整 18-package clean build/test 退出 `0`，backend 为 `1,163 pass/2 skip`。dependency/package boundary 均 compatible。
- workspace 仍为 18 package、1,031 source，其中 1,013 个实现文件位于嵌套领域目录、18 个为受审根入口；无 single-source/shallow package。本切片只新增 Runtime Core、Local API、Cluster Control 各一个嵌套实现文件，没有新增 package 或根目录平铺文件。
- 14 个最终 Profile artifact 全部 compatible，未提高任何 cap：基础 Edge/Standalone 为 `2,385,220/2,385,298` bytes、230 个可达 JavaScript、50 loaded modules；Application+API 为 `3,533,506/3,533,650` bytes、78 modules；Application+AI 为 `4,211,374/4,211,506` bytes、133 modules，距 6 MiB 门仍有 `2,080,082/2,079,950` bytes；MCP 为 `7,154,215/7,154,323` bytes、211 modules。
- 真实 arm64 Local image 为 UID/GID `65532:65532`、AI excluded，精确 inventory 为 10 package/380 files/3,284,889 bytes；Edge 128 MiB/64 PIDs 与 Standalone 256 MiB/256 PIDs 均在 read-only root、network none 下完成 20-event active→graceful stop，SQLite integrity 为 `ok`。
- PostgreSQL HA Docker 门在 PostgreSQL `18.4`/arm64 上通过 112 gates，primary timeline `1→2`，报告 SHA-256 为 `e6e02a78d08ec387e57a9246f3175cd1bc1f05952711da584b3aa5e93dffe05c`。没有新增依赖、migration、连接、listener、timer、cache 或写 authority。

## 不采用方案

- **复制 MCP 投影到两个 HTTP package**：会形成三份字段与分页安全规则。
- **HTTP 直接调用 MCP Tool**：把 Tool Registry、SemVer/MCP 协议和可选 sidecar 依赖带入普通 API。
- **只实现 Local 或只实现 Cluster**：同一 `/api/v3` 在部署梯度间漂移，客户端必须维护两套能力。
- **返回完整 TaskDefinition**：命令、config 和 labels 可能含 secret-adjacent 内容，并提前冻结内部 spec。
- **过滤 disabled Task**：底层按 `taskId` 分页，投影过滤会造成页大小不确定或无界补读。
- **新增 Task query package/service**：纯投影没有独立部署、authority 或依赖隔离价值。

## 完成门

- Runtime Core 覆盖默认/最大页、稳定 cursor、字段脱敏、disabled Task、跨 Project、乱序/重复/超量、continuation drift 和 repository failure；leaf import 不加载 Tool Registry/SemVer。
- Local route、transport、admission、product-surface authority 与真实 SQLite HTTP 覆盖 `task.read`、pre-auth query rejection、credential confirm、durable audit 和同一 storage authority。
- Cluster route、registry 与 production composition 使用既有 `TaskDefinitionSource`/Pool，并覆盖 Project Policy、audit 和最大响应。
- MCP 既有 Tool schema与 stdio E2E 保持不变，并证明只调用共享投影。
- Runtime Core、Local API、Local Application、Local MCP、Cluster Control、双方言相关测试、完整 backend/18-package、14 Profile artifact、Local image 与 PostgreSQL HA 门全绿。
