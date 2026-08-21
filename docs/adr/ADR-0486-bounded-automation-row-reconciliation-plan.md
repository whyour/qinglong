# ADR-0486：有界 Automation 行级 Reconciliation Plan

- 状态：Accepted
- 日期：2026-08-21
- 决策：D-393
- 关联：ADR-0002、ADR-0482、ADR-0483、ADR-0484、ADR-0485

## 背景

ADR-0485 只把 signed schema/table review 汇总为八领域 application plan。`automation=adapter_required` 说明必须进入领域 adapter，却不能证明任一 Legacy `Crontabs` 行能够安全写为 3.0 `TaskDefinition/Trigger`。直接把表级 `adopt_legacy` 解释为批量 INSERT 会遗漏：

- command/schedule/timezone 与 shell compatibility；
- Project 重绑定后的 Task ID 冲突；
- target current revision 的稳定内容身份；
- malformed、manual-only 与 security-review 行；
- Edge 上逐行材料的内存和文件预算；
- review file、sealed bundle 与 application head 的 exact binding。

既有 Legacy Crontab adoption 已实现有界分类与 canonical Task/Trigger candidate。D-393 应复用该语义，而不是建立第二套转换器；但首次 adoption 尚不知道 D-392 application、captured target 冲突和后续 backup/rollback，因此不能直接调用其 publication。复用只允许通过 `@qinglong/local-admin/adoption-inspection` 的窄化只读子路径，包根继续隐藏 candidate；依赖审计只对 D-393 `rowPlan.ts` 精确放行该子路径，不能借此取得 Local Admin 的其它写 authority。

## 决策

### 1. 先发布逐行计划，不取得 DML authority

Local Owner 在既有 `deployment/reconciliation/application/automation/` 下提供：

- `local.deployment.reconciliation.automation.plan`；
- `local.deployment.reconciliation.automation.verify`。

plan 只允许 exact `reconciliation_application_planned` head。它重新验证 application terminal、signed review 所绑定的原始 decision file、canonical sealed facts，以及 Legacy `Crontabs` table 的 `adopt_legacy|retain_both` 方向授权。没有 Automation adapter action、decision file digest/count 漂移、hot journal 或 unpaired sidecar 都失败关闭。

### 2. 逐行 NDJSON 为私有、内容最小化证据

每行重新使用既有 Legacy Crontab classifier，并记录：

- row ordinal、source digest、classification/reasons；
- proposed Task ID、enabled、trigger count；
- Task/Trigger candidate digest，而不是 command/spec 正文；
- target 当前 Task 的 `absent`，或 current revision/content digest；
- `review_adopt | review_skip_conflict | manual_required` requirement；
- domain-separated row plan digest。

文件不保存 command、Task name、reviewer、credential、Secret、路径或 target row body。header 绑定 application/review/decision/bundle/head/Project/timezone，footer 绑定 inventory、row-set、计数和 outcome。外部 receipt 再绑定完整 plan file SHA-256 和字节数。

### 3. 冲突矩阵

| Legacy candidate | Target Task ID | 计划 requirement | 本阶段含义 |
|---|---|---|---|
| 可转换 | absent | `review_adopt` | 可进入后续签名行级裁决 |
| 可转换 | occupied | `review_skip_conflict` | 不覆盖 target；后续必须显式 skip/rename/manual |
| 不可转换 | 任意 | `manual_required` | 不获得自动写入资格 |

表级 `retain_both` 不能自动改名，表级 `adopt_legacy` 也不能覆盖已存在 Task。后续 apply 必须消费 exact row plan digest 和独立签名裁决。

### 4. Edge/Standalone 预算

- plan 按 NDJSON 流式写入，单行最多 64 KiB；
- Edge 文件最多 8 MiB，Standalone 最多 32 MiB；
- Legacy 与 target 各只打开一个 readonly SQLite handle；
- Edge 每 handle cache 2 MiB，总 SQLite cache 约 4 MiB；Standalone 每 handle 8 MiB；
- 不把全量 Task ID 或 candidate 放入内存 Set/JSON array；
- 不新增 package、依赖、binary、daemon、timer 或 listener。

超出 byte/row/schema budget 时失败关闭，不以截断计划换取成功。

### 5. Crash、replay 与 seal

plan 使用 owner-only stage、fsync、hard-link no-replace publication。plan、receipt、terminal seal 与 instance-head CAS 四个窗口都允许 exact replay：

