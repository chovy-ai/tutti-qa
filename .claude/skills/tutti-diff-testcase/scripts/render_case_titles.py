#!/usr/bin/env python3
"""标题树形确认页：模块 → 子模块 → 正常/异常/边界场景 → 用例标题，默认全选，一键复制标题树及兼容的 TUTTI-QA-CASES 确认结果。

用法：python3 render_case_titles.py <spec.json> --snapshot <快照目录> -o <cases.html> [--batch 名称]
"""
import argparse
import html
import json
import pathlib

from case_tool import all_cases, load_snapshot, module_name
from render_cases import confirmation_keys, grouped_creates, scene_order, spec_hash


def render(spec_path, snapshot_dir, out, batch=None):
    spec_path = pathlib.Path(spec_path)
    batch = batch or spec_path.resolve().parent.name
    spec = json.loads(spec_path.read_text(encoding='utf-8'))
    snap = load_snapshot(snapshot_dir)
    existing = all_cases(snap)
    modules = {}
    def add(module, group, key, title, scene):
        modules.setdefault(module, {}).setdefault(group, {}).setdefault(scene, []).append((key, title))
    for mod, groups in grouped_creates(spec, snap).items():
        for group, scenes in groups.items():
            for scene, items in scenes.items():
                for key, c in items:
                    add(mod, group, key, c['title'], scene)
    for label, kind, prefix in (('修改用例', 'update', 'U'), ('归档用例', 'archive', 'R')):
        for i, item in enumerate(spec.get(kind, [])):
            old = existing.get(item['id']) or {}
            cur = item.get('case') or old
            group = ' / '.join(x for x in (module_name(snap, spec, cur.get('moduleId', '')), cur.get('group')) if x)
            add(label, group or item['id'], f'{prefix}{i}', cur.get('title') or item['id'], cur.get('scene') or '用例')
    esc = lambda x: html.escape(str(x), quote=True)
    blocks = []
    keys = []
    for module, groups in modules.items():
        blocks.append('<li class="module"><label><input type="checkbox" checked class="module-check"><span class="title">' + esc(module) + '</span></label><ul>')
        for group, scenes in groups.items():
            blocks.append('<li class="group"><label><input type="checkbox" checked class="group-check"><span class="title">' + esc(group) + '</span></label><ul>')
            for scene in scene_order(scenes):
                blocks.append('<li class="scene"><label><input type="checkbox" checked class="scene-check"><span class="title">' + esc(scene) + '</span></label><ul>')
                for key, title in scenes[scene]:
                    keys.append(key)
                    blocks.append('<li class="case"><label><input type="checkbox" checked class="case-check" data-key="' + esc(key) + '"><span class="title">' + esc(title) + '</span></label></li>')
                blocks.append('</ul></li>')
            blocks.append('</ul></li>')
        blocks.append('</ul></li>')
    if sorted(keys) != sorted(confirmation_keys(spec)) or len(keys) != len(set(keys)):
        raise ValueError('确认项 key 与 spec 不一致')
    payload = json.dumps({'batch': batch, 'hash': spec_hash(spec_path)}, ensure_ascii=False).replace('</', '<\\/')
    page = TEMPLATE.replace('__TREE__', ''.join(blocks)).replace('__COUNT__', str(len(keys))).replace('__META__', payload)
    pathlib.Path(out).write_text(page, encoding='utf-8')
    return len(keys)


