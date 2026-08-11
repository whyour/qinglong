# ADR-0141：Profile-neutral Approved Action 与 Package 准入边界

- 状态：Accepted（领域契约、`package.manage` Policy、SQLite/PostgreSQL durable
  authority、immutable proposal、dispatch execution/start barrier、Package 原子
  准入回执、产品 dispatcher/Package handler、准入强绑定、Profile 管理组合与
  transport-neutral 认证后管理 facade 已实现；ADR-0149 已完成原子资源 generation
  identity/source，HTTP/CLI/UI 与资源语义 materializer 待完成）
- 日期：2026-07-25
- 关联 RFC：QL-RFC-0001 D-05、D-08、D-09、D-29 至 D-33、D-130 至
  D-139

## 上下文

Plugin Package 的 Manifest、PackageLock、SQLite/PostgreSQL installation
repository、OCI/offline staging、POSIX/Kubernetes pointer publisher 和启动恢复已经具备
可执行合同，Approved Action 到 queued installation 的原子 admission consumer、
immutable proposal repository、dispatch execution/start barrier、调用方驱动的产品
dispatcher/Package handler、两个方言的强绑定 admission transaction 与 Profile 管理
组合及 ADR-0142 的认证后管理 facade 也已完成；生产安装入口当前缺少的是真实
HTTP/CLI/UI authentication/transport adapter 与基于 ADR-0149 active generation 的
资源语义 materializer。

现有 2.x `back/runtime` ApprovalRequest 实现有 durable dispatch 和 start barrier，
但它依赖 legacy Sequelize 表、旧 Project Policy 类型和旧进程 lifecycle。让 3.0
Package 安装直接适配该实现会违反 3.0 新领域不得继续写入旧架构的边界，也会让
cluster-control 反向依赖 SQLite/Sequelize。

早期的 `PluginPackageApprovedActionConsumer.consume(lock)` 只是安装 coordinator
前置端口。若产品层把它实现成内存校验或一次性标记，会留下：

1. 审批已标记消费但 queued installation 尚未耐久化；
2. 调用进程崩溃后没有可发现的 dispatch 继续 exact replay；
3. Package stage/activation 与通用 Approved Action start barrier 的责任不清；
4. 单 owner 路由设备若强制“四眼审批”将永远无法安装 Package；
5. 集群若默认允许自批，又无法表达 separation-of-duty。

因此必须先建立 3.0 profile-neutral Approval 契约，再实现两个方言的同语义 authority，
不能用一个“总是成功”的 consumer 打通产品入口。

## 决策

### 1. Approval 契约进入既有 runtime-core

新增 `@qinglong/runtime-core/approved-action` 显式 subpath，不新增 workspace package
或第三方依赖，也不从 edge 禁用路径装配 Repository、timer、socket 或数据库。

v1 契约固定：

- `qinglong/approval-request@v1`；
- `qinglong/approved-action-dispatch@v1`；
- canonical `permission/actionType/actionRef/actionDigest/previewDigest`；
- `pending → approved | rejected → consumed`，version 固定为 1/2/3；
- request、decision、consumption 三次 Project/RoleBinding fence；
- 24 小时最大生命周期；
- decision/consumption mutation identity 和 exact replay；
- immutable dispatch 同时携带审批人、强认证 ID/assurance、批准时间、过期时间和最终
  consumption fence。

Action digest 或 preview digest 不是执行授权；只有 durable consumed request 产生的
immutable dispatch 才能进入后续执行。

### 2. Package 使用独立 Policy 权限

Project Policy 新增 `package.manage`：

- owner、admin 可直接发起 Package 管理；
- operator、viewer 不可管理 Package；
- Agent 即使具备 admin binding，也只能得到 `require_approval`；
- Tool definition 可声明该权限，但仍必须通过统一 Policy/fence 规划。

不复用 `project.manage`，避免为了安装 Package 同时授予 Project 生命周期管理权限。

### 3. Edge 与 Cluster 共用记录，选择不同 ceremony

ApprovalRequest 显式记录 decision mode：

- `human_confirmation`：允许请求者本人在独立 decision mutation 中确认，但必须是
  active User principal，并具备 `local_console`、`multi_factor` 或 `hardware`
  assurance。该模式服务单 owner 的 edge/standalone；
- `separation_of_duty`：除同样的强认证要求外，审批 User 必须与 requester 不同。
  cluster 部署可由 Project/组织 Policy 强制选择该模式。

