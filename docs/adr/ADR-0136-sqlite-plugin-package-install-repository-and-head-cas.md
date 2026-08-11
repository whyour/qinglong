# ADR-0136：SQLite Plugin Package 安装仓库与 Head CAS

- 状态：Accepted（首建/替换 head、完整 lock、mutation ledger、版本与 record digest
  CAS、bounded recovery、migration/schema/readiness lockstep 已实现；ADR-0137 已补
  PostgreSQL parity，ADR-0138 已补本地 activation publisher/组合；具体产品 consumer、
  startup lifecycle 与生产管理入口仍未开放）
- 日期：2026-07-24
- 关联 RFC：QL-RFC-0001 D-08、D-09、D-130、D-132、D-133、D-134
- 关联 ADR：ADR-0063、ADR-0076、ADR-0132、ADR-0134、ADR-0135

## 背景

ADR-0134 定义了 profile-neutral PackageLock、安装状态机、CAS commit 和恢复动作，
ADR-0135 又证明离线 bundle 可被确定性检查并私有 staging。但没有 durable adapter
时，`queued`、staging receipt、activation receipt、上一代 active pointer 和
mutation replay 都只存在于内存，进程重启后无法安全裁决。

本地 edge/standalone 必须先有低资源、单 SQLite authority 的实现；同时不能为这一
能力新增只有一个文件的 workspace package，也不能把安装器接入默认启动路径。

## 决策

### 1. Repository 留在既有 `@qinglong/local-sqlite`

新增显式 `@qinglong/local-sqlite/plugin-package-install` subpath，不从 package 根入口
或 runtime 入口导出，不新增 workspace package和第三方依赖。Repository 复用既有
`LocalSqliteOperationAuthority` 的单连接有界队列和 Node SQLite transaction authority。

禁用插件安装时，edge/standalone 默认 composition 不加载该 subpath，不增加 timer、
watcher、socket、后台进程或第二个数据库连接。

### 2. 三张表分别拥有历史、当前指针和重放事实

`0037-plugin-package-installs` 新增：

- `QingLong3PluginPackageInstalls`：原子保存每个 installation 的不可变 `lock_json`
  与当前 durable record，同时保留所有 generation 历史；
- `QingLong3PluginPackageInstallHeads`：每个 Project/Package 只有一个当前
  installation head；
- `QingLong3PluginPackageInstallMutations`：保存 mutation ID、命令摘要、结果 version
  与 record digest，作为 exact replay ledger。

表级 CHECK、FK 和索引将 lock/record JSON 的 installation、Project、Package、
operation、state、generation、version 与 digest 同索引列绑定。Repository 的
`findLock` 每次读取重新规范化并重算 lock digest。typed Drizzle schema、真实 SQLite
catalog、migration manifest 和 readiness contract 必须保持 lockstep。

`0038-capability-v19` 只允许从 exact local-control-core v18 前驱推进到 v19，并发布
`"plugin_package_install":1`。runtime readiness 要求 34 张表、全部受审索引、无
owned-table trigger、完整 migration history 和 exact capability JSON。

### 3. 首建也是需要 head fence 的提交

领域层新增 `PluginPackageInstallCreate`，固定：

- normalized initial queued record；
- create mutation ID；
- expected head，首装必须为 null，替换必须精确绑定 installation ID、version 和
  record digest；
- domain-separated create command digest。

create command digest 同时绑定 candidate record digest 和 expected head，不能复用
record 自己的 initial mutation digest。这样同一 queued record 不能在审批后从
“首装”静默改成“替换另一 head”，也不能改变被替换 generation 后继续命中 replay。

替换只接受同一 Project/Package 的不同 installation；上一 head 必须为
`active | failed` 终态，且候选 record 的 previous-active pointer 必须与其一致。
首装只接受 generation 1、null previous active 和空 head。

### 4. 所有写入使用短 `BEGIN IMMEDIATE` 与 exact CAS

create 在同一 transaction 内：

1. 复验 Project 存在且未 archived；
2. 读取并比较 expected head；
3. 插入 immutable installation、mutation ledger；
4. 首建或替换 head；
5. COMMIT 后返回重新规范化的 durable record。

后续 commit 同时比较 installation ID、expected version、expected record digest、
mutation ID/digest 和完整 next record。任一漂移返回稳定 conflict；SQLite、约束或
corrupt record 统一映射为 unavailable，不泄漏 driver/schema 细节。

同 mutation exact replay 返回当前已前进的 record，不把历史结果倒写成旧状态。
同 ID 不同 command digest 永远冲突。record JSON 每次读取都重新走 runtime-core
normalizer，不能因为索引列看似正确而接受被手工篡改的内容。

### 5. 恢复只扫描当前 head

恢复查询只返回当前 head 中 `queued | staged | activating` 的 installation，按
Package name、installation ID 稳定排序，cursor exact continuation，每页最多 64 条。
旧 generation 即使历史上仍是非终态，也不允许绕过 head authority 被重新执行。

动作仍由 ADR-0134 决定：

- `queued` → `resume_stage`；
- `staged` → `resume_activation`；
- `activating` → `inspect_activation`。

Repository 不读取 bundle、调用 staging、发布资源、注册 Tool/Task/Trigger 或创建
recovery timer。

### 6. 可注入组合不等于生产入口开放

本 ADR 不实现：

- PostgreSQL parity 已由 ADR-0137 完成，但 production composition 仍不可达；
- 具体 Approved Action 产品 consumer、Policy/Audit 入口；
- Task、Workflow、Prompt、Tool 或 Trigger 的原子 generation publisher；
- production startup recovery lifecycle、operator repair 和旧代 GC；
- OCI client、publisher revoke/index、管理 API/CLI/UI 或自动更新；
- Runtime Extension 或动态代码加载。

因此 migration 和 Repository 的存在不能被解释为 Plugin Package 已可在生产安装或
执行。任何产品入口必须在上述闭环及独立审计完成前保持不可达。

## 影响

- 本地 Profile 获得 crash-safe 安装历史、单 head、exact replay 和恢复候选 authority。
- SQLite 只在显式安装/恢复操作中付费，不增加常驻资源；低配路由器继续使用单连接、
  bounded page 和短 transaction。
- `packages/` importer 数不增加；能力留在 runtime-core/local-sqlite 现有包的显式
  subpath。
- 集群 adapter 已由 ADR-0137 实现，并与 SQLite 共用同一可执行语义合同；后续修改
  不能把 JSON/schema 或锁策略提升为第二套领域语义。
- bundle staging 成功仍不能直接激活；它只能形成下一次 CAS 所需的 evidence。

## 验证

单元和架构门禁覆盖：

1. initial queued record 与 head-bound create command；
2. 首装空 head、replacement exact head 和 previous-active fence；
3. durable install/head/mutation 原子 create；
4. exact create replay 与 command/head drift conflict；
5. version + record digest + mutation digest CAS；
6. record 前进后的旧 mutation replay不回退状态；
7. terminal-only head replacement 和历史保留；
8. current-head-only 稳定 recovery pagination；
9. archived Project 与 corrupt record fail-closed；
10. `0037`/`0038` manifest checksum、v19 capability 和 typed schema/catalog lockstep；
11. explicit subpath-only export；
12. runtime-core、local-sqlite、Profile artifact、edge import 与 dependency audit。

ADR-0138 加入共享 lock 合同与本地端到端组合后，当前结果为 runtime-core 215/215、
local-sqlite 68/68、local-admin 50/50，均 0 fail。生产产品入口、真实断电恢复与
operator 级安装恢复仍是后续 Gate。
