# ADR-0221：原子、可重放的 Plugin Package 生命周期 Overlay

- 状态：Proposed
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-140、D-141、D-142、D-174、D-175、D-207、
  D-210、D-211
- 关联 ADR：ADR-0140、ADR-0142、ADR-0143、ADR-0144、ADR-0184、
  ADR-0186、ADR-0217、ADR-0220、ADR-0222

## 背景

QingLong 3.0 已经能安装、升级、回滚和安全隔离 Plugin Package，但安装状态机只描述
制品如何进入可用状态，publisher quarantine 则描述强制安全撤回。正常运维仍缺少三个
不同语义：

- 暂停一个正常 Package，保留随后恢复的可能；
- 恢复同一份、未被替换且仍可信的 Package；
- 在保留历史的前提下逻辑卸载 Package。

直接修改 install state 会混淆部署执行与运维意图；复用 quarantine 会伪造安全事件；
删除 install/head/history 会破坏审计、回滚和 durable execution recovery。Task 与 Tool
分两次撤出还会暴露“Task 已停、Tool 仍可启动”或相反的部分状态。

该能力同时需要覆盖资源很小的路由设备和 PostgreSQL 集群。实现不能为每个概念增加
package、后台 daemon、timer、watcher 或缓存，也不能把 Cluster 依赖带入 Edge。

## 决策

### 1. 独立 append-only lifecycle overlay

生命周期不改写 Plugin Package install record。每次 `disable|enable|uninstall` 追加：

1. canonical lifecycle event；
2. `(Project, Package)` current lifecycle head；
3. capability publication receipt；
4. 本次实际变更的 Package-owned Task transition evidence。

head disposition 只有 `active|disabled|uninstalled`。没有 head 表示当前安装仍按原
activation 语义为 active；head 必须精确绑定 installation、lock 和 install record
digest。新的 installation 或 lock 不能继承旧 head。

event 同时绑定 mutation、Approved Action dispatch、action/impact digest、请求人与批准
人、expected lifecycle version 和完整 reference graph digest。相同 event 精确重放；
mutation、dispatch、target 或预览漂移一律冲突。

### 2. 影响计划是批准对象，不是执行时提示

`plan` 在同一一致性数据库视图中重新计算：

- current install 与 materialized resource generation；
- current lifecycle head；
- current Project Tool snapshot；
- Package-owned Task；
- blocking Run/recovery reference；
- durable consumer 数量与 canonical reference graph digest。

批准绑定完整 impact digest。执行事务必须重新计算并与批准值完全一致，不能只验证
Package name。当前已落地 consumer 是 Task ownership、Project Tool snapshot 与
generation-bound Workflow/Prompt automation publication。Secret binding 尚无
durable consumer，因此 contract 保留计数、blocking reference 与全图 digest 扩展点；
未来增加 consumer 时旧执行器必须失败关闭，不能把未知引用当作零。

### 3. 三种 transition

`disable`：

- 只接受 active；
- 为当前仍 enabled 的 Package-owned Task 追加 disabled revision；
- 发布排除该 source 的 Project Tool snapshot；
- 对包含 Workflow/Prompt 的 Package 追加 active→withdrawn publication；
- 原子写 event/head/receipt/Task evidence/Tool snapshot/automation publication。

`enable`：

- 只接受同一 current installation 的 disabled；
- 重新验证 quarantine、publisher trust/revocation、materialized generation、Project
  Policy 与 active source 上限；
- 只恢复前一 disable receipt 中由生命周期实际关闭的 Task；
- 发布重新包含该 source 的 Tool snapshot；
- 对包含 Workflow/Prompt 的 Package 追加 withdrawn→active publication。

`uninstall`：

- 只接受 disabled；
- live Run、未收敛 recovery 或任何 durable consumer reference 都是 blocker；
- 只把 lifecycle head 推进到 uninstalled，不删除 install、proposal、approval、
  execution、event、snapshot 或 audit 历史；
- OCI、offline bundle、staging 和本地缓存字节由后续独立 retention receipt 回收。

### 4. 新启动拒绝，已 durable 执行继续收敛

