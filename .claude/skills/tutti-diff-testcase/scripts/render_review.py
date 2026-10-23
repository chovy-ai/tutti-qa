#!/usr/bin/env python3
"""把 changes.json 渲染成 QA 勾选确认页（单文件 HTML，无外部依赖）。

用法：python3 render_review.py output/<batch>/changes.json -o output/<batch>/review.html

页面功能：按仓库分组列出每个 PR / commit；候选默认勾选、噪音默认不勾选；可按「候选 / 噪音 / 全部」
筛选、关键词搜索、展开看文件与 PR 描述、逐条写备注；勾选状态存在浏览器本地。
点「导出确认结果」生成一段文本（末行是 TUTTI-QA-CONFIRM 开头的 JSON），复制后粘回对话即可。
"""
import argparse
import html
import json

TPL = r"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>变更确认 · __BATCH__</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--line:#e3e6ea;--muted:#6b7280;--txt:#111827;--acc:#2563eb;--warn:#b45309;--ok:#047857}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--card:#1a1e24;--line:#2b313a;--muted:#9aa3ae;--txt:#e5e7eb;--acc:#60a5fa;--warn:#f59e0b;--ok:#34d399}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--txt)}
header{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line);padding:12px 20px}
h1{font-size:17px;margin:0 0 4px}.sub{color:var(--muted);font-size:12px}
.scope{display:flex;gap:16px;flex-wrap:wrap;margin-top:8px;font-size:12px}.scope b{color:var(--txt)}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}
button,select,input[type=search]{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--txt);border-radius:6px;padding:4px 10px}
button{cursor:pointer}button.primary{background:var(--acc);border-color:var(--acc);color:#fff}
.count{margin-left:auto;font-weight:600}
main{padding:12px 20px 80px;max-width:1200px;margin:0 auto}
h2{font-size:15px;margin:18px 0 8px}
.item{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:6px 0;display:grid;grid-template-columns:24px 1fr;gap:8px}
.item.noise{opacity:.72}.item.hide{display:none}
.title{font-weight:600}.title a{color:inherit;text-decoration:none}.title a:hover{text-decoration:underline}
.meta{color:var(--muted);font-size:12px;margin-top:2px}
.chips{margin-top:6px;display:flex;gap:4px;flex-wrap:wrap}
.chip{font-size:12px;border:1px solid var(--line);border-radius:10px;padding:0 8px}
.chip.mod{color:var(--acc);border-color:color-mix(in srgb,var(--acc) 40%,transparent)}
.chip.noise{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,transparent)}
.impact{margin-top:6px;padding:6px 8px;border-left:3px solid var(--ok);background:color-mix(in srgb,var(--ok) 8%,transparent);font-size:13px}
details{margin-top:6px;font-size:12px}summary{cursor:pointer;color:var(--muted)}
pre{white-space:pre-wrap;word-break:break-all;margin:4px 0;max-height:260px;overflow:auto;background:var(--bg);padding:6px;border-radius:4px}
.note{width:100%;margin-top:6px;font:inherit;font-size:12px;border:1px solid var(--line);border-radius:6px;padding:4px 8px;background:transparent;color:var(--txt)}
input[type=checkbox]{width:18px;height:18px;margin-top:2px}
#out{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;z-index:9}
#out .box{background:var(--card);width:min(900px,94vw);border-radius:10px;padding:16px}
#out textarea{width:100%;height:50vh;font:12px/1.5 ui-monospace,Menlo,monospace;background:var(--bg);color:var(--txt);border:1px solid var(--line);border-radius:6px;padding:8px}
.tip{color:var(--muted);font-size:12px;margin:6px 0}
</style></head><body>
<header>
 <h1>变更确认 · 批次 __BATCH__</h1>
 <div class="sub" id="range"></div>
 <div class="scope" id="scope"></div>
 <div class="bar">
  <button data-f="cand" class="primary">候选</button><button data-f="noise">噪音</button><button data-f="all">全部</button>
  <input type="search" id="q" placeholder="搜索标题 / 模块 / 文件">
  <button id="selCand">勾选全部候选</button><button id="clear">全部取消</button>
  <span class="count" id="count"></span>
  <button class="primary" id="export">导出确认结果</button>
 </div>
