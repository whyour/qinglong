# QingLong 2.x remote management CLI

[简体中文](README.md) | **English**

`@qinglong/cli` is a standalone npm client for the panel's open API. It registers only `ql`, for authentication, tasks and subscriptions. Local execution, repo/raw workers, reload/update/account recovery belong to the panel's internal tools and are excluded from npm. Development publishing is outside both command sets.

## Installation and commands

Requires Node >=22.12; Node 24 is recommended. Commander is bundled with no additional runtime npm dependencies. There is no standalone CLI image.

```sh
npm install -g @qinglong/cli
ql --help
# Temporary use without replacing an existing panel ql
npm exec --package=@qinglong/cli -- ql --help
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

## Authentication

Create a dedicated panel application with `crons` and/or `subscriptions` permissions as needed. `login` and `auth login` are equivalent. Interactive login prompts for Client ID and a hidden Client Secret. For automation, inject `QL_CLIENT_ID` and `QL_CLIENT_SECRET` through the environment; secret command-line arguments are not supported.

Use the panel root URL, including any reverse-proxy path prefix, without appending `/open`. Remote connections require HTTPS; HTTP is allowed for loopback addresses. Requests do not follow redirects. The 2.x token endpoint carries credentials in query parameters, so configure the proxy to avoid recording that query string.

Credentials and tokens are stored in `~/.config/qinglong/cli.json`, a plaintext file owned by the current user with mode 0600. Set `QL_CLI_CONFIG` to another file to select a different instance. Expired tokens refresh automatically; operations are not replayed after 401/403 responses.

`auth status` verifies `crons` read access by making a request without printing credentials. Use `--scope subscriptions` to check subscription access. Login verifies application credentials, not its task permissions. `logout` removes local credentials only; reset or delete the application in the panel to revoke access. QingLong 2.x grants both read and execution access through `crons`; the CLI does not add server-side read-only permissions.

## Tasks, subscriptions and output

Subscription commands support `list`, `get`, `run`, `stop`, `logs`, `enable` and `disable`. Subscription lists return `{code:200,data:[...]}`, without task pagination. Subscription reads omit repository URLs, fetch credentials, proxies and executable hooks. Logs are not automatically redacted.

Commands output pretty-printed JSON by default; `--json` produces a single line. Success goes to stdout and errors to stderr. Help with `--json` returns `{code:200,data:{help:"..."}}`.

- Task list: `{code:200,data:{data:[...tasks],total:123}}`. Default page size: 50; maximum: 200. Task fields retain server content.
- Task get: `{code:200,data:{id:12,...}}`.
- Logs: `{code:200,data:"log tail",logStatus:"completed",truncated:true}`. Default tail: 200 lines; maximum: 10000. `logStatus` is omitted when absent from the older API.
- Task run/stop: `{code:200,data:{taskId:12,action:"run",accepted:true}}`. Subscription mutations use `subscriptionId`. Acceptance does not mean execution succeeded.
- Errors: `{code:1,message:"..."}`. Exit codes: 0 success, 1 API/network/configuration failure, 2 invalid arguments, 3 missing authentication or HTTP/API 401/403.

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

The CLI package workflow runs type checking, builds and tests on Node 22.12/24 for relevant PRs, develop pushes and manual runs. Node 24 uploads the verified archive as `qinglong-cli-<commit>`; it does not publish to npm. Install the tgz from that artifact without build tools.

## Panel-internal tools

Local execution, subscription synchronization and maintenance ship with panel source/builds, using the full internal dist tree and a separate `qinglong-local` skill. See `cli/LOCAL.md` and `cli/LOCAL.en.md` in the source checkout. An npm installation is not a valid QL_CLI_ROOT. Recovery/reload must run on the actual panel host or inside its container, using docker exec for Docker installations.

API task run returns acceptance; a local runner waits for script completion. Their elapsed times are different measurements. Compare the internal TS runner against Shell using identical configuration/scripts; remote API management has no equivalent old Shell management command.
