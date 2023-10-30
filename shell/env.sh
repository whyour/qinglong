#!/usr/bin/env bash

store_env_vars() {
  initial_vars=($(env | cut -d= -f1))
}

restore_env_vars() {
  for key in $(env | cut -d= -f1); do
    if ! [[ " ${initial_vars[@]} " =~ " $key " ]]; then
      unset "$key"
    fi
  done
}

store_env_vars
