#!/usr/bin/env python3
"""把待写入平台的 spec 渲染成「用例详细确认页」（单文件 HTML），供 QA 查看详情、改级、写备注。

用法：python3 render_cases.py <spec.json> --snapshot <快照目录> -o <cases-detail.html> [--batch 名称]

页面内容：
- 新增：按 模块 → 分组 → 场景 → 用例 分层展示，可展开看前置 / 操作 / 预期 / 备注
- 更新：每条显示位置、依据、改前 / 改后逐行对比（改前取自快照）
- 归档：每条显示位置、原因（平台软删除）
每条可勾选（默认全选）、改优先级、写备注；分组 / 场景复选框可一键全选或全不选其下用例。
「导出确认结果」生成文本，末行 TUTTI-QA-CASES 开头的 JSON 带 spec 指纹，粘回对话后用 apply_case_confirm.py 解析。
条目 key：新增 C<n>、更新 U<n>、归档 R<n>（n 为 spec 内序号），与 apply_case_confirm.py 共用。
"""
import argparse
import difflib
import hashlib
import html
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from case_tool import all_cases, load_snapshot, module_name  # noqa: E402

SCENES = ("正常场景", "异常场景", "边界场景")


def spec_hash(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:16]


def confirmation_keys(spec):
    """spec 中全部确认项的 key，顺序即页面顺序。"""
    return ([f"C{i}" for i, _ in enumerate(spec.get("create", []))]
            + [f"U{i}" for i, _ in enumerate(spec.get("update", []))]
            + [f"R{i}" for i, _ in enumerate(spec.get("archive", []))])


def case_text(c):
    """用例全文（用于改前 / 改后对比）。"""
    lines = [f"标题：{c.get('title', '')}", f"优先级：{c.get('priority', '')}",
             f"位置：{c.get('category', '')} / {c.get('group', '')} / {c.get('scene', '')}",
             f"前置：{c.get('precondition', '')}"]
    lines += [f"操作 {i}：{x}" for i, x in enumerate(c.get("steps") or [], 1)]
    lines += [f"预期：{x}" for x in c.get("expectations") or []]
    if c.get("note"):
        lines += ["备注：" + x for x in c["note"].split("\n")]
    return "\n".join(lines)


def grouped_creates(spec, snap):
    """新增用例按 模块 → 分组 → 场景 归组：{模块名: {分组: {场景: [(key, case)]}}}，保持 spec 顺序。"""
    out = {}
    for i, c in enumerate(spec.get("create", [])):
        mod = module_name(snap, spec, c["moduleId"])
        out.setdefault(mod, {}).setdefault(c["group"], {}).setdefault(c["scene"], []).append((f"C{i}", c))
    return out


def scene_order(scenes):
    order = {name: i for i, name in enumerate(SCENES)}
    return sorted(scenes, key=lambda x: order.get(x, len(SCENES)))


def location(snap, spec, c):
    return " / ".join(x for x in (module_name(snap, spec, c["moduleId"]), c.get("group"), c.get("scene"), c.get("title")) if x)


def diff_html(before, after):
    a, b = before.split("\n"), after.split("\n")
    rows = []
    for op in difflib.ndiff(a, b):
        tag, text = op[:2], html.escape(op[2:])
        if tag == "- ":
            rows.append(f'<div class="del">− {text}</div>')
        elif tag == "+ ":
            rows.append(f'<div class="ins">+ {text}</div>')
        elif tag == "  ":
            rows.append(f'<div class="same">  {text}</div>')
    return "".join(rows)


