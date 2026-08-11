# ADR-0381：强认证的 Local 手动 Run retry

- 状态：Accepted
- 日期：2026-08-12
- 关联 RFC：QL-RFC-0001 D-293
- 前置决策：ADR-0001、ADR-0035、ADR-0066、ADR-0365、ADR-0367、ADR-0380

## 上下文

ADR-0380 完成的是 admission-time policy 驱动的 lost Run 自动重试，不是用户发起的恢复操作。QingLong 3.0 已经定义 `run.retry` permission，Owner、Admin 与 Operator 角色也已获得该权限，但此前没有冻结以下产品语义：终态 Run 是否原地重开、怎样绑定认证与 Policy fence、重放如何避免重复创建 Run、低配路由设备如何限制写放大，以及 Local 与 Cluster 是否必须同时开放。

现有 Local HTTP bearer 只能建立 `single_factor` Principal。把它直接用于恢复执行会降低 ADR-0035 的强认证边界；为了 HTTP 对称而复制一个弱认证入口也会让 transport 决定领域安全语义。

## 决策

### 1. 手动 retry 创建新 Run，不改写源 Run

`run.retry` 只接受同一 Project 内状态为 `failed`、`cancelled` 或 `timed_out` 的顶层、runtime-owned、非 Workflow Run。源 Run 的状态、版本、Attempt 与 Event 历史保持不变；成功操作创建一个新的 queued Run，并以 `retry_of_run_id` 指向源 Run。

新 Run 复制源 Run 已冻结的 Task revision、snapshot reference、input 与 priority，但必须在提交事务内再次证明：

- 源 Run 的期望状态与版本未变化；
- source snapshot 与 Task revision 一致，且对应 execution revision 仍可解析为 Local process；
- 当前 Task 仍然启用；
- 源 Run 不是 nested Run 或 `plugin_package_workflow`。

一次手动 retry 只创建一个新的顶层 Run，不继承源 Run 的自动 retry policy。`lost` 必须先由 ADR-0380 的自动 reconciliation 收敛，不能借人工入口绕过 unknown-outcome safety。

### 2. 共享契约不绑定 transport 或 Profile

canonical `RunManualRetry*` request、command、result、错误和 Repository contract 位于 `@qinglong/runtime-core/run-manual-retry`。契约要求调用方提供：

- canonical mutation ID、source Run identity、期望状态与版本；
- 服务端生成的新 Run、Attempt 与 Event identity；
- 完整的强 User Principal；
- Project、RoleBinding 与 credential policy fence；
- request/audit identity。

该层不依赖 CLI、SQLite 或 Local Profile，后续 Cluster/PostgreSQL adapter 必须复用相同领域语义，而不是复制另一种“原地重开”行为。

### 3. Local 产品入口只接受强本机证明

首个产品入口加入现有统一产品 CLI：`ql3 run retry --command-file <private-file>`，实现 binary 为 `ql3-run`。私有命令文件只描述期望与部署位置，不得注入新 Run/Attempt/Event identity、时间戳、Task snapshot、command、environment、Secret 或执行 placement。

入口复用 Local Owner credential、pepper provenance 与 POSIX 私有文件证明，建立不超过五分钟的 `local_console` User Principal；随后按顺序执行 credential activation、`run.retry` Policy authorize、fence confirm 和 SQLite mutation。Owner、Admin、Operator 由既有角色矩阵授权，其他主体失败关闭。

本批不向 Local HTTP 暴露 retry：现有 bearer 只有 `single_factor`，在可信 MFA/hardware adapter 完成前不得升级或旁路。CLI 的存在也不授权 MCP、AI Tool 或常驻 application 获得该 mutation authority。

### 4. SQLite 是唯一原子 authority

SQLite adapter 使用短生命周期 connection 与 `BEGIN IMMEDIATE`。数据库时钟下，它在同一事务内完成：

1. 精确 idempotency replay 检查；
2. credential、Project、RoleBinding 与 source Run fence 重验；
3. 新 Run、claimed Attempt、`run.created`/`run.queued` Event 写入；
4. allowed security audit 写入。

