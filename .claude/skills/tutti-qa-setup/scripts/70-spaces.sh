#!/bin/bash
# 每个账号：一个 ego lite profile（Cookie 隔离单位，只能在应用里手动创建）+ 一个同名 Space。
# 同一 profile 下的 Space 共用 Cookie，所以不同账号必须放在不同 profile。
# 检查 profile 是否存在、Space 是否就绪、该账号是否已登录目标环境。登录由人在 Space 里完成。
. "$(dirname "$0")/lib.sh"

F="$QA_HOME/accounts.json"
has ego-browser || { manual "ego-browser 不可用" "先完成 50-ego"; exit 0; }
[ -f "$F" ] || { manual "缺少 accounts.json" "先完成 60-accounts"; exit 0; }

# 账号与环境入口（只取非敏感字段）
plan=$(python3 - "$F" "$REPO_ROOT/regress/envs" 2>>"$LOG_FILE" <<'PY'
import json, os, sys
accs = json.load(open(sys.argv[1], encoding="utf-8")).get("accounts") or []
out = []
for a in accs:
    if "示例" in (a.get("note") or ""):
        continue
    f = os.path.join(sys.argv[2], f"{a.get('env')}.json")
    if not os.path.isfile(f):
        continue  # 60-accounts 已报错
    env = json.load(open(f, encoding="utf-8"))
    out.append({"name": a["name"], "space": a["space"], "profile": a.get("profile") or a["name"], "url": env["webUrl"]})
print(json.dumps(out, ensure_ascii=False))
PY
) || { fail "读取 accounts.json 失败"; exit 0; }
[ "$plan" = "[]" ] && { manual "没有可用账号" "先在 accounts.json 填写真实账号"; exit 0; }

script=$(mktemp)
trap 'rm -f "$script"' EXIT
# ego-browser nodejs 不继承调用方的环境变量，参数直接写进脚本
{ printf 'const plan = %s;\nconst apply = %s;\n' "$plan" "$([ "$SETUP_MODE" = apply ] && echo true || echo false)"; cat; } >"$script" <<'JS'
const profs = await profiles();
const spaces = await listTaskSpaces();
const line = (...cols) => console.log(["QA-RESULT", ...cols].join("\t"));
for (const a of plan) {
  const prof = profs.find((p) => p.name === a.profile || p.id === a.profile);
  if (!prof) {
    line("manual", `账号 ${a.name}：缺少 profile「${a.profile}」`, "在 ego lite 里新建同名 profile（每个账号一个，Cookie 才隔离）");
    continue;
  }
  const existing = spaces.find((s) => s.name === a.space);
  if (!existing && !apply) {
    line("manual", `账号 ${a.name}：Space「${a.space}」不存在`, "执行 setup.sh --only 70-spaces");
    continue;
  }
  try {
    // 上次检查结束后 Space 交还给了用户（方便人工登录），这次需要重新认领
    const task = !existing
      ? await taskSpace(a.space, { profileId: prof.id })
      : existing.ownership === "user" ? await claimTaskSpace(existing.id) : await taskSpace(existing.id);
    // 认领后原页面是未托管的标签页，先接管；没有就新开
    let page = (await task.pages())[0];
    if (!page) {
      const tab = (await task.tabs())[0];
      page = tab ? await task.adopt(tab.page) : await task.newPage();
    }
    await page.goto(a.url);
    await page.waitForLoadState("networkidle").catch(() => {});
    const url = await page.url();
    const loggedIn = url.startsWith(a.url) && !/login|sign-?in|auth/i.test(url);
    if (loggedIn) line("ok", `账号 ${a.name}：已登录`, `Space ${task.spaceId} · profile ${prof.name}`);
    else line("manual", `账号 ${a.name}：未登录`, `在 ego lite 的 Space「${a.space}」里手动登录一次（${a.url}）`);
    // 保留页面并交还给用户：未登录时人直接在这个页面登录
    await task.finish({ keep: [page.label] });
  } catch (e) {
    line("fail", `账号 ${a.name}：Space 检查出错`, String(e.message || e).split("\n")[0]);
  }
}
JS

# ego-browser nodejs 把 console.log 输出到 stderr；结果行带 QA-RESULT 前缀，其余输出进日志
raw=$(ego-browser nodejs <"$script" 2>&1) || fail "Space 检查脚本出错" "见 $LOG_FILE"
printf '%s\n' "$raw" | grep -v '^QA-RESULT' >>"$LOG_FILE"
while IFS=$'\t' read -r _ st item detail; do
  _emit "$st" "$item" "$detail"
done < <(printf '%s\n' "$raw" | grep '^QA-RESULT')
