# QingLong 2.x remote management CLI

[简体中文](README.md) | **English**


The npm and panel-internal entries both use the name `ql`, but have separate Commander command trees. The npm entry only calls remote APIs; the internal entry only runs local tools. Verify the absolute executable path and `--help` before use. Installing the npm package does not migrate the built-in Shell commands.

`@whyour/qinglong-cli` is a standalone npm client for the panel's open API. It registers only `ql`, for the currently supported OpenAPI resources. Local execution, repo/raw workers, reload/update/account recovery belong to the panel's internal tools and are excluded from npm. Development publishing is outside both command sets.

## Installation and commands

Requires Node >=22.12; Node 24 is recommended. Commander is bundled with no additional runtime npm dependencies. There is no standalone CLI image.

```sh
npm install -g @whyour/qinglong-cli
ql --help
# Temporary use without replacing an existing panel ql
npm exec --package=@whyour/qinglong-cli -- ql --help
```

This branch has not published the package. Build with `npm ci --prefix cli` and `npm run build:cli`, then run `npm pack` in cli and install the local tgz. Global installation occupies the `ql` name. On a panel host use a separate npm prefix or `node /absolute/path/to/cli/dist/npm/ql.js`.

```sh
ql login --url https://ql.example.com
ql auth status --json
ql task list --search example --page 1 --size 50 --json
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

Use command `--help` and `QL_LANG=en` for English. Command names and JSON fields do not change with language. The npm CLI never interprets unknown task actions as local scripts and does not register a separate `task` executable.

## Complete OpenAPI management

The CLI also supports task/subscription CRUD, application and secret management, environment variables, configuration, scripts, logs, dependencies, system, dashboard and user APIs. `ql api routes --json` lists all 143 active routes; three retired file-reading endpoints are excluded. CI compares the catalogue against backend routes. See the [complete bilingual reference](skills/qinglong-cli/references/openapi.md) for every command and payload.

```sh
ql task create --name demo --command 'task demo.js' --schedule '0 0 * * *' --json
ql subscription create --type public-repo --url https://example.com/repo.git --alias demo --schedule-type crontab --schedule '0 0 * * *' --json
ql app create --name agent --scopes crons,subscriptions --show-secrets --json
ql env create --data @envs.json --json
ql api request PUT /open/crons/run --data '[12,13]' --json
```

Use --data JSON/@file/- for bodies, --query for query objects, --file for uploads and --output for downloads. New commands support --timeout seconds. Existing command contracts remain; raw API requests expose all fields and batch operations. Downloads do not overwrite files. App secrets require --show-secrets; other raw resources may contain sensitive data.

Remote ql system commands call the target panel API. Local reload/reset tools remain excluded from npm.

## Authentication

Protected requests use `Authorization: Bearer <token>`. Two credential sources are supported:

| Mode | Supply credentials | Persistence and refresh |
| --- | --- | --- |
| Application login | `ql login --url <panel-url>` prompts for Client ID / Client Secret; automation injects `QL_CLIENT_ID` and `QL_CLIENT_SECRET` | Exchanges credentials at `/open/auth/token`, saves credentials/token locally and refreshes expired tokens |
| Direct access token | Set `QL_URL` and `QL_ACCESS_TOKEN` together; accepts a valid application token or panel session token | Overrides saved configuration, is not persisted and is not refreshed |

### Application login

Create a dedicated panel application with the required scopes, such as crons, subscriptions or envs. `login` and `auth login` are equivalent. Interactive login hides the Client Secret; secret command-line arguments are not supported.

```sh
ql login --url https://ql.example.com
ql auth status --scope crons --json
# For automation, inject QL_CLIENT_ID and QL_CLIENT_SECRET before the same login command
```

Credentials/token are stored in `~/.config/qinglong/cli.json`, a plaintext file owned by the current user with mode 0600. `QL_CLI_CONFIG` selects another file. Login validates application credentials, not every resource permission.

### Direct access token

Inject QL_URL and QL_ACCESS_TOKEN through your terminal or CI credential settings, then invoke commands without login:

```sh
ql auth status --scope apps --json
ql app list --json
```

Both variables are required for protected commands; providing only one is a usage error. They take precedence over the file selected by QL_CLI_CONFIG. Running login still writes application configuration, but subsequent requests continue using the environment token. Run `unset QL_URL QL_ACCESS_TOKEN` in your own terminal to return to saved application credentials.

Application management requires apps permission or an authorized panel session. The current UI does not list every backend scope; the CLI never escalates automatically. Anonymous user login requires only QL_URL and accepts --data @credentials.json or --data -; the returned session is not automatically saved. A two-factor challenge (server 420) exits 3 and directs you to user two-factor-login with username/password/code in its JSON body. Do not put credentials in command arguments or chat.

### Permissions, logout and failures

Auth status checks crons read permission by default. Use --scope subscriptions, --scope apps or another supported scope for that resource. A representative read does not prove permission for every write. The crons scope covers reads and execution.

Auth logout deletes only saved application configuration. It neither revokes server tokens nor clears QL_ACCESS_TOKEN from the parent environment, so direct-token access may continue. Revoke access through the panel's application/session management. Resetting an application secret invalidates its old tokens; login again with the new secret.

Use the panel root URL with any proxy prefix, without /open. Remote connections require HTTPS; loopback HTTP is allowed. Requests never follow redirects. The 2.x application token endpoint carries credentials in query parameters; avoid logging that query at the proxy. Operations are not replayed after 401/403. An expired direct token must be replaced; the CLI does not fall back to saved application credentials.

## Tasks, subscriptions and output

Subscription commands include create/update/delete/list/get/run/stop/logs/enable/disable/status/log-files. Subscription lists return `{code:200,data:[...]}`, without task pagination. The subscription list/get commands omit repository URLs, fetch credentials, proxies and executable hooks; raw API responses and create/update results may contain sensitive fields. Logs are not automatically redacted.

Commands output pretty-printed JSON by default; `--json` produces a single line. Success goes to stdout and errors to stderr. Help with `--json` returns `{code:200,data:{help:"..."}}`.

- Task list: `{code:200,data:{data:[...tasks],total:123}}`. Default page size: 50; maximum: 200. Task fields retain server content.
- Task get: `{code:200,data:{id:12,...}}`.
- Logs: `{code:200,data:"log tail",logStatus:"completed",truncated:true}`. Default tail: 200 lines; maximum: 10000. `logStatus` is omitted when absent from the older API.
- Task run/stop: `{code:200,data:{taskId:12,action:"run",accepted:true}}`. Subscription run/stop/enable/disable use `subscriptionId`; CRUD and raw API operations retain their server response instead. Acceptance does not mean execution succeeded.
- Errors: `{code:1,message:"..."}`. Exit codes: 0 success, 1 API/network/configuration failure, 2 invalid arguments, 3 missing authentication, HTTP/API 401/403 or a two-factor challenge.

IDs must be positive integers. Each task run/stop request addresses one task. The 2.x API provides no separate run ID or idempotency key: an error may leave the outcome unknown. Inspect status before retrying. The CLI does not automatically retry HTTP requests.

Logs may belong to an earlier run; `completed` does not imply success. `--tail` truncates on the client and does not reduce server reads or network traffic. Neither task fields nor logs are automatically redacted.

## Skill, build and validation

The package includes `skills/qinglong-cli`, covering all remote commands. Copy it to your agent's skill directory and verify the remote npm entry. It contains no credentials and does not replace server permissions.

Strict TypeScript and Commander provide shared parsing/output with separate remote and internal entries. `dist/npm/ql.js` is a self-contained remote bundle; its build graph rejects local operational modules. The npm file allowlist includes only the remote bundle/map, licenses, bilingual documentation and remote skill. The full dist tree is panel-internal and is not published to npm.

```sh
npm ci --prefix cli
npm run check:cli
npm run test:cli
node cli/scripts/verify-package.cjs
```

Tests cover requests, token refresh, output, errors, no automatic retries, permissions and isolated installation. Package verification installs the archive offline, verifies the sole ql executable and rejects local commands.

The CLI package workflow checks, builds and tests Node 22.12/24 on relevant PRs, develop/master pushes and manual runs. Node 24 uploads the archive verified by offline installation as `qinglong-cli-<commit>`. After both matrix jobs succeed, master pushes publish that exact archive to npm as latest, using the same NPM_TOKEN secret as the Docker workflow. Manual runs publish only when run on master with publish enabled; PRs, develop and forks never publish. The token needs publish permission for @whyour/qinglong-cli.

The CLI has an independent stable version in cli/package.json and cli/package-lock.json. Before releasing changes, run `npm version patch --prefix cli --no-git-tag-version` (or minor/major) and commit both files. Existing versions are skipped with a notice; registry failures stop publication. Only stable X.Y.Z versions are published by this workflow. Publication does not rebuild the verified archive or run package lifecycle scripts.

## Panel-internal tools

Local execution, subscription synchronization and maintenance ship with panel source/builds, using the full internal dist tree and a separate `qinglong-local` skill. See `cli/LOCAL.md` and `cli/LOCAL.en.md` in the source checkout. An npm installation is not a valid QL_CLI_ROOT. Recovery/reload must run on the actual panel host or inside its container, using docker exec for Docker installations.

API task run returns acceptance; a local runner waits for script completion. Their elapsed times are different measurements. Compare the internal TS runner against Shell using identical configuration/scripts; remote API management has no equivalent old Shell management command.

## Source layout

```text
src/
  entrypoints/     # Executable composition
  remote/          # commands / api / auth
  internal/        # commands / execution / subscription / maintenance / runtime / integration
  compatibility/   # Legacy entry and argument adapters
  shared/          # cli / i18n / response types and errors
```

Shared code cannot import business modules. Remote and internal modules may only import their own area and shared code; integration tests enforce these boundaries. Each surface owns its command registry, passed into the shared Commander parser.

Tests follow the same areas under test/. `npm run test:cli` (repository root) or `npm test` (cli/) discovers the standard suites; test/linux remains an explicitly invoked container integration suite. scripts/entrypoints.cjs preserves existing dist executable paths and dist/local/entrypoints.js and cronEntrypoint.js. Moving sources does not require changing QL_CLI_ROOT or cron commands.
