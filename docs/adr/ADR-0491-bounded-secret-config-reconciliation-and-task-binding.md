# ADR-0491：有界 Secret/Config Reconciliation 与任务环境绑定

- 状态：Proposed（D-397 已实现 Legacy Env inspection、私有有界 row plan、durable plan publication、独立 signed decision、逐项 Automation adoption provenance、Local SQLite 原子 application publisher、Owner prepared/apply/rollback 编排、ADR-0492 completion v3；ADR-0494 完成 Cluster mounted-files provider live 子门，ADR-0495 完成 content-free Cluster plan ledger，ADR-0496 完成 opaque environment bundle 数据面，ADR-0497 完成 Cluster Task/Trigger 原子 mutation 与 receipt；真实 Edge 空间证据、promotion 后 receipt replay 与直接外部 custody gate 尚未完成）
- 日期：2026-08-23
- 决策：D-397
- 关联：ADR-0073、ADR-0074、ADR-0092、ADR-0094、ADR-0480、ADR-0482、ADR-0483、ADR-0484、ADR-0485、ADR-0486、ADR-0487、ADR-0488、ADR-0490

## 背景

QingLong 2.x 的 `Envs` 不是简单的 `name → value` 字典。运行时只使用 `status=normal` 的行，先按 `isPinned DESC、position DESC、createdAt ASC` 排序，再把同名行的值用 `&` 连接后注入所有 Legacy Task。停用行仍属于用户数据，但不应被激活。直接把每一行转换成一个 3.0 Secret 会改变同名变量语义；只把数据加密保存而不更新 TaskDefinition，又会让迁移在形式上完成、实际任务却失去环境变量。

3.0 已具有项目内版本化 SecretRef、TaskDefinition `command@v1` 的 secret environment binding、本地按引用解密注入和 Cluster remote Secret delivery。D-397 应复用这些边界，不能恢复 2.x 的全局明文 `export` 文件，也不能让 Secret 值进入 plan、review、receipt、日志、命令文件或 stdout。

此外，D-385～D-388 已处理数据目录中的 `config.sh`、Keyv 与 SSH material，但没有处理 Legacy SQLite 的 `Envs`。二者是不同 source lineage，不能因为目标端已经存在 Data Directory Adoption Secret 就把数据库 Env 判定为已迁移。当前 2.x 生产代码也没有稳定的 SQLite `Configs` 模型；捕获中出现的历史 `Configs` 表必须按未知 schema 失败关闭，不能套用 `Envs` 规则。

## 决策

### 1. 固定执行顺序与领域授权

Local reconciliation 顺序固定为：

```text
application plan
  → Automation plan / review / apply（若需要）
  → Secret/Config plan / review / apply（若需要）
  → Run History preservation（若需要，绑定最新 head）
  → cross-domain completion
```

Secret/Config 不消费 Automation decision 作为自身授权。D-391 把 `secret_and_config` facts 标为 `blocked`，其 review action 只能是 `manual_external|defer`；D-397 专用 adapter 只接收每条 fact 都精确选择 `manual_external` 的决策流，把它重新绑定到同一 sealed bundle、D-392 application plan 与当前 target snapshot，任何 `defer` 都继续失败关闭。D-397 使用独立的逐候选 signed decision：只有 `plan.outcome=ready`、候选非空且没有 manual/conflict 才能 prepare；后续 application 必须消费该终态授权。强认证 User、Project Policy、Secret custody 与 Task mutation authority 都要在写事务前及事务内重新验证。

存在 active Env 时，Automation 必须已经完成，且至少一个同时经 `QingLong3LegacyAdoptions` 聚合账本和逐项 provenance 证明的 Legacy Task 可绑定；否则不得用“Secret 已保存”冒充行为迁移。只有停用 Env 的场景可以在 Automation `no_effect` 后做纯保全。

聚合计数不能作为 Task/Trigger 写权限。Local v51 增加 `QingLong3LegacyAdoptionTasks` 与 `QingLong3LegacyAdoptionTriggers`，由 Automation publisher 在原 `BEGIN IMMEDIATE` 中逐项写入 adoption mutation、source digest、Task/Trigger identity、revision、mutation、content digest、ordinal 与 item digest。Task provenance 精确引用 revision 1；Trigger provenance 同时引用 Task provenance、Trigger revision 1 与原 adoption。父 adoption 外键延迟到事务提交检查，使 Edge/Standalone 可以流式发布最多 100,000 个 Task 与 500,000 个 Trigger，无需在内存保留全集。旧 pre-release 数据若只有聚合 ledger 而没有逐项 provenance，只能判定 `missing → manual_required`，不得按 `legacy-cron:*` 扫描、猜测或回填所有权。

