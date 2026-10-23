#!/usr/bin/env python3
"""ProcessOn .pos 用例库工具：浏览、搜索、统计、合并、校验、基准 commit 读写。

子命令：
  tree     <pos> [--path A/B/C | --id ID] [--depth N] [--cases]   打印子树（带用例数），--cases 列出用例标题
  search   <pos> KEYWORD [KEYWORD ...] [--limit N]               按标题关键词找节点，输出路径与 id
  stats    <pos> [--path ... | --id ...]                          节点数 / 用例数 / 图标数 / P0-P2 分布
  cases    <pos> (--path ... | --id ...) [--full]                 导出子树下的用例，--full 带前置/操作/预期/备注
  merge    <pos> <spec.json> -o <out.pos>                         按 spec 新增 / 更新 / 删除 / 移动，并更新基准 commit
  validate <before.pos> <after.pos> [--ops <out.pos>.ops.json] [--allow-removed ID,..] [--allow-retitled ID,..]
  baseline get  <pos>                                             读基准 commit（JSON）
  baseline init <pos> --set repo=sha [--set ...] -o <out.pos>     新建基准节点（已存在则报错）

路径用 "/" 分隔，从顶层模块开始（不含根节点）；每段按「去 HTML 后的标题」先全等、再前缀匹配，
所以「正常场景」能匹配到「正常场景（4）」。路径有歧义时报错并列出候选，改用 id。

spec.json 格式（各段都可省略）：
{
  "scope":  {"add": ["房间/文件中心", "游客模式"], "delete": ["活动看板/任务看板（房间内）（草版）"]},
            （授权路径还不存在时，允许在其父节点下新建该模块本身：parent_id 填父节点，节点 title 与路径末段一致；顶层模块的父节点 id 是 root）
  "add":    [ {"parent_path": "...", "nodes": [NODE, ...]}, {"parent_id": "...", "nodes": [...]} ],
  "update": [ {"id": "节点id", "from": "原标题全文", "to": "新标题全文", "reason": "tutti#3425 ..."} ],
  "delete": [ {"id": "节点id", "title": "原标题（校验用，前缀即可）", "reason": "..."} ],
  "move":   [ {"id": "节点id", "new_parent_id": "目标id"} ],
  "baseline": {"tutti-lab/tutti": "<head sha>", "tutti-lab/tsh-web": "<head sha>", "tutti-lab/tutti-server": "<head sha>"},
  "baseline_note": "2026-10-23 批次 20261023-1，Sun"
}
- add 的挂载点必须落在 scope.add 列出的模块子树内，delete 的目标必须落在 scope.delete 子树内，否则拒绝执行；
  QA 没指出的模块不新增、不删除。update 不受 scope 限制（由 commit diff 驱动）。
- update 的 from 必须与当前标题完全一致（防止改错节点），只改 title，不动 id 与 children。
NODE = {"title": "...", "children": [NODE, ...], "collapsed": true?}
用例节点写法（自动转成 前置/操作/预期/备注 子节点）：
  {"case": "🔴【P0】标题", "pre": "...；角色：...；入口：...", "op": "...",
   "expect": ["列表展示 ｜ ...", "副作用 ｜ ..."], "note": "可选"}
merge 同时写出 <out.pos>.ops.json（被删 / 被改的 id 清单），validate --ops 用它放行授权的删改。
"""
import argparse
import collections
import datetime
import json
import re
import sys
import uuid

TAG_RE = re.compile(r"<[^>]+>")
PRIO_RE = re.compile(r"^(🔴|🟠|🟡)?\s*【(P[012])】")
A_LINE_RE = re.compile(r"^\d+\)\s*\S[^｜]*｜\s*\S")


def strip(t):
    return TAG_RE.sub("", (t or "").replace("<br>", "\n")).replace("&nbsp;", " ").strip()


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def save(d, p):
    with open(p, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, separators=(",", ":"))


def root_of(d):
    return d["diagram"]["elements"]


