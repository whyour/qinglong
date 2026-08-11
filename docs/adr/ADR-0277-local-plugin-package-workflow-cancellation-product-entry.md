# ADR-0277：本机 Plugin Package Workflow 取消产品入口

- 状态：Accepted
- 日期：2026-08-07
- 关联：D-207、D-212、D-213、D-251、D-257、ADR-0228、ADR-0270、ADR-0276

## 上下文

本机 Plugin Package Workflow 已经具备 generation-bound plan、原子 admission、StepRun-aware Task
执行、application 单 cadence 和整条 Workflow cancellation convergence。`ql3-workflow` 也已经开放
`workflow.inspect` 与 `workflow.start`。但产品用户仍无法请求取消：现有测试只能直接更新 `Runs` 的
`cancel_requested_at_ms/cancel_reason`，这会绕过 credential、Project Policy、RoleBinding fence、
durable audit 与幂等命令协议。

底层“知道如何安全收敛”而产品面“只能直写 SQL”不是可用闭环。另一方面，取消请求只表示停止意图，
不能把 leased/starting/running Attempt 或 running StepRun 直接改成 terminal；它们仍必须由 Worker
completion、可信 recovery 或本机执行控制链收敛。

实现该入口时，撤权测试还暴露出既有 Project Policy latest-head 读取缺陷：RoleBinding 查询按版本倒序
后使用 `LIMIT 2`，再交给只接受零或一行的解析器。正常出现第二个 append-only 版本时，所有复用该
Repository 的入口都会把授权变化误报为 storage unavailable，而不是读取最新 binding。

## 决策

1. 既有 `ql3-workflow` private-command 产品入口增加 schema v1 的 `workflow.cancel`，不新增 CLI、
   workspace package、dependency、migration、表、connection、listener、timer 或 watcher。
2. command 只携带 Project、Package、Run、mutation、RunEvent、request 与 audit identity；取消原因固定由
   服务端派生为 `user`，调用者不能提交 `shutdown`、`timeout` 或其他内部 authority。
3. 必须先建立当前强 User credential，再以 `run.stop` 执行 Project Policy precheck。SQLite adapter 在
   同一个 `BEGIN IMMEDIATE` 内重新验证 credential、Project version 与 latest RoleBinding exact fence，
   并确认 Run 属于指定 Project/Package 的 durable Workflow admission。
4. 首次非终态请求在同一事务中更新 Run cancel intent/version/event sequence、追加
   `run.cancel_requested` 和 allowed `workflow.cancel` security audit。任一写入、围栏或 identity 冲突
   整体回滚。
5. 同一 command response loss 通过 audit identity、mutation dedupe、RunEvent identity/actor/payload 与
   durable audit time 返回 `existing`，不重复写 Event。新的命令面对既有 intent 返回
   `already_requested`；面对 terminal Run 返回 `already_terminal`。这些状态都不宣称 Workflow 已停止。
6. 输出只包含 Project/Package/Workflow/Run identity、Run status/version/event sequence 与低敏取消状态；
   不输出 Policy fence、authentication、plan digest、路径、Task spec、Secret 或执行 handle。
7. `LocalSqliteRunRepository.resolveProjectPolicy` 的 latest binding 查询改为 `ORDER BY version DESC
   LIMIT 1`。这恢复 append-only RoleBinding 的 head 语义，不改变角色矩阵、写入历史或 fence contract。
8. 本切片只接受 Local 产品取消入口。leased/starting/running 的在途停止仍由现有 application control、
   completion/recovery 收敛；Cluster 继续使用独立 `/runs/{runId}/cancellation` 产品面和 PostgreSQL
   authority，不复用 POSIX command file。

## 被拒绝的方案

- **CLI 直接更新 `Runs`**：绕过认证、Policy、审计、事务围栏和目标 Workflow 归属。
- **调用 cancel 即把 Run/StepRun 改 terminal**：伪造外部执行已经停止，允许迟到副作用越过终态。
- **为 cancellation 再拆 package**：同一 Workflow 产品、Repository 与 application closure 没有独立
  部署或重依赖价值，会重新制造 D-207 已禁止的微包。
- **把 command time 当幂等语义**：响应丢失后重试时间必然变化；durable audit time 才是首次 winner，
  replay 只比较稳定 command/actor/fence 语义。
- **继续使用 `LIMIT 2` 检测 RoleBinding 冲突**：append-only 历史存在两行是正常状态，不是重复 head；
  唯一性由 `(project, subject, version)` 与最新版本语义保证。

## 接受证据

- Runtime Core 436/436、Local SQLite 192/192、Local Admin 83/83、Local Owner CLI 101/101；
- 真 SQLite 产品测试覆盖 `accepted`、exact `existing`、新命令 `already_requested`、单一
  `run.cancel_requested`、allowed audit、低敏 CLI 输出，以及 Owner→Viewer 第二版本后的 `run.stop`
  拒绝与 Run/Event 零变化；
- 完整 19-package 门退出 0，完整后端门退出 0；edge import、cluster dependency、package boundary、
  cluster deployment、worker deployment、local image 六项审计全部 compatible；
- 十档 artifact 全 compatible：Edge/Standalone 3,547,572/3,547,620 bytes，Adopted
  4,146,274/4,146,358，Application 4,633,643/4,633,787，AI 4,882,494/4,882,554，
  Application AI 5,968,637/5,968,793；最大档距 6 MiB 仍有 322,663 bytes；
- PostgreSQL 18.4 arm64 physical-streaming HA `gates.passed=true`，`remote_apply`、timeline 1→2、
  旧主 fencing、`pg_rewind` 只读同步重入、两个 fresh control replica 与既有 remote Workflow
  cancellation promotion gate 全绿；`ql3-ha-*` container/network/volume 零残留。
- 刷新后 GitNexus 为 42,502 nodes/96,450 edges/1,672 clusters/261 flows；取消产品链的新增与既有
  入口均为 LOW，`resolveProjectPolicy` 保持 MEDIUM、11 direct/0 affected process；`detect-changes`
  all/compare `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process。

## 剩余边界

- Linux `/proc` 下 running Workflow Task 的真实 stop→completion/recovery→parent terminal 门仍由既有
  Local Application 条件测试覆盖，固定路由设备断电/闪存证据仍是发布门；
- 本 ADR 不新增 Cluster Workflow-specific cancel route，也不替代 Cluster 已有通用 Run cancellation、
  Worker Lease control、attestation 与跨 promotion 证据；
- UI/HTTP/MCP 对本机取消的远程暴露仍需独立身份、transport、rate-limit 与存在性屏蔽评审。
