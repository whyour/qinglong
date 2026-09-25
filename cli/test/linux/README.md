# Linux CLI regression runtime

Build the CLI on the host first (`npm run build:cli`), then build this test-only image:

```sh
docker build -t qinglong-cli-test:node22-debian cli/test/linux
docker run --rm --network none \
  --mount type=bind,src="$(pwd)/cli",dst=/workspace/cli,readonly \
  --mount type=bind,src="$(pwd)/shell",dst=/workspace/shell,readonly \
  --mount type=bind,src="$(pwd)/back/api",dst=/workspace/back/api,readonly \
  --workdir /workspace qinglong-cli-test:node22-debian
```

The image supplies Linux interpreters, Git and archive tools. It does not mount host node_modules, credentials, the Docker socket or production data. Tests use temporary installations and loopback API fixtures; the runtime has no external network. Package installation verification runs offline after the test suite. No installed ql/task command is replaced. The original Shell is mounted read-only for differential tests.

Image construction needs network access. If Docker injects a stale proxy, override it for this build only with empty HTTP_PROXY, HTTPS_PROXY, ALL_PROXY and their lowercase build arguments; do not change global proxy settings as part of the test.

The Node base image digest and TypeScript interpreter versions are fixed. Debian package revisions follow the Bookworm repositories at build time. Passing this suite does not prove real panel authentication/database persistence, nginx/PM2 deployment, or compatibility of all user scripts.

For Alpine/musl, use the second pinned base and the same read-only runtime mounts:

```sh
docker build -f cli/test/linux/Dockerfile.alpine -t qinglong-cli-test:node24-alpine cli/test/linux
docker run --rm --network none \
  --mount type=bind,src="$(pwd)/cli",dst=/workspace/cli,readonly \
  --mount type=bind,src="$(pwd)/shell",dst=/workspace/shell,readonly \
  --mount type=bind,src="$(pwd)/back/api",dst=/workspace/back/api,readonly \
  --workdir /workspace qinglong-cli-test:node24-alpine
```

This includes Bash/coreutils, as does the panel's Alpine Dockerfile; it is not a bare BusyBox compatibility claim. Python comes from the pinned base's Alpine repository, and package patch revisions remain build-time dependent.

## Real service manager integration

After building the Debian test image:

```sh
docker build -f cli/test/linux/Dockerfile.services -t qinglong-cli-test:services cli/test/linux
docker run --rm --network none \
  --mount type=bind,src="$(pwd)/cli",dst=/workspace/cli,readonly \
  --workdir /workspace qinglong-cli-test:services
```

This separate test installs nginx and PM2 5.4.3 in the image. It invokes bootstrap reload twice with an isolated PM2_HOME and nginx config, checks proxy responses/config replacement/backend PID change, and verifies stopPanel removes the PM2 application. Cleanup quits nginx and kills the test PM2 daemon before the disposable container is removed. Ports 5801/5802 remain container-local. The backend is a minimal HTTP fixture, not a real QingLong application/database. No OS boot integration (`pm2 startup`) or first-time online dependency provisioning is claimed by this test.

## Released 2.x panel integration

`panel.cjs` is for a fresh disposable official panel only. It refuses initialized instances, generates random temporary owner/application credentials without printing them, exercises API login/status/subscription reads and a scheduled task run, then invokes the new local task engine against the real token generator and verifies persisted log_path/execution time. It does not replace installed Shell entrypoints. The fixture script exits 7 in the local-runner step.

Run the official `whyour/qinglong:2.20.1@sha256:4e96d821494cfbeddd29f5a46dfb006a5a64f5639e0b8665816fcf55f39a85ea` image with `--network none`, no published ports, and this CLI directory mounted read-only at `/candidate/cli`. Clear inherited proxy variables for the test container. After its startup log reports readiness, execute:

```sh
docker exec -e QL_PANEL_INTEGRATION=1 <temporary-container-id> node /candidate/cli/test/linux/panel.cjs
```

Always remove that temporary container and its anonymous volume with `docker rm -fv <temporary-container-id>` after the run, including failures. Never point this test at an existing initialized panel. The version is explicit because the current workspace's backend build also contains independent 3.0 changes; this gate tests the public 2.x compatibility contract without pulling 3.0 work into the migration.

## Interrupted replacement with real services

Using the services image above, run:

```sh
docker run --rm --network none \
  --mount type=bind,src="$(pwd)/cli",dst=/workspace/cli,readonly \
  --workdir /workspace qinglong-cli-test:services \
  node --test cli/test/linux/upgrade.test.cjs
```

