# QingLong 2.x TypeScript CLI

**简体中文** | [English](README.en.md)

独立 CLI，通过 2.x 开放 API 管理任务和订阅。当前为并行评测入口，默认保留原 `ql`、`task` Shell 入口和用户配置；可通过下文 `QL_CLI_ROOT` 显式选择 TS 入口。新 CLI 不隐式调用旧 Shell。

## npm 安装

npm 包是 CLI 唯一的独立发布产物，不单独发布 CLI 镜像。要求 Node >=22.12，推荐 Node 24。包版本发布后使用：

```sh
npm install -g @qinglong/cli
ql --help
# 临时运行：包有多个 bin，因此显式选择 ql。
npm exec --package=@qinglong/cli -- ql --help
```

本分支准备 npm 交付，尚未发布到 registry；发布前可从源码执行 `npm ci --prefix cli`，再进入 `cli` 目录执行 `npm pack` 安装本地产物。远程 API 管理只需要 Node；本机执行和运维还需要面板文件、对应解释器与系统工具。面板镜像可集成同一 npm 产物并随面板发布。

## 统一入口

所有能力统一使用 `ql`：面板资源按 `auth`、`task`、`subscription` 分组，本机运维直接用 `ql update/reload/check` 等命令，开发发布使用 `ql dev`。`task` 是 `ql task` 的快捷入口，参数和行为相同。

```sh
ql task list --json                    # 面板任务
ql task run 12 --json                  # 请求面板执行任务 ID
ql task demo.js now                    # 本机脚本
ql task exec --root /ql demo.js now     # 显式本机执行
task demo.js now                      # 等价于 ql task demo.js now
ql update --help
ql raw <url>                     # 本机订阅执行器，沿用旧参数
ql subscription run 5 --json           # 面板订阅 ID
ql dev release --root /repo --json
```

`list/get/run/stop/logs` 是 `ql task` 的管理动作，`exec` 是显式本机执行动作；同名脚本必须用 `ql task exec <script>` 或 `ql task ./<script>`，不会把无效任务 ID 自动当脚本执行。`ql task` 无参数显示组合帮助；需要旧脚本清单用 `ql task exec --root /ql`。脚本后的参数仍原样透传，`--` 后的 `--json` 等参数属于脚本。

`ql local <命令>` 保留为兼容别名。`ql update false` 等价于 `ql update --download-only`，`ql update true` 保留默认应用升级行为；`ql reload system|data|services` 等价于对应的 `--target`。旧位置参数后可继续添加 `--root`、`--json` 等选项，重复选项仍会报错。`ql repo/raw` 沿用旧订阅参数。原 `ql-cli`、`ql-local-cli`、`ql-task-cli` 等包入口暂留为兼容别名，新文档统一使用 `ql`。独立包现在提供 `ql` 和 `task`，全局安装会占用这两个名称；评测可使用独立 npm prefix 或 `node /absolute/path/to/dist/ql.js`，面板进程仍需显式设置 `QL_CLI_ROOT` 才会切换入口。

## 命令边界

本机执行与运维通过统一命令树分组；用户配置和 hook 继续使用 Bash。

| 入口 | 职责 | 当前状态 |
| --- | --- | --- |
| `ql` / `dist/ql.js` | 认证、任务与订阅的面板 API 管理 | 已通过隔离 API 与真实面板验收 |
| `qinglong-cli` / `dist/startup.js` | 兼容原 qinglong 无参数启动／reload，复用本机 start | 参数转发、双语帮助及独立安装已验证 |
| `ql update/reload/check/…`（别名 `ql local …`） | 本机日志清理、账号重置、extra 脚本等运维 | 已实现，包含真实 Linux 运维验收 |
| `ql task exec` / `dist/runner.js` | 本机脚本执行、日志与生命周期上报 | 已通过兼容评测、真实面板调度与三平台回归 |
| `ql-subscription-worker` / `dist/subscription-worker.js` | 内部 repo/raw 拉取、文件同步、定时任务协调 | 已通过临时面板 repo/raw 调度验收 |
| `ql-compat` / `dist/compat.js` | 旧 `ql` 参数分流至本机运维与内部 worker | 显式入口选择及重载保留已验证 |
| `ql dev` / `dist/developer.js` | 开发发布计划、CDN 元数据与分支/标签发布 | 临时 Git 仓库测试通过，未执行真实发布 |

