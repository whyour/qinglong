# ADR-0285：有界且受认证的 Package-bound Workflow RunEvent 时间线

- 状态：Accepted
- 日期：2026-08-07
- 关联：D-85、D-87、D-213、D-257、ADR-0046、ADR-0047、ADR-0048、ADR-0049、ADR-0087、ADR-0267、ADR-0270、ADR-0271、ADR-0276、ADR-0282、ADR-0283、ADR-0284

## 上下文

ADR-0282 至 ADR-0284 已提供 Package-bound Workflow 的 Run 摘要与 StepRun 列表，但调用者仍不能在不读取
内部执行记录的前提下回答“这个 Run 依次发生了什么”。既有通用 `RunRepository.listEvents` 返回完整
`RunEventRecord`，其中包含任意 payload、dedupe key、actor、Attempt、错误与内部引用；直接暴露它会把
`run.read` 扩大为调试、审计、Artifact 与 Secret 读取权限。

RunEvent 是只追加且由 Run 的 `event_sequence` 分配序号的事实流。Local 与 Cluster 需要共享同一有界、连续、
低敏时间线协议，同时保留 SQLite/PostgreSQL 的事务授权栅栏与审计语义。路由器档位不能因为增加时间线而引入
后台轮询、缓存、长连接或新的发布包。

本增量也复核了 workspace package 粒度。`src` 平铺或文件较少本身不是 package 边界：边界必须由独立协议、
依赖方向、产物裁剪或部署权威证明。当前 19 个 package 中仅 `local-command-file` 是单文件包；它是被三个生产
消费者共享的私有命令文件协议。`local-profile` 与 `local-adopted-profile` 是两个显式 Profile 公共入口集合。
三者继续作为机器账本中的可撤销浅层例外，不能据此扩张“一文件一包”模式。

## 决策

1. 新增共享 schema `qinglong/plugin-package-workflow-run-event-list@v1`，产品操作固定为
   `workflow.event.list`，权限固定为 `run.read`。Local Owner CLI 在既有 `ql3-workflow` 协议提供对应操作；
   Cluster 增加
   `GET /api/v3/projects/{projectId}/packages/{packageName}/workflows/{workflowId}/runs/{runId}/events`。
2. 每页默认 32、最大 64；`limit` 必须是 canonical positive decimal，`after_sequence` 必须是 canonical
   non-negative decimal。事件严格按 `sequence` 升序读取；数据库唯一约束 `(run_id, sequence)` 已给出单值
   cursor，不增加复合 cursor、offset、客户端排序或无界计数。
3. 响应只包含目标 Project/Package/Workflow/Run、`afterSequence`、同 snapshot 的 `headSequence`，以及事件
   `id`、`sequence`、`type`、`stepRunId`、`createdAtMs`。payload、dedupe key、actor/actorId、Attempt、错误、
   Secret、Artifact、input/output、lease 与 executor 明确禁止进入 schema。
4. 每页必须从 `afterSequence + 1` 连续开始且不能越过 `headSequence`。`truncated=true` 时
   `nextAfterSequence` 必须等于本页最后序号；terminal page 必须恰好结束于同一 snapshot 的 head。该契约能
   区分“本页结束”和“该 snapshot 已完整”，不执行无界 `COUNT(*)`。
5. SQLite 在同一 `BEGIN IMMEDIATE` 内重验 credential、active Project exact version 与 latest active
   RoleBinding exact version，精确关联 immutable Workflow admission 与 Run，读取 head、执行 limit+1 查询并
   提交 allowed audit；相同 audit ID 只允许语义完全一致的 replay。
6. PostgreSQL adapter 在同一 serializable transaction 内重验 current credential/identity、Project 与最新
   RoleBinding，精确绑定目标、读取 head 与有界事件，再以 append-only INSERT 提交 allowed audit。runtime role
   保持审计 INSERT-only；HTTP 每次请求使用新 audit UUID，冲突 fail-closed。
7. admission/Run 缺失或任一目标身份不匹配统一投影为 `found=false`，HTTP 返回
   `404 workflow_run_not_found`。授权 fence 漂移返回 `409 authorization_fence_changed`；其余存储、连续性或
   adapter 失败统一为 `503 workflow_run_event_query_unavailable`。GET body 被拒绝。
