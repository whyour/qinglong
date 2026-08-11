# `ql3-policy` 本机 Project 与 RoleBinding 管理

`ql3-policy` 是一次命令、一次进程的 Owner-only 管理入口，不启动管理 daemon，也不把
credential token、pepper、数据库路径或 command 路径写入成功输出。

## 前置条件

- 已完成 Fresh Setup；
- 当前 credential 属于实例 authority Project 的 active User Owner；
- deployment root 和子目录为当前 UID 所有、目录 `0700`、文件 `0600`；
- SQLite 与 Owner pepper keyring 已通过 readiness；
- 所有 UUID、Project、subject 和路径均替换为部署自己的值。

执行形式：

```sh
ql3-policy run --command-file /srv/qinglong3/commands/project.json
```

command file 必须是 deployment root 内的规范、非 symlink、当前 UID `0600` 文件。
响应不确定时只能原样重放同一个 command。

## 创建 Project

```json
{
  "schemaVersion": 1,
  "operation": "policy.project.create",
  "options": {
    "deploymentRoot": "/srv/qinglong3",
    "databasePath": "/srv/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/srv/qinglong3/owner-keys",
    "credentialFilePath": "/srv/qinglong3/owner-credential.json"
  },
  "request": {
    "authorityProjectId": "default",
    "projectId": "automation",
    "name": "Automation",
    "slug": "automation",
    "expectedCurrentVersion": 0,
    "mutationId": "11111111-1111-4111-8111-111111111111",
    "requestId": "project-create-automation",
    "failureAuditEventId": "11111111-1111-4111-8111-111111111112"
  }
}
```

创建会在同一 SQLite 事务内建立 active Project、调用者自己的首个 active Owner
RoleBinding、allowed audit 和 immutable mutation ledger。成功示例：

```json
{
  "schemaVersion": 1,
  "operation": "policy.project.create",
  "status": "inserted",
  "projectId": "automation",
  "name": "Automation",
  "slug": "automation",
  "projectStatus": "active",
  "version": 1
}
```

Edge 最多 16 个 Project，Standalone 最多 128 个；archived Project 仍占容量。

## 归档与恢复

归档使用 Project 当前版本：

```json
{
  "schemaVersion": 1,
  "operation": "policy.project.archive",
  "options": {
    "deploymentRoot": "/srv/qinglong3",
    "databasePath": "/srv/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/srv/qinglong3/owner-keys",
    "credentialFilePath": "/srv/qinglong3/owner-credential.json"
  },
  "request": {
    "authorityProjectId": "default",
    "projectId": "automation",
    "expectedCurrentVersion": 1,
    "mutationId": "22222222-2222-4222-8222-222222222221",
    "requestId": "project-archive-automation",
    "failureAuditEventId": "22222222-2222-4222-8222-222222222222"
  }
}
```

归档后 Project Policy 默认拒绝该 Project 的业务权限，但不删除 RoleBinding、Task、
Run、Secret、Package 或审计历史。恢复把 operation 改为
`policy.project.restore`，并把 `expectedCurrentVersion` 改为归档结果的版本。

实例 authority Project 不能归档。不要通过直接 SQL 修改其状态，也不要把 archive
当成 hard delete。

## 查询 Project

查询一个 Project current head：

```json
{
  "schemaVersion": 1,
  "operation": "policy.project.inspect",
  "options": {
    "deploymentRoot": "/srv/qinglong3",
    "databasePath": "/srv/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/srv/qinglong3/owner-keys",
    "credentialFilePath": "/srv/qinglong3/owner-credential.json"
  },
  "request": {
    "authorityProjectId": "default",
    "projectId": "automation",
    "requestId": "project-inspect-automation",
    "auditEventId": "44444444-4444-4444-8444-444444444441"
  }
}
```

已授权但不存在时返回 `found:false`。active 和 archived Project 都可查询；查询 archived
Project 不会恢复其业务权限。

有界列出 Project：

```json
{
  "schemaVersion": 1,
  "operation": "policy.project.list",
  "options": {
    "deploymentRoot": "/srv/qinglong3",
    "databasePath": "/srv/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/srv/qinglong3/owner-keys",
    "credentialFilePath": "/srv/qinglong3/owner-credential.json"
  },
  "request": {
    "authorityProjectId": "default",
    "limit": 16,
    "status": "all",
    "requestId": "project-list-first-page",
    "auditEventId": "44444444-4444-4444-8444-444444444442"
  }
}
```

`limit` 必须为 1–64；`status` 只能为 `active`、`archived` 或 `all`。若响应中的
`nextCursor` 非 null，下一条 command 使用新的 request/audit ID，并把该值原样放入
request：

