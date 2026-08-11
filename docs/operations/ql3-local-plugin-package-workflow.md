# QingLong 3.0 本机 Plugin Package Workflow

`ql3-workflow` 用于检查和启动已经由 Plugin Package 安装、materialize 并发布的 Workflow。它只适用于
edge/standalone；Cluster 后续使用独立的受认证 API/RBAC transport。

## 前置条件

- 已完成 Local Owner credential 与 Project RoleBinding；
- Package generation 处于 active，未 disabled、withdrawn 或 quarantine；
- `ql3-local-application` 正在运行并已输出 `event=active`；
- command 目录为 `0700`，command file 为当前运行 UID 的 canonical `0600` regular file。

## 检查可用 Workflow

```json
{
  "schemaVersion": 1,
  "operation": "workflow.inspect",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "databasePath": "/opt/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/opt/qinglong3/owner-peppers",
    "credentialFilePath": "/opt/qinglong3/owner-credential.json",
    "busyTimeoutMs": 100
  },
  "request": {
    "projectId": "default",
    "packageName": "example-automation",
    "requestId": "workflow-inspect-example-v1",
    "auditEventId": "REPLACE_WITH_UUID_V4",
    "failureAuditEventId": "REPLACE_WITH_DIFFERENT_UUID_V4"
  }
}
```

```sh
chmod 0600 /opt/qinglong3/commands/workflow-inspect.json
ql3-workflow run --command-file /opt/qinglong3/commands/workflow-inspect.json
```

结果只返回 Workflow metadata。记录目标 Workflow 的 `id` 和所有 Step `id`；不要从 Package bundle 手工
拼 generation、revision 或 digest。

## 启动 Workflow

为 plan、Run 和每个 StepRun 分别生成 UUID v4。`stepRunIds` 的 key 必须与 inspect 返回的 Step `id`
精确一致：

```json
{
  "schemaVersion": 1,
  "operation": "workflow.start",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "databasePath": "/opt/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/opt/qinglong3/owner-peppers",
    "credentialFilePath": "/opt/qinglong3/owner-credential.json",
    "busyTimeoutMs": 100
  },
  "request": {
    "projectId": "default",
    "packageName": "example-automation",
    "workflowId": "daily",
    "planId": "REPLACE_WITH_UUID_V4",
    "runId": "REPLACE_WITH_DIFFERENT_UUID_V4",
    "stepRunIds": {
      "collect": "REPLACE_WITH_DIFFERENT_UUID_V4",
      "summarize": "REPLACE_WITH_DIFFERENT_UUID_V4"
    },
    "requestId": "workflow-start-example-v1",
    "auditEventId": "REPLACE_WITH_DIFFERENT_UUID_V4",
    "failureAuditEventId": "REPLACE_WITH_DIFFERENT_UUID_V4"
  }
}
```

```sh
chmod 0600 /opt/qinglong3/commands/workflow-start.json
ql3-workflow run --command-file /opt/qinglong3/commands/workflow-start.json
```

`created` 表示 admission 已耐久提交，不表示 Workflow 已完成。application 的唯一 scheduler cadence 会继续
推进 frontier、Task Attempt 和执行。若命令响应丢失，必须保留并原样重放同一文件；`existing` 表示同一个
durable plan 已存在。不得重新生成 ID 来“重试”，否则会表达一个新的 Workflow Run。

`workflow.inspect` 需要 `run.read`；`workflow.start` 需要 `run.start`。Viewer 可以检查但不能启动，
Operator/Admin/Owner 按当前 RoleBinding 执行。命令不会回显 credential、数据库路径、Package/plan digest、
Task spec 或业务参数。
