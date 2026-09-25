# 2.x TypeScript CLI candidate acceptance

> Historical snapshot before the unified Commander CLI. Its archive, runtime requirements and test results describe that earlier build only. For the current implementation, see [Commander migration validation](commander-refactor-20260925.md).

Executable snapshot: candidate-manifest-20260925.json. This records source/build hashes and the tested local image; it is not a production release or a whole-branch approval.

- Strict standalone TypeScript build and isolated 2.x loader build passed.
- Fixed-source Debian and Alpine suites: 250 tests each, zero failures/skips. Logs: /tmp/ql-six-signals-full-{debian,alpine}.log.
- Offline independent installation passed on macOS, Debian and Alpine with seven commands, bundled Skill and zero runtime npm dependencies. Linux snapshots: 180117 packed / 670808 unpacked bytes; macOS pack: 180120 / 670808 (different npm tar packaging). Logs: /tmp/ql-candidate-package*.log.
- Skill Creator quick_validate.py passed the bundled skill. This validates structure, not arbitrary agent behavior.
- macOS ARM64 Node 24.18.0, nine process samples: baseline median 67.93 ms / 44.52 MiB peak RSS; help 70.93 ms / 46.11 MiB. Increment: 3 ms / 1.59 MiB. Dist including maps: 463111 bytes. /tmp/ql-candidate-benchmark.log.

## Same-image real deployment

Image sha256:e7c3b150a33af15670b821a150ca89b52ba99639bb8e54d0f9b4bbecbc2dd0cd, pinned official 2.20.1 base. Two fresh containers used the explicit TS container entry, real system scheduler, --init, 30-second stop grace, no external network or published ports, and only a read-only test directory mount. No source/dist overlay changed the running artifact.

The first passed actual application authentication, remote task run/logs and local-runner status persistence. It then passed service reload retaining a task, real JS/MJS/Python preload and QLAPI integration, ESM global exported-subpath resolution, and a natural crond minute tick whose ancestry included the TS runner and container entry. Logs: /tmp/ql-candidate-panel.log, /tmp/ql-candidate-preload.log, /tmp/ql-candidate-cron.log.

The second passed the complete selected-entry gate: application auth, subscription reads, actual raw subscription execution, Git repository reconciliation, account maintenance, log retention/service reload, remote run/logs, TS ql/task selection and persisted nonzero local task status. /tmp/ql-candidate-switched.log. The initial test refused the already-selected image because its older fixture expected original symlinks before making a reversible test switch. QL_PANEL_PACKAGED=1 now verifies the existing packaged wrappers and runs those same assertions without substituting commands or loader. That first refusal occurred before account initialization; retry used the still-uninitialized fixture.

Both containers stopped normally (exit 143, OOMKilled=false, Running=false) and were removed with anonymous data volumes. /tmp/ql-candidate-stop.log. Image retained locally, not published.

## Scope audit

Working-tree tracked GitNexus analysis: four files/two indexed symbols, zero affected flows, LOW risk. It includes pre-existing AGENTS changes and does not include untracked CLI files. Comparison against develop: 3848 files/53511 symbols/272 flows, CRITICAL, dominated by independent branch work including 3.x. Do not treat this branch-wide result as a CLI-only diff or merge recommendation. First attempts hit an incompatible git executable; reruns selected /usr/bin/git. Logs: /tmp/ql-candidate-impact-{working,compare}.json (CLI text format).

Direct git diff of shell/, production docker/ and packages/ is empty. Existing unrelated .gitignore/AGENTS/CLAUDE and the untracked ql3 test remain untouched. Intended tracked integrations are package.json CLI scripts and opt-in back/loaders/deps.ts; CLI and documentation are currently untracked. No commit or PR was created.

Remaining completion audit: inspect the untracked implementation and command/capability inventory against the original Shell rather than relying on GitNexus's indexed-only scope; reconcile current acceptance documentation and any concrete defects that audit finds. Earlier real 2.19→2.20.1 upgrade and Alpine/Debian reboot evidence remains version-scoped in cli/docs/evaluation.md. No production switching is implied by the candidate tests.

## Subsequent audit finding

The legacy no-argument task inventory was missing from the runner. It is now implemented in scriptInventory.ts with a retained gen_array_scripts comparison and structured JSON. This changes runner source/build after the candidate above: the recorded image and manifest remain historical evidence and must be refreshed before final acceptance.