This test covers direct Node and PM2 separately. It starts the old HTTP fixture, invokes replaceAndReload in a child process, waits until the new HTTP fixture responds, sends SIGTERM to the upgrade child, then checks exit 143, old file/HTTP restoration, disappearance of the new PID, and backup cleanup. The child fixture inserts a deterministic wait after real startup so the signal cannot race past the rollback boundary. Test services and PM2_HOME are temporary; port 5811 is container-local. It exercises the real service functions and filesystem replacement but not QingLong database migrations, archive downloads, or interruption during a package install.

The optional `QL_PANEL_ENTRYPOINTS=1` environment flag on the same fresh-panel command enables a test-only reversible switch of the official release's `~/bin/task` and `~/bin/ql` symlinks. Original Shell targets remain on disk, and the links are restored in finally. It additionally schedules `ql extra` and checks persisted log metadata. The corrected gate passed on official 2.20.1 after legacy status-field selection and scheduler log-path reuse were added; retain the run output as evaluation evidence. It covers task and ql extra scheduling, not every legacy command.

With entry switching enabled, panel.cjs also runs panel-subscription.cjs: a loopback file subscription downloads through the new worker, creates one task with its subscription ID, then executes that task through the panel and checks its output. The official 2.20.1 gate passed on 2026-09-25. Notification channels are intentionally unconfigured; their rejection must produce a diagnostic without failing an otherwise completed synchronization. Repository subscriptions are outside this particular gate.

The switched-entrypoint fixture also includes panel-repository.cjs. It creates a local file:// Git repository with a main and selected branch, include/exclude patterns, a shared dependency, and two revisions. Assertions check the selected branch, exclusion, dependency execution, stable ID for an unchanged task, addition/removal after the second pull, and removal of the obsolete script. The source is local because the official image lacks git-daemon. This gate does not establish network Git transport, proxies or private repository authentication.

The switched-entrypoint gate also runs panel-account.cjs at the end. It changes only the freshly generated test owner's username/password through ql, verifies new login credentials, activates login retry/second-factor requirements via the test owner's API, and verifies resetlet/resettfa restore access. It never prints credentials and must only run inside the disposable panel guarded by panel.cjs. The account and its data volume are removed with the container.

The expanded switched-entrypoint gate now includes panel-operator.cjs for real log retention and full-panel service reload. Without the candidate loader, the original 2.20.1 startup loader overwrites temporary Node wrappers with Shell links. Use the candidate-loader gate below to verify persistent entry selection.

### Persistent entrypoint selection gate

The loader integration regression can be run on the development host with `node --test cli/test/linux/entrypoints.test.cjs`; it needs the repository TypeScript dev dependency and reads the actual back/loaders/deps.ts. It verifies both commands, exact args/exit codes, paths with spaces, repeated startup selection, invalid/incomplete installations and return to original Shell.

For the real-panel gate, transpile only back/loaders/deps.ts to a temporary CommonJS file using the repository TypeScript transpileModule (CommonJS, esModuleInterop, ES2022). Mount that file read-only as /candidate/deps.js alongside the CLI mount and start the disposable official image with QL_CLI_ROOT=/candidate/cli. Add QL_PANEL_LOADER=1 to the panel.cjs docker exec environment. The guarded fixture backs up the installed compiled loader, copies this single candidate loader, exercises reload, and restores the compiled loader and command links in finally. No full workspace backend/3.0 build is used. The updated gate passed with operatorMaintenance=true on 2026-09-25; without the candidate loader the expected old-entry overwrite remains reproducible.

## Online check/repair gate

Use a fresh disposable official 2.20.1 container with the CLI read-only mount, no published ports/user data, and normal container networking (unlike the offline gates). Clear inherited proxy environment variables. Execute `node /candidate/cli/dist/admin.js check --root /ql --json` with npm_config_registry=https://registry.npmjs.org, npm_config_fetch_retries=0 and npm_config_fetch_timeout=30000, redirecting stdout to /tmp/check-result.json. This performs real package downloads and container-local installs.

For the repair scenario, append a fixture comment to /ql/data/config/config.sh, copy it to /tmp/expected-config.sh, delete /ql/data/config/task_before.sh, and overwrite /ql/data/scripts/sendNotify.js with a fixture string. Run the same check again, redirecting stdout to /tmp/check-repair-result.json. Then execute `QL_PANEL_INTEGRATION=1 node /candidate/cli/test/linux/verify-check.cjs` inside that container. Always remove the container and anonymous volumes afterward. The official image and registry dependencies can change; retain the exact image digest and resulting tool versions with the evidence. Never run this damage fixture on an existing panel.

## First-start container gate

