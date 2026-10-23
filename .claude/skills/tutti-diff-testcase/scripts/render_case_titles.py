#!/usr/bin/env python3
"""标题树形确认页：默认全选，一键复制标题树及兼容的 TUTTI-QA-CASES 确认结果。"""
import argparse
import html
import json
import pathlib
import re

import pos_tool as t
from render_cases import build, spec_hash, walk_add


def render(pos, spec_path, out, batch=None, layout=None):
    spec_path = pathlib.Path(spec_path)
    batch = batch or spec_path.resolve().parent.name
    spec = json.loads(spec_path.read_text(encoding='utf-8'))
    data = build(pos, spec_path, batch)
    modules = {}
    def add(module, group, key, title):
        modules.setdefault(module, {}).setdefault(group, []).append((key, title))
    for key, node, path in walk_add(spec):
        if 'case' not in node:
            continue
        title = t.PRIO_RE.sub('', node['case']).strip()
        ancestors = [p for p in path if not p.startswith(('正常场景', '异常场景', '边界场景'))]
        parent = spec['add'][int(key.split('.')[0][1:])]
        host = parent.get('parent_path') or data['adds'][int(key.split('.')[0][1:])]['host']
        module = host + (' / ' + ancestors[0] if ancestors else '')
        group = ' / '.join(ancestors[1:]) or '用例'
        if layout:
            matches = [x for x in layout if key.startswith(x['prefix'])]
            if len(matches) != 1:
                raise ValueError(f'用例布局须唯一覆盖 key：{key}')
            module = matches[0]['title']
            group = ancestors[-1] if ancestors else '用例'
        add(module, group, key, title)
    root = t.root_of(t.load(pos))
    index = {node['id']: node for node, path in t.iter_nodes(root)}
    def label(node_id):
        node = index[node_id]
        current = node
        while current is not None:
            if t.is_case(current):
                return t.PRIO_RE.sub('', t.strip(current.get('title'))).strip()
            current = index.get(current.get('parent'))
        return t.strip(node.get('title'))
    for i, item in enumerate(data['updates']):
        add('修改用例', '已有用例标题', item['k'], label(spec['update'][i]['id']))
    for i, item in enumerate(data['deletes']):
        add('删除用例', '删除范围标题', item['k'], label(spec['delete'][i]['id']))
    esc = lambda x: html.escape(str(x), quote=True)
    blocks = []
    count = 0
    keys = []
    for module, groups in modules.items():
        blocks.append('<li class="module"><label><input type="checkbox" checked class="module-check"><span class="title">' + esc(module) + '</span></label><ul>')
        for group, cases in groups.items():
            blocks.append('<li class="group"><label><input type="checkbox" checked class="group-check"><span class="title">' + esc(group) + '</span></label><ul>')
            for key, title in cases:
                keys.append(key)
                count += 1
                blocks.append('<li class="case"><label><input type="checkbox" checked class="case-check" data-key="' + esc(key) + '"><span class="title">' + esc(title) + '</span></label></li>')
            blocks.append('</ul></li>')
        blocks.append('</ul></li>')
    if len(keys) != len(set(keys)):
        raise ValueError('确认项 key 重复')
    payload = json.dumps({'batch': batch, 'hash': spec_hash(spec_path)}, ensure_ascii=False).replace('</', '<\\/')
    page = TEMPLATE.replace('__TREE__', ''.join(blocks)).replace('__COUNT__', str(count)).replace('__META__', payload)
    pathlib.Path(out).write_text(page, encoding='utf-8')
    return count