def kids(n):
    return n.get("children") or []


def iter_nodes(n, path=()):
    yield n, path
    for c in kids(n):
        yield from iter_nodes(c, path + (strip(n.get("title")),))


def is_case(n):
    ts = [strip(c.get("title")) for c in kids(n)]
    return any(t.startswith("前置") for t in ts) and any(t.startswith("预期") for t in ts)


def count(n):
    return 1 + sum(count(c) for c in kids(n))


def find_by_path(root, path):
    segs = [s.strip() for s in path.split("/") if s.strip()]
    cur = [root]
    for s in segs:
        nxt = []
        for n in cur:
            exact = [c for c in kids(n) if strip(c.get("title")) == s]
            nxt.extend(exact or [c for c in kids(n) if strip(c.get("title")).startswith(s)])
        if not nxt:
            sys.exit(f"路径段未找到：{s!r}（完整路径 {path!r}）")
        cur = nxt
    if len(cur) > 1:
        msg = "\n".join(f"  {c['id']}  {strip(c.get('title'))[:60]}" for c in cur)
        sys.exit(f"路径有歧义，匹配到 {len(cur)} 个节点，请改用 --id：\n{msg}")
    return cur[0]


def find_by_id(root, nid):
    for n, _ in iter_nodes(root):
        if n.get("id") == nid:
            return n
    sys.exit(f"id 未找到：{nid}")


def pick(root, a):
    if getattr(a, "id", None):
        return find_by_id(root, a.id)
    if getattr(a, "path", None):
        return find_by_path(root, a.path)
    return root


def path_of(root, nid):
    for n, p in iter_nodes(root):
        if n.get("id") == nid:
            return " / ".join(p[1:] + (strip(n.get("title")),))
    return "?"


# ---------- tree / search / stats / cases ----------

def cmd_tree(a):
    root = root_of(load(a.pos))
    start = pick(root, a)

    def show(n, dep):
        t = strip(n.get("title")).split("\n")[0][:80]
        if is_case(n):
            if a.cases:
                print("  " * dep + f"· {t}")
            return
        if dep > a.depth:
            return
        nc = sum(1 for x, _ in iter_nodes(n) if is_case(x))
        print("  " * dep + f"{t}  [用例 {nc}]  ({n.get('id')})")
        for c in kids(n):
            show(c, dep + 1)

    show(start, 0)


def cmd_search(a):
    root = root_of(load(a.pos))
    kws = [k.lower() for k in a.keywords]
    hits = 0
    for n, p in iter_nodes(root):
        t = strip(n.get("title"))
        if all(k in t.lower() for k in kws):
            kind = "用例" if is_case(n) else ("步骤" if re.match(r"^(前置|操作|预期|备注)", t) else "分组")
            line = next((l for l in t.splitlines() if any(k in l.lower() for k in kws)), t.splitlines()[0])
            print(f"[{kind}] {' / '.join(p[1:])}\n    → {line.strip()[:100]}  ({n.get('id')})")
            hits += 1
            if hits >= a.limit:
                print(f"... 已截断（--limit {a.limit}）")
                break
    if not hits:
        print("无匹配")


def stats_of(n):
    s = collections.Counter()
    for x, _ in iter_nodes(n):
        s["节点"] += 1
        s["图标"] += len(x.get("icons") or [])
        if is_case(x):
            s["用例"] += 1
            m = PRIO_RE.match(strip(x.get("title")))
            s[m.group(2) if m else "未定级"] += 1
    return s


def cmd_stats(a):
    root = root_of(load(a.pos))
    s = stats_of(pick(root, a))
    print(json.dumps({k: s.get(k, 0) for k in ["节点", "用例", "图标", "P0", "P1", "P2", "未定级"]}, ensure_ascii=False))


