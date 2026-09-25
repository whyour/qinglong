# Evaluation evidence

This records measured evidence, not a replacement approval. The full acceptance matrix remains in migration.md.

## Independent package

Run `npm run build:cli` followed by `node cli/scripts/verify-package.cjs` from the repository root. The verifier creates a tarball, installs it offline in a temporary directory without lifecycle scripts, and invokes all six installed executable links from outside the source checkout. It checks that docs and the companion skills/qinglong-cli/SKILL.md are included, verifies the installed Skill matches its single source, and checks that source/tests are excluded, and no runtime npm dependencies are declared. All temporary package/cache/install files are removed.

Latest measured offline package snapshot passed for all six entries: 115,552 packed bytes, 445,323 unpacked bytes, zero runtime npm dependencies (2026-09-25, before this documentation update).

A standalone management CLI needs only Node. Local operators still need the installed panel, interpreters and system programs appropriate to their operation; the developer uploader uses the release repository's Qiniu/dotenv dependencies.

## Startup measurement

Measured on 2026-09-25, macOS arm64, Node v24.18.0, nine fresh processes per sample group:

| Measurement | Empty Node | Public help |
| --- | ---: | ---: |
| Median wall time | 69.18 ms | 71.38 ms |
| p95 wall time | 74.38 ms | 81.73 ms |
| Median peak RSS | 44.63 MiB | 45.78 MiB |

Measured incremental median: 2.20 ms and 1.15 MiB. Compiled dist including source maps: 352,255 bytes, including the two-step upgrade handoff and log-retention correction. These are local samples, not cross-platform bounds. Run `node cli/scripts/benchmark.cjs` to remeasure the current build.

## Task output compatibility

`test/differential.test.cjs` runs copies of the unmodified legacy Shell alongside the TypeScript executor. It compares Shell hook state and account selection, and checks `log_name=/dev/null` in now/desi/conc modes with `real_time` enabled and disabled. Normal and designated execution discard stdout but retain stderr, including hook errors. Concurrent child streams merge before being discarded, while hook stderr remains visible. The CLI routes visible task output to stderr to keep JSON stdout clean.

`test/local.test.cjs` separately verifies normal logging, `no_tee`, and `real_time`: realtime output overrides `no_tee` and does not create a persistent task log.

The differential fixture also exercises `return 7`, `exit 7`, `set -e; false`, and EXIT traps with both return and explicit exit, using `no_tee=true`. Both implementations run after-hooks for an ordinary return and skip them on explicit exit or errexit termination; EXIT traps execute in both cases. The new runner returns the actual task status; the legacy wrapper changes an ordinary returned failure to status 0. Pipeline/tee failure statuses and arbitrary combinations of shell options remain outside this fixture.

`test/runner.test.cjs` starts real Shell sessions through the compiled JSON CLI, waits for script readiness, then sends SIGINT, SIGTERM or SIGHUP to the CLI. The original signal reaches the child process group, with cancellation statuses 130, 143 and 129 respectively. Fixtures verify the matching INT/TERM/HUP trap plus EXIT trap, skipped after-hooks, final JSON and persisted diagnostics. A generic AbortController cancellation still defaults to SIGTERM/143; pre-cancelled executions never spawn. Only these three signal reasons are accepted. Additional CLI fixtures interrupt the random-delay phase with each of these signals: final JSON and logs retain the matching cancellation status, timedOut remains false, and the task never starts. These fixtures establish signal handling for running Shell sessions and random delay.

After-hook cancellation fixtures cover independent JS-task hooks and same-session Shell hooks with SIGINT/SIGTERM/SIGHUP. They verify original signal traps and final cancellation status even when the main script previously returned 7. An already-cancelled script does not start an independent after-hook. Ordinary hook failure still leaves the task exit status unchanged; cancellation is recorded separately through its conventional exit status. Configuration and separately evaluated before-hooks are covered by additional CLI fixtures for all three supported signals: the original trap runs, cancellation status is preserved, and the task does not start. Cancellation during configuration produces an error JSON on stderr (no task result exists yet); cancellation during a before-hook produces the final task result on stdout. Configuration evaluation now shares the process-group termination and escalation mechanism. fd 3 remains isolated from user output, with a 4 MiB capture limit and 30-second timeout followed by a one-second termination grace period. Separate tests verify fd 3 isolation/overflow and that pre-cancelled configurations are never sourced. These tests do not prove cleanup of independently detached descendants or all user-defined trap behavior.

## Direct backend discovery

`test/backendProcesses.test.cjs` constructs a temporary /proc-shaped tree and verifies the Linux selector against legacy relative commands, absolute commands, spaces in installation paths, symlink aliases, other installations, interpreter mismatches, extra arguments, missing cwd/script and exited processes. No host processes are signalled by this fixture. The selector is used by the Linux stop/start fallback; non-Linux retains the prior absolute-path ps match. The additional Linux-only test launches two temporary Node services with legacy relative entrypoints, stops one through stopPanel, verifies the other survives, then exercises direct Node startup, log output and stopping the new absolute-entry process. Both selector and live lifecycle tests passed in the Node 18 Debian container. This verifies actual /proc and signalling for responsive test services; an additional real HTTP-server fixture now covers delayed shutdown and port handoff: the old service delays exit by 400 ms, then its replacement serves requests on the same port. A service that ignores SIGTERM triggers a five-second stop deadline; the fixture verifies that no replacement was spawned. All five backend-process tests passed in the Node 18 Debian container. Concurrent external launches and arbitrary process-title changes remain outside this fixture.

## Linux container evidence and remaining gaps

Full Debian regression passed on 2026-09-25: **113 tests, zero failures, zero skips**, followed by successful offline package installation/help/Skill verification. The test runtime is defined in `test/linux/Dockerfile`; reproduction instructions are in `test/linux/README.md`. Image ID for this run: `sha256:b28303e3966efc1f1763fd8e939f4ccaa6e21cf1a0bdfbb7016d0c5971337883`. It uses Node 18.20.8 on Linux aarch64, Python 3.11, ts-node 10.9.2 and TypeScript 5.2.2, plus actual Git/curl/archive tools. Host node_modules are not mounted. Runtime networking is disabled apart from loopback; CLI and original Shell are read-only mounts.

This expands coverage to all current fixtures, including language preloaders, local Git subscriptions, archive validation/rollback and temporary-repository release cases. Bootstrap/package-manager/PM2/nginx operations still use controlled executables in these fixtures. The result proves the full current suite on Debian, not a production panel deployment. The package snapshot after this run was 87,010 packed bytes / 342,067 unpacked bytes, with zero runtime npm dependencies.

The initial image build failed because Docker injected an unavailable proxy. Empty per-build proxy arguments allowed construction; no global proxy setting was changed.

### Alpine full regression

The same full suite also passed on Alpine 3.21.3 aarch64 / musl, Node 18.20.8 and Python 3.12.14: **113 tests, zero failures, zero skips**, followed by successful offline package verification (87,579 packed bytes / 343,807 unpacked bytes at that documentation snapshot). The test image is defined in `test/linux/Dockerfile.alpine`; image ID: `sha256:da70a2e1a547220ff04b624fe3321d72e6337ae233bf5f7863cb8a2b14f5bd0e`.

It includes Bash and coreutils, matching those tool choices in the panel's Alpine Dockerfile. This is not a claim of compatibility with bare BusyBox or every historical Alpine version. As on Debian, the runtime had no external network, host credentials or host node_modules. Package revisions are build-time dependent even though the base digest is pinned.

### Real PM2/nginx lifecycle

The dedicated services image (`test/linux/Dockerfile.services`, PM2 5.4.3 plus Debian nginx) passed `test/linux/services.test.cjs` on 2026-09-25. It invokes bootstrapPanel in reload mode against real service executables with a temporary PM2_HOME/config, serves HTTP through nginx, changes nginx configuration, reloads both layers, verifies the backend PID changes, and stops the PM2 application. The first run exposed a configuration mismatch: reload used nginx's default config while startup used the supplied config. Both now pass the same `-c` path. The two existing bootstrap regression fixtures also pass after updating the exact expected argv.

This is a real service-manager test with a minimal HTTP backend. It does not prove the full QingLong backend, database, OS boot integration or first-time online provisioning. Reproduction and isolation details are in test/linux/README.md.

### Released 2.x panel integration

A fresh official QingLong 2.20.1 container passed `test/linux/panel.cjs` on 2026-09-25 (image digest `sha256:4e96d821494cfbeddd29f5a46dfb006a5a64f5639e0b8665816fcf55f39a85ea`). It had no external network, no host port mapping and no user data mount. Random test owner/application credentials authenticated the actual CLI; subscription access and remote task run/log retrieval succeeded. The migrated executeTask used the real installed token generator and local API, returned script exit code 7, and wrote a log path/execution timestamp that the panel API subsequently returned. Reading that log through the public CLI returned the expected native-runner marker. The container and its anonymous data volume were deleted after verification.

The first attempt revealed a fixture assumption: this release logs completion as “执行结束”, not “完成”. The fixture now accepts both completion markers; the rerun used a new uninitialized container. This gate verifies real API/database integration on the named 2.x release. It does not establish every 2.x version, new lifecycle fields absent from older releases, subscriptions that pull remote repositories, or the final installed entrypoint switch. Owner credentials are never printed or used outside this temporary container.

### Earlier incremental runs

On 2026-09-25 Docker Desktop was started and reported Linux aarch64. A disposable `node:18-bookworm-slim` container (Node v18.20.8, image digest `sha256:f9ab18e354e6855ae56ef2b290dd225c1e51a564f87584b9bd21dd651838830e`) ran with external networking disabled and only the CLI directory mounted read-only. These test files passed: cli.test.cjs, subscription.test.cjs, runner.test.cjs, localApi.test.cjs and backendProcesses.test.cjs — 35 tests, zero failures/skips. Loopback mocks still supplied API responses; no real panel was contacted.

The same container then ran verify-package.cjs: offline installation, all five executable help entries and the bundled Skill passed with zero runtime dependencies. That tarball snapshot was 85,832 packed bytes / 338,255 unpacked bytes (documentation differs from the earlier macOS snapshot).

Reproduce after building on the host:

```sh
docker run --rm --network none \
  --mount type=bind,src="$(pwd)/cli",dst=/workspace/cli,readonly \
  --workdir /workspace \
  node:18-bookworm-slim@sha256:f9ab18e354e6855ae56ef2b290dd225c1e51a564f87584b9bd21dd651838830e \
  sh -c 'node --test cli/test/cli.test.cjs cli/test/subscription.test.cjs cli/test/runner.test.cjs cli/test/localApi.test.cjs cli/test/backendProcesses.test.cjs && node cli/scripts/verify-package.cjs'
```

A second container run mounted both cli/ and the unchanged shell/ read-only and ran local.test.cjs plus differential.test.cjs: 40 tests passed with no failures/skips. This exercises real Bash/process groups, hooks, account modes, log routing and the existing old-Shell comparisons on Linux. A separate backendProcesses.test.cjs run passed both mock-selector and live two-instance process tests (2 tests).

Neither these incremental runs nor the full fixture suite establish full deployment acceptance. Package/service fixtures still substitute executables; full panel Alpine/Debian provisioning and OS boot integration, production entrypoint replacement and broader version compatibility remain unverified. Real application authentication and task log persistence now pass on the named 2.20.1 release. Alpine fixture coverage is complete for the current suite; real panel installation remains separate. Original Shell and installed default commands remain unchanged. Docker Desktop remains running; the test container was removed automatically.

### Compatibility entry cancellation

The compatibility and subscription-worker cancellation fixture exercises twelve subprocess runs: config evaluation, extra maintenance, raw through the adapter and raw through the standalone worker, each with SIGINT/SIGTERM/SIGHUP. The raw server deliberately leaves the response pending so cancellation reaches a live curl process. It asserts error JSON, conventional exit codes, paired start/end status (except configuration-stage cancellation, which precedes lifecycle start), final exit_code and disappearance of the config/extra process. Final lifecycle reports are outside the cancellable subprocess scope. This does not yet verify cancellation during a pending local API mutation or rollback after interruption of an upgrade.

After this change, the full macOS suite passed 114 tests with two Linux-only skips (116 total). The isolated Alpine/Node 18 suite passed all 118 tests without skips; its offline package verifier installed all six executable links and the bundled Skill with zero runtime dependencies (93,967 packed bytes / 371,197 unpacked bytes for that snapshot). Both runs completed on 2026-09-25. The unchanged legacy Shell remains available for differential evaluation; no installed entrypoints were replaced.

### Local API and replacement recovery cancellation

Local API fetch now combines the operation signal with its existing 30-second timeout using a Node 18-compatible controller, and removes parent listeners/timers after completion. Fixtures leave either response headers or JSON body pending, cancel a POST, assert exactly one mutation request, then verify the final lifecycle request still succeeds with exit_code 143. Cancellation cannot undo a mutation already accepted by the server; the existing uncertain-result error still instructs checking state before retrying.

Replacement reload now checks cancellation at state boundaries and isolates recovery from the cancelled operation. Tests cover cancellation before stopping (no service actions), after stopping (restart old files), and after the new start reports success (stop new, restore files, restart old). Recovery executes a real Node subprocess to prove the cancelled signal is absent. A separate failure case proves that inability to stop the new service leaves its files and the old backup intact rather than restoring under a running service. These use injected lifecycle callbacks, not an interrupted production upgrade. Filesystem copies finish before the next cancellation checkpoint; atomic cancellation of a copy is not claimed.

Validation on 2026-09-25: full macOS suite 117 passed / two Linux-only skipped (119 total); Alpine Node 18 localApi/operator/compat regression 25 passed, zero skips/failures. Original shell/ and docker/ files remain unchanged.

### Interrupted replacement with real Node and PM2

On 2026-09-25, the services image passed `test/linux/upgrade.test.cjs`: three tests including direct Node and PM2 subtests, zero failures/skips. A forked upgrade process used the real replaceAndReload/startPanel/stopPanel functions. After a new-generation HTTP response, the test sent SIGTERM and verified exit 143, restored old-generation HTTP/file contents, the new PID no longer existed, and backup directories were removed. The fixture pauses at the post-start boundary; this proves real process and filesystem recovery there, not every possible interruption point or database compatibility. The initial fixture run exposed missing event-loop liveness while awaiting a signal and premature HTTP probes after PM2 startup; the fixture now retains its IPC channel and polls HTTP readiness. No product code changed for this gate, and the disposable containers were removed automatically.

