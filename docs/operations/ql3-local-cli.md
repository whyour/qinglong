# QingLong 3.0 Local 统一命令入口

Local Owner 管理制品提供统一的 `ql3` 入口，同时保留所有既有专用 binary。统一入口不
改变权限、command-file 或输出协议，只负责从同一安装制品的静态白名单启动精确命令。

```sh
ql3 --version
ql3 --help
ql3 task --help
ql3 readiness --help
ql3 deploy --help
```

常用映射如下：

| 统一命令 | 原专用 binary | 用途 |
| --- | --- | --- |
| `ql3 setup` | `ql3-local-setup` | Fresh Local 存储与 Owner material 准备 |
| `ql3 readiness` | `ql3-local-readiness` | schema 与运行时 readiness 检查 |
| `ql3 deploy` | `ql3-local-deploy` | systemd/OpenRC/Compose 部署 ceremony |
| `ql3 owner` | `ql3-owner` | Owner bootstrap 与恢复 |
| `ql3 identity` | `ql3-identity` | Identity 与 API credential 管理 |
| `ql3 policy` | `ql3-policy` | Project 与 Policy 管理 |
| `ql3 audit` | `ql3-audit` | 有界安全审计查询 |
| `ql3 secret` | `ql3-secret` | Local Secret 管理 |
| `ql3 task` | `ql3-task` | TaskDefinition 管理 |
| `ql3 trigger` | `ql3-trigger` | Trigger 管理 |
| `ql3 workflow` | `ql3-workflow` | Package Workflow 管理 |
| `ql3 approval` | `ql3-approval` | 人工 Approval inspect/decide |
| `ql3 package` | `ql3-package` | Plugin Package 生命周期 |
| `ql3 prompt` | `ql3-prompt` | Package Prompt 查询与执行 |
| `ql3 ai-feature` | `ql3-ai-feature` | 可选 AI schema 激活/停用 |

其他可发现子命令由 `ql3 --help` 列出。子命令后的参数会原样传给专用 binary，因此文档
中的命令可以等价改写，例如：

```sh
ql3 deploy prepare \
  --command-file /secure/operator/qinglong3-deployment.json

ql3 task run \
  --command-file /secure/operator/task-create.json
```

不要用 `eval`、shell alias 或自行拼接 binary 路径包裹 `ql3`。dispatcher 自身不使用
shell 或 `PATH`，并拒绝未知、绝对或路径穿越形式的 command name。

`ql3-service-bridge` 刻意不作为 `ql3` 子命令。它属于 root service-manager authority，
必须继续由 root operator 使用 root-owned `0600` command file 显式运行：

```sh
ql3-service-bridge run \
  --command-file /run/qinglong3-evidence/service-command.json
```

统一入口不会隐式 sudo、读取 root 文件或把 Owner command 转换为 bridge command。
