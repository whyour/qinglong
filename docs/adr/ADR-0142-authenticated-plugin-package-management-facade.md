# ADR-0142：认证后 Plugin Package 管理 Facade 与 Profile ceremony

- 状态：Accepted（transport-neutral 管理 facade、SQLite 真实端到端闭环与
  local/cluster Profile 组合已实现；本机 CLI 由 ADR-0143 完成，Cluster transport
  边界由 ADR-0144 冻结，identity/keyset 与 HTTP process 由 ADR-0145 完成；
  durable quota 由 ADR-0146 完成，ADR-0149 已完成原子 resource generation
  identity/source；真实双 User/UI 与资源语义 materializer 待完成）
- 日期：2026-07-25
- 关联 RFC：QL-RFC-0001 D-05、D-08、D-09、D-85、D-130 至 D-140

## 上下文

ADR-0141 已完成 immutable proposal、durable Approval、execution/start barrier、
Package 原子 admission 和调用方驱动 dispatcher，但这些能力仍是彼此独立的显式
authority。若 HTTP、CLI、UI 或自动化入口自行拼接这些 repository，很容易出现：

1. 在解析完整 Package action 前查询 Policy，或绕过 `package.manage`；
2. 由 transport 提交 Project/RoleBinding fence，而不是读取当前 Policy snapshot；
3. local 与 cluster ceremony 漂移为“全部允许自批”或“全部强制四眼”；
4. consumption 复用用户输入的 consumer identity；
5. proposal、request、decision、consume 和 dispatch 各自生成不稳定幂等身份；
6. 为每种 transport 或 Profile 新建 workspace package。

公开 transport 现在还不能直接开放，但必须先建立唯一的 use-case 组合边界，后续
adapter 才不会再次复制安全协议。

## 决策

### 1. 共享 use-case 留在 runtime-core 显式子路径

新增 `@qinglong/runtime-core/plugin-package-management`，不新增 workspace package、
第三方依赖、timer、watcher、socket 或数据库连接。Facade 只接受已经认证且仍 active
的 `SecurityPrincipal`，并固定提供：

- `propose`：规范化完整 install action，执行 `package.manage` Policy，使用返回的
  fence 创建 immutable proposal，再创建 digest-bound ApprovalRequest；
- `decide`：重新读取 request，以当前 principal 对 `approval.decide` 执行 Policy，
  再提交强认证 decision；
- `consume`：只使用构造时注入的 system consumer authority，重新读取 requester 的
  `package.manage` Policy fence，再原子生成 dispatch/execution baseline；
- `inspect`：只读取 proposal 与 request durable fact；
- `dispatch`：调用既有 bounded dispatcher，不安装后台循环。

Facade 不接收调用方提供的 Policy fence、consumer subject、action digest 或 preview
digest；这些事实必须分别来自 Policy engine、固定 composition 和 canonical proposal。

### 2. 幂等身份由请求显式携带

写操作必须携带稳定的 action/request/decision/consumption/dispatch/audit identity
以及对应发生时间。相同 identity 与相同语义可 exact replay；不同内容复用 actionRef
或 approvalRequestId 必须冲突。Facade 不在响应丢失后静默生成新 identity。

默认 Approval lifetime 为 15 分钟，可由受信 composition 缩短或在领域允许的 24 小时
上限内调整。已超出 lifetime 的新 `propose` 调用在任何 mutation 前拒绝。

### 3. Profile 固定 ceremony，不让 transport 选择

- `@qinglong/local-admin/package-management` 固定
  `human_confirmation`，复用唯一 `LocalSqliteOperationAuthority`，edge/standalone
  dispatcher 默认批量仍为 1/4；
- `@qinglong/cluster-admin/plugin-package-management` 固定
  `separation_of_duty`，使用 admin-only PostgreSQL repository，dispatcher 默认批量
  仍为 16；
- 两个入口都不从 package root、常驻 runtime、cluster-control 或 worker 导出。

local 新增 `@qinglong/local-sqlite/project-policy` 窄 adapter，cluster 只给现有
`PostgresProjectPolicyRepository` 增加显式 `project-policy` export。没有新增表、
migration、连接或 importer。

### 4. 公开 transport 继续失败关闭

本 ADR 的“认证后”表示 facade 不接受匿名/过期 principal，并不表示 bearer token、
本机 credential file、MFA/hardware assertion 或 HTTP session 已在这里完成验证。
真实 transport adapter 必须在调用 facade 前完成：

- bounded request/body/command-file 解析；
- credential 或本机 console proof；
- rate limit、取消和 response mapping；
- secret 不进入 argv/stdout/audit；
- transport response-loss 的 idempotency key 保留。

因此当前不能把内部 subpath 注册为 2.x Controller route，也不能宣称 UI 或
cluster admin transport 已生产开放。本机私有 command-file CLI 由 ADR-0143 完成；
ADR-0145 提供的 cluster HTTP process 和 Kubernetes operation 仍默认关闭，生产
ingress 继续受 keyset anti-rollback、真实双 User 与 live ingress 门约束。

## 影响

- Package 管理 use-case 不再由每种 transport 自行拼 repository；
- workspace importer 仍为 21，runtime-core 只增加一个纯协调 source；
- edge 禁用 Package 时不会加载 facade 或任何 Package storage；
- cluster-control/runtime/worker 仍无 proposal、decision、consume 或 admission 写权限；
- ADR-0143 已在同一 facade 上实现短生命周期本机 CLI；独立 cluster admin API
  已由 ADR-0144 冻结双 authority 边界，仍无需改变领域和 Package 数据库协议。

## 验证

1. runtime-core 250/250，其中新增四眼审批、operator mutation-before-deny 与
   authorization-before-quota 门禁；
2. local-admin 54/54，其中真实 Node 24 SQLite 流程覆盖
   `propose → self-confirm → consume → dispatch → queued admission`；
3. 弱认证 decision 与过期 propose 在 mutation 前失败，失败 decision 不产生 Audit；
4. 完整流程产生 proposal/request/decision/consume/admit 五类 durable Audit；
5. cluster-admin 63 pass/1 条件 skip，构造不打开 PostgreSQL且 ceremony 常量固定为
   `separation_of_duty`；
6. 26 项 source-boundary test 与 cluster dependency audit
   `findings: []`、`compatible: true`；
7. importer 仍为 21；新增能力均为既有 package 的显式 subpath。

## 后续门禁

- 为 keyset generation/revocation 增加跨全副本重启的 durable anti-rollback；
- response-loss 下相同 transport idempotency key 的完整端到端重放；
- PostgreSQL 真库 separation-of-duty/concurrent decision/consume；
- ADR-0149 已完成 generation publisher/source；继续实现
  Task/Workflow/Prompt/Tool 语义 materializer；
- UI 只消费低敏 preview/status，不持有数据库或 dispatcher authority。