8. 本增量不新增 workspace package、生产 dependency、migration、表、索引、Pool、timer、listener、watcher、
   cache、状态机或部署单元。新增能力留在既有 runtime-core、local-sqlite/local-admin/local-owner-cli 与
   cluster-postgres/cluster-control 边界内。
9. package 合并不以文件数机械触发。浅包只有同时失去独立协议/公共入口所有权、依赖方向价值、产物裁剪价值，
   且合并不会扩大 Edge 闭包时才可合并；任何新增浅包必须更新 package boundary ledger 并证明生产消费者与
   source-root hard cap。目录美观不是 package 或部署边界。

## 被拒绝的方案

- **直接暴露通用 RunEvent DTO**：会泄露 payload、actor、Attempt 与内部引用，并把 `run.read` 扩大为多种权限。
- **把事件嵌入 Run 或 StepRun 响应**：使轻量查询无界增长，并破坏独立分页、字段权限与缓存策略演进。
- **offset、时间戳 cursor 或一次返回全部事件**：并发追加时可能重复或遗漏，也不能证明同一 head 的完整性。
- **先读 Run 再在另一个事务读事件**：不能原子证明授权 fence、Package/Workflow 目标、head 与 audit。
- **新建事件 projection 表、缓存、stream 或 package**：当前只追加序列与现有索引已满足查询，不存在新故障域或
  发布边界价值。
- **按文件数合并全部浅包**：会让共享命令协议反向依赖 CLI/应用实现，或让 adopted Profile 进入默认 Edge 闭包；
  文件更少不等于依赖更简单。

## 接受证据

- Runtime Core、真实 SQLite Local Owner CLI、Cluster PostgreSQL adapter、Cluster capability/route 与 production
  纵切面定向 30/30，覆盖 canonical cursor、连续页、严格字段白名单、cross-target 遮蔽、授权 fence、同事务
  audit 与 HTTP 错误映射。
- 完整 19-package clean build/test 与 backend 1,110 tests（1,108 pass/2 skip）退出 0；Edge import、cluster
  dependency、package boundary schema v2、cluster deployment、worker deployment 与 local image 六项审计全部
  compatible。
- package boundary ledger 证明 workspace 仍为 19 包、hard cap 19；仅 1 个 single-source package 与 3 个
  shallow package，分别标记为 `shared_protocol`/`public_entrypoints`，并具备明确生产消费者。审计会拒绝无理由
  单文件包、未声明 package、root role 不实与 source-root hard cap 增长。
- 十档本机制品全部 compatible。最小 Edge 为 3,597,913 bytes/324 files，Edge Application AI 为
  6,028,257 bytes/475 files，均在各自 4 MiB/6 MiB 与 RSS 上限内；细粒度 package 没有被无差别装入路由器
  闭包。
- PostgreSQL 18.4 arm64 physical-streaming HA `gates.passed=true`；新增
  `pluginPackageWorkflowRunEventListCommitsAtomically`、`MasksCrossTarget`、`SurvivesPromotion` 三项 gate 全绿。
  `remote_apply`、timeline 1→2、旧主先 fencing、`pg_rewind` 后只读同步 rejoin、两个 fresh control replica
  ready，结束后 `ql3-ha-*` container/network/volume 零残留。
- 强制纯索引刷新后的 GitNexus 为 42,747 nodes/97,254 edges/1,667 clusters/261 flows；共享 normalizer、
  SQLite/PostgreSQL repository、Local service/CLI、Cluster capability/route/production wiring 均为 LOW、
  0 affected process，最大为 `bootstrapClusterControlRuntime` 的 2 direct/3 total。`detect_changes`
  unstaged/compare `develop` 分别为 12 files/31 symbols 与 14/34，均 low/0 affected process；当前 QL3 孵化树
  仍为 untracked，因此统计只覆盖 tracked diff，不能替代逐符号 impact、完整测试、制品与真实 HA 证据。

## 后续边界

- 事件 payload、失败诊断、日志与 Artifact 必须使用独立权限和独立协议，不能扩宽本时间线。
- 实时 stream、SSE/WebSocket、轮询器或缓存若被提出，必须重新证明 Router/Edge/Standalone/Cluster 的连接、
  背压、断线恢复与内存预算；本 ADR 只授权一次性有界查询。
- 浅包例外应在消费者消失或产物闭包可安全收敛时复审，但不能为了减少 package 数牺牲依赖方向。