### Installed entrypoint gate — failing evidence

On 2026-09-25 the optional `QL_PANEL_ENTRYPOINTS=1` panel fixture temporarily replaced the official 2.20.1 `~/bin/task` and `~/bin/ql` links with Node adapters, restoring the originals in finally. This release creates links in the backend user's home bin via back/loaders/deps.ts; it does not use the current Dockerfile's /usr/local/bin links. The first path probe failed before initialization, then the corrected run used that still-uninitialized container.

The scheduled task and `ql extra` both executed TypeScript and emitted their markers, but the full gate FAILED. The real 2.20.1 crons/status schema rejects exit_code (and has no execution_id field), so final lifecycle reporting failed. Also loggedOperation generated its own extra/... log_path instead of honoring the scheduler's real_log_path, while real_time output was captured in the scheduler's ql/... file. The panel log lookup therefore did not observe completion. This is explicit evidence against declaring installed replacement complete. Fix legacy status capability handling and scheduler log-path reuse before rerunning the gate. The temporary container and anonymous volume were deleted; original source Shell files remain unchanged.

### Installed entrypoint gate — corrected 2.20.1 rerun

The subsequent fresh official 2.20.1 container passed the switched-entrypoint gate on 2026-09-25. API authentication, subscription reads, scheduled TypeScript task execution, scheduled ql extra completion/log lookup and local runner exit 7 all passed. Original ~/bin links were restored, the two fixture log directories contained no reporting-failed messages, and the container/volume were deleted. This proves the named task and maintenance routes through the released scheduler; subscription execution and every other legacy operation are not implied.

Lifecycle payload selection now reads the installed panel package.json: 2.x minor <=20 and unknown/unreadable versions use the base status schema and omit the newer dashboard record request; 2.x minor >=21 uses the extended schema. QL_CLI_LIFECYCLE=legacy|extended explicitly overrides the selection for backports/custom builds. This version mapping follows the inspected 2.20.1 release and current 2.21 source; custom versions can diverge. No mutation is retried for capability discovery. Exit codes remain in local results/logs even when the panel schema cannot store them. Command logs reuse real_log_path and validate containment before writing.

Full macOS regression: 117 passed, two Linux-only skipped (119 total), plus two new lifecycle/path tests passed separately. Synthetic extended-API fixtures now explicitly opt into that contract instead of assuming missing panel metadata denotes a modern server.

### Subscription scheduling integration

The switched-entrypoint panel fixture now creates a file subscription backed by a container-local HTTP server, runs it through ql-cli subscription run, waits for the TypeScript worker result, checks the generated task's sub_id/downloaded contents, and runs that task through the real scheduler. No external repository or notification service is contacted.

The first real run downloaded the script and created its task but then failed because an unconfigured notification channel caused system/notify to reject delivery. The old Shell only logs notification failures. Reconciliation now likewise retains its successful changes and emits a diagnostic; task-list/create/delete failures still fail synchronization. The next run confirmed synchronization success but exposed a test assumption about the paginated task-list response, corrected to data.data. Targeted subscriptionRunner/compat regression passed all 12 tests.

The final fresh 2.20.1 rerun passed on 2026-09-25, returning subscriptionExecution=true together with authentication, switched task/ql extra scheduling and native exit-7 checks. The generated raw task had the correct subscription id, downloaded marker and completed execution log. Entry links were restored by the fixture and all three disposable containers/volumes from this evaluation were removed. This is file/raw subscription coverage; repository subscription branches, dependencies and deletion still require corresponding real-panel gates.

### Repository subscription through the released scheduler

On 2026-09-25 a fresh official 2.20.1 panel passed the expanded switched-entrypoint fixture with repositoryExecution=true. The repository fixture uses a real local file:// Git repository: main contains a wrong-branch script, selected contains two included tasks, an excluded script and a shared dependency. The first pull produced exactly two tasks with the correct subscription ID, omitted wrong/excluded scripts, and a scheduled generated task loaded the copied dependency. After a second commit, the next pull reported one addition/one deletion, kept the unchanged task ID, and removed the obsolete task and script. File/raw subscription, task/maintenance scheduling, auth and local exit-7 checks passed in the same run.

An initial Git-daemon fixture could not start because the official image lacks that executable; it was replaced with a local file transport. Thus this evidence covers repository selection/reconciliation and real panel integration, not network Git, proxy or private-repository authentication. Both temporary containers and anonymous volumes were removed. No product source changed in this turn; the original Shell remains untouched.

### Cron metadata differential correction

A new fixture extracts the unchanged add_cron function from shell/update.sh and compares its API payload with cronMetadata for four scripts: conflicting filename/cron annotations, multiple filename declarations, annotation-only and fallback-only. It first exposed inverted priority, then exposed a regex that consumed // comment markers as a cron field. The TS parser now selects sorted/deduplicated filename-bearing expressions before annotations and requires fields to begin with a digit or asterisk. All eight subscriptionRunner tests passed on macOS. This proves those precedence cases, not arbitrary Perl/JavaScript regex equivalence or every cron grammar extension.
The same eight-test subscriptionRunner suite also passed in isolated Alpine/Node 18, with zero failures/skips, on 2026-09-25.

### POSIX subscription selection

The previous JavaScript RegExp adapter silently interpreted legacy POSIX character classes differently. Repository selection now invokes grep -E with argument arrays and per-operation temporary candidate files, preserving the installed engine/locale. Explicit -e protects option-like patterns. No Shell string is evaluated, output capture is bounded by candidate-list bytes, processes inherit cancellation, and invalid expressions fail before script publication/reconciliation. The matcher rejects line-break paths when filtering. macOS matcher plus subscriptionRunner regression passed nine tests, including legacy character classes, escaping, anchors, option-like patterns, invalid expressions and temporary-file cleanup.
The same nine tests passed in isolated Alpine/Node 18 on 2026-09-25, zero failures/skips. This verifies each platform's installed ERE behavior; locale-dependent classes intentionally remain controlled by that installation.

### Account maintenance through switched ql

On 2026-09-25 the expanded official 2.20.1 gate passed with accountMaintenance=true. The helper invokes the actual replaced ~/bin/ql executable for resetname, resetpwd, resetlet and resettfa. Fresh random credentials (including a password beginning with --) successfully log in after reset. The fixture activates a login retry limit and verifies login rejection before clearing it with resetlet; it then enables twoFactorActivated, verifies password-only login rejection and clears it with resettfa. Each check uses actual panel persistence/authentication, not a mocked request recorder. No credentials are printed. Task, raw/repository subscription, lifecycle/log and exit-7 gates also passed in this run. The original entry links were restored and the disposable container/data volume was deleted. No real user account was changed.

### Full-panel reload exposes deployment integration gap

The new panel-operator.cjs gate invokes the switched ql rmlog 7 and verifies deletion of an old unused file plus retention of an old log referenced by a real task. The first fixture incorrectly attempted to set a different log path with an idle/end status; 2.20.1 intentionally ignores that stale-end update. Using the running/start status correctly establishes the reference, and the retention checks passed on the next fresh instance.

The same instance then ran ql reload against the full installed panel. The command succeeded and /api/system became healthy again. The final gate FAILED: backend startup recreated ~/bin/ql and task as original Shell symlinks. Inspection of back/loaders/deps.ts confirms unconditional linkCommandToDir behavior. Therefore the prior per-session switched-entrypoint tests do not prove persistent deployment replacement. Add explicit implementation selection to the 2.x command-link lifecycle and verify it survives reload; do not touch the independent 3.0 launcher. Both temporary containers/volumes from this evaluation were deleted. No product Shell was modified.

### Persistent 2.x CLI selection

The 2.x command-link loader now honors explicit QL_CLI_ROOT. Its existing default still links original Shell. A selected CLI installs Node wrappers using exact argv forwarding, absolute module paths and atomic per-entry replacement; both module files are validated before replacing either entry. Invalid selection is logged without silently falling back. Source Shell files are retained. GitNexus impact for linkCommandToDir was LOW: one direct caller and three impacted symbols, no indexed affected processes.

Two host loader regressions passed against the actual transpiled back/loaders/deps.ts: repeated selection, both commands/exit 7/exact arguments, paths with spaces, invalid path retention, incomplete package preservation and deselection back to original links. CLI typecheck passed. The isolated official 2.20.1 panel then used only this candidate compiled loader (not a full current backend build), with QL_CLI_ROOT set. All existing auth/task/subscription/account gates passed and operatorMaintenance=true confirmed real log retention, full-panel reload, post-reload ql retention and subsequent account maintenance through that entry. The fixture restored loader/entry files, then the container/volume was deleted. This establishes explicit startup selection on the named release, not automatic production rollout or every platform bootstrap path.
Full host regression after integration: 121 passed, two Linux-only skipped (123 total). Offline installation verified all six executable entries and the bundled Skill with zero runtime npm dependencies; that snapshot was 102,587 packed bytes / 402,598 unpacked bytes. Documentation may change later tarball sizes.

### Help and maintenance locale integration

Registered public/local command summaries, option descriptions, usage/options/default labels now honor QL_LANG=en with Chinese fallback. Command names, flags, choices and JSON keys are unchanged. A coverage test enumerates all registered descriptions so missing Chinese translations fail validation. Subprocess fixtures prove both help surfaces and JSON help work with a nonexistent panel root; maintenance log fixtures verify both languages. Full macOS regression passed 124 tests with two Linux-only skips (126 total). A subsequent footer correction removed the now-inaccurate claim that installed entries always remain unchanged, and the three locale tests passed again. Independent runner/worker/developer help and remaining dynamic diagnostic call sites are still outside this completion claim.

### Standalone help locale completion

All four standalone help entries (task runner, compatibility adapter, subscription worker and developer release) now use the same QL_LANG=en / Chinese-fallback rule as public/local help. The compatibility text describes explicit QL_CLI_ROOT selection rather than incorrectly claiming installed commands can never change. Tests invoke all four entries in both languages from outside the repository with nonexistent panel/config paths, asserting clean help without setup. Full macOS regression passed 125 tests with two Linux-only skips (127 total). This closes help localization; dynamic error/diagnostic localization remains a separate gap.

### Online check/repair on the official panel

On 2026-09-25 a fresh disposable official 2.20.1 ARM64 container ran ql-local-cli check --root /ql --json with actual npm/pnpm and external package access. No user data, host ports or host package directories were mounted. Only the candidate CLI was mounted read-only. Per-command npm_config_registry=https://registry.npmjs.org, npm_config_fetch_retries=0 and npm_config_fetch_timeout=30000 bounded registry retries without altering host settings.

The first run installed global tools (pnpm 8.3.1, PM2, ts-node, TypeScript 5) and the installed panel's production dependencies; the real @whyour/sqlite3 remote native binary install succeeded. PM2 reloaded the full backend. Both panel HTML and backend system probes returned healthy HTTP 200 before/after, and two notification files were copied. PM2 warned that the in-memory daemon was 6.0.14 while the newly installed CLI was 7.0.4; reload succeeded, but this does not prove a daemon upgrade or OS boot registration.

The second run followed controlled damage: append a marker to config.sh and save a byte-for-byte reference, delete task_before.sh, and replace sendNotify.js with a fixture string. verify-check.cjs passed: the hook equals task.sample.sh, config.sh equals the saved reference, both notification files equal current samples, PM2 is selected, and both health probes are healthy. The container and anonymous volume were removed. This gate changes no product code and proves the named online repair workflow; first-time bootstrap, bot connectivity and full panel version upgrades remain separate gates.

### First start without the old container entrypoint

On 2026-09-25 a fresh official 2.20.1 image was started with --entrypoint sleep and infinity, bypassing every original startup script. QL_DIR=/ql and QL_DATA_DIR=/ql/data were explicit, the CLI was mounted read-only, and networking was allowed only for container package installation. The initial TypeScript start installed Alpine nginx and global Node tools, checked Python requests, prepared config, and started the full panel, but failed at pm2 startup because this container has no init system.

The local start command now has an explicit --no-startup option for this deployment case. It skips only OS boot registration, still saves PM2 state, and returns startup=skipped; default host behavior retains pm2 startup and reports failures. Reload/direct-node modes report not-requested. The bootstrap and locale regressions passed seven tests.

A second fresh container, again bypassing the old entrypoint, passed start --no-startup and verify-start.cjs: install mode, configuration templates present, real backend API and panel HTML healthy, panel still uninitialized, and PM2 dump contains qinglong. Alpine package installation and npm global installs were real; Python requests was already present in the image's dependency cache and pip validated it. Both temporary containers/volumes were deleted. This proves first-start orchestration on that installed panel image, not an empty operating system, actual host reboot, or fresh installation of every preinstalled prerequisite.

### Real Linux Bot installation and process isolation

On 2026-09-25 bot-install.cjs passed in a fresh official 2.20.1 ARM64 container with its normal entrypoint bypassed. prepareBot invoked actual apk development-package installation, cloned a local fixture repository and installed colorama==0.4.6 with real pip. A Python -m jbot fixture imported that dependency and emitted its version. A second installation's Python bot ran concurrently. Reinstallation copied an updated repository module, stopped the first PID, started the replacement, preserved custom bot.json, and left the other installation alive. Explicit stop removed only the target bot; cleanup removed both fixture trees/processes and then the container/volume.

This closes the real Linux package-install/process-scope gap for the local Bot workflow. It uses a local fixture bot and does not claim Telegram network/authentication compatibility, behavior of the current external upstream bot repository, or every binary Python dependency. The CLI's responsibility demonstrated here is preparation, configured-repository copying, config preservation and process lifecycle.

### Full-panel version replacement and OverlayFS backup

On 2026-09-25 panel-upgrade.cjs ran against a fresh official ARM64 2.19.0 container with staged source/static files copied from the official 2.20.1 image. It installed target production dependencies using pnpm, then invoked the TypeScript system reload. The first attempt exposed EXDEV when renaming a lower-layer OverlayFS directory, despite source and backup being on the same mount. The previous service restarted and /api/system still reported healthy 2.19.0.

