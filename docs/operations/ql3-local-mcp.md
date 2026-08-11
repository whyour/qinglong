# QingLong 3.0 本机 MCP Task/Trigger/Run/Approval 发现、预览与运行诊断

`ql3-mcp` 是一个显式可选的 stdio sidecar，供同机 AI Client/Agent 发现当前 Project 的 Task、Trigger、最近 Run 与 Approval 状态，读取单个 Approval 的脱敏预览，以及读取单个 Run 的低敏状态和有界事件元数据。它不会随 Edge/Standalone application 自动启动，不监听网络端口，也不会执行 migration、任务、Shell、Approval decision 或管理操作。

## 前置条件

- 已完成 QingLong 3.0 fresh/adopted SQLite 部署和 readiness；MCP 启动只检查 schema，不自动升级数据库。
- 已通过 [本机 Identity Credential](./ql3-local-identity-credential.md) 签发 active API credential presentation。
- credential 对应 subject 在目标 Project 至少具有相应的 `task.read`、`trigger.read`、`run.read` 或 `approval.read`；读取 Approval preview 还必须同时具有 `artifact.read`。调用方还需获得目标 Tool 的 exact `tool.call:<tool-name>` permission。
- config、credential、SQLite 文件必须是当前 UID 持有的 `0600` regular file，目录必须是当前 UID 持有的私有目录；不得使用 symlink。
- Owner Pepper keyring 必须存在并包含 credential 记录绑定的 active/retired exact key。

## 私有配置

示例 `/opt/qinglong3/mcp/mcp.json`：

```json
{
  "schema": "qinglong/local-mcp-server@v1",
  "profile": "edge",
  "projectId": "default",
  "deploymentRoot": "/opt/qinglong3",
  "databasePath": "/opt/qinglong3/data/qinglong3.sqlite",
  "ownerPepperKeyringDirectory": "/opt/qinglong3/owner-pepper-keyring",
  "credentialFilePath": "/opt/qinglong3/mcp/credential.json",
  "busyTimeoutMs": 500
}
```

`profile` 只能是 `edge` 或 `standalone`。三个 authority path 必须互不相同且都是 `deploymentRoot` 的规范化后代；`busyTimeoutMs` 可省略，范围为 100–30000 ms。配置只允许上述字段。

credential presentation 的形状为：

```json
{
  "schemaVersion": 1,
  "kind": "qinglong3-local-identity-credential-presentation",
  "token": "<ql3c credential token>"
}
```

设置私有权限后先做帮助检查：

```sh
chmod 0700 /opt/qinglong3/mcp
chmod 0600 /opt/qinglong3/mcp/mcp.json /opt/qinglong3/mcp/credential.json
ql3-mcp --help
```

## AI Client 配置

在支持本机 stdio MCP 的 Client 中，把 command/args 配为：

```json
{
  "command": "/absolute/path/to/ql3-mcp",
  "args": [
    "--config",
    "/opt/qinglong3/mcp/mcp.json"
  ]
}
```

Client 必须保持 stdin/stdout 直连。stdout 专用于 MCP JSON-RPC，不能通过会插入 banner、日志或 shell profile 输出的包装脚本启动；低敏进程错误写入 stderr。关闭 Client 的 stdin 或发送 `SIGINT`/`SIGTERM` 会关闭 MCP transport 和唯一 SQLite connection。

## Tool 契约

当前只发布七个只读 Tool。

`qinglong.task.list` 接受：

```json
{
  "limit": 32,
  "after": {
    "taskId": "task-id-from-previous-page"
  }
}
```

`after` 和 `limit` 都可省略；`limit` 默认 32、最大 64。响应按 `taskId` 严格递增，只返回当前 Task 的 ID/revision/name、kind、spec schema identity、enabled 与更新时间。`hasMore=true` 时原样使用 `next`。disabled Task 仍会出现，但明确返回 `enabled=false`。

Project ID 来自私有配置。description、spec config/command、labels、mutation/content digest、Secret reference 与数据库字段不会返回；该列表只用于发现，不构成 Task 执行授权。

`qinglong.trigger.list` 接受：

```json
{
  "limit": 32,
  "after": {
    "triggerId": "trigger-id-from-previous-page"
  }
}
```

`after` 和 `limit` 都可省略；`limit` 默认 32、最大 64。响应按 `triggerId` 严格递增，只返回当前 Trigger 的 ID/revision、固定绑定的 Task ID/revision、spec schema identity、enabled 与更新时间。`hasMore=true` 时原样使用 `next`。disabled Trigger 仍会出现，但明确返回 `enabled=false`。

Project ID 来自私有配置。cron expression、timezone、misfire/config、Task/Trigger content digest、mutation ID、Secret reference 与数据库字段不会返回；列表只说明当前调度定义和 Task 的绑定关系，不构成执行或变更授权。

`qinglong.approval.list` 接受：

```json
{
  "limit": 32,
  "after": {
    "updatedAtMs": 1786360000000,
    "requestId": "approval-id-from-previous-page"
  }
}
```

`after` 和 `limit` 都可省略；`limit` 默认 32、最大 64。响应按
`updatedAtMs DESC, requestId DESC` 排列，只返回 request ID、version/state/risk/decision mode、permission/action type、
requester type，以及请求、过期、决定、消费和更新时间。`hasMore=true` 时必须原样使用服务端 `next`。

Project ID、action reference、action/preview/request digest、requester/decider ID、authentication ID、reason、Policy fence、
decision/consumption/dispatch ID 和 preview 内容不会返回。列表仅用于判断动作仍在等待、已拒绝、已批准或已消费；它不授予
approve、reject、consume、dispatch 或 execute 权限，也不能替代强 User 的 Approval 产品流程。

