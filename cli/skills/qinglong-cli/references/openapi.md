# OpenAPI 全量参考 / Complete OpenAPI reference

CLI 对应当前 develop 的 143 条有效路由。通过 `ql api routes --json` 查看方法、路径、对应命令、位置参数、请求体与上传字段；CLI 测试与 back/api 路由逐项核对。GET configs/:file、scripts/:file、logs/:file 已返回 410，改用 detail 命令，不再暴露旧入口。旧版面板可能没有新路由，以服务端响应为准。

The catalogue covers 143 active routes in the current develop backend. `ql api routes --json` lists methods, paths, commands, positional parameters, bodies and upload fields. A route-coverage test detects drift. Three retired GET :file routes return 410; use detail-based commands. Older panel versions may not implement newer routes.

## 认证与权限 / Authentication and permissions

常规使用 `ql login` 的应用凭据。scope 是 /open 后首个路径段：crons、subscriptions、envs、configs、scripts、logs、dependencies、system、dashboard 等。应用管理需要 apps；user、health、update 等路由同样接受服务端权限校验。面板 UI 当前没有列出全部这些 scope，不能把路由存在理解成现有应用已获授权。

认证步骤、环境变量优先级、应用登录、面板会话与双因素验证、退出行为，统一见 [认证参考](panel.md#authentication)。应用管理可用 apps 权限的应用或授权面板会话；QL_URL/QL_ACCESS_TOKEN 不保存、不刷新，不自动退回应用配置。

See the [authentication reference](panel.md#authentication) for application login, direct-token precedence, owner sessions/2FA and logout. App management accepts apps-scoped credentials or an authorized owner session. Direct tokens are not saved/refreshed and never fall back to application configuration.

`auth status --scope <scope>` tests a representative read; update has no read endpoint and is not offered by status. This does not prove permission for every write. `app list/create/update/reset-secret` 默认隐藏 client_secret/tokens；只有明确需要凭据时才加 --show-secrets，并避免把输出记录到共享日志。其他资源/通用请求可能含环境值、配置、脚本、订阅凭据和会话，按敏感数据处理。

App results omit client_secret/tokens unless --show-secrets is explicit. Other resources and raw responses may contain sensitive values. Handle them accordingly.

## 输入和输出 / Inputs and outputs

- `--data '<JSON>'` / `--data @file.json` / `--data -`：完整请求体，保留所有后端字段；query 同样支持这三种输入。
- `--query '{"searchValue":"demo","page":1}'`：查询对象，值为标量或标量数组，CLI 编码为 URL 参数；不要拼接 URL 查询字符串。
- `create/update` 常用字段可用选项；同一字段不能同时在 --data 和选项中提供。update 的位置 ID 注入请求体，拒绝与 body.id 冲突；它提交完整更新对象，不会先读取后盲目合并。
- 使用 `<id...>` 的命令可以传多个 ID。原 task run/stop 与 subscription run/stop/enable/disable 保持单 ID 契约；批量使用 api request 和数组请求体。
- 上传使用 `--file`，其他 multipart 字段用 --data 对象，字段名由路由决定（file/env/data/avatar）；下载与 system command-run 使用 `--output`，不覆盖已有文件，文件权限 0600，失败清理本次新建文件。
- 默认 30 秒超时，可用新命令的 `--timeout <秒>` 调整，最多 3600。耗时任务优先创建任务再 run，持续执行的 command-run 需合理超时；连接超时不表示远程操作已停止。
- JSON 响应保留服务端 data/附加字段。原任务/订阅读取保留原有分页、裁剪和日志 tail 契约；api request 提供完整原始能力。下载只输出保存路径/字节数，不把二进制混入 stdout。
- POST/PUT/DELETE 不自动重试，网络/5xx 后先检查服务端状态。GET crons/import 也可能改变服务端状态，不能仅凭 HTTP 动词认定只读。

Inputs accept inline JSON, @file or stdin (-). Queries are objects with scalar/array values. Named updates require complete server fields plus the positional ID; there is no implicit read/merge/write. Bulk operations use ID positionals where shown, or api request arrays. Uploads use --file; downloads/command streams require a new --output file. Responses remain JSON; downloaded bytes go only to the file. New operations support --timeout (seconds, default 30, maximum 3600). Timeouts do not prove remote cancellation. No request is automatically retried.

## 常用示例 / Examples

```sh
ql task create --name demo --command 'task demo.js' --schedule '0 0 * * *' --json
ql task update 12 --data @task.json --json
ql task enable 12 13 --json
ql task delete 12 13 --json
ql subscription create --type public-repo --url https://example.com/repo.git --alias demo --schedule-type crontab --schedule '0 0 * * *' --json
ql subscription update 5 --data @subscription.json --json
ql subscription delete 5 --query '{"force":true}' --json
ql app create --name agent --scopes crons,subscriptions --show-secrets --json
ql app update 3 --name agent --scopes crons,subscriptions,envs --json
ql app reset-secret 3 --show-secrets --json
ql env create --data @envs.json --json
ql env update 8 --data '{"name":"EXAMPLE","value":"value"}' --json
ql script create --file ./demo.js --data '{"filename":"demo.js","path":""}' --json
ql script get --query '{"file":"demo.js","path":""}' --json
ql config save --data '{"name":"example.sh","content":"# example"}' --json
ql config get --query '{"path":"example.sh"}' --json
ql log download --data '{"filename":"example.log","path":"example"}' --output ./example.log --json
ql dependency create --data '[{"name":"example-package","type":0}]' --json
ql system data-export --data '{}'  --output ./panel.tgz --json
ql system data-import --file ./panel.tgz --json
ql api request PUT /open/crons/run --data '[12,13]' --json
ql api request GET /open/crons --query '{"page":1,"size":100,"searchValue":"demo"}' --json
```

任务 create/update 需要 command/schedule；name、labels、sub_id、extra_schedules、task_before/after、log_name、allow_multiple_instances、work_dir 等字段可通过 --data 提交。订阅 create 需要 type/url/alias/schedule_type，update 需要 id/type/url/alias；interval_schedule、pull_option、dependences、extensions、sub_before/after、proxy、autoAddCron/autoDelCron 等用 --data。private-repo 凭据仅通过受保护文件或 stdin 提供。环境变量与依赖 create 接受对象数组，应用 scopes 为字符串数组。其余准确字段/枚举由当前后端 Joi schema 校验：见 [back/api](https://github.com/whyour/qinglong/tree/develop/back/api) 和 [定时规则 schema](https://github.com/whyour/qinglong/blob/develop/back/validation/schedule.ts)。

Task creation/update needs command/schedule; additional fields use --data. Subscription creation needs type/url/alias/schedule_type; updates need id/type/url/alias. Interval schedules, private repository credentials, filters, hooks and booleans use --data. Env/dependency creation accepts arrays; application scopes is a string array. The server validates field types/enums; the linked backend schemas are authoritative.

下面包含应用/用户/系统远程管理；这些通过 HTTP 在目标面板执行，与已从 npm 移除的本机 reload/reset/start 不同。诊断不自动授权创建、删除、升级、重启、密钥重置或数据导入。遵循当前用户已给出的授权，不重复确认已授权操作。

System/user operations below execute remotely through the panel API. They do not restore local system tools to npm. Follow the user's authorized scope, including for resets, data import and upgrades; diagnosis alone does not authorize mutations.

## 路由表 / Route table

| 命令 / Command | 方法 / Method | /open 路径 / Path | 输入 / Input |
| --- | --- | --- | --- |
| `ql task view-list ` | GET | `crons/views` | --query |
| `ql task view-create ` | POST | `crons/views` | --data, --query |
| `ql task view-update <id>` | PUT | `crons/views` | --data, --query |
| `ql task view-delete <id...>` | DELETE | `crons/views` | --query |
| `ql task view-move ` | PUT | `crons/views/move` | --data, --query |
| `ql task view-disable <id...>` | PUT | `crons/views/disable` | --query |
| `ql task view-enable <id...>` | PUT | `crons/views/enable` | --query |
| `ql task list ` | GET | `crons` | --query via api request |
| `ql task detail ` | GET | `crons/detail` | --query |
| `ql task create ` | POST | `crons` | --data, --query |
| `ql task run <id...>` | PUT | `crons/run` | --query via api request |
| `ql task stop <id...>` | PUT | `crons/stop` | --query via api request |
| `ql task labels-delete ` | DELETE | `crons/labels` | --data, --query |
| `ql task labels-create ` | POST | `crons/labels` | --data, --query |
| `ql task disable <id...>` | PUT | `crons/disable` | --query |
| `ql task enable <id...>` | PUT | `crons/enable` | --query |
| `ql task logs <id>` | GET | `crons/:id/log` | --query via api request |
| `ql task update <id>` | PUT | `crons` | --data, --query |
| `ql task delete <id...>` | DELETE | `crons` | --query |
| `ql task pin <id...>` | PUT | `crons/pin` | --query |
| `ql task unpin <id...>` | PUT | `crons/unpin` | --query |
| `ql task import ` | GET | `crons/import` | --query |
| `ql task get <id>` | GET | `crons/:id` | --query via api request |
| `ql task status ` | PUT | `crons/status` | --data, --query |
| `ql task instances <id>` | GET | `crons/:id/instances` | --query |
| `ql task instance-stop <id> <instanceId>` | POST | `crons/:id/instances/:instanceId/stop` | --query |
| `ql task log-files <id>` | GET | `crons/:id/logs` | --query |
| `ql subscription list ` | GET | `subscriptions` | --query via api request |
| `ql subscription create ` | POST | `subscriptions` | --data, --query |
| `ql subscription run <id...>` | PUT | `subscriptions/run` | --query via api request |
| `ql subscription stop <id...>` | PUT | `subscriptions/stop` | --query via api request |
| `ql subscription disable <id...>` | PUT | `subscriptions/disable` | --query via api request |
| `ql subscription enable <id...>` | PUT | `subscriptions/enable` | --query via api request |
| `ql subscription logs <id>` | GET | `subscriptions/:id/log` | --query via api request |
| `ql subscription update <id>` | PUT | `subscriptions` | --data, --query |
| `ql subscription delete <id...>` | DELETE | `subscriptions` | --query |
| `ql subscription get <id>` | GET | `subscriptions/:id` | --query via api request |
| `ql subscription status ` | PUT | `subscriptions/status` | --data, --query |
| `ql subscription log-files <id>` | GET | `subscriptions/:id/logs` | --query |
| `ql app list ` | GET | `apps` | --query |
| `ql app create ` | POST | `apps` | --data, --query |
| `ql app update <id>` | PUT | `apps` | --data, --query |
| `ql app delete <id...>` | DELETE | `apps` | --query |
| `ql app reset-secret <id>` | PUT | `apps/:id/reset-secret` | --query |
| `ql auth login ` | GET | `auth/token` | --query via api request |
| `ql env list ` | GET | `envs` | --query |
| `ql env create ` | POST | `envs` | --data, --query |
| `ql env update <id>` | PUT | `envs` | --data, --query |
| `ql env delete <id...>` | DELETE | `envs` | --query |
| `ql env move <id>` | PUT | `envs/:id/move` | --data, --query |
| `ql env disable <id...>` | PUT | `envs/disable` | --query |
| `ql env enable <id...>` | PUT | `envs/enable` | --query |
| `ql env rename ` | PUT | `envs/name` | --data, --query |
| `ql env get <id>` | GET | `envs/:id` | --query |
| `ql env pin <id...>` | PUT | `envs/pin` | --query |
| `ql env unpin <id...>` | PUT | `envs/unpin` | --query |
| `ql env labels-create ` | POST | `envs/labels` | --data, --query |
| `ql env labels-delete ` | DELETE | `envs/labels` | --data, --query |
| `ql env upload ` | POST | `envs/upload` | --data, --file (env), --query |
| `ql config samples ` | GET | `configs/samples` | --query |
| `ql config list ` | GET | `configs/files` | --query |
| `ql config get ` | GET | `configs/detail` | --query |
| `ql config save ` | POST | `configs/save` | --data, --query |
| `ql script list ` | GET | `scripts` | --query |
| `ql script get ` | GET | `scripts/detail` | --query |
| `ql script create ` | POST | `scripts` | --data, --file (file), --query |
| `ql script update ` | PUT | `scripts` | --data, --file (file), --query |
| `ql script delete ` | DELETE | `scripts` | --data, --query |
| `ql script download ` | POST | `scripts/download` | --data, --output, --query |
| `ql script run ` | PUT | `scripts/run` | --data, --query |
| `ql script stop ` | PUT | `scripts/stop` | --data, --query |
| `ql script rename ` | PUT | `scripts/rename` | --data, --query |
| `ql log list ` | GET | `logs` | --query |
| `ql log get ` | GET | `logs/detail` | --query |
| `ql log delete ` | DELETE | `logs` | --data, --query |
| `ql log download ` | POST | `logs/download` | --data, --output, --query |
| `ql dependency list ` | GET | `dependencies` | --query |
| `ql dependency create ` | POST | `dependencies` | --data, --query |
| `ql dependency update <id>` | PUT | `dependencies` | --data, --query |
| `ql dependency delete <id...>` | DELETE | `dependencies` | --query |
| `ql dependency force-delete <id...>` | DELETE | `dependencies/force` | --query |
| `ql dependency get <id>` | GET | `dependencies/:id` | --query |
| `ql dependency reinstall <id...>` | PUT | `dependencies/reinstall` | --query |
| `ql dependency cancel <id...>` | PUT | `dependencies/cancel` | --query |
| `ql system info ` | GET | `system` | --query |
| `ql system config-get ` | GET | `system/config` | --query |
| `ql system config-log-remove-frequency ` | PUT | `system/config/log-remove-frequency` | --data, --query |
| `ql system config-cron-concurrency ` | PUT | `system/config/cron-concurrency` | --data, --query |
| `ql system config-dependence-proxy ` | PUT | `system/config/dependence-proxy` | --data, --query |
| `ql system config-node-mirror ` | PUT | `system/config/node-mirror` | --data, --query |
| `ql system config-python-mirror ` | PUT | `system/config/python-mirror` | --data, --query |
| `ql system config-linux-mirror ` | PUT | `system/config/linux-mirror` | --data, --query |
| `ql system update-check ` | PUT | `system/update-check` | --query |
| `ql system update ` | PUT | `system/update` | --query |
| `ql system reload ` | PUT | `system/reload` | --data, --query |
| `ql system notify ` | PUT | `system/notify` | --data, --query |
| `ql system command-run ` | PUT | `system/command-run` | --data, --output, --query |
| `ql system command-stop ` | PUT | `system/command-stop` | --data, --query |
| `ql system data-export ` | PUT | `system/data/export` | --data, --output, --query |
| `ql system data-import ` | PUT | `system/data/import` | --data, --file (data), --query |
| `ql system logs ` | GET | `system/log` | --query |
| `ql system logs-delete ` | DELETE | `system/log` | --query |
| `ql system auth-reset ` | PUT | `system/auth/reset` | --data, --query |
| `ql system config-timezone ` | PUT | `system/config/timezone` | --data, --query |
| `ql system config-lang ` | PUT | `system/config/lang` | --data, --query |
| `ql system config-panel-title ` | PUT | `system/config/panel-title` | --data, --query |
| `ql system config-global-ssh-key ` | PUT | `system/config/global-ssh-key` | --data, --query |
| `ql system config-dependence-clean ` | PUT | `system/config/dependence-clean` | --data, --query |
| `ql dashboard record ` | POST | `dashboard/record` | --data, --query |
| `ql dashboard overview ` | GET | `dashboard/overview` | --query |
| `ql dashboard trend ` | GET | `dashboard/trend` | --query |
| `ql dashboard top-time ` | GET | `dashboard/top-time` | --query |
| `ql dashboard top-count ` | GET | `dashboard/top-count` | --query |
| `ql dashboard runtime ` | GET | `dashboard/runtime` | --query |
| `ql dashboard labels ` | GET | `dashboard/labels` | --query |
| `ql dashboard system ` | GET | `dashboard/system` | --query |
| `ql system client-ip-get ` | GET | `system/client-ip/config` | --query |
| `ql system client-ip-set ` | PUT | `system/client-ip/config` | --data, --query |
| `ql system client-ip-diagnose ` | GET | `system/client-ip/diagnose` | --query |
| `ql system retention-set ` | PUT | `system/storage-retention/config` | --data, --query |
| `ql system retention-preview ` | POST | `system/storage-retention/preview` | --data, --query |
| `ql system retention-cleanup ` | POST | `system/storage-retention/cleanup` | --data, --query |
| `ql user login ` | POST | `user/login` | --data, --query |
| `ql user logout ` | POST | `user/logout` | --query |
| `ql user update ` | PUT | `user` | --data, --query |
| `ql user get ` | GET | `user` | --query |
| `ql user two-factor-init ` | GET | `user/two-factor/init` | --query |
| `ql user two-factor-active ` | PUT | `user/two-factor/active` | --data, --query |
| `ql user two-factor-deactivate ` | PUT | `user/two-factor/deactivate` | --query |
| `ql user two-factor-login ` | PUT | `user/two-factor/login` | --data, --query |
| `ql user login-log ` | GET | `user/login-log` | --query |
| `ql user ip-blacklist ` | GET | `user/ip-blacklist` | --query |
| `ql user ip-blacklist-set ` | PUT | `user/ip-blacklist` | --data, --query |
| `ql user ip-blacklist-delete ` | DELETE | `user/ip-blacklist` | --data, --query |
| `ql user notification-get ` | GET | `user/notification` | --query |
| `ql user notification-set ` | PUT | `user/notification` | --data, --query |
| `ql user init ` | PUT | `user/init` | --data, --query |
| `ql user notification-init ` | PUT | `user/notification/init` | --data, --query |
| `ql user avatar ` | PUT | `user/avatar` | --data, --file (avatar), --query |
| `ql system apply-reload ` | PUT | `update/reload` | --query |
| `ql system apply-system ` | PUT | `update/system` | --query |
| `ql system apply-data ` | PUT | `update/data` | --query |
| `ql health get ` | GET | `health` | --query |