replaceAndReload now falls back only for EXDEV: copy the complete original directory to a unique backup before deleting the target, register that backup for rollback before removal, then install the replacement. Failed backup copying leaves the original intact. A regression injects EXDEV and verifies both successful replacement and restoration after failed service start; all 13 operator tests passed.

A fresh 2.19.0 container then passed the full upgrade fixture: /api/system reported 2.20.1, the original random account logged in, the original scheduled task retained its identity and executed its script, config.sh and .env remained byte-identical, and no retained backups remained. Both evaluation containers and the dedicated staging volume were removed. This proves staged release replacement with real dependencies and database continuity; it does not cover downloading published archives or persistent CLI selection across an upgrade to an unmodified released backend.

Host regression after the OverlayFS fix: 129 tests, 127 passed, two Linux-only skipped, zero failures. Original shell/ and docker/ files remain unchanged.

### Random-delay configuration and dispatch parity

On 2026-09-25 differential fixtures extracted unchanged random_delay, run_normal and main functions from shell/otask.sh. They first reproduced two TS differences: an empty ignored-minute list was converted to minute zero, and ordinary script arguments still triggered delay instead of following legacy run_else. The runner now discards empty minute-list tokens and limits random delay to the legacy single supported-script dispatch. Arbitrary executables bypass delay as before; explicit now already bypassed it.

Tests compare actual TS execution with the extracted Shell logic for unset/empty/whitespace/explicit minute settings at minute zero, bare scripts, ordinary arguments, now and arbitrary executables. Only clock/random/sleep and irrelevant Shell execution adapters are controlled; the legacy decision functions are unchanged. The macOS differential and runner suites passed all 25 tests, including signal cancellation. This does not establish equivalence for arbitrary regex expressions in RandomDelayFileExtensions or Bash arithmetic expressions in minute configuration.

The same 25 tests passed in offline Alpine/Node 18 with no skips. The first Linux attempt exposed a fixture-only /usr/bin/true assumption; using PATH lookup corrected it, followed by successful macOS differential and Alpine combined reruns. Containers were auto-removed. Subscription fallback cron upper bounds were also inspected: original random_range excludes its upper bound, so the existing randomInt(0, 59)/randomInt(0, 23) is consistent and was left unchanged.

### Random-delay extension expressions

The task runner now uses the installed grep -E engine for RandomDelayFileExtensions, preserving the original literal-space substitution, POSIX classes, grouping and invalid-expression behavior. Empty configuration selects every supported script; an unset setting defaults to js. An invalid expression skips delay as the original `if ! grep` did. Patterns are passed as argv data without Shell evaluation. A private temporary directory holds the filename input and is removed in finally; filtering has a bounded timeout and propagates cancellation through the runner's existing AbortError contract.

On 2026-09-25 twelve configurations were compared with the unchanged random_delay function: default matching/nonmatching, empty, multiple suffixes, bracket expression, grouping, POSIX class, whitespace, tab, invalid expression, option-like text and command-substitution-like text. A real task execution additionally verifies ERE selection reaches the delay and then runs the script. macOS differential, runner and filter suites passed 28 tests. This closes the extension-expression gap named above; arbitrary Bash arithmetic expressions in minute settings remain outside this evidence.
The same 28 tests passed without skips in an offline Alpine/Node 18 container, which was automatically removed. Both platforms use their own installed ERE engine; no npm runtime dependency was added.

### Authenticated Git HTTP and proxy transport

On 2026-09-25 networkRepository.test.cjs exercised real Git smart HTTP through git-http-backend, using an isolated local server and random Basic credentials supplied through per-process Git configuration. The direct case and an explicit HTTP proxy case each selected the requested branch, copied the selected script/dependency and omitted the wrong branch's script. The proxy case uses an unresolvable .invalid origin and verifies absolute-form proxy requests plus the actual git-upload-pack POST, so it cannot pass by accessing a local repository or bypassing the proxy.

For both routes, missing authentication and a controlled HTTP 503 each reject synchronization, preserve the previous script and checkout HEAD, and remove all staging files. Automatic task reconciliation is disabled in this transport fixture; existing real-panel gates cover reconciliation separately. This evidence does not establish SSH credentials, HTTPS trust/CONNECT proxies, or a particular third-party Git host's authentication flow.

The fixture passed on macOS and Debian/Node 18. Initial Alpine testing exposed missing git-http-backend in the test image, not a client branch-selection failure. The Alpine test Dockerfile now includes git-daemon, and the fixture explicitly checks this prerequisite before opening its server. Product runtime dependencies are unchanged.
The rebuilt Alpine/Node 18 image also passed the authenticated direct/proxy fixture, with no skip. All test containers were automatically removed.
Full regression on the rebuilt Alpine/Node 18 image passed 137 tests with zero failures/skips. Offline package installation verified all six executable entries and the bundled Skill, with zero runtime npm dependencies (that snapshot: 113,257 packed bytes / 434,495 unpacked bytes). This run includes the recent OverlayFS, bootstrap and random-delay corrections as well as the new Git transport fixture.

### Local lifecycle and subscription warning localization

On 2026-09-25 four previously English-only warnings were connected to QL_LANG: task lifecycle reporting, task statistics reporting, maintenance command lifecycle reporting and subscription notification delivery. The default is Chinese; QL_LANG=en preserves the existing English wording. Command names, structured fields and exit statuses are unchanged.

An execution-level locale fixture injects LocalApi failures, runs a real shell task, writes a maintenance log and synchronizes a real temporary Git repository with task creation. For each language it verifies the actual warning text, a successful task exit and a successful added-task result despite notification failure. macOS locale plus local execution regression passed 39 tests. Remaining argument/API diagnostics are not included in this localization claim.
The five locale tests also passed in an offline Alpine/Node 18 container with no skips; the container was automatically removed. Original Shell and production Docker files remain unchanged.

### Partial multi-directory upgrade failure recovery

On 2026-09-25 an additional replacement fixture forced the OverlayFS EXDEV path for two installation entries. The first entry was fully replaced, then the second failed at one of three points: backup copying after a partial file write (ENOSPC), original-directory removal after deleting a file (EACCES), or replacement copying after a partial file write (ENOSPC). Each case verifies both original versions are restored before recovery start, ancillary files and relative symlinks remain intact, staged input remains available, and backup directories are cleaned. The original injected error is preserved and recovery starts exactly once after the initial stop.

All 17 operator tests passed on macOS and Alpine/Node 18, with zero failures/skips. The container was automatically removed. This adds fault-injection evidence to the earlier actual OverlayFS upgrade gate; it does not simulate physical disk exhaustion, process crash/power loss, or rollback filesystem failure. No product implementation changed in this turn.

### Download-only followed by a separate system reload

A command mapping audit on 2026-09-25 found a missing handoff: stageUpgrade created a random private staging directory, while a later independent reload system searched only legacy fixed directories. The direct update-and-reload path passed because it supplied stage paths explicitly, masking this two-command regression.

After both archives, dependency installation and ready.json succeed, staging now atomically publishes a branch-specific upgrade-ready-<branch>.json containing only the private directory name. Independent reload validates that name, rejects symlink staging roots, and checks ready.json against the exact expected source/static paths before stopping services. Missing records retain the old fixed-directory fallback. Failed later downloads leave the previous complete record untouched. Explicitly supplied staged paths retain their existing behavior.

The archive fixture now performs a successful download, a failed second download, then a separate system reload using the retained record; it verifies installed backend contents and the config sample. Additional cases reject malformed JSON, traversal, absent/incomplete staging and a symlink stage before any service-manager call. macOS operator regression passed 18 tests. These tests use real archive extraction and temporary files with substituted download/service commands; public archive transport remains a separate gate.
The same 18 operator tests passed without skips in offline Alpine/Node 18. Its temporary container was automatically removed; original Shell and production Docker files remain unchanged.

### Undated log retention calendar boundary

On 2026-09-25 the rmlog audit found that TS used the precise mtime for filenames without a YYYY-MM-DD prefix, whereas original Linux rmlog.sh extracts only the modification date before computing age. With a seven-day retention, a log modified on January 1 at 18:00 must be eligible on January 8 at noon under the legacy date-based rule; the previous TS implementation incorrectly retained it until 18:00.

pruneLogs now normalizes both filename dates and fallback modification dates to local midnight. A fixture first reproduced the failure, then passed after the fix. It checks both named/unnamed eligible logs, active-reference protection, API query selection and retention of non-log files. On Linux it also executes the unmodified original rmlog.sh against duplicate files, controlling only the current clock and API/translation helpers. The host boundary test passed. This adopts the Linux calendar-date rule consistently; it does not claim parity with macOS date's implicit time-of-day defaults or invalid calendar-date strings.
The original-Shell comparison and local execution suite passed all 35 tests in offline Alpine/Node 18, with no skips. The temporary container was automatically removed.

### Current footprint and public-module loading boundary

On 2026-09-25 loadingBoundary.test.cjs copied compiled dist outside the repository and inspected each fresh subprocess's actual require.cache. Public help, task help, logout and unauthenticated auth/task/subscription requests load no local operator or backend modules and no external node_modules. Help loads no command/API/config implementation at all; task/subscription invocation is also checked to have actually reached its corresponding command module before authentication rejects it. This complements existing authenticated API tests, not a claim about unexercised branches. Both macOS and Alpine/Node 18 passed. The initial macOS fixture needed realpath normalization for /var versus /private/var; no product change was needed.

Nine-process measurements of current dist (352,255 bytes with source maps): macOS ARM64/Node 24.18.0 empty Node/help medians 69.18/71.38 ms and median peak RSS 44.63/45.78 MiB. Offline Alpine ARM64/Node 18.20.8 empty Node/help medians 20.88/31.15 ms, p95 24.13/35.70 ms, median peak RSS 43.56/44.62 MiB. These are local observations with different OS/Node versions, not performance promises or a direct platform comparison. Packaging verified all six bins and the bundled Skill outside the repository, with zero runtime npm dependencies. Test containers and temporary installs were removed.

### Configuration Shell option handoff

On 2026-09-25 sourceEnvironment was found to transfer variables/functions but omit non-exported Shell option state. It now includes SHELLOPTS and BASHOPTS in the environment snapshot using Bash's standard child-startup mechanism. The bridge's own allexport setting is excluded from SHELLOPTS; BASHOPTS is captured when the installed Bash exposes it. This does not transfer arbitrary traps or restore options unavailable in the child Bash version.

A fixture compares a config-sourced Bash with the bridged environment for pipefail and nullglob, then verifies a real TS task preserves a failing pipeline's exit status. Additional execution cases verify configuration errexit stops the script without an after-hook, and nounset is temporarily disabled during the script then restored for the after-hook, matching the existing task-session contract. These are targeted configuration semantics, not a claim that every legacy product-Shell failure under strict options must be reproduced.

Full host regression after the implementation change passed 142 tests with two Linux-only skips (144 total). The initial Alpine differential/preload/runner subset passed all 32 tests. After adding the explicit errexit/nounset fixture, host differential coverage passed all ten tests. Original product Shell files remain unchanged.
The final ten-test differential suite, including errexit/nounset, also passed on Alpine/Node 18 with zero skips. Both temporary containers were automatically removed.

### Disabled Shell options and later-hook overrides

On 2026-09-25 reverse-option tests confirmed that a later hook can disable previously enabled pipefail/nullglob without mutating the prior environment snapshot; task and after-hook both observe the disabled state. A separate probe exposed a further gap: SHELLOPTS excludes braceexpand after `set +o braceexpand`, but Bash starts with braceexpand enabled anyway. Its standard environment import enables named options without disabling defaults.

Configuration snapshots now retain explicit option lists in QL_CLI_SHELLOPTS/QL_CLI_BASHOPTS. For snapshot-bearing Bash -c calls only, the common subprocess adapter prepends a fixed builtin-only restoration bridge that disables options absent from the snapshot before running the existing command body. Values are compared as data and supplied as builtin arguments; no configuration text is interpolated into the bridge. Non-Bash processes and invocations without snapshots are unchanged. Enabled states still use Bash's standard startup import. The environment bridge's own allexport is excluded as before.

New differential fixtures verify pipefail/nullglob disabling, snapshot isolation, after-hook state, and braceexpand/extquote remaining disabled through another environment capture and actual task execution. Full macOS regression passed 145 tests with two Linux-only skips (147 total). This does not claim arbitrary traps transfer or full equivalence for options a Bash version does not expose. Child Bash processes started independently by user code only receive Bash's standard environment behavior; the explicit restoration applies to CLI-managed Bash bridges.
Alpine/Node 18 differential, preload and runner regression passed all 35 tests without skips; the offline container was automatically removed.

### Bash command-option boundary correction

On 2026-09-25 an adversarial argv fixture exposed that the option-restoration adapter searched for -c anywhere in Bash argv. For `bash script.sh -c value`, this prefixed the restoration bridge to a user argument. The fixture reproduced the corruption before the fix.

Restoration now recognizes only a leading -c after zero or more --noprofile/--norc flags, the forms used by CLI-owned bridges. Script paths, option terminators and other invocation forms stop recognition. Script arguments are untouched. Actual subprocess fixtures cover direct script invocation, -- termination, the profile flags, -o pipefail, empty/space-containing arguments and literal command-substitution text; recognized -c forms additionally retain positional arguments and disabled brace expansion. Arbitrary Bash invocation forms retain their native behavior and standard environment import.

Host Bash-argv/differential/runner suites passed all 31 tests. No original Shell files changed.
The same 31 tests passed without skips in an offline Alpine/Node 18 container, which was automatically removed.

### Data reload on a real mounted directory

On 2026-09-25 mounted-data.test.cjs reproduced EBUSY by running reloadPanel(data) against a disposable tmpfs data root and a real direct Node HTTP backend. The old implementation attempted to rename the volume root itself. Docker forbids that operation even when copying can otherwise cross filesystems.

