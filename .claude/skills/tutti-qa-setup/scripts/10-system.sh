#!/bin/bash
# 系统设置：只检查并提示，不改动（不关闭休眠）。
. "$(dirname "$0")/lib.sh"

user=$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || true)
if [ -n "$user" ]; then ok "开机自动登录（$user）"
else warn "开机自动登录未开启" "ego lite 需要图形界面；无人值守时到 系统设置 → 用户与群组 开启"; fi

fv=$(fdesetup status 2>/dev/null | head -1)
case "$fv" in
  *On*) ok "FileVault 已开启" ;;
  *) warn "FileVault 未开启" "账号登录态存在本机，建议开启磁盘加密" ;;
esac