`qinglong.approval.get` 接受：

```json
{
  "requestId": "approval-id-known-by-caller"
}
```

成功响应只含 `found`；存在时返回列表已有的 request ID、version/state/risk/decision mode、permission/action type、
requester type、请求/过期时间、`previewAvailable`，以及可用时经过 Tool redaction contract 生成的
`title/summary/fields/warnings`。`redacted` field 不含 value。无 preview 时明确返回 `previewAvailable=false`；不存在与跨
Project 不可区分。

该 Tool 必须同时通过 `approval.read` 与 `artifact.read`。MCP 不读取 input Artifact，不获得 ciphertext、key、artifact ID、
action reference、任一 digest、主体 ID、authentication、reason/fence、decision/consumption/dispatch evidence。关联或存储
校验失败统一返回 unavailable，不回退到未验证 JSON，也不扫描其它 Artifact。

`qinglong.run.list` 接受：

```json
{
  "limit": 32,
  "after": {
    "createdAtMs": 1786340000000,
    "runId": "run-id-from-previous-page"
  }
}
```

`after` 和 `limit` 都可省略；`limit` 默认 32、最大 64。响应中的 Run 按 `createdAtMs DESC, id DESC` 排列，只包含 ID、Task ID/revision、status/version/event sequence/priority、execution origin/owner 和生命周期时间。`hasMore=true` 时，下一次调用应原样使用 `next`；不要构造 offset 或猜测 cursor。

Project ID 来自私有 MCP 配置，不接受客户端指定。Task name/snapshot、trigger/actor/request、input/output reference、cancel/error detail、Attempt/Event payload、Artifact/Log 和 Secret 永不返回。

`qinglong.run.get` 接受：

```json
{
  "runId": "run-id-known-by-caller"
}
```

成功响应只含 `found`，以及存在时的 Run ID、Task ID/revision、status、version、event sequence、priority、execution origin/owner 和生命周期时间。Task snapshot、command、input/output reference、credential、Principal、Policy reason、路径及内部错误不会返回。不存在和跨 Project 都返回 `{"found":false}`。

`qinglong.run.events.list` 接受：

```json
{
  "runId": "run-id-known-by-caller",
  "afterSequence": 0,
  "limit": 32
}
```

`afterSequence` 可省略；`limit` 默认 32、最大 64。响应固定为 `found`、低敏 `events`、`hasMore` 与 `nextAfterSequence`；每个事件只含 `sequence`、`type`、`actorType` 和 `createdAtMs`。事件按 sequence 严格递增，游标只指向本页最后一条事件。Run 不存在或跨 Project 时统一返回 `found=false` 和空 events，不继续查询事件。

事件 payload、event ID、dedupeKey、actorId、attemptId、stepRunId、Artifact/Log reference、命令和错误详情永不返回。需要下一页时使用响应中的 `nextAfterSequence`，不要自行猜测 sequence。

每次调用都会重新认证 credential，解析 exact Tool Definition，执行 Tool-specific permission 与对应的 `task.read`/`trigger.read`/`run.read`/`approval.read` Policy；Approval preview 额外要求 `artifact.read`。通过后先持久写 Security Audit，再确认 credential fence，最后才做 Project-scoped 有界读取。事件 Tool 只有在 point read 确认 Run 属于当前 Project 后才查询事件。撤销 credential/RoleBinding 后无需重启 MCP 进程；后续调用会失败关闭。

## 资源档位

`edge-mcp`/`standalone-mcp` 是独立制品，不属于默认 application。MCP 单一消费者的 Task/Trigger/Run/Approval projection 位于 sidecar 自身的 `tool-projection` domain；默认 application 不加载这些文件。跨产品复用的 `run.get` projection、Profile-neutral Approval discovery/detail contract 和双方言 document-only source 保留在既有包内；完整 Tool Invocation Artifact 不进入 MCP projection。当前 Standalone 裁剪后闭包为 947 files、9,857,149 bytes、203 loaded modules，完整 import RSS 增量 40,632,320 bytes，硬门为 1,536 files、16 MiB、48 MiB。64 MiB 总内存设备不应启用；128 MiB 设备也应结合 application、内核页缓存和其他服务实测后决定。资源不足时保持 MCP 未安装/未启动，不影响 QingLong 调度。

可复核运行：

```sh
pnpm run audit:artifact:edge-mcp:ql3
pnpm run audit:artifact:standalone-mcp:ql3
```

## 故障处理

- 启动立即失败：先运行本机 readiness，确认 schema 已迁移、Profile 与 journal mode 匹配，再检查 config/credential/keyring 的 owner、mode、regular-file 与 no-symlink 条件。
- Tool 返回认证错误：检查 credential 是否 active、是否仍绑定可解析 Pepper key，以及 presentation 是否被替换。
- Tool 返回 Policy 拒绝：按 [本机 Project Policy](./ql3-local-project-policy.md) 检查 subject 的当前 RoleBinding；不要通过复制 Owner credential 绕过授权。
- Tool 返回 audit/database unavailable：MCP 会在 Run read 前失败关闭。修复 SQLite 可写性/容量/锁等待后重试，不要删除 audit 或自动 migration。
- 需要 Workflow start、Approval decision、未脱敏 input、Shell、Secret、事件 payload 或写操作：当前 MCP 明确不支持；不得通过自定义 wrapper 把这些操作伪装成任一只读 Tool。