Data reload now retains the root and replaces its immediate children as one service lifecycle operation. The replacement engine supports deletion entries with no source: it backs them up with the other targets, removes them on success, and restores them if replacement/start fails. Backups stay alongside each child on the data filesystem. Staging and installed data must not contain one another. This retains the existing process-level rollback model; nested mount points and power-loss recovery are not established by this gate.

Host operator regression passed 19 tests, including restoration of a removed old directory and removal of a newly added file before restarting the old service after failed startup. Original Shell and production Docker files remain unchanged.
The expanded offline Alpine mount gate passed both successful replacement and real startup failure: staged data deliberately causes the new Node process to exit 7; rollback restores the previous data, removes the new-only file, restarts the backend and serves the previous value. Mount identity remains unchanged and backups are cleaned. All disposable containers/tmpfs mounts were automatically removed.

### Selected command PATH precedence

A deployment audit on 2026-09-25 found that current Dockerfiles place /usr/local/bin before ~/bin and install legacy ql/task links there. The opt-in backend loader previously created selected TS entries only in ~/bin without adjusting PATH, so panel child processes could still resolve the global Shell commands.

After successful QL_CLI_ROOT installation, linkCommandToDir now prepends its command directory to the panel process PATH and removes duplicate instances of that exact directory. Failed installation does not change PATH, and default unselected startup leaves PATH unchanged. This does not alter a container's global environment or an independent interactive shell. GitNexus reported LOW risk: one direct caller, three affected items, no indexed affected processes.

The actual transpiled 2.x loader fixture first reproduced the failure with deliberately earlier legacy commands. It now invokes ql/task by name through the selected PATH, verifies exact arguments/exit 7, repeated linking without duplicate PATH entries, invalid/incomplete installation retention and return to original links. Both tests passed on macOS and Alpine/Node 18. The Alpine test uses the source loader and actual wrapper installer with mocked root/home/logger configuration; it is not a newly rebuilt full panel image. The current production Dockerfiles still do not package the standalone CLI automatically, so production artifact/bootstrap distribution remains open.

### Opt-in packaged 2.x image

On 2026-09-25 cli/docker/Dockerfile.panel added an explicit derivative image with pinned official 2.20.1 and Node artifact-stage bases. Its narrowly filtered build context copies CLI dist, metadata, docs/Skill and one separately transpiled 2.x loader; it does not include repository dependencies, source/tests or credentials. Eight command links (six package entries plus ql/task) reside under /opt/qinglong-cli/bin. Their env-node shebangs work across base-image interpreter locations. Original Shell files and production Dockerfiles remain unchanged. Version validation handles both package.json and released version.yaml and rejects non-2.x versions.

The first image only added PATH entries. Non-root help/packaging checks and panel API tests passed, but the real scheduled-task parent probe proved it still executed bash /root/bin/task. That exposed the released scheduler/loader contract, so PATH-only packaging was rejected. The revised image includes the existing 2.x selection loader compiled independently by build-panel-loader.cjs; no 3.x build runs. Fresh-panel auth, subscription reads, task execution/log persistence and native exit-7 checks passed again. The panel fixture's switchedEntrypoints=false means it did not rewrite entries at test runtime; deployment selection belongs to the image.
The revised image then passed image-selection.cjs: a scheduled script inspects its real parent argv, which is Node /root/bin/task, and verifies that wrapper loads /opt/qinglong-cli/dist/runner.js. Packaged ql reload returns success, /api/system recovers, and subsequent ql help remains the TS adapter. Both disposable initialized containers and their anonymous volumes were removed. No image was pushed. The base image's original Shell container entrypoint is retained, so this closes an explicit distribution/command-selection path, not the remaining TypeScript container-bootstrap ownership question or other base releases/platforms.

### Released version fallback for lifecycle reporting

On 2026-09-25 the official image's missing package.version exposed the same assumption in runtime lifecycle selection. extendedLifecycle now falls back to a single top-level version.yaml scalar when package metadata has no string version or cannot be read. Explicit QL_CLI_LIFECYCLE overrides remain first, and a present string package version retains precedence. Unknown versions, duplicate release fields and unsupported YAML forms select the conservative legacy protocol. No YAML runtime dependency is added. GitNexus impact was UNKNOWN for this new CLI symbol; its task and operator reporting paths were reviewed directly.

The four lifecycle tests passed on macOS and offline Alpine/Node 18. Coverage includes quoted/commented release scalars, BOM/CRLF, missing metadata, precedence and overrides. Actual task execution and operator execution with captured API calls verify legacy versus extended exit-code fields and task statistics calls. This is payload-contract coverage, not a real 2.21 backend integration claim. The temporary Alpine container was automatically removed. The previously built evaluation image predates this change and must be rebuilt to include it.

### Container environment preparation module

On 2026-09-25 comparison with docker/docker-entrypoint.sh established that host bootstrap alone does not replace container startup. The new containerEnvironment module implements directory access checks with the legacy non-root ownership-repair attempt, a writable HOME fallback under the panel root, Alpine ndots initialization, and IPv4/IPv6 localhost entries. It returns a copied environment and explicit nonfatal network-file warnings. Existing .tmp contents are retained, no permission-probe files are created in the data directory, and individually mounted network files are appended in place. Hostname matching uses complete tokens and ignores comments. Existing writable HOME and configured ndots:0 options are retained. Directory access errors stop preparation before network changes.

Five tests passed on macOS and five passed with UID/GID 65534 in an offline Alpine/Node 18 container, without skips. They exercise real temporary files, inaccessible data permissions, idempotence, missing trailing newlines and IO warnings. The container was removed automatically. The first macOS run exposed a chown argument-order portability issue, which was corrected before final validation. GitNexus impact for the new requireContainerDirectory symbol was UNKNOWN.

This module is not yet wired to a container entrypoint and does not establish startup replacement. Remaining integration must load panel configuration, export service ports, start services and optional hooks, own the foreground scheduler, handle termination/reaping, and verify real panel startup/shutdown. Default Docker entrypoints and original Shell remain unchanged.

### Explicit TypeScript container runtime

On 2026-09-25 container.ts and containerRuntime.ts connected preparation to configuration repair/loading, backend ports, scheduler selection, panel startup, optional hooks, foreground lifetime and shutdown. Scheduler mode is exported before backend launch. System-mode crond runs through the cancellable process-group adapter; unexpected exit, including zero, fails the container. Startup-hook groups receive TERM and bounded KILL escalation; service cleanup runs outside cancelled operation scope, including partial startup failures. Node mode retains a live event loop until cancellation. Docker --init owns orphan reaping. This is an independent opt-in entry, not a change to production Dockerfiles or the image's default entrypoint.

Five runtime tests passed on macOS and five passed in offline Alpine/Node 18 as UID/GID 65534 with --init. They cover configuration-derived service ports, auto-selected real scheduler subprocess argv/TERM handling, scheduler failure, invalid mode, partial startup failure and cancellation during startup. Service operations are injected in these fixtures; optional-hook group cleanup and real host init registration are not established by these tests.

A fresh offline container from the existing 2.20.1 evaluation image, with current CLI mounted read-only, --init and explicit node entrypoint, then started the real panel without the old Shell container entrypoint. /api/system returned 200 before initialization. The existing full-panel fixture passed application authentication, subscription reads, remote task execution/logs and local exit-7/log persistence. It did not exercise subscription execution, account/operator maintenance or rewrite entries at runtime. docker stop completed promptly with exit 143; PM2 logs showed deletion of the panel process, rather than timeout SIGKILL. The stopped container and anonymous data volume were removed. The packaged image still needs rebuilding to include current source; this gate used the current compiled CLI bind mount. Real system-crond scheduling and startup-hook shutdown remain additional integration gates.

### Startup-hook cancellation ownership correction

On 2026-09-25 a real launchStartupHook(extra) fixture exposed that admin.js had no signal cancellation wrapper. TERM killed that supervisor immediately while its separately grouped Bash script survived. The fixture explicitly installs a TERM-ignoring script, records its PID and requires both script and supervisor to be gone after container cleanup; it failed before the fix, with its finalizer removing leaked fixture processes.

The admin entry now establishes cancellation before command/configuration execution. The container waits up to fifteen seconds for the hook supervisor, allowing the subprocess adapter's ten-second escalation to finish first. main accepts the admin signal and reports conventional cancellation codes in JSON, matching the process exit code; public callers omit the signal and retain their loading boundary. GitNexus main impact was LOW (one indexed direct caller, no indexed affected processes); new admin/container symbols were UNKNOWN. Deployment guidance now requires at least thirty seconds Docker stop grace. This proves ordinary extra subprocess-group cleanup, not separately daemonized bot ownership or arbitrary user-created sessions.

After the ownership fix, full macOS regression passed 161 tests with two Linux-only skips (163 total), and all six runtime tests passed in offline Alpine/Node 18 as UID/GID 65534 with --init. The later JSON-code refinement passed all six runtime tests plus the public loading-boundary test on macOS. Public API fixtures initially could not listen under the ordinary sandbox (EPERM); they were rerun with loopback permission. Temporary Linux containers use automatic removal.
The permitted public API rerun passed all seven tests. The final Alpine extra fixture also passed its cancellation JSON assertion (one selected test, five excluded by name), confirming both PID cleanup and code 143 after the refinement.

### Daemonized bot ownership during container shutdown

On 2026-09-25 the Linux container-bot fixture reproduced a remaining leak: launchStartupHook's admin installer had exited successfully while launchBot's detached Python session was still alive; stopping only the former process group could not stop the latter. The pre-fix test reached shutdown and timed out waiting for its Python bot to disappear. Failure finalization killed the fixture processes.

runContainer now records when automatic bot startup is attempted. After installer-group cleanup, it calls the existing Linux stopBot operation scoped by exact data-directory cwd and python -m jbot argv; panel cleanup still runs if bot cleanup fails. The existing SIGKILL stop semantics are retained. No bot stop is requested when automatic startup was not attempted. GitNexus impact for runContainer was UNKNOWN; this change is limited to the explicit container entry.

All seven combined runtime/bot tests passed in an offline Alpine/Node 18 container as UID/GID 65534 with --init. The added fixture executes the real admin installer and Python launcher, waits for installer exit, verifies bot survival before shutdown and disappearance afterward, and confirms another installation's bot remains alive. Package-manager commands are isolated stubs and the module has no Telegram client code. This establishes the bot process's ownership, not arbitrary subprocess daemonization inside third-party bot code. The container was automatically removed; original shell/ and production docker/ still have no diff.

### Real system crond minute-trigger integration

On 2026-09-25 container-cron.cjs added a real minute-tick gate against the TS container entry and official 2.20.1 backend. It creates an every-minute task through LocalApi, verifies an active installed system crontab entry, and waits up to ninety seconds without calling the task run API. The script records its process ancestry; the gate requires crond, the selected Node task entry with verified wrapper/symlink destination, and dist/container.js. Output is retrieved through the panel log API. The finalizer removes the task and script.

Two preliminary mount-based runs failed for fixture reasons. Mounting the entire source cli directory hid image-generated bin links (task not found); mounting local dist preserved links but replaced executable packaged files with non-executable tsc outputs (permission denied). These failures do not establish product regressions. The guide now requires rebuilding the image and mounting only the test directory for this gate.

The offline rebuilt evaluation image sha256:e9d12753bf1118739dce796310123511ce03bdfc63cb45f5f550880ff9bca059 contains current compiled CLI and loader with packaged executable modes. A fresh --init, QL_SCHEDULER=system container using that image passed all four gate assertions: realCrondMinuteTick, tsRunner, persistedLog and tsContainerAncestor. No network, published port, user data mount or Telegram access was used. This validates automatic system scheduling, beyond earlier immediate-run API tests. The image remains local and its default entrypoint remains the original Shell; the test explicitly selects the TS container entry.
docker stop completed promptly with exit 143, running=false and oom=false. All three disposable containers and their anonymous volumes were removed after their respective runs.

### Legacy qinglong startup-name adapter

On 2026-09-25 startup.ts added the missing host-start compatibility entry. qinglong-cli with no positional mode delegates to the shared local start handler; reload maps to start --reload. Root/data/no-startup options retain exact argv boundaries and shared registry validation. Cancellation uses the same operation scope and conventional exit codes as admin. Bilingual help is available without loading local configuration. The private evaluation package now installs seven commands, and the opt-in image adds qinglong alongside ql/task aliases. Original root package.json bin mappings and Shell files remain unchanged; the panel loader still selects only ql/task.

Five host adapter/bootstrap tests passed, including shared-handler forwarding, no-root/invalid-mode rejection before host operations, install/reload ordering and bilingual JSON help. Offline package verification installed all seven entries outside the repository, verified the bundled Skill and zero runtime dependencies; its pre-documentation-update size snapshot was 134270 packed bytes and 512663 unpacked bytes. These entry tests complement existing real bootstrap evidence, not a host-reboot acceptance claim. The rebuilt local image is sha256:dfd4b8add12628c503354ac450fc2298d606d3387854ffb722d400045650710b; no image was pushed.
An offline UID/GID 65534 container verified both qinglong-cli and qinglong execute successfully, return JSON help and resolve to packaged dist/startup.js. The container was automatically removed.

### Packaged Skill entry and permission guidance

On 2026-09-25 the bundled Skill was reconciled with current entry selection. It no longer assumes installed ql/task always use Shell, distinguishes qinglong-cli host startup from ql-cli API management, and preserves existing selection during resource operations. Subscription workflows check subscriptions scope directly instead of requiring crons access first. Authentication guidance distinguishes successful credential exchange from resource permission validation and allows reuse of already supplied environment credentials without exposing them. The actual auth handler's data.url/scopeChecked fields and generated status help were checked against the guidance.

skill-creator quick_validate passed. Offline package verification installed all seven commands, exercised their help and compared the installed Skill byte-for-byte with the source; runtime npm dependencies remain zero. The snapshot before this evaluation-note update was 135284 packed bytes and 515722 unpacked bytes. This checks schema, package contents and executable help, not unrestricted agent behavior. No panel credentials, installed user skills or existing entry selection were changed.

### Shared argument and error diagnostic localization