TEMPLATE = r'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>模块和用例标题 · 勾选确认</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#242424;--line:#e5e5e5;--muted:#747474;--accent:#315de5}@media(prefers-color-scheme:dark){:root{--bg:#17191b;--fg:#e9e9e9;--line:#35383b;--muted:#aaa;--accent:#a9baff}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.8 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}.toolbar{position:sticky;top:0;z-index:2;display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:14px 24px;background:var(--bg);border-bottom:1px solid var(--line)}button{font:inherit;font-size:13px;padding:5px 14px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);cursor:pointer}button.primary{background:var(--accent);color:var(--bg)}button:disabled{opacity:.45;cursor:default}#count,#status{font-size:12px;color:var(--muted)}#count{margin-left:auto}main{max-width:1300px;padding:24px 32px 60px;margin:auto}ul{list-style:none;margin:0;padding:0}.module{margin:0 0 24px}.module>label{font-size:18px;font-weight:650}.module>ul,.group>ul,.scene>ul{margin:8px 0 0 8px;padding-left:24px;border-left:1px solid var(--line)}.scene{margin:6px 0}.scene>label{font-size:13px;font-weight:500;color:var(--muted)}.group{margin:12px 0}.group>label{font-size:14px;font-weight:600}.case{font-size:13px;font-weight:400;padding:4px 0;overflow-wrap:anywhere}label{display:flex;align-items:baseline;gap:9px;cursor:pointer}input[type=checkbox]{accent-color:var(--accent);flex-shrink:0;width:15px;height:15px;margin:0;transform:translateY(2px)}.case:has(input:not(:checked)) .title{color:var(--muted)}#manual{position:fixed;inset:0;background:#0007;z-index:4;display:flex;align-items:center;justify-content:center}#manual[hidden]{display:none}.dialog{width:min(900px,94vw);padding:20px;border-radius:8px;background:var(--bg)}textarea{width:100%;height:55vh;font:12px/1.6 ui-monospace,monospace;background:var(--bg);color:var(--fg);border:1px solid var(--line);padding:10px}#manual p{margin:0 0 12px}#manual button{margin-top:10px}@media(max-width:600px){main{padding:20px 16px}.toolbar{padding:12px 16px}.module>ul,.group>ul,.scene>ul{padding-left:14px;margin-left:4px}#count{margin-left:0}}
</style></head><body><div class="toolbar"><button id="all">全选</button><button id="none">全不选</button><button id="copy" class="primary">一键复制</button><output id="count" aria-live="polite">已选 __COUNT__ / __COUNT__ 条</output><span id="status" role="status"></span></div><main><ul id="tree">__TREE__</ul></main><div id="manual" hidden role="dialog" aria-modal="true" aria-labelledby="manual-title"><div class="dialog"><p id="manual-title">浏览器限制了自动复制，请复制下面已选内容，再粘回对话。</p><textarea id="text" readonly aria-label="已选用例确认结果"></textarea><button id="retry">重试复制</button><button id="close">关闭</button></div></div><script>
const META=__META__;
const tree=document.getElementById('tree'),cases=[...tree.querySelectorAll('.case-check')],status=document.getElementById('status'),manual=document.getElementById('manual'),text=document.getElementById('text');
function sync(){for(const [sel,chk] of [['.scene','.scene-check'],['.group','.group-check'],['.module','.module-check']]){for(const node of tree.querySelectorAll(sel)){const children=[...node.querySelectorAll('.case-check')],box=node.querySelector(':scope > label > '+chk);box.checked=children.length>0&&children.every(x=>x.checked);box.indeterminate=children.some(x=>x.checked)&&!box.checked;}}const n=cases.filter(x=>x.checked).length;document.getElementById('count').textContent=`已选 ${n} / ${cases.length} 条`;document.getElementById('copy').disabled=n===0;status.textContent='';}
tree.addEventListener('change',event=>{const el=event.target;if(el.classList.contains('module-check')||el.classList.contains('group-check')||el.classList.contains('scene-check')){const parent=el.closest(el.classList.contains('module-check')?'.module':el.classList.contains('group-check')?'.group':'.scene');parent.querySelectorAll('.case-check').forEach(x=>x.checked=el.checked);}sync();});
document.getElementById('all').onclick=()=>{cases.forEach(x=>x.checked=true);sync();};document.getElementById('none').onclick=()=>{cases.forEach(x=>x.checked=false);sync();};
function buildText(){const lines=[],T=n=>n.querySelector(':scope > label > .title').textContent;for(const mod of tree.querySelectorAll('.module')){const groupLines=[];for(const group of mod.querySelectorAll('.group')){const sceneLines=[];for(const scene of group.querySelectorAll('.scene')){const selected=[...scene.querySelectorAll('.case')].filter(x=>x.querySelector('.case-check').checked);if(!selected.length)continue;sceneLines.push('        '+T(scene));selected.forEach(x=>sceneLines.push('            '+x.querySelector('.title').textContent));}if(sceneLines.length)groupLines.push('    '+T(group),...sceneLines);}if(groupLines.length){lines.push(T(mod),...groupLines);}}lines.push('','TUTTI-QA-CASES '+JSON.stringify({batch:META.batch,hash:META.hash,decisions:cases.map(x=>({key:x.dataset.key,keep:x.checked}))}));return lines.join('\n');}
async function copyValue(value){try{await navigator.clipboard.writeText(value);return true;}catch{}text.value=value;manual.hidden=false;text.focus();text.select();let ok=false;try{ok=document.execCommand('copy')===true;}catch{}if(ok){manual.hidden=true;}else{manual.hidden=false;text.focus();text.select();}return ok;}
async function copySelected(){if(!cases.some(x=>x.checked))return;const value=buildText(),ok=await copyValue(value);status.textContent=ok?'已复制，可粘回对话':'请在弹窗中手动复制';}
document.getElementById('copy').onclick=copySelected;document.getElementById('retry').onclick=copySelected;document.getElementById('close').onclick=()=>manual.hidden=true;sync();
</script></body></html>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('spec')
    parser.add_argument('--snapshot', required=True)
    parser.add_argument('-o', '--out', required=True)
    parser.add_argument('--batch')
    args = parser.parse_args()
    count = render(args.spec, args.snapshot, args.out, args.batch)
    print(f'已生成 {args.out}：{count} 个确认项，默认全选，支持复制确认结果')


if __name__ == '__main__':
    main()
