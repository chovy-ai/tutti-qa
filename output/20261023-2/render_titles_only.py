import json,pathlib,re,html
B=pathlib.Path(__file__).resolve().parent
spec=json.loads((B/'spec.confirmed.json').read_text())
records=[]
def walk(nodes,prefix,path=()):
 for i,n in enumerate(nodes):
  key=f'{prefix}.{i}'
  if 'case' in n:records.append((key,n['case'],path))
  else:walk(n.get('children',[]),key,path+(n.get('title',''),))
for i,a in enumerate(spec['add']):walk(a['nodes'],f'A{i}')
assert len(records)==99
esc=lambda x:html.escape(x,quote=True)
blocks=[];lines=[]
for module,prefix in [('房间管理 · 游客配置','A0.'),('房间管理 · 成员与游客','A1.'),('房间 · 登录游客','A2.0.1.'),('房间 · 匿名访问','A2.0.2.')]:
 groups={}
 for key,title,path in records:
  if key.startswith(prefix):groups.setdefault(path[-2],[]).append(re.sub(r'^(🔴|🟠|🟡)?\s*【P[012]】','',title).strip())
 lines.append(module)
 blocks.append('<li class="module"><span>'+esc(module)+'</span><ul>')
 for group,titles in groups.items():
  lines.append('    '+group)
  blocks.append('<li class="group"><span>'+esc(group)+'</span><ul>')
  for title in titles:
   lines.append('        '+title)
   blocks.append('<li class="case">'+esc(title)+'</li>')
  blocks.append('</ul></li>')
 blocks.append('</ul></li>')
page='''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>游客访问模块和用例标题</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#242424;--line:#e5e5e5}@media(prefers-color-scheme:dark){:root{--bg:#17191b;--fg:#e9e9e9;--line:#35383b}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.8 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}main{max-width:1300px;padding:28px 32px 60px;margin:auto}ul{list-style:none;margin:0;padding:0}.module{margin:0 0 24px}.module>span{font-size:18px;font-weight:650}.module>ul,.group>ul{margin:8px 0 0 8px;padding-left:24px;border-left:1px solid var(--line)}.group{margin:12px 0}.group>span{font-size:14px;font-weight:600}.case{font-size:13px;font-weight:400;padding:4px 0;overflow-wrap:anywhere}@media(max-width:600px){main{padding:20px 16px}.module>ul,.group>ul{padding-left:14px;margin-left:4px}}
</style></head><body><main><ul>'''+''.join(blocks)+'</ul></main></body></html>'
(B/'游客访问_模块和用例标题.html').write_text(page)
(B/'游客访问_模块和用例标题.txt').write_text('\n'.join(lines)+'\n')
assert page.count('class="module"')==4
assert page.count('class="group"')==19
assert page.count('class="case"')==99
assert '<script' not in page and '<details' not in page
print('通过：4 个模块、19 个子模块、99 个用例标题；无详情、编号、优先级或场景标签。')
