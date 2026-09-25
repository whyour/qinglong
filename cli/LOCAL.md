# 面板内部 TypeScript 工具

**简体中文** | [English](LOCAL.en.md)


npm 与面板内部入口都叫 `ql`，但使用独立的 Commander 命令树：npm 入口只调用远程 API，内部入口只运行本机工具。使用前确认可执行文件的绝对路径和 `--help`；安装 npm 包不会迁移内置 Shell 命令。

这些工具随面板构建交付，不包含在 `@qinglong/cli` npm 包中。要求 Node >=22.12；用户配置和 hook 保持 Bash，任务还需要对应解释器。开发发布命令已移除，原 `shell/pub.sh` 保留供发布流程使用。

```sh
npm ci --prefix cli
npm run build:cli
node cli/dist/ql.js --help
node cli/dist/ql.js task exec --root /ql demo.js now
node cli/dist/ql.js reload --root /ql
```

必须在实际安装面板的宿主机或容器中运行。Docker 使用 `docker exec <容器> <容器内选定入口> ...`；不能在工作站上用 npm ql 重置远端账号，单独挂载 data 目录也不是完整运行环境。

## 命令

| 能力 | 内部命令 |
| --- | --- |
| 脚本执行/清单 | `ql task exec [选项] [脚本]`，兼容 `ql task <脚本>` 和 `task <脚本>` |
| 订阅同步 | `ql repo <url> [include] [exclude] [dependencies] [branch] [extensions] [proxy] [autoAdd] [autoDelete]`、`ql raw <url> [proxy] [autoAdd] [autoDelete]` |
| 启动与修复 | `ql start`、`ql repair-config`、`ql check` |
| 升级/重载 | `ql update [--mirror github\|gitee] [--download-only]`、`ql reload [--target services\|system\|data]` |
| 日志与扩展 | `ql rmlog <days>`、`ql extra`、`ql bot` |
| 账号恢复 | `ql resetlet`、`ql resettfa`、`ql resetpwd -- <value>`、`ql resetname -- <value>` |

`ql local <命令>` 保留为兼容写法。`update false` 等价于 `--download-only`，`reload system/data/services` 映射到 `--target`。维护选项 `--root`、`--data-dir`、`--json` 必须放在 `--` 前。密码位置参数会出现在进程参数中，使用本人可信终端，不向聊天发送密码。

执行器选项必须放在脚本前；`now` 跳过延迟，`conc`/`desi` 支持账号选择，`--` 后参数透传。设置 QL_DIR 后，无参数 `ql task` 或 `task` 显示 JS 脚本清单；显式 `--help` 不读取配置。`--json` 将脚本输出写 stderr、最终结果写 stdout，并保留脚本退出码。内部入口拒绝远程 API 命令，不读取远程认证配置。远程管理使用独立 npm 入口；与 API 动作同名的脚本使用显式 `task exec`。

repo/raw 沿用位置参数，使用 QL_DIR/QL_DATA_DIR，不接受 --root/--json；筛选采用本机 `grep -E` 的 POSIX ERE，需 Git/curl 等系统工具。配置桥使用 Bash 和支持 `-0` 的 env。

`check` 会安装依赖、修复并重载，并非只读探测；结果须检查 before/after 健康观测。`reload` 默认重启服务，system/data 应用暂存文件。`start --no-startup` 跳过 OS 启动注册，适用于容器；`start --reload` 跳过依赖安装、可选 hook 与启动注册。Bot 涉及系统/pip 依赖与外部进程。

## 集成与 Skill

包含选择加载器的面板设置 `QL_CLI_ROOT=/absolute/path/to/built/cli`，指向包含完整 dist 的面板工具构建目录，**不能指向 npm 包**。重启后加载器在 ~/bin 创建私有 ql/task/cron 包装器，并为面板进程优先使用它们；独立终端应显式使用该路径。清除变量并重启恢复原 Shell 入口。无效路径报错，不静默降级。默认仍保留旧 Shell 入口。

`dist/startup.js` 兼容旧启动/reload；`dist/compat.js` 与 `dist/subscription-worker.js` 保留内部适配用途，不注册为 npm 命令。生命周期根据已安装面板版本选择字段，定制版本可设置 QL_CLI_LIFECYCLE=legacy|extended。

独立 Skill 位于 [skills/qinglong-local](skills/qinglong-local/SKILL.md)，包含完整执行与维护参考。远程管理另用 qinglong-cli Skill。`QL_LANG=en` 切换帮助和执行提示；JSON 字段保持一致。

功能验收区分隔离夹具、真实面板和真实系统升级/重启。不能将夹具通过视为所有发行版、Bot 或公网升级均已验证。开发发布从迁移目标中明确排除；性能比较使用临时评测脚本，不随产品发布。