```json
{
  "after": {
    "slug": "automation",
    "projectId": "automation"
  }
}
```

不要自行修改 cursor，也不要使用上一次 query command 的 audit event ID。列表按
`slug, projectId` 正序稳定翻页，不支持 offset、任意排序或模糊搜索。
每一页都是独立的 current-head snapshot；若翻页期间发生 create/archive/restore，
需要严格同一时点清单时应从第一页重新查询。

## 管理 RoleBinding

授予或更新 RoleBinding：

```json
{
  "schemaVersion": 1,
  "operation": "policy.role-binding.put",
  "options": {
    "deploymentRoot": "/srv/qinglong3",
    "databasePath": "/srv/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/srv/qinglong3/owner-keys",
    "credentialFilePath": "/srv/qinglong3/owner-credential.json"
  },
  "request": {
    "projectId": "automation",
    "target": { "type": "user", "id": "operator-user" },
    "role": "operator",
    "expectedCurrentVersion": 0,
    "mutationId": "33333333-3333-4333-8333-333333333331",
    "requestId": "role-put-automation-operator",
    "failureAuditEventId": "33333333-3333-4333-8333-333333333332"
  }
}
```

撤销时使用 `policy.role-binding.revoke`，移除 `role`，并填写 target 当前 binding
version。Owner 只能授予 User；授予新 Owner 前，目标必须有 active Identity 和当前
有效 credential。撤销或降级当前 Owner 时必须保留另一位可登录的 active User Owner。

## 查询 RoleBinding

取得一个 subject 的 current binding：

```json
{
  "schemaVersion": 1,
  "operation": "policy.role-binding.inspect",
  "options": {
    "deploymentRoot": "/srv/qinglong3",
    "databasePath": "/srv/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/srv/qinglong3/owner-keys",
    "credentialFilePath": "/srv/qinglong3/owner-credential.json"
  },
  "request": {
    "projectId": "automation",
    "target": { "type": "user", "id": "operator-user" },
    "requestId": "role-inspect-automation-operator",
    "auditEventId": "55555555-5555-4555-8555-555555555551"
  }
}
```

已授权但从未存在时返回 `found:false`。当前 binding 已撤销时返回 `state:"revoked"`，
不返回 `role`；历史 active revision 不会被当成当前状态。

有界列出每个 subject 的最新 binding：

```json
{
  "schemaVersion": 1,
  "operation": "policy.role-binding.list",
  "options": {
    "deploymentRoot": "/srv/qinglong3",
    "databasePath": "/srv/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/srv/qinglong3/owner-keys",
    "credentialFilePath": "/srv/qinglong3/owner-credential.json"
  },
  "request": {
    "projectId": "automation",
    "limit": 32,
    "state": "active",
    "role": "all",
    "requestId": "role-list-automation-first-page",
    "auditEventId": "55555555-5555-4555-8555-555555555552"
  }
}
```

`limit` 必须为 1–64；`state` 只能为 `active|revoked|all`；`role` 只能为
`owner|admin|operator|viewer|all`。下一页使用新的 request/audit ID，并把响应的
`nextCursor` 原样放入 request：

```json
{
  "after": {
    "subjectType": "api_app",
    "subjectId": "deployment-bot"
  }
}
```

每一页都是独立的 current-head snapshot。若翻页期间发生 put/revoke，需要严格同一
时点清单时从第一页重新查询。RoleBinding query 由目标 Project 自己的当前 Owner
授权，不要求实例 authority Project；但 Owner 不能用一个 Project 的权限查询另一个
Project。

## Authority 与失败处理

- Project lifecycle command 的 `authorityProjectId` 必须是 ADR-0211 定义的实例
  authority Project；
- Project inspect/list 也必须使用该 authority Project；secondary Project Owner
  不能枚举实例 Project 拓扑；
- secondary Project Owner 可以管理自身 RoleBinding，但不能创建、归档或恢复其他
  Project；
- RoleBinding inspect/list 与 put/revoke 一样，只允许目标 Project 的当前 Owner；
- `current_version_conflict`：重新取得受支持的当前版本后创建新 command；
- `mutation_conflict`：同一 mutation ID 已用于不同语义，停止重试并人工调查；
- `project_identity_conflict`：Project ID 或 slug 已存在；
- `project_capacity_exceeded`：已达到 Profile 硬上限；
- `authority_project_protected`：试图归档实例 authority Project；
- `credential_or_policy_fence_rejected`：认证后 credential、authority 或 Owner fence
  已变化，重新认证并使用新 mutation。

当前没有 Project rename、authority transfer 或 hard-delete 命令。不要用直接 SQLite
查询或修改模拟这些产品能力。
