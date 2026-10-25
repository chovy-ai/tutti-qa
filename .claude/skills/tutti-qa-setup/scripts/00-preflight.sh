#!/bin/bash
# 系统前置检查：只检查，不改动。
. "$(dirname "$0")/lib.sh"

[ "$(uname -s)" = "Darwin" ] && ok "macOS $(sw_vers -productVersion)" || fail "操作系统" "只支持 macOS"
ok "芯片架构 $(uname -m)"

free_gb=$(df -g "$HOME" | awk 'NR==2{print $4}')
if [ "${free_gb:-0}" -ge "$DISK_MIN_GB" ]; then ok "磁盘剩余 ${free_gb}GB"
else fail "磁盘剩余 ${free_gb}GB" "至少需要 ${DISK_MIN_GB}GB"; fi

for url in https://github.com https://tutti.sh https://cdn.ego.app; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" || true)
  if [ "${code:-000}" != "000" ]; then ok "网络 $url"
  else fail "网络 $url" "连不上，检查网络或代理"; fi
done
