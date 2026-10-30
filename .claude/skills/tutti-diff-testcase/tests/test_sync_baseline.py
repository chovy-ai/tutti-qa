"""Module baseline safety: local Git, fake platform receipts, no production writes."""
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import case_tool
import collect_changes
import apply_case_confirm
import render_case_titles
from test_case_tool import CASE

REPO = 'tutti-lab/tutti'
SHA = 'a' * 40


def baseline(sha=SHA):
    return {'repos': {REPO: {'sha': sha, 'branch': 'main'}}, 'batch': 'old', 'note': ''}


class SyncBaselineTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.mod = {'id': 'mod-a', 'name': '站点', 'description': '保留说明', 'revision': 10, 'syncBaseline': baseline()}
        self.spec = {'brand_id': '233749', 'baseline': {REPO: 'b' * 40}, 'baseline_modules': ['mod-a'],
                     'baseline_note': '完整分析', 'confirmed_from': {'batch': 'batch-1'}}
        self.spec_path = self.root / 'spec.confirmed.json'
        self.ver_path = self.root / 'verify.json'
        self.args = SimpleNamespace(action='set', spec=str(self.spec_path), verified=str(self.ver_path),
                                    brand='233749', cache=str(self.root), yes=False)
        self.save_inputs()

    def save_inputs(self):
        self.spec_path.write_text(json.dumps(self.spec), encoding='utf-8')
        self.ver = {'ok': True, 'brand_id': '233749', 'spec_hash': case_tool.file_hash(str(self.spec_path)),
                    'modules': {'mod-a': self.mod}, 'written_modules': ['mod-a']}
        self.ver_path.write_text(json.dumps(self.ver), encoding='utf-8')

    def run_set(self, current=None, reply=None):
        current = copy.deepcopy(current or self.mod)
        def ops(*args, **kw):
            if kw.get('mode') == 'yes':
                current['syncBaseline'] = copy.deepcopy(kw['data']['syncBaseline'])
                current['revision'] += 1
                if reply:
                    return reply
            return 0, {'ok': True}
        with patch.object(case_tool, 'get_module', side_effect=lambda *_: copy.deepcopy(current)), \
             patch.object(case_tool, 'ops', side_effect=ops) as calls, \
             patch.object(collect_changes, 'ensure_clone', return_value=str(self.root)), \
             patch.object(collect_changes, 'oldest_baseline', return_value=SHA):
            case_tool.cmd_baseline(self.args)
        return calls, current

    def test_set_defaults_to_preflight_and_preserves_full_metadata(self):
        calls, current = self.run_set()
        self.assertEqual(current['syncBaseline'], self.mod['syncBaseline'])
        self.assertEqual([c.kwargs['mode'] for c in calls.call_args_list], ['dry'])
        data = calls.call_args.kwargs['data']
        self.assertEqual((data['revision'], data['name'], data['description']), (10, '站点', '保留说明'))
        self.assertEqual(data['syncBaseline']['repos'][REPO]['sha'], 'b' * 40)

    def test_set_writes_only_verified_modules_and_reads_back(self):
        self.args.yes = True
        calls, current = self.run_set()
        self.assertEqual([c.kwargs['mode'] for c in calls.call_args_list], ['dry', 'yes'])
        self.assertEqual(current['revision'], 11)
        log = json.loads((self.root / 'baseline-log.json').read_text())
        self.assertEqual(log['steps'][0]['status'], 'verified')
        # A response lost after commit is reconciled by current content, without another PUT.
        calls, _ = self.run_set(current)
        self.assertEqual(calls.call_count, 0)

    def test_set_rejects_concurrent_change(self):
        with self.assertRaisesRegex(SystemExit, 'verify 后已变化'):
            self.run_set({**self.mod, 'revision': 11})

    def test_set_rejects_missing_write_evidence_brand_and_hash_mismatch(self):
        for change in [{'written_modules': []}, {'brand_id': 'another'}, {'spec_hash': 'stale'}, {'ok': False}]:
            self.ver_path.write_text(json.dumps({**self.ver, **change}), encoding='utf-8')
            with self.subTest(change=change), self.assertRaises(SystemExit), patch.object(case_tool, 'ops') as ops:
                self.run_set()
            ops.assert_not_called()

    def test_unknown_write_stops_and_keeps_receipt(self):
        self.args.yes = True
        with self.assertRaisesRegex(SystemExit, '先回读'):
            self.run_set(reply=(6, {'ok': False, 'error': {'code': 'OUTCOME_UNKNOWN'}}))
        self.assertEqual(json.loads((self.root / 'baseline-log.json').read_text())['steps'][0]['status'], 'unknown')

    def test_get_never_falls_back_to_local_commits(self):
        args = SimpleNamespace(action='get', modules=['mod-a'], brand='233749', out=None)
        with patch.object(case_tool, 'get_module', return_value={'id': 'mod-a'}), self.assertRaisesRegex(SystemExit, '缺少 syncBaseline'):
            case_tool.cmd_baseline(args)

    def test_incomplete_module_list_is_rejected(self):
        with patch.object(case_tool, 'ops_read', return_value={'meta': {'complete': False}, 'data': {'items': [self.mod]}}), self.assertRaisesRegex(SystemExit, '列表不完整'):
            case_tool.list_modules('233749')

    def test_missing_repository_in_any_module_is_rejected(self):
        data = {'modules': {'mod-a': self.mod, 'mod-b': {**self.mod, 'syncBaseline': baseline()}}}
        data['modules']['mod-b']['syncBaseline']['repos']['tutti-lab/tsh-web'] = {'sha': SHA}
        with self.assertRaisesRegex(SystemExit, '不完整'):
            collect_changes.module_baselines(data)

    def test_confirmation_excludes_entire_partially_deferred_module(self):
        snap = self.root / 'snapshot'
        snap.mkdir()
        (snap / 'mod-a.json').write_text(json.dumps({'cases': [CASE]}))
        spec = {**self.spec, 'scope': {'add': ['mod-a']}, 'create': [
            {k: v for k, v in {**CASE, 'id': 'new-one'}.items() if k in case_tool.AUTHORED}],
            'archive': [{'id': CASE['id'], 'reason': '下线'}]}
        original = self.root / 'spec.json'
        original.write_text(json.dumps(spec))
        page = self.root / 'cases.html'
        render_case_titles.render(original, str(snap), page)
        meta = json.loads(re.search(r'const META=(\{.*?\});', page.read_text()).group(1))
        conf = self.root / 'confirm.txt'
        conf.write_text('TUTTI-QA-CASES ' + json.dumps({**meta, 'decisions': [{'key': 'C0', 'keep': True}, {'key': 'R0', 'keep': False}]}))
        with patch.object(sys, 'argv', ['confirm', str(original), '--snapshot', str(snap), '--text-file', str(conf)]):
            apply_case_confirm.main()
        result = json.loads(self.spec_path.read_text())
        self.assertEqual(result['baseline_modules'], [])
        self.assertNotIn('baseline', result)

    def test_init_refuses_existing_different_baseline(self):
        path = self.root / 'commits.json'
        path.write_text(json.dumps({'repos': baseline()['repos']}))
        args = SimpleNamespace(action='init', brand='233749', file=str(path), out=str(self.root / 'init.json'), yes=False)
        with patch.object(case_tool, 'list_modules', return_value={'mod-a': self.mod}), patch.object(case_tool, 'get_module', return_value=self.mod), patch.object(case_tool, 'ops') as ops, self.assertRaisesRegex(SystemExit, '不覆盖'):
            case_tool.cmd_baseline(args)
        ops.assert_not_called()


