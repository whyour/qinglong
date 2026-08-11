# `ql3-audit` 本机安全审计查询与诊断压缩

`ql3-audit` 是一次命令、一次进程的实例 Owner 运维入口。它提供有界查询和显式的
诊断审计压缩，不启动管理 daemon，不开放网络端口，也不返回 durable audit 中的
`authenticationId`。

## 前置条件

- 已完成 Fresh Setup 或采用流程；
- 当前 credential 属于实例 authority Project 的 active User Owner；
- deployment root 和子目录由当前 UID 所有，目录为 `0700`、文件为 `0600`；
- SQLite、credential 和 Owner pepper keyring 已通过 readiness。

执行形式：

```sh
ql3-audit run --command-file /srv/qinglong3/commands/audit-list.json
```

command file 必须是 deployment root 内的规范、非 symlink、当前 UID `0600` 文件。

## 查询第一页

```json
{
  "schemaVersion": 1,
  "operation": "security.audit.list",
  "options": {
    "deploymentRoot": "/srv/qinglong3",
    "databasePath": "/srv/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/srv/qinglong3/owner-keys",
    "credentialFilePath": "/srv/qinglong3/owner-credential.json"
  },
  "request": {
    "authorityProjectId": "default",
    "query": {
      "limit": 32,
      "filter": {
        "projectId": "automation",
        "outcome": "denied"
      }
    },
    "requestId": "audit-denied-automation-page-1",
    "auditEventId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
  }
}
```

`limit` 必须为 1–64。`filter` 只能包含以下可选精确条件：

- `projectId`；
- `subject`，形如 `{"type":"user","id":"owner-user"}`；
- `outcome`。

空过滤器必须写成 `"filter": {}`。不支持 offset、模糊查询、任意排序或调用方 SQL。

## 翻页

若响应的 `nextCursor` 非 null，下一条 command 使用新的 request/audit ID，并把 cursor
原样放入 `query.before`：

```json
{
  "query": {
    "limit": 32,
    "before": {
      "occurredAtMs": 1785300000000,
      "eventId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    },
    "filter": {
      "projectId": "automation",
      "outcome": "denied"
    }
  }
}
```

排序固定为 `occurredAtMs DESC,eventId DESC`。每页是独立授权和独立 SQLite snapshot；
如果翻页期间有新事件，而你要求严格同一时点清单，应从第一页重新查询。

不要复用上一页的 `auditEventId`。查询自己的 allowed audit 在读取 snapshot 后才于同一
事务写入，因此当前响应不会包含本次查询事件。

## 输出与安全边界

成功记录只包含 event/request/operation、nullable Project/subject、outcome、reasons、
nullable fence 和 timestamp。输出中不存在 `authenticationId`、credential、pepper、
Secret、路径或 command 内容。

只有实例 authority Project 的当前强认证 User Owner 可以使用此入口。secondary
Project Owner 即使能管理自己的 RoleBinding，也不能枚举实例审计。不要通过直接 SQL
绕过该边界。

## 显式压缩过期诊断事件

先保留部署所需的审计期限，再计算一个不晚于“当前受信时间减 retention”的固定
`eligibleBeforeMs`。例如 Edge 每次最多处理 64 条：

```json
{
  "schemaVersion": 1,
  "operation": "security.audit.compact",
  "options": {
    "deploymentRoot": "/srv/qinglong3",
    "databasePath": "/srv/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/srv/qinglong3/owner-keys",
    "credentialFilePath": "/srv/qinglong3/owner-credential.json"
  },
  "request": {
    "authorityProjectId": "default",
    "retentionMs": 2592000000,
    "eligibleBeforeMs": 1782710400000,
    "limit": 64,
    "mutationId": "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
    "requestId": "audit-compact-2026-06-batch-1",
    "failureAuditEventId": "cccccccc-cccc-4ccc-8ccc-ccccccccccc2"
  }
}
```

约束：

- retention 必须为 30 天至 10 年；
- `eligibleBeforeMs + retentionMs` 不得晚于执行时的受信时钟；
- Edge `limit` 为 1–64，Standalone 为 1–512；
- `mutationId` 和 `failureAuditEventId` 必须不同；
- exact replay 必须复用完全相同的 command 语义；
- 处理下一批时必须生成新的 mutation/request/failure identity。

响应只返回 batch receipt 的低敏投影，包括删除数量、payload bytes、首尾 cursor、
records digest 和创建时间。重复运行新的 batch，直到 `deletedCount` 为 0。

## 压缩的安全边界

v1 只删除超过期限、没有已知引用的诊断事件：

- 所有非 `allowed` outcome；
- 精确只读 operation：
  `identity.inspect`、`credential.inspect`、`policy.project.inspect`、
  `policy.project.list`、`policy.role_binding.inspect`、
  `policy.role_binding.list`、`security.audit.list`。

允许的 mutation、dispatch、execution、package 和 compaction evidence 不会被该命令
删除。不要把它描述为通用 retention、合规销毁或完整日志轮转。

删除、allowed audit 和不可变 compaction receipt 在同一个 `BEGIN IMMEDIATE` 中提交。
命令不执行 `VACUUM`；删除页可供 SQLite 后续复用，但数据库文件大小可能不会立即
下降。物理缩容需要独立的离线备份/恢复维护流程。

查询是有界交互能力，压缩是保守的诊断回收能力；二者都不是合规 export。签名导出、
远端归档、完整领域 retention、销毁证明、聚合和告警仍是后续独立能力。
