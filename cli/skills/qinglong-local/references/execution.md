# Local execution and subscription synchronization

## Installation and task runner

Identify `--root /absolute/panel` or the existing `QL_DIR`. Use `--data-dir /absolute/data` or `QL_DATA_DIR` when storage is separate. Confirm the intended local installation; it is independent of any remote CLI login. Local operations use the panel's own token/configuration, not the remote application's credential file. User config and hooks remain Bash; JS, Python, Shell and TS tasks need their respective installed runtimes.

CLI options precede the script:

```sh
<cli> task exec --root /ql --json job.js now -- --flag 'value with spaces'
<cli> task exec --root /ql -m 5m --json job.py
<cli> task exec --root /ql --json job.js conc ACCOUNTS
<cli> task exec --root /ql --json job.js desi ACCOUNTS 1 3-5
```

- Normal execution retains configured delay; `now` skips it. `conc` runs selected accounts concurrently; `desi` selects accounts for designated execution. Confirm the configured variable name and account ranges; avoid printing values.
- `--` ends runner mode/account arguments and passes the remaining arguments to the user script. `--root`, `--data-dir`, `--json`, `-m/--timeout`, `-l/--log` belong before the script. Local script arguments resembling flags must not be reinterpreted as management commands.
- `task <script>` and `<cli> task <script>` are shorthands. Remote API verbs are rejected before reading credentials or starting a script. Use explicit `task exec` for scripts with those names.
- With `QL_DIR` set, `task` or `<cli> task` with no operation lists available JS scripts without executing them. Use `task exec --root /ql --json` to list an explicit installation. `--help` shows usage without loading configuration.
- JSON mode sends script output to stderr and a final result to stdout. Preserve nonzero script exits, timeout and signal outcomes; successful process launch is not successful execution. Local script logs may contain secrets.

## Local repo/raw workers

For managing an existing panel subscription, use `subscription ...` API commands from the separate `qinglong-cli` skill. Use these workers only when local synchronization is intended. They may download files, install dependencies, run configured hooks and reconcile scheduled tasks.

Legacy positional syntax (quote empty placeholders):

```text
<cli> repo <url> [include] [exclude] [dependencies] [branch] [extensions] [proxy] [autoAdd] [autoDelete]
<cli> raw <url> [proxy] [autoAdd] [autoDelete]
```

Set `QL_DIR` and, when needed, `QL_DATA_DIR` in the execution environment; these workers do not accept `--root` or `--json`. `SUB_ID` identifies a panel subscription when invoked by the scheduler. Do not guess an ID. Preserve supplied booleans as `true`/`false` and positional order. Include/exclude/dependency expressions use POSIX ERE (`grep -E`), not JavaScript regexes.

Use existing Git/curl credential mechanisms without putting secrets into chat or URLs. After synchronization inspect the JSON result/log path, changed files and corresponding panel tasks; a command returning is not evidence that every newly scheduled task succeeded. Do not retry a failed sync blindly if hooks or dependency operations may already have executed.
