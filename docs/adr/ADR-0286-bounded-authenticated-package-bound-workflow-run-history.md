# ADR-0286：有界且受认证的 Package-bound Workflow Run 历史列表

- 状态：Accepted
- 日期：2026-08-07
- 关联：D-85、D-87、D-213、D-257、ADR-0046、ADR-0047、ADR-0048、ADR-0049、ADR-0267、ADR-0270、ADR-0271、ADR-0276、ADR-0282、ADR-0283、ADR-0284、ADR-0285

## 上下文

ADR-0282 已能按已知 Run ID 查询单个 Package-bound Workflow Run，ADR-0284/0285 能继续读取其 StepRun 与
RunEvent，但产品调用者仍无法回答“这个 Package 的这个 Workflow 最近运行过哪些 Run”。要求调用者预先保存
Run ID 会让 Run 详情能力不可发现；复用通用 Run 列表又无法证明 Package/Workflow admission 归属，并可能暴露
Task、Attempt、plan、错误、Artifact、Secret、lease 或 executor 信息。

Local 路由设备与 Cluster 节点必须共享同一低敏、稳定、有界的发现协议。列表不能执行无界 count，不能引入缓存、
轮询、后台索引器或新服务；授权、目标绑定、读取与 allowed audit 必须保持一个数据库事务。并发 admission 要求
分页在相同排序键下不重复、不回退。

## 决策

1. 新增共享 schema `qinglong/plugin-package-workflow-run-list@v1`，产品操作固定为 `workflow.run.list`，权限
   固定为 `run.read`。Local Owner CLI 在既有 `ql3-workflow` 协议增加该操作；Cluster 增加
   `GET /api/v3/projects/{projectId}/packages/{packageName}/workflows/{workflowId}/runs`。
2. 默认页大小 32、最大 64。排序固定为 `(admittedAtMs DESC, runId DESC)`；cursor 必须同时包含 canonical
   non-negative `after_admitted_at_ms` 与 `after_run_id`，两半缺一、非 canonical 数字或无效 ID 都在存储前拒绝。
   adapter 只读取 `limit + 1`，不执行 `COUNT(*)`。
3. item 只允许 `runId`、`status`、`version`、`eventSequence`、`stepCount`、`admittedAtMs`、`queuedAtMs`、
   `startedAtMs`、`finishedAtMs`、`cancelRequestedAtMs` 与 `cancelReason`。plan/receipt/definition digest、Task、
   StepRun、Attempt、payload、input/output、错误、Secret、Artifact、lease 与 executor 全部排除。
4. 结果必须严格 newest-first、Run ID 唯一；`truncated=true` 时 `next` 必须精确等于本页末项位置，terminal page
   必须为 `next=null`。cursor 后每一项都必须严格更旧，禁止客户端重排、offset 或隐式时间窗口。
5. SQLite 在同一 `BEGIN IMMEDIATE` 内重验 credential、active Project exact version 与 latest active
   RoleBinding exact version，以 admission/Run join 精确绑定 Project、Package、Workflow，执行有界查询并提交
   allowed audit；相同 audit ID 只允许语义完全相同的 replay。
6. PostgreSQL adapter 使用同一 serializable transaction 重验 current credential/identity、Project 与最新
   RoleBinding，执行相同 join/keyset 查询，再用 runtime role 的 INSERT-only authority 追加 audit。HTTP 每次请求
   生成新的 UUID v4 audit ID；任何冲突或非 canonical 输入 fail-closed。
7. 空集合始终返回成功空页，Cluster HTTP 为 200；这包括真实无运行记录和 cross-target Package/Workflow，避免用
   列表响应枚举目标存在性。授权 fence 漂移返回 409，非法 query/GET body 返回 400，其余数据库或一致性失败
   返回 503。
8. SQLite migration `0085-plugin-package-workflow-run-list-index` 与 PostgreSQL migration
   `pg-0053-plugin-package-workflow-run-list-index` 都增加
   `(project_id, package_name, workflow_id, admitted_at_ms, run_id)` 索引。Local capability 升至 v43/86 migrations，
   PostgreSQL `control-core` 升至 v52/53 migrations；旧 schema 必须由 readiness 拒绝，不能退化为全表扫描。
