#!/usr/bin/env bash
# 开发模式下设置 Python venv 环境变量
# 用法: source shell/dev-env.sh（需在项目根目录执行）

export PYTHON_VENV_DIR="${PYTHON_VENV_DIR:-${PWD}/.venv}"

if [[ -f "${PYTHON_VENV_DIR}/bin/python3" ]]; then
  # 仅将 venv 的 bin 加入 PATH，Python 的 venv 机制自动处理包路径
  export PATH="${PYTHON_VENV_DIR}/bin:${PATH}"
  export PIP_CACHE_DIR="${PYTHON_VENV_DIR}/pip"
  mkdir -p "${PIP_CACHE_DIR}"
fi