### 2. Legacy Env 的确定性语义

`Envs` inspection 要求 `id/name/value`，并兼容缺省的 `status/isPinned/position/createdAt`。合法环境变量名必须符合 shell 与 3.0 `command@v1` 的共同子集，且不得使用 `QL3_` 保留前缀。

active 行按以下顺序处理：

```text
COALESCE(isPinned, 0) DESC,
position DESC,
createdAt ASC,
id ASC
```

同名行按该顺序用单个 `&` 连接，形成一个 effective value；它只产生一个 active Secret 和一个 Task environment binding。停用行不参与连接，每行形成一个 disabled-preservation candidate，后续可由 Owner 显式恢复或重建，但不会绑定到任务。

诊断只保存 row ordinal、source digest、disposition 与 reason。inventory 只保存计数、状态与 digest。变量名、值、remarks、labels、原始排序字段和 row body 均不得进入公开 evidence。candidate 只能通过 Local Admin 的精确私有子路径流式交给短生命周期 planner/publisher。

以下情况必须 `manual_required`：非法/保留名称、非文本或含 NUL 的值、异常 status/ordering metadata、同组 effective value 超过 16 KiB、全部 active effective values 超过 64 KiB、active binding 超过 256、停用保全数量超预算、必要列缺失或 source 漂移。不能丢弃异常行后对剩余行做“部分成功”绑定。

### 3. Edge 与 Standalone 预算

当前 inspection 与 row-plan 切片固定：

| 预算 | Edge | Standalone |
| --- | ---: | ---: |
| Legacy Env 行数 | 10,000 | 100,000 |
| disabled preservation candidates | 128 | 512 |
| active bindings | 256 | 256 |
| 单个 effective value | 16 KiB | 16 KiB |
| 全部 active effective values | 64 KiB | 64 KiB |

实现逐行读取，不把整张 `Envs` 或全部停用值加载到内存；active value 的在途内存由 64 KiB 合同封顶，停用值通过第二次有界扫描逐个交付。它位于既有 `@qinglong/local-admin/src/legacy-adoption/secret-and-config/`，不新增 workspace package、production dependency、daemon、timer、watcher、listener、socket、数据库连接池或 `src` 根平铺文件。

Local Owner 使用私有 NDJSON row plan 记录 header、逐行 content-free disposition、逐 candidate 目标冲突投影与 footer。Edge/Standalone plan 文件分别限制为 8 MiB/32 MiB，单行不超过 64 KiB；超过预算立即失败关闭。公开 plan/receipt 不保存原 Env name/value、目标 ciphertext、key ID 或原始 row body。active 与 disabled candidate 分别使用 `legacy-db-env-*` 和 `legacy-db-env-disabled-*` 命名空间；目标已经存在时只记录 envelope 元数据的组合摘要并进入 `review_skip_conflict`，不得读取明文、覆盖或自动改名。plan 绑定 application、D-391 review authorization、sealed bundle、target projection、Automation adoption ledger 及逐项 provenance 的有界 content-free 投影与 prepared head，并产生可重新计算的 row-set、candidate-set、adoption-set、plan-file 和 receipt digest。planner 流式复算每个 provenance item digest，并要求当前 Task/Trigger head 仍精确指向记录的 revision、mutation 与 content digest，Trigger schedule 仍精确指向记录的 Trigger revision，且 Task 不属于 Plugin Package。计数缺项形成 `missing`，当前对象、schedule 或 ownership 漂移形成 `drifted`；两者都只能 `manual_required`。投影只在内存保留最多 128/512 条 adoption 聚合记录，不按目标 Task/Trigger 总量建立 Set。

