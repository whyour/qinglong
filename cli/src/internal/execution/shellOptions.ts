// Restore the captured state, including Bash 3.x without native BASHOPTS.
export const shellOptionPrelude = `
if [ "\${QL_CLI_SHELLOPTS+x}" = x ]; then
  while read -r __ql_option __ql_state; do
    case ":$QL_CLI_SHELLOPTS:" in
      *:"$__ql_option":*) ;;
      *) set +o "$__ql_option" ;;
    esac
  done < <(set -o)
fi
if [ "\${QL_CLI_BASHOPTS+x}" = x ]; then
  while read -r __ql_builtin __ql_state __ql_option; do
    case ":$QL_CLI_BASHOPTS:" in
      *:"$__ql_option":*) shopt -s "$__ql_option" ;;
      *) shopt -u "$__ql_option" ;;
    esac
  done < <(shopt -p)
fi
unset __ql_option __ql_state __ql_builtin
`;
