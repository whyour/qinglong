# QingLong 3.0 本机 AI Feature 操作手册

本手册只适用于 `edge` 和 `standalone`。Cluster 不得使用本机 Owner command 代替
TLS identity、平台 Policy、quota 和职责分离。

## 部署与启动边界

基础 edge/standalone application 制品不安装 `@qinglong/ai`。需要本机 AI 时，部署
显式的 `edge-application-ai` 或 `standalone-application-ai` 制品。ADR-0178 已提供
`ql3-local-application` headless executable 和统一 product composition，但通用 CLI
当前只直接支持 `deployment=excluded`；installed AI 必须由受信 host 注入 provider
authority。不要把 token 写入启动配置来绕过这道门。受审 composition 为：

```text
@qinglong/local-application/ai-feature
```

不要改为调用基础 `@qinglong/local-application` 后自行加载 provider。受审入口只在
9007 head 为 `active` 且完整 AI schema/history/checksum 通过时动态加载 AI；
deployment excluded、schema absent 和 inactive 都不会加载 provider。

基础进程配置、SIGTERM drain 和低敏日志见
[本机 Headless Application 手册](./ql3-local-application-process.md)。

管理命令不会向常驻进程注入代码，也不包含 watcher：

- `inspect` 成功返回 `runtimeAction: "none"`；
- `activate`、`deactivate` 及其 exact replay 成功返回
  `runtimeAction: "restart_required"`。

activate 后必须重启应用，重启成功且 AI 状态为 `active` 才表示 provider 已装配。
deactivate 提交后数据库 admission fence 已立即生效；当前进程下一次 AI 操作会拒绝
请求并进入 drain。完成有界 drain 后重启应用，确认 AI 状态为 `inactive` 且 provider
loader 为零，才完成可验证卸载。

## 安全前置

1. 使用 QingLong 部署用户执行，不使用远程 HTTP、聊天输入或公共目录传递命令。
2. command 目录权限设为 `0700`，command file 设为 `0600`。
3. 准备当前 local-console credential presentation 和 Owner pepper keyring。
4. 对已有数据库先完成 SQLite 文件及 `-wal`/`-shm` 一致性备份，并记录备份制品的
   SHA-256；新库可使用 `fresh_database`。
5. 不手工修改 `QingLong3AiSchemaMigrations`、feature transition/head 或 AI 业务表。

以下路径必须替换成当前部署的规范化绝对路径。UUID 必须为新的 v4 UUID。

## 1. Inspect

```json
{
  "schemaVersion": 1,
  "operation": "ai-feature.inspect",
  "options": {
    "deploymentRoot": "/opt/qinglong",
    "databasePath": "/opt/qinglong/data/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/opt/qinglong/config/owner-keys",
    "credentialFilePath": "/opt/qinglong/private/owner-credential.json"
  },
  "request": {
    "requestId": "ai-feature-inspect-20260727",
    "failureAuditEventId": "00000000-0000-4000-8000-000000000001"
  }
}
```

```sh
ql3-ai-feature run --command-file /opt/qinglong/private/ai-feature-inspect.json
```

保存输出中的 `migrationPlanDigest`。`schemaState`：

- `absent`：没有 AI feature schema；
- `partial_or_drifted`：可能是中断的 reviewed migration，也可能是漂移；不要手工修表；
- `ready`：9001–9007 history/checksum 和全部本机 AI 表已通过只读核对。

## 2. 首次启用

新库使用：

```json
{
  "schemaVersion": 1,
  "operation": "ai-feature.activate",
  "options": {
    "deploymentRoot": "/opt/qinglong",
    "databasePath": "/opt/qinglong/data/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/opt/qinglong/config/owner-keys",
    "credentialFilePath": "/opt/qinglong/private/owner-credential.json"
  },
  "request": {
    "requestId": "ai-feature-activate-20260727",
    "failureAuditEventId": "00000000-0000-4000-8000-000000000002",
    "mutationId": "ai-feature-activate-20260727",
    "expectedGeneration": 0,
    "expectedState": null,
    "expectedMigrationDigest": "REPLACE_WITH_INSPECTED_PLAN_DIGEST",
    "safety": {
      "mode": "fresh_database",
      "backupEvidenceDigest": null
    }
  }
}
```

已有库把 safety 改为：

```json
{
  "mode": "backup_verified",
  "backupEvidenceDigest": "REPLACE_WITH_64_HEX_BACKUP_EVIDENCE_DIGEST"
}
```

命令中断时，保留同一私有 command file 原样重试。不得生成新 mutation 来“绕过”
partial schema。只有返回 `schemaState=ready` 且 `activation.state=active` 后，价格管理和
新 ModelInvocation admission 才可用。确认响应中的
`runtimeAction="restart_required"`，随后重启 AI application 制品；不要等待后台
watcher，因为系统不会创建 watcher。

## 3. 非破坏性停用

先停止产生新 AI 请求并等待现有 invocation 终结。使用 inspect 返回的 generation：

```json
{
  "schemaVersion": 1,
  "operation": "ai-feature.deactivate",
  "options": {
    "deploymentRoot": "/opt/qinglong",
    "databasePath": "/opt/qinglong/data/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/opt/qinglong/config/owner-keys",
    "credentialFilePath": "/opt/qinglong/private/owner-credential.json"
  },
  "request": {
    "requestId": "ai-feature-deactivate-20260727",
    "failureAuditEventId": "00000000-0000-4000-8000-000000000003",
    "mutationId": "ai-feature-deactivate-20260727",
    "expectedGeneration": 1,
    "expectedState": "active",
    "expectedMigrationDigest": "REPLACE_WITH_INSPECTED_PLAN_DIGEST",
    "safety": {
      "mode": "preserve_existing",
      "backupEvidenceDigest": null
    }
  }
}
```

出现 `LOCAL_AI_FEATURE_IN_FLIGHT_INVOCATION` 时不要删行；等待 completion/recovery
收敛后原样重试。成功停用不会删除 schema、价格、usage、quota、invocation 或审计
事实。确认 `runtimeAction="restart_required"`，等待当前进程有界 drain，再重启并
inspect；重启后的 AI 状态必须为 `inactive`。

## 4. 重新启用

重新 inspect，使用当前 inactive generation、`expectedState: "inactive"` 和新的
mutation/request/audit ID。已有 durable data 必须使用 `backup_verified`，不能再声明
`fresh_database`。

## 5. 失败处理

- `...COMMAND_CONFIGURATION_INVALID`：命令 shape、路径、权限或字段不合法；
- `...TRANSITION_CONFLICT`：plan digest、CAS、mutation replay 或身份发生漂移；
- `...DATA_SAFETY_REJECTED`：空库/备份声明不满足当前 durable data；
- `...FEATURE_NOT_READY`：schema/history/checksum 未通过；
- `...FENCE_REJECTED` / `...OWNER_REJECTED`：credential/pepper/User/Owner 已漂移；
- `...IN_FLIGHT_INVOCATION`：仍有未完成调用；
- `...MIGRATION...UNAVAILABLE`：保留原命令和数据库，先检查磁盘、锁、完整性与审计，
  不手工补 history。

每次操作后再次 inspect，并执行 SQLite `integrity_check`、备份可恢复性和应用启动门。
若 active head 存在但应用启动返回
`LOCAL_AI_FEATURE_APPLICATION_UNAVAILABLE`，不得绕过 AI 入口启动成“部分 ready”：
检查部署是否确实包含 `@qinglong/ai`、9001–9007 history/checksum、provider credential
和 recovery 状态；修复后重新执行同一产品启动门。
