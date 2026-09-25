import type { LocalContext } from '../runtime/context';

// Bash is the interpreter for user-owned files. The CLI supplies paths/argv as
// separate arguments; no user argument is interpolated into this fixed bridge.
export function shellSessionArguments(
  context: LocalContext,
  argv: string[],
  scriptArgs: string[],
  command = false,
): string[] {
  const scriptIndex = command
    ? argv.findIndex((arg) => /\.(?:js|mjs|py|pyc|sh|ts)$/.test(arg))
    : 0;
  const bridge = `
__ql_env=$1; __ql_before=$2; __ql_after=$3; __ql_command=$4; __ql_index=$5; __ql_count=$6; shift 6
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
__ql_args=( "\${__ql_hook_args[@]}" )
if [ "$__ql_index" -lt 0 ]; then __ql_index=0; fi
__ql_file=\${__ql_args[__ql_index]}
__ql_resolve=false
cd "$dir_scripts" || exit 1
if [ -n "\${work_dir:-}" ] && [ -d "$work_dir" ]; then
  cd "$work_dir" || exit 1
  __ql_resolve=true
elif [[ "$__ql_file" == */* ]] && [ -d "\${__ql_file%/*}" ]; then
  cd "\${__ql_file%/*}" || exit 1
  __ql_resolve=true
fi
if [ "$__ql_resolve" = true ] && [[ "$__ql_file" == */* ]]; then
  __ql_args[__ql_index]="./\${__ql_file##*/}"
fi
if [ "$__ql_command" = true ]; then
  "\${__ql_args[@]}" "\${__ql_script_args[@]}"
else
  . "\${__ql_args[0]}" "\${__ql_script_args[@]}"
fi
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
    String(command),
    String(scriptIndex),
    String(argv.length),
    ...argv,
    ...(command ? [] : argv.slice(1)),
    ...scriptArgs,
  ];
}