- 已发布 plan 会用重新派生的 exact bytes/digest 验证；
- 已发布 receipt 会验证 plan size/hash 和 command binding；
- terminal 文件为 `0400`、目录为 `0500`；
- head 只允许 `reconciliation_application_planned → reconciliation_automation_planned`；
- verify 只读，不打开 live target、不执行 DML、不修复 drift。

### 6. 尚未授予的能力

`reconciliation_automation_planned` 不等于 applied、rollback-ready 或 reconciliation-complete。它不允许启动 target、删除 Legacy、写 Task/Trigger、创建 Secret、复制日志或解释其它领域。

下一切片仍必须完成：

1. exact row-plan-bound 的独立签名行级裁决与再次强认证；
2. 在同一 target write fence 内生成并验证写前 SQLite backup；
3. Project Policy fence、幂等 Task/Trigger transaction 与 response-loss replay；
4. post-apply exact evidence、无后续写保护和全库 rollback；
5. Edge 磁盘峰值及 Cluster/PostgreSQL 的独立并发/HA 语义。

## 被拒绝的替代方案

### 直接调用首次 Legacy adoption

拒绝。它没有 D-392 application binding，也没有 captured target collision snapshot 与 rollback authority。

### 把 target Task ID 全量载入 Set

拒绝。内存随 target 规模增长，低配路由设备的峰值不可控。当前实现以有界双 readonly handle 对每个 candidate 做索引查询。

### 在行计划保存 command/spec

拒绝。人工裁决只需要 classification、reason、digest 与冲突证据；command 正文扩大泄露面和计划文件预算。apply 必须从 exact sealed source 重新派生 candidate。

### 自动为冲突 Task 改名

拒绝。改名会改变外部引用、Trigger ID 和用户可见 identity，必须成为明确行级决定，不能由表级 `retain_both` 推导。

## 验收条件

ADR 只有在以下证据全部通过后才可改为 Accepted：

1. exact signed review 与 Crontabs table disposition 被重新验证；
2. 无冲突、冲突、manual/malformed、空表、timezone 与 byte budget 有测试；
3. plan/receipt/seal/head response-loss exact replay 与篡改拒绝有测试；
4. 新状态对既有 capture/plan/review/application/cutover 状态机无回归；
5. Local Owner、tracked backend、18-package、架构与 artifact gates 通过；
6. GitNexus `detect_changes` 仅报告预期 Automation/Cutover 影响。

## 验收证据（2026-08-21）

- Automation 聚焦套件 `40 total / 38 pass / 2 conditional Docker skip / 0 fail`，覆盖无冲突、target collision、空表 `no_effect`、缺失 timezone 转 manual、64 KiB 注入预算失败、四个 publication response-loss 窗口、plan tamper 与 CLI 脱敏；真实 Docker sealed reconciliation `2/2` 通过。
- 完整 Local Owner `262 total / 255 pass / 7 conditional skip / 0 fail`；18-package clean build/逐包测试退出 0；backend build 通过，tracked backend `1541 total / 1539 pass / 2 conditional skip / 0 fail`。
- Edge import、Cluster dependency、package boundary、service-manager bridge、deployment lock surface 与 fresh readiness 定向门全部通过；workspace 保持 18 packages，`singleSourcePackages=[]`、`shallowSourcePackages=[]`。Local Admin 为 `46 source / 45 nested / 1 root public export`，Local Owner 为 `161 source / 160 nested / 1 root binary entry`，新增实现均在既有领域目录。
- 十四档 Edge/Standalone artifact audit 全部 compatible。基础 Edge/Standalone 精确保持 `2,611,978 / 2,612,056 bytes`、319 files、58 modules；D-393 一次性 authority 没有进入低配常驻闭包。
- GitNexus staged audit 为 `15 files / 56 symbols / 0 affected execution flows / LOW`；`next` 相对 `develop` 的 `3464 files / 48714 symbols / 269 flows / CRITICAL` 是 3.0 孵化分支累计风险，继续单独保留，不能归因于本切片。
- 本切片不修改 SQL migration、PostgreSQL role/ACL、Pool、Cluster 拓扑或 HA 运维语义，因此不重复占有 PostgreSQL HA 证明；写前 backup/apply/rollback 切片引入 SQL 写语义时必须重新选择相应数据库门禁。
