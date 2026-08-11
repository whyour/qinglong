# `ql3-task` 本机 TaskDefinition 管理

`ql3-task` 是 Edge/Standalone 的一次命令、一次进程管理入口。它不启动管理服务；成功输出
不包含 Task spec、命令参数、SecretRef、credential、pepper 或本机路径。

## 前置条件

- 已完成 Fresh Setup、Owner credential 交付与 Project/RoleBinding 配置；
- 调用者是 strong User；owner、admin、operator 可 create/update，viewer 只能 inspect/list；
- deployment root/子目录属于当前 UID，目录 `0700`、credential 与 command file 为 `0600`；
- 当前 production Task registry 只接受 `kind=command`、`schema=qinglong/command@v1`。

统一执行形式：

```sh
ql3-task run --command-file /srv/qinglong3/commands/task-create.json
```

响应未知时只能原样重放同一个 command file。不要修改 mutation、request、时间或 Task 内容
来“重试”。

## 创建 Task

```json
{
  "schemaVersion": 1,
  "operation": "task.put",
  "options": {
    "deploymentRoot": "/srv/qinglong3",
    "databasePath": "/srv/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/srv/qinglong3/owner-keys",
    "credentialFilePath": "/srv/qinglong3/owner-credential.json",
    "busyTimeoutMs": 100
  },
  "request": {
    "projectId": "default",
    "taskId": "daily-health-check",
    "expectedRevision": null,
    "mutationId": "11111111-1111-4111-8111-111111111111",
    "requestId": "task-create-daily-health-check",
    "failureAuditEventId": "11111111-1111-4111-8111-111111111112",
    "name": "Daily health check",
    "description": "Print a bounded local health marker",
    "kind": "command",
    "spec": {
      "schema": "qinglong/command@v1",
      "config": {
        "command": {
          "kind": "argv",
          "file": "/usr/bin/printf",
          "args": ["health-check\\n"]
        }
      }
    },
    "labels": { "team": "operations" },
    "enabled": true,
    "occurredAtMs": 1785542400000
  }
}
```

`occurredAtMs` 是 immutable command 语义的一部分，必须在创建 command file 时固定；不得用
每次执行时的当前时间替换。首次返回 `created`，结果未知后逐字重放返回 `existing`。

## 更新、停用与重新启用

先 inspect 当前 Task，取得 `revision`。随后创建新的 `task.put` command：

- `expectedRevision` 填当前 revision；
- 每次使用全新的 `mutationId`、`requestId`、`failureAuditEventId` 和 `occurredAtMs`；
- 修改 name/description/spec/labels 或 enabled；
- 停用设 `enabled:false`，重新启用设 `enabled:true`。

成功返回 `updated` 和递增 revision。不存在原地修改或 delete；历史 revision 继续解释已经
固定到旧 revision 的 Run。`expectedRevision` 冲突时不要盲重试，重新 inspect 并人工确认差异。

## 查询一个 Task

```json
{
  "schemaVersion": 1,
  "operation": "task.inspect",
  "options": {
    "deploymentRoot": "/srv/qinglong3",
    "databasePath": "/srv/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/srv/qinglong3/owner-keys",
    "credentialFilePath": "/srv/qinglong3/owner-credential.json"
  },
  "request": {
    "projectId": "default",
    "taskId": "daily-health-check",
    "requestId": "task-inspect-daily-health-check",
    "auditEventId": "22222222-2222-4222-8222-222222222221",
    "failureAuditEventId": "22222222-2222-4222-8222-222222222222"
  }
}
```

已授权但不存在返回 `found:false`。存在时仅返回低敏摘要，不返回 `spec.config`；需要更新的
部署者应保留自己受保护的源 command/template，不能把 inspect 当作明文配置导出。

## 有界列出 Task

```json
{
  "schemaVersion": 1,
  "operation": "task.list",
  "options": {
    "deploymentRoot": "/srv/qinglong3",
    "databasePath": "/srv/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/srv/qinglong3/owner-keys",
    "credentialFilePath": "/srv/qinglong3/owner-credential.json"
  },
  "request": {
    "projectId": "default",
    "limit": 32,
    "requestId": "task-list-default-first-page",
    "auditEventId": "33333333-3333-4333-8333-333333333331",
    "failureAuditEventId": "33333333-3333-4333-8333-333333333332"
  }
}
```

`limit` 必须为 1–256。若 `nextCursor` 非 null，下一页使用新的 request/audit identity，并把
cursor 原样放入 request：

```json
{ "after": { "taskId": "daily-health-check" } }
```

列表按 `taskId` 正序稳定翻页，不支持 offset、模糊搜索或无界返回。每页是独立 current-head
snapshot；若翻页期间有更新，需要严格同一时点清单时从第一页重新查询。

## 事务、安全与恢复

- create/update 的 allowed audit、Task head、immutable revision、mutation ledger 和可执行
  command revision 在同一 SQLite 事务提交；credential 或 Policy 在授权后变化会整体回滚；
- authentication/authorization/fence/semantic/revision/audit 冲突均失败关闭；禁止直接 SQL 修补；
- 成功输出的 `contentDigest` 可用于变更审核，但不是可反推出 spec 的备份；
- `ql3-task` 只适用于 Edge/Standalone。Cluster 必须使用后续 PostgreSQL 管理 transport，不得把
  本机 credential/SQLite 文件挂入集群 Pod 作为替代入口。
