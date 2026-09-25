# Final 2.x CLI migration acceptance

> Historical snapshot before the unified Commander CLI. Its archive, runtime requirements and test results describe that earlier build only. For the current implementation, see [Commander migration validation](commander-refactor-20260925.md).

Status: complete, 2026-09-25. The requested Shell capabilities are implemented in the independent strict TypeScript CLI; originals and production defaults remain for comparison. The independent 3.0 launcher is excluded. No production entry switch, Git commit, PR or public release was performed.

## Deliverable

- Archive: [qinglong-cli-0.1.0.tgz](artifacts/qinglong-cli-0.1.0.tgz), 182498 bytes, SHA256 `2cab6a3939e1777c55e8902a053a08f9c9715f29cc552116c01933bc50fe1277`.
- Source/build hashes: [final-manifest-20260925.json](final-manifest-20260925.json).
- Usage: [CLI README](../../cli/README.md); full [acceptance audit](../../cli/docs/acceptance-status.md); [Shell capability map](shell-capability-audit.md).
- Seven entries, zero runtime npm dependencies, Node >=18; native argument parser, declarative command registry and lazy loading. Public panel management is separate from execution/maintenance, subscription worker and release entry. Skill is packaged and validated.

The exact delivery archive was installed offline into a new temporary prefix. All seven --help entries passed, and the installed runner discovered a fixture without executing it. Each of its 114 compiled/map files matches both the working build and the tested image byte for byte. Final documentation is reconciled after image testing; these documentation changes do not alter executables. Linux independent-install checks also passed on Alpine/Debian; packaging-tool compression differs slightly between environments.

## Verified behavior

- Final strict TS and isolated 2.x loader builds passed.
- Debian: 251 passed, zero skips/failures; Alpine: 251 passed, zero skips/failures. Native macOS Bash 3.2: 244 passed, five Linux-only skips, zero failures. Logs: /tmp/ql-bash-bridge-full-{debian,alpine,macos}.log.
- Fixed image `sha256:a9ac7186ff15f4f02fd8b4f7a3d62f5954ef60c0309e366e380ba1e7fb4d9921` passed the complete real 2.20.1 sequence in one fresh network-disabled container: app authentication, raw/Git subscription execution, account/operator maintenance, remote tasks/logs, retained tasks after reload, real JS/MJS/Python QLAPI and ESM exported subpath, packaged no-argument task discovery, and natural crond minute execution through TS. Logs: /tmp/ql-final-bridge-{panel,preload,inventory,cron}.log. Dist/image equality: /tmp/ql-delivery-image-match.log.
- Real 2.19→2.20.1 upgrade preserved account/tasks/config/dotenv, selected TS loader and port, with task execution and automatic minute trigger. Actual Alpine/OpenRC and Debian/systemd kernel reboots restored nginx/cron/PM2 and retained scheduled tasks. Their exact historical version scopes are in evaluation.md.
- HTTP/HTTPS/CONNECT, native Git credential helper, raw netrc and SSH identity/host-key gates passed; both archive mirrors passed actual staging. No downloaded archive code was executed in transport-only tests.
- Retained-Shell comparisons cover copy/cron precedence, account modes, hooks/options, random delay and script inventory. Six-signal cancellation, timeout/cleanup, failure preservation, local API contracts and release refs/CDN failures have isolated execution evidence.
- Normal final container shutdown: exit 143, no OOM, not running. Container and anonymous volume removed. No fixture VM remains running from host acceptance.

## Footprint and scope

macOS ARM64 Node 24.18.0, nine samples: baseline median 78.84 ms / 44.70 MiB peak RSS; public help 80.15 ms / 46.02 MiB. Increment 1.31 ms / 1.32 MiB. Dist with source maps: 469052 bytes. These are measured host observations, not universal limits.

Working tracked scope: package.json CLI scripts and opt-in back/loaders/deps.ts plus pre-existing unrelated .gitignore/AGENTS changes. CLI/docs are untracked deliverables. Original shell/, production docker/ and packages/ working-tree diffs remain empty; unrelated CLAUDE and ql3 test files were preserved. GitNexus working indexed analysis is LOW; comparison with develop is CRITICAL because it includes thousands of independent branch/3.0 changes. Do not merge or present that entire comparison as this task's diff.

Intentional differences and boundaries are explicit in migration.md: actual signal/child failures, TLS verification, explicit archive mirror, scoped process cleanup, preserved dotenv and safer release refs. Prerequisite interpreters/generated backend modules remain installation dependencies; user hooks remain Bash. Ubuntu-specific full boot, arbitrary third-party helpers/providers, detached user daemons and power-loss atomicity are not universal guarantees. These limits do not remove a named migrated capability.

The originating [issue #3073](https://github.com/whyour/qinglong/issues/3073) proposes AI-assisted task operation/diagnosis. The user's selected implementation is authenticated CLI plus Skill, with separate local/worker tools; a Telegram agent or MCP server was not part of this migration goal.
