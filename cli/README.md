# QingLong 2.x 远程管理 CLI

**简体中文** | [English](README.en.md)


npm 与面板内部入口都叫 `ql`，但使用独立的 Commander 命令树：npm 入口只调用远程 API，内部入口只运行本机工具。使用前确认可执行文件的绝对路径和 `--help`；安装 npm 包不会迁移内置 Shell 命令。

`@qinglong/cli` 是独立 npm 包，覆盖当前 develop 的有效 OpenAPI，只注册一个 `ql` 命令。它不包含脚本执行器或本机运维实现；`task exec`、`repo/raw`、`reload/update/reset*` 等属于面板内部工具，不随 npm 包分发。开发发布也不属于 CLI 范围。

## 安装与使用

要求 Node >=22.12，推荐 Node 24。Commander 在构建时打包，无额外运行时 npm 依赖，不单独发布 CLI 镜像。

```sh
npm install -g @qinglong/cli
ql --help
# 临时使用，不覆盖面板已有的 ql
npm exec --package=@qinglong/cli -- ql --help
```

本分支尚未发布 npm 包。发布前从源码执行 `npm ci --prefix cli`、`npm run build:cli`，在 cli 目录执行 `npm pack`，然后安装本地 tgz。全局安装会占用 `ql` 名称；已有面板的机器建议使用独立 npm prefix 或直接执行 `node /absolute/path/to/cli/dist/npm/ql.js`。

```sh
ql login --url https://ql.example.com
ql auth status --json
ql task list --search 示例 --page 1 --size 50 --json
ql task get 12 --json
ql task logs 12 --tail 200 --json
ql task run 12 --json
ql task stop 12 --json
ql auth status --scope subscriptions --json
ql subscription list --json
ql subscription get 5 --json
ql subscription run 5 --json
ql subscription stop 5 --json
ql subscription logs 5 --tail 200 --json
ql subscription enable 5 --json
ql subscription disable 5 --json
ql auth logout --json
```

各命令支持 `--help`，`QL_LANG=en` 切换英文帮助；命令和 JSON 字段不随语言变化。`ql task` 中只包含 API 操作，不会把无效命令解释为本机脚本，也不提供独立 `task` npm 入口。

## 全量 OpenAPI 管理

现在还支持任务/订阅创建、修改、删除，应用管理与密钥重置，以及环境变量、配置、脚本、日志、依赖、系统、仪表盘和用户管理。`ql api routes --json` 列出全部 143 条有效路由；3 条已下线文件读取接口不包含在内。新增命令在 [完整双语参考](skills/qinglong-cli/references/openapi.md) 中逐项列出，路由覆盖由 CI 与后端代码核对。

```sh
ql task create --name demo --command 'task demo.js' --schedule '0 0 * * *' --json
ql subscription create --type public-repo --url https://example.com/repo.git --alias demo --schedule-type crontab --schedule '0 0 * * *' --json
ql app create --name agent --scopes crons,subscriptions --show-secrets --json
ql env create --data @envs.json --json
ql api request PUT /open/crons/run --data '[12,13]' --json
```

请求体使用 --data JSON/@file/-，查询使用 --query，上传 --file，下载 --output。新命令支持 --timeout 秒数；旧命令行为保留，完整参数可用 api request。下载不覆盖现有文件，应用密钥默认隐藏，明确加 --show-secrets 才输出。新增资源通常保留原始返回字段，注意环境、配置和会话信息可能敏感。

远程 `ql system ...` 调用面板 API；本机 reload/reset 等仍不在 npm 包中。不要将远程 API 覆盖理解为本机运维重新混入包。

## 认证

受保护的请求均使用 `Authorization: Bearer <token>`，支持以下两种凭据来源：

