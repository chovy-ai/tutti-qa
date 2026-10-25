#!/bin/bash
# tutti-qa 执行机初始化入口。可重复执行：已就绪的项跳过，缺什么补什么。
#   setup.sh                 检查并补装全部步骤
#   setup.sh --check         只检查，不改动
#   setup.sh --only 50-ego   只跑某一步（可重复传）
#   setup.sh --with-regress  额外安装 regress 回归所需的 Playwright Chromium
#   setup.sh --json          最后输出 JSON 结果
# 退出码：0 全部就绪；1 有需要人工处理的项；2 有失败项。
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
export SETUP_MODE=apply SETUP_WITH_REGRESS=0
ONLY=() JSON=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) SETUP_MODE=check ;;
    --with-regress) SETUP_WITH_REGRESS=1 ;;
    --only) shift; ONLY+=("${1%.sh}") ;;
    --json) JSON=1 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 64 ;;
  esac
  shift
done

export SETUP_RESULTS; SETUP_RESULTS=$(mktemp)
trap 'rm -f "$SETUP_RESULTS"' EXIT
STEPS=(00-preflight 10-system 20-toolchain 30-repo 40-model 50-ego 60-accounts 70-spaces 80-auth)
[ ${#ONLY[@]} -gt 0 ] && STEPS=("${ONLY[@]}")

out=/dev/stdout; [ "$JSON" = 1 ] && out=/dev/stderr
for s in "${STEPS[@]}"; do
  [ -f "$DIR/$s.sh" ] || { echo "没有步骤 $s" >&2; exit 64; }
  echo "▶ $s" >"$out"
  STEP="$s" bash "$DIR/$s.sh" >"$out" || printf '%s\tfail\t脚本异常退出\t\n' "$s" >>"$SETUP_RESULTS"
done

count() { awk -F'\t' -v s="$1" '$2==s' "$SETUP_RESULTS" | wc -l | tr -d ' '; }
n_fail=$(count fail); n_manual=$(count manual); n_warn=$(count warn)
{
  echo
  echo "结果：失败 ${n_fail} · 需人工 ${n_manual} · 提示 ${n_warn}（模式 ${SETUP_MODE}，日志 ${TUTTI_QA_HOME:-$HOME/.tutti-qa}/setup.log）"
  if [ "$n_manual" -gt 0 ]; then
    echo "需要人工处理："
    awk -F'\t' '$2=="manual"{printf "  [%s] %s：%s\n",$1,$3,$4}' "$SETUP_RESULTS"
  fi
} >"$out"

if [ "$JSON" = 1 ]; then
  python3 - "$SETUP_RESULTS" "$SETUP_MODE" <<'PY'
import json, sys
rows = [l.rstrip("\n").split("\t") for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
items = [{"step": r[0], "status": r[1], "item": r[2], "detail": r[3] if len(r) > 3 else ""} for r in rows]
print(json.dumps({"mode": sys.argv[2], "ready": not any(i["status"] in ("fail", "manual") for i in items), "items": items}, ensure_ascii=False, indent=2))
PY
fi

[ "$n_fail" -gt 0 ] && exit 2
[ "$n_manual" -gt 0 ] && exit 1
exit 0