durable publisher 固定写入 `<secretConfigRoot>/<secretConfigId>/{plan.ndjson,receipt.json,staging/}`，使用 no-replace publication、`0400/0500` 权限、文件与目录 `fsync`，并覆盖 plan、receipt、terminal seal、head CAS 四个 response-loss 窗口。只有 Automation 无需 adapter 时的 `reconciliation_application_planned`，或 Automation 已完成时的 `reconciliation_automation_applied`，可以单向推进到 `reconciliation_secret_config_planned`；verify 只读复算 plan/receipt/seal/head 绑定，不修复漂移。active Env 若没有至少一条已采纳 Legacy Task ledger 记录仍为 manual；历史 `Configs` 计入 `unadaptedLegacyConfigCount` 并保持 manual。

独立决策使用私有 NDJSON decision file，每个候选必须按 ordinal/digest 精确选择 `apply_active_binding/reviewed_active_binding`、`preserve_disabled/reviewed_disabled_preservation` 或 `skip/operator_excluded|target_conflict|security_review_required`。任何 `skip` 都把终态 outcome 降为 `manual_required`，不能被 application 当成部分成功；`no_effect` 不需要决策，manual/conflict plan 也不能通过强认证升级。签名授权使用与 D-391 review 相同的强认证 User，认证年龄最多 5 分钟、授权生命期最多 30 分钟，并以独立 HMAC domain 绑定 decision、Secret/Config plan、candidate set、application、preparation、prepared head、sealed bundle、reviewer 与时间。Edge/Standalone decision/authorization 文件分别限制为 1 MiB/4 MiB，沿用 owner-only `0700/0600`、sealed `0500/0400`、no-replace 与 `fsync`。lineage 单向推进 `reconciliation_secret_config_planned → reconciliation_secret_config_decision_prepared → reconciliation_secret_config_reviewed`；prepare/commit 的全部 publication response-loss 窗口都精确重放且不重复认证，terminal verify 只读复算 sealed decision、authorization、receipt 与当前 reviewed head。

### 4. 原子 application 同时完成 custody 与行为绑定

D-397 application 已在一个 `BEGIN IMMEDIATE` 事务内完成：

1. 复验 Project/RoleBinding fence、signed decision、sealed source、target snapshot 与当前 instance head；
2. 为每个 active effective Env 写入加密 Local Secret envelope、content-free `secret.create` audit 与 adoption item；
3. 为每个 disabled candidate 写入加密但未绑定的 Secret，并记录 disabled preservation disposition；
4. 为每个经 Automation adoption ledger 证明的 Legacy Task 追加 TaskDefinition revision，把 active Env 绑定为 `kind=secret` 的 environment；
5. 为指向旧 Task revision 的 Legacy Trigger 追加 Trigger revision，并更新 local schedule/dispatch revision；
6. 写入不可变 Secret/Config reconciliation receipt ledger 后一次提交。

任一 Secret、Task、Trigger、dispatch、audit、ledger 或 fence 冲突都回滚整个事务。禁止先提交 Secret 再逐任务修补，也禁止在现有 Task revision 上原地改 JSON。目标已有同名/同源 Secret、非 Legacy Task、Plugin-owned Task 或用户在 stopped window 中产生的 revision 都按冲突处理，不自动覆盖或重命名。

Owner 编排保留在既有 `local-owner-cli/deployment/reconciliation/application/secret-and-config/application/` 子域，不新增 package、常驻进程或依赖。它只把密文写入私有 `materials.ndjson`，单行不超过 64 KiB，Edge/Standalone 文件分别不超过 4/16 MiB；POSIX keyring、Owner Pepper 与 credential material 必须位于私有 deployment root 内，且与 apply authority root、target database 相互隔离。编排在推进 head 前重新证明 stopped state、同一 reviewer 的 `local_console` 强认证与最多 5 分钟认证年龄，并先创建、校验 write-before SQLite v52 backup。空间不足、权限错误或 backup 漂移均发生在 prepared head 与任何 DML 之前，不得在低配设备上边写边赌。

lineage 单向推进 `reconciliation_secret_config_reviewed → reconciliation_secret_config_apply_prepared → reconciliation_secret_config_applied`；回滚只允许从 applied 精确恢复写前 SQLite snapshot，再推进到 `reconciliation_secret_config_rolled_back`。material、backup、prepared head、数据库 commit、receipt、applied head、seal，以及 restore、rollback receipt/head/seal 的每个 response-loss 窗口都通过 immutable digest 与 durable target state 精确重放：intent 之前的孤儿密文会丢弃并重新生成，intent 之后只复用同一 ciphertext；数据库 commit 丢失响应时由 v52 publisher receipt 复验，不重复 DML。回滚保持原 SQLite 文件 identity 证明，任何 receipt/head/seal 漂移都失败关闭。

