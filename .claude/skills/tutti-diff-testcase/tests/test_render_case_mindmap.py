"""Run with python3 -m unittest discover -s <skill>/tests."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest

SKILL = Path(__file__).resolve().parents[1]
MODULE = importlib.util.spec_from_file_location('render_case_mindmap', SKILL / 'scripts/render_case_mindmap.py')
renderer = importlib.util.module_from_spec(MODULE)
MODULE.loader.exec_module(renderer)


class MindmapRendererTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        case = {'id': 'case-1', 'title': '标题 __SCRIPT__ </script> & 内容',
                'category': '邀请', 'group': '房间 / 邀请', 'scene': '正常场景',
                'priority': 'P0', 'steps': ['打开邀请'], 'expect': ['显示邀请页']}
        self.cases = [case, {**case, 'id': 'case-2', 'scene': '边界场景'},
                      {**case, 'id': 'case-3', 'category': '权限', 'group': '房间 / 权限'}]
        self.input = self.root / 'cases.json'
        self.input.write_text(json.dumps({'cases': self.cases}), encoding='utf-8')
        self.spec = self.root / 'spec.json'
        self.spec.write_text(json.dumps({
            'update': [{'id': 'title'}, {'id': 'pre'}], 'archive': [{'id': 'old-case'}],
            'create': [{'id': 'new-case'}, {'id': 'other-case'}],
        }), encoding='utf-8')
        self.meta = {
            'batch': 'sample', 'hash': hashlib.sha256(self.spec.read_bytes()).hexdigest()[:16],
            'cases': [{'id': 'case-1', 'keys': ['U0', 'U1']},
                      {'id': 'case-2', 'keys': ['C0']}, {'id': 'case-3', 'keys': ['R0']}],
            'extraKeys': {'C1': ['case-1', 'case-2']},
            'allKeys': ['U0', 'U1', 'C0', 'R0', 'C1'],
        }
        self.mapping = self.root / 'confirmation.json'
        self.mapping.write_text(json.dumps(self.meta), encoding='utf-8')

    def render(self, confirmation=False):
        out = self.root / 'map.html'
        renderer.render(self.input, out, '自定义 <模块>',
                        self.mapping if confirmation else None, self.spec if confirmation else None)
        page = out.read_text(encoding='utf-8')
        data = json.loads(re.search(r'<script id="suite-data" type="application/json">(.*?)</script>', page, re.S)[1])
        return page, data

    def test_standalone_page_escapes_input_and_derives_categories(self):
        page, data = self.render()
        self.assertEqual(len(data['cases']), 3)
        self.assertEqual([c[1] for c in data['categories']], ['邀请', '权限'])
        self.assertEqual(data['cases'][0]['title'], self.cases[0]['title'])
        self.assertIn('自定义 &lt;模块&gt;', page)
        self.assertIsNone(data['confirmation'])
        self.assertNotIn('标题 __SCRIPT__ </script>', page)

    def test_confirmation_render_preserves_complete_mapping_and_inputs(self):
        before = {p: p.read_bytes() for p in (self.input, self.spec, self.mapping)}
        _, data = self.render(confirmation=True)
        self.assertEqual(data['confirmation'], self.meta)
        self.assertEqual(before, {p: p.read_bytes() for p in before})

    def test_incomplete_or_stale_confirmation_is_rejected(self):
        cases, _ = renderer.normalize_cases(self.cases)
        for change in ('hash', 'missing-case', 'missing-key', 'unmapped-key', 'unknown-owner', 'duplicate-key'):
            with self.subTest(change=change):
                meta = copy.deepcopy(self.meta)
                if change == 'hash':
                    meta['hash'] = '0' * 16
                elif change == 'missing-case':
                    meta['cases'].pop()
                elif change == 'missing-key':
                    meta['allKeys'].pop()
                    meta['extraKeys'].clear()
                elif change == 'unmapped-key':
                    meta['cases'][0]['keys'].pop()
                elif change == 'unknown-owner':
                    meta['extraKeys']['C1'] = ['unknown-case']
                else:
                    meta['cases'][1]['keys'].append('U0')
                with self.assertRaises(ValueError):
                    renderer.validate_confirmation(meta, self.spec, cases)

    def test_invalid_case_does_not_silently_disappear(self):
        for changes in ({'scene': '其他场景'}, {'id': 'root'}, {'steps': '不是数组'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                renderer.normalize_cases([{**self.cases[0], **changes}])
        with self.assertRaises(ValueError):
            renderer.normalize_cases([self.cases[0], self.cases[0]])

    def test_confirmation_arguments_are_paired(self):
        with self.assertRaises(ValueError):
            renderer.render(self.input, self.root / 'map.html', confirmation=self.mapping)


if __name__ == '__main__':
    unittest.main()
