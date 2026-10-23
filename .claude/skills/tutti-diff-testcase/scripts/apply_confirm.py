#!/usr/bin/env python3
"""解析 QA 从确认页导出、粘回对话的文本，写出 selected.json。

用法：
  python3 apply_confirm.py output/<batch>/changes.json --text-file /tmp/confirm.txt
  pbpaste | python3 apply_confirm.py output/<batch>/changes.json

只认文本里 TUTTI-QA-CONFIRM 开头的那一行 JSON；批次号与 changes.json 不一致时报错（防止拿旧页面的结果）。
输出 output/<batch>/selected.json：{"batch", "repos", "scope", "selected": [完整条目 + note], "unselected": [key...]}
"""
import argparse
import json
import os
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("changes")
    ap.add_argument("--text-file")
    a = ap.parse_args()
    text = open(a.text_file, encoding="utf-8").read() if a.text_file else sys.stdin.read()
    line = next((l for l in text.splitlines() if l.strip().startswith("TUTTI-QA-CONFIRM ")), None)
    if not line:
        sys.exit("没找到 TUTTI-QA-CONFIRM 行，请让 QA 用确认页的「导出确认结果」重新复制")
    conf = json.loads(line.strip()[len("TUTTI-QA-CONFIRM "):])
    with open(a.changes, encoding="utf-8") as f:
        ch = json.load(f)
    if conf.get("batch") != ch["batch"]:
        sys.exit(f"批次不一致：确认结果是 {conf.get('batch')}，changes.json 是 {ch['batch']}")
    by = {i["key"]: i for i in ch["items"]}
    unknown = [s["key"] for s in conf["selected"] if s["key"] not in by]
    if unknown:
        sys.exit(f"确认结果里有 changes.json 不存在的条目：{unknown}")
    sel = [dict(by[s["key"]], note=s.get("note") or "") for s in conf["selected"]]
    out = {"batch": ch["batch"], "repos": ch["repos"], "scope": ch.get("scope", {}),
           "selected": sel, "unselected": conf.get("unselected", [])}
    dst = os.path.join(os.path.dirname(os.path.abspath(a.changes)), "selected.json")
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"已勾选 {len(sel)} 条，未勾选 {len(out['unselected'])} 条 → {dst}")
    for s in sel:
        print(f"- {s['key']}  #{s['pr']}  {s['title'][:70]}" + (f"  ｜ 备注：{s['note']}" if s["note"] else ""))


if __name__ == "__main__":
    main()
