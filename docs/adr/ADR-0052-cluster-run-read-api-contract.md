# ADR-0052: Cluster Run Read API Contract

- 状态：Proposed
- 日期：2026-07-19
- 关联 RFC：QL-RFC-0001 D-03、D-08、D-11、D-38、D-44 至 D-47、D-51

## 上下文

cluster-control 已具备 PostgreSQL RunRepository、真实 bearer Authentication、Project Policy、durable security audit、reviewed route registry 与认证前 overload shield，但此前没有任何受审业务 route。继续直接制作镜像会把一个网络与存储底座包装成“可部署控制面”，却没有可供用户调用的领域能力；反过来，一次性接入 Run 创建、调度、取消和恢复又会在 production lifecycle 尚未完成时开放副作用。

首个业务纵切面因此选择只读 Run 查询。它必须证明 API 不会直接序列化 PostgreSQL/领域记录，不会因 Run ID 暴露其他 Project 的存在性，也不会绕过既有 route → Authentication → Policy → audit → body → handler 顺序。

## 决策

### 1. 固定唯一的首版 route authority

首个 route 固定为：

```text
GET /api/v3/projects/{projectId}/runs/{runId}
operation: run.get
permission: run.read
Project scope: path.projectId
query allowlist: empty
```

definition 只能由 `createClusterControlRunReadRoute()` 构造，再交给 reviewed route registry 编译。请求 body 必须为 `null`；带 body 的 GET 在任何 Run lookup 前返回 `400 invalid_request_body`。

### 2. 安全门禁先于 Repository

route resolution、bearer Authentication、`run.read` Project Policy 和 durable allowed/denied audit 全部成功后，prepared handler 才能执行一次 `findRunById(runId)`。未认证、无权限、route/query 不规范或 audit 不可用时不得读取 RunRepository。

该顺序意味着安全审计记录的是受审 operation 与 Project scope，而不是由 repository row 或请求 body 反向决定授权输入。

### 3. 只返回固定低敏投影

成功响应只包含：

- `id/projectId/taskId/taskRevision`；
- `status/version/eventSequence/priority`；
- `executionOrigin/executionOwner`；
- `createdAtMs/queuedAtMs/startedAtMs/finishedAtMs`。

可选时间统一编码为 `number | null`，使 wire shape 稳定。以下字段即使存在于领域记录也不得由该 route 返回：Task 名称/快照引用、trigger identity、request/idempotency key、input/output ref、executor handle、PID、lease/callback capability、error code/summary、Secret 或 Artifact 内容。

handler 在序列化前重新检查所有投影字段的类型、枚举、上限和时间值；损坏记录 fail closed，不能依赖 `JSON.stringify` 猜测安全性。

### 4. Project 错位与不存在统一屏蔽

以下情况统一返回 `404 run_not_found`：

- Run ID 不存在；
- Run 存在但 `run.projectId` 不等于已经授权的 path Project。

这样拥有 Project A `run.read` 的主体不能用 Run ID 探测 Project B。repository 抛错、返回错 ID 或投影损坏统一返回 `503 run_query_unavailable`，wire 不包含 SQL、连接信息、驱动错误或原始 row。

### 5. Package 与生命周期边界不变

route factory 位于 `@qinglong/cluster-control/run-routes`，只依赖 runtime-core 的公开 RunRepository contract，不导入 legacy Controller、Express、Sequelize 或 migration DDL。该切片提供可复用、受审的业务 route，但不伪造 production recovery/lifecycle，也不自动把 route 注册进尚未存在的默认 Profile application stack。

Profile 镜像必须等真实 startup recovery/lifecycle assembly 能安全安装该 route 后再宣称 ready。当前能力可以进入组合测试和后续 application assembly，不能单独证明完整控制面已可生产部署。

## 被否决的替代方案

### 直接返回 `RunRecord` 或 PostgreSQL row

拒绝。领域记录包含 request、trigger、Artifact、错误和兼容字段，未来加字段还会静默扩大 API 与隐私面。

### 只按 Run ID 查询后再决定 Project

拒绝。授权 scope 必须来自受审 path；先读 row 再授权会产生跨 Project 存在性旁路，并让 repository 数据决定 Policy 输入。

### 不区分 cross-Project 与 not-found

拒绝返回不同错误。两者统一 404 是刻意的存在性屏蔽，而不是丢失诊断；内部存储损坏仍用 503 区分。

### 先开放 Run 创建以证明“可用”

拒绝。production dispatch/recovery/lifecycle 和 Task revision materializer 尚未装配时，创建 queued Run 只会制造永久积压或不受控副作用。

## 影响

### 正向

- cluster-control 有了首个真实、只读、Project-fenced 的领域 API contract；
- API wire 不再等同于数据库或内部 domain shape；
- 跨 Project 存在性、存储错误和敏感引用默认被屏蔽；
- 后续 list/events/attempt routes 可以复用相同 DTO 与错误边界；
- 不扩大 edge 依赖或 cluster runtime 数据库权限。

### 代价与未完成项

- 当前只有单 Run point query，没有 list、event/attempt、Artifact 或流式日志查询；
- route factory 尚未进入默认 production application stack；
- 没有 ETag/version conditional read、缓存或跨副本负载基准；
- production recovery/lifecycle、独立 importer/image/SBOM 和真实 PostgreSQL HTTP integration 仍是发布门禁。

## 验证

1. route definition 固定 method/path/operation/permission/Project parameter 且不可变。
2. contract test 证明 Authentication、Policy、audit 完成前 Repository 调用次数为零。
3. 成功响应精确匹配低敏 DTO，敏感内部字段不进入序列化结果。
4. absent/cross-Project 返回相同 404；损坏/driver error 返回稳定 503。
5. GET body 在 Repository 前拒绝，未知 query 由 registry 在 Authentication 前拒绝。
6. package entrypoint import audit 继续拒绝 migration、legacy 与未声明依赖。
7. Node 22/24、cluster dependency audit 与 GitNexus detect-changes 继续作为合并门禁。