| 方式 | 提供方式 | 保存与刷新 |
| --- | --- | --- |
| 应用凭据登录 | `ql login --url <面板地址>`，输入 Client ID / Client Secret；自动化通过 `QL_CLIENT_ID`、`QL_CLIENT_SECRET` 注入 | 通过 `/open/auth/token` 换取 token，凭据和 token 保存到本机，过期自动刷新 |
| 直接访问令牌 | 环境中同时设置 `QL_URL`、`QL_ACCESS_TOKEN`，支持有效应用 token 或面板会话 token | 优先于保存的配置，不落盘、不自动刷新 |

### 应用凭据登录

在面板创建专用应用，按需授予 crons、subscriptions、envs 等权限。`login` 与 `auth login` 等价；交互输入 Client ID 和不回显的 Client Secret，密钥不支持命令行参数。

```sh
ql login --url https://ql.example.com
ql auth status --scope crons --json
# 自动化环境事先注入 QL_CLIENT_ID 和 QL_CLIENT_SECRET，再运行同一 login 命令
```

凭据和 token 保存到 `~/.config/qinglong/cli.json`，为当前用户所有的 0600 明文文件。`QL_CLI_CONFIG` 可选择其他配置文件。登录只验证应用凭据，不意味着具备所有资源权限。

### 直接使用访问令牌

在终端或 CI 的凭据配置中注入 `QL_URL` 与 `QL_ACCESS_TOKEN` 后，直接调用命令，无需再执行 login：

```sh
ql auth status --scope apps --json
ql app list --json
```

两个变量必须同时提供给受保护命令；只提供一个会报参数错误。此方式优先于 `QL_CLI_CONFIG` 指定的配置。即使重新执行 login 写入了应用配置，后续请求仍使用环境令牌；切回保存的应用配置时，在自己的终端执行 `unset QL_URL QL_ACCESS_TOKEN`。

应用管理需要 apps 权限或有效的授权面板会话；当前面板 UI 没有列出所有后端 scope，CLI 不自动提权。匿名 `user login` 可在仅设置 QL_URL 时使用 `--data @credentials.json` 或 `--data -` 提交凭据；返回的会话不会自动保存。启用双因素认证时，服务端 420 对应 CLI 退出码 3，随后使用 `user two-factor-login`，请求体包含 username/password/code。不要将凭据写入命令参数或聊天。

### 权限检查、退出与失败

`auth status` 默认检查 crons 读取权限，可用 `--scope subscriptions`、`--scope apps` 等检查对应资源。它只验证代表性读取，不代表所有写操作都获授权。2.x 的 crons scope 同时覆盖读取和执行。

`auth logout` 仅删除本机应用配置，不撤销服务端 token，也不清除父进程中的 QL_ACCESS_TOKEN。令牌模式仍可能继续访问；如需撤销访问，使用面板提供的应用或会话管理。重置应用密钥会使旧应用 token 失效，需要使用新密钥重新 login。

URL 使用面板根地址，可包含代理路径前缀，不附加 `/open`。远程连接要求 HTTPS，回环地址允许 HTTP；不跟随重定向。2.x 应用 token 接口以查询参数传递凭据，代理应避免记录该查询字符串。401/403 不自动重放操作；直接令牌失效时需更换，CLI 不会转而使用保存的应用凭据。

## 输出契约

订阅支持 create/update/delete/list/get/run/stop/logs/enable/disable/status/log-files。`subscription list/get` 保留管理字段投影；run/stop/enable/disable 返回 subscriptionId/action/accepted。创建、修改、删除及通用 API 请求保留服务端响应，可能包含敏感字段；不能将所有变更都解释为 accepted。

命令默认输出缩进 JSON，`--json` 输出单行 JSON；成功写 stdout，错误写 stderr，互不混用。帮助在 `--json` 下也使用 `{code:200,data:{help:"..."}}`。

