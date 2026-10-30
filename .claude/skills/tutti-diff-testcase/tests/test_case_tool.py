"""Run with python3 -m unittest discover -s <skill>/tests. No network: covers validate → 确认页 → 确认解析。"""
import copy
import importlib.util
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import case_tool  # noqa: E402
import render_case_titles  # noqa: E402
import render_cases  # noqa: E402

CASE = {'id': 'old-1', 'moduleId': 'mod-a', 'title': '打开站点', 'category': '房间 · 站点', 'group': '站点 / 入口',
        'scene': '正常场景', 'priority': 'P0', 'kind': '功能回归', 'precondition': '已进入房间',
        'steps': ['点击站点'], 'expectations': ['1) 页面 ｜ 打开站点页'], 'note': '', 'references': [],
        'revision': 7, 'archived': False}


class CaseToolTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.snap = self.root / 'snapshot'
        self.snap.mkdir()
        cases = [CASE, {**CASE, 'id': 'old-2', 'title': '关闭站点', 'revision': 9}]
        (self.snap / 'mod-a.json').write_text(json.dumps({'cases': cases}, ensure_ascii=False), encoding='utf-8')
        (self.snap / 'modules.json').write_text(json.dumps([{'id': 'mod-a', 'name': '房间 · 站点'}]), encoding='utf-8')
        new = {k: v for k, v in CASE.items() if k not in ('revision', 'archived')}
        self.spec = {
            'scope': {'add': ['mod-a/站点'], 'delete': ['mod-a']},
            'create': [{**new, 'id': 'tq-1', 'title': '新标签页', 'priority': 'P1'}],
            'update': [{'id': 'old-1', 'reason': 'tutti#1 变更点',
                        'case': {**new, 'expectations': ['1) 页面 ｜ 打开站点页', '2) 按钮 ｜ 显示加号']}}],
            'archive': [{'id': 'old-2', 'reason': '功能下线'}],
        }

    def errors(self, spec):
        return case_tool.validate(spec, case_tool.load_snapshot(str(self.snap)))[0]

    def test_valid_spec(self):
        self.assertEqual(self.errors(self.spec), [])

    def test_rejects_out_of_scope_and_bad_format(self):
        spec = copy.deepcopy(self.spec)
        spec['scope'] = {'add': ['mod-a/其他'], 'delete': []}
        spec['create'][0]['expectations'] = ['打开']
        spec['create'][0]['title'] = '🔴【P0】新标签页'
        spec['update'][0]['case']['moduleId'] = 'mod-b'
        errs = '\n'.join(self.errors(spec))
        for word in ('scope.add', 'A 记法', '优先级前缀', 'moduleId', 'scope.delete'):
            self.assertIn(word, errs)

    def test_rejects_duplicate_title_and_existing_id(self):
        spec = copy.deepcopy(self.spec)
        spec['create'].append({**spec['create'][0], 'id': 'old-2'})
        spec['create'].append({**spec['create'][0], 'id': 'tq-2', 'title': '打开站点'})
        errs = '\n'.join(self.errors(spec))
        self.assertIn('已存在', errs)
        self.assertIn('同名', errs)

    def test_requests_use_snapshot_revision(self):
        reqs = case_tool.requests(self.spec, case_tool.load_snapshot(str(self.snap)), '1')
        self.assertEqual([r[1][2] for r in reqs], ['import', 'update', 'update'])
        self.assertEqual(reqs[1][2]['revision'], 7)
        self.assertEqual((reqs[2][2]['archived'], reqs[2][2]['revision']), (True, 9))

    def test_confirmation_roundtrip(self):
        spec_path = self.root / 'spec.json'
        spec_path.write_text(json.dumps(self.spec, ensure_ascii=False), encoding='utf-8')
        page = self.root / 'cases.html'
        self.assertEqual(render_case_titles.render(spec_path, str(self.snap), page), 3)
        meta = json.loads(re.search(r'const META=(\{.*?\});', page.read_text(encoding='utf-8')).group(1))
        detail = render_cases.build(str(self.snap), str(spec_path), 'b')
        self.assertEqual(detail['hash'], meta['hash'])
        decisions = [{'key': 'C0', 'keep': True, 'prio': 'P2'}, {'key': 'U0', 'keep': True}, {'key': 'R0', 'keep': False}]
        confirm = self.root / 'confirm.txt'
        confirm.write_text('TUTTI-QA-CASES ' + json.dumps({**meta, 'decisions': decisions}), encoding='utf-8')
        sys.argv = ['apply_case_confirm.py', str(spec_path), '--text-file', str(confirm)]
        spec = importlib.util.spec_from_file_location('apply_case_confirm', SCRIPTS / 'apply_case_confirm.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        mod.main()
        out = json.loads((self.root / 'spec.confirmed.json').read_text(encoding='utf-8'))
        self.assertEqual(out['create'][0]['priority'], 'P2')
        self.assertEqual(out['archive'], [])
        self.assertEqual(out['confirmed_from']['spec_hash'], meta['hash'])


if __name__ == '__main__':
    unittest.main()
