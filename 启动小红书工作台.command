#!/bin/zsh
set -u
umask 077
PROJECT_DIR="${0:A:h}"
PROJECT_TOKEN="$(printf '%s' "$PROJECT_DIR" | shasum -a 256 | cut -c 1-16)"
RUNTIME_DIR="$HOME/Library/Application Support/XHSWorkbench/$PROJECT_TOKEN"

# Finder uses the installed Node; no dependency on nvm or a terminal profile.
if [[ ! -x "$RUNTIME_DIR/bin/node" ]]; then
  echo "首次使用需在项目目录执行 npm run local:install。"
  read -r "?按回车关闭窗口..."
  exit 1
fi
if "$RUNTIME_DIR/bin/node" "$RUNTIME_DIR/tools/local-service.mjs" start; then
  open "http://127.0.0.1:3000/personal"
else
  echo "未删除缓存、数据或终止其他服务。"
  read -r "?按回车关闭窗口..."
  exit 1
fi
