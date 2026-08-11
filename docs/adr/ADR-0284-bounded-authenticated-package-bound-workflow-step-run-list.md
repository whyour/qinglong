# ADR-0284：有界且受认证的 Package-bound Workflow StepRun 列表

- 状态：Accepted
- 日期：2026-08-07
- 关联：D-85、D-87、D-213、D-257、ADR-0046、ADR-0047、ADR-0048、ADR-0049、ADR-0270、ADR-0271、ADR-0282、ADR-0283

## 上下文

ADR-0282 与 ADR-0283 已为 Local/Cluster 提供绑定 Project、Package、Workflow 与 Run 的低敏 Run 查询，
但只返回 StepRun 状态计数，不能回答哪些 Step 已经 ready、running、blocked 或 terminal。直接把全部 StepRun
塞进 Run 响应会让响应随 Workflow 规模无界增长，也会把 definition、输入输出、错误、Secret、lease 与
executor 等内部执行事实暴露给只有 `run.read` 的调用者。

Local 与 Cluster 必须共享同一字段、排序和 cursor 契约，同时保留 SQLite/PostgreSQL 各自的事务栅栏、审计
原子性和 cross-target 遮蔽语义。低配路由器不能因为列表能力增加常驻连接、轮询器、缓存、表或额外 package。

## 决策

1. 新增共享 schema `qinglong/plugin-package-workflow-step-run-list@v1`，产品操作固定为
   `workflow.step.list`，权限固定为 `run.read`。Local Owner CLI 在既有 `ql3-workflow` 命令协议提供对应
   操作；Cluster 增加
   `GET /api/v3/projects/{projectId}/packages/{packageName}/workflows/{workflowId}/runs/{runId}/steps`。
2. 每页默认 32、最大 64。HTTP 只接受 canonical positive decimal `limit`；cursor 由
   `after_step_key` 与 `after_step_run_id` 组成，必须同时存在或同时缺失。Repository 与共享 DTO 使用同一
   `(stepKey, id)` 升序 keyset，不提供 offset、全量读取或客户端自选排序。
3. 列表项只包含 `id`、`parentStepRunId`、`stepKey`、`kind`、`required`、`status`、`version`、
   `attemptCount`、`readyAtMs`、`startedAtMs`、`finishedAtMs`、`resultCode`、`createdAtMs`、`updatedAtMs`。
   definition ref/digest、input/output、approval request、error summary、mutation ID、StepRun digest、Secret、
   lease 与 executor 明确禁止进入 schema。
4. SQLite 在同一 `BEGIN IMMEDIATE` 内重验 credential、active Project exact version 与 latest active
   RoleBinding exact version，精确关联 immutable Workflow admission 与 Run，验证实际 StepRun 总数等于
   admission `step_count`，再执行有界 keyset 查询并提交 allowed audit。相同 audit ID 只允许语义完全一致
   的 replay。
5. PostgreSQL adapter 在同一 serializable transaction 内完成同等 fence、目标、计数与分页校验，并以
   append-only INSERT 提交 allowed audit。runtime role 对审计表保持 INSERT-only，不增加 SELECT、
   SECURITY DEFINER 或读回 replay 权限；HTTP 每次请求生成新的 audit UUID，冲突 fail-closed。
6. admission/Run 缺失或任一目标身份不匹配统一投影为 `found=false`，HTTP 返回
   `404 workflow_run_not_found`。授权 fence 漂移返回 `409 authorization_fence_changed`；计数漂移、非法
   存储事实、SQL 或内部 adapter 失败统一折叠为 `503 workflow_step_run_query_unavailable`。GET body 被拒绝。
7. 本增量不新增 workspace package、生产 dependency、migration、表、Pool、timer、listener、watcher、
   cache、状态机或部署单元；继续复用既有 Workflow admission、Run、StepRun 与 Security Audit authority。

## 被拒绝的方案

- **把 StepRun 数组加入 Run inspection**：使轻量 Run 查询随 Workflow 规模增长，也无法独立演进分页和字段权限。
- **offset 分页或一次返回全部 Step**：并发状态推进时会产生重复/遗漏，且不能给路由器设定稳定内存上界。
- **允许任意 sort/filter 或可配置最大页**：扩大 SQL 与索引面，使单次请求预算不可预测。
- **返回 definition、input/output 或错误详情**：`run.read` 不是调试、Artifact 或 Secret 权限；后续诊断必须另立协议。
- **route 层组合通用 Run 与 StepRun 查询**：跨 snapshot 不能原子证明 Package/Workflow 目标、授权 fence 和审计。
- **新建 Step 查询 package、projection 表或后台缓存**：不存在新的部署、依赖或故障域价值，反而扩大低配闭包。

## 接受证据

- Runtime Core 定向 6/6 覆盖 canonical input、严格字段白名单、排序/cursor、状态时间约束和非法结果失败关闭；
  Local Owner CLI 真实 SQLite 纵切面 3/3 覆盖两页 cursor、cross-target 遮蔽与 allowed audit。
- Cluster PostgreSQL 定向 6/6 覆盖 serializable fence、精确目标、StepRun 总数、keyset、同事务 audit、零审计
  SELECT 与 cross-target；Cluster Control 定向 11/11 覆盖 query/body、路由、schema 和错误映射。
- 完整 19-package clean build/test 门退出 0；Cluster PostgreSQL 281 tests（280 pass/1 skip）、Cluster
  Control 177 tests（175 pass/2 skip）、Local Owner CLI 101/101。backend 1,110 tests（1,108 pass/2 skip）
  退出 0；Edge import、cluster dependency、package boundary schema v2、cluster deployment、worker
  deployment 与 local image 六项审计全部 compatible，workspace 保持 19 个 package。
- 十档本机制品的 package/file/module closure 不变且全部 compatible。最大 Standalone Application AI 为
  6,011,292 bytes，距 6 MiB 上限仍有 280,164 bytes；默认 32/最大 64 的请求内分页不引入常驻缓存、轮询或
  连接，低配设备稳态模型不变。
- PostgreSQL 18.4 arm64 physical-streaming HA `gates.passed=true`；新增
  `pluginPackageWorkflowStepRunListCommitsAtomically`、`MasksCrossTarget`、`SurvivesPromotion` 三项 gate
  全绿。`remote_apply`、timeline 1→2、旧主先 fencing、`pg_rewind` 后只读同步 rejoin、两个 fresh control
  replica ready，结束后 `ql3-ha-*` container/network/volume 零残留。
- 强制纯索引刷新后的 GitNexus 为 42,705 nodes/97,077 edges/1,669 clusters/261 flows；共享 normalizer、
  SQLite/PostgreSQL repository、Local service/CLI、Cluster capability/route/production wiring 均为 LOW、
  0 affected process，最大为 `bootstrapClusterControlRuntime` 的 2 direct/3 total。`detect_changes`
  unstaged/compare `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process；当前 QL3
  孵化树仍为 untracked，因此这两个统计只覆盖 tracked diff，不能替代本批逐符号 impact、完整测试、制品与
  真实 HA 证据。

## 后续边界

- 单个 StepRun 的失败诊断、Artifact、日志、input/output 与 approval 读取必须使用更窄字段权限和独立协议，
  不能扩宽本列表。
- RunEvent 时间线需要独立 cursor、事件 payload 脱敏与保留策略，不复用 StepRun cursor。
- 如果未来增加推送、轮询、缓存或 stream，必须按 Router/Edge/Standalone/Cluster 分档重新预算连接、内存、
  背压与恢复语义；本 ADR 只授权一次性有界查询。
