# ADR-0488：跨领域 Reconciliation 完成围栏与目标重启授权

- 状态：Accepted
- 日期：2026-08-22
- 决策：D-394
- 关联：ADR-0482、ADR-0485、ADR-0486、ADR-0487

## 背景

D-392 把 reconciliation 拆为固定八个领域，D-393 已实现首个 Automation plan、review、apply、verify 与 rollback。然而 instance lineage 在 Automation apply 后只停在 `reconciliation_automation_applied`，target start authority 又只接受早期 `legacy_stopped|target_active|manual_required`。系统因此同时存在两个缺口：

- 没有一个证据能证明八个领域都已终结，不能安全地把单领域 apply 当作整体完成；
- 即使八个领域都明确选择 no-effect，也没有合法状态可进入 target generation 2。

直接允许 `reconciliation_automation_applied` 重启是不安全的。真实迁移后的目标 SQLite 仍可能在 Secret/Config、Run History、Identity/Policy/Audit 或 Unknown 领域包含 `manual_external`；Automation 写入成功不等于这些领域已经被处理。另一方面，永久拒绝 all-no-effect 场景会让完成了人工 review、明确保留 Target/排除 Legacy 的部署无法继续。

## 决策

### 1. 完成是独立的跨领域状态，而不是某个 adapter 的别名

实例谱系新增唯一终态 `reconciliation_completed`。它只能从以下 source head 前进：

- `reconciliation_application_planned`：八个领域全部为 `no_effect`；
- `reconciliation_automation_applied`：只有 Automation 为 `adapter_required`、其余七个领域全部为 `no_effect`，且 Automation decision、apply receipt、当前 target snapshot 与 head 完整一致。

任何 `manual_external|adapter_and_manual`、非 Automation 的 `adapter_required`、Automation rolled-back 或证据漂移都失败关闭。当前完整迁移数据库通常仍包含多个受保护的 manual 领域，因此 Automation apply 不会被误判为 restart-ready；backup 继续保留，等待后续领域 adapter 或显式 rollback。

### 2. 调用方不能自报八领域完成

`local.deployment.reconciliation.complete` 只接收 completion/application/head digest，以及可选的 Automation apply digest/identity。coordinator 重新打开已封存的 application terminal，并严格按 D-392 固定顺序从 plan 推导八项 domain evidence：

- `no_effect` 绑定 application domain `summaryDigest`；
- Automation adapter 绑定真实 `applyDigest`。

receipt 固定包含八项、`adapterCount=0|1`、application plan、source head、实例 identity、generation、时间与自身 digest。调用方不能提交任意 domain 数组、路径、row body、Secret、reviewer 或 credential 作为完成声明。

### 3. Receipt-first、head-second、重资产最后回收

mutation 顺序固定为：

1. 重新验证 application、可选 Automation apply、当前 target snapshot 与 source head；
2. no-replace 发布 completion receipt，并封存为 `0400`；目录封为 `0500`；
3. CAS 前进到 `reconciliation_completed`；
4. 仅在 completed head 已 durable 后回收 Automation rollback backup，并把空 `backup/`、`rollback-work/` 封为 `0500`。

receipt publish、seal、head advance 或 backup collection 任一响应丢失都可由相同 exact command 重放。顺序禁止在 head 仍是 applied 时删除 backup；若在 head 完成后、回收前崩溃，重放只继续收紧存储，不恢复 rollback authority。

`local.deployment.reconciliation.complete.verify` 全程只读：验证 sealed receipt、八领域推导、application/Automation binding、当前 target snapshot、completed head 与已经收敛的存储形态，不修复漂移。

### 4. 直接 Target 重启只接受完成围栏

Docker target authority 继续拒绝 `reconciliation_application_planned`、`reconciliation_automation_applied` 和所有 manual/rolled-back 中间态；只有 `reconciliation_completed` 能重新进入 `target_active`，且调用方必须使用下一 generation。

Service Manager 虽然复用同一个 head assertion，但既有 v1 intent 只绑定 prior service journal `previousRecordDigest`，没有独立的 expected completion-head digest；其后续 compare-and-swap 因而继续拒绝 completed head。D-394 不通过忽略该比较来伪造兼容性。该后续边界现由 D-395/ADR-0489 的 v2 intent 完成：systemd/OpenRC 必须同时绑定 prior service record、exact completion head 与 completion digest 才能获得 restart-ready authority；v1 仍失败关闭。

### 5. 部署规模与代码边界

实现位于既有 `@qinglong/local-owner-cli` 的 `deployment/reconciliation/completion/` 子域，按 contract/evidence/coordinator 三个职责文件组织；没有新拆 workspace package，也没有把实现平铺到 `src/` 根。

- Edge/Standalone：无 daemon、timer、watcher、listener、Pool 或常驻缓存；receipt 上限 64 KiB、completion catalog 上限 64，SQLite snapshot/hash 复用固定内存实现；completed 后同步释放数据库等量 rollback backup。
- Cluster：本 ADR 只定义 Local SQLite authority。PostgreSQL/多副本必须使用独立的事务、snapshot 与 HA evidence，不能复用本机文件路径或把 Local receipt 当成 Cluster completion。

## 被拒绝的替代方案

### Automation applied 直接允许重启

拒绝。它会跳过其余七个领域，尤其会把 Secret custody、append-only history 和 Identity/Policy manual decision 静默吞掉。

### 调用方提交 `completedDomains[]`

拒绝。自由数组无法证明来源、顺序、摘要和 current head，容易把 stale 或伪造 claim 变成 restart authority。

### 先删除 backup 再写 completed head

拒绝。head CAS 失败会留下 applied 状态却失去 rollback source，形成不可恢复的部分提交。

### 为完成围栏新增独立 package/service/GC timer

拒绝。该职责没有独立部署和扩缩容边界；额外 package、进程或周期扫描只会增加路由设备的安装元数据、RSS、唤醒和竞态。

## 验收证据

- completion focused `2/2`：覆盖 all-no-effect 的 receipt/seal/head 三个 response-loss 窗口、只读 verify、CLI content-free、直接 target generation 2 状态转换；同时覆盖 Automation 已 apply 但其他领域仍 manual 时拒绝完成、拒绝 target restart，并保持 `0400/0500` backup authority。
- 完整 Local Owner `268 total / 261 pass / 7 conditional skip / 0 fail`；18-package clean build 与逐包测试 exit 0。
- dependency/package boundary 组合门 `70/70`，Edge import audit 为 122 modules、0 forbidden；workspace 保持 18 packages、无 single-source/shallow package；Local Owner 为 `172 source / 171 nested / 1 root binary entry`。
- 不新增 production dependency、SQL migration、daemon、timer、watcher、listener、Pool、PostgreSQL role/ACL 或 cluster workload。
- Secret/Config、Run History、Plugin Package、AI/Tool、Identity/Policy/Audit、Unknown 的 terminal adapter，以及固定真实 systemd/OpenRC completed restart 演练仍是后续工作；Service Manager v2 completion-head binding 已由 D-395/ADR-0489 完成，D-394 本身不倒填该结论。
