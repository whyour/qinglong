# ADR-0483：密封 Reconciliation Bundle 的有界数据域计划

- 状态：Accepted（D-390 已实现）
- 日期：2026-08-21
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-64、D-87、D-184、D-259、D-383、D-389、D-390
- 关联 ADR：ADR-0064、ADR-0094、ADR-0095、ADR-0194、ADR-0201、ADR-0314、ADR-0315、ADR-0482
- 细化：ADR-0482 第 3、5、7 节的 terminal asset layout 与只读消费者契约

## 背景

ADR-0482 已把 stopped `reconciliation_required` 的 target、Legacy source、recovery 和 lineage 冻结为不可变 bundle，但
`reconciliation_captured` 只证明原始字节可恢复，不说明两侧哪些数据域发生变化、哪些事实可映射、哪些只能保留或人工裁决。直接从
capture 跳到 import 会把“证据保全”错误提升成写 authority，并且无法回答 3.0 Run、Secret、Plugin Package、AI、identity 与 audit
如何安全降级到 2.x。

当前 bundle 还使用 `target-main`、`target-wal` 等逻辑名作为实际文件名。SQLite 只识别 `<main>-wal/-shm/-journal`，因此下游若要
检查一致 snapshot，只能再复制一整份数据库或修改 bundle。前者会在路由器、NAS 和小闪存设备上制造不可接受的第二次空间放大；后者
破坏 ADR-0482 的不可变承诺。D-390 必须先修正物理读取契约，再建立严格只读、固定内存和固定输出的领域计划。

## 决策

### 1. Capture schema v2 使用 SQLite 可识别的固定物理名并密封

manifest 继续只保存固定逻辑名，不保存输入绝对路径；实际 payload 使用固定映射：

| 逻辑名 | 物理名 |
| --- | --- |
| `target-main` | `target.sqlite` |
| `target-wal/-shm/-journal` | `target.sqlite-wal/-shm/-journal` |
| `legacy-main` | `legacy.sqlite` |
| `legacy-wal/-shm/-journal` | `legacy.sqlite-wal/-shm/-journal` |
| `recovery-main` | `recovery.sqlite` |

capture manifest/receipt 升为 schema v2，并把 activation 中的 `sourceSha256`、`targetSha256` 纳入内容无关 lineage projection 和
manifest。receipt 发布后、instance head 推进前，所有 asset 从 `0600` 收敛为 `0400`，assets directory 从 `0700` 收敛为 `0500`，
并 fsync 文件、目录及父目录。部分 chmod、receipt-response-loss 和 head-response-loss 均由同一 commit 收敛；terminal verify 只接受
完整密封状态。3.0 尚未发布，本 ADR 不为内部 alpha schema v1 增加双格式兼容或自动重写。

### 2. 只允许两种零复制 SQLite 读取方式

- main 无 `-wal/-shm/-journal`：使用 `file:...?...immutable=1` 与 `readOnly`；
- `-wal` 与 `-shm` 同时存在、无 `-journal`：使用普通 `readOnly`，依赖密封 mode 阻止 SQLite 改写 shm。

存在 hot journal、WAL/SHM 不配对、额外 sidecar、mode/owner/link/hash 漂移时，不打开数据库、不尝试 checkpoint/recovery，也不把 main
当作完整 snapshot；该数据库 inventory 固定为 `manual_required`。每次打开前后重验 manifest 中全部 bytes/hash 和 stat，任何变化失败
关闭。handle 固定 `defensive`、`trusted_schema=OFF`、`query_only=ON`、`temp_store=MEMORY`、`mmap_size=0`，禁止 extension、attach、
vacuum、DDL、DML 和网络。

### 3. 增加独立 plan prepare、commit、verify

既有 `ql3-local-deploy` 增加：

```text
local.deployment.reconciliation.plan.prepare
local.deployment.reconciliation.plan.commit
local.deployment.reconciliation.plan.verify
```

调用方显式提供独立私有 `planRoot`、UUID `planId`、`captureRoot/captureId`、exact `bundleDigest`、当前 instance head digest、
`legacyTimezone|null` 和时间。prepare 验证密封 bundle 与 `reconciliation_captured` head，以 CAS 推进为
`reconciliation_plan_prepared`，并在 `<planRoot>/<planId>` no-replace 发布固定 intent。planRoot 不得位于 deployment root、capture
directory 或任一 SQLite asset 内。