def build(snapshot_dir, spec_path, batch):
    snap = load_snapshot(snapshot_dir)
    existing = all_cases(snap)
    with open(spec_path, encoding="utf-8") as f:
        spec = json.load(f)
    adds, g = [], 0
    for mod, groups in grouped_creates(spec, snap).items():
        tree = []
        for group, scenes in groups.items():
            g += 1
            ch = []
            for scene in scene_order(scenes):
                g += 1
                ch.append({"k": f"G{g}", "kind": "scene", "t": scene, "ch": [
                    {"k": k, "kind": "case", "t": c["title"], "prio": c["priority"], "pre": c.get("precondition", ""),
                     "op": "；".join(c.get("steps") or []), "exp": c.get("expectations") or [], "note": c.get("note", "")}
                    for k, c in scenes[scene]]})
            tree.append({"k": f"G{g}", "kind": "group", "t": group, "ch": ch})
        adds.append({"host": mod, "tree": tree})
    ups = []
    for i, u in enumerate(spec.get("update", [])):
        old = existing.get(u["id"])
        ups.append({"k": f"U{i}", "path": location(snap, spec, old) if old else f"{u['id']}（快照里不存在）",
                    "reason": u.get("reason", ""), "diff": diff_html(case_text(old or {}), case_text(u["case"]))})
    dels = []
    for i, x in enumerate(spec.get("archive", [])):
        old = existing.get(x["id"])
        dels.append({"k": f"R{i}", "path": location(snap, spec, old) if old else f"{x['id']}（快照里不存在）",
                     "nodes": 1, "cases": [old["title"]] if old else [], "reason": x.get("reason", "")})
    return {"batch": batch, "hash": spec_hash(spec_path), "scope": spec.get("scope", {}),
            "adds": adds, "updates": ups, "deletes": dels}


