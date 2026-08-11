# ADR-0028：Project Identity、版本化 RBAC 与默认拒绝 Policy Core

- 状态：Proposed
- 日期：2026-07-19
- 关联：QL-RFC-0001、ADR-0025、ADR-0027

## 上下文

QingLong 2.x 只有面板单用户登录和 API App route scope。`logs/crons/envs` 等 scope 只决定某类 `/open/*` 路由能否进入，既没有稳定 ActorRef，也不绑定 Project、资源 identity 或审批策略。把 `logs` 直接解释为 3.0 `artifact.read` 会让一个旧 token 获得所有 Project 日志；把当前用户名直接作为 owner 又会把可修改的显示值误当成持久安全主体。

ADR-0027 已要求 Artifact 在任何文件访问前执行 `artifact.read`，但只定义了 authorizer port。3.0 还需要一个可在 edge 上低成本运行、在 cluster 中可替换存储 adapter、能够表达 User/API App/MCP Client/Agent/System/Worker 的基础 Policy Core。

## 决策

### 1. ActorRef 使用统一、精确且有界的主体

主体固定为：

```ts
interface PolicySubject {
  type: 'user' | 'api_app' | 'mcp_client' | 'agent' | 'system' | 'worker';
  id: string;
}
```

ID 为 1～255 字符，不允许控制字符。所有 subject、Project、RoleBinding、snapshot 和 policy request 都拒绝未知字段，避免调用方提交一个看似生效但实际被忽略的 `permissions/context`。Artifact read 已复用同一 subject 类型，不再维护第二套 identity 枚举。

Authentication adapter 负责把 session/token/mTLS credential 映射为稳定 subject；PolicyEngine 不读取 HTTP header、cookie、用户名或 legacy App scope。身份认证与授权仍是两个边界。

### 2. Project 是权限和归档状态的事实源

`0017-project-policy` 新增 `Projects`：

- `id/name/slug/status/version`；
- `created_at_ms/updated_at_ms`；
- slug 唯一，status 为 `active|archived`；
- migration 创建 RFC 要求的 `default` Project，baseline 时间为 0，表示从 legacy 升级继承而非伪造创建时间。

baseline Project 故意不创建 owner binding。生产升级必须通过一次性、可审计且认证后的 bootstrap claim 建立首个 owner；禁止根据当前 username、默认密码、system App 或任意已有 token 静默授予。ADR-0029 已孵化默认不可达的 bootstrap core，但本机控制台/authentication adapter 与产品入口尚未实现，因此 migration 注册仍不代表 3.0 API 可用。

### 3. RoleBinding append-only、按主体版本化

`ProjectRoleBindings` 的 identity 是 `(projectId,subjectType,subjectId,version)`。每次赋权、变更角色或撤销都追加一行：

- state 为 `active|revoked`；active 必须有 role，revoked 不得携带 role；
- role 为 `owner|admin|operator|viewer`；
- `mutationId` 在 Project 内唯一，同请求重放返回 existing，内容漂移返回稳定 mutation conflict；
- 调用方提供 expected current version，新版本必须严格 `+1`；SQLite adapter 使用短 `IMMEDIATE` transaction，使并发赋权只有一个版本获胜；
- 每行保存 `changedBy` ActorRef 和时间，不覆盖历史授权事实。

撤销是一条新版本，不删除旧行。当前读取使用 `(project,subject,version DESC)` 点查；另有 subject→Project 索引供未来列出可见 Project。edge 不把所有 membership 加载到内存，也不常驻缓存；cluster-control 必须实现 PostgreSQL CAS/locking adapter，不能共享 SQLite。

### 4. 首版角色权限矩阵固定在领域代码

静态权限包括 RFC 原有权限，并补充 `project.manage`、`policy.manage`、`approval.decide`。Tool 权限只接受精确 `tool.call:{toolName}`；外部请求不接受 `tool.call:*`。

| Role | 允许范围 |
| --- | --- |
| owner | Project 内全部已声明权限和精确 Tool call |
| admin | 除 `project.manage` 外的全部已声明权限和精确 Tool call |
| operator | 读、Task create/update、Run start/stop/retry、Secret use、精确 Tool call |
| viewer | `project/task/run/artifact` 只读 |

首版不引入用户自定义 role、外部策略语言或 allow/deny JSON。添加权限必须修改 canonical permission registry、矩阵和测试，不能依赖数据库自由字符串。接口保持独立，后续可接 OPA 或 Project custom policy，但新实现必须保持默认拒绝和相同 decision contract。

### 5. Policy decision 默认拒绝，Agent 写操作要求审批

稳定 decision effect 为 `allow|deny|require_approval`，reason 使用低敏机器码：

