# Node.js 原生部署与 Python venv

面板要求 Node.js >=22.17，推荐 Node.js 24，并要求该 Node 构建提供 `node:sqlite`。应用升级保留现有 Node；旧 Node 20 环境需先升级运行时。远程管理 CLI 的最低版本要求独立于面板。

设置 `QL_DIR` 为安装目录，`QL_DATA_DIR` 为以 `/data` 结尾的绝对持久化数据路径。
如需隔离 Python，请在启动进程的环境中显式设置 `PYTHON_VENV_DIR`（绝对路径或相对 `QL_DIR` 的路径），例如 `export PYTHON_VENV_DIR=/srv/qinglong/.venv`。未设置时保留现有 Python prefix 行为。

- `qinglong`（`shell/start.sh`）安装系统依赖和 Node 工具，并安装 Python requests，然后调用公共启动脚本。
- `npm run start:simple`（`shell/start-simplify.sh`）使用已准备的 Node、pm2、nginx、jq 等依赖，不安装系统包、全局 npm 包或 requests；显式指定的 venv 不存在时仍会创建。请先在 venv 中安装 requests 和任务所需依赖。
- 两种启动方式均保留已有 `.env`；使用 venv 时清除继承的 `PYTHONPATH`/`PYTHONUSERBASE`，依赖查询、安装和卸载使用该 venv 的 Python。

该模式需具备现有启动流程所要求的 nginx 配置和 pm2 服务权限。生产环境设置变量应通过 systemd 的 `Environment` 或相应进程配置完成。已有系统 Python 依赖不自动迁移至 venv，需在 venv 中重新安装。