`single_factor`、service principal、过期 principal 和非 User decision 全部失败关闭。
同一底层记录格式不按 Profile 分叉；差异只存在于受信管理 composition 选择的 mode。

### 4. Durable dispatch 只授权原子准入

Package Approved Action 的业务结果定义为“把一份 digest-bound PackageLock 与 queued
installation 原子准入”，而不是在 Approval transaction 内完成 OCI 下载、解包、
Kubernetes publish 或资源激活。

完整产品链必须按以下顺序实现：

1. 管理入口先持久化可由 `actionRef` 解析的 immutable install proposal；
2. ApprovalRequest 绑定 proposal 的 action/preview digest；
3. human decision 与消费生成 durable dispatch/execution；
4. dispatcher 在外部副作用前提交 start barrier；
5. 同一数据库 transaction 重新验证 dispatch execution fence、proposal、Policy
   fence，并原子写入完整 PackageLock、queued installation、head、mutation ledger、
   Package admission receipt 和低敏 security audit；
6. dispatcher 以 receipt 完成；Plugin Package recovery 再从 queued 状态有界收敛
   staging/activation。

这样，start 后响应丢失只能由 Package admission receipt 和 installation durable fact
裁决；不会再次执行审批，也不会把长时间网络/Kubernetes I/O 放进数据库 transaction。

现有 `PluginPackageInstallationCoordinator` 已删除注入式 consumer，改为调用
`PluginPackageAdmissionRepository.admit()`；SQLite 与 PostgreSQL adapter 都能在单一
事务内提交 PackageLock、queued installation、head、mutation、admission receipt 与
audit，coordinator 只在获得 admission receipt 后进入 stage，并对相同 dispatch/lock
做 exact replay。底层 installation repository 仍保留给恢复和契约测试，但产品
coordinator 不得绕过 admission repository 直接 `create()`。

新增 `qinglong/plugin-package-install-proposal@v1` 与
`qinglong/approved-action-execution@v1` 纯契约及两个方言的显式 repository subpath。
consume 现在把 immutable dispatch 与 `pending` execution baseline 在同一事务提交；
只有 pre-start lease 可以释放或接管，`executing` 过期必须进入
`recovery_required`，不得盲重放。proposal 持久化同时重新验证 Project/RoleBinding
Policy fence，并与 `plugin_package.propose` audit 原子提交。

`@qinglong/runtime-core/approved-action-dispatcher` 现在提供无 timer、调用方驱动、
每次最多 64 条的通用 dispatcher。它固定执行 list → claim → inspect → durable start
barrier → handler → complete；只允许 start 前 retry，start 后异常转
`indeterminate/blocked`，且 start/complete response loss 都先读取 durable execution
收敛，不会重做 handler 副作用。`plugin-package-approved-action` handler 重新读取
proposal、确定性派生 installation/mutation/audit identity，并只调用原子 admission；
admission COMMIT 响应丢失时以 receipt + installation exact replay 收敛。

SQLite `BEGIN IMMEDIATE` 与 PostgreSQL `SERIALIZABLE` admission transaction 都会重新
读取 durable proposal、当前 `executing` execution 和 Project Policy fence。除请求内
exact execution snapshot 外，adapter 还必须用事务内数据库时钟确认 lease 在观察时
仍有效，不能信任调用者提供的历史时间；已有 receipt 的 exact replay 不再要求旧
execution 仍处于 executing，因为 replay 本身不产生新副作用。

这仍不等于公开产品入口已经开放：dispatcher 和 ADR-0142 管理 facade 只从
`@qinglong/local-admin/package-approved-action` 和
`@qinglong/cluster-admin/plugin-package-approved-action` 及对应
`plugin-package-management` 显式管理子入口装配，不从 package root、常驻 runtime、
cluster-control 或 worker 导出。真实 HTTP/CLI/UI 在 credential/local-console/MFA、
rate limit、transport idempotency 与资源语义 materializer 完整装配前必须继续
失败关闭。

### 5. Profile 资源边界

- edge/standalone：复用唯一 Node 24 SQLite authority、调用方驱动、单连接、短
  `BEGIN IMMEDIATE`；禁用 Package 时不加载 Approval/Package storage subpath，不增加
  timer/watcher；默认单次批量分别为 1/4；
- cluster：使用 admin-only PostgreSQL role、短 `SERIALIZABLE` transaction 和现有
  COMMIT outcome-unknown 规则；cluster-control/runtime/worker 不获得 Approval decision
  或 Package admission 写权限；短生命周期管理调用默认单次批量 16；
