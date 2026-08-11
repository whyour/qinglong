# ADR-0271：受认证的 Cluster Plugin Package Workflow 产品入口

- 状态：Accepted
- 日期：2026-08-04
- 关联 RFC：QL-RFC-0001 D-03、D-08、D-09、D-12、D-70、D-86、D-212、D-213、D-252
- 关联 ADR：ADR-0223、ADR-0227、ADR-0228、ADR-0229、ADR-0270

## 背景

ADR-0270 已为 Edge/Standalone 提供短生命周期 `ql3-workflow`，但 Cluster 部署用户仍只能通过测试或
repository 直接调用启动 Plugin Package Workflow。Cluster 已有 mTLS HTTP、API credential、Project
Policy、durable security audit、单一 scheduler cadence 与 HA PostgreSQL Pool；另建 Workflow 服务会
复制这些边界。`cluster-admin` 的数据库角色面向 Package 管理和批准执行，也不应被扩宽为 Run mutation
authority。

## 决策

### 1. Workflow 是 `cluster-control` 的必选生产路由

生产 allowlist 增加：

- `GET /api/v3/projects/{projectId}/packages/{packageName}/workflows`：
  `workflow.read` / `run.read`；
- `POST /api/v3/projects/{projectId}/packages/{packageName}/workflows/{workflowId}/runs`：
  `workflow.start` / `run.start`。

两条路由继续使用既有 mTLS surface、Bearer API credential、Project Policy 与 pre-body security audit。
User credential 当前明确是 `single_factor`，service subject 是 `service`；本 ADR 不把 API credential
虚报为 MFA。谁能读取或启动由既有 role matrix 决定。

### 2. 调用方只拥有幂等 identity

start body 只允许 schema、UUID v4 `planId`、`runId` 与每个 Step 的 `stepRunId`。publication、
installation、generation、lock/materialized revision/publication digest、Workflow definition digest、Task
definition ref/digest 和 immutable plan 均从当前 PostgreSQL durable publication/revision 派生。响应只返回
created/existing、plan/Run identity 与 receipt digest，不返回 Package/plan/Task digest 或业务输入。

### 3. 授权 fence 与 admission 同事务

`PostgresAuthorizedPluginPackageWorkflowAdmissionRepository` 在底层 Workflow admission 的同一个
SERIALIZABLE transaction 内：

1. 取得与 API credential administration 相同的 credential advisory lock；
2. 取得与 Identity administration 相同的 subject advisory lock；
3. 验证 latest active credential version、active Identity 与数据库时钟有效期；
4. 锁定 active Project exact version，并验证 latest active RoleBinding exact version；
5. 以 append-only INSERT 写一条 `workflow.start` mutation audit；
6. 验证 current install/lifecycle/quarantine/publication/revision/Workflow/Task snapshot；
7. 原子写 Run、RunEvent、StepRun、Step mutation、admission 与 receipt。

runtime 保持对 security audit 仅 INSERT、对 credential/Identity 仅 SELECT；不授予 audit SELECT/UPDATE、
credential mutation 或 Package executor authority。Project row lock 与 credential/identity advisory lock 复用
各自管理写路径的串行化键，避免撤权 TOCTOU。

首次 mutation audit 使用 `planId` 作为稳定 event/request identity。exact replay 先对 durable plan 的
Project/Package/Workflow/Run/Step identity 做精确比较，再重新验证当前 credential 与 Policy fence；首次
plan 与 audit 已在同一事务不可分割提交，因此 replay 不读取 append-only audit 表，也不产生第二条 mutation
audit。每次 HTTP 尝试仍由外层 admission pipeline 写独立 request audit。

### 4. 不增加部署拓扑

能力作为 `cluster-control` 与 `cluster-postgres` 的显式 subpath 接入既有 composition root。没有新增
workspace package、第三方 dependency、migration、table、process、listener、port、Pool、timer、watcher
或 scheduler cadence。Edge/Standalone 不导入 Cluster adapter，19-package 硬上限保持不变。

## 替代方案

- **复用 cluster-admin Package 管理进程**：拒绝。会混合 Package manager/executor 与 runtime Run authority。
- **HTTP Policy 允许后调用普通 admission**：拒绝。credential revoke、Identity disable 或 RoleBinding
  变化可穿过事务边界。
- **让客户端提交 publication digest 或完整 plan**：拒绝。会把 generation/digest authority 外移。
- **授予 runtime audit SELECT 以检查 replay**：拒绝。首次 plan/audit 原子不变量已足够，扩大审计读取面没有
  必要。
- **另建 Workflow API 服务和 Pool**：拒绝。它复制 authentication、Policy、HA 与连接预算。

## 验证

- Cluster Control：175 pass/2 条件 skip/0 fail；新增服务测试证明 server-derived plan 与 exact replay，
  路由测试证明 strict body、Policy fence 和 content-free response；
- Cluster PostgreSQL：authorized repository 测试证明 credential→Policy→audit→Package snapshot→Run 的事务
  顺序，以及 credential fence 变化时 audit/Run 零写入；
- 精确 dependency audit 46/46，cluster dependency、package boundary、edge import 均无 finding；workspace 19；
- 完整 19-package 门退出 0；后端 1,095 pass/2 条件 skip/0 fail；local-image audit 无 finding；
- 十档本机制品均 `compatible=true`；Edge 为 3,506,692 bytes/324 files/10,846,208 bytes RSS，最大
  Standalone Application AI 为 5,874,007 bytes/474 files/20,692,992 bytes RSS，未放宽既有预算；
- PostgreSQL 18.4 arm64 physical HA `gates.passed=true`，新增
  `pluginPackageWorkflowAuthorizedAdmissionCommitsAtomically` 与
  `pluginPackageWorkflowAuthorizedAdmissionSurvivesPromotion` 均为 true；
- HA 同时完成 `remote_apply`、timeline 1→2、旧主 fencing、`pg_rewind` 只读重入和两个 fresh control
  replicas；本轮隔离 `ql3-ha-*` container/volume/network 零残留，受保护控制面容器状态未改变。

## 影响

Cluster 部署用户第一次能通过正式 `/api/v3` 产品面发现并启动 Plugin Package Workflow，同时保持
server-derived generation authority、append-only audit、最小数据库权限与故障转移后 exact replay。UI、
MCP facade、OIDC/MFA 与外部 API gateway 是后续独立入口，不改变本 ADR 的 admission contract。