TPL = r"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>用例确认 · __BATCH__</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--line:#e3e6ea;--muted:#6b7280;--txt:#111827;--acc:#2563eb;--p0:#dc2626;--p1:#ea580c;--p2:#ca8a04;--ins:#dcfce7;--del:#fee2e2}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--card:#1a1e24;--line:#2b313a;--muted:#9aa3ae;--txt:#e5e7eb;--acc:#60a5fa;--ins:#14361f;--del:#3b1517}}
*{box-sizing:border-box}body{margin:0;font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--txt)}
header{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line);padding:12px 20px}
h1{font-size:17px;margin:0 0 4px}.sub{color:var(--muted);font-size:12px}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}
button,select,input[type=search]{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--txt);border-radius:6px;padding:4px 10px}
button{cursor:pointer}button.primary{background:var(--acc);border-color:var(--acc);color:#fff}button.on{outline:2px solid var(--acc)}
.count{margin-left:auto;font-weight:600}
main{padding:12px 20px 80px;max-width:1200px;margin:0 auto}
h2{font-size:16px;margin:22px 0 8px}.host{color:var(--muted);font-size:12px;margin:4px 0 8px}
.grp{border:1px solid var(--line);border-radius:8px;background:var(--card);margin:8px 0;padding:8px 12px}
.grp .grp{background:transparent}
.gh{display:flex;gap:8px;align-items:center;font-weight:600}.gh.scene{font-weight:500;color:var(--muted)}
.desc{font-size:12px;color:var(--muted);background:var(--bg);border-radius:6px;padding:6px 8px;margin:6px 0;white-space:pre-wrap}
.case{border-top:1px dashed var(--line);padding:8px 0 8px 26px;display:grid;grid-template-columns:22px 1fr;gap:6px}
.case.off .ct{opacity:.45;text-decoration:line-through}
.ct{font-weight:600}.badge{display:inline-block;font-size:12px;font-weight:700;border-radius:4px;padding:0 6px;margin-right:6px;color:#fff}
.P0{background:var(--p0)}.P1{background:var(--p1)}.P2{background:var(--p2)}
details{font-size:13px;margin-top:4px}summary{cursor:pointer;color:var(--muted)}
.kv{margin:4px 0}.kv b{color:var(--muted);font-weight:500;margin-right:4px}
ol{margin:4px 0;padding-left:22px}
.tools{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
.tools select{padding:2px 6px;font-size:12px}.note{flex:1;min-width:240px;font:inherit;font-size:12px;border:1px solid var(--line);border-radius:6px;padding:3px 8px;background:transparent;color:var(--txt)}
.diff{font:12px/1.6 ui-monospace,Menlo,monospace;border:1px solid var(--line);border-radius:6px;overflow:hidden;margin-top:6px;white-space:pre-wrap}
.diff .ins{background:var(--ins)}.diff .del{background:var(--del)}.diff .same{color:var(--muted)}
.hide{display:none!important}
input[type=checkbox]{width:17px;height:17px}
#out{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;z-index:9}
#out .box{background:var(--card);width:min(900px,94vw);border-radius:10px;padding:16px}
#out textarea{width:100%;height:50vh;font:12px/1.5 ui-monospace,Menlo,monospace;background:var(--bg);color:var(--txt);border:1px solid var(--line);border-radius:6px;padding:8px}
.tip{color:var(--muted);font-size:12px;margin:6px 0}
</style></head><body>
<header>
 <h1>用例确认 · __BATCH__</h1>
 <div class="sub" id="sum"></div>
 <div class="bar">
  <span class="tip">筛选：</span><button data-p="">全部</button><button data-p="P0">P0</button><button data-p="P1">P1</button><button data-p="P2">P2</button>
  <input type="search" id="q" placeholder="搜索标题 / 预期">
  <button id="all">全选</button><button id="none">全不选</button><button id="expand">展开全部</button>
  <span class="count" id="count"></span><button class="primary" id="export">导出确认结果</button>
 </div>
</header>
<main id="main"></main>
<div id="out"><div class="box"><b>确认结果</b>
 <div class="tip">已自动复制到剪贴板；如未复制成功，点「复制」或手动全选复制，然后粘贴回对话。</div>
 <textarea id="txt" readonly></textarea>
 <div class="bar"><button class="primary" id="copy">复制</button><button id="dl">下载 .txt</button><button id="close">关闭</button><span class="tip" id="copied"></span></div>
</div></div>
<script>
const D = __DATA__;
const KEY = "tutti-qa-cases:" + D.batch + ":" + D.hash;
// 预览面板可能以沙箱运行、禁止 localStorage；不可用时只是不记住勾选状态，页面照常工作
const store = (() => { try { const s = window.localStorage; s.getItem("_"); return s; } catch { return null; } })();
let saved = {}; try { saved = JSON.parse((store && store.getItem(KEY)) || "{}"); } catch {}
const st = {}; const meta = {};
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const save = () => { try { store && store.setItem(KEY, JSON.stringify(st)); } catch {} };
function reg(k, m) { meta[k] = m; st[k] = saved[k] || {keep: true, prio: m.prio || "", note: ""}; }
const main = document.getElementById("main");
const sc = D.scope || {};
let nAdd = 0;
function itemTools(k, prio) {
  return `<div class="tools">${prio ? `<select data-k="${k}" class="pr">${["P0","P1","P2"].map(p => `<option ${p===st[k].prio?"selected":""}>${p}</option>`).join("")}</select>` : ""}
    <input class="note" data-k="${k}" placeholder="备注（可选）：要怎么改、为什么不要" value="${esc(st[k].note)}"></div>`;
}
function renderTree(nodes) {
  return nodes.map(n => {
    if (n.kind === "case") {
      nAdd++; reg(n.k, {type: "新增", prio: n.prio, title: n.t, text: (n.t + " " + n.exp.join(" ")).toLowerCase()});
      return `<div class="case item" data-k="${n.k}"><input type="checkbox" class="ck" data-k="${n.k}">
        <div><div class="ct"><span class="badge ${st[n.k].prio}">${st[n.k].prio}</span>${esc(n.t)}</div>
        <details><summary>前置 / 操作 / 预期${n.note ? " / 备注" : ""}</summary>
         <div class="kv"><b>前置</b>${esc(n.pre)}</div><div class="kv"><b>操作</b>${esc(n.op)}</div>
         <div class="kv"><b>预期</b><ol>${n.exp.map(e => `<li>${esc(e.replace(/^\d+\)\s*/, ""))}</li>`).join("")}</ol></div>
         ${n.note ? `<div class="kv"><b>备注</b>${esc(n.note)}</div>` : ""}</details>
        ${itemTools(n.k, true)}</div></div>`;
    }
    if (n.kind === "desc") return `<div class="desc">${esc(n.t)}</div>`;
    return `<div class="grp" data-g="${n.k}"><div class="gh ${n.kind}"><input type="checkbox" class="gk" data-g="${n.k}">${esc(n.t)}</div>${renderTree(n.ch)}</div>`;
  }).join("");
}
let h = "";
if (D.adds.length) {
  h += `<h2>新增</h2>`;
  D.adds.forEach(a => { h += `<div class="host">模块：${esc(a.host)}</div>` + renderTree(a.tree); });
}
if (D.updates.length) {
  h += `<h2>更新（${D.updates.length}）</h2>`;
  D.updates.forEach(u => { reg(u.k, {type: "更新", title: u.path, text: (u.path + " " + u.reason).toLowerCase()});
    h += `<div class="grp item" data-k="${u.k}"><div class="gh"><input type="checkbox" class="ck" data-k="${u.k}">${esc(u.path)}</div>
      <div class="tip">依据：${esc(u.reason)}</div><div class="diff">${u.diff}</div>${itemTools(u.k, false)}</div>`; });
}
if (D.deletes.length) {
  h += `<h2>归档（${D.deletes.length}）</h2>`;
  D.deletes.forEach(x => { reg(x.k, {type: "归档", title: x.path, text: (x.path + " " + x.cases.join(" ")).toLowerCase()});
    h += `<div class="grp item" data-k="${x.k}"><div class="gh"><input type="checkbox" class="ck" data-k="${x.k}">${esc(x.path)}</div>
      <div class="tip">原因：${esc(x.reason)}</div>${itemTools(x.k, false)}</div>`; });
}
main.innerHTML = h || "<p>spec 为空</p>";
document.getElementById("sum").textContent =
  `新增用例 ${nAdd} 条 · 更新 ${D.updates.length} 处 · 归档 ${D.deletes.length} 条　｜　授权新增：${(sc.add||[]).join("、")||"无"}；授权归档：${(sc.delete||[]).join("、")||"无"}　｜　spec ${D.hash}`;

const boxes = () => [...main.querySelectorAll(".ck")];
function sync() {
  boxes().forEach(b => { b.checked = st[b.dataset.k].keep; b.closest(".item").classList.toggle("off", !b.checked); });
  main.querySelectorAll(".gk").forEach(g => {
    const cs = [...g.closest(".grp").querySelectorAll(".ck")];
    g.checked = cs.length > 0 && cs.every(c => c.checked);
    g.indeterminate = cs.some(c => c.checked) && !g.checked;
  });
  const keys = Object.keys(st), kept = keys.filter(k => st[k].keep).length;
  const byP = {}; keys.filter(k => st[k].keep && meta[k].type === "新增").forEach(k => byP[st[k].prio] = (byP[st[k].prio]||0) + 1);
  document.getElementById("count").textContent = `保留 ${kept} / ${keys.length}　P0 ${byP.P0||0} · P1 ${byP.P1||0} · P2 ${byP.P2||0}`;
}
main.addEventListener("change", e => {
  const el = e.target;
  if (el.classList.contains("ck")) st[el.dataset.k].keep = el.checked;
  if (el.classList.contains("gk")) el.closest(".grp").querySelectorAll(".ck").forEach(c => st[c.dataset.k].keep = el.checked);
  if (el.classList.contains("pr")) { st[el.dataset.k].prio = el.value; const b = el.closest(".item").querySelector(".badge"); b.className = "badge " + el.value; b.textContent = el.value; }
  save(); sync();
});
main.addEventListener("input", e => { if (e.target.classList.contains("note")) { st[e.target.dataset.k].note = e.target.value; save(); } });
let pf = "";
function apply() {
  const q = document.getElementById("q").value.trim().toLowerCase();
  main.querySelectorAll(".item").forEach(el => { const k = el.dataset.k, m = meta[k];
    el.classList.toggle("hide", (pf && m.type === "新增" && st[k].prio !== pf) || (pf && m.type !== "新增") || (q && !m.text.includes(q))); });
}
document.querySelectorAll("[data-p]").forEach(b => b.onclick = () => { pf = b.dataset.p;
  document.querySelectorAll("[data-p]").forEach(x => x.classList.toggle("on", x === b)); apply(); });
document.getElementById("q").oninput = apply;
document.getElementById("all").onclick = () => { Object.values(st).forEach(s => s.keep = true); save(); sync(); };
document.getElementById("none").onclick = () => { Object.values(st).forEach(s => s.keep = false); save(); sync(); };
document.getElementById("expand").onclick = () => main.querySelectorAll("details").forEach(d => d.open = true);

function buildText() {
  const keys = Object.keys(st);
  const L = [`【tutti-qa 用例确认】批次 ${D.batch}　spec ${D.hash}`];
  for (const type of ["新增", "更新", "归档"]) {
    const ks = keys.filter(k => meta[k].type === type); if (!ks.length) continue;
    const kept = ks.filter(k => st[k].keep);
    L.push(`${type}：保留 ${kept.length} / ${ks.length}`);
    ks.filter(k => !st[k].keep).forEach(k => L.push(`  ✗ 不要：${meta[k].title}` + (st[k].note ? ` ｜ ${st[k].note}` : "")));
    kept.filter(k => (meta[k].prio && st[k].prio !== meta[k].prio) || st[k].note).forEach(k =>
      L.push(`  ✎ ${meta[k].title}` + (meta[k].prio && st[k].prio !== meta[k].prio ? ` ｜ 优先级 ${meta[k].prio}→${st[k].prio}` : "") + (st[k].note ? ` ｜ ${st[k].note}` : "")));
  }
  L.push("TUTTI-QA-CASES " + JSON.stringify({batch: D.batch, hash: D.hash,
    decisions: keys.map(k => ({key: k, keep: st[k].keep, prio: (meta[k].prio && st[k].prio !== meta[k].prio) ? st[k].prio : undefined, note: st[k].note || undefined}))}));
  return L.join("\n");
}
const out = document.getElementById("out"), txt = document.getElementById("txt");
async function copy() {
  try { await navigator.clipboard.writeText(txt.value); document.getElementById("copied").textContent = "已复制"; }
  catch { txt.select(); try { document.execCommand("copy"); document.getElementById("copied").textContent = "已复制"; } catch { document.getElementById("copied").textContent = "请手动复制"; } }
}
document.getElementById("export").onclick = () => { txt.value = buildText(); out.style.display = "flex"; txt.focus(); txt.select(); copy(); };
document.getElementById("copy").onclick = copy;
document.getElementById("close").onclick = () => out.style.display = "none";
document.getElementById("dl").onclick = () => { const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([txt.value], {type: "text/plain"})); a.download = `tutti-qa-cases-${D.batch}.txt`; a.click(); };
sync();
</script></body></html>
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec")
    ap.add_argument("--snapshot", required=True)
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--batch")
    a = ap.parse_args()
    batch = a.batch or os.path.basename(os.path.dirname(os.path.abspath(a.spec)))
    data = build(a.snapshot, a.spec, batch)
    page = TPL.replace("__DATA__", json.dumps(data, ensure_ascii=False).replace("</", "<\\/")).replace("__BATCH__", html.escape(batch))
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(page)
    n = sum(len(c) for m in data["adds"] for g in m["tree"] for s in g["ch"] for c in [s["ch"]])
    print(f"已生成 {a.out}：新增 {n} 条，更新 {len(data['updates'])} 条，归档 {len(data['deletes'])} 条（spec {data['hash']}）")


if __name__ == "__main__":
    main()
