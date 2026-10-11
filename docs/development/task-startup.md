# Task startup and notification loading

`task` performs shell configuration, status reporting and dependency-path discovery
before invoking the selected runtime. These costs are separate from cron callback
latency and time spent waiting for an execution slot.

## Dependency-path cache

Node scheduling usually starts in `/ql`, while Alpine crond starts in `/root`.
The pnpm discovery key includes the working directory, npm/pnpm configuration,
relevant environment and executable metadata. Each key now has its own cached
record, so alternating scheduler environments do not evict each other.

Records expire after 60 seconds. Refreshes share a persistent per-user lock;
records older than an hour are removed on refresh. Warm lookups do not scan the
cache directory. The lock is never removed while another process might use it.
The opt-out `QL_NODE_PATH_CACHE=0`, failed-discovery fallback, and package resolution
order remain available. This caches the dependency directory, not its contents.

## Language startup paths

| Invocation | Environment and before hooks | Automatic notification loading |
| --- | --- | --- |
| `task script.py` / `.pyc` | Python preload imports generated environment, runs the shell/command before hooks, imports `task_before.py`, then applies account selection | `QLAPI.notify(...)` imports `__ql_notify__` on first call |
| `task script.js` / `.mjs` / `.ts` | Node preload imports generated environment, runs shell/command before hooks, requires `task_before.js`, then applies account selection | `QLAPI.notify(...)` requires `__ql_notify__.js` on first call |
| `task script.sh` | Shell sources the generated environment and runs shell before hooks | No automatic Python/Node notification module |
| Explicit interpreter or other command, e.g. `task python3 script.py` | Retains generated environment and shell before-hook exports; it does not automatically install the Python/Node preload | No automatic notification module unless configured by the caller |

TypeScript uses `ts-node-transpile-only`; MJS uses the same Node preload plus the
ESM loader. There are no separate built-in Ruby, Go, Java or PHP preload modules.
All these task paths still pass through shared dependency-path setup: non-JS
scripts and their hooks may themselves call Node or use the QLAPI bridge.

The before hooks are deliberately still synchronous: they can export environment
variables or perform work required by the user's script. Python's preload still
starts a child shell/Python to capture that environment; Node's preload starts a
child shell/Node. Node also still loads its gRPC client eagerly. These are remaining
startup costs, not work performed by the cron library, and are not removed by this
change.

Shell scripts run in a child shell that inherits the wrapper's environment and
before-hook functions. This lets the wrapper run its after hooks and report the
exit status even when a script calls `exit`, replaces itself with `exec`, or fails
under `set -e`. The script's own EXIT trap still runs in the child. Changes made
inside the script (variables, working directory, functions and shell options)
do not propagate back to the wrapper or its after hooks.

## Lazy notifications

Scripts keep calling `QLAPI.notify` with the same arguments. When no notification
is sent, the notification provider and its channel dependencies are never imported
by the preload. First use loads the provider; subsequent uses reuse the standard
Python/Node module cache. JS forwards the receiver and return value, including
promises, and Python forwards positional and keyword arguments. Import/send errors
surface at the notification call rather than preventing unrelated scripts from
obtaining QLAPI during startup. A failed import can be retried after its cause is
resolved.

Provider initialization, including provider configuration reads, now happens at
first use. A script's explicit `import __ql_notify__`, `require(...)`, or independent
notification helper still loads that module immediately.

## Task timeouts

`task -m DURATION ...` also applies to sourced Shell scripts. The timeout worker
inherits before-hook variables, arrays and functions without serializing them.
At the deadline, the worker's process group receives TERM, followed by KILL after
0.5 seconds, so ordinary child processes cannot continue after the timeout.
Explicit interpreters and other commands use the same mechanism. Processes that
intentionally create a separate session/process group are outside this boundary.
The wrapper records status 124 and runs its after hook; concurrent account mode
retains its existing aggregate status behavior. Zero disables the timeout.

Cron executions waiting for a concurrency slot retain their schedule revision.
Disabling, deleting or replacing that revision prevents its queued executions
from starting when a slot becomes available. Already running executions retain
the existing stop behavior. Invalidated callbacks do not count against a new
revision's limit of five pending/running executions.
