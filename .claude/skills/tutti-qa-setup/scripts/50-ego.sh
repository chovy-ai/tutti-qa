#!/bin/bash
# ego lite：安装应用（用上游锁定 tag 的 install.sh）→ 人工完成 onboarding → 校验 ego-browser 命令
# → 给 Claude Code / Codex 安装 ego-browser skill。
. "$(dirname "$0")/lib.sh"

find_app() {
  for p in "/Applications/ego lite.app" "$HOME/Applications/ego lite.app"; do
    [ -d "$p" ] && { echo "$p"; return 0; }
  done
  return 1
}

if app=$(find_app); then
  ok "ego lite 已安装" "$app"
elif applying; then
  tmp=$(mktemp -d)
  url="https://raw.githubusercontent.com/citrolabs/ego-lite/$EGO_LITE_TAG/skills/ego-browser/scripts/install.sh"
  if curl -fsSL --retry 3 "$url" -o "$tmp/install.sh" && run_logged sh "$tmp/install.sh"; then
    fixed "ego lite 已安装并启动" "$(find_app)"
  else
    fail "ego lite 安装失败" "见 $LOG_FILE"
  fi
  rm -rf "$tmp"
else
  manual "ego lite 未安装" "执行 setup.sh --only 50-ego"
fi

if has ego-browser; then
  ok "ego-browser 命令" "$(command -v ego-browser)"
  if out=$(ego-browser nodejs <<<"console.log('ego-browser ready')" 2>&1) && [[ "$out" == *"ego-browser ready"* ]]; then
    ok "ego-browser 运行时可用"
  else
    fail "ego-browser 运行时不可用" "确认 ego lite 正在运行；输出：${out:0:120}"
  fi
  if ego-browser skill 2>/dev/null | grep -q '\[ego-browser:skill\] end of guide'; then ok "ego-browser skill 用法说明"
  else manual "ego-browser 版本过旧" "经确认后执行 ego-browser upgrade"; fi
else
  manual "ego-browser 命令不可用" "打开 ego lite 完成首次引导（onboarding），引导会把命令注册到 ~/.local/bin"
fi

# Agent 侧的 ego-browser skill（全局安装给 Claude Code 与 Codex）
installed=1
for d in "$HOME/.claude/skills/ego-browser" "$HOME/.agents/skills/ego-browser"; do
  [ -f "$d/SKILL.md" ] || installed=0
done
if [ "$installed" = "1" ]; then ok "Agent 已安装 ego-browser skill"
elif applying; then
  src="https://github.com/citrolabs/ego-lite/tree/$EGO_LITE_TAG/skills/ego-browser"
  (cd "$QA_HOME" && run_logged npx -y skills add "$src" -g -y -a claude-code -a codex) \
    && fixed "Agent 已安装 ego-browser skill" "$EGO_LITE_TAG" \
    || fail "ego-browser skill 安装失败" "见 $LOG_FILE"
else
  manual "Agent 未安装 ego-browser skill" "执行 setup.sh --only 50-ego"
fi