订阅管理使用订阅 ID 调用面板 API；repo/raw 的旧位置参数仅用于内部执行器兼容。安装、升级、修复归本机运维，发布流程归开发工具，不进入公开管理命令树。

## 构建与运行

在仓库根目录安装独立 CLI 的构建依赖后执行：

```sh
npm ci --prefix cli
npm run build:cli
node cli/dist/ql.js --help
node cli/dist/ql.js login --url https://ql.example.com
node cli/dist/ql.js auth status --json
node cli/dist/ql.js task list --search 示例 --page 1 --size 50 --json
node cli/dist/ql.js task get 12 --json
node cli/dist/ql.js task logs 12 --tail 200 --json
node cli/dist/ql.js task run 12 --json
node cli/dist/ql.js task stop 12 --json
node cli/dist/ql.js auth status --scope subscriptions --json
node cli/dist/ql.js subscription list --search 示例 --json
node cli/dist/ql.js subscription get 5 --json
node cli/dist/ql.js subscription run 5 --json
node cli/dist/ql.js subscription logs 5 --tail 200 --json
node cli/dist/ql.js auth logout --json
```

运行需要 Node.js >=22.12.0，推荐 Node 24 LTS。Commander 15 已在构建时打包到产物中，无需另装运行时 npm 依赖；API 操作不加载后端或数据库。构建后的整个 `cli/dist` 目录可复制到独立机器后通过 `node /path/to/dist/ql.js` 使用；不能只复制 ql.js。`cli/package.json` 提供统一的 `ql` 与 `task` 简写。可构建后在 cli 目录执行 `npm pack`，将本地包安装到评测环境；当前不发布到 registry。

源码按职责组织：`arguments.ts` 解析参数，`commands/` 执行命令，`api/` 请求与校验接口，`config/` 保存凭据，`types.ts` 定义边界类型。使用独立 tsconfig 严格编译，再用 esbuild 生成共享的 `dist/framework/commander.js`；业务模块继续按需加载。Commander 许可证位于 `dist/licenses/commander-LICENSE`。构建依赖固定在 `cli/package-lock.json`，产物在忽略跟踪的 `dist/`，不依赖 3.0 构建。

## 认证

在面板创建专用应用，按需授予定时任务（`crons`）或订阅（`subscriptions`）权限。`login` 与 `auth login` 等价，交互输入 Client ID 和不回显的 Client Secret；非交互环境通过 `QL_CLIENT_ID`、`QL_CLIENT_SECRET` 注入，不支持命令行参数传入密钥。

URL 使用面板根地址，可包含代理路径前缀，不附加 `/open`。远程连接要求 HTTPS，回环地址允许 HTTP；请求不跟随重定向。2.x 的 token 接口使用查询参数传递凭据，反向代理应避免记录该请求的查询参数。

凭据和 token 保存为 `~/.config/qinglong/cli.json` 的 0600 文件（明文、当前用户所有）。`QL_CLI_CONFIG` 指定其他文件，可分别管理多个实例。过期 token 自动刷新，401/403 不自动重放操作。`auth status` 实际验证 `crons` 读取权限，不输出凭据。登录仅验证应用凭据，是否具有 `crons` 权限由 status/任务调用验证。

`logout` 只删除本机凭据，不撤销服务端 token；需要撤销时在面板重置或删除应用。2.x 的 `crons` 权限覆盖读取和执行，本 CLI 不引入服务端只读权限。