- `task list`：`{code:200,data:{data:[...tasks],total:123}}`，默认每页 50，最多 200；任务字段保留服务端内容。
- `task get`：`{code:200,data:{id:12,...}}`。
- `task logs`：`{code:200,data:"日志尾部",logStatus:"completed",truncated:true}`。默认 200 行，最多 10000；旧接口若不返回 logStatus，该字段省略。
- `task run/stop`：`{code:200,data:{taskId:12,action:"run",accepted:true}}`。仅表示请求被接受，不表示任务成功完成。
- 错误：`{code:1,message:"..."}`；退出码 1 为 API/网络/配置错误，2 为参数错误，3 为未登录、HTTP/API 401/403 或需要双因素验证；成功退出码 0。

ID 必须为正整数，运行/停止一次操作一个任务。2.x 没有为此提供独立运行 ID 或幂等键，失败响应可能意味着执行结果未知，应先查询状态，禁止盲目重试。CLI 不自动重试 HTTP 请求。

日志是该任务最新日志，可能属于先前运行；`completed` 不代表成功。`--tail` 在客户端截取，不减少服务端读取量或网络传输量。日志与任务字段不自动脱敏，应按需读取并避免向聊天中暴露敏感信息。

## Skill、构建与验证

npm 包附带 `skills/qinglong-cli`，覆盖全部远程命令。复制到所用 Agent 的 skills 目录，并确认使用 npm 远程入口。Skill 不存放凭据，也不替代服务端权限。

源码使用 TypeScript 严格检查和 Commander 解析；共用参数/输出逻辑，分别构建远程入口和面板内部入口。`dist/npm/ql.js` 是可独立运行的远程 bundle，构建依赖图会拒绝引入本机运维模块；npm 文件白名单仅包含该 bundle、source map、许可证、中英文说明和远程 Skill。完整 `dist` 用于面板内部构建，不随 npm 发布。

```sh
npm ci --prefix cli
npm run check:cli
npm run test:cli
node cli/scripts/verify-package.cjs
```

测试覆盖请求格式、认证刷新、输出、错误、禁止自动重试、权限和独立安装。打包验证会离线安装 tgz，并确认唯一入口是 `ql`，本机命令不可调用。

CLI package 工作流在相关 PR、develop 推送和手动触发时执行 Node 22.12/24 类型检查、构建及测试。Node 24 上传通过离线安装验证的 `qinglong-cli-<commit>` artifact；不自动发布 npm。下载后安装其中的 tgz，无需构建工具。

## 面板内部工具

本机执行、订阅同步和运维随面板源码/构建交付，使用完整内部 `dist` 与独立 `qinglong-local` Skill；源码说明见 `cli/LOCAL.md` 和 `cli/LOCAL.en.md`。npm 包不能用作 `QL_CLI_ROOT`。账号恢复、服务重载必须在实际面板宿主机或容器中执行；Docker 使用 `docker exec` 调用容器内选定入口。

API `task run` 返回请求接受，本机执行器等待脚本结束，二者耗时不能直接对比。Shell 迁移性能应比较相同配置和脚本下的内部 TS 执行器与原 Shell；远程 API 操作没有对应的旧 Shell 管理命令。

## 源码结构

```text
src/
  entrypoints/     # 可执行入口组装
  remote/          # commands / api / auth
  internal/        # commands / execution / subscription / maintenance / runtime / integration
  compatibility/   # 旧入口和参数适配
  shared/          # cli / i18n / 响应类型与错误
```

shared 不能引用业务模块；remote 与 internal 只能引用各自区域及 shared，集成测试检查这些依赖边界。两套业务注册表分别注入共享 Commander 解析器。

测试按同样的区域分组。仓库根目录 `npm run test:cli` 或 cli/ 下 `npm test` 自动发现标准测试；test/linux 保持为显式执行的容器集成测试。scripts/entrypoints.cjs 保留现有 dist 可执行入口，以及 dist/local/entrypoints.js、cronEntrypoint.js；移动源码不要求修改 QL_CLI_ROOT 或 cron 命令。
