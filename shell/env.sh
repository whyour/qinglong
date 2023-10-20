#!/usr/bin/env bash

store_env_vars() {
  initial_vars=($(compgen -A variable))
}

restore_env_vars() {
  for key in $(compgen -A variable); do
    if ! [[ " ${initial_vars[@]} " =~ " $key " ]]; then
      unset "$key"
    fi
  done
}

store_env_vars