class GitBaselineTest(unittest.TestCase):
    def test_oldest_uses_first_parent_ancestry_and_rejects_forks_and_regression(self):
        with tempfile.TemporaryDirectory() as directory:
            def git(*args, date=None):
                env = dict(os.environ, GIT_AUTHOR_NAME='QA', GIT_AUTHOR_EMAIL='qa@example.test',
                           GIT_COMMITTER_NAME='QA', GIT_COMMITTER_EMAIL='qa@example.test')
                if date:
                    env.update(GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date)
                return subprocess.check_output(['git', '-C', directory, *args], text=True, env=env).strip()
            git('init', '-q')
            git('commit', '--allow-empty', '-qm', 'older ancestor', date='2026-10-29T00:00:00Z')
            first = git('rev-parse', 'HEAD')
            git('commit', '--allow-empty', '-qm', 'newer commit with older timestamp', date='2026-10-28T00:00:00Z')
            second = git('rev-parse', 'HEAD')
            self.assertEqual(collect_changes.oldest_baseline(directory, [second, first], second), first)
            with self.assertRaises(SystemExit):
                collect_changes.oldest_baseline(directory, [second], first)
            git('checkout', '-qb', 'fork', first)
            git('commit', '--allow-empty', '-qm', 'fork')
            with self.assertRaises(SystemExit):
                collect_changes.oldest_baseline(directory, [git('rev-parse', 'HEAD')], second)


if __name__ == '__main__':
    unittest.main()