- Project 不存在：`deny/project_not_found`；
- 无 binding 或已撤销：`deny/subject_unbound`；
- role 不包含权限：`deny/permission_missing`；
- archived Project 对非只读操作：`deny/project_archived`；
- role 允许：`allow/role_grant`；
- Agent 的写操作、Secret use/manage、管理权限和 Tool call：`require_approval/agent_action_requires_approval`。

Policy storage 损坏、snapshot identity 漂移或读取失败不返回 deny 原因，而返回稳定 unavailable 并 fail closed。因为当前 ApprovalRequest 状态机尚未实现，`require_approval` 不能被视为 allow；调用端不得先执行再补审批。

archived Project 只允许 `project.read/task.read/run.read/artifact.read`，方便历史审计；不允许启动 Run、使用 Secret 或管理 policy。

### 6. 旧身份不自动继承 3.0 权限

- 2.x 面板登录只证明 legacy session；ADR-0030 已提供默认不可达的稳定 `user/usr_legacy_primary` 映射 core，但生产 middleware 尚未装配；
- legacy API App 的 `logs` scope 不等于 `artifact.read`，`crons` 不等于 `run.start`；
- system App、Worker token、MCP session 和 Agent identity 都必须经各自 authentication adapter 产生 subject，并显式绑定 Project role；
- migration 不复制 client secret、token、username 或 password 到 RoleBinding。

未来兼容向导可以展示建议映射，但必须由已认证 owner 明确确认并写入审计 mutation。

### 7. 当前保持 production unreachable

本切片已实现 domain registry、`ProjectPolicyEngine`、SQLite append/resolve repository、`0017` migration、schema ownership 和 `ProjectPolicyArtifactReadAuthorizer`；ADR-0029 另已实现默认不可达的首 owner bootstrap core。但仍没有：

- 首 owner bootstrap 的本机控制台 issuer、认证 adapter、产品入口与恢复码；
- session/token/mTLS → subject authentication adapter；
- role 管理 API/UI、审计事件和 rate limit；
- ApprovalRequest 持久化与一次性消费；
- PostgreSQL repository、跨副本 cache invalidation 或 OPA adapter；
- typedi/Express/MCP/Worker startup 装配。

因此 default Project 在现有生产入口中仍是 ownerless，所有真实调用默认拒绝。不得为“让 API 能用”而在 loader 中隐式授予 owner。

## 影响

正面影响：

- Artifact、Secret、Run、Tool 可以共享一套 Project/Actor permission vocabulary；
- 权限变更有不可覆盖历史、幂等 mutation 和 CAS 并发语义；
- edge 每次决策只需有界点查，不需要策略 sidecar 或全量 membership cache；
- legacy token 不会因升级静默扩大权限；
- Agent 写行为在 Approval 状态机完成前无法被误当成 allow。

代价与风险：

- 初次升级必须完成显式 owner bootstrap，否则 3.0 API 保持不可用；
- 每次无缓存决策至少一次数据库读取，未来缓存必须以 binding/project version 正确失效；
- 固定角色不支持复杂 ABAC、资源标签和 Tool 风险等级；
- 当前所有 Agent Tool call 都要求审批，未来只能由可信 Tool manifest 风险分类放宽，不能由 Agent 自报只读；
- RoleBinding 历史持续增长，需要与 Project 生命周期一致的审计 retention，而不能直接覆盖或清空。

## 未选择的方案

1. **把 legacy scope 直接映射为 Permission**：没有 Project/资源边界且会扩大旧 token 权限，拒绝。
2. **默认用户名自动成为 owner**：显示名可变且没有一次性 bootstrap 审计，拒绝。
3. **RoleBinding 单行覆盖**：丢失授权历史和并发裁决证据，拒绝。
4. **把 permissions JSON 存进 binding**：无法维护 canonical 语义，损坏/拼写会形成隐式权限，首版拒绝。
5. **未绑定主体默认 viewer**：跨 Project 数据泄露，拒绝。
6. **Agent role 允许即直接执行写操作**：绕过 RFC 默认审批原则，拒绝。
7. **edge 引入 OPA sidecar**：资源与部署复杂度不适合基础能力，首版拒绝。

## 验证要求

- migration 在 legacy fixture 上创建 ownerless default Project，重复执行和 ownership audit 通过；
- subject、permission、Project、binding、snapshot、request 非 canonical 输入在 repository/policy 副作用前拒绝；
- role matrix、archived Project、unbound/revoked/default-deny 和 Agent approval 全覆盖；
- append replay、mutation drift、stale expected version 和两个 SQLite 连接并发赋权可重复验证；
- current row 损坏、active-null-role、identity 漂移和非 SQLite adapter fail closed；
- Artifact authorizer 只委托 `artifact.read` 且错误 action 拒绝；
- Node 22/24 全量测试、类型检查、schema audit 和 GitNexus reachability 通过；
- app/loaders/api/services 不得导入或装配本切片。
