#!/usr/bin/env python3
"""Synthetic large-telemetry migration/latency contracts; never calls a real model.

BENCH_BASELINE_BIN optionally measures the old binary on a separate fresh DB.
BENCH_TELEMETRY_SAMPLES defaults to the observed production scale (27,578).
Only aggregate metrics/check names are emitted, never run content or keys.
"""
import hashlib
import http.server
import json
import os
from pathlib import Path
import socket
import sqlite3
import statistics
import subprocess
import tempfile
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CHECKS = []

def check(ok, label):
    assert ok, label
    CHECKS.append(label)

def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))

def digest(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',', ':')).encode()).hexdigest()

def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]

class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        value = {'timestamp': '2026-11-07T00:00:00Z', 'cpu': {'usage': 12}, 'gpus': []}
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(encoded(value).encode())
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert body['model'] == 'synthetic-loopback-only'
        assert 'messages' in body
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        for n in range(8):
            content = 'The answer is ' if n == 0 else '1' if n == 7 else ''
            event = {'choices': [{'delta': {'content': content}, 'finish_reason': 'stop' if n == 7 else None}]}
            self.wfile.write(('data: ' + encoded(event) + '\n\n').encode()); self.wfile.flush()
            time.sleep(.5)
        self.wfile.write(('data: '+encoded({'choices': [], 'usage': {'prompt_tokens': 10, 'completion_tokens': 8}})+'\n\ndata: [DONE]\n\n').encode()); self.wfile.flush()

