#!/bin/sh
# Only these code/config paths are packaged. No local .env, drafts or caches.
set -eu
out=${1:-/tmp/xhs-cloudbase-source.tgz}
if [ -e "$out" ]; then printf '%s\n' '目标文件已存在，请指定一个新文件名。' >&2; exit 1; fi
umask 077
LC_ALL=C tar -czf "$out" --exclude='.env*' --exclude='*/.env*' --exclude='.npmrc' --exclude='*/.npmrc' --exclude='.yarnrc*' --exclude='*/.yarnrc*' --exclude='.git' --exclude='*/.git' --exclude='.local-data' --exclude='*/.local-data' --exclude='.cloud-dev' --exclude='*/.cloud-dev' --exclude='.next' --exclude='*/.next' --exclude='.codex' --exclude='*/.codex' --exclude='.agents' --exclude='*/.agents' --exclude='node_modules' --exclude='*/node_modules' --exclude='test-results' --exclude='*/test-results' --exclude='*.sqlite*' --exclude='*.db' --exclude='*.pem' --exclude='*.key' --exclude='*.p12' --exclude='*.pfx' --exclude='credentials*.json' --exclude='service-account*.json' --exclude='*.log' app components lib deployment vendor instrumentation.ts package.json package-lock.json next.config.ts tsconfig.json postcss.config.mjs Dockerfile .dockerignore scripts/cloud-secrets.mjs
printf '已创建部署源码包：%s\n' "$out"
