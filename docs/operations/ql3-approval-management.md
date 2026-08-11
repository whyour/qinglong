# QingLong 3.0 本机人工 Approval 检查与决定

`ql3-approval` 是 Edge/Standalone 的短生命周期 Owner CLI。它不会启动 daemon、监听端口、执行 migration、消费 Approved
Action 或运行 Tool；未调用时资源占用为零。MCP 可帮助发现和查看脱敏 preview，但不能批准或拒绝。

## 前置条件

- QingLong 3.0 SQLite 已由正常部署流程完成 migration/readiness。
- 当前 POSIX User 拥有私有 deployment root、Owner Pepper keyring、active User credential presentation 和 command file。
- credential 的 User 在目标 Project 对检查具有 `approval.read` + `artifact.read`，对决定具有 `approval.decide`。
- command、credential、数据库与 keyring 路径必须位于同一私有 deployment root；文件为当前 UID 的 `0600` regular file，目录为
  `0700`，不得使用 symlink。

## 第一步：检查 Approval

创建 `/opt/qinglong3/commands/approval-inspect.json`：

```json
{
  "schemaVersion": 1,
  "operation": "approval.inspect",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "databasePath": "/opt/qinglong3/data/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/opt/qinglong3/owner-pepper-keyring",
    "credentialFilePath": "/opt/qinglong3/owner/credential.json",
    "busyTimeoutMs": 500
  },
  "request": {
    "projectId": "default",
    "approvalRequestId": "approval-1",
    "requestId": "owner-review-1",
    "auditEventId": "10000000-0000-4000-8000-000000000001",
    "failureAuditEventId": "10000000-0000-4000-8000-000000000002"
  }
}
```

```sh
chmod 0600 /opt/qinglong3/commands/approval-inspect.json
ql3-approval run --command-file /opt/qinglong3/commands/approval-inspect.json
```

检查输出的 Project、request/version/state/risk、requester、过期时间、preview 和完整 `expectedAction`。不要从 MCP 输出、日志或
猜测重建 action reference/digest；下一步必须复制本次 Owner inspect 返回的整个 `expectedAction`。

## 第二步：批准或拒绝

创建新的私有文件，使用新的 request/audit/failure event ID；`expectedVersion` 固定为 1：

```json
{
  "schemaVersion": 1,
  "operation": "approval.decide",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "databasePath": "/opt/qinglong3/data/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/opt/qinglong3/owner-pepper-keyring",
    "credentialFilePath": "/opt/qinglong3/owner/credential.json",
    "busyTimeoutMs": 500
  },
  "request": {
    "projectId": "default",
    "approvalRequestId": "approval-1",
    "requestId": "owner-decision-1",
    "auditEventId": "20000000-0000-4000-8000-000000000001",
    "failureAuditEventId": "20000000-0000-4000-8000-000000000002",
    "expectedVersion": 1,
    "expectedAction": {
      "permission": "run.start",
      "actionType": "tool.invoke",
      "actionRef": "<copy-from-inspect>",
      "actionDigest": "<64-lowercase-hex-from-inspect>",
      "previewDigest": "<64-lowercase-hex-from-inspect>"
    },
    "decisionId": "approval-decision-1",
    "decision": "approved",
    "reasonCode": "reviewed"
  }
}
```

将 `decision` 改为 `rejected` 可拒绝；`reasonCode` 是稳定的低敏 snake_case 分类，不写自由文本、Secret 或个人信息。

```sh
chmod 0600 /opt/qinglong3/commands/approval-decide.json
ql3-approval run --command-file /opt/qinglong3/commands/approval-decide.json
```

成功返回 `decided` 与 version 2 receipt。命令响应丢失时可用同一个 decision ID、decision、reason、User 与 exact action 重试；
返回 `existing` 表示原决定已持久化。不要修改语义后复用 decision ID。

## 安全与故障处理

- action/preview digest 漂移：重新运行 inspect，确认新内容后创建新的 decision command；不要手工替换摘要绕过检查。
- version/state/expiry 冲突：Approval 已变化或过期，不得强制回写；重新检查或创建新的 Approval request。
- credential/Policy fence rejected：检查 credential 是否 active、User RoleBinding 是否仍允许 `approval.decide`。撤权后重试必须失败。
- separation of duty：请求者与决定者相同时会失败；使用另一个具备强认证和权限的 User，不要复制 credential。
- database/audit unavailable：先修复可写性、容量或锁等待。成功 audit 与决定同事务，不需要也不允许手工补写状态。
- CLI 只作决定，不会 consume/dispatch/execute。决定成功后由对应的受信执行面按自己的 start barrier 和恢复协议处理。

Cluster 部署不运行本机 Owner CLI；其独立 mTLS/OIDC 管理面、一次性 client Job 和 PostgreSQL HA 恢复流程见
[`ql3-cluster-approval-management.md`](./ql3-cluster-approval-management.md)。
