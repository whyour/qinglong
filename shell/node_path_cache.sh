#!/usr/bin/env bash

# Cache discovery only, never the installed packages. Ordinary installs at the
# same root are visible immediately. TTL bounds changes outside known inputs.
ql_node_path_cache_key() {
  local pnpm_bin node_bin name directory file
  pnpm_bin=$(type -P pnpm) || return 1
  node_bin=$(type -P node) || return 1
  {
    printf '%s\n' 'v1' "$EUID" "$PWD" "$PATH" "${HOME:-}" \
      "${PNPM_HOME:-}" "${XDG_CONFIG_HOME:-}" "${XDG_DATA_HOME:-}" \
      "$pnpm_bin" "$node_bin"
    for name in ${!npm_config_@} ${!NPM_CONFIG_@}; do
      printf '%s=%s\n' "$name" "${!name}"
    done
    # Follow executable symlinks, detecting upgrades at the same command path.
    stat -Lc '%n:%i:%s:%Y:%Z' "$pnpm_bin" "$node_bin" 2>/dev/null || \
      stat -Lf '%N:%i:%z:%m:%c' "$pnpm_bin" "$node_bin" 2>/dev/null
    directory=$PWD
    while :; do
      for file in "$directory/.npmrc" "$directory/pnpm-workspace.yaml"; do
        if [[ -f "$file" ]]; then
          printf '%s\n' "$file"
          cat -- "$file"
          printf '\n'
        fi
      done
      [[ "$directory" == / ]] && break
      directory=${directory%/*}
      [[ -n "$directory" ]] || directory=/
    done
    for file in "${HOME:-}/.npmrc" \
      "${XDG_CONFIG_HOME:-${HOME:-}/.config}/pnpm/rc" \
      "${npm_config_userconfig:-${NPM_CONFIG_USERCONFIG:-/dev/null}}" \
      "${npm_config_globalconfig:-${NPM_CONFIG_GLOBALCONFIG:-/dev/null}}"; do
      if [[ -f "$file" ]]; then
        printf '%s\n' "$file"
        cat -- "$file"
        printf '\n'
      fi
    done
  } | cksum
}

ql_read_node_path_cache() {
  local cache="$1" key="$2" now
  local stored_key="" stored_at="" stored_path=""
  now=${EPOCHSECONDS:-$(date +%s)}
  if [[ -f "$cache" && ! -L "$cache" && -O "$cache" ]]; then
    if ! {
      IFS= read -r stored_key && IFS= read -r stored_at && IFS= read -r stored_path
    } < "$cache"; then
      return 1
    fi
    if [[ "$stored_key" == "$key" && "$stored_at" =~ ^(0|[1-9][0-9]{0,10})$ && "$stored_path" == /* ]] && \
      (( now >= stored_at && now - stored_at < 60 )); then
      printf '%s\n' "$stored_path"
      return 0
    fi
  fi
  return 1
}

# Keep the lock descriptor in a subshell so sourcing this helper never changes
# the caller's descriptors. A crashed refresher releases the kernel lock.
ql_refresh_node_global_path() (
  local cache="$1" key="$2" now result previous_umask
  local lock="${cache}.lock"
  previous_umask=$(umask)
  umask 077
  if type -P flock &>/dev/null && mkdir -p -- "$dir_tmp" 2>/dev/null; then
    if [[ ! -L "$lock" && ( ! -e "$lock" || ( -f "$lock" && -O "$lock" ) ) ]] && \
      { exec 9>> "$lock"; } 2>/dev/null; then
      # Bound the wait; absent/unsupported flock or contention falls back to
      # independent discovery. Never remove the lock file while waiters exist.
      if flock -w 2 9 2>/dev/null; then
        if ql_read_node_path_cache "$cache" "$key"; then
          return 0
        fi
      fi
    fi
  fi

  # Private lock creation must not change pnpm's inherited creation mask.
  umask "$previous_umask"
  now=${EPOCHSECONDS:-$(date +%s)}
  result=$(pnpm root -g 9>&- 2>/dev/null) || return $?
  # Never cache failed, empty, multiline or non-absolute answers.
  if [[ "$result" == /* && "$result" != *$'\n'* && "$result" != *$'\r'* ]]; then
    (
      umask 077
      mkdir -p -- "$dir_tmp" || exit 0
      local temporary
      temporary=$(mktemp "${cache}.XXXXXX") || exit 0
      if printf '%s\n%s\n%s\n' "$key" "$now" "$result" > "$temporary"; then
        mv -f -- "$temporary" "$cache" || rm -f -- "$temporary"
      else
        rm -f -- "$temporary"
      fi
    ) 2>/dev/null
  fi
  printf '%s\n' "$result"
)

ql_get_node_global_path() {
  if [[ "${QL_NODE_PATH_CACHE:-1}" == 0 ]]; then
    pnpm root -g 2>/dev/null
    return $?
  fi

  local key cache
  cache="${dir_tmp}/pnpm-root-${EUID}.cache"
  key=$(ql_node_path_cache_key) || { pnpm root -g 2>/dev/null; return $?; }
  if ql_read_node_path_cache "$cache" "$key"; then
    return 0
  fi
  ql_refresh_node_global_path "$cache" "$key"
}
