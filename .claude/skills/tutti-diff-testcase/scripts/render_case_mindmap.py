#!/usr/bin/env python3
"""Render compact case-usage checkboxes as a standalone HTML mind map."""
import argparse
import hashlib
import html
import json
from pathlib import Path
import re

ASSETS = Path(__file__).resolve().parents[1] / 'assets' / 'case-mindmap'
SCENES = ('正常场景', '异常场景', '边界场景')


def normalize_cases(raw):
    records = raw.get('cases') if isinstance(raw, dict) else raw
    if not isinstance(records, list) or not records:
        raise ValueError('cases 必须是非空数组，输入完整用例而不是 spec 操作列表。')
    cases, categories, names, ids = [], [], {}, set()
    for record in records:
        case = {}
        for key in ('id', 'title', 'group', 'scene', 'priority'):
            value = record.get(key)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f'用例缺少字符串字段：{key}')
            case[key] = value
        if case['id'] in ids:
            raise ValueError(f"重复用例 id：{case['id']}")
        ids.add(case['id'])
        if case['scene'] not in SCENES or case['priority'] not in ('P0', 'P1', 'P2'):
            raise ValueError(f"场景或优先级无效：{case['id']}")
        for key, default in (('kind', '功能回归'), ('pre', ''), ('note', '')):
            case[key] = record.get(key, default)
            if not isinstance(case[key], str):
                raise ValueError(f'{key} 必须是字符串')
        if case['kind'] not in ('功能回归', '专项验证'):
            raise ValueError('kind 必须是功能回归或专项验证')
        for key in ('steps', 'expect'):
            case[key] = record.get(key, [])
            if not isinstance(case[key], list) or any(not isinstance(x, str) for x in case[key]):
                raise ValueError(f'{key} 必须是字符串数组')
        category = record.get('category') or record.get('module') or case['group'].split(' / ')[0]
        if not isinstance(category, str):
            raise ValueError('category / module 必须是字符串')
        if category not in names:
            names[category] = f'module-{len(names)}'
            categories.append([names[category], category])
        case['categoryId'] = names[category]
        cases.append(case)
    reserved = {'root'}
    for category_id, _ in categories:
        reserved.add(category_id)
        groups = list(dict.fromkeys(c['group'] for c in cases if c['categoryId'] == category_id))
        for i, _ in enumerate(groups):
            group_id = f'{category_id}-g{i}'
            reserved.add(group_id)
            reserved.update(f'{group_id}-{scene}' for scene in SCENES)
    if ids & reserved:
        raise ValueError('用例 id 与导图分组 id 冲突，请使用稳定的原用例 id。')
    return cases, categories


def confirmation_keys(spec):
    keys = {f'U{i}' for i, _ in enumerate(spec.get('update', []))}
    keys.update(f'D{i}' for i, _ in enumerate(spec.get('delete', [])))

    def walk(nodes, prefix):
        for i, node in enumerate(nodes):
            key = f'{prefix}.{i}'
            if 'case' in node or not node.get('children'):
                keys.add(key)
            else:
                walk(node['children'], key)
    for i, item in enumerate(spec.get('add', [])):
        walk(item['nodes'], f'A{i}')
    return keys


def validate_confirmation(meta, spec_path, cases):
    fingerprint = hashlib.sha256(spec_path.read_bytes()).hexdigest()[:16]
    if meta.get('hash') != fingerprint or not isinstance(meta.get('batch'), str) or not meta['batch']:
        raise ValueError('确认元数据的 batch 缺失或 spec 指纹已变化，请重新生成映射。')
    ids = {c['id'] for c in cases}
    rows, extras, all_keys = meta['cases'], meta['extraKeys'], meta['allKeys']
    if len(rows) != len(ids) or {c['id'] for c in rows} != ids:
        raise ValueError('确认映射必须逐条覆盖导图用例；无变更用例的 keys 可为空。')
    mapped = [key for row in rows for key in row['keys']]
    if any(not isinstance(row['keys'], list) for row in rows):
        raise ValueError('keys 必须是数组')
    for key, owners in extras.items():
        if not isinstance(owners, list) or not owners or not set(owners) <= ids:
            raise ValueError(f'共享说明没有有效的所属用例：{key}')
    mapped.extend(extras)
    if (any(not isinstance(key, str) for key in mapped + all_keys) or
            len(mapped) != len(set(mapped)) or len(all_keys) != len(set(all_keys)) or
            set(mapped) != set(all_keys)):
        raise ValueError('确认 key 重复、遗漏或未映射，不能导出可合并确认。')
    if set(all_keys) != confirmation_keys(json.loads(spec_path.read_text(encoding='utf-8'))):
        raise ValueError('确认 key 没有完整覆盖 spec 的新增用例 / 说明、更新和删除。')


def render(cases_path, out, title='测试用例', confirmation=None, spec=None):
    if bool(confirmation) != bool(spec):
        raise ValueError('--confirmation 和 --spec 必须同时提供；不提供时仅导出勾选清单。')
    cases, categories = normalize_cases(json.loads(Path(cases_path).read_text(encoding='utf-8')))
    meta = json.loads(Path(confirmation).read_text(encoding='utf-8')) if confirmation else None
    if meta is not None:
        validate_confirmation(meta, Path(spec), cases)
    # Match the established snapshot key for the same case content and ordering.
    content = [{k: v for k, v in c.items() if k != 'categoryId'} for c in cases]
    suite_id = hashlib.sha256(json.dumps(content, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:20]
    data = {'title': title, 'cases': cases, 'categories': categories, 'suiteId': suite_id, 'confirmation': meta}
    values = {
        '__TITLE__': html.escape(title),
        '__STYLE__': (ASSETS / 'map.css').read_text() + (ASSETS / 'selection.css').read_text(),
        '__DATA__': json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c'),
        '__SELECTION_MODEL__': (ASSETS / 'selection.js').read_text(),
        '__SCRIPT__': (ASSETS / 'map.js').read_text(),
    }
    page = re.sub('|'.join(map(re.escape, values)), lambda match: values[match[0]],
                  (ASSETS / 'map.html').read_text(encoding='utf-8'))
    out = Path(out)
    if out.suffix.lower() != '.html' or out.resolve() in {Path(cases_path).resolve(), *(Path(p).resolve() for p in (confirmation, spec) if p)}:
        raise ValueError('输出须为独立的 .html 文件，不能覆盖输入。')
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding='utf-8')
    return {'file': str(out.resolve()), 'cases': len(cases), 'confirmation': meta is not None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cases', help='完整 cases.json 或用例数组')
    parser.add_argument('-o', '--out', required=True)
    parser.add_argument('--title', default='测试用例')
    parser.add_argument('--confirmation', help='逐用例的确认 key 映射，详见 references/case-mindmap.md')
    parser.add_argument('--spec', help='指纹对应的原始 spec.json，仅校验，不修改')
    args = parser.parse_args()
    try:
        print(json.dumps(render(args.cases, args.out, args.title, args.confirmation, args.spec), ensure_ascii=False))
    except (ValueError, TypeError, KeyError, OSError) as error:
        parser.exit(1, f'生成失败：{error}\n')


if __name__ == '__main__':
    main()
