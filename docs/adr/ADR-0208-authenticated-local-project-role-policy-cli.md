# ADR-0208：强认证 Local Project Role Policy CLI 与防锁死交接

- 状态：Accepted
- 日期：2026-07-29
- 关联 RFC：QL-RFC-0001 D-05、D-27、D-37、D-65、D-72、D-73、D-175、
  D-197、D-198
- 关联 ADR：ADR-0028、ADR-0074、ADR-0086、ADR-0185、ADR-0193、ADR-0207

## 背景

Fresh Setup 与首 Owner ceremony 已创建 `default` Project 和首个 Owner，
ADR-0207 也让 Secret 管理具备正式 CLI。但 Project RoleBinding 仍只有 repository
和 Policy Engine，没有强认证产品入口。部署者不能把 viewer/operator/admin 权限
交给另一个已登记主体，也不能以受支持方式交接 Owner。

直接把 `ProjectPolicyRepository.append()` 暴露给 CLI 不可接受：

- 它不验证 actor 的 `project.manage`；
- RoleBinding、allowed audit 和 credential/Policy fence 不在同一事务；
- admin 持有 `policy.manage`，若产品误用该 permission，可把自己提升为 owner；
- 只数 Owner binding 会允许把 Owner 交给没有 active credential 的 User，随后撤销
  原 Owner，形成不可恢复的假交接。

## 决策

### 1. 复用现有四个 package，不新增 importer

- `@qinglong/runtime-core/local-project-policy-administration` 只定义原子 repository
  contract 和低敏错误；
- `@qinglong/local-sqlite/project-policy-administration` 是一次命令、一个连接的短生命
  周期 composition；
- `@qinglong/local-admin/project-policy-administration` 拥有认证后领域服务；
- `@qinglong/local-owner-cli/project-policy-command` 和 `ql3-policy` 提供私有 command
  file 产品入口。

workspace 继续是 22 个 package。常驻 `local-application`、Profile、Worker 和
Cluster 均不能导入两个 mutation authority。依赖审计只允许 exact
`projectPolicyCommand.ts` 使用它们。

### 2. v1 只管理既有 Project 的 RoleBinding

开放两个 operation：

- `policy.role-binding.put`：创建或更新 active binding；
- `policy.role-binding.revoke`：追加 revoked binding。

两者都要求 target、expected current version、UUIDv4 mutation、request ID 和独立
failure-audit UUID。成功只返回 Project、target、version、state、可选 role 和
`inserted|existing`，不返回 credential、token、pepper、路径或内部 Policy 细节。

本切片不创建/归档 Project，不注册 Identity，不签发 credential，不提供远程 HTTP
入口，也不把常规 `ProjectPolicyRepository.append()` 变成产品 API。

### 3. 只有当前强认证 Owner 可以修改 RoleBinding

CLI 使用现有 private `0600` command file、Owner credential presentation、
pepper provenance 和 POSIX proof 建立 `local_console` Principal。服务固定请求
`project.manage`，不能改为 `policy.manage`：

- owner 允许；
- admin/operator/viewer 拒绝；
- admin 不能借管理 RoleBinding 把自己升级为 owner；
- deny/approval/unavailable 先写低敏 audit，再返回固定错误。

### 4. 最终写事务内复验三重 fence

SQLite 在 `BEGIN IMMEDIATE` 已取得写锁后按顺序复验：

1. authenticated credential version/state、User status、有效期、pepper state 与
   material digest；
2. Project active/version；
3. actor 最新 RoleBinding version/state/owner role；
4. target RoleBinding expected version 与 mutation replay；
5. Owner 连续性。

随后 RoleBinding revision 与 allowed security audit 在同一事务插入。任何 fence、
版本、mutation、audit 或约束失败都回滚。相同 mutation 的语义重放返回
`existing`；时间戳不参与 response-loss 的语义相等判断。

### 5. Owner 交接必须同时防止“最后一个 Owner”和“不可登录 Owner”

- active owner 只能授予 `user` subject；
- owner grant 在同一事务确认目标 Identity active，并至少存在一条当前有效的 active
  API credential、pepper binding 和 active/retired pepper catalog；
- 撤销或降级当前 active User owner 前，必须仍有另一条最新 active User owner
  binding；
- 因此正确流程是先为目标 User 完成 Identity/credential ceremony，再 grant owner，
  用目标 credential 验证登录，最后 revoke 原 owner。

这不证明目标 credential 的外部 presentation file 仍在；operator 仍必须在交接前
用目标身份完成一次真实认证。

## 低配路由器与集群影响

- 管理命令仅人工调用时加载，结束后关闭单 SQLite authority；
- 不新增 migration、表、daemon、timer、watcher、listener、socket 或第三方依赖；
- Edge/Standalone 常驻 artifact closure 不导入 local-admin policy service 或 Owner
  CLI；
- Cluster 继续使用独立 PostgreSQL/RBAC/管理 host 设计，不能复用本地文件
  credential CLI。

## 不采用方案

### 暴露常规 `ProjectPolicyRepository.append`

缺少 actor Policy、credential fence 和同事务 audit，且会扩大任意 caller 的写权限。

### 使用 `policy.manage`

admin 本来拥有该 permission；允许其签发 owner 会形成直接提权路径。产品固定使用
owner-only `project.manage`。

### 只禁止删除最后一行 Owner

RoleBinding 是 append-only，必须检查每个 subject 的最新 revision；历史 owner 行
不能计入当前 owner 数。

### 只检查第二个 Owner binding

无 active Identity/credential 的 Owner 不能接管系统。将其计入连续性会制造锁死。

## 验收证据

- `ql3-policy` 真实 SQLite/CLI 专项 6/6：
  - grant、exact replay、role update、revoke；
  - admin 自提升拒绝；
  - 最后一个 active User owner 撤销拒绝；
  - 无 active credential 的 owner target 拒绝；
  - 有 credential 的 owner handover 后允许撤销原 owner；
  - credential 在预检后 revoke 时事务回滚。
- dependency/source boundary 34/34，包含 mutation authority 的 exact-file 正负向
  契约；
- runtime-core contract、SQLite repository、local-admin service 和 Owner CLI 的
  strict targeted TypeScript 编译通过；
- workspace 仍为 22 package，无新增 dependency 或 migration。

完整 workspace build、artifact 预算和 PostgreSQL HA 门仍需在锁定依赖恢复后重跑；
不能用本专项门替代。

## 后续

- Identity register/disable 与 credential issue/rotate/revoke 的本机产品入口；
- Project lifecycle/query 已由 ADR-0212/0213 完成，RoleBinding current query 已由
  ADR-0214 完成；仍需 rename、authority transfer 与 RoleBinding history query；
- bounded local audit query 已由 ADR-0215 完成；仍需 export/retention/signing/alert；
- RoleBinding change approval/break-glass 和恢复流程；
- Cluster PostgreSQL 对等管理 transport；
- 固定 Edge 设备上的 CLI RSS、闪存写入和断电恢复证据。
