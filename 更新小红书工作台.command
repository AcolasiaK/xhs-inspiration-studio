#!/bin/zsh
set -u
umask 077
PROJECT_DIR="${0:A:h}"
PROJECT_TOKEN="$(printf '%s' "$PROJECT_DIR" | shasum -a 256 | cut -c 1-16)"
RUNTIME_DIR="$HOME/Library/Application Support/XHSWorkbench/$PROJECT_TOKEN"
cd "$PROJECT_DIR" || exit 1
echo "请先保存当前内容，并等待正在生成的任务完成。更新会短暂重启服务。"
read -r "?按回车开始构建并检查更新，或关闭窗口取消..."
if [[ ! -x "$RUNTIME_DIR/bin/node" ]]; then
  echo "尚未安装稳定版，请先执行 npm run local:install。"
  exit 1
fi
if "$RUNTIME_DIR/bin/node" "$PROJECT_DIR/scripts/local-service.mjs" update; then
  open "http://127.0.0.1:3000/personal"
else
  read -r "?更新未完成，请查看上方原因。按回车关闭窗口..."
  exit 1
fi