On 2026-09-25 shared parameter validation and the main error renderer adopted QL_LANG translations. Unknown commands/options, duplicate options, positional arity, missing/invalid named options and integer bounds now use Chinese by default and preserve English under QL_LANG=en. Unknown languages use Chinese fallback. Local-surface help hints now correctly name ql-local-cli instead of ql-cli. Generic configuration failures and signal cancellation messages are also localized; JSON envelopes, stdout/stderr routing and numeric exit codes are unchanged. GitNexus reported LOW for parse/main and UNKNOWN for integer. Other command-specific error sites still require migration.

Actual subprocess diagnostics fixtures cover eight argument-error cases under three language selections, plus generic config evaluation failure in Chinese/English. The real extra cancellation fixture now verifies the localized final message with exit 143. Full host regression passed 165 tests with two Linux-only skips (167 total). The diagnostics and public-module loading suites passed all three tests in offline Alpine/Node 18 as UID/GID 65534. No backend modules or local operators were introduced into public help loading. The temporary container was automatically removed.

### Git HTTPS and CONNECT transport

On 2026-09-25 networkRepository.test.cjs extended its existing real Git HTTP fixture with a TLS server and a real HTTP CONNECT tunnel. A per-test OpenSSL certificate contains an IP SAN and is trusted only through the isolated Git environment's GIT_SSL_CAINFO. Both direct and proxied clones use random Basic credentials, select the requested branch and copy scripts/dependencies. The proxy case additionally requires observed CONNECT traffic. Unauthorized, unavailable and untrusted-certificate attempts must preserve the installed script, checkout HEAD and empty staging directory. No TLS verification is disabled.

Both HTTP and HTTPS test cases passed on macOS. The first Alpine run exposed a missing test prerequisite, openssl; Dockerfile.alpine now installs it alongside git-daemon. After rebuilding the independent test image, both cases passed as UID/GID 65534 with --network none, without skips. Temporary keys, certificates, repositories, proxy sockets and containers were cleaned. This required no product runtime change. It covers authenticated HTTPS and CONNECT plus trust rejection, not SSH, mutual TLS, provider-specific OAuth or every credential-helper configuration.

### Real SSH Git subscription authentication

On 2026-09-25 a separate Dockerfile.ssh and opt-in Linux fixture added real OpenSSH transport validation. A fresh root container creates its own restricted SSH account, host/client keys and Git repository, listens only on loopback, and disables password authentication and forwarding. Both ssh:// and scp-style URLs synchronize through the existing subscription implementation using an isolated GIT_SSH_COMMAND config. Successful key authentication installs the selected script; wrong identity and mismatched pinned host key must reject without changing that script, checkout HEAD or staging cleanup. No user SSH material is mounted, and no external network is enabled.

Initial attempts failed because sshd StrictModes rejected authorized_keys beneath world-writable /tmp. Moving the temporary tree to /var/lib fixed the fixture without weakening permissions or key verification. The resulting test passed all six transport outcomes (two URL forms, each with success and two failure cases). GitNexus fixture impact was UNKNOWN; product runtime was unchanged. The disposable container, local account, keys and repositories were removed. This validates key-based SSH configuration forwarding, not agent forwarding, hardware-backed identities or every external credential helper.

### Published Gitee upgrade archive staging

On 2026-09-25 published-archive.test.cjs added an opt-in gate calling the actual stageUpgrade against published master ZIP URLs. It validates archive paths/modes, extraction, static build/app.js, the 2.x version, readiness marker, stage-selection pointer and preservation of the installed manifest. Dependency installation is intercepted so downloaded code is not executed; this gate does not claim a full upgrade or dependency installation. Its work is cancellation-bounded and staged files are removed afterward.

GitHub direct connectivity timed out in a separate ten-second HEAD probe, and its actual download attempt failed without producing passing archive evidence. Gitee GET succeeded through its HTTPS redirect: both source and static master archives passed on macOS and on Alpine/Node 18 as UID/GID 65534. Both observed release 2.21.0 and identical bytes/hashes: source 819710 bytes, SHA256 d0c6eb093da7f589a4bf896bc491be9f532f13e8b07dae8469554a7465fb5a81; static 11350313 bytes, SHA256 b98f0f4f8a306171c2866471910f06bfb1c7aef31a19541449d25b8c96e41d53. These identify the inspected moving-branch snapshot, not a permanent version pin.

The non-opt-in invocation skips without network access. Host temporary directories were checked absent, and the Linux container was automatically removed. Product runtime and default mirror were unchanged. GitHub's public transport path remains unverified from this environment; Gitee's passing archive gate must not be described as a GitHub pass.

### Authentication and API diagnostic localization

On 2026-09-25 configuration-read errors, URL validation, credential prompts, noninteractive login requirements, login cancellation and token-response validation adopted the existing QL_LANG translator. The shared API client now translates resource-specific permission and uncertain-outcome messages with parameterized templates. It still suppresses raw server/fetch errors and never replays mutations. Numeric HTTP/API statuses, crons/subscriptions scope names and exit-code classification are preserved. GitNexus reported HIGH for request (three direct callers, three affected modules, no indexed processes), disclosed before editing; the other changed functions reported LOW.

New bilingual diagnostics fixtures cover task/subscription permission failures, HTTP 503, transport exceptions, API denial and invalid token expiration, asserting one request per mutation and no credential/URL leakage. Existing network-backed public API/subscription regressions still cover real transport behavior. A stale English-only subscription assertion failed initially and was updated to accept its Chinese equivalent while retaining resource and no-replay checks. The final full host run passed 167 tests with two Linux-only skips (169 total). Four diagnostics/loading-boundary tests passed in an offline Alpine/Node 18 non-root container. Command-specific local operator/runner errors remain to be migrated; this is not a claim that every diagnostic is localized.

### Full non-root Linux regression and runner JSON error correction

On 2026-09-25 the then-current compiled tree passed all 171 tests in Alpine/Node 18 as UID/GID 65534 with --init and --network none, without skips. The same run installed the standalone package offline, exercised all seven command helps and checked bundled Skill equality and zero runtime dependencies. Snapshot sizes were 141874 packed bytes and 531046 unpacked bytes. An initial invocation omitted the required read-only original shell/ mount and failed nine comparison/preload tests; the corrected run retained the original comparisons and passed. Both containers were automatically removed.

A subsequent direct probe exposed that runner --json --unknown-option emitted plain text because JSON mode was assigned only after successful parsing. runnerMain now recognizes an explicit JSON request before parsing failure, while successful parsing still determines whether --json belongs to the script. Tokens after an explicit -- are excluded from the preliminary selection. Runner option, configuration-cancellation and generic failure messages also use QL_LANG. GitNexus impact was UNKNOWN for runnerMain/parseExecution, disclosed before editing.

After that fix, 19 runner/diagnostic tests passed on macOS, followed by a three-test diagnostic run including the added script/terminator boundary regression. All 20 combined runner/diagnostic tests passed on non-root Alpine/Node 18. They verify failure envelopes, plain-text behavior when --json belongs to the script or follows --, and existing native exit/signal behavior. The 171-test full run and package sizes precede this correction; final full-artifact acceptance must use a later build.

### Legacy adapter and worker diagnostics (2026-09-25)

The compatibility adapter and independent subscription worker now translate usage, boolean/arity/SUB_ID validation, interruption and generic failure messages using QL_LANG. Command routing and exit statuses are unchanged. Actual subprocess checks cover both languages and the existing Chinese fallback for unsupported language values, including repo/raw dispatch through the compatibility entry.

The build and five host diagnostic tests passed; the five host compatibility tests also passed. The combined ten tests passed without skips in the disposable Node 18 Alpine image as UID/GID 65534, with Docker init and external networking disabled. Compatibility fixtures exercise loopback raw downloads, logs/lifecycle reporting and SIGINT/SIGTERM/SIGHUP cancellation. They establish cancellation status preservation, not every translated cancellation string.

A new configuration-failure fixture initially assumed all stderr was JSON and failed on both platforms. The existing local contract deliberately forwards user configuration diagnostics to stderr. The corrected assertion preserves that behavior, requires empty stdout and a parseable final JSON error, and checks that the generic error message itself does not incorporate configuration output. Local diagnostics/log streams are not automatically redacted. Remaining operator/context translations and final combined deployment acceptance are still open.

### Shared context and developer entry diagnostics (2026-09-25)

createContext and sourceEnvironment now translate their existing validation and configuration errors using the supplied environment. Error classes/codes, path resolution and configuration interpretation are unchanged. Actual entrypoint tests cover five local entries, four invalid-root cases and both languages (40 subprocess invocations), checking code 2, empty stdout and no filesystem mutation. Real Bash bridge tests cover nonzero configuration exit, early successful exit without environment data, and cancellation after a readiness marker; AbortError/ABORT_ERR are preserved.

The context and existing diagnostics suites passed seven host tests. The shared-context change then passed 74 tests without skips in non-root Node 18 Alpine with --init and --network none, including local execution, original-Shell differential cases, runner cancellation, bootstrap and public loading boundaries.

Developer entry validation and generic fallback diagnostics now use the same language selection. Eight actual invalid-input invocations use an empty PATH and a temporary working directory; they return code 2 without requiring Git or changing files. After this addition, all three context/developer diagnostic tests passed on the host and all seven combined context/release tests passed in the same non-root Linux environment. Release regression writes only disposable local bare repositories and simulates CDN outcomes; no real release occurred. Final full-artifact and deployment acceptance remain outstanding.

### Reproduced language-preloader installation-path failure (2026-09-25)

The existing real-language preload suite was rerun with a temporary installation parent containing spaces. All five languages (JS, MJS, TS, Python source and bytecode) failed the before-hook environment assertion on macOS and on non-root Node 18 Alpine. Account selection, language hook and QLAPI observations were present, and the task itself returned zero, but FROM_SHELL was missing. The reused sitecustomize.js/sitecustomize.py concatenate file_task_before and the script name into Shell command strings without preserving argument boundaries. This is a concrete unresolved replacement defect, not a green compatibility result.

A dedicated opt-in gate is checked in as cli/test/linux/preload-paths.test.cjs. Run with QL_PRELOAD_PATH_INTEGRATION=1; despite its location it also runs on macOS. It invokes the original preload assertions with temporary paths, removes inherited NODE_TEST_CONTEXT so the nested test runner actually executes, requests TAP and requires six reported tests (the parent plus five languages). An initial nested invocation without clearing that environment returned zero without executing the expected tests; it is not counted as evidence. The corrected gate fails on both platforms with the five reproduced hook failures. Temporary installations and the Linux container were removed. Original shell/ files remain unchanged. ESM dependency-resolution coverage has not yet been expanded in this step.

### Language adapter path fix and full regression (2026-09-25)

The runner now materializes packaged Node/Python adapters in a private per-execution directory and links the installed panel's generated modules. Bash receives paths, inline-hook text and exact task argv as separate execFileSync/check_output arguments; the original preload files are retained unchanged. ESM loader registration uses pathToFileURL. The adapters preserve generated-environment loading, language hooks, account selection, QLAPI and preload-environment restoration. Temporary adapter directories are removed by the runner's finally path.

The previously failing installation-path gate now passes on macOS and non-root Node 18 Alpine for JS/MJS/TS/Python/PYC. Additional JS/Python runtime checks cover script names containing quotes, dollar signs and semicolons, literal command-substitution-looking arguments, empty arguments and temporary adapter removal. An initial fixture omitted the installed ESM loader; adding that required panel module made the fixture reflect an actual installation. This does not establish behavior for an incomplete panel deployment.

The focused host run initially passed 56 of 58 tests; the two failures were sandbox EPERM while binding loopback HTTP fixtures. With loopback permission, all 34 local tests passed. The Linux path/preload/runner/differential run passed 36 tests. Finally, the complete non-root Node 18 Alpine CLI suite plus the explicit path gate passed all 179 tests without skips, using --init, --network none and read-only source/original-Shell mounts. Its subsequent offline package install passed all seven executable entries, Skill equality and zero runtime npm dependencies. That snapshot was 150538 packed bytes and 563769 unpacked bytes, before this documentation update. The disposable container was automatically removed; the bounded console log is /tmp/ql-preload-full-regression.log. Original shell/ and production docker/ have no tracked modifications. ESM global dependency coverage and final packaged real-panel deployment remain open.

### ESM global resolution repair (2026-09-25)

A new actual .mjs task fixture reproduced failed global imports with a pnpm root containing spaces, # and %. The previous loader also conflated exported subpaths with filesystem paths. The packaged adapter now writes its own ESM resolver: package-root selection precedes native nextResolve, pathToFileURL preserves literal path characters, and builtin/path/URL/#imports specifiers go directly to Node. Native exports/import conditions are retained rather than reading package.json or reimplementing its resolution rules.

The fixture exercises nine dynamic import outcomes plus builtin imports: global-over-local priority, mapped exported subpath, scoped root/subpath, local fallback, CommonJS default, relative and data URLs, and ERR_PACKAGE_PATH_NOT_EXPORTED for a physically present private file. The scoped package is linked into a pnpm-like store and its entry uses #imports. This fixture passed on macOS and non-root Node 18 Alpine. Eight host language/ESM tests passed before the additional symlink/#imports coverage, followed by a successful rerun of the strengthened ESM test. Ten Linux ESM/language/path/loading-boundary tests then passed with no skips. The same disposable offline container verified installation of all seven package entries and Skill equality; the snapshot was 151720 packed bytes, 569050 unpacked bytes, zero runtime npm dependencies, before this documentation update.

This is local module-resolution evidence using real runtimes and temporary packages, not an npm network-install test or a real-panel deployment gate. The earlier 179-test full run predates this resolver change; final deployment/full-artifact acceptance must include the packaged resolver. Original shell/ files remain unchanged.

### Latest packaged 2.20.1 panel, preload, crond and reload gate (2026-09-25)

Rebuilt the pinned overlay from current CLI output and the isolated 2.x loader: image sha256:2bdce5a8b9d6783783878c32faa4d60d8359f7c671b2fc69ec76d169f60c3803. A fresh container ran the explicit TS entry with --init, --network none, QL_SCHEDULER=system, a thirty-second stop timeout and only the test directory mounted read-only. The backend reported version 2.20.1 and initially uninitialized state. The existing panel gate passed real application authentication, subscription reads, API task execution/logs, native runner exit 7 and persisted task log/status. Its switchedEntrypoints=false denotes that the test-only wrapper replacement was not requested; the image already selected the packaged commands.