def cmd_cases(a):
    root = root_of(load(a.pos))
    start = pick(root, a)
    for n, p in iter_nodes(start):
        if not is_case(n):
            continue
        print(f"- {strip(n.get('title'))}  ({n['id']})\n  位置：{' / '.join(p)}")
        if a.full:
            for c in kids(n):
                print("    " + strip(c.get("title")).replace("\n", "\n      "))


# ---------- merge ----------

def build(spec_node, parent_id):
    nid = str(uuid.uuid4())
    if "case" in spec_node:
        exp = spec_node["expect"]
        if isinstance(exp, str):
            exp = [exp]
        lines = [e if re.match(r"^\d+\)", e) else f"{i}) {e}" for i, e in enumerate(exp, 1)]
        steps = [("前置：", spec_node["pre"]), ("操作：", spec_node["op"]), ("预期：\n", "\n".join(lines))]
        if spec_node.get("note"):
            steps.append(("备注：", spec_node["note"]))
        children = [{"parent": nid, "callout": [], "children": [], "id": str(uuid.uuid4()), "title": k + v}
                    for k, v in steps]
        node = {"parent": parent_id, "callout": [], "children": children, "collapsed": True,
                "id": nid, "title": spec_node["case"]}
    else:
        node = {"parent": parent_id, "callout": [], "children": [], "id": nid, "title": spec_node["title"]}
        if spec_node.get("collapsed"):
            node["collapsed"] = True
        node["children"] = [build(c, nid) for c in spec_node.get("children", [])]
    return node


BASE_TITLE = "📌 基准 Commit"
BASE_LINE_RE = re.compile(r"^([\w.-]+/[\w.-]+)\s*｜\s*([0-9a-f]{7,40})\b")


def baseline_node(root):
    for c in kids(root):
        if strip(c.get("title")).startswith(BASE_TITLE):
            return c
    return None


def baseline_get(root):
    n = baseline_node(root)
    out = {}
    for c in kids(n) if n else []:
        m = BASE_LINE_RE.match(strip(c.get("title")))
        if m:
            out[m.group(1)] = {"sha": m.group(2), "id": c["id"], "title": strip(c.get("title"))}
    return out


def baseline_line(repo, sha):
    return f"{repo} ｜ {sha} ｜ main ｜ 更新于 {datetime.date.today().isoformat()}"


def baseline_set(root, shas, note):
    """更新基准节点，返回被改标题的节点 id 列表。"""
    n = baseline_node(root)
    if not n:
        sys.exit("宿主库里没有基准节点，先 baseline init")
    cur = baseline_get(root)
    changed = []
    hist = next((c for c in kids(n) if strip(c.get("title")).startswith("更新记录")), None)
    if hist is None:
        hist = {"parent": n["id"], "callout": [], "children": [], "id": str(uuid.uuid4()),
                "title": "更新记录", "collapsed": True}
        n["children"].append(hist)
    moves = []
    for repo, sha in shas.items():
        if repo in cur:
            node = next(c for c in kids(n) if c["id"] == cur[repo]["id"])
            moves.append(f"{repo.split('/')[1]} {cur[repo]['sha'][:10]} → {sha[:10]}")
            node["title"] = baseline_line(repo, sha)
            changed.append(node["id"])
        else:
            # 仓库行放在「说明」之后、「更新记录」之前
            at = next(k for k, c in enumerate(kids(n)) if c["id"] == hist["id"])
            n["children"].insert(at, {"parent": n["id"], "callout": [], "children": [],
                                      "id": str(uuid.uuid4()), "title": baseline_line(repo, sha)})
            moves.append(f"{repo.split('/')[1]} 新增 {sha[:10]}")
    hist["children"].insert(0, {"parent": hist["id"], "callout": [], "children": [], "id": str(uuid.uuid4()),
                                "title": f"{datetime.date.today().isoformat()} ｜ {'；'.join(moves)} ｜ {note or ''}".rstrip(" ｜")})
    return changed


