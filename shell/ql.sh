#!/usr/bin/env bash

if [[ -z "$QL_DIR" ]]; then
  echo "Error: QL_DIR environment variable is not set"
  exit 1
fi

dir_shell=$QL_DIR/shell
. $dir_shell/update.sh "$@"