The new panel-preload gate scheduled JS/MJS/Python tasks through the panel and checked real Shell hook exports and QLAPI. MJS imported a temporary pnpm-global exported subpath using the packaged resolver. A second passing run invoked ql-local-cli service reload after task creation, verified the stored command survived, and executed all three languages afterward. These are real panel/generated modules, not inert client/notification stubs. A separate minute-tick gate passed actual crond → selected Node task wrapper → TS container ancestry without invoking the run API.

The empty tmpfs used in this run masked image-preinstalled Python requests. Initial Python checks therefore failed QLAPI injection with a concrete missing-requests diagnostic. A no-mount disposable instance confirmed requests exists in the fixed image. Those preinstalled files were copied offline from that image and extracted inside the live tmpfs, then a direct import succeeded and all three-language gates passed. An initial docker-cp-to-tmpfs attempt did not materialize the files and is not considered a successful seed. This qualification matters: the passing result assumes interpreter dependencies are present and does not establish empty-OS provisioning.

The final container stopped with exit 143, OOMKilled=false, empty runtime error and no running PID; health observations immediately before deliberate stop showed HTTP/grpc available after reload. The evaluation and seed containers, anonymous volumes and host temporary dependency copy were removed. No production data, original Shell or production Dockerfiles were changed. Final cross-version combined acceptance, supported host startup/reboot, remaining diagnostics and final full-artifact measurements are still open.

### Real Alpine host installation and kernel reboot (2026-09-25)

A disposable QEMU ARM64 VM was booted with OpenRC using the official Alpine 3.23.6 UEFI/cloud-init image from https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/cloud/alpine-3.23.6-aarch64-uefi-cloudinit-r0.qcow2. SHA512 matched the published checksum: 06888a0fcac4e5a9a5caf61c9a37f83b16110c8a685f9af6be4dae5fb305e796478ea295b76c25a5fac165fcf6cf59572a312958bbdf3e025e749fd5c8d1c1a2. QEMU used HVF, 2 vCPUs, 1 GiB memory, a private sparse 6 GiB disk and SSH forwarded only on 127.0.0.1:22863 with a fixture-only key. The first root-login seed was rejected; the corrected seed uses the documented alpine cloud user and a guest-only doas fixture rule. The first VM was shut down before its disposable overlay was replaced.

The guest started with no panel/service tooling. Node/npm/Python/pip and Bash were provided as prerequisite interpreters; versions were Node 24.18.1 and Python 3.12.14. An initial invocation before Bash was installed failed at the user-configuration bridge; this shared prerequisite with the old Bash start.sh is not an automatic-bootstrap success. The uninitialized pinned 2.20.1 panel distribution and latest packaged CLI were copied from the already-tested image. No old startup script was executed. The current TS admin start then actually installed OS packages, global pnpm/PM2/TS tools and Python requests, started nginx and the panel, registered /etc/init.d/pm2 in OpenRC's default runlevel and saved the PM2 process list. Its JSON result reported startup=registered and mode=install.

The new host-boot.cjs gate created a task and recorded boot ID eb70feaa-f0bc-4caa-ab43-df0d6f8d479f. After an actual guest reboot, OpenRC reported pm2 started, the kernel boot ID changed to 451ca7d6-f80a-440c-82f9-6f92c6c544e9, the 2.20.1 panel became available without manual service startup, and the retained task executed through the panel API with its expected log. The test removed its task, script and state file. This proves real host PM2 registration/recovery and task retention, not just fixture command dispatch.

The broader service check found a remaining concrete gap: both nginx and crond were stopped after reboot, while the direct panel HTTP endpoint returned 200. The current migrated bootstrap (like the original start.sh) registers only PM2. Do not describe this result as complete host service/scheduled-task recovery. The next host fix must address enabled host services while retaining --no-startup container behavior. The VM was powered off after the checks; its isolated disk, key and bounded logs remain under /tmp/ql-host-boot-20260925 for the follow-up fix/retest, not as a running service. The authoritative start log is start.log and the current seed configuration is seed/user-data; no production or host boot settings were changed.

### Host service registration repair and cron PATH gap (2026-09-25)

bootstrapPanel now calls a dedicated host-services registrar only for normal host startup registration. OpenRC enables nginx/crond and starts crond; Debian/Ubuntu systemd installs cron if needed, enables nginx and enables/starts cron. nginx remains started/reloaded by the existing bootstrap stage. An initial implementation tried to start nginx a second time through OpenRC and failed against the already-running unmanaged PID; the final implementation registers it for the next boot without a duplicate start. Unknown init and command failures propagate. The systemd path has command/failure fixtures only, not a real Debian/Ubuntu reboot result.

Six focused host tests passed. The final Node 18 Alpine non-root/offline full suite plus the explicit preload-path gate passed 183 tests, no skips/failures. Offline package/Skill verification passed seven entries with zero runtime npm dependencies; the pre-documentation snapshot was 155909 packed bytes and 581298 unpacked bytes. Log: /tmp/ql-host-services-regression.log. An earlier 14-test startup/container run predates the final duplicate-start correction and is not evidence for that correction.

The saved Alpine VM was restarted and updated with the current built CLI. Actual full start completed with startup=registered (log: /tmp/ql-host-boot-20260925/start-services-final.log). Before the next reboot, nginx's PID and crond were running. After the real reboot, OpenRC reported nginx, crond and PM2 all started automatically. This closes the missing-service registration defect, but the strengthened automatic-minute gate failed: root crontab invokes bare `task`, the selected wrapper exists at /root/bin/task, and no /usr/local/bin/task exists in this distribution-based host installation. The init-started cron daemon does not inherit the panel's PATH that selects ~/bin. No post-reboot task log containing the new kernel boot ID appeared within ninety seconds. No run API was called to mask this failure.

Next work is to propagate the selected command path into host scheduling without overwriting preserved original Shell entrypoints, and rerun the same real reboot/minute gate. The VM was powered off with its failing fixture task/state and isolated disk retained under /tmp/ql-host-boot-20260925. This is not complete host scheduling acceptance; command fixtures and a live cron process alone cannot establish task execution.


### Host cron bridge and automatic reboot recovery (2026-09-25)

The opt-in 2.x command loader now installs a CLI-owned crontab bridge alongside its ql/task wrappers. Only installation of the configured panel crontab file is transformed; the original file remains unchanged. The private submitted copy adds a whitelisted environment export to scheduled commands. Reads through the bridge strip only its managed additions; native option failures and unrelated tables pass through. Deselecting the CLI removes its owned bridge and preserves unrelated commands. The native BusyBox applet path must remain crontab, rather than resolving its symlink to busybox.

The first generic environment-header implementation passed the native-utility fixture but failed the actual ninety-second minute gate. BusyBox cron does not support arbitrary environment headers and retains quote characters in PATH values. The replacement uses shell-quoted per-command exports, tested with spaces, embedded quotes and literal command-substitution text. Newline/NUL/percent in captured paths is rejected before changing the installed table. No credential values are captured. Comments and original task arguments survive reads unchanged.

The corrected bridge passed the retained task gate in boot 34043d64-4fd8-4545-bb7a-e7b2d56b2ff7. A fresh task was then created and the guest actually rebooted. Boot ID changed to 0355db6b-0a84-4cab-a8d8-58a2cf37c053; host-boot.cjs after passed with automaticPanelStartup, taskRetained, taskExecuted, nginxStarted, crondStarted and automaticMinuteTick all true against panel 2.20.1. No task-run API was called after reboot. The fixture deleted its task/script/state. The source CLI and loader were updated within the isolated guest; the older evaluation image has not been rebuilt with this bridge and is not evidence for the final packaged artifact.

TypeScript build and the three macOS bridge/loader checks passed; after adding deselection/unrelated-command assertions both loader checks passed again. Node 18 Alpine, non-root, network disabled: all seven bridge/bootstrap/host-service tests passed with no skips. These focused checks do not replace the final full-suite and same-artifact packaging acceptance. Debian/Ubuntu still has fixture-only service-registration coverage, not a real reboot result.


### Current cron-bridge regression and real startup alias (2026-09-25)

