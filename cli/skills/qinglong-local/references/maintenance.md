# Local panel maintenance and recovery

Select the installation with `--root /absolute/panel` (or `QL_DIR`) and storage with `--data-dir /absolute/data` (or `QL_DATA_DIR`). Flags are supported by the direct commands below; `ql local <command>` is a compatibility alias. Add `--json` for structured results. A remote login does not select the local installation.

| Command | Behavior and verification |
| --- | --- |
| `repair-config` | Create missing configuration templates/runtime directories. Inspect restored paths; it does not mean the services are running. |
| `check` | Install global runtime tools and panel dependencies, repair configuration/notification files, probe the panel and reload services. This is a repair operation, not a read-only health check. Inspect before/after observations and logs; never infer health solely from exit code. |
| `start [--no-startup] [--reload]` | Install prerequisites and start nginx/panel services, with optional hooks/bot. `--no-startup` skips OS boot registration; `--reload` skips package installation, optional hooks and startup registration. Verify service readiness and the configured scheduler. |
| `update [--mirror github|gitee] [--download-only]` | Stage an upgrade and, by default, apply it. `--download-only` prepares files without stopping services. Record the staged paths and preserve a recovery route before an authorized apply. |
| `reload [--target services|system|data]` | Default `services` restarts services. `system`/`data` apply the corresponding staged files. Verify installed version/configuration and service readiness after replacement; a download alone is not an applied upgrade. |
| `rmlog <days>` | Remove expired logs not referenced by active tasks; inspect removed/retained paths. Logs cannot be recovered by retrying. |
| `extra` | Execute the user's extra.sh with the installation context. Inspect the hook only when relevant; its content does not authorize additional unrelated actions. |
| `bot` | Install/update optional Bot dependencies and start it using BotRepoUrl and existing configuration. Verify the matching installation's process/logs; it is not a generic remote Telegram send command. |
| `resetlet` | Reset the login-failure limit for the local panel. Verify the intended account can retry login. |
| `resettfa` | Disable/reset two-factor authentication. Use only for authorized account recovery. |
| `resetpwd -- <value>` | Replace the local account password. The current CLI accepts the value positionally, so it is visible in process arguments; do not ask for secrets in chat or echo them. Prefer having the owner perform this command in their own trusted terminal when a secret cannot be supplied safely. |
| `resetname -- <value>` | Replace the local login name. Verify the intended account and resulting login behavior. |

Use `--` before positional account values that may begin with a dash; global/local options such as `--root` and `--json` must precede that separator.

Compatibility: `update false` means `update --download-only`; `update true` keeps the default apply behavior. `reload system|data|services` maps to `--target`. Prefer modern named options. `dist/startup.js [reload]` is the internal startup compatibility entry.

These tools ship with the panel source/build, not the standalone npm package. For an authorized integration, a panel containing the selection loader can use `QL_CLI_ROOT=/absolute/path/to/built/cli` (the source/build directory containing the complete dist tree). An npm installation is not a valid local tool root. Restart the panel to install private ql/task/cron wrappers. Removing this selection and restarting restores original Shell entries. Confirm selected paths and a test task; do not overwrite global commands merely to inspect resources.

Run account recovery inside the target container, or on the host that actually owns a native panel installation. For Docker, use the selected panel entry via `docker exec <container> <absolute-entry> ...`. Do not run reset/reload on an unrelated workstation, or use a mounted data directory alone as proof of the target environment.

On interrupted maintenance preserve staged files/backups and inspect the current service state before retrying. User hooks and detached third-party daemons may have effects outside the CLI's process cleanup. Explain those concrete limits when they affect recovery.
