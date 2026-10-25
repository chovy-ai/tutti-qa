#!/bin/bash
# 模型网关：regress/.env 的 MIDSCENE_* 配置；检查网关可用、模型能看图。不打印 key。
. "$(dirname "$0")/lib.sh"

ENV_FILE="$REPO_ROOT/regress/.env"
if [ ! -f "$ENV_FILE" ]; then
  if applying; then
    cp "$REPO_ROOT/regress/.env.example" "$ENV_FILE" && chmod 600 "$ENV_FILE"
    fixed "已生成 regress/.env" "来自 .env.example"
  else
    manual "缺少 regress/.env" "执行 setup.sh --only 40-model 生成后填写"; exit 0
  fi
fi

get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }
BASE=$(get MIDSCENE_MODEL_BASE_URL); KEY=$(get MIDSCENE_MODEL_API_KEY); MODEL=$(get MIDSCENE_MODEL_NAME)

case "$BASE" in
  http*) ;;
  codex://*) ok "模型走本机 Codex CLI" "$BASE"; exit 0 ;;
  *) manual "MIDSCENE_MODEL_BASE_URL 未配置" "在 $ENV_FILE 填写"; exit 0 ;;
esac
if [ -z "$KEY" ] || [ "$KEY" = "sk-..." ]; then
  manual "MIDSCENE_MODEL_API_KEY 未填写" "在 $ENV_FILE 填写 sub2api 的 key"; exit 0
fi

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -H "Authorization: Bearer $KEY" "$BASE/models" || true)
if [ "$code" = "200" ]; then ok "模型网关可用" "$BASE"
else fail "模型网关不可用" "$BASE/models 返回 ${code:-无响应}，检查 sub2api 是否启动、key 是否正确"; exit 0; fi

# 1x1 红色 PNG，验证模型接受图片输入
IMG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
body=$(printf '{"model":"%s","max_tokens":20,"messages":[{"role":"user","content":[{"type":"text","text":"What color is this image? One word."},{"type":"image_url","image_url":{"url":"data:image/png;base64,%s"}}]}]}' "$MODEL" "$IMG")
resp=$(curl -s --max-time 120 -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "$body" "$BASE/chat/completions" || true)
if printf '%s' "$resp" | grep -qi '"choices"'; then ok "$MODEL 支持图片输入"
else fail "$MODEL 图片输入失败" "$(printf '%s' "$resp" | head -c 200)"; fi
