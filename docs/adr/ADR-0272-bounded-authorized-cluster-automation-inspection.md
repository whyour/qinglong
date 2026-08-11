# ADR-0272：有界且授权原子的 Cluster Automation Inspection

- 状态：Accepted
- 日期：2026-08-04
- 关联：D-85、D-207、D-208、D-239、D-241、D-242、D-253、ADR-0259

## 上下文

Cluster Automation Management 已能通过独立的 TLS 1.3、mTLS、用途绑定 OIDC 进程发布
TaskDefinition 与 Trigger，但部署者无法通过同一受支持产品面检查当前定义或做有界列表。让用户直接查询
PostgreSQL、把读取能力放进常驻 `cluster-control`，或返回 Task/Trigger 的完整 spec，都会分别绕过
Policy/audit、扩大 runtime authority，或泄漏脚本正文和调度表达式。

读取也存在撤权竞态：仅在事务外完成 Policy precheck，然后读取 Task/Trigger，会允许 Project、RoleBinding
或 Identity 在两个动作之间变化。另一方面，Edge/Standalone 已有短生命周期本机入口，不能为了 Cluster
能力给路由设备增加 listener、Pool 或依赖闭包。

## 决策

1. 在既有 `ql3-automation-manage` 与 `ql3-automation-client` 中增加
   `task.inspect`、`task.list`、`trigger.inspect`、`trigger.list`；不新增 workspace package、进程、端口、
   Pool、migration、表、timer 或 watcher。
2. 所有读取继续要求 TLS 1.3、mTLS、`automation-management` 用途绑定 OIDC 与 strong User；Task 使用
   `task.read`，Trigger 使用 `trigger.read`。request 必须携带独立 UUID v4 `auditEventId`；列表上限复用
   Runtime Core 的 256 硬上限和稳定 keyset cursor，禁止 offset 与无界列表。
3. 新的 Runtime Core administration-source contract 只表达授权后的 inspect/list，不赋予 mutation。PostgreSQL
   adapter 在一个 SERIALIZABLE 快照事务中复验 exact active Project 与 latest active RoleBinding
   version、拒绝重复 auditEventId、
   读取 current head/一页结果、append-only 写 allowed audit，再提交。
4. PostgreSQL 读取必须通过独立只读 `PostgresTaskDefinitionSource`/`PostgresTriggerSource` 执行；management
   service 不取得裸 SQL，runtime/control 不取得 automation-manager 权限。事务失败、围栏变化、重复审计或
   存储损坏均失败关闭。
5. 产品响应只返回低敏 summary：稳定 ID、current revision、kind/enabled、content digest、更新时间与
   Trigger 的 Task pin；不返回 name、description、labels、spec、mutationId、createdAt、Principal、
   authenticationId、Policy reason 或 audit identity。不存在返回显式 `absent`，列表始终返回固定形状的
   `tasks|triggers/truncated/next`。
6. Edge/Standalone 保持现有短生命周期本机入口和零 Cluster 常驻成本。Cluster HA 继续使用既有两个
   management Pod、每 Pod Pool 2、port 8445 与已有数据库角色；本决策不把管理面装入路由 Profile。
7. 读取不是弱一致的“免费查询”：每次 inspect/list 都必须原子持久化 allowed audit。生产 HA 使用
   `synchronous_commit=remote_apply` 时，如果主库已提升但尚无同步备库，读取会在事务超时后失败关闭，
   不允许为了查询可用性绕过审计耐久性或降为异步提交。旧主完成 `pg_rewind`、以只读同步备库重入后，
   同一产品入口恢复成功；客户端应以新的 request/audit identity 重试。

## 被拒绝的方案

- **让 Cluster Control 直接读取 Automation 表**：扩大常驻执行面的数据库权限与攻击面。
- **读取不记 audit**：无法解释谁在何时枚举了可执行定义。
- **Policy precheck 后用独立查询读取**：存在 RoleBinding/Project/Identity 撤权竞态。
- **返回完整 Task/Trigger record**：会把脚本正文、参数、标签和 cron expression 带出管理边界。
- **新增只读管理 package/service**：现有用途隔离进程、身份、限流和 Pool 已是正确部署 owner。
- **offset pagination 或客户端指定 revision**：前者不稳定且可能无界，后者把当前 head 选择权外移。

## 验证要求

- Runtime contract 覆盖 exact-shape、UUID v4 audit identity、cursor/page hard bound 与 audit/fence binding；
- PostgreSQL adapter 证明 Project snapshot→RoleBinding fence→read→audit→COMMIT 顺序，
  fence 变化、重复 audit 与读取失败均无部分提交；
- management service/transport/client 覆盖四个命令、Policy permission、absent、分页与 content-free 输出；
- process composition 证明 disabled 仍不开 Pool/文件，enabled 只复用既有 Pool/HTTPS；
- 完整 package/back、dependency/package-boundary/edge/local-image、十档 artifact 与 PostgreSQL HA 门保持通过。

## 验证结果

- Runtime Core 435/435、Cluster PostgreSQL 275 pass/1 条件 skip、Cluster Admin
  256 pass/2 条件 skip；四个 inspection 命令的 exact-shape、分页、低敏结果、Policy 与事务失败关闭均已覆盖；
- 完整 19-package 门退出 0，后端为 1,095 pass/2 条件 skip/0 fail；十档 Edge/Standalone
  artifact 均为 compatible，最小 Edge 为 3,514,849 bytes/324 files/10,665,984 bytes RSS，最大
  Standalone Application AI 为 5,882,164 bytes/474 files/20,578,304 bytes RSS；
- dependency、package-boundary、edge-import、cluster-deployment 与 local-image 审计均为 compatible，
  workspace 保持 19 个 package；未增加 dependency、migration、表、进程、listener、port、Pool、timer
  或 watcher；
- PostgreSQL 18.4 arm64 physical-streaming HA 门总 `passed=true`：allowed audit 与读取结果原子提交、
  提升前 `remote_apply` 复制、无同步备库时读取失败关闭、timeline 1→2 promotion，以及旧主
  `pg_rewind`/同步重入后的 Task/Trigger inspect/list 恢复均已由独立 gate 证明；
- 受保护的 `ql3-cnpg-evidence-control-plane` 未被测试夹具纳入资源集合，启动状态、restart policy
  与 restart count 保持不变；本轮随机 `ql3-ha-*` 容器、网络与卷由 fixture 精确清理。

## 影响

Cluster 部署者可以通过同一用途隔离管理入口发现发布后的 Task/Trigger 当前状态，不再需要数据库直连。
能力成本只由显式启用 Cluster Automation Management 的部署承担；路由器与 Standalone 不增加常驻开销。
