# QingLong 3.0 Fresh Edge/Standalone 初始化

本流程用于没有 2.x SQLite 数据的新安装。已有 2.x 数据的部署继续使用 adoption
流程，不得把 fresh 模式当作绕过迁移审查的入口。

需要自动创建固定私有目录、application 配置并生成 systemd/OpenRC/Compose
描述符时，优先使用[部署准备器](./ql3-local-deployment.md)。下文保留底层
`ql3-local-setup` 手工流程，供恢复和逐项审计使用。

## 1. 准备私有目录

使用最终运行 QingLong 的同一个 POSIX 用户：

```sh
install -d -m 0700 /opt/qinglong3
install -d -m 0700 /opt/qinglong3/owner-peppers
install -d -m 0700 /opt/qinglong3/owner-pepper-backup
install -d -m 0700 /opt/qinglong3/plugin-staging
install -d -m 0700 /opt/qinglong3/plugin-activation
```

路径必须是 canonical absolute path，不能是 symlink。若平台的 `/var` 实际解析为
`/private/var`，配置中应使用 `realpath` 后的路径。

## 2. 执行可重放 setup

创建 `/opt/qinglong3/setup.json` 并设为 `0600`：

```json
{
  "schemaVersion": 1,
  "operation": "local.setup.prepare",
  "options": {
    "deploymentRoot": "/opt/qinglong3",
    "databasePath": "/opt/qinglong3/qinglong3.sqlite",
    "profile": "edge",
    "ownerPepperKeyringDirectory": "/opt/qinglong3/owner-peppers",
    "ownerPepperBackupDirectory": "/opt/qinglong3/owner-pepper-backup",
    "ownerPepperKeyId": "owner-v1",
    "localSecretKeyringPath": "/opt/qinglong3/local-secret-keyring.json",
    "busyTimeoutMs": 100
  },
  "request": {
    "registerMutationId": "REPLACE_WITH_UUID",
    "activateMutationId": "REPLACE_WITH_DIFFERENT_UUID",
    "registeredAtMs": 1785254400000,
    "activatedAtMs": 1785254400001
  }
}
```

```sh
chmod 0600 /opt/qinglong3/setup.json
ql3-local-setup run --command-file /opt/qinglong3/setup.json
```

首次成功返回 `prepared`；崩溃或结果未知时保留原文件并执行同一命令，成功重放返回
`existing`。不要修改 mutation ID、时间或路径来“重试”。CLI 只输出低敏摘要，不
输出 key、digest 或路径。

setup 只准备存储和密钥 authority。随后使用 `ql3-owner` 完成 Identity provision、
challenge、Owner claim 与 delivery acknowledgement。

## 3. 创建 fresh application 配置

创建 `0600` 的 `/opt/qinglong3/local-application.json`：

```json
{
  "schema": "qinglong/local-application-process@v2",
  "instanceId": "router-edge-1",
  "profile": "edge",
  "storage": {
    "mode": "fresh",
    "databasePath": "/opt/qinglong3/qinglong3.sqlite",
    "busyTimeoutMs": 100
  },
  "runtime": {
    "receiptRoot": "/opt/qinglong3/receipts",
    "artifactRoot": "/opt/qinglong3/artifacts",
    "secretKeyringPath": "/opt/qinglong3/local-secret-keyring.json"
  },
  "pluginPackages": {
    "stagingRoot": "/opt/qinglong3/plugin-staging",
    "activationRoot": "/opt/qinglong3/plugin-activation",
    "recoverySource": {
      "mode": "disabled"
    },
    "pageSize": 4,
    "maxPages": 4,
    "taskPublicationPageSize": 4,
    "taskPublicationMaxPages": 4
  },
  "ai": {
    "deployment": "excluded"
  }
}
```

启动：

```sh
chmod 0600 /opt/qinglong3/local-application.json
ql3-local-application --config /opt/qinglong3/local-application.json
```

看到 `event=active` 后才算 admission 已开放。停止时发送 `SIGTERM`，等待
`event=stopped` 后再维护数据库或密钥文件。

启动前或故障诊断时，可用只读的
[`ql3-local-readiness`](./ql3-local-readiness.md) 复验 84 条 migration、capability、schema
integrity 与 Profile journal mode。不要使用 legacy/Shadow schema audit 代替该门。

## 4. 创建第一个 TaskDefinition 与 Trigger

完成 Owner credential 和 Project/RoleBinding 配置后，使用短生命周期 `ql3-task` 创建、更新、
停用、启用或查询 Task。它不会启动第二个管理 daemon，也不会在输出中回显 command 参数或
SecretRef：

```sh
chmod 0600 /opt/qinglong3/commands/task-create.json
ql3-task run --command-file /opt/qinglong3/commands/task-create.json
```

当前 production registry 只开放 `qinglong/command@v1`。完整 command schema、revision replay、
分页和失败恢复见 [`ql3-task` 运维说明](./ql3-local-task-definition.md)。随后 inspect Task，取得
current `revision` 与 `contentDigest`，创建 `0600` Trigger command file：

```sh
chmod 0600 /opt/qinglong3/commands/trigger-create.json
ql3-trigger run --command-file /opt/qinglong3/commands/trigger-create.json
```

完整 schema、cron 约束、exact replay、停用和 Task 变化后的显式 repin 见
[`ql3-trigger` 运维说明](./ql3-local-trigger.md)。启用的 Trigger 只能固定到当前且 enabled 的
Task head；Task 更新、停用或重新启用后，旧 Trigger 会立即停止 admission，必须显式 repin 才会
继续产生 Run。`ql3-task` 与 `ql3-trigger` 都是短生命周期本机入口，不增加常驻 daemon、timer
或连接；Cluster 必须使用 PostgreSQL/RBAC 管理 transport。

## 5. 检查并启动 Plugin Package Workflow

Package 完成安装、materialize 和 automation publication 后，先使用 `ql3-workflow` 的
`workflow.inspect` 读取当前受审 Workflow/Step metadata，再为 plan、Run 与每个 StepRun 提供
不同的 UUID v4，执行 `workflow.start`。命令经当前 Owner credential 与 Project Policy 验证，
只把 durable Run admission 交给已运行的 application，不同步等待 Workflow 完成：

```sh
chmod 0600 /opt/qinglong3/commands/workflow-inspect.json
ql3-workflow run --command-file /opt/qinglong3/commands/workflow-inspect.json

chmod 0600 /opt/qinglong3/commands/workflow-start.json
ql3-workflow run --command-file /opt/qinglong3/commands/workflow-start.json
```

完整 command schema、`run.read`/`run.start` 权限、created/existing 重放和输出边界见
[`ql3-workflow` 运维说明](./ql3-local-plugin-package-workflow.md)。

AI optional feature 激活、Provider Secret 与 durable credential binding 配置完成后，可使用一次性
`ql3-prompt` 执行已发布 Prompt；它不会启动新的 scheduler 或监听端口。参见
[`ql3-prompt` 运维说明](./ql3-local-plugin-package-prompt.md)。
