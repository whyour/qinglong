# ADR-0493：目标原生 Reconciliation 域分类与身份保留

- 状态：Accepted
- 日期：2026-08-24
- 决策：D-398
- 关联：ADR-0483、ADR-0484、ADR-0485、ADR-0488、ADR-0492

## 背景

Reconciliation 必须同时处理两类不同事实：从 2.x 迁入的数据，以及已经属于 QingLong 3.0 目标库的原生数据。此前实现把 `identity_policy_audit` 整域无条件标为 `manual_required/identity_custody_required`，因此即使 Legacy 完全没有 `Auths/Users`，fresh v52 目标库自带的 Project、RoleBinding、Credential、Pepper、SecurityAudit 与 LocalOwner 表也会阻止全局 completion。

同一盘点还发现 fresh v52 的六张已知表没有进入稳定领域，被误归为 `unknown`：

- Automation：`QingLong3LegacyAdoptions`、`QingLong3LegacyAdoptionTasks`、`QingLong3LocalExecutionContextRecipes`、`QingLong3LocalTaskExecutionRevisions`；
- Run History：`QingLong3RunAttemptLogArtifactTombstones`、`QingLong3RunAttemptLogRetentionState`。

这不是缺少新 adapter，而是现有 planner 对目标原生 schema 的知识不完整。为绕过门禁而伪造 completion receipt 或把整个 `QingLong3*` 前缀视为可信都会破坏 fail-closed 边界。

## 决策

### 1. 已知目标表使用精确领域目录

上述六张表按精确表名分别归入 Automation 与 Run History。Schema object 继续按其 `tableName` 继承同一领域，因此相关 index/trigger 不需要单独的宽泛名称规则。

不引入 `QingLong3*`、`LegacyAdoption*` 或 `Local*` 的整体通配。未来新增但尚未登记的目标表仍进入 `unknown`，不读取行数，并要求人工外部处理。

### 2. 目标原生身份是保留事实，不是迁移事实

`identity_policy_audit` 的 disposition 改为按来源判定：

- Legacy 存在 `Auths/Users` 时继续 `manual_required`；
- Legacy 没有身份事实、Target 有已知身份事实时为 `target_only`；
- 两端都没有时为 `aligned`。

Target 身份诊断是 `required/reviewable_fact`，必须在 signed review 中逐事实选择 `retain_target` 才能形成 `no_effect` application action。它不能选择 `adopt_legacy` 或 `exclude_legacy`。Legacy 身份诊断仍是 `blocked/identity_custody_required`，只允许 `defer|manual_external`，本 ADR 不声明 2.x credential、session、password hash、token、Policy 或 Audit 已迁移。

### 3. Completion 只消费既有闭合证据

本 ADR 不增加 completion schema、adapter、instance state 或绕过规则。目标原生身份经过 canonical diagnostics、signed decision 和 application summary 后，以既有 `no_effect/application_summary` 进入 completion；真正未知表和任何 Legacy 身份事实仍阻止 completion。

完整 v52 + Legacy Secret/Config fixture 必须通过真实 v3 completion，而不是测试直接构造 receipt、推进 head 或调用 storage collector。只有 completed head durable 后，Secret/Config backup 才能由既有流程回收。

### 4. 部署与资源边界不变

实现只修改既有 Local Owner 一次性 reconciliation planner/reviewer，没有新增 workspace package、production dependency、SQL migration、daemon、listener、timer、Pool、容器或 Kubernetes workload。Edge/Standalone 常驻闭包、SQLite cache 上限和 artifact 预算不变；Cluster 仍使用自己的 PostgreSQL、Secret provider 与 HA authority。

## 被拒绝的替代方案

### 为目标原生身份增加 migration adapter

拒绝。没有 Legacy 身份输入时不存在要迁移的数据；额外 adapter 只会复制已经由目标数据库拥有的事实并扩大权限面。

### 信任全部 QingLong3 前缀

拒绝。名称前缀不是 schema ownership 证明，会让未来未知表自动越过人工审查。

### 自动跳过目标身份评审

拒绝。`target_only` 仍必须形成逐事实 signed `retain_target` 决策，不能仅凭分类器直接授权 completion。

### 放行 Legacy Auths/Users

拒绝。旧身份材料的 custody、hash/token 兼容、撤销、Policy 与 Audit 语义尚未建立独立 adapter；本 ADR 只消除目标原生数据被误当成迁移输入的问题。

## 验证

- 定向回归 `4/4`：fresh v52 `unknown=0`、目标身份 `retain_target`、Legacy 身份继续 blocked、真正未知表继续 row-free/manual；
- Secret/Config completion v3 使用真实 `complete → replay → verify` 链路，首调 `completed`、重放 `existing`，receipt 为 v3 且 Identity/Unknown 均为 `no_effect`；
- completed head durable 后 Secret/Config backup 被回收，加密 material 与 receipt 保持只读；
- Local Owner 受限沙箱为 `301 total / 291 pass / 7 conditional skip / 3 loopback EPERM`，两个 loopback 文件在沙箱外 `15/15`，有效结果 `301/294/7/0`；
- 完整 backend 为 `1567 total / 1565 pass / 2 conditional skip / 0 fail`；18-package clean build 与逐包顺序测试除 Worker 三条 sandbox loopback 外全部通过，对应 Worker 文件在沙箱外 `8/8`；
- package boundary、精确 Cluster dependency、122-module Edge import、service-manager bridge import、本地镜像与 `14/14` Local artifact audit 全部 compatible；workspace 保持 18 packages，`singleSourcePackages=[]`、`shallowSourcePackages=[]`；
- 基础 Edge/Standalone 保持 `2,635,529 / 2,635,607 bytes`、323 files、58 loaded modules，没有 Cluster/PostgreSQL 闭包。