</header>
<main id="list"></main>
<div id="out"><div class="box">
 <b>确认结果</b>
 <div class="tip">已自动复制到剪贴板；如未复制成功，点「复制」或手动全选复制，然后粘贴回对话。</div>
 <textarea id="txt" readonly></textarea>
 <div class="bar"><button class="primary" id="copy">复制</button><button id="dl">下载 .txt</button><button id="close">关闭</button><span class="tip" id="copied"></span></div>
</div></div>
<script>
const D = __DATA__;
const KEY = "tutti-qa-review:" + D.batch;
// 预览面板可能以沙箱运行、禁止 localStorage；不可用时只是不记住勾选状态，页面照常工作
const store = (() => { try { const s = window.localStorage; s.getItem("_"); return s; } catch { return null; } })();
let saved = {}; try { saved = JSON.parse((store && store.getItem(KEY)) || "{}"); } catch {}
const st = {};
D.items.forEach(i => st[i.key] = saved[i.key] || {checked: i.checked, note: ""});
const save = () => { try { store && store.setItem(KEY, JSON.stringify(st)); } catch {} };
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const short = r => r.split("/")[1];
const prLabel = i => short(i.repo) + (i.pr ? "#" + i.pr : "@" + i.sha.slice(0,10));

document.getElementById("range").textContent = Object.entries(D.repos).map(([r,v]) => `${r}  ${v.base.slice(0,10)} → ${v.head.slice(0,10)}`).join("　｜　") + `　·　生成于 ${D.generated_at}`;
const sc = D.scope || {};
document.getElementById("scope").innerHTML =
  `<span>新增模块：<b>${esc((sc.add||[]).join("、") || "无（不新增模块）")}</b></span>` +
  `<span>更新：<b>${sc.update === "auto" || !sc.update ? "按 commit diff 自动识别" : esc(sc.update)}</b></span>` +
  `<span>删除模块：<b>${esc((sc.delete||[]).join("、") || "无")}</b></span>`;

const list = document.getElementById("list");
for (const repo of Object.keys(D.repos)) {
  const items = D.items.filter(i => i.repo === repo);
  const h = document.createElement("h2"); h.textContent = `${repo}（${items.length}）`; list.appendChild(h);
  for (const i of items) {
    const el = document.createElement("div");
    el.className = "item" + (i.noise ? " noise" : ""); el.dataset.key = i.key;
    el.dataset.text = (i.title + " " + i.modules.join(" ") + " " + i.files.join(" ") + " " + (i.pr||"")).toLowerCase();
    el.innerHTML = `<input type="checkbox" ${st[i.key].checked ? "checked" : ""}>
     <div><div class="title"><a href="${esc(i.url)}" target="_blank">${esc(prLabel(i))}</a>　${esc(i.title)}</div>
     <div class="meta">${esc(i.author)} · ${esc(i.date.slice(0,16).replace("T"," "))} · ${i.files.length} 个文件 +${i.add}/-${i.del} · ${esc(i.sha.slice(0,10))}</div>
     <div class="chips">${i.modules.map(m => `<span class="chip mod">${esc(m)}</span>`).join("")}${i.noise ? `<span class="chip noise">默认不选：${esc(i.noise)}</span>` : ""}${(i.labels||[]).map(l => `<span class="chip">${esc(l)}</span>`).join("")}</div>
     ${i.impact ? `<div class="impact">${esc(i.impact)}</div>` : ""}
     <details><summary>文件与 PR 描述</summary><pre>${esc(i.files.join("\n"))}</pre>${i.body ? `<pre>${esc(i.body)}</pre>` : ""}</details>
     <input class="note" placeholder="备注（可选）：例如只关注其中的某个改动、口径说明" value="${esc(st[i.key].note)}"></div>`;
    el.querySelector("input[type=checkbox]").onchange = e => { st[i.key].checked = e.target.checked; save(); count(); };
    el.querySelector(".note").oninput = e => { st[i.key].note = e.target.value; save(); };
    list.appendChild(el);
  }
}
let filter = "cand";
function apply() {
  const q = document.getElementById("q").value.trim().toLowerCase();
  for (const el of list.querySelectorAll(".item")) {
    const i = D.items.find(x => x.key === el.dataset.key);
    const okF = filter === "all" || (filter === "cand" ? !i.noise : !!i.noise);
    el.classList.toggle("hide", !(okF && (!q || el.dataset.text.includes(q))));
  }
}
function count() {
  const n = D.items.filter(i => st[i.key].checked).length;
  document.getElementById("count").textContent = `已勾选 ${n} / ${D.items.length}`;
}
document.querySelectorAll("[data-f]").forEach(b => b.onclick = () => {
  filter = b.dataset.f; document.querySelectorAll("[data-f]").forEach(x => x.classList.toggle("primary", x === b)); apply(); });