生命周期 transition 与能力 publication 在同一数据库写事务完成。事务提交后：

- Run 从 queued 推进到 dispatching/running 时，若其精确 Task revision 属于
  non-active lifecycle head，立即拒绝；
- Tool start barrier 若命中同一 installation/lock 的历史 Tool definition，且 head
  non-active，立即拒绝；
- 已经 durable running 的 Attempt/StepRun 仍按原 revision 完成、取消或恢复，不由
  disable 热杀。

`enable` 把同一 head 恢复为 active 后，精确历史 revision 可再次通过 start fence；
Task current head 和 Tool current snapshot 仍由 lifecycle transition 发布的新版本决定。

SQLite 在唯一 `BEGIN IMMEDIATE` authority 内执行 transition，Run/Tool 围栏复用同一
连接和事务；PostgreSQL 使用 `SERIALIZABLE` repository 及
`SECURITY DEFINER commit_plugin_package_lifecycle(jsonb, jsonb, jsonb, jsonb)` 完成
server-side CAS。只有 `ql3_package_executor` 可执行该函数并只读 lifecycle ledger；
runtime、admin、package manager 和 worker ingress 既不能执行函数，也不能直接写表。

### 5. Profile 和部署边界

- Local 固定当前 Owner `human_confirmation`；
- Cluster 固定 separation-of-duty，由 package manager 管理 proposal/approval，由
  caller-driven package executor 执行；
- Edge 单命令只处理一个 Package，active source 上限 4；
- Standalone 单命令最多 4 个，active source 上限 16；
- Cluster 一批最多 16 个；
- 复用现有 20 个 workspace package 的显式 subpath，不新增 package、进程、端口、
  timer、watcher、listener 或常驻 cache。

PostgreSQL lifecycle repository 只从
`@qinglong/cluster-postgres/package-executor` 和显式
`@qinglong/cluster-postgres/plugin-package-lifecycle` 暴露；根入口、runtime、admin、
package manager、worker ingress 不取得 mutation authority。

Cluster review 使用短生命周期、append-only 的 durable plan：
`ql3_package_executor` 重算完整 impact 后只能 INSERT，`ql3_package_manager` 只能
SELECT 并据此创建 separation-of-duty Approval。executor 在消费审批前再次重算并做
exact compare；manager HTTP 不暴露 consume/execute，也不取得 lifecycle commit 权限。
plan JSON 的运行时和数据库硬上限均为 96 KiB，最长存活 15 分钟。

### 6. 恢复与失败语义

COMMIT response loss 通过 event digest、mutation、dispatch、target version 和 receipt
关系精确重放。SQLite readiness 与 PostgreSQL schema readiness 都复核 event/head/
receipt/Task relation；缺行、JSON/digest 漂移、Task evidence 不完整或 head CAS 丢失均
失败关闭。

隔离优先于正常恢复：存在 matching quarantine 或 publisher revocation 时，enable
拒绝。生命周期不能清除、覆盖或绕过安全隔离事实。

## 不采用方案

### 扩展 install state

拒绝。安装执行阶段和用户运维意图具有不同版本、恢复和审计语义。

### 把 disable 实现为 quarantine

拒绝。正常停用不是 publisher compromise，且 quarantine 不能被普通 enable 撤销。

### 直接删除 current head 或历史

拒绝。会破坏 rollback、durable completion、审计与 COMMIT response-loss 恢复。

### Task、Tool 分事务撤出

拒绝。任一崩溃窗口都会留下部分可见能力。

### uninstall 同步删除制品

拒绝。大文件删除和数据库逻辑退役不是同一原子域，会扩大路由设备写锁、闪存和恢复
成本。

### 新建 lifecycle package 或后台 reconciler

拒绝。现有 runtime-core/local-sqlite/cluster-postgres 权限与 Profile subpath 足以承载，
另建 package/daemon 违反 D-175/D-207，并增加低配设备供应链与空闲资源。

## 影响

- workspace 保持 20 个 package；
- SQLite capability 由 lifecycle v39 推进至 automation publication v40；
  PostgreSQL control-core 由 lifecycle plan v41 推进至 automation publication v42；
