#!/usr/bin/env python3
"""用例管理平台（tutti-ops test-management）上的用例库维护工具。

用法：
  case_tool.py baseline get   [--file baseline/commits.json]                     读基准 commit（JSON）
  case_tool.py baseline set   <spec.confirmed.json> --verified <verify.json>     按 spec.baseline 前移基准（需回读核对通过）
  case_tool.py modules        [--search 关键词]                                   列平台模块：id ｜ 用例数 ｜ 名称
  case_tool.py pull <模块id>... --out <dir>                                      导出模块完整 JSON 作为本批快照
  case_tool.py validate <spec.json> --snapshot <dir>                              本地校验（不发请求）
  case_tool.py apply <spec.confirmed.json> --snapshot <dir> [--yes]               默认只做 tutti-ops --dry-run；--yes 才写入
  case_tool.py verify <spec.confirmed.json> --snapshot <dir> --out <dir>          重新导出并核对每条改动已生效

spec 格式：
{
  "brand_id": "233749",
  "scope": {"add": ["<模块id>", "<模块id>/<group 前缀>"], "delete": [...]},
  "modules": [{"id": "...", "name": "...", "description": "..."}],     # 仅新建模块时填，id 须在 scope.add 内
  "create": [{"id", "moduleId", "title", "category", "group", "scene", "priority", "kind",
              "precondition", "steps": [...], "expectations": [...], "note", "references": [...]}],
  "update": [{"id": "...", "reason": "<repo>#<PR> 变更点", "case": {完整用例字段，同 create}}],
  "archive": [{"id": "...", "reason": "..."}],
  "baseline": {"tutti-lab/tutti": "<head sha>", ...},                   # 可选，见 SKILL.md 第 6 步
  "baseline_note": "批次 <batch>，已分析 N 条变更，Sun"
}

- 新增 / 归档只能落在 scope.add / scope.delete 范围内，越界则整份 spec 拒绝。
- 更新只改已有用例的内容，不能改 moduleId（不挪模块），revision 取自快照（乐观锁）。
- 归档是平台的软删除（archived=true），可在平台上恢复。
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
BASELINE = os.path.join(REPO_ROOT, "baseline", "commits.json")
BRAND = "233749"

AUTHORED = ("id", "moduleId", "title", "category", "group", "scene", "priority", "kind",
            "precondition", "steps", "expectations", "note", "references")
SCENES = ("正常场景", "异常场景", "边界场景")
PRIOS = ("P0", "P1", "P2")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
A_RE = re.compile(r"^(\d+)\) \S.*? ｜ \S")
PRIO_PREFIX_RE = re.compile(r"^\s*(🔴|🟠|🟡)?\s*【P\d】")
PENDING_RE = re.compile(r"按产品定义|待确认|待补充")
IMPORT_LIMIT = 1000


# ---------- tutti-ops ----------

def ops(*args, data=None, mode=None, tmp=None):
    """调用 tutti-ops，返回 (退出码, 解析后的 JSON 或原文)。mode: None=读，"dry"=--dry-run，"yes"=--yes。"""
    cmd = ["tutti-ops", "--json", *args]
    if data is not None:
        tmp = tmp or tempfile.mkdtemp(prefix="case-tool-")
        os.makedirs(tmp, exist_ok=True)
        path = os.path.join(tmp, f"req-{len(os.listdir(tmp)):04d}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        cmd += ["--data", "@" + path]
    if mode == "dry":
        cmd.append("--dry-run")
    elif mode == "yes":
        cmd.append("--yes")
    r = subprocess.run(cmd, capture_output=True, text=True)
    try:
        out = json.loads(r.stdout)
    except ValueError:
        out = {"ok": False, "stdout": r.stdout.strip(), "stderr": r.stderr.strip()}
    if r.returncode and isinstance(out, dict):
        out.setdefault("stderr", r.stderr.strip())
    return r.returncode, out


def ops_read(*args):
    code, out = ops(*args)
    if code or not out.get("ok"):
        sys.exit(f"tutti-ops {' '.join(args)} 失败（退出码 {code}）：{json.dumps(out, ensure_ascii=False)[:800]}")
    return out


# ---------- 快照 ----------

def load_snapshot(d):
    """读取 pull 产出的快照：{moduleId: {"module": {...}, "cases": {id: case}}}。"""
    mods = {}
    meta_path = os.path.join(d, "modules.json")
    meta = {}
    if os.path.exists(meta_path):
        with open(meta_path, encoding="utf-8") as f:
            meta = {m["id"]: m for m in json.load(f)}
    for name in sorted(os.listdir(d)):
        if not name.endswith(".json") or name == "modules.json":
            continue
        mid = name[:-5]
        with open(os.path.join(d, name), encoding="utf-8") as f:
            cases = json.load(f)["cases"]
        mods[mid] = {"module": meta.get(mid, {"id": mid}), "cases": {c["id"]: c for c in cases}}
    if not mods:
        sys.exit(f"快照目录 {d} 里没有模块，先 case_tool.py pull")
    return mods


def all_cases(snap):
    return {cid: c for m in snap.values() for cid, c in m["cases"].items()}


def module_name(snap, spec, mid):
    for m in spec.get("modules", []):
        if m["id"] == mid:
            return m["name"]
    return snap.get(mid, {}).get("module", {}).get("name") or mid


# ---------- 子命令 ----------

def cmd_baseline(a):
    path = a.file or BASELINE
    if a.action == "get":
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        print(json.dumps({k: v["sha"] for k, v in data["repos"].items()}, ensure_ascii=False, indent=1))
        return
    if not a.spec or not a.verified:
        sys.exit("baseline set 需要 <spec.confirmed.json> 和 --verified <verify.json>")
    spec = json.load(open(a.spec, encoding="utf-8"))
    ver = json.load(open(a.verified, encoding="utf-8"))
    if not ver.get("ok"):
        sys.exit("回读核对未通过，不前移基准")
    if ver.get("spec_hash") != file_hash(a.spec):
        sys.exit("verify 结果与当前 spec.confirmed.json 不对应，重新 verify")
    shas = spec.get("baseline") or {}
    if not shas:
        sys.exit("spec 里没有 baseline 字段：本批不前移基准")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    today = datetime.date.today().isoformat()
    old = {k: v["sha"] for k, v in data["repos"].items()}
    for repo, sha in shas.items():
        if not SHA_RE.match(sha):
            sys.exit(f"{repo} 的 SHA 不是 40 位完整 SHA：{sha}")
        data["repos"][repo] = {"sha": sha, "branch": "main", "updated": today}
    data.setdefault("history", []).append({"date": today, "note": spec.get("baseline_note", ""),
                                           "from": {k: old.get(k) for k in shas}, "to": shas})
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")
    for repo, sha in shas.items():
        print(f"{repo}: {(old.get(repo) or '（无）')[:10]} → {sha[:10]}")


def cmd_modules(a):
    out = ops_read("test-management", "modules", "list", "--brand-id", a.brand, "--page-all", "--page-limit", "10")
    if out.get("meta", {}).get("complete") is not True:
        print("警告：模块列表可能不完整（meta.complete 不为 true）", file=sys.stderr)
    for m in out["data"]["items"]:
        if a.search and a.search not in m["name"] and a.search not in m["id"]:
            continue
        print(f"{m['id']} ｜ {m['caseCount']} ｜ {m['name']}")


def cmd_pull(a):
    os.makedirs(a.out, exist_ok=True)
    listed = ops_read("test-management", "modules", "list", "--brand-id", a.brand, "--page-all", "--page-limit", "10")
    by_id = {m["id"]: m for m in listed["data"]["items"]}
    meta = []
    for mid in a.modules:
        if mid not in by_id:
            sys.exit(f"平台上没有模块 {mid}；用 case_tool.py modules --search 查候选")
        dst = os.path.join(a.out, mid + ".json")
        out = ops_read("test-management", "+export", "--brand-id", a.brand, "--module-id", mid,
                       "--output", dst, "--overwrite", "true")
        m = dict(by_id[mid], exportedVersion=out["data"].get("version"))
        meta.append({k: m.get(k) for k in ("id", "name", "description", "caseCount", "revision", "exportedVersion")})
        print(f"{mid} ｜ {m['name']} ｜ {out['data'].get('caseCount')} 条 ｜ 版本 {out['data'].get('version')} → {dst}")
    old = []
    meta_path = os.path.join(a.out, "modules.json")
    if os.path.exists(meta_path):
        old = [m for m in json.load(open(meta_path, encoding="utf-8")) if m["id"] not in a.modules]
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(old + meta, f, ensure_ascii=False, indent=1)


def in_scope(scope_list, mid, group):
    for s in scope_list:
        smid, _, prefix = s.partition("/")
        if smid == mid and (not prefix or (group or "").startswith(prefix)):
            return True
    return False


def check_case(c, where, errs):
    for k in ("id", "moduleId", "title", "category", "group", "scene", "priority"):
        if not str(c.get(k) or "").strip():
            errs.append(f"{where}：缺少 {k}")
    extra = set(c) - set(AUTHORED)
    if extra:
        errs.append(f"{where}：不允许的字段 {sorted(extra)}（revision / archived / 审计字段由工具处理）")
    if c.get("id") and not ID_RE.match(c["id"]):
        errs.append(f"{where}：id 只能是 1–128 位字母、数字、_、-")
    if c.get("priority") and c["priority"] not in PRIOS:
        errs.append(f"{where}：priority 须为 P0 / P1 / P2")
    if c.get("scene") and c["scene"] not in SCENES:
        errs.append(f"{where}：scene 须为 {' / '.join(SCENES)}")
    if PRIO_PREFIX_RE.match(c.get("title") or ""):
        errs.append(f"{where}：标题不要带优先级前缀，优先级写在 priority")
    steps, exps = c.get("steps"), c.get("expectations")
    if not isinstance(steps, list) or not [s for s in steps if str(s).strip()]:
        errs.append(f"{where}：steps 不能为空")
    if not isinstance(exps, list) or not exps:
        errs.append(f"{where}：expectations 不能为空")
    else:
        for i, e in enumerate(exps, 1):
            m = A_RE.match(str(e))
            if not m or int(m.group(1)) != i:
                errs.append(f"{where}：第 {i} 条预期不符合 A 记法「{i}) 维度 ｜ 内容」：{str(e)[:40]}")
            if "<br" in str(e):
                errs.append(f"{where}：预期里有 <br>，用分条代替")
    text = json.dumps({k: c.get(k) for k in ("title", "precondition", "steps", "expectations", "note")}, ensure_ascii=False)
    if PENDING_RE.search(text):
        errs.append(f"{where}：残留「按产品定义 / 待确认 / 待补充」字样，先在第 5 步问清")


def validate(spec, snap):
    errs, warns = [], []
    scope = spec.get("scope") or {}
    adds, dels = scope.get("add") or [], scope.get("delete") or []
    existing = all_cases(snap)
    new_mods = {m.get("id"): m for m in spec.get("modules", [])}
    for mid, m in new_mods.items():
        if not mid or not ID_RE.match(mid) or not m.get("name"):
            errs.append(f"新建模块 {mid}：id / name 不合法")
        elif mid in snap:
            errs.append(f"新建模块 {mid} 已存在于快照")
        elif mid not in adds:
            errs.append(f"新建模块 {mid} 不在 scope.add 内")
    for mid in {s.partition("/")[0] for s in adds + dels}:
        if mid not in snap and mid not in new_mods:
            errs.append(f"scope 里的模块 {mid} 不在快照里，先 pull")

    titles = {}
    for c in existing.values():
        if not c.get("archived"):
            titles.setdefault((c["moduleId"], c.get("group"), c.get("scene"), c["title"]), set()).add(c["id"])

    seen = set()
    for i, c in enumerate(spec.get("create", [])):
        where = f"create[{i}] {c.get('title', '')}"
        check_case(c, where, errs)
        cid = c.get("id")
        if cid in seen or cid in existing:
            errs.append(f"{where}：id {cid} 重复或已存在")
        seen.add(cid)
        if c.get("moduleId") not in snap and c.get("moduleId") not in new_mods:
            errs.append(f"{where}：moduleId {c.get('moduleId')} 不在快照或新建模块里")
        if not in_scope(adds, c.get("moduleId"), c.get("group")):
            errs.append(f"{where}：落点 {c.get('moduleId')} / {c.get('group')} 不在 scope.add 内（未授权新增）")
        key = (c.get("moduleId"), c.get("group"), c.get("scene"), c.get("title"))
        if titles.get(key):
            errs.append(f"{where}：同模块同分组同场景下已有同名用例 {sorted(titles[key])}")
        titles.setdefault(key, set()).add(cid)

    touched = set()
    for i, u in enumerate(spec.get("update", [])):
        cid = u.get("id")
        where = f"update[{i}] {cid}"
        old = existing.get(cid)
        if not old:
            errs.append(f"{where}：快照里没有这条用例")
            continue
        if old.get("archived"):
            errs.append(f"{where}：用例已归档，不能更新")
        if cid in touched:
            errs.append(f"{where}：同一用例出现多次")
        touched.add(cid)
        if not u.get("reason"):
            errs.append(f"{where}：缺少 reason（<repo>#<PR> 变更点）")
        c = u.get("case") or {}
        check_case(c, where, errs)
        if c.get("id") != cid:
            errs.append(f"{where}：case.id 与 id 不一致")
        if c.get("moduleId") != old.get("moduleId"):
            errs.append(f"{where}：更新不能改 moduleId（挪模块需 QA 授权的新增 + 归档）")
        if all(c.get(k) == old.get(k) for k in AUTHORED if k in c or k in old):
            warns.append(f"{where}：内容与平台现有一致，没有实际改动")
        key = (c.get("moduleId"), c.get("group"), c.get("scene"), c.get("title"))
        if titles.get(key, set()) - {cid}:
            errs.append(f"{where}：改后标题与同组用例重名 {sorted(titles[key] - {cid})}")

    for i, x in enumerate(spec.get("archive", [])):
        cid = x.get("id")
        where = f"archive[{i}] {cid}"
        old = existing.get(cid)
        if not old:
            errs.append(f"{where}：快照里没有这条用例")
            continue
        if old.get("archived"):
            errs.append(f"{where}：已经归档")
        if cid in touched:
            errs.append(f"{where}：同一用例既更新又归档")
        touched.add(cid)
        if not in_scope(dels, old["moduleId"], old.get("group")):
            errs.append(f"{where}：{old['moduleId']} / {old.get('group')} 不在 scope.delete 内（未授权删除）")

    for repo, sha in (spec.get("baseline") or {}).items():
        if not SHA_RE.match(str(sha)):
            errs.append(f"baseline {repo}：须是 40 位完整 SHA")
    return errs, warns


def file_hash(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:16]


def summary(spec):
    pr = {}
    for c in spec.get("create", []):
        pr[c.get("priority")] = pr.get(c.get("priority"), 0) + 1
    dist = " / ".join(f"{p} {pr.get(p, 0)}" for p in PRIOS)
    return (f"新建模块 {len(spec.get('modules', []))}，新增 {len(spec.get('create', []))}（{dist}），"
            f"更新 {len(spec.get('update', []))}，归档 {len(spec.get('archive', []))}，"
            f"基准 {'前移' if spec.get('baseline') else '不变'}")


def cmd_validate(a):
    spec = json.load(open(a.spec, encoding="utf-8"))
    snap = load_snapshot(a.snapshot)
    errs, warns = validate(spec, snap)
    print(summary(spec))
    for w in warns:
        print("  ⚠ " + w)
    for e in errs:
        print("  ✗ " + e)
    if errs:
        sys.exit(f"校验未通过：{len(errs)} 项")
    print("校验通过")


def requests(spec, snap, brand):
    """把 spec 翻译成按顺序执行的 tutti-ops 请求：(说明, 参数, data)。"""
    existing = all_cases(snap)
    reqs = []
    for m in spec.get("modules", []):
        reqs.append((f"新建模块 {m['id']} {m['name']}",
                     ["test-management", "modules", "create", "--brand-id", brand],
                     {k: m[k] for k in ("id", "name", "description") if k in m}))
    creates = spec.get("create", [])
    for i in range(0, len(creates), IMPORT_LIMIT):
        chunk = creates[i:i + IMPORT_LIMIT]
        reqs.append((f"新增用例 {i + 1}–{i + len(chunk)}",
                     ["test-management", "cases", "import", "--brand-id", brand], {"cases": chunk}))
    for u in spec.get("update", []):
        data = dict(u["case"], revision=existing[u["id"]]["revision"])
        reqs.append((f"更新 {u['id']} {u['case']['title']}",
                     ["test-management", "cases", "update", "--brand-id", brand, "--id", u["id"]], data))
    for x in spec.get("archive", []):
        old = existing[x["id"]]
        data = {k: old[k] for k in AUTHORED if k in old}
        data.update(archived=True, revision=old["revision"])
        reqs.append((f"归档 {x['id']} {old['title']}",
                     ["test-management", "cases", "update", "--brand-id", brand, "--id", x["id"]], data))
    return reqs


def cmd_apply(a):
    spec = json.load(open(a.spec, encoding="utf-8"))
    if not spec.get("confirmed_from"):
        sys.exit("只能写入 apply_case_confirm.py 生成的 spec.confirmed.json")
    snap = load_snapshot(a.snapshot)
    errs, _ = validate(spec, snap)
    if errs:
        sys.exit("校验未通过，先 validate：\n  " + "\n  ".join(errs))
    brand = spec.get("brand_id") or a.brand
    batch_dir = os.path.dirname(os.path.abspath(a.spec))
    tmp = os.path.join(batch_dir, "apply-requests")
    reqs = requests(spec, snap, brand)
    log_path = os.path.join(batch_dir, "apply-log.json")
    log = {"spec_hash": file_hash(a.spec), "mode": "yes" if a.yes else "dry-run",
           "at": datetime.datetime.now().isoformat(timespec="seconds"), "steps": []}
    print(summary(spec))
    failed = None
    for desc, args, data in reqs:
        code, out = ops(*args, data=data, mode="dry")
        step = {"desc": desc, "args": args, "dry_run_exit": code}
        if code or not out.get("ok"):
            step["error"] = out
            log["steps"].append(step)
            failed = f"dry-run 失败：{desc}（退出码 {code}）"
            break
        if a.yes:
            code, out = ops(*args, data=data, mode="yes", tmp=tmp)
            step.update(exit=code, ok=bool(out.get("ok")), result=out.get("data") if out.get("ok") else out)
            if code or not out.get("ok"):
                log["steps"].append(step)
                failed = (f"写入结果不确定：{desc}（退出码 6），先 verify 回读，不要直接重试" if code == 6
                          else f"写入失败：{desc}（退出码 {code}）")
                break
        log["steps"].append(step)
        print(("  ✓ " if a.yes else "  · ") + desc)
    with open(log_path, "w", encoding="utf-8") as f:
        json.dump(log, f, ensure_ascii=False, indent=1)
    if failed:
        sys.exit(f"{failed}\n已执行的步骤见 {log_path}；revision 冲突时重新 pull、改 spec 后重走确认")
    print(f"{'已写入' if a.yes else 'dry-run 通过（未发请求）'}：{len(reqs)} 个请求 → {log_path}")


def cmd_verify(a):
    spec = json.load(open(a.spec, encoding="utf-8"))
    snap = load_snapshot(a.snapshot)
    existing = all_cases(snap)
    mods = sorted({c["moduleId"] for c in spec.get("create", [])}
                  | {u["case"]["moduleId"] for u in spec.get("update", [])}
                  | {existing[x["id"]]["moduleId"] for x in spec.get("archive", []) if x["id"] in existing})
    a.modules = mods
    cmd_pull(a)
    after = all_cases(load_snapshot(a.out))
    problems = []
    def same(want, got):
        return all(want.get(k) == got.get(k) for k in AUTHORED if k in want)
    for c in spec.get("create", []):
        got = after.get(c["id"])
        if not got or got.get("archived") or not same(c, got):
            problems.append(f"新增未生效或内容不符：{c['id']} {c['title']}")
    for u in spec.get("update", []):
        got = after.get(u["id"])
        if not got or not same(u["case"], got):
            problems.append(f"更新未生效或内容不符：{u['id']}")
    for x in spec.get("archive", []):
        got = after.get(x["id"])
        if not got or not got.get("archived"):
            problems.append(f"归档未生效：{x['id']}")
    res = {"ok": not problems, "spec_hash": file_hash(a.spec), "modules": mods, "problems": problems,
           "at": datetime.datetime.now().isoformat(timespec="seconds")}
    dst = os.path.join(os.path.dirname(os.path.abspath(a.spec)), "verify.json")
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    for p in problems:
        print("  ✗ " + p)
    if problems:
        sys.exit(f"回读核对未通过：{len(problems)} 项 → {dst}")
    print(f"回读核对通过 → {dst}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--brand", default=BRAND, help=f"brand id，默认 {BRAND}（Tutti）")
    sp = ap.add_subparsers(required=True)
    p = sp.add_parser("baseline"); p.add_argument("action", choices=["get", "set"]); p.add_argument("spec", nargs="?")
    p.add_argument("--verified"); p.add_argument("--file"); p.set_defaults(f=cmd_baseline)
    p = sp.add_parser("modules"); p.add_argument("--search"); p.set_defaults(f=cmd_modules)
    p = sp.add_parser("pull"); p.add_argument("modules", nargs="+"); p.add_argument("--out", required=True)
    p.set_defaults(f=cmd_pull)
    p = sp.add_parser("validate"); p.add_argument("spec"); p.add_argument("--snapshot", required=True)
    p.set_defaults(f=cmd_validate)
    p = sp.add_parser("apply"); p.add_argument("spec"); p.add_argument("--snapshot", required=True)
    p.add_argument("--yes", action="store_true", help="真正写入；不带时只做 dry-run"); p.set_defaults(f=cmd_apply)
    p = sp.add_parser("verify"); p.add_argument("spec"); p.add_argument("--snapshot", required=True)
    p.add_argument("--out", required=True); p.set_defaults(f=cmd_verify)
    a = ap.parse_args()
    a.f(a)


if __name__ == "__main__":
    main()
