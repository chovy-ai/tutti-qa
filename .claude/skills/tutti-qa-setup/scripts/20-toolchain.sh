#!/bin/bash
# 工具链：只检查，不安装（不依赖 Homebrew）。缺少时给出安装方式，由人处理。
. "$(dirname "$0")/lib.sh"

need() { # 命令 用途 安装提示
  if has "$1"; then ok "$1" "$2"; else manual "缺少 $1（$2）" "$3"; fi
}

need git "拉取仓库" "执行 xcode-select --install"
need curl "下载 ego lite" "macOS 自带，检查 PATH"
need gh "tutti-diff-testcase 读取 PR / diff" "从 https://cli.github.com 下载安装包"

if has python3; then
  v=$(python3 -c 'import sys;print("%d.%d.%d"%sys.version_info[:3])')
  ver_ge "$v" "$PYTHON_MIN" && ok "python3 $v" || manual "python3 $v 过旧" "需要 ≥ $PYTHON_MIN，执行 xcode-select --install 或从 python.org 安装"
else
  manual "缺少 python3" "执行 xcode-select --install"
fi

if has node; then
  v=$(node -p 'process.versions.node')
  ver_ge "$v" "$NODE_MIN" && ok "node $v" || manual "node $v 过旧" "需要 ≥ $NODE_MIN（regress 直接运行 .ts），从 https://nodejs.org 安装 LTS"
else
  manual "缺少 node" "从 https://nodejs.org 安装 LTS（≥ $NODE_MIN）"
fi

if has pnpm; then ok "pnpm $(pnpm -v)"
elif has corepack && applying && run_logged corepack enable pnpm && has pnpm; then fixed "pnpm $(pnpm -v)" "已通过 corepack 启用"
else manual "缺少 pnpm" "执行 corepack enable pnpm（Node 自带）"; fi
