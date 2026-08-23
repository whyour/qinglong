# ADR-0491：有界 Secret/Config Reconciliation 与任务环境绑定

- 状态：Proposed（D-397 第一切片已实现 Legacy Env inspection，原子 application 尚未完成）
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

Secret/Config 不消费 Automation decision 作为自身授权。它必须重新绑定 D-391 的 `secret_and_config` facts、同一 sealed bundle、D-392 application plan、当前 target snapshot 与独立的逐候选 signed decision。强认证 User、Project Policy、Secret custody 与 Task mutation authority 都要在写事务前及事务内重新验证。

存在 active Env 时，Automation 必须已经完成，且至少一个经 `QingLong3LegacyAdoptions` 证明的 Legacy Task 可绑定；否则不得用“Secret 已保存”冒充行为迁移。只有停用 Env 的场景可以在 Automation `no_effect` 后做纯保全。

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

第一切片固定：

| 预算 | Edge | Standalone |
| --- | ---: | ---: |
| Legacy Env 行数 | 10,000 | 100,000 |
| disabled preservation candidates | 128 | 512 |
| active bindings | 256 | 256 |
| 单个 effective value | 16 KiB | 16 KiB |
| 全部 active effective values | 64 KiB | 64 KiB |

实现逐行读取，不把整张 `Envs` 或全部停用值加载到内存；active value 的在途内存由 64 KiB 合同封顶，停用值通过第二次有界扫描逐个交付。它位于既有 `@qinglong/local-admin/src/legacy-adoption/secret-and-config/`，不新增 workspace package、production dependency、daemon、timer、watcher、listener、socket、数据库连接池或 `src` 根平铺文件。

### 4. 原子 application 必须同时完成 custody 与行为绑定

后续 D-397 application 必须在一个 `BEGIN IMMEDIATE` 事务内完成：

1. 复验 Project/RoleBinding fence、signed decision、sealed source、target snapshot 与当前 instance head；
2. 为每个 active effective Env 写入加密 Local Secret envelope、content-free `secret.create` audit 与 adoption item；
3. 为每个 disabled candidate 写入加密但未绑定的 Secret，并记录 disabled preservation disposition；
4. 为每个经 Automation adoption ledger 证明的 Legacy Task 追加 TaskDefinition revision，把 active Env 绑定为 `kind=secret` 的 environment；
5. 为指向旧 Task revision 的 Legacy Trigger 追加 Trigger revision，并更新 local schedule/dispatch revision；
6. 写入不可变 Secret/Config reconciliation receipt ledger 后一次提交。

任一 Secret、Task、Trigger、dispatch、audit、ledger 或 fence 冲突都回滚整个事务。禁止先提交 Secret 再逐任务修补，也禁止在现有 Task revision 上原地改 JSON。目标已有同名/同源 Secret、非 Legacy Task、Plugin-owned Task 或用户在 stopped window 中产生的 revision 都按冲突处理，不自动覆盖或重命名。

由于该 adapter 执行 DML，它需要独立的 prepared/applied/rolled-back lineage 与写前 target backup；无 DML 的 Run History preservation 继续只绑定最新 head。跨领域 completion 后才可回收 Automation 与 Secret/Config 两份 rollback material。空间不足必须在 prepare 前失败，不得在低配设备上边写边赌。

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

D-397 第一切片已经实现并测试：absent、unsupported、Edge over-budget、2.x 顺序、同名连接、disabled preservation、保留前缀、异常状态、effective overflow、candidate digest 与 content-free diagnostics。Local Admin 完整测试为 95/95。

转为 Accepted 前仍必须完成：私有 row plan 与 signed decision、原子 Secret/Task/Trigger/dispatch publisher、prepared/apply/rollback response-loss、completion schema 演进、完整 Local Owner/18-package/boundary/artifact gates、真实 Edge 空间预算、PostgreSQL HA 与 Cluster Secret provider live gate。
