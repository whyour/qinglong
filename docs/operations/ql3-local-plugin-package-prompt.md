# 本机 Plugin Package Prompt

`ql3-prompt` 在 Edge/Standalone 上一次性执行已经安装、materialize 并发布的 Plugin Package
Prompt。它不是 scheduler 或 daemon；每条命令只打开一个 SQLite authority，完成 Model Gateway
drain 后退出。

## 前置条件

1. 本机数据库已完成 AI optional migration，且 `ql3-ai-feature` 当前为 `active`；
2. Prompt 所属 Package 当前 active、未 quarantine，automation publication 中存在目标 Prompt；
3. 当前强 User 同时具有 Project 的 `run.start`、`model.invoke` 与 `secret.use`；
4. Provider token 已通过 `ql3-secret` 写入该 Project，并通过 `ql3-model-credential` 绑定到 Provider；
5. Secret keyring 和 Owner credential 均位于 deployment root 内的私有路径；
6. Provider endpoint/policy manifest 是 canonical JSON regular file，当前 UID 所有，完成配置后改为
   `0400` 或 `0440`，不得包含 token、SecretRef 或 authorization header。

Provider manifest 使用 schema `qinglong/projected-model-gateway-authority@v1`，只声明 Provider
type/base URL、响应字节上限和 Project 模型 Policy。它不是 credential authority；实际 token 在每次
模型请求时由 durable binding 和加密 Secret 重新解析。

## 执行命令

命令文件必须是 deployment root 的后代、当前 UID 所有且 mode `0600`：

```json
{
  "schemaVersion": 1,
  "operation": "prompt.execute",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "databasePath": "/opt/qinglong3/data/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/opt/qinglong3/owner-keys",
    "credentialFilePath": "/opt/qinglong3/credentials/operator.json",
    "secretKeyringPath": "/opt/qinglong3/secrets/keyring.json",
    "providerAuthorityFilePath": "/opt/qinglong3/ai/provider-authority.json",
    "busyTimeoutMs": 1000
  },
  "request": {
    "projectId": "default",
    "packageName": "example-package",
    "promptId": "summary",
    "requestId": "prompt-summary-20260804-1",
    "traceId": "trace-summary-20260804-1",
    "auditEventId": "71000000-0000-4000-8000-000000000001",
    "failureAuditEventId": "71000000-0000-4000-8000-000000000002",
    "parameters": {
      "subject": "仅存在于本次内存和 Provider 请求中的内容"
    },
    "provider": "openai-compatible",
    "model": "vendor/model-a",
    "maxOutputTokens": 512,
    "temperature": 0.2,
    "timeoutMs": 60000,
    "output": {
      "mode": "live_only"
    }
  }
}
```

```sh
chmod 600 /opt/qinglong3/commands/prompt-summary.json
ql3-prompt run --command-file /opt/qinglong3/commands/prompt-summary.json
```

不要在 command 中加入 publication、publicationDigest、generation、plan、Run/StepRun/invocation
identity、Policy fence、SecretRef 或 token；exact-shape 校验会在打开 SQLite 前拒绝这些字段。

## 结果与重放

首次成功返回 content-free receipt identity 和当前 live caller 的模型 `result`。SQLite 中的 plan、
RunEvent、SecurityAudit、credential-use audit 与 finalization 不含参数值或模型正文。使用完全相同的
私有 command file 重放时，返回同一 plan/admission/finalization，`status=existing`、`result=null`，
不会再次调用 Provider。

当前产品入口只接受显式 `live_only`。需要长期保存正文时，不要把 stdout 重定向回数据库或日志；应在
后续接入受支持的加密 `durable_artifact` key/output authority 后再启用该模式。

错误输出只包含稳定 `code`/`name`。token、SecretRef、数据库路径、credential path 和
authentication identity 不会进入错误 JSON。