`auth status --scope subscriptions` 验证订阅读取权限；省略 scope 默认验证 `crons`。订阅命令支持 list/get/run/stop/logs/enable/disable。订阅列表返回 `{code:200,data:[...]}`，没有任务列表的分页结构；读取结果仅保留管理字段，省略仓库地址、拉取凭据、代理与可执行钩子。订阅日志不自动脱敏。变更返回 `subscriptionId`、`action` 和 `accepted`，接受请求不代表执行成功。

## 输出契约

命令默认输出缩进 JSON，`--json` 输出单行 JSON；成功写 stdout，错误写 stderr，互不混用。帮助在 `--json` 下也使用 `{code:200,data:{help:"..."}}`。

- `list`：`{code:200,data:{data:[...tasks],total:123}}`，默认每页 50，最多 200；任务字段保留服务端内容。
- `get`：`{code:200,data:{id:12,...}}`。
- `logs`：`{code:200,data:"日志尾部",logStatus:"completed",truncated:true}`。默认 200 行，最多 10000；旧接口若不返回 logStatus，该字段省略。
- `run/stop`：`{code:200,data:{taskId:12,action:"run",accepted:true}}`。仅表示请求被接受，不表示任务成功完成。
- 错误：`{code:1,message:"..."}`；退出码 1 为 API/网络/配置错误，2 为参数错误，3 为未登录或 HTTP/API 401/403；成功退出码 0。

ID 必须为正整数，运行/停止一次操作一个任务。2.x 没有为此提供独立运行 ID 或幂等键，失败响应可能意味着执行结果未知，应先查询状态，禁止盲目重试。CLI 不自动重试 HTTP 请求。

日志是该任务最新日志，可能属于先前运行；`completed` 不代表成功。`--tail` 在客户端截取，不减少服务端读取量或网络传输量。日志与任务字段不自动脱敏，应按需读取并避免向聊天中暴露敏感信息。

## Skill 与测试

配套 Skill 随独立安装包分发，位于包内 `skills/qinglong-cli`（源码路径 `cli/skills/qinglong-cli`）。复制到所用 Agent 的 skills 目录，并在首次使用时提供编译产物的绝对路径；Skill 不存放凭据，也不替代服务端权限。

```sh
npm run check:cli
npm run test:cli
node cli/scripts/verify-package.cjs
```

常规测试使用隔离凭据和回环 HTTP 服务。覆盖命令、2.x 请求格式、刷新、错误流、禁止重试、配置权限以及独立产物运行。

当前测试还覆盖入口隔离、本机脚本参数与退出码、超时、日志清理和 Git 同步失败保留旧文件。执行器 `--json` 将脚本输出写 stderr，stdout 只保留结果，退出状态保留脚本退出码。

2.x Shell 能力迁移与可替换性验收已完成，原 Shell 与生产默认入口保留。当前实现覆盖任务执行、内部订阅同步、维护、升级、宿主机和容器启动。切换使用文档中的显式选择机制，面板进程入口通过 QL_CLI_ROOT 显式选择；全局安装包会注册 ql/task 名称。

本机运维提供 `repair-config`、`update --mirror github|gitee [--download-only]` 和 `reload --target services|system|data`，使用 `node cli/dist/admin.js <命令> --root <安装目录>`。升级/重载会改动本机安装，已通过真实 Linux 进程恢复与官方面板 2.19.0 → 2.20.1 暂存文件替换验收，保留账号、任务及配置；公网升级归档下载与版本选择仍是独立验证范围。`--download-only` 输出并记录完整暂存目录，不停止服务；之后执行 `reload --target system`（旧参数为 `ql-compat reload system`）会使用该记录。失败的后续下载不覆盖上次可用记录。

`ql check` 保留旧命令的修复语义：安装全局运行工具和面板依赖、补齐配置、恢复通知文件，再诊断与重载服务。它不是只读检查。JSON 结果包含重载前后的健康观测，以及最多各 300 行、256 KiB 的 PM2 日志尾部；日志内容不会自动脱敏。

