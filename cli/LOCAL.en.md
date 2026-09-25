# Panel-internal TypeScript tools

[简体中文](LOCAL.md) | **English**


The npm and panel-internal entries both use the name `ql`, but have separate Commander command trees. The npm entry only calls remote APIs; the internal entry only runs local tools. Verify the absolute executable path and `--help` before use. Installing the npm package does not migrate the built-in Shell commands.

These tools ship with panel builds and are excluded from the @whyour/qinglong-cli npm package. Node >=22.12 is required; user configuration/hooks remain Bash and scripts need their interpreters. Development publishing was removed from the CLI; shell/pub.sh remains available to release workflows.

```sh
npm ci --prefix cli
npm run build:cli
node cli/dist/ql.js --help
node cli/dist/ql.js task exec --root /ql demo.js now
node cli/dist/ql.js reload --root /ql
```

Run on the actual panel host or inside its container. For Docker use `docker exec <container> <selected-absolute-entry> ...`. A workstation npm CLI cannot reset a remote account; a mounted data directory alone is not the complete operational environment.

| Capability | Internal commands |
| --- | --- |
| Execution/inventory | `ql task exec [options] [script]`, with `ql task <script>` and `task <script>` shorthands |
| Subscription synchronization | `ql repo <url> [include] [exclude] [dependencies] [branch] [extensions] [proxy] [autoAdd] [autoDelete]`, `ql raw <url> [proxy] [autoAdd] [autoDelete]` |
| Startup/repair | `ql start`, `ql repair-config`, `ql check` |
| Upgrade/reload | `ql update [--mirror github\|gitee] [--download-only]`, `ql reload [--target services\|system\|data]` |
| Logs/extensions | `ql rmlog <days>`, `ql extra`, `ql bot` |
| Recovery | `ql resetlet`, `ql resettfa`, `ql resetpwd -- <value>`, `ql resetname -- <value>` |

`ql local <command>` remains compatible. `update false` means --download-only; reload system/data/services maps to --target. Place maintenance --root, --data-dir and --json before --. Password values appear in process arguments: use the owner's trusted terminal and never request passwords in chat.

Runner options precede the script. now skips delay; conc/desi select accounts; -- passes subsequent arguments through. With QL_DIR set, bare ql task or task lists JS scripts. Explicit --help does not read configuration. JSON mode sends script output to stderr and the final result to stdout, retaining the script exit code. The internal entry rejects remote API commands and does not read remote credentials. Use the separate npm entry for remote management; use task exec for scripts with reserved API action names.

repo/raw retain positional arguments and QL_DIR/QL_DATA_DIR, without --root/--json. Filtering uses native grep -E POSIX ERE; Git/curl and other operation-specific tools are required. The configuration bridge uses Bash and env supporting -0.

check installs dependencies, repairs and reloads; inspect its before/after observations rather than treating it as a read-only probe. reload defaults to service restart; system/data apply staged files. start --no-startup skips OS boot registration for containers; start --reload skips installation, optional hooks and boot registration. Bot setup involves system/pip dependencies and external processes.

## Integration and skill

On a panel containing the selection loader, set `QL_CLI_ROOT=/absolute/path/to/built/cli` to the internal build directory containing the full dist tree, **not an npm installation**. Restart to create private ~/bin ql/task/cron wrappers and prioritize them for panel processes. Independent terminals should use the selected absolute path. Unset the variable and restart to restore Shell entries. Invalid paths report errors without silent fallback. Original Shell entries remain the default.

dist/startup.js retains startup/reload compatibility; dist/compat.js and dist/subscription-worker.js are internal adapters, not npm commands. Lifecycle fields follow the installed panel version; customized versions may select QL_CLI_LIFECYCLE=legacy|extended.

The separate [qinglong-local skill](skills/qinglong-local/SKILL.md) covers execution and maintenance. Use qinglong-cli for remote API management. QL_LANG=en selects English help/messages while JSON fields remain stable.

Distinguish isolated fixtures, real-panel validation, and actual system upgrades/reboots. Fixture success does not establish support for every distribution, Bot or public upgrade download. Development publishing is explicitly excluded. Performance comparisons use temporary evaluation scripts, not shipped product code.
