# ADR-0485：Reconciliation 应用协调器与领域 Adapter 边界

- 状态：Accepted（D-392 已实现并完成门禁）
- 日期：2026-08-21
- 关联 RFC：QL-RFC-0001 D-05、D-06、D-17、D-64、D-87、D-184、D-259、D-383、D-389、D-390、D-391、D-392
- 关联 ADR：ADR-0482、ADR-0483、ADR-0484
- 细化：ADR-0484 的签名人工裁决消费边界

## 背景

ADR-0484 已把密封 reconciliation plan 转换为逐事实、强认证 User 签名的 review authorization，但该 authorization 仍只表达
operator 对 schema object/table 事实的选择。它没有定义任何领域的行级兼容、幂等键、写入顺序、备份、回滚或外部资产语义。

直接让通用导入器消费 review 会产生错误的授权提升。例如 Automation 表被选择为 `adopt_legacy`，并不意味着表内每个 Legacy shell
command 都能转换为 3.0 TaskDefinition，也不能证明目标 task id、timezone、disabled state 和 trigger 没有冲突。Secret、Run history、
Plugin package、AI/Tool 与 Identity/Policy/Audit 的安全语义差异更大，不存在一套可信的通用 DML。

D-392 因此只建立一个持久、内容无关的应用顺序根。它把签名 decision stream 汇总成固定八领域计划，为后续 adapter 提供唯一 fence，
但不执行迁移。

## 决策

### 1. 增加独立 application coordinator 状态机

既有 `ql3-local-deploy` 增加三个显式私有命令：

```text
local.deployment.reconciliation.application.prepare
local.deployment.reconciliation.application.commit
local.deployment.reconciliation.application.verify
```

状态以 instance head CAS 推进：

```text
reconciliation_reviewed
  → reconciliation_application_prepared
  → reconciliation_application_planned
```

`application.prepare` 必须绑定 exact `reviewId`、`reviewDigest` 和 reviewed head digest。它建立唯一 application fence 后，以 no-replace
方式发布 intent。第二个 application、旧 review replay、rollback、restart 或越级 commit 都必须失败关闭。

`reconciliation_application_planned` 只表示领域执行顺序已固定，不表示 reconciliation 完成、数据库已迁移或 target 可以重启。

### 2. Application plan 固定为八领域内容无关摘要

coordinator 重新验证 D-391 的 sealed review directory、authorization HMAC、issuer keyring、review/receipt binding 和 decision-set digest，
并在读取签名 NDJSON 时以固定 counter 统计：

```text
schema_lineage
automation
secret_and_config
run_history
plugin_package
ai_and_tool
identity_policy_audit
unknown
```

每个领域只保存 Legacy/Target 两侧的 decision count、固定 disposition counts、summary digest 与 action：

```text
no_effect | adapter_required | manual_external | adapter_and_manual
```

总体 outcome 为：

```text
no_effect_ready | adapter_required |
manual_required | adapter_and_manual_required
```

plan 不保存对象名、表名、路径、fact digest、row value、command、schedule、Secret、credential、Prompt/Tool payload、Artifact、日志或 reviewer
identity。它最多 64 KiB，domain 数固定为 8，内存只使用固定 counters 与 64 KiB 读取缓冲。

### 3. 修正 disposition 的数据库方向语义

D-391 已限制 blocked domain，但原始校验没有拒绝数据库方向矛盾的选择。D-392 明确：

- Legacy fact 不允许 `retain_target`；
- Target fact 不允许 `adopt_legacy` 或 `exclude_legacy`；
- `retain_both`、`defer` 与 `manual_external` 仍受既有 domain/blocked 规则约束；
- informational fact 仍不得出现在 decision stream。

该规则在签名发布前对重新派生的 canonical fact 生效，不依赖 diagnostics page。

### 4. 持久化、封存与崩溃恢复

`applicationRoot` 必须与 deployment、capture、plan、review root 两两不重叠；issuer keyring 必须位于 deployment root 的真后代。catalog 最多
保留 64 个 application directory，每个目录只含：

```text
intent.json
plan.json
receipt.json
staging/
```

intent、plan、receipt 使用 no-replace publication、stable file identity、file/directory fsync 和 digest binding。prepare head、plan、receipt、
terminal seal 与 planned head 后的 response loss 均必须 exact replay；冲突内容不允许覆盖或自动清理。terminal 文件收敛为 `0400`，目录与
空 staging 收敛为 `0500`。专用 terminal reader 在读取前后复核 owner、mode、link count、device/inode、size、mtime/ctime，不放宽通用
`0600` command-file policy。

### 5. Verify 完全只读

verify 只读取 sealed application evidence、sealed review authorization、issuer verification key 与 instance head。它不创建、替换、修复或
清理文件，不打开 Legacy/Target SQLite，不执行 checkpoint、SQL/DML、Secret 解密、Docker/init/service/network 或后台 retry。

应用 coordinator 的 prepare/commit 同样不得打开 SQLite。它消费的是 D-391 已签名、内容完整性受保护的 decision stream，而不是重新读取
数据库。每个未来 adapter 在写入前仍必须重新验证 exact application plan/head 和自己的领域输入。

### 6. 领域 Adapter 必须独立授权和回滚

D-392 不提供通用 apply。后续每个 adapter 至少要单独定义：

