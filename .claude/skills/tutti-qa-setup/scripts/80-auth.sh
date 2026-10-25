#!/bin/bash
# 外部服务登录：只检查，登录由人完成。
. "$(dirname "$0")/lib.sh"

if has gh && gh auth status >/dev/null 2>&1; then
  if gh api repos/tutti-lab/tutti -q .name >/dev/null 2>&1; then ok "gh 已登录，可读 tutti-lab"
  else manual "gh 无权读取 tutti-lab/tutti" "用有权限的账号执行 gh auth login"; fi
else
  manual "gh 未登录" "执行 gh auth login"
fi

if has tutti-ops; then
  if tutti-ops auth status 2>/dev/null | grep -q '"ok": *true'; then ok "tutti-ops 已登录"
  else manual "tutti-ops 未登录" "执行 tutti-ops auth login（申请新用户登录码需要 access 模块写权限）"; fi
else
  warn "未安装 tutti-ops" "只有需要「全新用户」或跑 regress 时才需要"
fi