commit 只读取密封 bundle，发布固定 schema plan、terminal receipt，再以 plan digest 把 head 推进为 `reconciliation_planned`。
verify 只重验 terminal plan、receipt、bundle binding 与 head，不打开 SQLite、不创建/清理文件。prepare/commit response loss、plan/receipt/
head 崩溃窗口均 exact replay；不同 command 不能复用 planId。

### 4. Plan 只提供固定领域 summary 和 disposition

plan 固定包含以下有序领域，不保存 row value、command、Secret、credential、日志、业务标识或单条对象名称：

1. `schema_lineage`：两侧 catalog、migration/capability 与未知对象摘要；
2. `automation`：Legacy Crontabs 与 3.0 Task/Trigger/adoption ledger 的计数和基线漂移；
3. `secret_and_config`：Legacy Envs/Auths 与 3.0 Secret/data-directory adoption 的计数和 custody 缺口；
4. `run_history`：Run/Attempt/Event/Step 等不可逆历史；
5. `plugin_package`：install/materialization/publication/lifecycle/quarantine；
6. `ai_and_tool`：provider、prompt、Tool execution/output/key binding；
7. `identity_policy_audit`：Project、RoleBinding、credential、pepper、approval 与 audit；
8. `unknown`：不在固定分类中的 table/schema facts。

每个领域只返回 bounded counts、inventory digest 和以下 disposition 之一：

```text
aligned | legacy_changed | target_changed | diverged |
target_only | manual_required | unsupported
```

`aligned` 也不授予写入；`target_only` 表示必须保留 3.0 bundle 或由后续显式 exporter 处理；`manual_required/unsupported` 禁止自动计划。
只要未知 schema、hot journal、不完整 sidecar、未映射 Legacy facts、active/inconclusive Run 或 credential/Secret custody 缺口存在，整体
outcome 必须为 `manual_required`。本 ADR 不产生 `import_ready`、`rollback_ready` 或 `legacy_ready`。

### 5. Diff 使用已提交 baseline，不猜测语义等价

capture manifest 的 source/target baseline SHA-256 与 captured asset set 判定数据库级 `unchanged|changed`。target 内既有
`QingLong3LegacyAdoptions` 和 `QingLong3LegacyDataDirectoryAdoptions` 只提供已提交 adoption baseline；Task/Trigger current revision、
Secret version 和各领域 table count/digest 只用于保守分类。名称相同、数量相同或 JSON 看起来相似都不能自动视为等价。

Legacy timezone 是显式 reviewed input；若与可证明的 adopted trigger timezone 不一致则 `manual_required`。D-390 不解密 Secret、不读取
credential/token、不执行 Legacy command，也不构造 2.x SQL。逐对象 private diagnostics、人工选择与目标 adapter 由后续 ADR 定义，必须
消费 exact plan digest。

### 6. 低资源与 package 边界

实现继续内聚在 `@qinglong/local-owner-cli/src/deployment/reconciliation/` 的 `sealed-bundle/` 与 `planning/` 子目录，不新增 workspace
package、production dependency、binary、daemon、timer、watcher、listener、socket 或后台 retry。不得把新文件平铺到 package `src/`
根，也不得从 deployment planning import Local SQLite mutation/adoption authority。

内存上限为单个 SQLite handle、64 KiB hash buffer、固定八领域数组和不超过 64 KiB 的 plan builder。Edge/Standalone SQLite cache
分别不超过 2/8 MiB；schema object 上限 4,096，table 上限 512，领域 row count 只保留安全整数和总量，不把对象列表放入内存。plan
文件不超过 64 KiB。Cluster/PostgreSQL 不消费 Local bundle 或 plan。

## 被拒绝的替代方案

### 为分析再复制 target 与 Legacy 数据库

拒绝。最坏会在 capture 已占两份数据库后再增加两份，直接破坏路由器和小闪存设备的空间模型。

### 直接以 immutable 打开带 WAL 的 main

拒绝。SQLite immutable 会忽略 WAL，可能静默丢失已经提交但未 checkpoint 的事实。

### 让 readonly SQLite 使用可写 shm

拒绝。真实验证表明 readonly handle 仍可能改写 `-shm`；只有密封资产才能保持 bundle hash 不变。

### 从表名相似自动生成回灌 SQL

