import type { LocalContext } from './context';

// Bash is the interpreter for user-owned files. The CLI supplies paths/argv as
// separate arguments; no user argument is interpolated into this fixed bridge.
export function shellSessionArguments(
  context: LocalContext,
  script: string,
  argv: string[],
  scriptArgs: string[],
): string[] {
  const bridge = `
__ql_env=$1; __ql_before=$2; __ql_after=$3; __ql_script=$4; __ql_count=$5; shift 5
__ql_hook_args=( "\${@:1:__ql_count}" ); shift "$__ql_count"
__ql_script_args=( "$@" )
if [ -f "$__ql_env" ]; then . "$__ql_env"; fi
if [ -f "$__ql_before" ]; then . "$__ql_before" "\${__ql_hook_args[@]}"; fi
if [ -n "\${task_before:-}" ]; then eval "\${task_before%;}"; fi
__ql_nounset=false
case $- in *u*) __ql_nounset=true; set +u;; esac
if [ -n "\${__ql_selected_name:-}" ]; then
  printf -v "$__ql_selected_name" '%s' "$__ql_selected_value"
  export "$__ql_selected_name"
fi
unset __ql_selected_name __ql_selected_value
. "$__ql_script" "\${__ql_script_args[@]}"
_task_exit_code=$?
if [ "$__ql_nounset" = true ]; then set -u; fi
export NODE_PATH="\${PREV_NODE_PATH:-}"
unset QL_NODE_GLOBAL_PATH
if [ -f "$__ql_after" ]; then . "$__ql_after" "\${__ql_hook_args[@]}"; fi
if [ -n "\${task_after:-}" ]; then eval "\${task_after%;}"; fi
exit "$_task_exit_code"
`;
  return [
    '--noprofile',
    '--norc',
    '-c',
    bridge,
    'ql-shell-session',
    context.paths.file_env!,
    context.paths.file_task_before!,
    context.paths.file_task_after!,
    script,
    String(argv.length),
    ...argv,
    ...argv.slice(1),
    ...scriptArgs,
  ];
}