Start a fresh official image with `--entrypoint sleep`, arguments `infinity`, explicit QL_DIR=/ql and QL_DATA_DIR=/ql/data, and the read-only CLI mount. Allow package network access and clear inherited proxy variables as in the online check gate. This bypasses the legacy container entrypoint. Run `node /candidate/cli/dist/admin.js start --root /ql --data-dir /ql/data --no-startup --json > /tmp/start-result.json` inside the container, then `QL_PANEL_INTEGRATION=1 node /candidate/cli/test/linux/verify-start.cjs`. Use the same bounded npm registry environment as online check. Remove the container and anonymous volumes afterward.

--no-startup explicitly skips OS boot registration for containers lacking init, while PM2 save still runs. This does not validate host reboot behavior. The official image already provides Node/Python/panel dependencies; the gate verifies migration of startup orchestration, not provisioning an empty OS.

## Online Bot installation/process gate

Use a fresh official 2.20.1 container with `--entrypoint sleep ... infinity`, normal container networking, cleared proxy variables and the read-only CLI mount. Run `QL_PANEL_INTEGRATION=1 node /candidate/cli/test/linux/bot-install.cjs` inside it. The fixture creates a local Git repository, performs real apk/pip installation, starts two Python test bots in separate data directories, replaces one and verifies configuration/process isolation, then stops/cleans them. It sends no Telegram traffic and uses no bot credentials. Remove the disposable container and anonymous volumes afterward. The dependency fixture pins colorama 0.4.6; OS packages follow the image's configured repositories.

The network repository regression uses a loopback smart-HTTP Git service, random test credentials and a loopback HTTP proxy. It requires `git-http-backend`; Alpine packages it in `git-daemon`, included only in this test image. No external repository or credential is used, and the runtime still works with `--network none`.

The same regression also runs a TLS smart-HTTP service and an actual HTTP CONNECT tunnel. OpenSSL generates a temporary self-signed certificate with an IP SAN; Git receives it through GIT_SSL_CAINFO only for the trusted case. Removing trust must fail, as must HTTP 401/503, while preserving installed scripts and checkout HEAD. The Alpine test image includes the openssl executable for this fixture; no runtime CLI dependency or certificate-verification bypass is introduced.

## Isolated SSH subscription gate

Build `cli/test/linux/Dockerfile.ssh` as `qinglong-cli-test:ssh` after the Alpine test image. Run only in a fresh disposable container:

```sh
docker run --rm --init --network none -e QL_SSH_INTEGRATION=1 \
  --mount type=bind,src="$(pwd)/cli",dst=/workspace/cli,readonly \
  qinglong-cli-test:ssh node --test cli/test/linux/ssh-repository.test.cjs
```

This root-only fixture creates a container-local account, host/client keys and repository. It starts sshd on loopback port 22022 with password authentication and forwarding disabled, then verifies both SSH URL and scp-style Git addresses. StrictHostKeyChecking and IdentitiesOnly remain enabled. Wrong identities and mismatched known_hosts must fail without changing scripts or checkout HEAD. The fixture does not mount host SSH configuration or keys. Its temporary authorization files live below /var/lib because sshd StrictModes rejects the world-writable /tmp ancestor. Never run this opt-in fixture directly on a host: account removal is provided by disposable-container deletion.

## Published upgrade archive gate

Run `QL_ARCHIVE_INTEGRATION=1 node --test cli/test/linux/published-archive.test.cjs` with network access and current dist. Set QL_ARCHIVE_MIRROR=gitee to exercise that explicit mirror instead of GitHub. The gate calls stageUpgrade against real master source/static ZIP URLs and validates paths, expected app entry, readiness marker and selected-stage pointer. It records archive hashes and version for reproducibility because master can change.

Dependency installation is intercepted: downloaded source is never executed, and no installed panel is reloaded. The existing package-install and retained-data upgrade gates provide separate evidence for those operations. This gate uses temporary directories, bounds download work with cancellation at 150 seconds and removes staging afterward. External archive availability is a prerequisite; connection failures must not be reported as successful transport validation.

Data reload with a real mount root and a live Node backend has a separate disposable gate:

```sh
docker run --rm --network none --tmpfs /mounted-data -e QL_MOUNT_TEST=1 \
  --mount type=bind,src="$(pwd)/cli",dst=/workspace/cli,readonly \
  qinglong-cli-test:node24-alpine node --test cli/test/linux/mounted-data.test.cjs
```

The fixture requires an empty separate filesystem at /mounted-data, never a production data mount. It verifies the mount inode/device remain unchanged, obsolete data is removed, staged data is installed and the restarted backend serves the new data.

## Container startup-hook ownership

