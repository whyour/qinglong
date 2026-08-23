# ADR-0490：Run History 终态保全与跨领域完成证明

- 状态：Accepted（D-396 实现、本地完整门禁与远程 37-job CI 已通过）
- 日期：2026-08-23
- 决策：D-396
- 关联：ADR-0482、ADR-0483、ADR-0484、ADR-0485、ADR-0488、ADR-0489

## 背景

QingLong 2.x 的 `CrontabStats`、`Logs` 与 QingLong 3.0 的 `Runs`、`RunAttempts`、`RunEvents`、`StepRuns` 等对象都属于运行历史，但两代模型并不具备可证明的一一映射。把旧统计或日志行直接插入 3.0 Run ledger 会伪造 Run identity、event sequence、Attempt/Step 关系与执行来源；用 target 覆盖 Legacy 又会违反 append-only 历史边界。

D-391 因而把 Run History 全部标为 blocked，D-394 completion 也只能拒绝该领域。这个保守默认能避免数据损坏，却使一个已经停稳、只要求保留两侧历史的迁移永远不能形成完成证明。D-396 必须提供真正可完成、但不冒充历史转换的领域 adapter。

## 决策

### 1. Run History adapter 是保全证明，不是数据导入器

Legacy 与 target 的历史继续保存在 ADR-0482 已封存的 capture bundle 中。adapter 不执行 INSERT、UPDATE、DELETE、checkpoint、日志复制、格式转换或外部上传，也不把旧行回灌到 3.0 Run ledger。

合法裁决固定为：

- Legacy Run History 的每个 required fact 必须选择 `retain_both / preserve_both`；
- Target Run History 的每个 required fact 必须选择 `retain_target / preserve_target`；
- `adopt_legacy`、`exclude_legacy`、`defer`、`manual_external` 或任意 blocked fact 都不能形成保全证明。

receipt 只绑定 bundle、review、application、领域 inventory 与 fact counts，不保存表名、Run ID、状态值、日志、路径或 row body。

### 2. 只有确定终态的 target history 可被提升为 required

Legacy capture 已由 stopped source fence 固定，因此其 Run History 可进入 `historical_preservation_required`。Target 必须从 exact sealed SQLite 重新证明：

- `Runs` 存在 `status` 与 `finished_at_ms`，所有 Run 只能是 `succeeded|failed|cancelled|timed_out`，且具备完成时间；
- 若存在 `RunAttempts`，不能有 `claimed|starting|running` Attempt；
- 若存在 `StepRuns`，所有 Step 只能是 `succeeded|failed|skipped|cancelled|timed_out`，且具备完成时间；
- 缺少 canonical 列、active/waiting/retry/lost Run、active Attempt、pending/waiting/running/lost Step 或查询漂移继续保持 `blocked / historical_integrity_required`。

该判断同时用于 diagnostics、review commit 和 adapter replay；operator 不能通过修改私有 decision file 把 active Run 提升为可保全。

### 3. 新增独立短生命周期 preserve/verify 命令

既有 `ql3-local-deploy` 增加：

```text
local.deployment.reconciliation.run-history.preserve
local.deployment.reconciliation.run-history.verify
```

preserve 重新打开 sealed application、plan、bundle 与 owner-private decision file，重放全部 canonical facts，并要求 review authorization 的 decision file digest/count 完全一致。它只允许 Run History domain 为 `adapter_required`，并绑定 exact `reconciliation_application_planned` 或 `reconciliation_automation_applied` source head。

每个 preservation directory 最多只含 `receipt.json`，以 no-replace publication、file/directory fsync 和 exact replay 收敛，最终文件/目录权限为 `0400/0500`；catalog 上限 64。receipt 发布或封存后的 response loss 可由相同命令继续完成，不覆盖冲突证据。

preserve 不增加 instance head 状态。它本身不授予 restart；若在发布期间另一个 adapter 推进 head，该证明会因 source-head digest 脱离而不能被 completion 消费，调用方必须在新的终态 head 上使用新 preservation ID 重新证明。这避免了多个独立 adapter 状态的组合爆炸。

### 4. Completion schema v2 消费第二种 adapter evidence

completion command/receipt 保留 v1 兼容语义；只有携带 Run History preservation 时使用 schema v2。固定八领域证据新增：

```text
run_history + adapter_required + run_history_preservation
```

completion 重新验证 sealed preservation、原 decision stream、bundle fingerprint、application plan 与 source head；调用方只能提交 preservation ID 和 expected digest，不能自报 domain evidence。`adapterCount` 从 `0|1` 扩展为 `0|1|2`，允许 Automation apply 与 Run History preservation 同时作为已证明 adapter。

完成时间不得早于 application commit、Automation apply 或 history preservation 中任一最新证据。v1 receipt 仍按原规则读取和验证；v2 receipt 必须实际包含 Run History preservation，不能用版本号绕过领域证明。

### 5. 低资源与集群边界

实现内聚于既有 `@qinglong/local-owner-cli/src/deployment/reconciliation/application/run-history/`，不新增 workspace package、production dependency、binary、daemon、timer、watcher、listener、socket、SQL migration 或 `src/` 根平铺。