The current candidate passed the complete top-level suite in both existing pinned Node 18 test images, each with --init, non-root UID/GID 65534, network disabled and read-only CLI/original Shell mounts: 183 tests passed, zero failures/skips per platform. Logs: /tmp/ql-cron-bridge-full-regression.log (Alpine) and /tmp/ql-cron-bridge-debian-regression.log (Debian). These commands run test/*.test.cjs; separate test/linux gates are not implicitly included. Both runs subsequently passed standalone offline package verification with seven entries and zero runtime npm dependencies. The snapshots measured 160815/599614 packed/unpacked bytes on Alpine and 160941/600086 on Debian; documentation changed between packaging runs, so these are distinct documentation snapshots, not byte-identical final release artifacts.

On macOS ARM64 Node 24.18.0, benchmark.cjs measured nine fresh-process samples: baseline median 100.03 ms, help median 108.18 ms, incremental median 8.15 ms; median peak RSS 44.73 versus 46.02 MiB (increment 1.29 MiB). Built dist including source maps was 434101 bytes. Concurrent VM/container activity can affect these observations; they describe this host/run, not a platform-wide performance guarantee.

The isolated Alpine VM was started again. Its actual /opt/qinglong-cli/bin/qinglong symlink targets ../dist/startup.js. With the selected installation environment, qinglong reload --json completed with mode=reload/startup=not-requested. Calling qinglong --json without a positional mode completed the real installation/bootstrap path with mode=install/startup=registered and PM2. stdout was independently captured as one valid JSON envelope in /tmp/ql-host-boot-20260925/start-alias-result.json; package/service diagnostics went to start-alias.log. This was an already provisioned fixture installation, not a second clean-OS test. OpenRC reported nginx, crond and pm2 started. A direct HTTP verification then required actual panel 2.20.1 system response, web root HTML, and saved qinglong PM2 state; all passed. An attempted local status command was correctly rejected as unknown; no such public/operator command is claimed. Original Shell/production Docker remain untouched.

The VM was powered off after the alias verification. Combined final image rebuild/retained-data deployment, actual Debian/Ubuntu reboot, remaining localized diagnostics and final artifact/Skill checks remain open; these results do not close the overall migration goal.


### Upgrade/operator/cron diagnostic localization (2026-09-25)

Eighteen fixed diagnostic messages in upgrade validation/replacement, direct backend stop and the selected crontab bridge now use the existing Chinese-default/QL_LANG=en translation mechanism. Recursive upgrade-tree validation carries the operation environment rather than reading global process state. The installed cron bridge retains its installation language as a fallback and honors an explicit invocation QL_LANG; it does not capture credential environment values. Error codes, underlying cause on failed rollback restart, native crontab stderr/status and filesystem operations are unchanged.

Six new execution tests cover Chinese, English and unsupported-language fallback, rejecting an invalid upgrade pointer/external symlink before replacement, restored old files when both new and recovery startup fail, and installed cron-wrapper failure without leaking its invalid path value. They also verify caller language override, non-invocation of the native cron utility on invalid environment, refusal to replace unrelated commands and absolute-path validation. Existing operator tests explicitly select English where assertions intentionally inspect English diagnostics.

The TypeScript build passed. The first local test invocation passed 33/36; three operator cases hit host sandbox EPERM for ps/process inspection or loopback listen. They were not counted as passing or suppressed. The same complete targeted group then ran in the pinned Node 18 Alpine container with --init, UID/GID 65534, network disabled and read-only CLI/Shell mounts: 36 passed, zero failures/skips. Log: /tmp/ql-operator-localization-regression.log. This includes rollback/fault tests, existing help and CLI JSON diagnostics, plus the new localized failure tests. The earlier 183-test full-platform runs predate this change.

Localization remains incomplete in task execution, subscription filters, Bot, bootstrap/container setup and several helper validation errors. These remaining paths still require execution-based language checks; this entry does not declare the overall diagnostic or migration requirement complete.


### Task validation diagnostics through the real runner (2026-09-25)

All six explicit taskRunner validation failures now use the operation language: missing executable, malformed/out-of-range account selection, missing/invalid account variable, malformed duration and unsupported duration range. The account and duration helpers accept an explicit environment and retain default process-environment selection for independent callers; executeTask passes its own environment. Parsing, valid account ordering, timeout units and exit codes are unchanged.

Three language tests exercise Chinese, English and unsupported-language Chinese fallback. Each invokes the actual runner process for five invalid cases, requires exit 2, empty stdout and the localized final stderr JSON, and verifies that the target executable did not create its marker file. Direct empty-argv rejection, valid reverse account selection and fractional-minute parsing are also checked. These three tests passed locally. The pinned Node 18 Alpine non-root/offline runtime then passed 66 tests, no failures/skips, across taskDiagnostics, local, differential and runner suites, including retained original Shell comparisons and existing process timeout/cancellation coverage. Log: /tmp/ql-task-localization-regression.log. This is a task-focused regression, not a new final package/deployment certification.


### Subscription filtering and Bot diagnostics (2026-09-25)

The three subscription-filter errors and eight Bot validation/startup errors now honor operation QL_LANG with Chinese fallback. POSIX matching, native grep error classification, temporary-list cleanup, package selection and process/file operations remain unchanged. Recursive Bot tree validation carries the same explicit environment as its caller. OS names and process exit statuses use translation placeholders; native tool stderr is retained rather than misrepresented as translated CLI text.

Filter execution tests cover Chinese/English/unsupported language, real grep invalid-expression errors, unsafe path rejection, a controlled native failure exit 7, and absence of leftover temporary lists or leaked path text. Bot tests exercise all three language modes through local repository preparation, external-link and non-regular-template rejection, preserved user configuration, staged-directory cleanup and an actual failing interpreter stub returning 9. Existing local repository, rollback and startup-failure tests continue to pass. No Telegram endpoint or production service is contacted.

Build and 12 focused macOS tests passed. The pinned Node 18 Alpine non-root/offline run passed 16 tests with no failures/skips across bot, subscriptionFilter, subscription and the Linux container-bot gate. The latter verifies shutdown of the owned daemonized fixture Bot while preserving another installation's process. Log: /tmp/ql-bot-filter-localization-regression.log. Bootstrap/container/helper diagnostics and final full-artifact deployment validation remain open.


### Bootstrap and container diagnostic localization (2026-09-25)

Eight bootstrap/container diagnostics now use operation-language translation: unsupported OS, invalid Python version, startup data-directory boundary, absolute container paths, inaccessible mounted directories, network-file initialization warnings, invalid scheduler mode and unexpected scheduler exit. Recursive/preparation helpers receive the caller environment; numeric codes, path/UID details and underlying filesystem error codes remain in their messages. No package/service, permission-repair or shutdown algorithm changed.

Nine new tests cover Chinese, English and unsupported-language fallback for invalid bootstrap inputs, container preflight/network warnings and scheduler failures. Invalid OS/data-directory inputs leave the temporary root empty; invalid scheduler starts no service; a real foreground scheduler stub exiting 7 triggers service cleanup. The tests also preserve data under the mounted-directory fixture and require expected error exit codes. Existing tests retain coverage for service order, non-root inaccessible directories, cancellation and extra-hook subprocess escalation.

Build passed. The focused macOS run passed 23 tests; the pinned Node 18 Alpine non-root/offline run added hostServices and passed 26 tests, zero failures/skips. Log: /tmp/ql-startup-localization-regression.log. These are runtime fixtures, not an additional real Debian/systemd reboot test. Remaining helper/developer diagnostics and final whole-artifact acceptance are still open.


### Helper diagnostics and full localization regression (2026-09-25)

Five helper/entry diagnostics now use the existing localization mechanism: invalid log directory, invalid QlPort, invalid CLI installation paths, non-file CLI entries and generated wrapper invocation failures. Entry installation accepts an explicit language environment for validation, while generated ql/task wrappers select their invocation language at runtime. The fallback excludes private exception details and preserves exit 1.

Five focused helper/loader tests passed locally. Three language cases check that invalid log actions never call the operation, invalid port/log checks create no files, invalid installation preserves the existing ql command, and both generated wrappers return localized stderr with empty stdout. The existing loader selection and restoration checks also pass.

The first complete Alpine run reported 208/210 passed: one Linux backend-stop test still assumed English after the preceding operator localization; its subtest and parent each counted as a failure. The observed refusal to restart was correct. The test now explicitly requests English. The complete retry in pinned Node 18 Alpine, UID/GID 65534, --init, network disabled and read-only CLI/original Shell mounts passed 210 tests with zero failures/skips. The offline verifier then passed all seven package entries with zero runtime npm dependencies. Snapshot size before this documentation update: 166986 packed bytes, 620782 unpacked bytes. Logs: /tmp/ql-localization-full-regression.log and /tmp/ql-localization-full-regression-final.log. The successful run includes every top-level test file; separate opt-in Linux deployment gates are not implied.

Remaining localization work includes generic subprocess/path-boundary helpers and developer release validation. A new full Debian run and final same-artifact real deployment remain required after source changes conclude; this full Alpine pass does not certify overall completion.


### Shared subprocess diagnostics (2026-09-25)

The four common subprocess diagnostics now use the supplied process environment's QL_LANG, falling back to the current process environment only when no environment was supplied: spawn failure, fallback output-sink failure, bounded-capture overflow and nonzero checked-process status. Arguments are not copied into the diagnostic. Caller-provided sink errors retain their original identity. Signal, timeout, output routing and process-group cleanup logic are unchanged.

Three new runtime tests cover Chinese/English/unsupported-language fallback. They run actual failing children, check exit 7 is reported with CLI error code 1 without echoing a private argument, confirm overflow and falsy sink exceptions terminate/reap the writer PID, and verify a caller Error is rethrown unchanged. The focused local run passed all three tests.

The pinned Node 18 Alpine non-root/offline full suite passed 213 tests, zero failures/skips. Offline independent package verification again passed all seven entries with zero runtime npm dependencies. Snapshot before this documentation update: 167775 packed bytes, 623908 unpacked bytes. Log: /tmp/ql-process-localization-full.log. Existing matching assertions accept either supported diagnostic language; separate new tests assert each locale explicitly. Path-boundary and developer-release diagnostics remain open, as do final Debian and same-artifact deployment/Skill acceptance.


### Developer release diagnostics (2026-09-25)

Seven release-validation errors, three CDN diagnostics and four human-readable plan steps now honor the release operation environment's QL_LANG with Chinese fallback. The CDN subprocess receives fixed translated text via JSON string serialization; no credential values are inserted into messages. Release refs, leases, atomic push, upload order and timeout values are unchanged.

Three added language cases use disposable local source/bare Git repositories and fixture SDK modules. They check invalid root/remote/branch, localized plan steps, stale-commit rejection before upload, missing CDN credentials and rejection responses, dirty worktree/version validation, and unchanged remote refs after failed validation/upload. Existing tests additionally exercise successful scoped refs, CDN failure and concurrent remote updates. No production remote or CDN is contacted. The translated timeout text retains its existing sixty-second behavior; the new tests do not wait through that timeout.

Build and all seven local release tests passed. The pinned Node 18 Alpine non-root/offline release plus CLI diagnostics run passed 12 tests with zero failures/skips. Log: /tmp/ql-release-localization-regression.log. Path-boundary diagnostics and the final complete artifact/deployment audit remain open; this result does not claim a live release or complete migration.


### Path-boundary language propagation and subscription validation (2026-09-25)

The managed-path helper now accepts the operation environment. Every production caller in task logging, command logging and subscription reconciliation/sync passes its context environment, preserving the existing lexical descendant rule. Repository-name, raw-protocol and invalid reconciliation-list errors also use that environment. No path-resolution, download, file publication or API ordering changed.

Three language tests verify allowed descendants, rejection of the managed root/parent/outside paths, no operation/files for invalid task or command log paths, invalid repository names and raw protocols, and no mutating API calls after an invalid task-list response. The last scenario uses a controlled download and API fixture; downloading/publishing a raw file still precedes reconciliation as before, so it does not claim file rollback on an API response error.

Build and three local language tests passed. An initial Linux command named a nonexistent repository.test.cjs and ran no suite; the corrected command uses subscriptionRunner.test.cjs. In pinned Node 18 Alpine non-root/offline, pathDiagnostics, subscriptionRunner and local suites passed 45 tests, no failures/skips. Log: /tmp/ql-path-localization-regression.log. This includes existing real local Git/HTTP transport and task execution checks.

A subsequent source scan identified remaining fixed-English diagnostics in local API credentials/responses, public task/subscription response validation, task delay and direct-backend startup; they were not covered by earlier localization completion assumptions. They remain explicit work alongside final same-artifact deployment acceptance. Original Shell and production Docker files remain unchanged.


### API/resource responses and final discovered diagnostics (2026-09-25)

Five local API messages and eight public resource-response/operation messages now use the appropriate operation or CLI environment. Local token/port errors retain exit codes 3/2; request/envelope errors retain code 1. The pre-existing local API catch still maps HTTP failures to the bounded no-retry diagnostic; this change does not expose server bodies or introduce retries. Public task/subscription malformed-data checks keep their projection/validation rules.

Six added language cases exercise actual local HTTP requests and compiled public CLI child processes. They cover missing local token after a no-op token generator, invalid port before HTTP, one PUT per failed request, hidden secret inputs/server bodies, and six malformed task/subscription response shapes with stderr JSON/empty stdout. The pinned Node 18 Alpine non-root/offline localApi/cli/subscription run passed 24 tests with no failures/skips. Log: /tmp/ql-api-localization-regression.log.

The remaining three delay/backend-start diagnostics were translated without changing AbortError/ABORT_ERR cancellation classification, exit statuses or process control. Added three-language tests execute a failing grep fixture and a real immediate-exit Node backend. The delay/backendProcesses Linux run passed 14 tests, no failures/skips (log: /tmp/ql-start-delay-localization-regression.log), including existing stop/port-handoff and Shell delay comparisons.

A TypeScript AST scan of literal/template arguments to fail, Error and CliError found one remaining user-visible literal in the top-level container entry and an internal request timeout abort reason. The container argument diagnostic was translated; all six local diagnostics tests passed, including three-language actual container-entry failure before installation access. The internal timeout reason remains an implementation detail consumed by the already-localized request failure handling. Native OS/tool errors, user hook output and task logs remain native; they are not translated as CLI-owned messages. This scan is bounded to error construction and does not replace final whole-artifact usability/Skill/deployment validation.

Final build and diff whitespace checks passed. The previous full Alpine run predates these changes; final cross-platform full suites, package/Skill validation and same-artifact deployment are still required. No production deployment, release or original Shell edits occurred.


### Fixed-source cross-platform and packaged panel acceptance (2026-09-25)

After rebuilding the standalone CLI and separate 2.x loader, source/build output was held fixed throughout this run. Pinned Node 18 Debian and Alpine non-root/offline full suites each passed 232 tests with zero failures/skips. Each then passed independent offline installation of all seven commands plus packaged Skill with zero runtime npm dependencies. Both package snapshots were identical in size: 171855 packed bytes, 639866 unpacked bytes. Logs: /tmp/ql-final-diagnostics-debian.log and /tmp/ql-final-diagnostics-alpine.log. These are top-level suites; opt-in deployment tests remain separate.

The rebuilt opt-in panel image is sha256:56b107a9d5825c381e82ac0a669b498d52c716ecbfc04ad9014d0ebf3ead99d2, based on the pinned official 2.20.1 base. Docker reported no captured Git commit metadata because CLI files remain untracked; do not substitute a commit identifier for this image digest. A fresh disposable container ran the TS container entry with --init, system scheduler, no network or published ports, a seeded image data volume, a 30-second stop timeout and only the test directory mounted. No live dist/source overlay or dependency repair was used.

In that same container, panel.cjs passed actual application authentication, subscription reads, task execution/logs and local runner persisted status. panel-preload.cjs with its reload gate passed retained tasks after actual PM2 reload, JS/MJS/Python scheduling, Shell hook exports, real QLAPI and the ESM global exported subpath. Finally container-cron.cjs passed a natural minute tick without a run API call; process ancestry included real crond, the selected TS task entry and the TS container entry. Logs: /tmp/ql-final-panel-api.log, /tmp/ql-final-panel-preload.log, /tmp/ql-final-panel-cron.log. Normal stop returned exit 143, OOMKilled=false, Running=false; container and anonymous volume were removed. The image remains local for follow-up gates and was not published.

Skill Creator's quick validator passed the current bundled Skill; offline package checks also confirm its inclusion. This is structural and instruction review evidence, not a guarantee of arbitrary agent behavior. Current macOS ARM64 Node 24.18.0 nine-process benchmark: baseline median 68.89 ms, public help 76.8 ms (increment 7.91 ms), median peak RSS 44.67 vs 46.11 MiB (increment 1.44 MiB), built dist including source maps 454522 bytes. These are host-specific observations, not universal performance limits.

This closes the current-source packaged 2.20.1 auth/preload/reload/cron/shutdown gate and full Linux regression snapshot. Remaining overall acceptance includes real Debian/Ubuntu host boot, final cross-version upgrade against the current artifact, unresolved archive transport/credential/configuration cases and final requirement-by-requirement audit. Documentation added after the run changes package bytes but not the tested executable artifact; the image digest above remains the deployment evidence.


### Current-artifact cross-version upgrade exposes two gaps (2026-09-25)

A new 2.19.0 opt-in image was built with the current CLI/loader using official base digest sha256:42b7937fd0230142420a98259f79639cb38521982fcef1b2445db6cdd6e3ed75. A disposable stage volume, ql-upgrade-final-stage, received source and static files copied directly from the cached official 2.20.1 image. Unlike the prior archive-shaped fixture, this image-shaped source includes .env. The fresh 2.19 container used the TS container entry, no published ports and the selected CLI. Before upgrade, /root/bin/task was confirmed to contain the TS runner wrapper.

panel-upgrade.cjs installed real target production dependencies and upgraded the running panel to 2.20.1. Account login, task identity and config.sh preservation checks reached their assertions successfully, but the next assertion failed: .env differed because reloadPanel treated a payload .env as a product file. Log: /tmp/ql-final-upgrade.log. This is a failed full gate, not a passed upgrade result. A separate read-only inspection confirmed the second gap: /root/bin/task became a symlink to /ql/shell/task.sh, because replacing static with the unmodified official loader discarded explicit CLI selection. Version change alone does not establish a successful CLI migration.

The dotenv overwrite is repaired by excluding .env from system replacement, alongside other installation-owned state. A regression with a conflicting staged dotenv verifies unchanged original bytes, inode and mode 0600 while package files are upgraded. Build and all 20 operator/rollback tests passed in non-root offline Alpine; log: /tmp/ql-upgrade-dotenv-regression.log. This focused fix has not yet been revalidated through the full real cross-version gate.

The test container and its anonymous data volume were stopped/removed. The dedicated ql-upgrade-final-stage volume remains as an isolated staged fixture with installed target dependencies for the next rerun; it contains no production data and no running service. The selected-entry loss still requires an implementation and regression before final current-artifact upgrade acceptance. The earlier final 2.20.1 image and 232-test snapshot predate the dotenv fix and remain scoped to their recorded artifact.


### Cross-version selection, dotenv and port preservation (2026-09-25)

Selected upgrades now snapshot the installed opt-in 2.x command loader and apply it after the incoming static payload, in the same rollback transaction. New backend files replace the old ones; downloaded source/static remain unchanged. A verified 2.x payload and recognized selected loader are required before stopping the service. Unit regressions cover successful selection retention, reverse rollback after startup failure, and rejection of unknown loaders/3.x targets.

The first selected-loader rerun preserved the TS task wrapper but failed the API check: retaining the original 2.19 dotenv also retained BACK_PORT=5600. Container startup supplied a 5700 override, while a fresh administrative restart did not. Inspection confirmed 2.20.1 served port 5600 and port 5700 refused connections. Log: /tmp/ql-upgrade-selection-panel.log. startPanel now supplies BACK_PORT from QlPort (default 5700) and GRPC_PORT from QlGrpcPort (default 5500), matching container startup for both PM2 and direct Node. It does not mutate caller environment or dotenv. The regression covers defaults and explicit custom ports.

After rebuilding the 2.19 overlay, a fresh isolated container passed panel-upgrade.cjs against the unchanged official 2.20.1 stage: original account login, task identity and execution, config.sh and dotenv bytes, selected ql/task wrappers, empty retained-backup list and API continuity on 5700 all passed. Log: /tmp/ql-upgrade-port-panel.log. Non-root offline Alpine startup, backend-process, container-runtime, operator and selection suites passed 41 tests with zero failures/skips; /tmp/ql-upgrade-port-linux.log. A preliminary macOS sandbox run could not execute ps/bind loopback (EPERM); it is not counted as passing evidence.

This verifies the particular official 2.19 → 2.20.1 transition. Keeping the explicitly selected loader is a 2.x compatibility integration, not proof of compatibility with every future backend release. The earlier 232-test/image snapshot predates these fixes.

The same upgraded container also passed container-cron.cjs on a natural minute tick, with no run API call: real crond, selected TS runner, persisted log and TS container ancestry were all confirmed (/tmp/ql-upgrade-port-cron.log). The complete current-source offline/non-root Alpine suite passed 237 tests with zero failures/skips (/tmp/ql-upgrade-full-alpine.log). The upgraded container and its anonymous data volume were stopped/removed, and the dedicated ql-upgrade-final-stage volume was removed. No fixture services remain from this upgrade gate.


### Real Debian 12 systemd provisioning and reboot (2026-09-25)

A separate QEMU/HVF ARM64 guest used the official Debian bookworm genericcloud image from https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-arm64.qcow2. Its SHA512 matched the downloaded official SHA512SUMS: 89a752d5c7d8e88bee39a57d88d496cca574f7d1e8df5df7a169825435f99feb11ed13ab27ec7bee96fe1584be4ff9479358fbca6cc859efa109f4aba18724c8. The overlay disk, unique SSH key and NoCloud seed are isolated under /tmp/ql-debian-boot-20260925. QEMU exposed SSH only on 127.0.0.1:22864, with 2 CPUs/1536 MiB and an 8 GiB overlay. No host service configuration was altered.

The fixture provisioned Node 18.20.4/npm, Python 3.11.2/pip and build tools before invoking the migrated startup. It copied the existing official 2.20.1 distribution fixture and current CLI/selected loader. Alpine native node_modules were removed and production dependencies installed for Debian/glibc. A pre-existing correct qinglong symlink caused an initial fixture ln command to report EEXIST; its ../dist/startup.js target was verified before continuing. This was fixture setup, not a failed product start.

The actual qinglong --json invocation then installed its real OS/global/Python packages, prepared configuration, started nginx/PM2 and registered nginx/cron/pm2-root through systemd. Its independently captured JSON had code=200, mode=install, os=debian, startup=registered and manager=pm2. Logs: prerequisites.log, install-panel.log and before.log in the fixture directory. This validates startup orchestration with prerequisite interpreters, not installation of those interpreters by the CLI itself.

host-boot.cjs now selects service checks by /etc/os-release: systemctl is-active with cron on Debian/Ubuntu, and rc-service with crond on Alpine; it uses the distribution's nginx PID file. Before reboot the gate created a retained minute task on panel 2.20.1 and recorded boot ID 821b05b9-add2-4701-a55b-61204919cb9c. After actual systemctl reboot, boot ID was 89893a77-11aa-400d-9a2a-6d57747ff26d. nginx, cron and pm2-root were all active automatically. The after gate passed task retention and a natural minute execution whose persisted log included that new boot ID, without calling a task-run API. Full result: after.log. The test removed its task/script/state. Debian reported 12.15 and all three services enabled. The guest was powered off and QEMU removed its PID file; finish.log records final versions/registration. Ubuntu-specific whole-machine boot remains untested.

The current source also passed the full non-root, network-disabled Debian test container suite: 237 tests, zero failures/skips, /tmp/ql-upgrade-full-debian.log. Together with the same 237-test Alpine run this refreshes full regression after upgrade/port fixes. These runs do not close remaining transport/configuration and final artifact acceptance work.


### Raw netrc compatibility and actual GitHub archive transport (2026-09-25)

A loopback random-credential differential reproduced a real raw-download regression in the official 2.20.1 image: its GNU wget read HOME/.netrc and downloaded the private script, while syncRaw's curl returned HTTP 401. The earlier macOS attempt could not launch its installed wget (exec error -86); the lightweight Alpine fixture used BusyBox wget, which itself rejected the netrc-only request. Neither preliminary tool mismatch was counted as evidence for the product regression. The official-image result is /tmp/ql-raw-netrc-before-official.log.

syncRaw now passes curl --netrc-optional, preserving GNU wget's configured credentials without requiring a netrc file for public subscriptions. No credential value is read into JavaScript, printed or added to argv. rawCredentials.test.cjs uses a private temporary HOME and random credentials, verifies successful private download, denied access preserving the installed file, temporary-file cleanup, and successful public download after removal of netrc. QL_WGET_COMPARE=1 additionally runs the retained GNU wget comparison in the official image; /tmp/ql-raw-netrc-after-official.log passed. Ordinary fixture runs do not require GNU wget. A focused run omitted the original Shell mount and therefore failed two unrelated differential-file reads; corrected full-suite commands restore that mount.

The actual GitHub archive gate was rerun without executing downloaded source. macOS downloaded the source archive but static download failed with curl exit 16 (HTTP/2), /tmp/ql-github-archive-current.log. The supported Alpine test runtime then passed the complete HTTPS source/static download, extraction, 2.x release validation and atomic readiness-pointer checks in 5.5 seconds, /tmp/ql-github-archive-alpine-current.log. Published master reported 2.21.0. Source archive: 819710 bytes, SHA256 b9960e9a51c3bb9b9cb585d982c6a3cd2fe67a07193e8d3824ff03a90f472574. Static archive: 12640693 bytes, SHA256 9fb1f2597cbc3d06bee15346a898e498d3af733df8cbab0fec2f2d2bf12a300c. Dependency installation was intercepted and no installed panel changed; retained-data upgrade evidence remains the separate actual 2.19→2.20.1 gate. Temporary stages were removed. Both supported archive mirrors now have successful transport/staging evidence, scoped to their recorded environment and published artifacts.

After the netrc fix, complete non-root/offline suites passed on both Debian and Alpine: 238 tests each, zero failures/skips. Logs: /tmp/ql-netrc-full-debian.log and /tmp/ql-netrc-full-alpine.log. These supersede the prior 237-test source snapshot; packaged panel images still predate this final raw-download edit and need rebuilding for final artifact acceptance.


### Credential-helper matrix and all six legacy task signals (2026-09-25)

networkRepository.test.cjs now exercises both http.extraHeader and credential.helper store authentication for direct/proxied HTTP and HTTPS CONNECT. Credentials are random and stored only in private fixture files. Every combination verifies selected branch/scripts and preservation of checkout HEAD/installed scripts on unauthorized/unavailable responses; HTTPS additionally rejects untrusted certificates. Both non-root/offline Linux runtimes passed the expanded matrix (/tmp/ql-git-helper-debian.log, /tmp/ql-git-helper-alpine.log). This verifies Git configuration passthrough for the native store helper, not arbitrary external helper implementations.

A source audit found a real signal-coverage omission: retained task.sh registers INT/TERM/HUP/ALRM/TSTP/QUIT, while both runnerMain and shared command cancellation registered only the first three. Shared signal selection now includes all six, runner listener installation/removal uses the same list, and main's cancellation error envelope obtains the same platform-specific 128+signal exit code. The cancellation module is loaded lazily on that error path, preserving public help's existing loading boundary. Generic AbortController cancellation still defaults to SIGTERM. GitNexus reported UNKNOWN for the new local symbols and LOW for main (one indexed direct caller, no affected flows); source review covered runner/operator callers.

The first regression after changing only shared cancellation reproduced missing runner listeners (signal termination instead of final JSON). The complete fix passed 54 focused Debian checks, including runner, subprocess diagnostics, operator rollback and loading boundary (/tmp/ql-six-signals-fixed-debian.log). Expanded runner tests cover six signals during random delay, active Shell with exact signal/EXIT traps, configuration and before-hook execution; compatibility tests additionally exercise config/extra/raw/worker lifecycle and child cleanup for all six. The original Shell's exit 1 remains intentionally replaced by conventional platform signal status. No original Shell was edited.

Complete fixed-source regression passed on both Debian and Alpine: 250 tests each, zero failures/skips, /tmp/ql-six-signals-full-debian.log and /tmp/ql-six-signals-full-alpine.log. The explicit configuration/transport review index is configuration-acceptance.md. Final distributable and real-image acceptance must now use a rebuild containing the netrc and six-signal changes; earlier images are not evidence for those edits.


### Reachable Shell audit finds and closes task discovery (2026-09-25)

The reachable capability audit is docs/cli/shell-capability-audit.md (outside the package). update.sh's complete command case list maps to local/worker implementations. Reviewing otask.sh found a concrete missing behavior: its no-argument usage calls gen_array_scripts to list top-level JS scripts and extract new Env activity names; the TS runner only returned static help. The unused run_nohup definition has no call site and does not create a separate callable operation.

scriptInventory.ts now streams script text to extract names without importing/executing it. With QL_DIR or --root configured, the no-script runner includes the inventory; --json returns data.scripts, while explicit --help remains static. Missing scripts directories yield an empty list. sendNotify.js, non-JS files and directories are excluded. No user config is executed for discovery. Anonymous scripts use their filename in text output and name=null in JSON. This improves the old generic unknown-name placeholder while retaining discovery capability.

scriptInventory.test.cjs compares file selection to the unchanged gen_array_scripts definition extracted from retained otask.sh, and checks actual compiled no-argument/JSON/help/empty-directory behavior with config and script contents that would fail if executed. The focused Debian runner/loading-boundary set passed 31 tests (/tmp/ql-inventory-regression.log). The complete current-source Debian and Alpine suites then each passed 251 tests, zero failures/skips (/tmp/ql-inventory-full-debian.log, /tmp/ql-inventory-full-alpine.log). GitNexus runnerMain impact remained UNKNOWN; source review confines this change to runner help/discovery.

The previously recorded candidate image predates this implementation. Its acceptance record explicitly notes that a refreshed package/image gate is required; do not claim the earlier image includes task inventory.


### Final native macOS shell bridge correction (2026-09-25)

The post-inventory image sha256:3c36190976624883a94f110bcef9ad221a817661ac7315c59fa37fd8e2ac6f8d passed the full packaged panel, reload/language preload, new task inventory and real crond sequence in one isolated container. Logs: /tmp/ql-complete-{panel,preload,inventory,cron}.log. It stopped normally (143, no OOM) and was removed. This image still predates the shell bridge correction below.

The full macOS suite with /usr/bin:/bin first in PATH selected native Bash 3.2 and exposed two shell-option failures: BASHOPTS is not a native inherited option mechanism there, so nullglob/extquote state did not survive the configuration bridge. That run passed 242, failed 2 and skipped 5 Linux-only tests; it was not counted as acceptance. The direct-child probe also relied on modern Bash importing BASHOPTS, so it now uses the actual CLI runProcess bridge before comparing with the original same-session Bash behavior.

sourceEnvironment now captures enabled shopt state explicitly from shopt -p and always records QL_CLI_BASHOPTS (including an empty state). shellOptionPrelude explicitly enables captured options as well as disabling absent ones. This preserves the same mechanism across Bash 3.2 and newer Bash, without executing configuration twice or replacing task scripts. GitNexus returned UNKNOWN for both symbols; source review identified config/runner/hook callers. Forty-six focused macOS task/config tests passed, /tmp/ql-bash3-focused.log.

Complete regression after the fix passed: Debian 251/251, Alpine 251/251, native macOS 244 passed with 5 Linux-only skips (249 total; Linux-only nested cases explain the count difference). No failures. Logs: /tmp/ql-bash-bridge-full-{debian,alpine,macos}.log. CLI and isolated loader build passed. Skill validation passed after correcting an invocation that supplied the file path instead of its directory; that initial invocation reported SKILL.md not found and was not a skill-content failure.


### Accepted final executable snapshot (2026-09-25)

Final executable image sha256:a9ac7186ff15f4f02fd8b4f7a3d62f5954ef60c0309e366e380ba1e7fb4d9921 includes task inventory and Bash option-bridge fixes. In one fresh network-disabled container with only tests mounted, the complete packaged panel gate passed authentication, raw/Git subscription execution, account/operator maintenance, remote run/logs and local nonzero status persistence. Service reload retained tasks; JS/MJS/Python preload, real QLAPI and ESM exported subpaths passed. The packaged task alias discovered a new JS fixture without executing it. A natural minute tick confirmed real crond, TS runner, persisted log and TS container ancestry. Logs: /tmp/ql-final-bridge-{panel,preload,inventory,cron}.log. Normal shutdown returned exit 143, OOMKilled=false, Running=false; container and volume removed (/tmp/ql-final-bridge-stop.log).

Strict build, Skill validation and independent seven-command package installation pass. Measured executable snapshot: dist including maps 469052 bytes; macOS ARM64 Node 24.18.0 nine samples, baseline median 78.84 ms / 44.70 MiB peak RSS versus help 80.15 ms / 46.02 MiB (increment 1.31 ms / 1.32 MiB). The measured packaged documentation snapshot was 182355 packed / 679352 unpacked bytes; final documentation reconciliation changes package bytes only. Final archive/install results are recorded outside the package in docs/cli/final-acceptance-20260925.md to avoid a self-changing package report.

The complete capability and configuration audits now close the migration goal. Full current suites pass as recorded above; original Shell/production defaults remain unchanged, and independent 3.0 work is excluded. Historical 'pending' statements in this chronological document describe prior snapshots, not the final state. Current acceptance and limitations are in acceptance-status.md. The original issue #3073 requested an AI agent workflow; this task followed the user's subsequently selected CLI/authentication/Skill approach, not an unrequested Telegram agent or MCP server.
