# `ql3-identity` 本机 Identity/Credential 管理

`ql3-identity` 是一次命令、一次进程的 Owner-only 管理入口。它不启动管理服务，也不把
credential token 写入 argv、stdout、stderr、command JSON 或 SQLite。

## 前置条件

- 已完成 Fresh Setup，当前 credential 属于 `default` Project 的 active Owner；
- deployment root、其子目录、SQLite、Owner credential presentation 与 command
  file 均由当前 real/effective UID 拥有；
- 目录权限为 `0700`，文件权限为 `0600`；
- Owner pepper keyring 中存在与 SQLite active pepper 完全匹配的材料；
- managed credential delivery 使用独立、规范化、非 symlink 的 `0700` 目录。

## 实例 Authority Project

Identity 与 API credential 是实例级对象，不属于任意单个业务 Project。
`ql3-identity` 只接受实例 authority Project 的当前 Owner：

- 新部署以全库最早成功消费的 Owner bootstrap challenge 所属 Project 为 authority；
- 没有任何 consumed bootstrap challenge 的旧库兼容回退到迁移内建的 `default`；
- 后续给其他 Project 授予 Owner 不会转移该 authority；
- secondary Project Owner 使用自己的 `projectId` 调用时，返回统一 authorization
  error，并记录 `instance_authority_project_required`；
- 当前没有 authority Project 转移命令，不要通过直接编辑数据库模拟转移。

command 中的 `projectId` 必须填写该 authority Project。它会在服务授权和最终 SQLite
事务各验证一次；直接调用 repository 不能绕过。

所有示例中的 UUID、subject 和路径都必须替换。command file 创建完成后执行：

```sh
ql3-identity run --command-file /srv/qinglong3/commands/identity.json
```

## 查询当前版本

后续 mutation 所需的 `expectedCurrentVersion` 必须通过受支持的 inspect 命令取得，
不要直接查询 SQLite。Identity 精确查询示例：

```json
{
  "schemaVersion": 1,
  "operation": "identity.inspect",
  "options": {
    "deploymentRoot": "/srv/qinglong3",
    "databasePath": "/srv/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/srv/qinglong3/owner-keys",
    "credentialFilePath": "/srv/qinglong3/owner-credential.json"
  },
  "request": {
    "projectId": "default",
    "target": { "type": "agent", "id": "agent-planner" },
    "requestId": "identity-inspect-agent-planner",
    "auditEventId": "10111111-1111-4111-8111-111111111111"
  }
}
```

Credential 精确查询把 operation 改为 `credential.inspect`，request 改为：

```json
{
  "projectId": "default",
  "credentialId": "agent-planner-primary",
  "requestId": "credential-inspect-agent-planner",
  "auditEventId": "10222222-2222-4222-8222-222222222222"
}
```

成功命中只返回 subject、status/state、version 和时间窗；不存在返回：

```json
{
  "schemaVersion": 1,
  "operation": "credential.inspect",
  "projectId": "default",
  "found": false
}
```

`found:false` 只会在 Owner authorization 与事务内 credential/Project/RoleBinding
围栏全部通过后返回。输出不会包含 secret digest、pepper key ID、token、数据库路径
或交付路径。每次人工查询使用新的 `auditEventId`；inspect 不是 mutation，也不使用
`mutationId`、`failureAuditEventId` 或 `expectedCurrentVersion`。

## 注册 Identity

```json
{
  "schemaVersion": 1,
  "operation": "identity.register",
  "options": {
    "deploymentRoot": "/srv/qinglong3",
    "databasePath": "/srv/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/srv/qinglong3/owner-keys",
    "credentialFilePath": "/srv/qinglong3/owner-credential.json"
  },
  "request": {
    "projectId": "default",
    "target": { "type": "agent", "id": "agent-planner" },
    "expectedCurrentVersion": 0,
    "mutationId": "11111111-1111-4111-8111-111111111111",
    "requestId": "identity-register-agent-planner",
    "failureAuditEventId": "11111111-1111-4111-8111-111111111112"
  }
}
```

`identity.enable` 和 `identity.disable` 使用相同结构，并把
`expectedCurrentVersion` 设为当前 Identity version。仍有 active Owner binding 的
User Identity 不能被禁用。

## 签发或轮换 Credential