- D-210 inventory v1 不静默扩展 availability enum，后续用显式新响应 schema 返回
  lifecycle disposition；
- disable 不热杀已 durable execution，运维界面必须明确“停止新启动、等待已有执行
  收敛”；
- Workflow/Prompt durable publication、`absent` generation tombstone 与
  caller-driven startup recovery 已实现；实际 Workflow/Prompt execution、Prompt
  产品入口、Secret binding 与 quarantine 收敛未实现前，D-211 不能标记 Accepted。

## 当前验证

1. runtime-core lifecycle contract、digest、reference graph、event/receipt/head 与 replay
   测试通过；
2. SQLite `0077/0078`、Drizzle schema、readiness、repository 和 exact replay 已实现；
   lifecycle repository 5/5，Run/Tool lifecycle/quarantine 定向 18/18，相关 SQLite
   回归 37 项通过；另一个 Run contract suite仅因本地缺
   `ts-node/register/transpile-only` 未启动；
3. Run transaction GitNexus 影响为 MEDIUM（12 direct、29 total），Tool start barrier
   为 LOW（2 direct、20 total）；改动只增加 non-active guard；
4. PostgreSQL `pg-0041`、schema contract/readiness、Drizzle schema、repository 和
   package-executor 受限出口已实现；impact planner 不直接读取 `runs`，而经
   `SECURITY DEFINER plugin_package_lifecycle_blocking_runs` 做 Project/Package
   作用域和 129 条硬上限查询；commit 复用
   `lock_active_plugin_package_project`，不向 package executor 扩大 Project/Run
   表权限；迁移/权限契约 37/37；
5. 空 PostgreSQL 18 容器按真实六角色边界重放 41/41 migrations，最终 capability
   为 40；函数 owner 为 `ql3_migration` 且为 `SECURITY DEFINER`，只有
   `ql3_package_executor` 有 lifecycle commit/有界 Run 查询 EXECUTE，业务角色均无
   lifecycle 表写权限，package executor 也没有 `runs` 表 SELECT；
6. 正式 PostgreSQL 18 physical-streaming HA 门已通过：`remote_apply`、主备提升、
   旧主 fencing、`pg_rewind` 回归、disable COMMIT-response-loss 恰好一次收敛、
   exact replay、separation-of-duty、Run/Tool 原子拒绝与 enable 恢复均为 true；
   2 event、2 receipt、4 Task transition 和 lifecycle v2 active head 经 WAL、
   promotion 与重新连接后保持一致；
7. 本次真实门禁额外发现并修复了 package executor 直接读取 Run/Project 的越权路径
   及 PL/pgSQL `previous_task` 变量/别名冲突；`pg-0041` 冻结 checksum 更新为
   `99669c63c891124aa0741586d5e92bd40d7a3ddf322ec7da970790958f554101`；
8. Local 产品入口已复用现有 `local-admin/package-lifecycle` 与
   `local-owner-cli/package-command`：`plugin-package.lifecycle.plan` 先返回完整
   canonical impact 和低敏摘要，`plugin-package.lifecycle.execute` 再以私有命令文件
   携带该 impact 与稳定审批 identity，固定当前 Owner `human_confirmation`，串行完成
   request/decision/consume/transition。任何部分完成均从 durable Approval/dispatch
   继续，event 时间固定为 dispatch 创建时间，响应丢失重跑得到同一 receipt；不新增
   workspace package、连接、进程或后台循环。本机 lifecycle service 定向 2/2、
   `local-admin` 81/81、既有 `ql3-package` 回归 2/2；
9. Cluster 已在现有 `cluster-admin`/`cluster-postgres` package 内完成 caller-driven
   vertical：`pg-0042-plugin-package-lifecycle-plans`、capability v41、manager
   SELECT-only/executor SELECT+INSERT、management service、公开
   `lifecycle.propose|decide|inspect` transport、精确客户端响应校验，以及仅由受信
   caller 调用的 plan/execute executor；没有新增 package、daemon、timer 或端口。
   plan 最大 96 KiB/15 分钟，pg0042 冻结 checksum 为
   `a242067854f4ee5231c75874fa77dda364da962a2dcaf570b5015ee069818c4b`。
   transport 11/11、客户端 TLS 6/6、PostgreSQL 迁移/权限 30/30 通过；