def exercise(binary, legacy=False):
    model_server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=model_server.serve_forever, daemon=True).start()
    port = free_port(); base = f'http://127.0.0.1:{port}/api/'
    samples = int(os.environ.get('BENCH_TELEMETRY_SAMPLES', '27578'))
    telemetry = [{'received_at': f'2026-11-07T00:00:{n % 60:02d}Z', 'sequence': n, 'data': {'padding': 'x' * 3000, 'temperature': n % 60}} for n in range(samples)]
    expected_hash = digest(telemetry)
    metrics = {'wall_ms': 1000, 'output_tokens': 8, 'input_tokens': 10, 'decode_source': 'fixture', 'prefill_source': 'fixture'}
    done = {'task': {'id': 'numeric:done', 'subject': 'fixture', 'prompt': 'Return 1', 'answer': '1', 'scorer': 'numeric', 'max_tokens': 64, 'meta': {}},
            'status': 'done', 'attempts': [{'started_at': '2026-11-07T00:00:00Z', 'ended_at': '2026-11-07T00:00:01Z', 'output': '1', 'reasoning': '', 'finish_reason': 'stop', 'error': None, 'metrics': metrics, 'score': {'state': 'scored', 'value': 1, 'detail': 'fixture', 'scorer_version': 'fixture', 'extra': {}}, 'raw': [{'content': 'preserved'}]}]}
    pending = {'task': {**done['task'], 'id': 'numeric:pending'}, 'status': 'pending', 'attempts': []}
    model_url = f'http://127.0.0.1:{model_server.server_port}'
    cfg = {'name': 'telemetry scale fixture', 'model': 'synthetic-loopback-only', 'base_url': model_url+'/v1', 'pack_id': 'fixture', 'profile': 'full', 'temperature': 0, 'max_tokens': 64, 'concurrency': 1, 'timeout_s': 20, 'telemetry_url': model_url+'/metrics'}
    header = {'id': 'large-telemetry', 'created_at': '2026-11-07T00:00:00Z', 'config': cfg, 'status': 'paused', 'suite_hash': 'unchanged-suite', 'protocol_version': 'fixture', 'pack_version': 'fixture', 'provenance': 'fixture', 'items': [], 'telemetry': telemetry, 'active_ms': 1000, 'error': None}
    with tempfile.TemporaryDirectory(prefix='bench-telemetry-contract-') as directory:
        dbfile = Path(directory)/'app.sqlite3'
        with sqlite3.connect(dbfile) as db:
            db.executescript('CREATE TABLE runs(id TEXT PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE packs(id TEXT PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE run_items(run_id TEXT,position INTEGER,body TEXT,PRIMARY KEY(run_id,position));CREATE TABLE run_trash(run_id TEXT PRIMARY KEY,deleted_at TEXT NOT NULL,metadata TEXT NOT NULL);')
            db.execute('INSERT INTO runs VALUES(?,?)',(header['id'], encoded(header)))
            db.executemany('INSERT INTO run_items VALUES(?,?,?)',[(header['id'],0,encoded(done)),(header['id'],1,encoded(pending))])
            trash = {**header, 'id': 'old-trash', 'telemetry': telemetry[:3], 'status': 'completed'}
            db.execute('INSERT INTO runs VALUES(?,?)',('old-trash', encoded(trash)))
            db.execute('INSERT INTO run_items VALUES(?,?,?)',('old-trash',0,encoded(done)))
            db.execute('INSERT INTO run_trash VALUES(?,?,?)',('old-trash','2026-11-07T00:01:00Z', encoded({'id':'old-trash'})))
            original_rows = db.execute('SELECT run_id,position,body FROM run_items ORDER BY run_id,position').fetchall()
            legacy_bytes = db.execute('SELECT length(body) FROM runs WHERE id=?',(header['id'],)).fetchone()[0]
        del header, trash
        def api(path, body=None):
            request = urllib.request.Request(base+path, data=None if body is None else encoded(body).encode(), headers={'Content-Type':'application/json'})
            start = time.perf_counter()
            with urllib.request.urlopen(request, timeout=120) as response: raw = response.read()
            return json.loads(raw), {'ms':round((time.perf_counter()-start)*1000,2),'bytes':len(raw)}
        with open(Path(directory)/'server.log','w') as log:
            env = dict(os.environ, BENCH_DATA_DIR=directory, BENCH_PORT=str(port))
            def boot():
                start=time.perf_counter();p=subprocess.Popen([str(binary)],cwd=ROOT,env=env,stdout=log,stderr=log)
                deadline=time.monotonic()+90
                while time.monotonic()<deadline:
                    if p.poll() is not None: raise AssertionError('Synthetic fixture boot: '+(Path(directory)/'server.log').read_text()[-1000:])
                    try:api('health');return p,round((time.perf_counter()-start)*1000,2)
                    except OSError:time.sleep(.05)
                raise AssertionError('fixture startup timeout')
            p,boot_ms=boot()
            try:
                compact,compact_timing=api('runs/large-telemetry?view=compact')
                saves=[]
                for concurrency in [2,4,8]:
                    _,t=api('runs/large-telemetry/concurrency',{'concurrency':concurrency});saves.append(t['ms'])
                with sqlite3.connect(dbfile) as db:
                    header_bytes=db.execute('SELECT length(body) FROM runs WHERE id=?',('large-telemetry',)).fetchone()[0]
                    current_rows=db.execute('SELECT run_id,position,body FROM run_items ORDER BY run_id,position').fetchall()
                    if not legacy:
                        count=db.execute('SELECT COUNT(*) FROM run_telemetry WHERE run_id=?',('large-telemetry',)).fetchone()[0]
                        check(count==samples,'migration preserves every legacy telemetry sample')
                        check(db.execute('SELECT COUNT(*) FROM run_telemetry WHERE run_id=?',('old-trash',)).fetchone()[0]==3,'migration includes existing trash telemetry')
                        check(header_bytes<10000,'checkpoint header remains small at production telemetry scale')
                        check(current_rows==original_rows,'migration and settings writes preserve original item row bytes')
                        check(len(compact['telemetry'])<=300 and compact['telemetry_count']==samples and compact['telemetry_truncated'] is True,'compact API bounds telemetry while exposing the original sample count')
                        check(compact['telemetry']==telemetry[-300:],'compact API retains exact newest telemetry sequence')
                if not legacy:
                    full,_=api('export/large-telemetry')
                    check(digest(full['telemetry'])==expected_hash,'full export preserves every sample and order after migration')
                    check(full['items'][0]['task']==done['task'] and full['items'][0]['attempts'][0]['raw']==done['attempts'][0]['raw'],'export retains original task and raw output')
                    history,_=api('runs/large-telemetry/telemetry')
                    check(digest(history['telemetry'])==expected_hash and history['telemetry_count']==samples,'report telemetry endpoint returns full history')
                    suffix,_=api(f'runs/large-telemetry/telemetry?after={samples-2}')
                    check(suffix['telemetry']==telemetry[-2:] and suffix['telemetry_count']==samples and suffix['after']==samples-2,'cursor returns exact remaining samples and global count')
                    empty,_=api(f'runs/large-telemetry/telemetry?after={samples}')
                    check(empty['telemetry']==[] and empty['telemetry_count']==samples,'cursor at current count returns empty stable suffix')
                    for invalid in [str(samples+1),'-1','invalid']:
                        try:api('runs/large-telemetry/telemetry?after='+invalid);raise AssertionError('invalid cursor accepted')
                        except urllib.error.HTTPError as error:check(error.code==400,'invalid cursor rejected '+invalid)

                    api('runs/large-telemetry/delete',{})
                    api('trash/large-telemetry/restore',{})
                    restored,_=api('export/large-telemetry')
                    check(restored==full,'trash restore roundtrips migrated full run without data changes')
                    api('trash/old-trash/restore',{})
                    old_trash,_=api('export/old-trash')
                    check(old_trash['telemetry']==telemetry[:3],'preexisting trash restores legacy sample history')
                    p.terminate();p.wait(timeout=15);p,restart_ms=boot()
                    restarted,_=api('export/large-telemetry')
                    check(restarted==full,'restart preserves full run after migration and restore')
                    with sqlite3.connect(dbfile) as db:
                        before_resume_done=db.execute('SELECT body FROM run_items WHERE run_id=? AND position=0',('large-telemetry',)).fetchone()[0]
                        db.execute("CREATE TRIGGER prohibit_telemetry_rewrite BEFORE UPDATE ON run_telemetry BEGIN SELECT RAISE(ABORT,'old samples must remain untouched'); END")
                        db.execute("CREATE TRIGGER prohibit_telemetry_delete BEFORE DELETE ON run_telemetry BEGIN SELECT RAISE(ABORT,'old samples must remain untouched'); END")
                    api('runs/large-telemetry/resume',{'api_key':''})
                    deadline=time.monotonic()+45
                    while time.monotonic()<deadline:
                        live,_=api('runs/large-telemetry?view=compact')
                        if live['status']=='completed':break
                        time.sleep(.1)
                    check(live['status']=='completed' and live['summary']['completed']==2,'synthetic pending request resumes and completes with existing history')
                    after,_=api('runs/large-telemetry/telemetry')
                    check(after['telemetry'][:samples]==telemetry and after['telemetry_count']>samples,'live collection appends new samples without rewriting old rows')
                    with sqlite3.connect(dbfile) as db:
                        current_done=db.execute('SELECT body FROM run_items WHERE run_id=? AND position=0',('large-telemetry',)).fetchone()[0]
                    check(current_done==before_resume_done,'resume never rewrites the already completed answer row')
                return {'binary': 'before' if legacy else 'after','sample_count':samples,'legacy_header_bytes':legacy_bytes,'checkpoint_header_bytes':header_bytes,'boot_ms':boot_ms,'compact':compact_timing,'control_save_ms':saves,'control_save_median_ms':round(statistics.median(saves),2)}
            finally:
                p.terminate();p.wait(timeout=20)
                model_server.shutdown(); model_server.server_close()

def main():
    before=os.environ.get('BENCH_BASELINE_BIN')
    results=[]
    if before:results.append(exercise(Path(before),legacy=True))
    if os.environ.get('BENCH_BASELINE_ONLY')!='1':results.append(exercise(ROOT/'target/debug/llm-bench'))
    result={'scope':'isolated loopback fixture; no real model or production DB writes','measurements':results,'checks':CHECKS,'passed':len(CHECKS)}
    out=Path(os.environ.get('BENCH_CONTRACT_RESULT','/tmp/bench-telemetry-contract-result.json'));out.write_text(json.dumps(result,indent=2))
    print(json.dumps(result,indent=2))
if __name__=='__main__':main()