9. 本增量不增加 workspace package、生产 dependency、表、Pool、timer、listener、watcher、cache、状态机或部署
   单元。能力进入既有 runtime-core、local-sqlite/local-admin/local-owner-cli 与 cluster-postgres/
   cluster-control owner。
10. package 内部源码布局与 package 边界分别治理：workspace 保持 19 个 package；共享协议实现不得再借
    `shared_protocol` 全平铺，根层只保留公开入口。全 workspace 当前无 single-source package，只有
    `local-profile` 与 `local-adopted-profile` 两组纯公开 Profile entrypoint 浅层例外。

## 被拒绝的方案

- **要求调用者保存 Run ID**：详情可读但不可发现，不构成可用产品面。
- **复用通用 Run 列表或返回完整 Run aggregate**：无法证明 Package/Workflow admission 归属，并扩大低敏读取权限。
- **把 StepRun、RunEvent 或错误摘要嵌入列表**：页面成本随执行规模增长，破坏列表的固定字段与资源上限。
- **offset、单独时间戳 cursor 或客户端排序**：并发 admission 下会重复、遗漏或产生不确定同时间排序。
- **先查目标存在性再查列表**：增加竞态和目标枚举侧信道；空集合统一 200 更安全。
- **依赖旧索引或允许 readiness 降级**：Package/Workflow 数量增长后会扫描不相关 admissions，不适合路由设备或
  多租户 Cluster。
- **为列表新建 package、projection 表、缓存或服务**：当前 admission 表和精确复合索引已经满足 bounded read，
  没有新的部署、权限或依赖隔离价值。

## 接受证据

- Runtime Core、Local SQLite/Admin/Owner CLI、Cluster PostgreSQL/Control 覆盖严格输入、字段白名单、newest-first
  keyset、空页 anti-enumeration、cross-target 遮蔽、授权 fence、同事务 audit 与 HTTP 400/409/503 映射。
- 完整 19-package clean build/test 退出 0；Cluster PostgreSQL 285 pass/1 条件 skip、Local Owner CLI 101/101。
  backend 1,110 tests 为 1,108 pass/2 skip/0 fail。
- Edge import、cluster dependency、package boundary schema v2、cluster deployment、CloudNativePG 与 local image
  六项审计全部 compatible；package ledger 为 19/19、`singleSourcePackages=[]`、两个纯入口 shallow package、
  `findings=[]`。
- 十档本机制品全部 compatible。最小 Edge/Standalone 为 3,614,826/3,614,874 bytes；最大 Standalone
  Application AI 为 6,049,841 bytes，距 6 MiB 上限 241,615 bytes，RSS 在对应 16/24 MiB 门内。
- PostgreSQL 18.4 arm64 physical-streaming HA `gates.passed=true`；
  `pluginPackageWorkflowRunListCommitsAtomically`、`MasksCrossTarget`、`SurvivesPromotion` 三项 gate 全绿。
  promotion 后同一有界页面验证严格 newest-first 并定位目标 succeeded Run；timeline 1→2，旧主先 fencing，
  `pg_rewind` 后只读同步 rejoin，两个 fresh control replica ready，结束后 `ql3-ha-*` container/network/volume
  零残留。
- 强制刷新后的 GitNexus 为 42,809 nodes/97,469 edges/1,674 clusters/261 flows。共享两个 Run-list
  normalizer 为 LOW/0 impacted，SQLite/PostgreSQL repository 各为 LOW、1 direct/0 affected process；HA 主库与
  promotion 验证函数均为 LOW、1 direct，只命中受审 Docker HA 流程。`detect_changes` all/compare `develop`
  分别为 12 files/31 symbols 与 14/34，均 low/0 affected process；QL3 孵化树仍大部分 untracked，因此该
  统计只作补充，不能替代逐符号 impact、完整测试、制品和真实 HA 证据。

## 后续边界

- Run 详情、StepRun、RunEvent、Artifact、错误诊断和日志继续使用独立 schema/permission，不能扩宽本列表。
- 若需要时间范围、状态筛选或实时订阅，必须分别证明索引、cursor、anti-enumeration、连接/背压和 Edge 资源预算；
  本 ADR 只授权一次性 Package/Workflow 精确目标下的 newest-first 有界查询。
- 新增列表类能力优先使用既有 owner 的领域 subpath；文件数或概念名不能成为第 20 个 workspace package 的理由。