TEMPLATE = r'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>模块和用例标题 · 勾选确认</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#242424;--line:#e5e5e5;--muted:#747474;--accent:#315de5}@media(prefers-color-scheme:dark){:root{--bg:#17191b;--fg:#e9e9e9;--line:#35383b;--muted:#aaa;--accent:#a9baff}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.8 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}.toolbar{position:sticky;top:0;z-index:2;display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:14px 24px;background:var(--bg);border-bottom:1px solid var(--line)}button{font:inherit;font-size:13px;padding:5px 14px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);cursor:pointer}button.primary{background:var(--accent);color:var(--bg)}button:disabled{opacity:.45;cursor:default}#count,#status{font-size:12px;color:var(--muted)}#count{margin-left:auto}main{max-width:1300px;padding:24px 32px 60px;margin:auto}ul{list-style:none;margin:0;padding:0}.module{margin:0 0 24px}.module>label{font-size:18px;font-weight:650}.module>ul,.group>ul{margin:8px 0 0 8px;padding-left:24px;border-left:1px solid var(--line)}.group{margin:12px 0}.group>label{font-size:14px;font-weight:600}.case{font-size:13px;font-weight:400;padding:4px 0;overflow-wrap:anywhere}label{display:flex;align-items:baseline;gap:9px;cursor:pointer}input[type=checkbox]{accent-color:var(--accent);flex-shrink:0;width:15px;height:15px;margin:0;transform:translateY(2px)}.case:has(input:not(:checked)) .title{color:var(--muted)}#manual{position:fixed;inset:0;background:#0007;z-index:4;display:flex;align-items:center;justify-content:center}#manual[hidden]{display:none}.dialog{width:min(900px,94vw);padding:20px;border-radius:8px;background:var(--bg)}textarea{width:100%;height:55vh;font:12px/1.6 ui-monospace,monospace;background:var(--bg);color:var(--fg);border:1px solid var(--line);padding:10px}#manual p{margin:0 0 12px}#manual button{margin-top:10px}@media(max-width:600px){main{padding:20px 16px}.toolbar{padding:12px 16px}.module>ul,.group>ul{padding-left:14px;margin-left:4px}#count{margin-left:0}}
</style></head><body><div class="toolbar"><button id="all">全选</button><button id="none">全不选</button><button id="copy" class="primary">一键复制</button><output id="count" aria-live="polite">已选 __COUNT__ / __COUNT__ 条</output><span id="status" role="status"></span></div><main><ul id="tree">__TREE__</ul></main><div id="manual" hidden role="dialog" aria-modal="true" aria-labelledby="manual-title"><div class="dialog"><p id="manual-title">浏览器限制了自动复制，请复制下面已选内容，再粘回对话。</p><textarea id="text" readonly aria-label="已选用例确认结果"></textarea><button id="retry">重试复制</button><button id="close">关闭</button></div></div><script>
const META=__META__;
const tree=document.getElementById('tree'),cases=[...tree.querySelectorAll('.case-check')],status=document.getElementById('status'),manual=document.getElementById('manual'),text=document.getElementById('text');
function sync(){for(const group of tree.querySelectorAll('.group')){const children=[...group.querySelectorAll('.case-check')],box=group.querySelector('.group-check');box.checked=children.length>0&&children.every(x=>x.checked);box.indeterminate=children.some(x=>x.checked)&&!box.checked;}for(const mod of tree.querySelectorAll('.module')){const children=[...mod.querySelectorAll('.case-check')],box=mod.querySelector('.module-check');box.checked=children.length>0&&children.every(x=>x.checked);box.indeterminate=children.some(x=>x.checked)&&!box.checked;}const n=cases.filter(x=>x.checked).length;document.getElementById('count').textContent=`已选 ${n} / ${cases.length} 条`;document.getElementById('copy').disabled=n===0;status.textContent='';}
tree.addEventListener('change',event=>{const el=event.target;if(el.classList.contains('module-check')||el.classList.contains('group-check')){const parent=el.closest(el.classList.contains('module-check')?'.module':'.group');parent.querySelectorAll('.case-check').forEach(x=>x.checked=el.checked);}sync();});
document.getElementById('all').onclick=()=>{cases.forEach(x=>x.checked=true);sync();};document.getElementById('none').onclick=()=>{cases.forEach(x=>x.checked=false);sync();};
function buildText(){const lines=[];for(const mod of tree.querySelectorAll('.module')){const groupLines=[];for(const group of mod.querySelectorAll('.group')){const selected=[...group.querySelectorAll('.case')].filter(x=>x.querySelector('.case-check').checked);if(!selected.length)continue;groupLines.push('    '+group.querySelector(':scope > label > .title').textContent);selected.forEach(x=>groupLines.push('        '+x.querySelector('.title').textContent));}if(groupLines.length){lines.push(mod.querySelector(':scope > label > .title').textContent,...groupLines);}}lines.push('','TUTTI-QA-CASES '+JSON.stringify({batch:META.batch,hash:META.hash,decisions:cases.map(x=>({key:x.dataset.key,keep:x.checked}))}));return lines.join('\n');}
async function copyValue(value){try{await navigator.clipboard.writeText(value);return true;}catch{}text.value=value;manual.hidden=false;text.focus();text.select();let ok=false;try{ok=document.execCommand('copy')===true;}catch{}if(ok){manual.hidden=true;}else{manual.hidden=false;text.focus();text.select();}return ok;}
async function copySelected(){if(!cases.some(x=>x.checked))return;const value=buildText(),ok=await copyValue(value);status.textContent=ok?'已复制，可粘回对话':'请在弹窗中手动复制';}
document.getElementById('copy').onclick=copySelected;document.getElementById('retry').onclick=copySelected;document.getElementById('close').onclick=()=>manual.hidden=true;sync();
</script></body></html>'''


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pos')
    parser.add_argument('spec')
    parser.add_argument('-o','--out',required=True)
    parser.add_argument('--batch')
    parser.add_argument('--layout',help='可选 JSON 数组，每项为 title/prefix，唯一覆盖新增用例 key')
    args=parser.parse_args()
    layout=json.loads(pathlib.Path(args.layout).read_text(encoding='utf-8')) if args.layout else None
    count=render(args.pos,args.spec,args.out,args.batch,layout)
    print(f'已生成 {args.out}：{count} 个确认项，默认全选，支持复制确认结果')

if __name__=='__main__':
    main()
