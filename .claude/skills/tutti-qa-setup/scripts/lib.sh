#!/bin/bash
# 公共函数：各步骤脚本 source 本文件。
# 结果行写到 $SETUP_RESULTS（setup.sh 汇总），同时打印给人看。
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
QA_HOME="${TUTTI_QA_HOME:-$HOME/.tutti-qa}"
SETUP_MODE="${SETUP_MODE:-apply}"          # check：只检查；apply：检查并补装
SETUP_WITH_REGRESS="${SETUP_WITH_REGRESS:-0}"
SETUP_RESULTS="${SETUP_RESULTS:-/dev/null}"
STEP="${STEP:-$(basename "$0" .sh)}"
# shellcheck source=../config/versions.env
. "$SKILL_DIR/config/versions.env"
export PATH="$HOME/.local/bin:$PATH"       # ego-browser 由 ego lite onboarding 注册在这里

mkdir -p "$QA_HOME"
LOG_FILE="$QA_HOME/setup.log"

_emit() { # status item detail
  printf '%s\t%s\t%s\t%s\n' "$STEP" "$1" "$2" "${3:-}" >>"$SETUP_RESULTS"
  printf "%s [%s] %s %s\t%s\n" "$(date "+%F %T")" "$STEP" "$1" "$2" "${3:-}" >>"$LOG_FILE"
  local mark
  case "$1" in
    ok) mark="✓" ;; fixed) mark="✓" ;; warn) mark="!" ;; manual) mark="✋" ;; fail) mark="✗" ;; *) mark="-" ;;
  esac
  printf '  %s %s%s\n' "$mark" "$2" "${3:+  —  $3}"
}
ok()     { _emit ok "$@"; }
fixed()  { _emit fixed "$@"; }     # 本次补装 / 修复
warn()   { _emit warn "$@"; }      # 不阻塞，只提示
manual() { _emit manual "$@"; }    # 需要人工处理
fail()   { _emit fail "$@"; }

applying() { [ "$SETUP_MODE" = "apply" ]; }
has() { command -v "$1" >/dev/null 2>&1; }

# 版本比较：ver_ge 22.18.0 22.6 → 真
ver_ge() {
  local IFS=.
  local -a a=($1) b=($2)
  local i
  for i in 0 1 2; do
    local x=${a[$i]:-0} y=${b[$i]:-0}
    x=${x%%[!0-9]*}; y=${y%%[!0-9]*}
    (( 10#${x:-0} > 10#${y:-0} )) && return 0
    (( 10#${x:-0} < 10#${y:-0} )) && return 1
  done
  return 0
}

# 运行命令，输出只进日志（避免把 token 等打到终端）
run_logged() { "$@" >>"$LOG_FILE" 2>&1; }
