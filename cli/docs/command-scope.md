# Command ownership

The Shell migration is a capability migration. Public command names follow panel resources and user workflows; internal implementation names do not automatically become public commands.

## Confirmed scope

The selected design is a panel management CLI plus independent local execution/operator tools. Subscriptions are managed through the panel API. This boundary applies to the 2.x migration; it does not include the separate 3.0 launcher.

For example, `ql subscription run 5` asks the authenticated panel to run subscription 5. The panel owns the subscription configuration, scheduling and execution status. The client does not clone the repository, edit local cron files, or silently switch to local execution when authentication fails. Existing scheduled `ql repo/raw` calls enter the compatibility adapter and local worker instead.

Full Shell migration means retaining the required behavior in its appropriate destination, not publishing every former Shell function as a management command. Shared TypeScript code and one distribution package are compatible with separate entrypoints; splitting responsibilities does not require duplicating implementations or adding runtime dependencies.

| Capability | Public API CLI (`ql`) | Local implementation / destination |
| --- | --- | --- |
| Authentication | login, auth status/logout | Explicit application credential, no implicit local system privilege |
| Scheduled tasks | task list/get/run/stop/logs | Task execution belongs to a separate runner; `run <id>` never means execute a local file |
| Subscriptions | subscription list/get/run/stop/logs/enable/disable | repo/raw, copying dependencies and cron reconciliation belong to the panel's local subscription executor |
| Environment / scripts / dependencies | Candidate resource commands, only with concrete API contracts and use cases | Do not expose arbitrary filesystem editing as a side effect of management commands |
| Log retention | Future panel management API if available | `ql rmlog`; protects currently referenced logs |
| Panel installation / upgrade / repair | Not part of the remote management CLI | Separate local operator commands with deployment prerequisites |
| Account reset / disable 2FA | Not part of remote application CLI | Explicit local operator capability |
| User extra.sh and task hooks | No public arbitrary-script shortcut | Local runner / operator tool executes user-owned scripts |
| Bot installation | No bundled Telegram agent in management CLI | Optional local integration installer; preserve existing behavior separately |
| Developer release (`pub.sh`) | Never a user-management command | Developer-only release tool, with explicit target/branch/tag plan |
| Service bootstrap (`start.sh`) | No remote install side effects | Local operator tool / container integration |

Current 2.x `back/config/subscription.ts` generates `SUB_ID=… ql repo/raw …`; this is an internal runtime contract that must be migrated and tested before replacing the legacy runner. It is not a reason to expose the same positional arguments in the new public CLI.

Public subscription reads omit pull credentials, URL, proxy, raw command and executable hook bodies. The existing subscriptions application scope remains authoritative. `auth status --scope subscriptions` checks that scope separately from `crons`.

Compatibility adapters are transitional entrypoints only. New public help should show resource operations; local help should show operator actions. The old installed ql/task binaries remain untouched during evaluation.

## Extension rules and current limits

- Add public commands around a panel resource and an explicit API contract. Authentication, request handling and structured output are shared; public handlers must not import local operators, the backend or database modules.
- Keep installation, process control, filesystem reconciliation and script execution in local tools. Local tools declare their installation and system-tool prerequisites separately from the remote client.
- Keep legacy positional arguments in the compatibility adapter. New management commands use resource IDs and named options, with no fallback from an API operation to a privileged local action.
- Subscription list/get/run/stop/logs/enable/disable exist today. Subscription creation, editing and deletion belong to the public API CLI if added, but are not implemented by the current command registry. This scope decision is not evidence that complete subscription CRUD has shipped.

The existing loading-boundary test checks that standalone public commands and help do not load local/backend dependencies. Packaging, compatibility and deployment acceptance remain separate gates; see [the acceptance audit](acceptance-status.md).

Local maintenance is exposed directly as `ql update/reload/check/start/rmlog/…`; `ql local <command>` remains a compatible alias. Both use the same validation and cancellation path. Legacy update booleans and reload targets are normalized before parsing; maintenance commands previously exposed by legacy ql retain command logs and lifecycle reports.
