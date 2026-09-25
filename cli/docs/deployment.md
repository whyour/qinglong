# 2.x CLI opt-in panel image

This separate Dockerfile packages the compiled standalone CLI in `/opt/qinglong-cli`, alongside its docs and Skill. It adds unified `ql`, its `task` shortcut, prior compatibility commands and the `qinglong` startup alias to a dedicated directory at the front of PATH. The original panel Shell files and base-image entrypoint are retained. Existing production Dockerfiles are unchanged.

From the repository root:

```sh
npm ci --prefix cli
npm run build:cli
node cli/scripts/build-panel-loader.cjs
docker build -f cli/docker/Dockerfile.panel -t qinglong-cli-evaluation:2.20.1 .
```

The default panel and build-stage images are digest-pinned. To select another reviewed 2.x base, pass `--build-arg PANEL_IMAGE=...`. The build checks the panel version in package.json or the released version.yaml; 3.x is rejected. The Dockerfile-specific ignore file admits only CLI build output, package metadata, documentation and Skill, plus the separately compiled 2.x command-selection loader, excluding source, tests, credentials and repository dependencies. Build the current CLI before building the image.

For a disposable evaluation (use a fresh volume, not production data):

```sh
docker run --rm --name ql-evaluation -p 127.0.0.1:5700:5700 qinglong-cli-evaluation:2.20.1
```

The image sets `QL_CLI_ROOT=/opt/qinglong-cli` and places `/opt/qinglong-cli/bin` before base-image commands. The image also replaces the single compiled 2.x command-selection loader with this repository’s implementation. That loader generates TS wrappers in ~/bin, which is necessary because released schedulers may use that location directly. No other backend module is rebuilt, and the separate 3.x build is not invoked. No system-wide original link is overwritten. The selected loader also installs a private ~/bin/crontab bridge. Only submissions of the configured panel task file receive an explicit environment export before each scheduled command; this supports BusyBox cron without relying on inherited daemon PATH or arbitrary crontab environment variables. The source task file stays unchanged, and bridge-mediated crontab -l removes its own additions. Other files/options go to the native utility. Captured values are limited to command/interpreter paths and QL installation directories, excluding credentials. Paths containing newline, NUL or percent are rejected before installation (percent has special cron semantics). Deselecting QL_CLI_ROOT removes only the owned bridge; unrelated user commands are retained. Merely removing QL_CLI_ROOT does not deselect this image's PATH overlay; return to the original base image to return to its command selection.

The package includes bundled Commander and its license, with no external runtime npm dependencies. The selected panel must supply Node >=22.12.0 (Node 24 LTS recommended); image construction checks this requirement. System tools and task interpreters come from the selected panel image. The base image's existing Shell entrypoint still performs container boot; this overlay proves artifact distribution and task/maintenance command selection, not completion of the separate TypeScript container-bootstrap migration. It does not publish to a registry or alter the base-image tag.

## TypeScript container entry evaluation

After rebuilding the CLI and evaluation image, a separate explicit entrypoint is available:

```sh
docker run --rm --init --stop-timeout 30 --name ql-container-evaluation \
  --entrypoint node -e QL_SCHEDULER=node \
  qinglong-cli-evaluation:2.20.1 /opt/qinglong-cli/dist/container.js
```

Use a fresh disposable data volume for this gate. This entry prepares container directories, HOME and network files; repairs configuration; loads user configuration; exports service ports; starts the panel and optional bot/extra hooks; and remains active until termination. It performs no package installation or host startup registration. It uses environment configuration only and rejects positional arguments. Startup events are JSON lines on stdout, while service command diagnostics use stderr. QL_DIR defaults to /ql, and QL_DATA_DIR follows the local context's data-directory setting.

QL_SCHEDULER accepts node or system. When absent, crond availability selects system, otherwise node. System mode runs crond -f and treats any unexpected exit as failure. Signal cancellation stops that process group, terminates startup-hook groups, and stops the panel, including after partial startup failure. Docker --init is required for orphan reaping; the TS process is not a general-purpose PID 1 reaper. Node mode relies on the existing panel/PM2 lifecycle and does not add backend health supervision. The evaluation image's default entrypoint is still unchanged.

Allow at least 30 seconds for container shutdown (`--stop-timeout 30`, or Compose `stop_grace_period: 30s`). The local CLI gives subprocess groups ten seconds to handle termination before escalation; container cleanup allows startup-hook supervisors fifteen seconds to finish that cleanup before escalating against the supervisor. A shorter Docker timeout can kill the container before this protocol finishes. If automatic bot startup was attempted, cleanup also stops the Python bot matching this data directory after the installer finishes, even if the installer already exited. This retains the local bot stop operation's SIGKILL behavior. Scripts deliberately detaching new sessions and subprocesses independently created by bot code are not covered by a general daemon-cleanup guarantee.
