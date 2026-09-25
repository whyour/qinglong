# Retained 2.x Shell capability audit

The audit scope is reachable product behavior in the retained 2.x Shell, not a one-to-one translation of dead helpers or executing user Bash inputs in TypeScript. Original files remain available for differential evaluation. shell/ql3-launcher.sh and the independent packages/ql3-* work are excluded.

| Retained source / entry | Current TypeScript implementation | Evidence to inspect |
| --- | --- | --- |
| update.sh main: repo/raw | subscription-worker.ts; subscriptionRunner.ts, subscriptionFilter.ts | Compatibility positional parsing; copy precedence against gen_list_repo; real switched raw/repository panel gate; authenticated HTTP/HTTPS/SSH and netrc tests |
| update.sh main: update/reload | maintenance.ts, upgrade.ts, upgradeSelection.ts, operator.ts | Staging/readiness tests; faults and rollback; real 2.19→2.20.1 with dotenv, TS selection, original account/task and natural minute execution retained |
| update.sh main: extra | maintenance.ts, commandLog.ts | User hook command execution, scoped logs/status and six-signal cancellation through compatibility tests |
| update.sh main: rmlog | maintenance.ts pruneLogs | Calendar-age/reference/symlink fixtures; actual panel retention for referenced and unused logs |
| update.sh main: bot | bot.ts | OS package/pip fixture and actual Alpine test bot lifecycle; installed configuration and other installation processes retained |
| update.sh main: check | check.ts and operator.ts | Original repair workflow comparison; actual online dependency/config repair and PM2 reload |
| update.sh main: resetlet/resettfa/resetpwd/resetname | maintenance.ts and LocalApi | Exact API payloads and actual disposable panel account-reset/login gate |
| task.sh parsing/language/logs/signals | runner.ts, taskRunner.ts, process.ts, cancellation.ts | Standard options/terminator/child argv, local process and log tests; all six original signals; actual scheduled task status and logs |
| otask.sh normal/now/conc/desi and workdir | taskRunner.ts, shellSession.ts, taskRunner.ts / dependencies.ts | Retained Shell differential; account selection and output order; nested path/explicit workdir/command execution tests |
| otask.sh random delay | taskDelay.ts and taskRunner.ts | Dispatch/extension/minute defaults and empty settings against retained Shell; cancellation during delay |
| otask.sh no-argument usage inventory | scriptInventory.ts and runner.ts | scriptInventory.test.cjs compares retained gen_array_scripts; static text metadata, exclusion of sendNotify.js, empty directory and JSON. Added after the first candidate image |
| env.sh store/restore and share.sh user config/hooks | context.ts, taskRunner.ts / dependencies.ts, shellSession.ts, shellOptions.ts | Configuration exports/functions/options, before/after state, generated language environment and exact argv tests |
| api.sh token/CRUD/status/notify/auth/stat helpers | LocalApi, taskRunner.ts, commandLog.ts, subscriptionRunner.ts, maintenance.ts | Exact request/JSON/no-replay fixtures, real token/status/log persistence, independent end-status/stat attempts and scheduled-system execution IDs |
| share.sh path/OS/package/proxy/process/date utilities | context.ts, process.ts, files.ts, operator.ts, bot.ts, check.ts and taskRunner.ts | Existing callers migrated; no calls to the retained product Shell implementation. User config/hooks and generated environment remain Bash input |
| start.sh | startup.ts and bootstrap.ts, hostServices.ts | No-argument qinglong/reload adapter; actual Alpine/OpenRC and Debian/systemd provisioning, reboot and natural retained-task execution |
| docker/docker-entrypoint.sh | container.ts, containerEnvironment.ts, containerRuntime.ts | Explicit TS entry in real 2.20.1, crond ancestry, hook/bot cleanup and normal stop. Original production default unchanged |
| pub.sh | developer.ts and developer/release.ts | Disposable Git refs/lease/tag/CDN fixtures and explicit reviewed commit; production publication is not part of this acceptance |
| lang/*.sh | i18n modules | Migrated messages, bilingual command/option help, diagnostics and lifecycle fixtures |

Source review confirmed update.sh's complete case list has matching dispatch. The new public command surface deliberately excludes repo/raw and host operations; those capabilities remain in their separate local/worker entries. Task discovery was the concrete omission found by this audit and was implemented rather than waived.

The original run_nohup helper is defined only and has no call site. The original ql_base_url value is assigned but unused. Neither creates an additional callable product operation. Library-only helpers such as update_cron_api remain supported through the same LocalApi payload contract; commented-out original reconciliation updates are not enabled as new behavior.

Intentional differences remain in cli/docs/migration.md: real failure/signal exit status, verified TLS, explicit mirror choice, scoped process termination and safer release reference updates. No claim covers every arbitrary user Bash program, detached daemon, third-party credential helper or live notification provider. These limitations do not remove any named migration command.

Post-inventory and Bash 3.2 bridge artifacts have now been rebuilt and passed the complete fixed-image panel gate, including inventory and natural minute scheduling. Current acceptance is recorded in cli/docs/acceptance-status.md and final-acceptance-20260925.md.
