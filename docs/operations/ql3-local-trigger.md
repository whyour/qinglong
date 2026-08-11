# `ql3-trigger` 本机 Trigger 管理

`ql3-trigger` 是 Edge/Standalone 的一次命令、一次进程管理入口。它复用现有 application
scheduler，不启动管理服务、独立 timer 或后台连接。Cluster 不支持此入口。

## 前置条件

- 已完成 Fresh Setup、Owner credential、Project/RoleBinding 与 TaskDefinition 配置；
- 调用者是 strong User；owner、admin、operator 可 put，viewer 只能 inspect/list；
- deployment root/子目录属于当前 UID，目录 `0700`、credential 与 command file 为 `0600`；
- 先用 `ql3-task` 执行 `task.inspect` command，取得 Task 的 current `revision` 与
  `contentDigest`；
- 当前 production Trigger registry 只接受 `schema=qinglong/cron@v1`。

统一执行形式：

```sh
ql3-trigger run --command-file /srv/qinglong3/commands/trigger-create.json
```

响应未知时只能原样重放同一个 command file。不要修改 mutation、request、时间、Task binding
或 Trigger 内容来“重试”。

## 创建 Trigger

```json
{
  "schemaVersion": 1,
  "operation": "trigger.put",
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
    "triggerId": "daily-health-check-cron",
    "expectedRevision": null,
    "mutationId": "44444444-4444-4444-8444-444444444441",
    "requestId": "trigger-create-daily-health-check",
    "failureAuditEventId": "44444444-4444-4444-8444-444444444442",
    "taskId": "daily-health-check",
    "taskRevision": 1,
    "taskContentDigest": "REPLACE_WITH_TASK_INSPECT_CONTENT_DIGEST",
    "spec": {
      "schema": "qinglong/cron@v1",
      "config": {
        "expression": "*/5 * * * *",
        "timezone": "Etc/UTC",
        "misfirePolicy": "skip"
      }
    },
    "enabled": true,
    "occurredAtMs": 1785542401000
  }
}
```

`expression` 接受有界五段或六段 cron，`timezone` 必须是运行时支持的 IANA timezone，
`misfirePolicy` 只能是 `skip` 或 `fire_once`。首次返回 `created`；相同文件逐字重放返回
`existing`。

## 更新、停用、启用与 repin

先 inspect 当前 Trigger，取得 `revision`。每次更新都提交新的 `trigger.put`：

- `expectedRevision` 填当前 Trigger revision；
- 每次使用新的 `mutationId`、`requestId`、`failureAuditEventId` 和 `occurredAtMs`；
- 修改 schedule 或 `enabled` 会追加新 revision，不存在原地修改；
- 启用 Trigger 时，`taskRevision`/`taskContentDigest` 必须精确匹配当前且 enabled 的 Task head；
- Task 更新、停用或重新启用后，旧 Trigger 会自动停止 admission。先 inspect Task，再以新的
  Trigger revision 显式 repin；系统不会静默改写绑定；
- Task 已变化时仍允许提交 `enabled:false` 的 Trigger revision，保证 operator 能撤权。此 revision
  可以保留历史 Task pin，但再次启用必须改为 current pin。

扫描取得候选后若 Task 发生变化，最终 Run commit 仍会失败关闭；不需要直接清理 schedule 表。

## 查询一个 Trigger

```json
{
  "schemaVersion": 1,
  "operation": "trigger.inspect",
  "options": {
    "deploymentRoot": "/srv/qinglong3",
    "databasePath": "/srv/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/srv/qinglong3/owner-keys",
    "credentialFilePath": "/srv/qinglong3/owner-credential.json"
  },
  "request": {
    "projectId": "default",
    "triggerId": "daily-health-check-cron",
    "requestId": "trigger-inspect-daily-health-check",
    "auditEventId": "55555555-5555-4555-8555-555555555551",
    "failureAuditEventId": "55555555-5555-4555-8555-555555555552"
  }
}
```

存在时只返回低敏摘要，不返回 cron expression、timezone 或 misfire policy。部署者应保留受保护
的源 command/template，不要把 inspect 当作配置导出。

## 有界列出 Trigger

`trigger.list` request 包含 `projectId`、`limit`、`requestId`、`auditEventId` 与
`failureAuditEventId`。`limit` 必须为 1–256；若 `nextCursor` 非 null，下一页使用新的
request/audit identity，并原样加入：

```json
{ "after": { "triggerId": "daily-health-check-cron" } }
```

列表按 `triggerId` 正序稳定翻页，不支持 offset、模糊搜索或无界返回。每页是独立
current-head snapshot。

## 事务、安全与恢复

- put 的 allowed audit、Trigger head/revision、mutation ledger 与 schedule reset 在同一 SQLite
  事务提交；credential、Policy 或 Task fence 变化会整体回滚；
- exact replay 绑定 actor、Policy fence、Task binding、Trigger spec 和 immutable time；
- 失败后禁止直接 SQL 修补 Trigger、schedule 或 audit；revision conflict 应重新 inspect 并人工
  确认；
- `ql3-trigger` 只适用于 Edge/Standalone。Cluster 必须使用 PostgreSQL/RBAC 管理 transport。