拒绝。相同名称不证明 Project、revision、Policy、Secret custody、append-only history 或幂等身份等价。

### 把完整 row diff 写入 plan

拒绝。会泄漏敏感内容、产生无界内存/文件，并把 inventory 偷换成未审批的迁移 payload。

## 验收条件

1. Capture v2 固定物理名、0400/0500 密封、baseline digest 与全部 crash replay 可验证；v1 不被静默接受。
2. main-only immutable 与 WAL+SHM readonly 在 Linux/Docker 中可读取且前后 bytes/hash/stat 完全不变；hot journal/unpaired sidecar 零
   SQLite open 并稳定 `manual_required`。
3. plan prepare 只接受 exact `reconciliation_captured` bundle/head 并建立唯一 CAS fence；restart/rollback/第二计划不能越过。
4. commit 产生固定八领域、固定 disposition、≤64 KiB 的内容无关 plan/receipt；unknown、Secret/credential、Run 与未映射事实保守分类。
5. plan/receipt/head 各崩溃窗口和 response loss exact replay；verify 完全只读且不打开 SQLite。
6. 无 import、DML、checkpoint、service、Docker/init/network 副作用，无新增 package/dependency/常驻对象或跨包写 authority import。
7. Edge 固定 2 MiB cache、Standalone 8 MiB cache；完整 Local Owner/backend/package、架构、release、十四档 artifact 与真实 Docker
   readonly rehearsal 通过，基础 Edge closure 不增长。

## 实现与验证证据

D-390 已在既有 `@qinglong/local-owner-cli/src/deployment/reconciliation/` 内实现。`sealed-bundle/reader.ts` 只接受经 terminal
validator 验证的密封 capture：main-only 走 immutable readonly，WAL+SHM 完整配对走普通 readonly；hot journal、sidecar 不配对或
任一 stat/hash/mode 漂移均在 SQLite open 前失败关闭。`planning/` 以固定 contract、inventory、prepare/commit/verify 将 instance head
从 `reconciliation_captured` CAS 推进到 `reconciliation_plan_prepared`、再推进到 `reconciliation_planned`。plan 只包含固定八领域的
有界计数、digest、disposition 和保守 outcome，不保存表名、路径、row value、Secret、credential、命令或日志，也不产生 import authority。

实现没有新增 workspace package、production dependency、binary、daemon、listener、timer、watcher 或网络访问。workspace 仍为 18
packages，`singleSourcePackages=[]`、`shallowSourcePackages=[]`；Local Owner 为 `146 source / 145 nested / 1 root binary entry`，新增的
5 个源文件全部进入 `deployment/reconciliation/sealed-bundle|planning/`，没有回到 `src/` 根平铺。Edge/Standalone cache 固定为
2/8 MiB，hash buffer 与 plan 上限均为 64 KiB，schema/table 上限为 4,096/512。

验收结果：reconciliation 聚焦套件 `24 total / 22 pass / 2 conditional Docker skip / 0 fail`；真实 Linux/Docker main-only 与
WAL+SHM readonly/hash-stability rehearsal `2/2`；完整 Local Owner `246 total / 239 pass / 7 conditional skip / 0 fail`；tracked
backend `1540 total / 1538 pass / 2 conditional skip / 0 fail`；18-package clean build/逐包测试通过。Edge import、Cluster dependency、
package boundary、service-manager bridge、Local image、image release、release version 与 deployment-lock surface 审计均 compatible。

十四档 artifact audit 均 compatible。基础 Edge/Standalone 仍为 `2,611,978 / 2,612,056` bytes、319 files、58 modules；Adopted
仍为 `2,831,713 / 2,831,836` bytes、339 files、59 modules；Application+AI 为 `4,529,710 / 4,529,842` bytes、516 files、
144 modules；MCP 为 `7,337,910 / 7,338,018` bytes、805 files、228 modules。一次性 plan authority 未进入基础常驻闭包，也没有被
Cluster/PostgreSQL 消费。

## 未包含

- 逐对象明细分页、人工冲突选择和审批；
- 任何 Legacy/target 写入、Secret 解密、credential 导出或服务 restart；
- 自动 checkpoint、hot journal recovery 或损坏数据库修复；
- Cluster/PostgreSQL/Kubernetes reconciliation；
- 固定物理 Edge/NAS 的断电、FTL 写放大与介质销毁证明。
