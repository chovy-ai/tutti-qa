#!/bin/bash
# 仓库依赖：regress 的 node 依赖；--with-regress 时再装 Playwright Chromium。
. "$(dirname "$0")/lib.sh"

R="$REPO_ROOT/regress"
[ -f "$R/package.json" ] || { fail "找不到 regress/" "$R"; exit 0; }
has pnpm || { manual "regress 依赖" "先装好 pnpm（见 20-toolchain）"; exit 0; }

if [ -d "$R/node_modules" ] && [ "$R/node_modules/.modules.yaml" -nt "$R/pnpm-lock.yaml" ]; then
  ok "regress 依赖已安装"
elif applying; then
  (cd "$R" && run_logged pnpm install --frozen-lockfile) && fixed "regress 依赖" "pnpm install" || fail "regress 依赖" "pnpm install 失败，见 $LOG_FILE"
else
  manual "regress 依赖未安装或已过期" "执行 setup.sh --only 30-repo"
fi

if [ "$SETUP_WITH_REGRESS" = "1" ]; then
  exe=$(cd "$R" && node -e 'try{console.log(require("playwright").chromium.executablePath())}catch{}' 2>/dev/null)
  if [ -n "$exe" ] && [ -x "$exe" ]; then ok "Playwright Chromium"
  elif applying; then
    (cd "$R" && run_logged pnpm exec playwright install chromium) && fixed "Playwright Chromium" || fail "Playwright Chromium" "安装失败，见 $LOG_FILE"
  else manual "Playwright Chromium 未安装" "加 --with-regress 重跑"; fi
fi