- 两者共用 exact record、transition、receipt 和 repository contract，不复制领域逻辑；
- 不为 Approval、Package consumer、receipt 或每个 Profile 新建单文件 workspace
  package。

## 拒绝的方案

- 直接复用 2.x Sequelize Approval 表：拒绝；会把兼容实现变成 3.0 永久事实源，并
  破坏 PostgreSQL/edge 对等合同。
- 内存 consumer、总是成功 consumer 或只校验 Lock 字段：拒绝；无法证明 durable
  decision/dispatch，也无法恢复消费与 queued create 之间的崩溃。
- 所有 Profile 强制不同审批人：拒绝；单 owner 路由设备无法使用。
- 所有 Profile 默认允许自批：拒绝；集群无法表达职责分离。
- Approval transaction 内执行 OCI/Kubernetes/POSIX I/O：拒绝；长事务、响应丢失和
  外部副作用会污染一致性边界。
- 新建 `approval-core`、`package-consumer` 等 workspace package：拒绝；当前独立
  发布、运行和依赖生命周期均不存在，显式 subpath 已足够隔离。

## 影响

- `runtime-core` 多一个纯契约 subpath，workspace package 数与第三方依赖数不变。
- `package.manage` 是共享 Policy 词表的加法式安全边界；Tool Registry 与角色矩阵必须
  持续回归。
- edge 用户获得可用的强认证自确认路径，cluster 用户获得可强制的四眼路径。
- 当前 production Package 安装入口仍保持关闭；durable dispatcher/Package handler、
  强绑定 admission、Profile 管理组合和认证后 use-case facade 完成，不等于真实
  HTTP/CLI/UI authentication/transport 或资源 generation consumer 已完成。
- 下一阶段 transport 必须调用 ADR-0142 facade，不能绕过
  proposal/Approval/dispatcher 直接调用 installation repository。

## 验证

当前门禁覆盖：

1. exact request/action shape、digest 与 24 小时生命周期；
2. pending/decision/consumption version 和状态 tuple；
3. 三次 fence、强认证事实与 immutable dispatch；
4. `human_confirmation` 同 User 强确认；
5. `separation_of_duty` 同主体拒绝、不同强认证 User 允许；
6. weak/service/expired principal 拒绝；
7. decision/consumption exact replay 与 mutation drift 拒绝；
8. `package.manage` owner/admin/operator/viewer/agent Policy 矩阵；
9. Tool definition 权限解析与未知权限拒绝；
10. runtime-core 249/249，覆盖 proposal/dispatch digest 绑定、pre-start retry、
    start barrier、post-start 禁止 takeover、dispatcher start/complete response-loss
    收敛、确定性 Package handler/admission response-loss 与 result digest；
11. SQLite 0039–0044、capability v22、39 表、request/dispatch digest 防漂移、三次
    原子 Audit、pending execution baseline、immutable proposal、Package admission
    receipt 与显式 subpath；
12. SQLite admission 成功/exact replay、数据库时钟拒绝过期 execution lease，以及
    Policy revoke 后 install、mutation、audit、receipt 全事务回滚；local-sqlite
    78/78、local-admin 54/54；后者包含认证后 facade 的
    propose→self-confirm→consume→dispatch→queued admission 真 SQLite 闭环；
13. PostgreSQL `pg-0019/0020/0021`、capability v20、35 表、admin-only
    `lock_approval_policy_fence`、proposal/execution/Package admission receipt ACL、
    runtime/worker 零权限与显式 subpath；
14. PostgreSQL 18.4 arm64 四角色真库 request/decision/consume/dispatch/admission
    exact replay，30 pass、1 个条件 skip、0 fail；
15. cluster-postgres 130 pass/1 条件 skip、cluster-control 139 pass/2 条件 skip、
    cluster-admin 63 pass/1 条件 skip，均 0 fail；
16. edge/cluster import closure 与依赖审计 `findings: []`、`compatible: true`；
17. PostgreSQL 18 physical streaming、`remote_apply`、timeline 1→2 promotion、
    `pg_rewind` rejoin 与 21 项 HA gate 全通过；最近一次 fail-closed 289.831 ms、
    双 fresh activation 354.635 ms、rewind 1,480.675 ms，unexpected domain side
    effect 为 0。

后续 product Gate 还必须覆盖 PostgreSQL admission 过期租约真库拒绝、两个方言的
并发 decision/consume、Approved Action/Package 端到端 COMMIT-response-loss、真实
credential/local-console/MFA transport、HTTP/CLI/UI、资源 generation consumer 和
完整 edge/cluster 产品闭环。