`ql bot` 承接可选 Bot 的依赖安装、仓库准备和启动，读取原配置中的 `BotRepoUrl`，保留已有 `bot.json`。只支持 Linux 上的 Alpine/Debian/Ubuntu；已用测试 Bot 验证真实 Alpine 系统包／pip 安装和 Python 进程隔离，未连接 Telegram。当前实现通过 pip requirements 文件安装依赖，具体兼容差异见迁移文档。

开发发布使用 `node cli/dist/developer.js release --root /仓库绝对路径 --json` 查看计划；明确执行时增加 `--apply --commit <计划中的完整提交SHA>`。默认目标为 origin/master，可用 `--remote`、`--branch` 指定。发布会上传 CDN 元数据并替换目标分支和当前版本标签，详见迁移文档中的副作用与兼容差异。

`qinglong-cli` 对应原 `qinglong` 无参数启动，`qinglong-cli reload` 对应旧重载形式；可通过 QL_DIR/QL_DATA_DIR 或显式目录选项指定安装。独立包使用 `qinglong-cli` 避免覆盖原命令。

`ql start --root /安装目录 --data-dir /存储路径/data` 承接本机安装与启动；增加 `--reload` 可跳过依赖安装、可选 Bot/extra 和开机注册。它操作真实系统包与 nginx/PM2 服务，已在官方 2.20.1 镜像绕过旧启动脚本完成首次启动验收；另已在预装 Node/Python 运行时的 Alpine/OpenRC 与 Debian 12/systemd 虚拟机验证真实安装、内核重启及保留任务的自动分钟触发；不包含运行时本身的安装，也不代表所有发行版已验证。

### 旧参数评测入口

`ql-compat` 是独立的旧参数适配器，依赖 `QL_DIR`。单独安装不会覆盖系统 `ql`；设置 `QL_CLI_ROOT` 后由面板加载器选择：

```sh
QL_DIR=/ql ql-compat update false
QL_DIR=/ql ql-compat reload system
QL_DIR=/ql ql-compat repo <url> <include> <exclude> <dependencies> <branch> <extensions> <proxy> <autoAdd> <autoDelete>
```

`update false` 映射到本机工具的 `--download-only`，`reload system|data` 映射到对应目标；`repo/raw` 分流到内部订阅执行器。其他旧维护命令分流到本机工具。兼容 `-l` 前缀（旧实现只解析该标记，没有独立动作）。参数不会拼成 Shell 字符串。公开面板 API 仍使用 `ql`，本机任务使用 `ql task exec` 或脚本简写。

维护命令已接入按命令写运行日志、`no_tee`/`real_time` 和 ID 开始/结束报告；用户配置仅加载一次，JSON 结果保持在 stdout。`repo/raw` 和独立订阅 worker 也使用同一包装器，且按旧行为省略开始/结束提示行；已验证配置加载、维护脚本及 raw 下载过程的 SIGINT/SIGTERM/SIGHUP 中断，返回 130/143/129 并完成已开始操作的状态报告。本地 API 等待响应及读取响应体时也可取消；升级恢复已验证停止／启动阶段的中断和旧版恢复。直接 Node／PM2 启动新版 HTTP 夹具后的真实信号回滚也已验证。临时面板的显式入口选择与重载保留、2.19.0 → 2.20.1 文件升级已有证据；完整迁移验收范围见验收审计。错误使用非零退出码，输出采用新工具的结构化格式。

本机状态报告优先读取已安装面板的 `package.json` 版本；没有字符串版本字段或无法读取包信息时，回退到 `version.yaml` 的顶层版本字段。2.20 及更早版本或无法识别的版本使用基础状态字段，2.21 起启用扩展状态和统计接口。定制／回移植版本可设置 `QL_CLI_LIFECYCLE=legacy|extended` 显式选择。旧接口不能保存的退出码仍写入命令结果和日志。官方 2.20.1 临时容器已通过 `task`、`ql extra` 入口替换后的真实面板调度验收；完整替换验证范围见验收审计。

