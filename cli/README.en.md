# QingLong 2.x TypeScript CLI

[简体中文](README.md) | **English**

A standalone CLI for QingLong 2.x. Manage tasks and subscriptions through the panel's open API, and use separate local tools for execution and maintenance. The original `ql` and `task` Shell commands and user configuration remain available. Installation does not switch panel commands automatically; explicitly select the TypeScript implementation with `QL_CLI_ROOT` as described below. The new implementation does not implicitly invoke the old product Shell scripts.

## Install from npm

The npm package is the only standalone CLI release artifact; no separate CLI image is published. Node >=22.12 is required; Node 24 is recommended. Once the package version is published:

```sh
npm install -g @qinglong/cli
ql --help
# One-off use; select ql explicitly because the package has multiple bins.
npm exec --package=@qinglong/cli -- ql --help
```

This branch prepares npm distribution; it does not publish the package. Before publication, run `npm ci --prefix cli`, then run `npm pack` inside `cli` and install that local archive; see the [deployment guide](docs/deployment.md). API management needs only Node; local operations additionally need the panel files and relevant interpreters/system tools. Panel images may integrate the same npm artifact into their normal release. Dockerfiles in this directory are internal test fixtures.

## Unified entry

Use `ql auth`, `ql task`, `ql subscription` and `ql dev` for grouped operations, and direct commands such as `ql update`, `ql reload` and `ql check` for local maintenance. `task` is shorthand for `ql task`, with identical arguments and behavior.

```sh
ql task list --json
ql task run 12 --json
ql task demo.js now
ql task exec --root /ql demo.js now
task demo.js now
ql update --help
ql raw <url>
ql subscription run 5 --json
ql dev release --root /repo --json
```

`list/get/run/stop/logs` are reserved API actions; `exec` explicitly selects local execution. A script with a reserved name must use `ql task exec <script>` or `ql task ./<script>`. Invalid task IDs never fall back to executing a script. Bare `ql task` shows combined help; use `ql task exec --root /ql` for the legacy script inventory. Arguments after the script remain intact; options following `--` belong to the script.

`ql local <command>` remains an alias. `ql update false` maps to `ql update --download-only`; `ql update true` retains the default apply behavior. `ql reload system|data|services` maps to `--target`. Named options such as `--root` and `--json` may follow these legacy positionals; duplicate options remain errors. `ql repo/raw` retains its subscription arguments. Previous package entries such as `ql-cli`, `ql-local-cli` and `ql-task-cli` remain compatibility aliases. The package now exposes `ql` and `task`: global installation claims those names. For evaluation, use an isolated npm prefix or `node /absolute/path/to/dist/ql.js`. Panel command selection still requires explicit `QL_CLI_ROOT` configuration.

## Command boundaries

| Entry point | Purpose |
| --- | --- |
| `ql` / `dist/ql.js` | Panel authentication, tasks and subscriptions through the API |
| `ql update/reload/check/…` (alias: `ql local …`) | Local startup, upgrades, repair, account reset, log cleanup and extra scripts |
| `ql task exec` / `dist/runner.js` | Local script execution, logs and lifecycle reporting |
| `ql-subscription-worker` / `dist/subscription-worker.js` | Internal repo/raw fetching, file synchronization and cron reconciliation |
| `ql-compat` / `dist/compat.js` | Adapter for legacy `ql` positional arguments |
| `qinglong-cli` / `dist/startup.js` | Legacy no-argument `qinglong` startup and `reload` |
| `ql dev` / `dist/developer.js` | Developer release plans, CDN metadata and branch/tag publication |

Public subscription management uses panel subscription IDs. Legacy repo/raw arguments belong to the internal worker. Installation and repair belong to local maintenance; release operations belong to the developer tool. See the [command scope](docs/command-scope.md) and [migration checklist](docs/migration.md) (Chinese).

## Build and run

From the repository root, install the standalone CLI build dependencies:

```sh
npm ci --prefix cli
npm run build:cli
QL_LANG=en node cli/dist/ql.js --help
node cli/dist/ql.js login --url https://ql.example.com
node cli/dist/ql.js auth status --json
node cli/dist/ql.js task list --search example --page 1 --size 50 --json
node cli/dist/ql.js task get 12 --json
node cli/dist/ql.js task logs 12 --tail 200 --json
node cli/dist/ql.js task run 12 --json
node cli/dist/ql.js task stop 12 --json
node cli/dist/ql.js auth status --scope subscriptions --json
node cli/dist/ql.js subscription list --search example --json
node cli/dist/ql.js subscription get 5 --json
node cli/dist/ql.js subscription run 5 --json
node cli/dist/ql.js subscription logs 5 --tail 200 --json
node cli/dist/ql.js auth logout --json
```

