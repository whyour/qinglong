# ADR-0283：受认证的 Cluster Plugin Package Workflow Run 查询

- 状态：Accepted
- 日期：2026-08-07
- 关联：D-85、D-87、D-213、D-257、ADR-0046、ADR-0047、ADR-0048、ADR-0049、ADR-0052、ADR-0271、ADR-0279、ADR-0282

## 上下文

ADR-0282 已为本机部署提供 Project/Package/Workflow/Run 四元组绑定的低敏 Run 查询，但 Cluster 产品面仍只有
按 Project/Run 查询的通用路由。通用路由不能证明 Run 属于路径中的 Package 与 Workflow，而且其 Task、优先级、
execution origin/owner 等字段超出 Workflow 产品查询所需的最小权限。

Cluster 不能只在 route 层先查通用 Run、再查 Workflow admission：两个查询可能跨越不同数据库快照，且
Project Policy precheck 后 credential、Project 或最新 RoleBinding 可能已经变化。为 Local/Cluster 提供相同
产品语义时，必须复用同一低敏 schema，同时保留 PostgreSQL 的事务、审计与 fail-closed 错误边界。

## 决策

1. 在现有 Cluster Workflow route 集合增加
   `GET /api/v3/projects/{projectId}/packages/{packageName}/workflows/{workflowId}/runs/{runId}`，固定
   operation `workflow.run.read`、permission `run.read`。不修改既有通用 Run route。
2. Cluster capability 依赖 ADR-0282 的独立 `PluginPackageWorkflowRunInspectionRepository`，不把只读查询并入
   Workflow admission 写接口；PostgreSQL 在既有 Workflow administration subpath 提供单独实现，不新增
   workspace package 或公开 authority subpath。
3. PostgreSQL adapter 在一个 serializable transaction 内重新验证当前 API credential 版本与状态、绑定主体
   状态、active Project exact version、最新 active RoleBinding exact version；然后用同一 snapshot 精确关联
   immutable Workflow admission 与 Run，并同时匹配 Project、Package、Workflow、Run。
4. 查询只返回共享 schema `qinglong/plugin-package-workflow-run-inspection@v1`：目标身份、`found`、Run
   status/version/event sequence、低敏时间与取消事实、全部十种 StepRun 状态计数。计数总和必须等于 admission
   `step_count`；plan、definition digest、Task、Attempt、input/output、错误、Secret、lease 与 executor 均禁止
   出现在响应。
5. allowed `workflow.run.read` audit 与查询在同一数据库事务 append-only 提交。每次 HTTP 查询由服务端生成
   新 audit UUID；runtime 角色保持对审计表只有 INSERT、没有 SELECT，UUID 冲突 fail-closed，不通过读回审计
   扩大运行时权限。admission 缺失或任一目标身份不匹配均投影为相同的 `found=false`，HTTP 层统一返回
   `404 workflow_run_not_found`，不得暴露哪一段身份不匹配。
6. fence 漂移返回既有 `409 authorization_fence_changed`；无效存储事实、计数漂移、SQL 或内部 adapter 失败
   统一折叠为 `503 workflow_run_query_unavailable`，不得沿用 Workflow start conflict 响应泄露内部错误分类。
7. 本增量不新增 dependency、migration、表、连接池、timer、listener、watcher、状态机或部署单元；继续复用
   既有 Run/StepRun/Workflow admission 与 Project Policy authority。

## 被拒绝的方案

- **扩宽通用 Run route**：仍不能证明 Package/Workflow 身份，而且会把更多通用执行字段带入产品响应。
- **route 层拼接两个 repository 查询**：无法保证同一 PostgreSQL snapshot，也不能在读取点重验 credential 与
  最新 RoleBinding fence。
- **把方法加入 Workflow admission 写接口**：扩大高影响写 capability 的实现者与消费者，不符合只读端口边界。
- **为 Cluster 查询复制一套 DTO**：会使 Local/Cluster 的字段、状态枚举和脱敏规则漂移。
- **新增 package、表或 materialized projection**：没有新的部署、依赖或故障域边界，现有索引与不可变 admission
  已足以完成有界精确查询。

## 接受证据

- Cluster Control 定向测试覆盖共享 schema、低敏字段白名单、`workflow.run.read`/`run.read` 路由、缺失目标 404
  及生产 route allowlist。
- PostgreSQL 定向测试覆盖 serializable transaction、credential/Project/latest RoleBinding fence 顺序、四元组 SQL
  参数绑定、十种状态计数总和、allowed audit 同事务 append-only 提交、零审计 SELECT、cross-target 遮蔽与
  credential 撤销时读前回滚。
- Cluster PostgreSQL 278 pass/1 skip、Cluster Control 175 pass/2 skip；完整 19-package clean build/test 门与
  backend 1,110 tests（1,108 pass/2 skip）退出 0。Edge import、cluster dependency、package boundary、
  cluster deployment、worker deployment、local image 六项审计全部 compatible，workspace 保持 19 个 package。
- 十档本机制品 package/file/module closure 不变且全部 compatible；Cluster-only 增量没有进入 Local closure，
  每档比上一批小 103 bytes。最大 Standalone Application AI 为 5,988,971 bytes，距 6 MiB 仍有 302,485 bytes，
  RSS 低于分档预算。
- PostgreSQL 18.4 arm64 physical-streaming HA `gates.passed=true`；新增
  `pluginPackageWorkflowRunInspectionCommitsAtomically`、`MasksCrossTarget`、`SurvivesPromotion` 三项 gate
  全绿，且真实揭示并移除了 runtime 审计 SELECT。timeline 1→2、旧主先 fencing、`pg_rewind` 后只读同步
  rejoin、两个 fresh control replica ready，结束后 `ql3-ha-*` container/network/volume 零残留。
- 最终 clean 19-package build/test 门再次以 exit 0 通过；格式门覆盖全部修改代码与文档。刷新后 GitNexus 为
  42,658 nodes/96,876 edges/1,672 clusters/265 flows；PostgreSQL inspection class/method、Cluster capability、
  route factory、production composition、bootstrap 与独立错误映射七个可索引实现符号均为 LOW、0 affected
  process，最大为 bootstrap 的 2 direct/3 total。`detect_changes` unstaged/compare `develop` 分别报告
  12 files/31 symbols 与 14/34，均 low/0 affected process；但该命令不统计当前仍为 untracked 的 3.0 孵化树，
  因此这些数字只证明既有 tracked diff 的范围，R99 本身以逐符号 impact、package/backend/架构/制品与真实 HA
  gate 共同验收，不把 `detect_changes` 结果扩大解释为未跟踪文件的覆盖证明。

## 后续边界

- Step 明细、失败诊断、事件时间线与 Artifact 下载必须另行定义分页、字段级权限和脱敏协议，不能扩宽本 schema。
- 若未来增加推送或轮询，cadence、连接数、背压和低配/集群分档必须独立决策；本 ADR 只授权单次查询。
- 通用 Run route 与 Package-bound Workflow Run route 服务不同产品语义，不因字段相似而合并。
