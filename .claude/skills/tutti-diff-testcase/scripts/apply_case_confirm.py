#!/usr/bin/env python3
"""解析 QA 在用例确认页导出的结果，生成只含已确认内容的 spec.confirmed.json。

用法：
  python3 apply_case_confirm.py <spec.json> --text-file <confirm.txt>
  pbpaste | python3 apply_case_confirm.py <spec.json>

- 只认 TUTTI-QA-CASES 开头的那一行；spec 指纹与当前 spec.json 不一致时报错（spec 改过就要重新出确认页）。
- 不要的新增用例删掉；删完后没有用例的场景、分组一并去掉（只剩「说明」的也去掉）。
- 改过的优先级直接改写标题前缀（🔴【P0】/ 🟠【P1】/ 🟡【P2】）。
- 不要的更新、删除从 spec 里去掉。
- 带备注的条目逐条列出：备注是 QA 的修改要求，agent 必须先按备注改好 spec.confirmed.json，
  再合并；改动若超出「删条目 / 改优先级」，需重新出确认页让 QA 再确认一次。
退出码：0 = 无备注，可直接合并；2 = 有备注待处理。
"""
import argparse
import copy
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pos_tool as t  # noqa: E402
from render_cases import spec_hash  # noqa: E402

BADGE = {"P0": "🔴【P0】", "P1": "🟠【P1】", "P2": "🟡【P2】"}


def has_case(n):
    if "case" in n:
        return True
    return any(has_case(c) for c in n.get("children", []))


def prune(nodes, prefix, dec, notes, stats):
    out = []
    for j, n in enumerate(nodes):
        k = f"{prefix}.{j}"
        if "case" in n:
            d = dec.get(k, {"keep": True})
            stats["total"] += 1
            if not d.get("keep", True):
                stats["dropped"].append(n["case"])
                continue
            n = copy.deepcopy(n)
            if d.get("prio"):
                n["case"] = BADGE[d["prio"]] + t.PRIO_RE.sub("", n["case"]).strip()
                stats["reprio"].append(n["case"])
            if d.get("note"):
                notes.append(f"[新增] {n['case']} ｜ {d['note']}")
            out.append(n)
        else:
            m = copy.deepcopy(n)
            m["children"] = prune(n.get("children", []), k, dec, notes, stats)
            if has_case(m):
                out.append(m)
            elif m.get("title", "").startswith("说明") and not m["children"]:
                out.append(m)  # 说明节点先留着，由上一层判断整组是否保留
    # 只剩说明节点的一层不保留
    if out and not any(has_case(x) for x in out):
        return []
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec")
    ap.add_argument("--text-file")
    a = ap.parse_args()
    text = open(a.text_file, encoding="utf-8").read() if a.text_file else sys.stdin.read()
    line = next((l.strip() for l in text.splitlines() if l.strip().startswith("TUTTI-QA-CASES ")), None)
    if not line:
        sys.exit("没找到 TUTTI-QA-CASES 行，请让 QA 用用例确认页的「导出确认结果」重新复制")
    conf = json.loads(line[len("TUTTI-QA-CASES "):])
    h = spec_hash(a.spec)
    if conf.get("hash") != h:
        sys.exit(f"spec 指纹不一致：确认结果对应 {conf.get('hash')}，当前 spec 是 {h}。spec 改过了，请重新生成确认页")
    dec = {d["key"]: d for d in conf["decisions"]}
    with open(a.spec, encoding="utf-8") as f:
        spec = json.load(f)
    notes = []
    stats = {"total": 0, "dropped": [], "reprio": []}
    out = copy.deepcopy(spec)
    out["add"] = []
    for i, item in enumerate(spec.get("add", [])):
        nodes = prune(item["nodes"], f"A{i}", dec, notes, stats)
        if nodes:
            out["add"].append(dict(item, nodes=nodes))
    for kind, key, label in (("update", "U", "更新"), ("delete", "D", "删除")):
        kept = []
        for i, x in enumerate(spec.get(kind, [])):
            d = dec.get(f"{key}{i}", {"keep": True})
            if d.get("keep", True):
                kept.append(x)
                if d.get("note"):
                    notes.append(f"[{label}] {x['id']} {x.get('reason', '')} ｜ {d['note']}")
            else:
                stats.setdefault(f"dropped_{kind}", []).append(x["id"])
        out[kind] = kept
    out["confirmed_from"] = {"batch": conf.get("batch"), "spec_hash": h}
    dst = os.path.join(os.path.dirname(os.path.abspath(a.spec)), "spec.confirmed.json")
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    kept_cases = stats["total"] - len(stats["dropped"])
    print(f"新增用例：保留 {kept_cases} / {stats['total']}，改优先级 {len(stats['reprio'])} 条")
    print(f"更新：保留 {len(out.get('update', []))} / {len(spec.get('update', []))}；"
          f"删除：保留 {len(out.get('delete', []))} / {len(spec.get('delete', []))}")
    for c in stats["dropped"]:
        print(f"  ✗ {c}")
    print(f"→ {dst}")
    if notes:
        print(f"\n有 {len(notes)} 条备注，需先按备注修改 spec.confirmed.json 再合并：")
        for n in notes:
            print("  ✎ " + n)
        sys.exit(2)


if __name__ == "__main__":
    main()