def cmd_baseline(a):
    d = load(a.pos)
    root = root_of(d)
    if a.action == "get":
        print(json.dumps({k: v["sha"] for k, v in baseline_get(root).items()}, ensure_ascii=False, indent=1))
        return
    if baseline_node(root):
        sys.exit("基准节点已存在；更新请走 merge 的 baseline 字段")
    if not a.out:
        sys.exit("init 需要 -o 输出文件")
    nid = str(uuid.uuid4())
    node = {"parent": "root", "callout": [], "id": nid, "collapsed": False,
            "title": f"{BASE_TITLE}（diff 起点，由 tutti-diff-testcase 维护）",
            "children": [{"parent": nid, "callout": [], "children": [], "id": str(uuid.uuid4()),
                          "title": "说明：每行一个仓库，格式「owner/repo ｜ 完整 SHA ｜ 分支 ｜ 更新日期」。下次生成用例从这里记录的 SHA 开始对比 main"}]}
    root["children"].insert(0, node)
    baseline_set(root, dict(x.split("=", 1) for x in a.set), a.note or "初始化")
    save(d, a.out)
    print(f"已写入 {a.out}")
    print(json.dumps({k: v["sha"] for k, v in baseline_get(root).items()}, ensure_ascii=False))


def under(root, node_id, scope_paths):
    p = path_of(root, node_id)
    for sp in scope_paths:
        try:
            target = path_of(root, find_by_path(root, sp)["id"])
        except SystemExit:  # 授权的模块还不存在，由 creates_scoped 处理
            continue
        if p == target or p.startswith(target + " / "):
            return True
    return False


def creates_scoped(root, host, item, scope_paths):
    """QA 授权的模块还不存在时，允许在其父节点下新建这个模块本身（节点标题须与授权路径末段一致）。"""
    for sp in scope_paths:
        segs = [x.strip() for x in sp.split("/") if x.strip()]
        parent = "/".join(segs[:-1])
        try:
            want_parent = find_by_path(root, parent) if parent else root
        except SystemExit:
            continue
        if want_parent["id"] == host["id"] and all(n.get("title") == segs[-1] for n in item["nodes"]):
            return True
    return False


