#!/usr/bin/env python3
"""Run against Go's disposable QA_TEST_PREVIEW fixture, never a production origin.

python3 integration_sync_baseline.py --cli /absolute/tutti-ops-cli/dist/index.js --port 18097 --out /tmp/baseline-check
Start server with QA_TEST_PREVIEW=1 QA_FIXTURE_CASES=1 QA_PREVIEW_ADDR=127.0.0.1:18097
go test ./internal/server -run '^TestTestManagementBrowserPreview$' -v -count=1
"""
import argparse
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import threading
import urllib.request

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--cli', required=True, type=Path)
    ap.add_argument('--port', required=True, type=int)
    ap.add_argument('--out', required=True, type=Path)
    a = ap.parse_args()
    out = a.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    checks = []
    with tempfile.TemporaryDirectory(prefix='baseline-integration-') as temporary:
        tmp = Path(temporary)
        class Proxy(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def forward(self):
                conn = http.client.HTTPConnection('127.0.0.1', a.port, timeout=10)
                body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
                conn.request(self.command, self.path.removeprefix('/api/admin'), body,
                             {k: v for k, v in self.headers.items() if k.lower() != 'host'})
                response = conn.getresponse()
                data = response.read()
                self.send_response(response.status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                conn.close()
            do_GET = do_POST = do_PUT = forward
        proxy = ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
        thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        thread.start()
        try:
            # Refuse an unrelated local service before sending any fixture key or write.
            req = urllib.request.Request(f'http://127.0.0.1:{a.port}/api/v1/test-management/modules?brandId=233749',
                                         headers={'Authorization': 'Bearer qa-preview-write'})
            fixture_modules = json.load(urllib.request.urlopen(req))
            if fixture_modules['total'] != 0:
                raise RuntimeError('Expected a fresh disposable fixture with zero managed modules')
            shim = tmp / 'tutti-ops'
            shim.write_text('#!/bin/sh\nexec node ' + shlex.quote(str(a.cli.resolve())) + ' "$@"\n')
            shim.chmod(0o700)
            env = dict(os.environ, TUTTI_OPS_BIN=str(shim), TUTTI_ADMIN_URL=f'http://127.0.0.1:{proxy.server_port}',
                       TUTTI_ADMIN_TOKEN='qa-preview-write', TUTTI_ADMIN_COOKIE='')
            def run(cmd, expected=0, overrides=None):
                r = subprocess.run(cmd, env={**env, **(overrides or {})}, text=True, capture_output=True)
                if r.returncode != expected:
                    raise RuntimeError(f'{cmd}: exit {r.returncode}, expected {expected}\n{r.stdout}\n{r.stderr}')
                return r.stdout if not expected else r.stderr
            def cli(*args, data=None, expected=0, overrides=None):
                cmd = [str(shim), '--json', 'test-management', *args, '--brand-id', '233749']
                if data is not None:
                    cmd += ['--data', json.dumps(data, ensure_ascii=False)]
                return json.loads(run(cmd, expected, overrides))
            def tool(*args):
                return run(['python3', str(SCRIPTS / 'case_tool.py'), *map(str, args)])
            def write(path, data):
                path.write_text(json.dumps(data, ensure_ascii=False))
            cache = tmp / 'cache'
            repo = cache / 'tutti'
            repo.mkdir(parents=True)
            git_env = {'GIT_AUTHOR_NAME': 'QA', 'GIT_AUTHOR_EMAIL': 'qa@example.test',
                       'GIT_COMMITTER_NAME': 'QA', 'GIT_COMMITTER_EMAIL': 'qa@example.test'}
            def git(*args):
                return run(['git', '-C', str(repo), *args], overrides=git_env).strip()
            git('init', '-q', '-b', 'main')
            git('commit', '--allow-empty', '-qm', 'base')
            base = git('rev-parse', 'HEAD')
            git('commit', '--allow-empty', '-qm', 'head')
            head = git('rev-parse', 'HEAD')
            git('remote', 'add', 'origin', str(repo))
            git('fetch', '-q', 'origin', 'main')
            initial = tmp / 'commits.json'
            write(initial, {'repos': {'tutti-lab/tutti': {'sha': base, 'branch': 'main'}}})
            for mid in ['integration-a', 'integration-b']:
                cli('modules', 'create', '--yes', data={'id': mid, 'name': mid, 'description': '保留说明'})
            tool('baseline', 'init', '--file', initial, '--out', out / 'init.json')
            assert 'syncBaseline' not in cli('modules', 'get', '--id', 'integration-a')['data']
            tool('baseline', 'init', '--file', initial, '--out', out / 'init.json', '--yes')
            tool('baseline', 'get', '--out', out / 'baselines.json')
            mods = json.loads((out / 'baselines.json').read_text())['modules']
            assert all(m['syncBaseline']['repos']['tutti-lab/tutti']['sha'] == base for m in mods.values())
            checks.append('初始化默认不写；真实初始化两个模块并全量回读成功')
            untouched = mods['integration-b']
            case = {'id': 'integration-case', 'moduleId': 'integration-a', 'title': '打开站点', 'category': 'integration-a',
                    'group': '站点 / 入口', 'scene': '正常场景', 'priority': 'P1', 'kind': '功能回归',
                    'precondition': '隔离测试', 'steps': ['点击站点'], 'expectations': ['1) 页面 ｜ 站点页可见'],
                    'note': '', 'references': []}
            spec = {'brand_id': '233749', 'scope': {'add': ['integration-a']}, 'create': [case],
                    'baseline': {'tutti-lab/tutti': head}, 'baseline_modules': ['integration-a'], 'baseline_note': '本地联调'}
            tool('pull', 'integration-a', 'integration-b', '--out', out / 'snapshot')
            write(out / 'spec.json', spec)
            run(['python3', str(SCRIPTS / 'render_case_titles.py'), str(out / 'spec.json'), '--snapshot', str(out / 'snapshot'), '-o', str(out / 'cases.html')])
            meta = json.loads(re.search(r'const META=(\{.*?\});', (out / 'cases.html').read_text()).group(1))
            # Synthetic QA response is test input inside this isolated fixture only.
            (out / 'confirm.txt').write_text('TUTTI-QA-CASES ' + json.dumps({**meta, 'decisions': [{'key': 'C0', 'keep': True}]}))
            run(['python3', str(SCRIPTS / 'apply_case_confirm.py'), str(out / 'spec.json'), '--snapshot', str(out / 'snapshot'), '--text-file', str(out / 'confirm.txt')])
            confirmed = out / 'spec.confirmed.json'
            tool('apply', confirmed, '--snapshot', out / 'snapshot')
            tool('apply', confirmed, '--snapshot', out / 'snapshot', '--yes')
            tool('verify', confirmed, '--snapshot', out / 'snapshot', '--out', out / 'after')
            tool('baseline', 'set', confirmed, '--verified', out / 'verify.json', '--cache', cache)
            assert cli('modules', 'get', '--id', 'integration-a')['data']['syncBaseline']['repos']['tutti-lab/tutti']['sha'] == base
            tool('baseline', 'set', confirmed, '--verified', out / 'verify.json', '--cache', cache, '--yes')
            changed = cli('modules', 'get', '--id', 'integration-a')['data']
            assert changed['syncBaseline']['repos']['tutti-lab/tutti']['sha'] == head
            assert cli('modules', 'get', '--id', 'integration-b')['data'] == untouched
            checks.append('确认页解析 → dry-run → 用例真实写入 → 回读 → 仅已处理模块前移；延期模块不变')
            tool('baseline', 'set', confirmed, '--verified', out / 'verify.json', '--cache', cache, '--yes')
            assert cli('modules', 'get', '--id', 'integration-a')['data']['revision'] == changed['revision']
            checks.append('相同目标续跑跳过已完成模块，不重复 PUT')
            rename = {'id': changed['id'], 'name': '改名', 'description': changed['description'], 'revision': changed['revision']}
            renamed = cli('modules', 'update', '--id', changed['id'], '--yes', data=rename)['data']
            assert renamed['syncBaseline'] == changed['syncBaseline']
            assert cli('modules', 'update', '--id', changed['id'], '--yes', data=rename, expected=7)['error']['code'] == 'CONFLICT'
            assert cli('modules', 'update', '--id', changed['id'], '--yes', data={**rename, 'revision': renamed['revision']}, expected=4,
                       overrides={'TUTTI_ADMIN_TOKEN': 'qa-preview-read'})['error']['code'] == 'FORBIDDEN'
            checks.append('旧客户端改名保留基准；过期 revision 返回冲突；只读密钥写入被后端拒绝')
        finally:
            proxy.shutdown()
            proxy.server_close()
    report = {'ok': True, 'environment': 'temporary SQLite + in-memory objects, loopback only', 'checks': checks}
    (out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