Edge/Standalone 每次最多打开一个 sealed SQLite handle，状态判定均为 `LIMIT 1`，decision file 继续使用 64 KiB 流式缓冲；长期新增资产只有一个小型 content-free receipt，不复制数据库或日志。

本 ADR 只定义 Local SQLite 保全。Cluster/PostgreSQL 的 Run History 必须使用数据库 snapshot、事务一致性、租约/运行收敛与 HA retention 的独立证明，不能复用本机路径或把 Local capture bundle 当成集群历史 authority。

## 被拒绝的替代方案

### 把 Legacy 统计和日志导入 3.0 Run ledger

拒绝。没有 Run/Attempt/Event/Step identity 与顺序证明，导入会制造看似完整但语义虚假的运行记录。

### 只保存 source database 的 SHA-256

拒绝。整库 hash 会被其他 adapter 对无关表的合法写入破坏，也不能表达签名的 append-only 保留选择。D-396 绑定 sealed bundle 与 Run History domain inventory。

### 每增加一个 adapter 就新增 instance head 状态

拒绝。八领域会产生顺序与组合爆炸。无 DML 的 history proof 绑定当前 source head，最终由跨领域 completion 一次 CAS。

### 把 active/lost Run 当成历史

拒绝。`running|waiting_approval|retry_wait|lost` 都可能仍需执行、恢复或人工裁决，封存为完成历史会丢失运行 authority。

## 验收条件

1. terminal Legacy/Target history 从 blocked 精确提升为 required；active/inconclusive target history 始终 blocked。
2. 只有 `legacy retain_both + target retain_target` 的完整 signed canonical decision stream 可发布 receipt。
3. receipt 不包含名称、路径、Run ID、状态值、日志或 row body，且收敛为 `0400/0500`。
4. receipt publication/seal response loss exact replay；替换、篡改、额外 catalog、stale head 与 decision drift 全部失败关闭。
5. completion v2 重新验证 preservation 并生成固定八领域 evidence；completion v1 保持兼容。
6. preserve/verify 无 SQLite DML、数据库复制、service、Docker、network 或后台对象。
7. 聚焦、完整 Local Owner、tracked backend、18-package、package/dependency/source boundary、artifact/Edge import 与远程 CI 全部通过后，本 ADR 才能转为 Accepted。

## 当前证据

- 聚焦 Run History：`2/2`，覆盖终态 preserve/verify、两处 response-loss replay、v2 completion、CLI content-free、active Run blocked、人工越权拒绝与 sealed receipt 篡改。
- 既有 completion v1 聚焦回归：`2/2`。
- 完整 reconciliation：`48 total / 46 pass / 2 conditional Docker skip / 0 fail`；完整 Local Owner：`273 / 266 / 7 / 0`。
- tracked backend：D-396 实现提交为 `1561 total / 1559 pass / 2 conditional skip / 0 fail`；最终远程修复提交增加一项 rollout-generation 合同测试后为 `1562 / 1560 / 2 / 0`。18-package clean build/test 为 `2919 / 2897 / 22 / 0`。
- package/dependency/source boundary、service-manager bridge import、Edge import 与十四档 Local artifact audit 全部 compatible；workspace 仍为 18 packages、`singleSourcePackages=[]`、`shallowSourcePackages=[]`，Local Owner 为 `175 source / 174 nested / 1 root binary entry`。
- 基础 Edge/Standalone 制品保持 `2,611,978 / 2,612,056 bytes`、319 files、58 loaded modules；本阶段未把一次性 Owner authority 带入常驻小设备 runtime。
- D-396 实现提交 [`42262094`](https://github.com/whyour/qinglong/commit/42262094cc573a63392576659367d2d80d036c89) 在远程暴露了两个与 Run History 领域逻辑无关、但会削弱总门稳定性的既存 live-test 时序问题：PostgreSQL claim takeover 只把过期时间置于数据库时钟前 1 ms，以及 Provider 证据在滚动发布后保存任意 Ready Pod 快照。
- [`85e244f6`](https://github.com/whyour/qinglong/commit/85e244f6022a20813a8136a449d524e508c54373) 仅把测试夹具中的 claim 置于完整 30 秒租约之外，未改变生产租约语义；[`6001174e`](https://github.com/whyour/qinglong/commit/6001174e232b72ba12127158fc3618c8257c6138) 让 Provider 发布和每次瞬态证据重试都重新绑定 exact `qinglong.io/provider-generation` 的非终止 Ready Pod，并继续保留 UID/restartCount/requestCount 与 CIDR 断言。
- 最终远程 [QingLong 3.0 CI](https://github.com/whyour/qinglong/actions/runs/32623061467) 为 `37/37 success`；此前失败的 PostgreSQL 16 arm64、其余 PostgreSQL 16/18 x64/arm64 矩阵及 Provider K3s + CloudNativePG material/CIDR rotation/failover gate 全部通过。独立 [Kubernetes deployment live contract](https://github.com/whyour/qinglong/actions/runs/32623061462) 同样通过，因此本 ADR 转为 Accepted。