def cmd_merge(a):
    d = load(a.pos)
    root = root_of(d)
    spec = load(a.spec)
    scope = spec.get("scope", {})
    index = {n["id"]: n for n, _ in iter_nodes(root)}
    parent_of = {c["id"]: n for n, _ in iter_nodes(root) for c in kids(n)}
    ops = {"removed": [], "retitled": [], "updated": [], "deleted": [], "added_roots": []}

    # 先做全部前置检查，任何一项不过都不写文件
    errs = []
    hosts = []
    for item in spec.get("add", []):
        host = index.get(item.get("parent_id")) if item.get("parent_id") else find_by_path(root, item["parent_path"])
        if host is None:
            errs.append(f"add 挂载点不存在：{item.get('parent_id')}")
            continue
        if not under(root, host["id"], scope.get("add", [])) and not creates_scoped(root, host, item, scope.get("add", [])):
            errs.append(f"add 挂载点不在 QA 授权的新增范围内：{path_of(root, host['id'])}")
        hosts.append((host, item))
    for u in spec.get("update", []):
        n = index.get(u["id"])
        if n is None:
            errs.append(f"update 节点不存在：{u['id']}")
        elif n.get("title") != u["from"] and strip(n.get("title")) != strip(u["from"]):
            errs.append(f"update 的 from 与当前标题不一致：{u['id']} 当前「{strip(n.get('title'))[:40]}」")
    for x in spec.get("delete", []):
        n = index.get(x["id"])
        if n is None:
            errs.append(f"delete 节点不存在：{x['id']}")
            continue
        if x.get("title") and not strip(n.get("title")).startswith(strip(x["title"])):
            errs.append(f"delete 标题校验不符：{x['id']} 当前「{strip(n.get('title'))[:40]}」")
        if not under(root, n["id"], scope.get("delete", [])):
            errs.append(f"delete 目标不在 QA 授权的删除范围内：{path_of(root, n['id'])}")
    if errs:
        sys.exit("spec 未通过前置检查，未写入任何文件：\n- " + "\n- ".join(errs))

    for u in spec.get("update", []):
        n = index[u["id"]]
        before, where = strip(n.get("title")), path_of(root, u["id"])
        n["title"] = u["to"]
        ops["retitled"].append(u["id"])
        ops["updated"].append({"id": u["id"], "path": where, "from": before,
                               "to": strip(u["to"]), "reason": u.get("reason", "")})
    for x in spec.get("delete", []):
        n = index[x["id"]]
        ops["deleted"].append({"id": n["id"], "path": path_of(root, n["id"]), "nodes": count(n),
                               "reason": x.get("reason", "")})
        ops["removed"].extend(y["id"] for y, _ in iter_nodes(n))
        src = parent_of[n["id"]]
        src["children"] = [c for c in kids(src) if c["id"] != n["id"]]
    added = 0
    for host, item in hosts:
        for sn in item["nodes"]:
            new = build(sn, host["id"])
            host.setdefault("children", []).append(new)
            added += count(new)
            ops["added_roots"].append({"id": new["id"], "path": path_of(root, new["id"])})
    moved = []
    for mv in spec.get("move", []):
        node, dst = index[mv["id"]], index[mv["new_parent_id"]]
        src = parent_of[mv["id"]]
        src["children"] = [c for c in kids(src) if c["id"] != node["id"]]
        node["parent"] = dst["id"]
        dst.setdefault("children", []).append(node)
        moved.append(node["id"])
    if spec.get("baseline"):
        ops["retitled"].extend(baseline_set(root, spec["baseline"], spec.get("baseline_note")))
    save(d, a.out)
    with open(a.out + ".ops.json", "w", encoding="utf-8") as f:
        json.dump(ops, f, ensure_ascii=False, indent=1)
    print(f"已写入 {a.out}：新增节点 {added}，更新 {len(ops['updated'])}，删除子树 {len(ops['deleted'])}"
          f"（{len(ops['removed'])} 个节点），移动 {len(moved)}，基准 {'已更新' if spec.get('baseline') else '未变'}")


# ---------- validate ----------