The CLI requires Node.js >=22.12.0; Node 24 LTS is recommended. Commander 15 is bundled at build time, so no additional runtime npm installation is needed. API operations do not load the backend or database. Copy the **entire** built `cli/dist` directory to another machine and run `node /absolute/path/to/dist/ql.js`; copying only `ql.js` is insufficient. Local tools additionally require an installed panel and the system tools needed by their operations.

Run `npm pack` inside `cli` after building, then install the local archive in your evaluation environment. The package is configured for public npm distribution but has not been published. Use an isolated prefix to avoid replacing existing global commands.

The source separates argument parsing (`arguments.ts`), command handlers (`commands/`), API requests and validation (`api/`), credentials (`config/`) and boundary types (`types.ts`). A separate strict TypeScript configuration compiles the modules, then esbuild bundles a shared `dist/framework/commander.js`. Business modules remain lazy-loaded. The Commander license ships in `dist/licenses/commander-LICENSE`; build dependencies are pinned in `cli/package-lock.json`. No 3.0 build is involved.

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

## Local execution and maintenance

```sh
QL_LANG=en ql update --help
ql task exec --root /ql example.js now
ql start --root /ql --data-dir /ql/data
ql update --root /ql --mirror github --download-only
ql reload --root /ql --target system
```

CLI options precede script arguments. Use `--` to pass arguments through to the script. `ql task exec --json` routes script output to stderr, reserves stdout for the result and preserves the script exit code. With `QL_DIR` or `--root` configured, calling the runner without a script shows help and top-level JS scripts, excluding `sendNotify.js`; activity names are extracted from `new Env(...)` text. JSON exposes `data.scripts`. Explicit `--help` neither inventories scripts nor executes configuration.

Local operations include `repair-config`, `update --mirror github|gitee [--download-only]` and `reload --target services|system|data`. Downloads are staged without stopping services when `--download-only` is set. A subsequent `reload --target system` uses the recorded staging directory. A failed later download preserves the previous usable record.

`check` retains the legacy **repair** behavior: it installs global tools and panel dependencies, restores configuration and notification files, then diagnoses and reloads services. It is not a read-only command. JSON includes health observations before/after reload and bounded PM2 log tails (up to 300 lines and 256 KiB each), without automatic redaction.

`bot` prepares dependencies and the optional Bot repository, reads `BotRepoUrl`, preserves existing `bot.json` and starts the Bot. Supported systems are Alpine, Debian and Ubuntu Linux. Actual Alpine package/pip installation and Python process isolation were tested using a test Bot, without connecting to Telegram. Dependencies are installed from a pip requirements file; see migration notes for compatibility differences.

`start` performs local installation and service startup. `--reload` skips dependency installation, optional Bot/extra steps and boot registration. Node/Python runtimes must already be installed. Tests cover the official 2.20.1 container and actual Alpine/OpenRC and Debian 12/systemd boots, including retained scheduled tasks; they do not establish support for every distribution.

For container startup, use `--no-startup` to skip system boot registration. Dependency preparation, service startup and PM2 process-list saving still run. Otherwise `pm2 startup` runs and failures are reported. The `startup` result distinguishes `registered`, `skipped` and `not-requested`.

`qinglong-cli` starts the panel; `qinglong-cli reload` preserves the old reload form. Select installation paths through `QL_DIR`/`QL_DATA_DIR` or explicit directory options.

## Legacy arguments and explicit entry selection

```sh
QL_DIR=/ql ql-compat update false
QL_DIR=/ql ql-compat reload system
QL_DIR=/ql ql-compat repo <url> <include> <exclude> <dependencies> <branch> <extensions> <proxy> <autoAdd> <autoDelete>
```

`update false` maps to `--download-only`; `reload system|data` selects that target. Repo/raw operations go to the internal subscription worker; maintenance goes to the local tool. The legacy `-l` prefix is accepted (the original only parsed it). Arguments are not concatenated into a Shell command. Panel API management remains `ql` and local execution remains `ql task exec`.

