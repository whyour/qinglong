# ADR-0214：Owner 围栏化、有界的 Local RoleBinding 查询

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-05、D-27、D-37、D-65、D-72、D-73、D-175、
  D-198、D-200、D-203、D-204
- 关联 ADR：ADR-0028、ADR-0185、ADR-0208、ADR-0210、ADR-0213

## 背景

ADR-0208 的 `policy.role-binding.put|revoke` 要求 target 的 current version，但产品
入口不能读取当前 RoleBinding。operator 仍需直接查询 SQLite，既绕过认证和审计，也
容易把 append-only 历史行误当成当前授权。

RoleBinding 查询与 ADR-0213 的 Project 拓扑查询不是同一种 authority：

- Project create/archive/restore/inspect/list 是实例级拓扑管理，只属于实例
  authority Project Owner；
- RoleBinding 是 Project-scoped 权限管理，每个 Project 的当前 Owner 应能自治查询
  自己 Project，而不能因此枚举其他 Project。

## 决策

### 1. 扩展既有 `ql3-policy`，不新增 package、migration 或常驻资源

在现有 project-policy-administration 四层 subpath 中新增：

- `policy.role-binding.inspect`；
- `policy.role-binding.list`。

查询只读取 v37 已有的 append-only RoleBinding 表并写已有 security audit 表。
workspace 保持 22 个 package，不新增依赖、daemon、timer、watcher、listener、缓存
或端口。

### 2. 每个 Project 的当前强认证 Owner 只能查询自己的 Project

local-admin 对 request `projectId` 固定请求 Owner-only `project.manage`。SQLite 在
同一个 `BEGIN IMMEDIATE` 事务内复用 put/revoke 的最终 authority helper，重新验证：

1. authenticated credential、Identity、有效期和 pepper provenance；
2. 目标 Project active/version；
3. actor 最新 active Owner RoleBinding/version。

验证后才读取目标或列表并原子写 allowed audit。admin/operator/viewer 和未绑定 User
均不能查询。secondary Project Owner 可以查询其自己的 Project，但不能把自身
`project.manage` 用于另一个 Project。

这条路径不要求 ADR-0211 的实例 authority anchor；错误地加入该要求会破坏
Project-scoped 自治。

### 3. inspect 只返回 target 的最新 revision

`policy.role-binding.inspect` 接受 Project、target、request ID 和单一 audit event
ID。SQLite 按 version 降序只取一条：

- 从未存在时返回 `found:false`；
- 当前 active 时返回 role；
- 当前 revoked 时不返回 role；
- 历史 active revision 不得覆盖最新 revoked revision。

成功输出只包含 Project、target、version、state、可选 role 和 created timestamp。
不返回 mutation ID、changedBy、credential、pepper、数据库路径或内部 audit。

### 4. list 只列出每个 subject 的最新 revision

`policy.role-binding.list` 要求：

- `limit` 为 1–64；
- `state` 为 `active|revoked|all`；
- `role` 为 `owner|admin|operator|viewer|all`；
- 可选 cursor 精确包含 `{subjectType, subjectId}`。

SQLite 先以相关子查询选择每个 `(projectId, subjectType, subjectId)` 的 max version，
再应用 state/role filter，按 `(subjectType ASC, subjectId ASC)` 查询 `limit + 1`。
只有确有下一条时才返回最后一条可见 binding 的 cursor。`role != all` 自然排除
role 为 null 的 revoked binding。

禁止返回历史 revision、offset、任意排序、模糊搜索、客户端 SQL 片段或无界数组。

每一页是独立授权、独立审计的 current-head snapshot，不是跨 command 的长事务。
翻页期间发生 put/revoke 时，要求严格同一时点清单的 operator 必须从第一页重查。

### 5. 查询与审计使用同一个最终事务

query command 不携带 mutation ID、expected version 或 failure-audit ID，只携带单一
audit event ID。成功查询与 allowed audit 原子提交；credential/Project/Owner fence
在服务授权后漂移时事务回滚，CLI 以同一 event ID 写低敏 denial audit。

## 不采用方案

### 直接暴露 `ProjectPolicyRepository.resolve`

拒绝。它只解析一个 subject 的 Policy snapshot，不提供 actor Owner authority、
credential fence 或同事务 audit，也会把内部 repository 变成产品 transport。

### 返回全部 append-only 历史

拒绝。产品 mutation 需要 current version，历史列表容易误判撤权状态且输出无界。
历史审计应由未来专门的 bounded audit/query contract 提供。

### 只允许实例 authority Project Owner 查询所有 RoleBinding

拒绝。这会破坏 Project-scoped RBAC 自治，并迫使 secondary Project 的日常成员管理
依赖实例根 Owner。

### 另建 RoleBinding query package 或管理 daemon

拒绝。查询与 mutation 共用 Project authority、SQLite、CLI 和交付闭包；拆包或常驻
服务增加供应链碎片和路由设备空闲成本。

## 影响

正向影响：

- put/revoke 的 expected version 不再要求直接 SQL；
- append-only 历史被明确折叠为每个 subject 的 current head；
- Project Owner 自治与实例拓扑 authority 保持分离；
- 64 条硬上限约束 CPU、内存和输出；
- put/revoke/query 共用同一个最终 Owner fence helper；
- SQLite contract 保持 v37，workspace 保持 22 包。

代价与限制：

- 每次查询写一条 security audit，并短暂取得 SQLite write reservation；
- 当前不提供历史 revision、RoleBinding approval 或 break-glass 恢复；
- Cluster 继续使用独立 PostgreSQL/RBAC management transport。

## 验证

- GitNexus：SQLite append method 1 个直接上游、CLI request normalizer 3 个上游，
  repository/class/service factory 均为 LOW，未命中已索引执行流程；
- 真实 SQLite/Owner CLI 18/18：
  - inspect 只返回 revoked current v3，不回退历史 active；
  - missing 返回 `found:false`；
  - 两页 keyset 覆盖四个最新 subject，无重复或静态遗漏；
  - active viewer filter 只返回当前 viewer；
  - secondary Project Owner 可查询自己的两个 Owner；
  - secondary Owner 查询 foreign Project 被拒绝并写 denial audit；
  - Project admin 查询被 `permission_missing` 拒绝；
  - limit 65 在打开数据库前拒绝；
  - credential 在服务授权后漂移时，最终 inspect 事务拒绝且不提交 allowed audit；
  - Project lifecycle/query、RoleBinding mutation、防锁死和容量回归；
- local-admin 与 local-owner-cli strict TypeScript 通过；
- runtime-core/local-sqlite 完整 TypeScript 仍只受锁定依赖未物化影响，本切片未出现
  类型错误；
- 不新增 migration、package、生产依赖或 deployment contract 版本。