- 可接受的 source/target row schema 与兼容矩阵；
- Project/Policy/Owner authority 与需要重新认证的操作；
- 幂等 identity、冲突规则、写入顺序和 response-loss replay；
- 写前 backup、失败保全、rollback 与不可逆边界；
- Secret custody、append-only history、外部文件/OCI/KMS 等领域特有语义；
- Edge 的 RSS/I/O/磁盘峰值与 Cluster 的并发、租约和 HA 语义。

第一候选为 Automation adapter，但它必须先生成逐行、可审查、可回滚的 TaskDefinition/Trigger 转换计划，不能把 D-391 的表级选择直接解释为
批量 INSERT/UPDATE。

### 7. Package 与部署边界

实现内聚在既有 `@qinglong/local-owner-cli/src/deployment/reconciliation/application/`，按 contract、plan、coordinator 三个职责文件组织。
不新增 workspace package、production dependency、binary、daemon、timer、watcher、listener 或 socket，也不把文件平铺到 package `src/`
根。基础 Edge/Standalone runtime artifact 不应携带一次性 application authority；Cluster/PostgreSQL/Kubernetes 不读取 Local application root。

## 当前实现进度

D-392 已实现三条命令、两阶段 instance CAS、八领域 content-free plan、signed authorization domain counters、数据库方向校验、`0400/0500`
terminal seal、完整 response-loss replay 和只读 verify。聚焦 reconciliation 套件为
`35 total / 33 pass / 2 conditional Docker skip / 0 fail`；完整 Local Owner 为
`257 total / 250 pass / 7 conditional skip / 0 fail`；Git 跟踪 backend 为
`1541 total / 1539 pass / 2 conditional skip / 0 fail`。包含用户未提交测试的当前工作区 backend 也以
`1542 total / 1540 pass / 2 conditional skip / 0 fail` 通过。18-package clean build/逐包测试、八项架构/部署审计与真实 Docker readonly
reconciliation `2/2` 全部通过。

十四档 artifact audit 全部 `compatible`；基础 Edge/Standalone 精确保持
`2,611,978 / 2,612,056 bytes`、319 files、58 loaded modules，证明一次性 application authority 未进入低配常驻闭包。workspace 仍为 18
packages，`singleSourcePackages=[]`、`shallowSourcePackages=[]`；Local Owner 为
`158 source / 157 nested / 1 root binary entry`。新增 3 个生产源码全部位于既有 `deployment/reconciliation/application/`，没有新增 package、
dependency、binary 或常驻对象。

本切片没有 SQL、SQLite open、数据库 schema、PostgreSQL driver/ACL/role/Pool、Cluster deployment 或 HA 拓扑改动；仍按 operator 授权额外
重跑 PostgreSQL 18.6 arm64 physical HA，以 146 gates、timeline `1 → 2` 通过。private evidence SHA-256 为
`632d71f2a5b33cf657476fbe41702064b609b12cdf2382bcddaef06f4d08279f`，独立 evidence audit 无 finding，临时 Docker container/network 已
清理。该证明是额外回归证据，不把 Local application coordinator 解释为 Cluster reconciliation authority。

## 被拒绝的替代方案

### 让 D-391 review 直接调用 Automation adoption

拒绝。D-391 是 schema/table fact 授权，既有 adoption 是逐行首次接管协议；二者的冲突、幂等和 rollback 语义不等价。

### 为八个领域立即各建一个 package

拒绝。尚未形成独立发布、依赖或生命周期边界，会制造单文件/浅层 package。领域 adapter 先在现有 owner composition 的嵌套目录孵化，只有
出现稳定复用边界后才考虑拆包。

### 把全部 decision 加载成内存 JSON

拒绝。Edge 路由设备不能让内存随 schema 规模增长；签名验证与 domain summary 必须流式、固定缓冲。

### 把 application plan 当作 restart authority

拒绝。计划没有证明任何 adapter 已成功执行，也没有证明 Secret、历史或外部资产已收敛。

## 验收条件

1. 只有 exact reviewed head/review digest 可建立唯一 application fence；第二 application、rollback 与 restart 被阻断。
2. signed authorization 被重新验证并汇总为固定八领域、双数据库、固定 disposition counters；全局与领域计数严格守恒。
3. Legacy/Target 的方向矛盾 disposition 在签名前失败；blocked/informational 规则不回退。
4. application plan/receipt 不包含名称、路径、fact digest、row value、command、Secret 或 reviewer identity，且 plan 不超过 64 KiB。
5. prepare、plan、receipt、seal、head 的全部 response-loss 窗口 exact replay，竞争 application 失败关闭。
6. terminal 文件为 `0400`、目录为 `0500`；verify 只读且不打开 SQLite、不写数据库、不调用服务或网络。
7. 不新增 package/dependency/binary/常驻对象，不平铺 package `src/`；Edge 基础 closure 不增长。
8. 聚焦、Local Owner、tracked backend、18-package、架构、Docker 与十四档 artifact 门通过后，ADR 才可改为 Accepted 并阶段提交。

## 未包含

- Automation 或其他领域的行级转换、SQL/DML、备份与 rollback；
- Secret 解密/重加密、Run history 合并、Plugin/AI 外部资产复制；
- reconciliation completion、target restart 或 Legacy source 删除；
- Cluster/PostgreSQL/Kubernetes reconciliation；
- 固定物理 Edge/NAS 的断电、FTL 写放大与迁移峰值证明。
