# Migration acceptance — complete

Updated 2026-09-25. The requested 2.x Shell capability migration, independent TypeScript CLI design, structured output, Skill and opt-in replacement acceptance are complete. Original Shell and production default entrypoints remain for comparison. No 3.0 launcher work, production deployment, release publication, commit or PR is included.

## Requirement-by-requirement evidence

| Requirement | Authoritative implementation and evidence |
| --- | --- |
| Every reachable 2.x Shell CLI capability | compat.ts, runner.ts, subscription-worker.ts, startup.ts, developer.ts and local operators. All update.sh command cases mapped; task modes, no-argument script inventory, hooks, logs, six signals and maintenance covered. The source inventory and per-command evidence are recorded in the repository's docs/cli/shell-capability-audit.md |
| Public/local separation | Registry and independent bins: public task/subscription API management; local execution/maintenance; internal repo/raw worker; developer release. Loading-boundary tests prevent local runtime loading for public help |
| Portable, small and extensible TS CLI | Strict TS/Node >=18, native util.parseArgs, declarative schemas/generated help, lazy handlers, zero runtime npm dependencies. Seven-command standalone/offline installation verified. Footprint and timing recorded in evaluation.md and final acceptance report |
| Authentication/structured output | Private credential files, HTTPS except loopback, scoped authentication, no mutation replay, real 2.20.1 application auth and resource operations; script output separated from JSON, errors retain nonzero/signal status |
| Skill | Packaged qinglong-cli Skill with scope/auth/ID resolution/uncertain-operation handling. Skill Creator validator and independent installation both pass |
| Task execution/configuration | Retained Shell differential and real subprocess tests; JS/MJS/TS/Python/pyc, exact argv, account selection, workdir, Bash options/functions, task discovery and six signals. Bash 3.2 shopt inheritance gap repaired and tested through the actual CLI bridge |
| Subscription execution | Actual switched raw and repository reconciliation; HTTP/HTTPS, proxy/CONNECT, native credential.helper, netrc and SSH key/host-key gates. Failed transfers preserve installed state. Both archive mirrors have download/staging evidence |
| Upgrade/maintenance | Actual 2.19→2.20.1 preserving account/tasks/config/dotenv/TS selection and port; retained minute task; rollback/fault/mount tests. Real account reset, log retention, repair and reload gates |
| Host and container replacement | Actual Alpine/OpenRC and Debian 12/systemd boot-ID-changing reboots with nginx/cron/PM2 and automatic retained-task execution. Explicit TS container entry passed auth/subscription/task/reload/preload/inventory/crond/normal shutdown in one fixed 2.20.1 image |
| Original artifacts and 3.0 boundary | Original shell/ and production docker/ working-tree diffs empty. Only tracked product integrations are CLI package scripts and opt-in deps loader; unrelated workspace changes retained. Whole branch against develop contains independent 3.0 work and must not be delivered as a CLI-only change |
| Developer release capability | Separate entry; disposable repository ref/lease/tag/CDN tests. No live release or notification-provider messages were sent |

Current-source full suites: Debian 251 passed, Alpine 251 passed; macOS native Bash 3.2 244 passed and 5 Linux-only skips. All have zero failures. Final fixed-image gate includes task inventory and the shell bridge correction. See evaluation.md for chronological results, exact logs and earlier failures; those historical pending statements are superseded by this current audit.

## Tested boundaries and intentional differences

The CLI preserves capabilities rather than legacy failure bugs: actual child/signal exit statuses, TLS verification, explicit mirror selection, scoped process cleanup, preserved dotenv and reviewed release refs are intentional. User configuration/hooks remain Bash input; generated backend environment/client modules and language interpreters remain installation dependencies. Host setup assumes prerequisite Node/Python runtimes. Linux host services were boot-tested on Alpine and Debian; Ubuntu uses the shared systemd path but has no separate full-machine result. No claim proves arbitrary user scripts, separately daemonized descendants, power-loss atomicity, every external credential helper or live Telegram/provider delivery.

Replacement is explicit through the documented CLI installation/QL_CLI_ROOT or evaluation image selection. Keeping original default entrypoints is part of the requested comparison strategy, not unfinished migration logic. No production switch is implied by acceptance.