相同 mutation 的精确重放返回原结果，不创建第二个 Run 或第二条 audit；语义漂移返回 conflict。认证、授权、fence、状态、资源限额或存储失败均通过既有安全审计 authority 记录有界失败事实，不回显 credential、command、input 或内部路径。

### 5. 限流复用既有耐久事实

不新增 rate-limit 表或进程内 token bucket。adapter 使用既有 `Runs(project_id, created_at_ms, id)` 索引，对同 Project、同 User、`run_manual_retry` trigger 的一分钟窗口计数：

- Edge：最多 4 个新 Run/分钟；
- Standalone：最多 16 个新 Run/分钟。

精确重放不消耗新额度。该设计在重启后仍然有效，且不增加低配路由设备的 timer、watcher、listener、常驻连接、cache 或 sidecar。Cluster 的多副本全局 quota 必须由后续 PostgreSQL adapter 独立证明。

## 验收

- Runtime Core 验证 request、strong Principal、fence 与低敏 response contract；
- SQLite 真库验证源 Run 终态不变、新 Run linkage、Attempt/Event/audit 原子提交、精确重放、状态/Task/auth fence 拒绝与 durable rate limit；
- Local Owner CLI 验证真实 credential、pepper、private command、Policy authorize、成功及拒绝审计；
- 受影响 package build/test、完整 QL3 package/backend 回归、dependency/package/Edge import audit 必须通过后才允许阶段性提交；
- workspace package、migration、表、索引和常驻资源数量不得增加。

### 验收证据（2026-08-12）

- Runtime Core 502/502；Local SQLite 真库包含 source/new Run linkage、exact replay、fence 与 rate-limit 专项；Local Owner CLI 160 pass/5 条环境条件 skip，其中产品 retry 成功、重放、拒绝审计与 binary 边界全部通过；
- `pnpm run test:packages:ql3`：18 个 QL3 package 全量清理、构建与测试通过，最终退出码 0；
- backend 回归：1165 项中 1163 通过、2 项按环境条件跳过、0 失败；
- package boundary audit：18 个 package、1060 个 source file、1042 个 nested source file，`singleSourcePackages=[]`、`shallowSourcePackages=[]`，非 ledger 密集目录为空；
- cluster dependency audit 与 Edge import audit 均为零 finding；Edge 实际加载 121 个 module，不含禁用的 Cluster/PostgreSQL/AWS SDK 边界；
- 14 种 Local Profile artifact 与 Local image static audit 全部 `compatible:true`；本切片未新增 package、migration、表、索引、timer、listener、watcher、常驻连接、cache 或 sidecar。

## 被否决的替代方案

1. **原地把终态 Run 改回 queued**：会改写历史、破坏 Event/Attempt 不变量，拒绝。
2. **允许对 lost 直接人工重跑**：无法证明旧执行已停止，可能复制外部副作用，拒绝。
3. **直接开放现有 Local HTTP bearer**：只有单因子认证，不满足恢复执行的强认证要求，拒绝。
4. **新增 `ql3-run-management` package**：只有一个短生命周期组合根，会继续制造薄包，拒绝。
5. **为限流新增表、timer 或内存 bucket**：增加 migration、空闲资源和重启绕过，既有 Run ledger 足以裁决，拒绝。
6. **强求 Local 与 Cluster 同批上线**：会把 PostgreSQL 多副本 quota、集群身份和 HA 证明混入本机切片，拒绝。

## 后续工作

- 为 Local HTTP 接入可信 MFA/hardware Principal，并保持本 ADR 的共享契约与强认证门；
- 实现 PostgreSQL/Cluster adapter、全局 quota、HA replay 与最小权限角色门；
- 在受审 UI 中提供失败原因、source/new Run linkage 与 retry 预览；
- 为 Workflow/StepRun 单独冻结 recovery 语义，不复用顶层 Run retry 入口。
