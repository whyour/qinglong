# Configuration and transport acceptance map

This map identifies the retained 2.x Shell inputs and their concrete checks. It is a review index, not proof that every arbitrary user program has been tested. Chronological results and artifact versions remain in evaluation.md.

| Input or behavior | Implementation / evidence |
| --- | --- |
| AutoAddCron, AutoDelCron, DefaultCronRule, RepoFileExtensions | subscriptionRunner.ts; subscriptionRunner.test.cjs, subscriptionFilter.test.cjs and actual panel-subscription/panel-repository gates cover matching, copy precedence and scoped cron reconciliation |
| ProxyUrl and per-subscription proxy | Real smart HTTP and HTTPS CONNECT in networkRepository.test.cjs; both direct and proxy paths use header and credential.helper authentication |
| Git credentials | Git receives the operation environment and retains its native configuration. Loopback tests cover http.extraHeader and credential.helper store with private random credentials; separate Linux SSH gate covers URL/scp, identity and host-key failures. These are not claims about third-party credential-helper services |
| Raw file credentials | rawCredentials.test.cjs verifies optional HOME/.netrc, failed authentication preserving installed files and public access without netrc; QL_WGET_COMPARE=1 compares the official image's GNU wget |
| Upgrade mirrors | Actual GitHub and Gitee source/static archives pass staging in recorded Linux runs; dependency execution is excluded from this download gate and covered separately by real retained-data upgrade |
| CommandTimeoutTime, RandomDelay, RandomDelayFileExtensions, RandomDelayIgnoredMinutes | taskRunner/taskDelay; local.test.cjs, taskDelay.test.cjs, differential.test.cjs and runner.test.cjs cover timeout, delay selection, empty settings and cancellation |
| Config functions and shell options | sourceEnvironment, shellOptions and shellSession; differential.test.cjs covers function export, pipefail, glob behavior, errexit/nounset and before-hook overrides against retained Shell |
| Script/hook state, account modes and argv | local.test.cjs, differential.test.cjs, bashArguments.test.cjs, languagePreload.test.cjs; generated environment, shared Shell state, ordered concurrent output and exact arguments have focused checks |
| Node/Python preload and ESM paths | languagePreload.test.cjs, esmDependencies.test.cjs, Linux preload-paths and actual panel-preload gate cover JS/MJS/TS/Python/pyc, unusual installation paths and native ESM exports/conditions |
| no_tee, real_time, log_name, real_log_path, work_dir | local.test.cjs, lifecycle.test.cjs, pathDiagnostics.test.cjs and differential.test.cjs cover routing, explicit paths, /dev/null and workdir precedence |
| QL_DIR, QL_DATA_DIR, QlPort, QlGrpcPort | context and startup tests, actual tmpfs/data reload, actual cross-version upgrade, and startup/port regression. QlBaseUrl is assigned but unused by retained Shell and does not rewrite local API endpoints |
| QL_LANG | Chinese/English registry, diagnostics and lifecycle fixtures; unsupported locales fall back to Chinese |
| EnableExtraShell, AutoStartBot, BotRepoUrl | bootstrap/container/bot fixtures, Linux extra escalation and real local test-bot installation/start/stop; no external Telegram messaging is required |
| INT, TERM, HUP, QUIT, ALRM, TSTP | All six are registered by runner and shared command cancellation. runner.test.cjs covers live Shell traps, random delay, config and before-hook; compat.test.cjs covers child cleanup and lifecycle completion through compatibility and worker entries |
| Notification provider variables | User configuration is passed through to installed notification modules. Repair/copy and environment propagation are tested; live provider delivery is not a CLI transport implementation |

Final build, independent package/Skill validation, real same-image panel gate and source/capability audit are complete; see acceptance-status.md and evaluation.md.

Current-source six-signal regression: Debian and Alpine each passed 251 tests with no failures/skips; see evaluation.md for logs.
