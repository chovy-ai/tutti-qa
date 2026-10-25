#!/bin/bash
# 账号池配置：~/.tutti-qa/accounts.json（0600，不入库）。一个账号对应一个 ego lite Space。
. "$(dirname "$0")/lib.sh"

F="$QA_HOME/accounts.json"
if [ ! -f "$F" ]; then
  if applying; then
    cp "$SKILL_DIR/templates/accounts.example.json" "$F" && chmod 600 "$F"
    fixed "已生成 $F" "来自模板"
  else
    manual "缺少 $F" "执行 setup.sh --only 60-accounts 生成后填写"; exit 0
  fi
fi

perm=$(stat -f '%Lp' "$F")
if [ "$perm" = "600" ]; then ok "accounts.json 权限 600"
elif applying; then chmod 600 "$F" && fixed "accounts.json 权限改为 600"
else warn "accounts.json 权限是 $perm" "应为 600"; fi

python3 - "$F" "$REPO_ROOT/regress/envs" <<'PY' | while IFS=$'\t' read -r st item detail; do _emit "$st" "$item" "$detail"; done
import json, os, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as e:
    print(f"fail\taccounts.json 不是合法 JSON\t{e}"); sys.exit()
accs = data.get("accounts") or []
if not accs:
    print("manual\taccounts.json 没有账号\t填写 QA 提供的账号"); sys.exit()
names, spaces = set(), set()
for a in accs:
    n = a.get("name") or "?"
    miss = [k for k in ("name", "profile", "space", "env", "roles") if not a.get(k)]
    if miss:
        print(f"fail\t账号 {n}\t缺少字段 {', '.join(miss)}"); continue
    if n in names or a["space"] in spaces:
        print(f"fail\t账号 {n}\tname 或 space 重复"); continue
    if not os.path.isfile(os.path.join(sys.argv[2], f"{a['env']}.json")):
        print(f"fail\t账号 {n}\t环境 {a['env']} 不存在：regress/envs/ 下没有 {a['env']}.json"); continue
    names.add(n); spaces.add(a["space"])
    if "示例" in (a.get("note") or ""):
        print(f"manual\t账号 {n} 还是模板示例\t替换为 QA 提供的真实账号")
    else:
        print(f"ok\t账号 {n}\tprofile {a['profile']} · Space {a['space']} · {a['env']} · {'/'.join(a['roles'])}")
PY
