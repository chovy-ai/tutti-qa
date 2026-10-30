#!/usr/bin/env python3
"""解析 QA 在用例确认页导出的结果，生成只含已确认内容的 spec.confirmed.json。

用法：
  python3 apply_case_confirm.py <spec.json> --text-file <confirm.txt>
  pbpaste | python3 apply_case_confirm.py <spec.json>

- 只认 TUTTI-QA-CASES 开头的那一行；spec 指纹与当前 spec.json 不一致时报错（spec 改过就要重新出确认页）。
- 确认项 key：新增 C<n>、更新 U<n>、归档 R<n>；必须与 spec 完全对应，缺项或多项都报错。
- 不要的新增 / 更新 / 归档从 spec 里去掉；新建模块下没有保留的新增用例时，该模块也不再新建。
- 改过的优先级直接改写新增用例的 priority。
- 带备注的条目逐条列出：备注是 QA 的修改要求，agent 必须先按备注改好 spec.confirmed.json，
  再写入；改动若超出「删条目 / 改优先级 / 改措辞」，需改 spec.json 后重新出确认页。
退出码：0 = 无备注，可直接写入；2 = 有备注待处理。
"""
import argparse
import copy
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from render_cases import confirmation_keys, spec_hash  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec")
    ap.add_argument("--text-file")
    a = ap.parse_args()
    if a.text_file:
        with open(a.text_file, encoding="utf-8") as f:
            text = f.read()
    else:
        text = sys.stdin.read()
    line = next((l.strip() for l in text.splitlines() if l.strip().startswith("TUTTI-QA-CASES ")), None)
    if not line:
        sys.exit("没找到 TUTTI-QA-CASES 行，请让 QA 用用例确认页的「一键复制」重新复制")
    conf = json.loads(line[len("TUTTI-QA-CASES "):])
    h = spec_hash(a.spec)
    if conf.get("hash") != h:
        sys.exit(f"spec 指纹不一致：确认结果对应 {conf.get('hash')}，当前 spec 是 {h}。spec 改过了，请重新生成确认页")
    with open(a.spec, encoding="utf-8") as f:
        spec = json.load(f)
    dec = {d["key"]: d for d in conf["decisions"]}
    want = confirmation_keys(spec)
    if set(dec) != set(want) or len(dec) != len(conf["decisions"]):
        sys.exit(f"确认项与 spec 不对应：缺 {sorted(set(want) - set(dec))}，多 {sorted(set(dec) - set(want))}")

    notes, dropped, reprio = [], [], []
    out = copy.deepcopy(spec)
    for kind, prefix, label in (("create", "C", "新增"), ("update", "U", "更新"), ("archive", "R", "归档")):
        kept = []
        for i, x in enumerate(spec.get(kind, [])):
            d = dec[f"{prefix}{i}"]
            title = (x.get("case") or x).get("title") or x["id"]
            if not d.get("keep", True):
                dropped.append(f"[{label}] {title}")
                continue
            x = copy.deepcopy(x)
            if kind == "create" and d.get("prio") and d["prio"] != x["priority"]:
                reprio.append(f"{title}：{x['priority']} → {d['prio']}")
                x["priority"] = d["prio"]
            if d.get("note"):
                notes.append(f"[{label}] {x['id']} {title} ｜ {d['note']}")
            kept.append(x)
        out[kind] = kept
    used = {c["moduleId"] for c in out.get("create", [])}
    out["modules"] = [m for m in spec.get("modules", []) if m["id"] in used]
    out["confirmed_from"] = {"batch": conf.get("batch"), "spec_hash": h}
    dst = os.path.join(os.path.dirname(os.path.abspath(a.spec)), "spec.confirmed.json")
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    for kind, label in (("create", "新增"), ("update", "更新"), ("archive", "归档")):
        print(f"{label}：保留 {len(out.get(kind, []))} / {len(spec.get(kind, []))}")
    for x in dropped:
        print(f"  ✗ {x}")
    for x in reprio:
        print(f"  ↕ {x}")
    print(f"→ {dst}")
    if notes:
        print(f"\n有 {len(notes)} 条备注，需先按备注修改 spec.confirmed.json 再写入：")
        for n in notes:
            print("  ✎ " + n)
        sys.exit(2)


if __name__ == "__main__":
    main()