Maintenance and subscription operations preserve per-command logs, `no_tee`/`real_time`, one-time configuration loading and lifecycle reporting where applicable. JSON stays on stdout. Interruptions return nonzero signal statuses and finalize reports for started operations. Local API requests can be cancelled while waiting for responses or reading bodies. Upgrade rollback and process recovery have dedicated validation evidence.

Lifecycle reporting reads the installed panel's `package.json` version, falling back to the top-level version in `version.yaml`. Versions up to 2.20 and unrecognized versions use basic reporting; 2.21+ enables extended reporting/statistics. Override with `QL_CLI_LIFECYCLE=legacy|extended` for customized/backported panels. Exit codes unsupported by older APIs remain in command results and logs.

Subscription include/exclude/dependency expressions and task `RandomDelayFileExtensions` retain POSIX ERE semantics via the native `grep -E` executable. Workers need the relevant system tools, including grep, Git and curl. Filtered paths containing newlines are rejected.

Panels containing this change to `back/loaders/deps.ts` can set `QL_CLI_ROOT=/absolute/path/to/cli` in the **panel process environment**. It must point to a built or installed CLI root containing `dist`. The loader creates Node wrappers for `ql` and `task` in the user's `~/bin`, prepends that directory to the panel's PATH, and retains the selection across reloads. This affects the panel and its children; separate terminals should use the selected paths explicitly. Existing images require installation or mounting of the CLI first.

Unset the variable and restart the panel to restore original Shell links. Installing the npm package alone does not switch commands. Invalid/unreadable paths or missing entries produce startup-link errors rather than silently falling back. Original Shell files remain available. Migration acceptance is complete; production publication has not been performed.

The internal-only [panel integration test image](docs/deployment.md) packages the CLI, documentation and Skill into `/opt/qinglong-cli` with the 2.x selection loader. Build the CLI and run `node cli/scripts/build-panel-loader.cjs` before using `cli/docker/Dockerfile.panel`. Production Dockerfiles are unchanged.

All executable entries support English help through `QL_LANG=en`; Chinese is the default. Command/option names and JSON keys are stable across languages. Task and maintenance execution messages use the same language setting. Help reads process environment only, without loading panel configuration.

## Developer releases

Inspect a plan with `node cli/dist/developer.js release --root /absolute/repository --json`. To execute, add `--apply --commit <full-planned-commit-SHA>`. The default destination is `origin/master`; override with `--remote` and `--branch`. Publishing uploads CDN metadata and replaces the target branch and current version tag. Tests use temporary Git repositories; no actual release was published. See migration notes before using this operation.

## Skill and validation

The standalone package includes `skills/qinglong-cli` (source: `cli/skills/qinglong-cli`). Copy it into your agent's skills directory and provide the absolute CLI entry path on first use. The Skill stores no credentials and does not replace server permissions.

```sh
npm run check:cli
npm run test:cli
node cli/scripts/benchmark.cjs
node cli/scripts/benchmark-legacy.cjs
node cli/scripts/verify-package.cjs
```

Tests cover isolated API behavior, authentication refresh, errors, no automatic retries, credential permissions, standalone packaging, entry isolation, script arguments/exit codes, timeouts, log cleanup and preserving files after failed synchronization. Additional acceptance covers real panels, 2.19.0 → 2.20.1 upgrades, host reboot/scheduling and three-platform regression. See [evaluation evidence](docs/evaluation.md) and [acceptance audit](docs/acceptance-status.md) (Chinese).

## Comparing elapsed time

`ql` panel-management operations include authentication when needed and HTTP round trips. Maintenance commands such as `ql update/check/reload` run locally, so their duration depends on the operation. `ql task run` returns when the request is accepted, while `ql task exec` waits for the script to finish; those return times measure different things. Subscription run acceptance likewise does not mean fetching is complete.

For the original Shell versus TypeScript executor comparison, see [timing measurements](docs/timing.md) (Chinese and English). `benchmark.cjs` measures empty Node versus CLI help startup only. `benchmark-legacy.cjs` measures the same isolated task through both executors without reading real panel configuration.

The local configuration bridge uses Bash and `/usr/bin/env -0` to capture exported environment data. The current Node process parses NUL-separated records without starting another Node process for serialization. Validated on macOS, Debian (GNU env) and Alpine (BusyBox env); other platforms require a compatible env executable.

See the [CLI framework evaluation](docs/cli-framework.md) for current-parser, Commander, CAC and Yargs measurements, including bundled Commander.
