# ADR-0397：Cluster Secret Action 显式人工恢复

- 状态：Accepted（实现、真实 PostgreSQL 单节点门、完整 workspace/后端门、边界审计与 physical HA 门均完成）
- 日期：2026-08-14
- 关联 RFC：QL-RFC-0001 D-306B2
- 关联 ADR：ADR-0035、ADR-0359、ADR-0395、ADR-0396

## 问题

Secret Action controller 已能从终态 Kubernetes Job 与不可变 binding/transition receipt 自动恢复，也能在 Job Failed 且数据库无业务 mutation 时安全写入 failed。但 `approved_action_executions` 已进入 `executing`、Job 已不存在且 durable binding/receipt 也不存在时，系统无法证明外部效果从未发生。自动重建可能重复写 Secret；自动标记 succeeded 会伪造不存在的业务 receipt；长期保持 executing 又缺少可审计的产品处置入口。

通用 execution repository 同时服务 Worker Credential 等高影响调用链。为人工恢复放宽它的 UPDATE 权限或复用 package-executor，会扩大爆炸半径，也破坏 Approval manager 与执行器的职责分离。

## 决策

1. 只为 `plugin_package.secret_binding.bind` 与 `plugin_package.secret_binding.transition` 开放人工恢复。目标必须仍是 `executing`，原 lease 已过期，effective status 为 `recovery_required`；pending、live lease、已有可自动验证 receipt、其他 action type 和任何终态均拒绝。
2. 人工决议只有 `confirm_failed` 与 `abandon_unknown`。前者表示外部证据已证明没有业务效果，execution 进入 `failed`；后者表示结果仍不可判定但操作者决定停止自动恢复，execution 进入 `blocked`。入口永远不能写 `succeeded`，因为人类陈述不能替代 immutable binding/transition receipt。
3. 调用者必须提交 exact execution version、execution digest、唯一 mutation ID、稳定低敏 reason code 和外部证据 SHA-256。服务端重新读取 dispatch/execution 并绑定 action、dispatch、Project 与原 execution digest；相同事实 exact replay 返回 `existing`，任一字段漂移冲突。
4. 复用 Cluster Approval management 的 mTLS/OIDC endpoint、短生命周期 client 与双重认证确认。只接受五分钟内的 `multi_factor|hardware` User，并独立请求 `approval.recover`；不复用 `approval.decide`、package.manage、ServiceAccount、Agent 或 System authority。
5. PostgreSQL `pg-0065`/control capability v64 新增不可变 resolution ledger 和单个 `SECURITY DEFINER resolve_approved_action_manual_recovery(jsonb,jsonb,jsonb)`。函数在同一事务内锁定当前 Policy fence 与 exact executing row，插入 allowed security audit、推进 execution 终态并插入 resolution。任一步失败全部回滚。
6. `ql3_approval_manager` 只新增 dispatch/execution/resolution 的 SELECT 与该函数的 EXECUTE；不取得 execution UPDATE，也不取得 resolution INSERT/UPDATE/DELETE。通用 `PostgresApprovedActionExecutionRepository` 保持不变，人工路径使用独立 repository，避免影响 Worker Credential execution flow。
7. 返回只包含低敏 action binding、execution 状态/版本/摘要/时间和 resolution receipt。lease owner/token、authentication ID、assurance、认证时间与 Policy 内部原因不进入响应。
8. 能力只属于 Cluster profile，复用现有 Approval manager Pool、Pod、listener 和 client。Edge/Standalone 不加载 PostgreSQL migration、repository 或新协议；不新增 workspace package、第三方依赖、daemon、timer、watcher、连接池或 Kubernetes workload。

## 接受条件

- Runtime Core 覆盖授权 inspect、两种终态、live lease/unsupported action/weak User/权限拒绝、围栏漂移和 exact replay。
- transport/client 覆盖 exact command/result、二次认证、终态 version fence，并证明 lease 与认证事实不泄露。
- PostgreSQL migration/readiness 明确证明 Approval manager 没有 execution UPDATE，只能执行受限函数。
- 真实 PostgreSQL 从空库执行全部 migration，证明 resolution、execution 与 audit 原子提交，响应重放不重复审计，直接 UPDATE 返回 `42501`。
- 完整 workspace build/test、package/dependency/edge/deployment 审计与 PostgreSQL physical HA 门通过后，ADR 才能转为 Accepted。

## 影响与替代方案

- 每次人工处置增加一行有界 resolution 和一行既有 security audit；正常执行路径没有额外查询、常驻内存或 cadence。
- evidence digest 只证明操作者审查的外部材料，不把材料本身写入 QingLong；证据保存、访问控制与 retention 由部署者负责。
- 不提供“重置为 pending”“重新创建 Job”或“人工确认 succeeded”。这些方案都可能复制或伪造外部副作用，拒绝。
- 不给 Approval manager 通用 UPDATE。即使应用层能够校验，数据库 credential 仍是独立 authority boundary，必须由函数约束精确转换。

## 当前验证

- Runtime Core、Cluster PostgreSQL 与 Cluster Admin 包级测试已通过；新增领域、repository、transport/client 与 migration/readiness 测试均进入默认 test 集合。18 个 QL3 package clean build/test 退出 0；后端全门 1,194 pass、2 条件 skip、0 fail。
- PostgreSQL 18.4 单节点真实门从空库完成 65 个 migration，验证 `resolved → existing`、resolution/audit 各一条，以及 Approval manager 直接 UPDATE 被 `42501` 拒绝。该门同时发现并修复 `audit_event_id` 外键与 JSON-to-UUID 写入的真实类型错误。
- package boundary、cluster dependency、edge import 与 cluster deployment 四项审计全部 compatible 且零 finding；workspace 保持 18 package、无 single-source/shallow-source package。`pg-0065` 与 recovery repository 按 `approved-action` 领域内聚，既有有序 migration ledger 直属源码仍保持审定上限 65，没有以放宽阈值掩盖目录增长。
- PostgreSQL 18.4 arm64 physical HA 125 项 gate 全绿，timeline `1→2`，报告 SHA-256 为 `6d4921cba74475d15722a13c6a8034793c0ee25681bc7dcaf91024927c5752fe`；临时 Docker 资源已清理。因此本 ADR 转为 Accepted。
