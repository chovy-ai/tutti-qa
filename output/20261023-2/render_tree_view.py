#!/usr/bin/env python3
"""将已确认游客用例展示为 模块 → 子模块 → 用例；不修改正式用例库。"""
import html,json,pathlib,re,sys
B=pathlib.Path(__file__).resolve().parent
S=B.parents[1]/'.claude/skills/tutti-diff-testcase/scripts'
sys.path.insert(0,str(S));import render_cases as r
spec=json.loads((B/'spec.confirmed.json').read_text())
meta={m['key']:m for m in json.loads((B/'用例追溯.json').read_text())}
records=[(key,n,path) for key,n,path in r.walk_add(spec) if 'case' in n]
assert len(records)==99
modules=[]
for name,prefix in [('房间管理 · 游客配置','A0.'),('房间管理 · 成员与游客','A1.'),('房间 · 登录游客','A2.0.1.'),('房间 · 匿名访问','A2.0.2.')]:
 groups={}
 for key,n,path in records:
  if not key.startswith(prefix):continue
  group=path[-2]
  groups.setdefault(group,[]).append((key,n,path))
 modules.append((name,groups))
esc=lambda value:html.escape(str(value),quote=True)
outline=[];blocks=[]
for name,groups in modules:
 total=sum(len(cs) for cs in groups.values())
 outline.append(name)
 blocks.append('<details open class="branch module"><summary>'+esc(name)+'<span class="count">'+str(total)+' 条</span></summary><div class="children">')
 for group,cs in groups.items():
  outline.append('    '+group)
  blocks.append('<details open class="branch group"><summary>'+esc(group)+'<span class="count">'+str(len(cs))+' 条</span></summary><div class="children">')
  for key,n,path in cs:
   title=re.sub(r'^(🔴|🟠|🟡)?\s*【P[012]】','',n['case']).strip()
   prio=r.prio_of(n['case']);scene=path[-1].removesuffix('场景')
   outline.append('        '+n['case'])
   body='<div class="case-body"><div class="location">原库位置：'+esc(meta[key]['path'])+'</div>'
   for label,field in [('前置','pre'),('操作','op')]:body+='<section><h4>'+label+'</h4><p>'+esc(n[field])+'</p></section>'
   body+='<section><h4>预期</h4><ol>'+''.join('<li>'+esc(re.sub(r'^\d+\)\s*','',line))+'</li>' for line in n['expect'])+'</ol></section>'
   if n.get('note'):body+='<section><h4>备注</h4><p>'+esc(n['note'])+'</p></section>'
   body+='</div>'
   search=' '.join([name,group,title,n['pre'],n['op'],*n['expect'],n.get('note','')]).lower()
   blocks.append('<details class="case" data-key="'+esc(key)+'" data-priority="'+prio+'" data-search="'+esc(search)+'"><summary><span class="case-title">'+esc(title)+'</span><span class="badge '+prio+'">'+prio+'</span><span class="scene">'+scene+'</span></summary>'+body+'</details>')
  blocks.append('</div></details>')
 blocks.append('</div></details>')