def cmd_validate(a):
    before, after = root_of(load(a.before)), root_of(load(a.after))
    allow_rm = set(filter(None, (a.allow_removed or "").split(",")))
    allow_rt = set(filter(None, (a.allow_retitled or "").split(",")))
    if a.ops:
        ops = load(a.ops)
        allow_rm |= set(ops.get("removed", []))
        allow_rt |= set(ops.get("retitled", []))
    b = {n["id"]: (n, p) for n, p in iter_nodes(before)}
    ids = collections.Counter()
    parent_err, empty = [], []
    for n, _ in iter_nodes(after):
        ids[n.get("id")] += 1
        for c in kids(n):
            if c.get("parent") != n.get("id"):
                parent_err.append(c.get("id"))
        if not strip(n.get("title")) and not n.get("root") and n.get("id") not in b:
            empty.append(n.get("id"))  # 宿主库存量空标题不算
    an = {n["id"]: n for n, _ in iter_nodes(after)}
    a_parent = {c["id"]: n["id"] for n in an.values() for c in kids(n)}
    b_parent = {c["id"]: n["id"] for n, _ in b.values() for c in kids(n)}
    dup = [i for i, k in ids.items() if k > 1]
    lost = [i for i in b if i not in an]
    retitled = [i for i in b if i in an and an[i].get("title") != b[i][0].get("title")]
    reparented = [i for i in b if i in an and a_parent.get(i) != b_parent.get(i)]
    new_ids = [i for i in an if i not in b]

    # 新引入的同级重名
    new_dup = []
    for n in an.values():
        names = collections.defaultdict(list)
        for c in kids(n):
            names[strip(c.get("title"))].append(c["id"])
        for t, lst in names.items():
            if len(lst) > 1 and any(i not in b for i in lst):
                new_dup.append(f"{t[:40]}（{path_of(after, n['id'])[:60]}）")

    # 新节点的 A 记法 / 定级 / 待确认残留
    a_bad, prio_bad, pending = [], [], []
    new_cases = 0
    updated_ids = [u["id"] for u in (load(a.ops).get("updated", []) if a.ops else [])]
    for i in new_ids + updated_ids:
        n = an[i]
        t = strip(n.get("title"))
        if is_case(n):
            new_cases += 1
            if not PRIO_RE.match(t):
                prio_bad.append(t[:50])
        if t.startswith("预期"):
            raw = n.get("title", "")
            if "<br>" in raw:
                a_bad.append(f"{i}: 使用了 <br>，请用换行")
            lines = t.split("\n")
            body = [l.strip() for l in [lines[0][3:]] + lines[1:] if l.strip()]
            for l in body:
                if not A_LINE_RE.match(l):
                    a_bad.append(f"{i}: {l[:50]}")
        if re.search(r"按产品定义|待确认", t):
            pending.append(f"{t[:50]}")

    sa, sb = stats_of(after), stats_of(before)
    rep = {
        "总量前后": {k: [sb.get(k, 0), sa.get(k, 0)] for k in ["节点", "用例", "图标", "P0", "P1", "P2"]},
        "新增节点数": len(new_ids), "新增用例数": new_cases,
        "重复ID": dup, "parent错": parent_err, "空标题": empty,
        "原节点丢失": [x for x in lost if x not in allow_rm],
        "原节点丢失(已授权)": [x for x in lost if x in allow_rm],
        "原节点标题被改": [x for x in retitled if x not in allow_rt],
        "原节点标题被改(已授权)": [x for x in retitled if x in allow_rt],
        "被重新挂载的原节点": [f"{x}  {strip(an[x].get('title'))[:40]}" for x in reparented],
        "新引入的重名": new_dup, "A记法问题": a_bad, "新用例缺优先级": prio_bad,
        "新节点残留待确认字样": pending,
    }
    print(json.dumps(rep, ensure_ascii=False, indent=2))
    hard = dup or parent_err or empty or rep["原节点丢失"] or rep["原节点标题被改"] or new_dup or a_bad or prio_bad
    sys.exit(1 if hard else 0)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)

    def loc(p):
        p.add_argument("--path")
        p.add_argument("--id")

    p = sp.add_parser("tree"); p.add_argument("pos"); loc(p)
    p.add_argument("--depth", type=int, default=3); p.add_argument("--cases", action="store_true")
    p.set_defaults(f=cmd_tree)
    p = sp.add_parser("search"); p.add_argument("pos"); p.add_argument("keywords", nargs="+")
    p.add_argument("--limit", type=int, default=40); p.set_defaults(f=cmd_search)
    p = sp.add_parser("stats"); p.add_argument("pos"); loc(p); p.set_defaults(f=cmd_stats)
    p = sp.add_parser("cases"); p.add_argument("pos"); loc(p); p.add_argument("--full", action="store_true")
    p.set_defaults(f=cmd_cases)
    p = sp.add_parser("merge"); p.add_argument("pos"); p.add_argument("spec"); p.add_argument("-o", "--out", required=True)
    p.set_defaults(f=cmd_merge)
    p = sp.add_parser("validate"); p.add_argument("before"); p.add_argument("after")
    p.add_argument("--ops"); p.add_argument("--allow-removed"); p.add_argument("--allow-retitled")
    p.set_defaults(f=cmd_validate)
    p = sp.add_parser("baseline"); p.add_argument("action", choices=["get", "init"]); p.add_argument("pos")
    p.add_argument("--set", action="append", default=[], help="repo=sha"); p.add_argument("--note")
    p.add_argument("-o", "--out"); p.set_defaults(f=cmd_baseline)
    a = ap.parse_args()
    a.f(a)


if __name__ == "__main__":
    main()