订阅 worker 的包含／排除／依赖表达式沿用 POSIX ERE 语义，由 TypeScript 直接调用本机 `grep -E`；无需 Shell 求值或新增 npm 依赖。部署本机 worker 需提供 `grep`、Git、curl 等对应工具。任务执行器的 `RandomDelayFileExtensions` 同样使用本机 `grep -E`，保留原正则配置语义。带换行符的路径在启用筛选时会报错。

### 2.x 启动入口选择

包含本次 `back/loaders/deps.ts` 集成的面板，可在面板进程环境中设置 `QL_CLI_ROOT=/absolute/path/to/cli`，指向已构建／安装且包含 `dist` 的独立 CLI 根目录。启动加载器会在用户 `~/bin` 生成 `ql`、`task` 的 Node 入口，并将该目录置于面板进程 PATH 首位，避免容器中的旧全局命令抢占；后续启动／重载继续使用同一选择。这只影响面板及其子进程，独立打开的容器终端应显式使用所选路径。现有镜像不会自动包含独立 CLI，需先安装或挂载构建产物。`ql` 使用统一分发入口；只有旧参数形式进入兼容适配器。

未设置该变量时沿用原 Shell 链接；移除变量并重新启动面板可切回原实现。仅安装 npm 包不会修改面板入口。CLI 路径必须是绝对路径且对面板用户可读；缺少入口文件或无效路径会记录启动链接错误，不静默回退。旧 `shell` 文件保留。该选择机制已在临时 2.20.1 面板加载器中复验，迁移验收已完成，尚未进行生产发布。

所有可执行入口的帮助说明均支持 `QL_LANG=en` 切换英文，默认中文；命令名、参数名和 JSON 字段不随语言变化。任务及维护日志的执行提示也使用同一语言选择。帮助读取进程环境，不加载用户面板配置。

容器内首次启动可使用 `ql start --root /ql --data-dir /ql/data --no-startup`，显式跳过不适用的系统开机注册；依赖准备、服务启动和 PM2 进程清单保存仍执行。默认不加此选项时继续执行 `pm2 startup`，失败会返回错误。结果中的 `startup` 区分 `registered`、`skipped` 和 `not-requested`。

配置了 `QL_DIR` 或传入 `--root` 时，`ql task exec` 不带脚本参数会显示帮助及脚本目录顶层的 JS 脚本列表（排除 `sendNotify.js`），并从文本提取 `new Env(...)` 活动名称。加 `--json` 可读取 `data.scripts`；显式 `--help` 只显示帮助，不读取脚本或执行配置。

## 耗时如何比较

`ql` 的面板管理操作包含认证（必要时）与 HTTP 往返；`ql update/check/reload` 等运维操作在本机执行，耗时取决于实际维护工作。`ql task run` 返回请求已接受，本机任务执行器 `ql task exec` 则等待脚本结束，所以两者返回时间不是同一个指标。订阅 run 的返回也不代表拉取完成。

本机配置桥使用 Bash 与 `/usr/bin/env -0` 读取导出的环境，在当前 Node 进程解析 NUL 分隔数据，不再额外启动 Node 做序列化。已验证 macOS、Debian（GNU env）及 Alpine（BusyBox env）；其他平台需提供兼容的 env 命令。


## CI npm 产物

CLI package 工作流在相关 PR、develop 推送及手动触发时运行，在 Node 22.12 和 24 上检查类型、构建并测试。Node 24 任务打包后进行离线安装，验证全部九个入口，再将验证过的 `.tgz` 上传为 GitHub Actions artifact；不自动发布到 npm registry。

在工作流运行页下载 `qinglong-cli-<commit>`，解压后执行 `npm install -g ./qinglong-cli-0.1.0.tgz`。安装产物不需要构建工具。
