#!/usr/bin/env python3
"""从平台模块的 syncBaseline 快照起，收集各仓库 main 上的变更，生成待分析的 changes.json。

用法：
  python3 collect_changes.py --out output/<batch>/changes.json --baseline output/<batch>/baselines.json \
      [--repo tutti-lab/tutti ...] [--head tutti-lab/tutti=<sha> ...] [--cache ~/.cache/tutti-qa/repos]

- 基准来自 case_tool.py baseline get；每仓库按 main 的 first-parent 祖先关系取所选模块最旧 SHA，缺失或分叉即停止。
- head 默认是收集时刻 origin/main 的 SHA，写进 changes.json，后续合并后基准就更新到这个 SHA（不是更新时的最新 main）。
- 以 main 的 first-parent 为单位列条目：一个 PR 的 merge commit 或 squash commit 算一条。
- PR 标题、描述、标签走 gh；文件列表与行数走本地 blobless clone（首次自动 clone 到 --cache）。
- 每条给出：可能影响的模块（references/module-map.json 初判）、是否噪音（默认不勾选）及原因。
  impact（一句话的用例影响判断）留空，由 agent 读过 PR 后补上再渲染确认页。
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

MAP = os.path.join(HERE, "..", "references", "module-map.json")
PR_RE = re.compile(r"Merge pull request #(\d+)|\(#(\d+)\)\s*$")
TYPE_RE = re.compile(r"^(\w+)(\([^)]*\))?!?:")


def sh(*args, cwd=None):
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"命令失败：{' '.join(args)}\n{r.stderr.strip()}")
    return r.stdout


def ensure_clone(repo, cache):
    path = os.path.join(cache, repo.split("/")[1])
    if not os.path.isdir(path):
        os.makedirs(cache, exist_ok=True)
        sh("git", "clone", "-q", "--filter=blob:none", "--no-checkout", f"https://github.com/{repo}.git", path)
    sh("git", "fetch", "-q", "origin", "main", cwd=path)
    return path


def load_map():
    with open(MAP, encoding="utf-8") as f:
        return json.load(f)


def oldest_baseline(path, shas, head):
    """Timestamps need not be monotonic. Every baseline must be on head's first-parent chain."""
    chain = {sha: i for i, sha in enumerate(sh("git", "rev-list", "--first-parent", head, cwd=path).splitlines())}
    missing = set(shas) - set(chain)
    if missing:
        sys.exit(f"基准不在 head 的 main first-parent 历史中，停止（可能回退、分叉或选错 head）：{sorted(missing)}")
    return max(shas, key=chain.__getitem__)


def module_baselines(data, mids=None):
    from case_tool import baseline_repos
    mods = data.get("modules") or {}
    selected = mids or list(mods)
    if not selected or any(mid not in mods for mid in selected):
        sys.exit("基准快照缺少指定模块，请重新 baseline get")
    repos = {}
    for mid in selected:
        current = mods[mid].get("syncBaseline")
        if not current:
            sys.exit(f"模块 {mid} 缺少 syncBaseline，先初始化")
        repos[mid] = baseline_repos(current.get("repos"))
    names = set().union(*(set(r) for r in repos.values()))
    if any(set(r) != names for r in repos.values()):
        sys.exit("模块的仓库基准不完整，请先补齐；不能只忽略缺失项")
    return {repo: {mid: repos[mid][repo]["sha"] for mid in selected} for repo in sorted(names)}


def match_noise_path(p, pats):
    for pat in pats:
        # 以 / 开头或形如 .test. 的按子串匹配，其余按路径前缀匹配
        if pat.startswith("/") or (pat.startswith(".") and not pat.endswith("/")):
            if pat in "/" + p:
                return True
        elif p.startswith(pat):
            return True
    return False


def classify(repo, title, files, m):
    rules = [r for r in m["rules"] if r["repo"] == repo]
    mods = []
    for f in files:
        for r in rules:
            if f.startswith(r["prefix"]):
                for x in r["modules"]:
                    if x not in mods:
                        mods.append(x)
    # Merge pull request 的标题看第二行（分支名）不可靠，用 PR 标题判断类型
    t = TYPE_RE.match(title or "")
    noise_reason = ""
    if t:
        typ, scope = t.group(1).lower(), (t.group(2) or "").lower()
        if typ + scope in m["noise"]["title_types"] or typ in m["noise"]["title_types"]:
            noise_reason = f"提交类型 {typ}{scope}"
    if not noise_reason and files and all(match_noise_path(f, m["noise"]["paths"]) for f in files):
        noise_reason = "只改了测试 / 工具 / 文档 / 构建文件"
    real = [x for x in mods if not x.startswith("(无用例模块")]
    if not noise_reason and mods and not real:
        noise_reason = "只涉及库中没有的模块：" + "、".join(x[7:-1] for x in mods)
    if not mods:
        mods = ["(未映射，需人工判断)"]  # 未映射不等于无感知，保持候选，由 agent 研判时决定
    return mods, noise_reason