无 DML 的 Run History preservation 继续只绑定最新 head。跨领域 completion 后才可回收 Automation 与 Secret/Config 两份 rollback material。

### 5. preserve、destroy 与 completion

D-397 application 的成功终态只声明：

- active Env 已加密并绑定到全部已采纳 Legacy Task；
- disabled Env 已加密保全且保持未激活；
- sealed source database 与 rollback backup 仍然存在；
- `physicalErasureGuaranteed=false`。

它不删除 Legacy SQLite、capture bundle、Data Directory Adoption Secret 或外部备份。明文销毁必须是目标 restart/readiness、观察窗口和 rollback 保留策略之后的独立强认证 ceremony，并明确列出可删除对象；闪存、CoW 文件系统与备份介质不能声称物理擦除保证。

Completion 需要演进为兼容旧 receipt 的下一 schema：`secret_and_config + adapter_required` 必须携带 exact Secret/Config application evidence；active Env 的 custody-only receipt 不合法。`adapterCount` 由实际 Automation、Secret/Config、Run History 三类证明推导，调用方不能自报。任何未知 `Configs`、manual Env、未绑定 Task、stale run-history proof、rolled-back state 或 target drift 都继续拒绝 `reconciliation_completed`。

### 6. `Configs` 与 D-385～D-388 的边界

- 数据目录 `config.sh`、Keyv、SSH 继续由 ADR-0477～ADR-0481 的 lineage 管理，默认 activation 仍为 disabled；
- SQLite `Envs` 由本 ADR 管理，active effective value 必须绑定 Task 才能终态；
- SQLite `Configs` 在没有版本化 schema transformer 前只能保留在 sealed bundle 并进入 manual，不自动解析字段或猜测文件路径；
- 两条 lineage 可以在 target Secret store 共存，但发布器必须检查 Secret name/source digest 冲突，不能重复接管同一 material。

### 7. Cluster 是独立实现

Cluster migration 不复用 Local SQLite handle、POSIX keyring、instance head 或本机 backup。它需要独立的 PostgreSQL SERIALIZABLE ledger、外部 KMS/Secret provider custody、exact Project/Task revision fence、Trigger revision 与 remote delivery authority，以及 HA promotion 后仍可验证的 receipt。

Cluster 不得把 Legacy Env 明文写入 PostgreSQL、ConfigMap、Job command、Pod environment 或迁移日志。一次性 migration Job 应使用精确投影、短期身份、零 watcher/controller，并在事务提交前后绑定 PostgreSQL timeline/role readiness。Edge 不安装或加载这些 Cluster 依赖；Cluster 也不能把本机 10,000 行预算冒充集群容量证明。

## 被拒绝的替代方案

### 恢复全局 `export` 文件

拒绝。它重新引入明文落盘、所有 Task 隐式继承、无法审计的动态作用域和本地/Cluster 行为分叉。

### 每个 Legacy Env 行直接创建一个 active Secret

拒绝。同名行在 2.x 中按顺序用 `&` 合并；逐行绑定既无法表达该语义，也会产生重复 environment name。

### 只做 Secret custody，不更新任务

拒绝。数据存在不等于任务行为已迁移；active Env 未绑定时 completion 必须失败。

### 在 Automation apply 中顺便导入 Env

拒绝。Automation decision 没有 Secret custody authority，也没有逐 Env 决策；把两个领域塞入同一签名会扩大权限并破坏独立 rollback/evidence。

### 自动猜测 `Configs` 表结构

拒绝。历史版本和第三方 fork 可能有同名异义表；字段猜测会把未知数据变成错误配置或 Secret。

## 当前验证与后续门禁