```json
{
  "schemaVersion": 1,
  "operation": "credential.issue",
  "options": {
    "deploymentRoot": "/srv/qinglong3",
    "databasePath": "/srv/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/srv/qinglong3/owner-keys",
    "credentialFilePath": "/srv/qinglong3/owner-credential.json",
    "credentialDeliveryDirectory": "/srv/qinglong3/managed-credentials"
  },
  "request": {
    "projectId": "default",
    "target": { "type": "agent", "id": "agent-planner" },
    "credentialId": "agent-planner-primary",
    "expectedCurrentVersion": 0,
    "lifetimeMs": 86400000,
    "mutationId": "22222222-2222-4222-8222-222222222221",
    "requestId": "credential-issue-agent-planner",
    "failureAuditEventId": "22222222-2222-4222-8222-222222222222"
  }
}
```

轮换时把 operation 改为 `credential.rotate`，并使用当前 credential version。
`lifetimeMs` 范围为 60 秒至两年。

成功输出示例：

```json
{
  "schemaVersion": 1,
  "operation": "credential.issue",
  "status": "inserted",
  "projectId": "default",
  "target": { "type": "agent", "id": "agent-planner" },
  "credentialId": "agent-planner-primary",
  "version": 1,
  "state": "active",
  "expiresAtMs": 1780000000000,
  "delivery": {
    "fileName": "managed-credential-22222222-2222-4222-8222-222222222221.ready.json",
    "digest": "64-char-lowercase-sha256"
  }
}
```

输出没有绝对路径和 token。ready 文件位于 command 指定的 delivery directory，
权限为 `0600`，其 JSON 可以直接作为后续 `credentialFilePath`。如果 CLI 在 commit
后中断，必须原样重放同一个 command；不要更换 mutation、request、target、version
或 lifetime。

## 确认交付

consumer 已复制、安装并真实验证 ready credential 后，提交确认：

```json
{
  "schemaVersion": 1,
  "operation": "credential.delivery.acknowledge",
  "options": {
    "deploymentRoot": "/srv/qinglong3",
    "databasePath": "/srv/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/srv/qinglong3/owner-keys",
    "credentialFilePath": "/srv/qinglong3/owner-credential.json",
    "credentialDeliveryDirectory": "/srv/qinglong3/managed-credentials"
  },
  "request": {
    "projectId": "default",
    "credentialMutationId": "22222222-2222-4222-8222-222222222221",
    "expectedDeliveryDigest": "replace-with-issue-output-digest",
    "mutationId": "33333333-3333-4333-8333-333333333331",
    "requestId": "credential-delivery-ack-agent-planner",
    "failureAuditEventId": "33333333-3333-4333-8333-333333333332"
  }
}
```

数据库 acknowledgement 先提交，随后 pending/ready 文件才删除。响应丢失时原样
重放；`cleanup:"absent"` 表示数据库已经确认且文件已在前一次执行中安全删除。

不要在 consumer 尚未验证前 acknowledge，也不要把唯一正在用于本命令认证的
credential presentation 提前删除。

## 撤销 Credential

`credential.revoke` 不需要 delivery directory 或 lifetime：

```json
{
  "schemaVersion": 1,
  "operation": "credential.revoke",
  "options": {
    "deploymentRoot": "/srv/qinglong3",
    "databasePath": "/srv/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/srv/qinglong3/owner-keys",
    "credentialFilePath": "/srv/qinglong3/owner-credential.json"
  },
  "request": {
    "projectId": "default",
    "target": { "type": "agent", "id": "agent-planner" },
    "credentialId": "agent-planner-primary",
    "expectedCurrentVersion": 1,
    "mutationId": "44444444-4444-4444-8444-444444444441",
    "requestId": "credential-revoke-agent-planner",
    "failureAuditEventId": "44444444-4444-4444-8444-444444444442"
  }
}
```

撤销 Owner 当前使用的 credential 前，必须先签发并验证另一把有效 credential。
数据库会拒绝撤销 active Owner 的最后一把凭据。

## 运维规则

- 先使用 exact inspect 取得当前 version，再创建 mutation command；不要把数据库表当作
  产品 API；
- command file 是不可变 mutation 载体；响应不确定时只允许原样重放；
- 不编辑 pending/ready 文件，不按 mtime 自动清理；
- `mutation_conflict` 表示相同 mutation ID 已用于不同语义，必须人工调查；
- `owner_continuity_required` 表示操作会造成 Owner 无法接管；
- `credential_or_policy_fence_rejected` 表示认证后 authority 已变化，应重新认证并使用
  新 mutation；
- managed delivery 上限是 64 个条目；长期未确认项需要人工核对，不得用通用目录
  GC 删除。