10. 正式 PostgreSQL 18.4 arm64 HA 重跑新增两轮
    executor plan → manager proposer → distinct reviewer → executor re-plan/consume/
    transition，disable 后再 enable。2 条 durable plan、lifecycle v4 active head、
    receipt 与 plan 在 `remote_apply`、timeline 1→2、旧主 fencing、
    `pg_rewind` 只读同步重入后精确保留，新增 gate
    `pluginPackageLifecycleManagedPlanReviewExecutesExactly=true`，总
    `gates.passed=true`。依赖从本机受审 Cluster Admin 镜像离线复用，未访问 registry；
11. Local SQLite 已完成真实子进程 lifecycle crash matrix：
    `disable|enable × edge|standalone × 8` 个事务窗口共 32/32 通过。窗口依次位于
    Task revision、Tool snapshot、lifecycle event/receipt/task/head 之后及 COMMIT
    前/后；28 个 COMMIT 前 `SIGKILL` 均保持原 Task、snapshot 和 ledger/head
    零部分写，重放返回 `created`，4 个 COMMIT 后 `SIGKILL` 均完整 durable 且重放
    返回 `existing`。Edge 使用 `DELETE/FULL`，Standalone 使用 `WAL/FULL`，全部
    `integrity_check`、foreign-key check、readiness 与 exactly-once relation 通过；
12. Cluster 管理进程已在同一正式 PostgreSQL 18.4 arm64 HA 门完成
    `disable|enable × plan|propose|decide|execute` 共 8 个真实 Node `SIGKILL`
    窗口：每个阶段先提交 durable fact、fsync 低敏 marker 后被杀，再由全新进程以稳定
    identity 重放，8 次均返回 `existing`。该门发现并修复两处实际恢复顺序缺陷：
    plan runner 现在先按 `actionRef` 恢复并严格核对 action/Project/Package/requester/
    lifetime；execution runner 现在先从 exact dispatch 重建 event 并检查 durable
    receipt，只有 receipt 不存在时才 re-plan。新增 gate
    `pluginPackageLifecycleManagementProcessCrashesConvergeExactlyOnce=true`，
    8 个窗口及其 plan/receipt/head 经 `remote_apply`、timeline 1→2、旧主 fencing、
    `pg_rewind` 只读同步重入后仍一致，总 `gates.passed=true`；
13. ADR-0222 已完成 Workflow/Prompt generation-bound durable publication：
    SQLite `0079/0080` 与 capability v40，PostgreSQL `pg-0043` 与 control-core v42；
    append-only publication/head、exact replay、materialized/lifecycle/head
    readiness、双方言 transaction-bound writer、`absent` tombstone 与有界
    keyset pending-source 已实现；
14. Local 生命周期授权失败回滚测试与完整 local-sqlite 165/165 通过；正式
    PostgreSQL 18.4 arm64 HA 中 publication 从 v1 经四次 lifecycle transition
    原子推进到 v5，1 Workflow + 1 Prompt 经 `remote_apply`、promotion、fencing、
    `pg_rewind` 和 fresh control replicas 后保持一致，两个 automation gate 与总
    `passed` 均为 true；
15. caller-driven publication coordinator 已接入 Local/Cluster startup，顺序固定为
    Task publication → automation publication → Tool snapshot → admission；Local
    启动定向 14/14、Cluster 定向 11/11。实际 Workflow/Prompt execution、Prompt
    产品入口、Secret binding 以及 quarantine 下的 automation 收敛仍未完成，因此
    本 ADR 保持 Proposed。本次离线 HA 成功不代表 registry 安装门已完成。
16. 最终离线复验完成 20 个 workspace package 的干净构建与全量测试，零失败；
    SQLite current contract v40 已同步 Compose image label、preflight、rollout、
    evidence、OCI 与 physical Edge 审计。PostgreSQL 18.4 arm64 physical HA 在跳过
    image pull 的条件下再次通过，新增
    `pluginPackageAutomationRecoverySourceConverges=true`，总
    `gates.passed=true`。