document.getElementById("q").oninput = apply;
const setAll = pred => { D.items.forEach(i => st[i.key].checked = pred(i)); save();
  list.querySelectorAll(".item").forEach(el => el.querySelector("input[type=checkbox]").checked = st[el.dataset.key].checked); count(); };
document.getElementById("selCand").onclick = () => setAll(i => !i.noise || st[i.key].checked);
document.getElementById("clear").onclick = () => setAll(() => false);

function buildText() {
  const sel = D.items.filter(i => st[i.key].checked), uns = D.items.filter(i => !st[i.key].checked);
  const L = [`【tutti-qa 变更确认】批次 ${D.batch}`,
    "范围：" + Object.entries(D.repos).map(([r,v]) => `${short(r)} ${v.base.slice(0,10)}→${v.head.slice(0,10)}`).join("；"),
    `QA 声明 · 新增模块：${(sc.add||[]).join("、") || "无"}；删除模块：${(sc.delete||[]).join("、") || "无"}`,
    `已勾选 ${sel.length} / ${D.items.length}：`];
  sel.forEach((i, n) => L.push(`${n+1}. ${prLabel(i)} ${i.sha.slice(0,10)} ${i.title}` + (i.modules.length ? ` ｜ 模块：${i.modules.join("、")}` : "") + (st[i.key].note ? ` ｜ 备注：${st[i.key].note}` : "")));
  L.push(`未勾选 ${uns.length} 条：` + (uns.map(prLabel).join("、") || "无"));
  L.push("TUTTI-QA-CONFIRM " + JSON.stringify({batch: D.batch,
    selected: sel.map(i => ({key: i.key, note: st[i.key].note || undefined})), unselected: uns.map(i => i.key)}));
  return L.join("\n");
}
const out = document.getElementById("out"), txt = document.getElementById("txt");
async function copy() {
  try { await navigator.clipboard.writeText(txt.value); document.getElementById("copied").textContent = "已复制"; }
  catch { txt.select(); try { document.execCommand("copy"); document.getElementById("copied").textContent = "已复制"; }
          catch { document.getElementById("copied").textContent = "请手动复制"; } }
}
document.getElementById("export").onclick = () => { txt.value = buildText(); out.style.display = "flex"; txt.focus(); txt.select(); copy(); };
document.getElementById("copy").onclick = copy;
document.getElementById("close").onclick = () => out.style.display = "none";
document.getElementById("dl").onclick = () => { const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([txt.value], {type: "text/plain"})); a.download = `tutti-qa-confirm-${D.batch}.txt`; a.click(); };
apply(); count();
</script></body></html>
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("changes")
    ap.add_argument("-o", "--out", required=True)
    a = ap.parse_args()
    with open(a.changes, encoding="utf-8") as f:
        d = json.load(f)
    data = json.dumps(d, ensure_ascii=False).replace("</", "<\\/")
    page = TPL.replace("__DATA__", data).replace("__BATCH__", html.escape(d["batch"]))
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(page)
    n = len(d["items"])
    c = sum(1 for i in d["items"] if i["checked"])
    print(f"已生成 {a.out}：{n} 条，默认勾选 {c} 条")


if __name__ == "__main__":
    main()