css='''
:root{color-scheme:light dark;--bg:#fff;--fg:#242424;--muted:#737373;--line:#e7e7e7;--hover:#f7f7f7;--detail:#fafafa;--accent:#315de5}
@media(prefers-color-scheme:dark){:root{--bg:#151719;--fg:#e7e7e7;--muted:#a5a5a5;--line:#34373b;--hover:#202327;--detail:#1c1f22;--accent:#91a7ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}header{padding:22px 32px 16px;border-bottom:1px solid var(--line);background:var(--bg)}h1{font-size:21px;margin:0 0 3px;font-weight:650}.subtitle{color:var(--muted);font-size:12px;margin:0}.toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:14px}button,input{font:inherit;font-size:12px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);padding:5px 10px}button{cursor:pointer}button:hover{background:var(--hover)}input{width:min(320px,100%)}#visible{margin-left:auto;color:var(--muted);font-size:12px}main{padding:18px 32px 64px;max-width:1420px;margin:0 auto}summary{cursor:pointer;list-style:none;position:relative;padding:6px 0 6px 19px;overflow-wrap:anywhere}summary::-webkit-details-marker{display:none}summary::before{content:'▸';position:absolute;left:1px;top:6px;color:var(--muted);font-size:12px}details[open]>summary::before{content:'▾'}summary:hover{background:var(--hover);border-radius:4px}summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.module{margin:8px 0 20px}.module>summary{font-size:17px;font-weight:650}.group{margin:7px 0}.group>summary{font-size:14px;font-weight:600}.children{margin-left:7px;padding-left:22px;border-left:1px solid var(--line)}.count{margin-left:10px;font-size:11px;color:var(--muted);font-weight:400}.case>summary{font-size:13px;font-weight:400;padding-top:5px;padding-bottom:5px;display:flex;align-items:baseline;gap:7px}.case-title{min-width:0}.badge,.scene{font-size:10px;line-height:1.7;white-space:nowrap;border:1px solid var(--line);border-radius:4px;padding:0 5px;flex-shrink:0}.scene{color:var(--muted)}.P0{color:light-dark(#b42332,#ffa5ad);background:light-dark(#fff0f0,#372126)}.P1{color:light-dark(#975207,#edc288);background:light-dark(#fff7e9,#332b1f)}.P2{color:light-dark(#5a6170,#aeb8cb);background:light-dark(#f2f4f7,#252b35)}.case-body{margin:3px 0 12px 19px;padding:14px 18px;border:1px solid var(--line);border-radius:6px;background:var(--detail);font-size:12px;line-height:1.8}.location{color:var(--muted);font-size:11px;margin-bottom:12px;overflow-wrap:anywhere}section{margin:10px 0}h4{font-size:12px;margin:0 0 4px}p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}ol{margin:0;padding-left:22px}li{margin:3px 0;overflow-wrap:anywhere}[hidden]{display:none!important}#empty{color:var(--muted);padding:24px}.hint{margin:0 0 8px;color:var(--muted);font-size:12px}@media(max-width:640px){header{padding:16px}main{padding:12px 12px 40px}.children{padding-left:12px;margin-left:4px}.case>summary{flex-wrap:wrap;gap:4px}.case-title{flex-basis:100%}.case-body{margin-left:0;padding:12px}.module>summary{font-size:15px}#visible{margin-left:0;width:100%}}
'''
js='''
const cases=[...document.querySelectorAll('.case')],branches=[...document.querySelectorAll('.branch')];
function apply(){const q=document.querySelector('#search').value.trim().toLowerCase();let count=0;for(const el of cases){el.hidden=!!q&&!el.dataset.search.includes(q);if(!el.hidden)count++;}for(const el of [...branches].reverse()){el.hidden=![...el.querySelectorAll('.case')].some(c=>!c.hidden);if(q&&!el.hidden)el.open=true;}document.querySelector('#visible').textContent='显示 '+count+' / '+cases.length+' 条';document.querySelector('#empty').hidden=count!==0;}
document.querySelector('#search').addEventListener('input',apply);
document.querySelector('#open-tree').onclick=()=>branches.forEach(el=>el.open=true);
document.querySelector('#close-tree').onclick=()=>branches.forEach(el=>el.open=false);
document.querySelector('#open-cases').onclick=()=>{branches.forEach(el=>{if(!el.hidden)el.open=true;});cases.forEach(el=>{if(!el.hidden)el.open=true;});};
document.querySelector('#close-cases').onclick=()=>cases.forEach(el=>el.open=false);
apply();
'''
page='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>游客访问用例 · 模块树形目录</title><style>'+css+'</style></head><body><header><h1>游客访问用例</h1><p class="subtitle">模块 → 子模块 → 用例　·　已确认 99 条 / 607 个断言　·　P0 20 · P1 47 · P2 32</p><div class="toolbar"><input type="search" id="search" aria-label="搜索用例" placeholder="搜索模块、用例或预期"><button id="open-tree">展开目录</button><button id="close-tree">收起目录</button><button id="open-cases">展开用例详情</button><button id="close-cases">收起用例详情</button><span id="visible">显示 99 / 99 条</span></div></header><main><p class="hint">本批新增用例目录；点击模块可收起分支，点击用例查看前置、操作和预期。</p>'+''.join(blocks)+'<p id="empty" hidden>没有匹配的用例。</p></main><script>'+js+'</script></body></html>'
(B/'游客访问用例_模块树形目录.html').write_text(page)
(B/'游客访问用例_模块树形目录.txt').write_text('\n'.join(outline)+'\n')
print('已生成树形目录：4 个模块，'+str(sum(len(g) for n,g in modules))+' 个子模块，99 条用例，607 个断言。')