D-397 当前八切片已经实现：absent、unsupported、Edge over-budget、2.x 顺序、同名连接、disabled preservation、保留前缀、异常状态、effective overflow、candidate digest、content-free diagnostics、私有有界 row plan、目标 Secret 冲突、Automation adoption projection、no-effect/manual outcome、durable no-replace publication、terminal seal、head CAS、逐候选独立 signed decision、同一强认证 reviewer、decision/authorization byte bound、`skip → manual_required`、prepare/commit response-loss exact replay、只读 terminal verify、v51 逐 Task/Trigger adoption provenance、v52 Local SQLite 原子 application publisher、Owner prepared/apply/rollback orchestration，以及 ADR-0492 completion v3。v52 在一个 `BEGIN IMMEDIATE` 内复验 Project/RoleBinding、外部 authority、逐 Task/Trigger provenance、当前 head、Plugin ownership 与 Trigger 数量，流式写入加密 Secret、content-free audit、Task rev2、dispatch、Trigger rev2、schedule 和四类 application ledger；deferred parent FK 允许最多 100,000 Task/500,000 Trigger 逐项发布而不在 JS 堆保留全集。Owner 在写前固定 backup 与 stopped proof，以有界 ciphertext-only material 连接 reviewed decision 和 publisher，并覆盖 apply/rollback 全部 response-loss 窗口。completion v3 保留 v1/v2 exact shape，验证 signed decision/apply/current target/head，只有 completed head durable 后才幂等回收 Secret/Config backup；rolled-back、target drift 与其余 manual 域继续失败关闭。commit response-loss 通过 durable receipt exact replay，并重新验证 Secret envelope、Task/Trigger head 与 schedule；目标占用、provenance 缺项、提交前 authority 漂移均回滚全部 DML，rollback 则恢复写前 snapshot。

本切片当前验证：Local SQLite `247/247`，其中 Secret/Config application publisher 定向回归 `6/6`；fresh Edge readiness 为 contract v52、104 migrations、89 required tables、SQLite 3.53.3、`DELETE` journal。Local Admin 为 `96/96`；ADR-0493 后 Local Owner 有效结果为 `301 total / 294 pass / 7 conditional skip / 0 fail`。完整 backend 为 `1567 total / 1565 pass / 2 conditional skip / 0 fail`。package boundary、精确 Cluster dependency/legacy boundary、122-module Edge import、service-manager bridge import、本地镜像与 `14/14` Local artifact audit 全部 compatible；Local Admin 为 49 source / 48 nested / 1 root export，Local Owner 为 188/187/1，workspace 仍为 18 packages 且没有单文件或浅层 package。基础 Edge/Standalone 为 `2,635,529 / 2,635,607 bytes`、323 files、58 loaded modules，且没有 Cluster/PostgreSQL 闭包。本切片不改 PostgreSQL schema、连接、role、Pool、容器或 Kubernetes 拓扑，因此不重跑且不重新占有 PostgreSQL HA 证明。

ADR-0494 已完成 Cluster `mounted-files` provider live 子门：真实三节点 K3s 中两个 management replica、direct exact-key executor 和两个跨节点 provider observer 完成 PostgreSQL durable approval/binding、Kubernetes atomic projection rotation、无 Secret API 权限/ServiceAccount token、只读 `0440`、内容脱敏及删除后 fail-closed；v2 私有报告 24/24 gates 为 true，并保持 v1 verifier 兼容。该门不增加 Edge 闭包，也不等于直接 Vault/KMS/HSM custody。

转为 Accepted 前仍必须完成：固定低性能 Edge 设备的真实空间/写放大/断电恢复证据、直接外部 custody adapter，以及 HA promotion 后对既有 application receipt 的 exact replay。ADR-0495 已完成专用 PostgreSQL plan ledger，ADR-0496 已完成只保存 pinned bundle ref、通过 fenced remote delivery 取回 typed carrier 并在 Worker 内存展开的数据面；ADR-0497 又在一个 Project-serialized SERIALIZABLE transaction 中完成逐项 Task/Trigger current-head revalidation、revision/execution mutation、schedule reset 和 content-free append-only receipt，并支持合法历史 Task pin。它仍不写入 Secret material、不等于 direct Vault/KMS/HSM custody，也尚未在 promotion 后重放同一 application receipt。ADR-0492 已完成本机 completion schema 演进和 completed-head 后 rollback material 回收，ADR-0493 又让没有 Legacy 身份输入的 fresh v52 目标身份经 signed `retain_target` 正确形成 no-effect，并精确消除六张已知目标表的 `unknown` 误判。Legacy `Auths/Users` 或真正未知表仍保持 manual；Local Owner 编排、mounted-files gate、plan/application ledger 或通用 PostgreSQL HA 证据都不得冒充完整外部密钥托管。