```sh
docker run --rm --init --network none --user 65534:65534 \
  --mount type=bind,src="$(pwd)/cli",dst=/workspace/cli,readonly \
  qinglong-cli-test:node24-alpine node --test \
  cli/test/containerRuntime.test.cjs cli/test/linux/container-bot.test.cjs
```

The bot fixture runs the actual detached admin installer and Python launcher against a local module with no Telegram code. OS/pip provisioning commands are fixture stubs; the separate online gate above validates dependency installation. It waits for the installer to exit while Python remains alive, stops the container runtime, and verifies that only its bot exits while another installation's bot stays alive. All fixture processes are cleaned, including on assertion failures. --init reaps adopted orphans.

## Real container crond gate

Start a fresh opt-in 2.20.1 image using the TS container entry with --init, --stop-timeout 30 and QL_SCHEDULER=system. Rebuild the evaluation image with the current CLI and mount only cli/test read-only at /opt/qinglong-cli/test. Do not overlay cli or dist: the source tree lacks image-generated bin links and local tsc output lacks the executable modes assigned during image packaging. No network or published port is required. Run `QL_PANEL_INTEGRATION=1 node /opt/qinglong-cli/test/linux/container-cron.cjs` with docker exec. It creates one minute-scheduled task through the local API, checks the installed system crontab and waits up to ninety seconds for a real minute tick. It never calls the task run API. The task records its process ancestry; the gate requires real crond, the selected Node task entry (verified wrapper or symlink target) and the TS container entry, and reads output through the panel log API. Task and script are removed in a finalizer. Stop the container, inspect its exit code and remove it with its anonymous volume afterward.

## Packaged language preload and service reload gate

Mount only cli/test at /opt/qinglong-cli/test in a fresh packaged 2.20.1 evaluation container. Start it through dist/container.js with QL_PANEL_INTEGRATION=1, --init and a 30-second stop timeout. Run panel.cjs first on the uninitialized panel for application authentication and API task/log checks. Then run `node /opt/qinglong-cli/test/linux/panel-preload.cjs` inside that container; set QL_PANEL_RELOAD_INTEGRATION=1 to additionally invoke the packaged local service reload after creating the first task and verify it survives. The gate schedules JS/MJS/Python through the real API, checks Shell before-hook exports and actual QLAPI, and imports a temporary global ESM exported subpath. It restores the hook and removes tasks/scripts/package in cleanup.

Use the image's ordinary seeded data volume. An empty tmpfs or host bind mount over /ql/data masks image-preinstalled requests under dep_cache/python3; that is not a complete interpreter environment. When explicitly evaluating tmpfs, seed the fixed image's preinstalled dependencies into the live mount and verify `python3 -c 'import requests'` before this gate. The recorded run used an offline copy from the same image, not pip installation or stub notification modules. Docker cp did not materialize writes in the active tmpfs in this environment; extraction by tar inside the running container did. Keep this prerequisite distinct from the separate empty-OS provisioning requirement.

## Real host reboot gate

`host-boot.cjs` runs only as root with QL_HOST_INTEGRATION=1 inside a disposable Alpine/OpenRC or Debian/systemd VM. Prepare a 2.x panel distribution plus the CLI, with Bash/Node/npm/Python/pip prerequisite runtimes. Run the actual `ql-local-cli start --root /ql` and require a successful registration result. Copy the test directory alongside the CLI dist directory, then run `node test/linux/host-boot.cjs before`, reboot the guest, and run the same script with `after` once SSH returns. Never run this on a production host.

The before phase verifies live nginx/crond, creates a minute-scheduled task and saves the kernel boot ID in a private fixture state file. The after phase checks OpenRC or systemd service state, requires a different boot ID, checks the stored task command and waits up to ninety seconds for a task log containing the new boot ID. It does not call the task run API. Success removes the task, script and state. On failure, retain the isolated guest for diagnosis or destroy it; do not cite PM2-only recovery as proof of nginx/cron recovery. The task fixture and script paths are under /ql, and the guest state file is /var/lib/ql-host-fixture.json.

## Remote OpenAPI CRUD gate

`openapi.cjs` requires a separate fresh official panel and `QL_PANEL_INTEGRATION=1`; it refuses initialized panels. Mount cli read-only at /candidate/cli, run the official image without published ports or production data, then execute `docker exec -e QL_PANEL_INTEGRATION=1 <container> node /candidate/cli/test/linux/openapi.cjs`. It creates temporary owner/application credentials without printing them and verifies task/subscription/app/env CRUD, app secret rotation, script/config writes and reads, and log/dependency reads through the npm bundle. It does not execute system updates, data import, real dependency installation or every dashboard/user mutation. Always remove the disposable container and anonymous volumes with `docker rm -fv <container>`.