def fetch_prs(repo, since_iso):
    out = sh("gh", "pr", "list", "-R", repo, "--state", "merged", "--base", "main", "--limit", "1000",
             "--search", f"merged:>={since_iso[:10]}",
             "--json", "number,title,body,labels,author,url,mergeCommit,mergedAt,additions,deletions")
    prs = json.loads(out)
    return {p["number"]: p for p in prs}, {(p.get("mergeCommit") or {}).get("oid"): p for p in prs}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", required=True, help="baseline get 生成的平台模块快照")
    ap.add_argument("--modules", nargs="+", help="只收集这些模块的基准，默认快照内全部模块")
    ap.add_argument("--out", required=True)
    ap.add_argument("--repo", action="append", help="只收集指定仓库，默认基准节点里的全部仓库")
    ap.add_argument("--head", action="append", default=[], help="repo=sha，固定 head；默认 origin/main")
    ap.add_argument("--cache", default=os.path.expanduser("~/.cache/tutti-qa/repos"))
    a = ap.parse_args()

    with open(a.baseline, encoding="utf-8") as f:
        baseline = json.load(f)
    base = module_baselines(baseline, a.modules)
    repos = a.repo or list(base)
    heads = dict(h.split("=", 1) for h in a.head)
    m = load_map()
    result = {"batch": os.path.basename(os.path.dirname(os.path.abspath(a.out))),
              "generated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
              "baseline": a.baseline, "brand_id": baseline["brand_id"], "baseline_modules": baseline["modules"],
              "repos": {}, "items": [], "scope": {"add": [], "update": "auto", "delete": []}}

    for repo in repos:
        if repo not in base:
            sys.exit(f"{a.baseline} 里没有 {repo}，先为平台模块补齐基准")
        path = ensure_clone(repo, a.cache)
        h = heads.get(repo) or sh("git", "rev-parse", "origin/main", cwd=path).strip()
        if not re.fullmatch(r"[0-9a-f]{40}", h):
            sys.exit(f"head 须为 40 位完整 SHA：{h}")
        oldest_baseline(path, [h], "origin/main")
        b = oldest_baseline(path, list(base[repo].values()), h)
        b_date = sh("git", "show", "-s", "--format=%cI", b, cwd=path).strip()
        result["repos"][repo] = {"base": b, "head": h, "base_date": b_date, "module_bases": base[repo]}
        by_num, by_oid = fetch_prs(repo, b_date)
        log = sh("git", "log", "--first-parent", "--reverse", "--format=%H%x1f%P%x1f%an%x1f%cI%x1f%s",
                 f"{b}..{h}", cwd=path)
        for line in filter(None, log.split("\n")):
            sha, parents, author, date, subject = line.split("\x1f")
            parent = parents.split()[0]
            mm = PR_RE.search(subject)
            num = int(mm.group(1) or mm.group(2)) if mm else None
            pr = by_oid.get(sha) or (by_num.get(num) if num else None)
            title = pr["title"] if pr else subject
            names = sh("git", "diff", "--name-only", parent, sha, cwd=path).split()
            if pr:  # 行数取 PR 接口的值；blobless clone 本地算 diff 统计要逐个拉文件内容，很慢
                add, dele = pr.get("additions", 0), pr.get("deletions", 0)
            else:
                stat = sh("git", "diff", "--shortstat", parent, sha, cwd=path)
                add = int((re.search(r"(\d+) insertion", stat) or [0, 0])[1])
                dele = int((re.search(r"(\d+) deletion", stat) or [0, 0])[1])
            mods, noise = classify(repo, title, names, m)
            short = repo.split("/")[1]
            result["items"].append({
                "key": f"{short}@{sha[:10]}", "repo": repo, "sha": sha, "parent": parent,
                "pr": pr["number"] if pr else num, "url": pr["url"] if pr else f"https://github.com/{repo}/commit/{sha}",
                "title": title, "author": (pr or {}).get("author", {}).get("login") or author, "date": date,
                "labels": [l["name"] for l in (pr or {}).get("labels", [])],
                "body": ((pr or {}).get("body") or "")[:1500],
                "files": names, "add": add, "del": dele,
                "modules": mods, "noise": noise, "impact": "", "checked": not noise,
            })
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    n = len(result["items"])
    c = sum(1 for i in result["items"] if i["checked"])
    for r, v in result["repos"].items():
        print(f"{r}: {v['base'][:10]}..{v['head'][:10]}")
    print(f"共 {n} 条，候选 {c} 条，噪音 {n - c} 条 → {a.out}")


if __name__ == "__main__":
    main()
