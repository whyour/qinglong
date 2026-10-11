#!/bin/bash
# Fixed harness for comparing the original Shell implementation with the CLI.
date() {
  if [[ $# == 1 && $1 == +%s ]]; then
    printf '%s' "$FIXED_NOW"
  else
    command date "$@"
  fi
}
t() { :; }
find_cron_api() { [[ $1 == *active* ]] && printf referenced; }
. "$1" 7
