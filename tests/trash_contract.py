#!/usr/bin/env python3
"""Reversible history deletion against a temporary DB and loopback model fixture.

No production records or model endpoints are accessed.
"""
import concurrent.futures
import copy
import http.server
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
checks=[]
requests=[]
preflight_requests=[]
release=threading.Event()
started=threading.Event()

def check(value,label):
    assert value,label
    checks.append(label)

class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        probe=body['messages'][0]['content'].startswith('Write a plain, factual paragraph')
        (preflight_requests if probe else requests).append(body)
        if not probe: started.set();release.wait(12)
        try:
            self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
            v={'choices':[{'delta':{'content':'answer'},'finish_reason':'stop'}],'usage':{'prompt_tokens':4,'completion_tokens':1}}
            self.wfile.write(('data: '+json.dumps(v)+'\n\ndata: [DONE]\n\n').encode())
        except (BrokenPipeError,ConnectionResetError):pass

def main():
    fixture=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture)
    threading.Thread(target=fixture.serve_forever,daemon=True).start()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    base=f'http://127.0.0.1:{port}/api/'
    def raw(path,body=None):
        req=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req,timeout=20) as r:return r.status,json.load(r)
        except urllib.error.HTTPError as e:return e.code,json.load(e)
    def api(path,body=None):
        code,value=raw(path,body);assert code==200,(path,code,value);return value
    def start_run(body):
        probe=api('preflight',body)
        check(probe['status'] in ('ready','limited'),'streaming preflight completes before new run')
        return api('runs',{**body,'preflight_token':probe['preflight_token'],'allow_limited_metrics':True})
    def wait(predicate,timeout=15):
        until=time.monotonic()+timeout
        while time.monotonic()<until:
            v=predicate()
            if v:return v
            time.sleep(.05)
        raise AssertionError('wait condition timed out')
    with tempfile.TemporaryDirectory(prefix='llm-bench-trash-contract-') as data:
        env=dict(os.environ,BENCH_DATA_DIR=data,BENCH_PORT=str(port))
        log=open(Path(data)/'server.log','w')
        def boot():
            p=subprocess.Popen([str(ROOT/'target/debug/llm-bench')],cwd=ROOT,env=env,stdout=log,stderr=log)
            def ready():
                try:return api('health')['ok']
                except (OSError,AssertionError):return False
            wait(ready);return p
        p=boot()
        try:
            config={'name':'Preserved history','base_url':f'http://127.0.0.1:{fixture.server_port}/v1','model':'fixture-only','pack_id':'trash-fixture','profile':'full','temperature':0,'max_tokens':32,'concurrency':1,'timeout_s':20}
            task={'id':'saved','subject':'fixture','prompt':'original question','answer':'answer','scorer':'exact','max_tokens':32,'meta':{'reference':'preserved'}}
            score={'value':1,'state':'scored','detail':'original grade','scorer_version':'fixture','extra':{'grading_history':[{'score':{'value':None,'state':'unavailable','detail':'original failure'}}]}}
            attempt={'started_at':'2026-11-06T00:00:00Z','ended_at':'2026-11-06T00:00:01Z','output':'answer','reasoning':'original reasoning','finish_reason':'stop','error':None,
                     'metrics':{'ttft_ms':12,'wall_ms':50,'input_tokens':4,'output_tokens':1,'decode_tps':20,'prefill_tps':80,'decode_source':'fixture','prefill_source':'fixture'},'score':score,'raw':[{'original':'raw response'}]}
            original={'id':'incoming','created_at':'2026-11-06T00:00:00Z','config':config,'status':'completed','suite_hash':'fixture','protocol_version':'fixture','pack_version':'fixture','provenance':'fixture',
                      'items':[{'task':task,'status':'done','attempts':[attempt]}],'telemetry':[{'original':'hardware sample'}],'active_ms':50,'error':None}
            rid=api('import',original)['id'];before=api('export/'+rid)
            other=copy.deepcopy(original);other['config']['name']='Unaffected record';other_id=api('import',other)['id'];other_before=api('export/'+other_id)
            check(api('trash')==[],'trash initially empty')
            with sqlite3.connect(Path(data)/'app.sqlite3') as db:
                db.execute("CREATE TRIGGER fixture_block_trash BEFORE INSERT ON run_trash BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END")
            check(raw(f'runs/{rid}/delete',{})[0]==400 and api('export/'+rid)==before and api('trash')==[],'failed deletion transaction leaves live record and original data intact')
            with sqlite3.connect(Path(data)/'app.sqlite3') as db:db.execute('DROP TRIGGER fixture_block_trash')
            response=api(f'runs/{rid}/delete',{})
            check(response['ok'] and response['id']==rid and response['deleted_at'],'delete returns stable run ID and timestamp')
            check(all(r['id']!=rid for r in api('runs')),'deleted record is absent from normal history')
            trash=api('trash');entry=next(r for r in trash if r['id']==rid)
            check(entry['name']==config['name'] and entry['summary']==before['summary'] and entry['busy'] is False,'trash exposes compact metadata and original result summary')
            check('items' not in entry and 'original question' not in json.dumps(entry),'trash list omits question/answer payloads')
            check(raw('runs/'+rid)[0]==400 and raw('export/'+rid)[0]==400 and raw('runs/'+rid+'/items/0')[0]==400,'deleted record cannot be fetched or exported through live routes')
            check(raw('runs/'+rid+'/rescore',{})[0]==400 and not requests,'deleted record cannot resume scoring or invoke model')
            again=api(f'runs/{rid}/delete',{})
            check(again['deleted_at']==response['deleted_at'] and len(api('trash'))==1,'repeated delete is idempotent')
            with sqlite3.connect(Path(data)/'app.sqlite3') as db:
                preserved=json.loads(db.execute('SELECT body FROM run_items WHERE run_id=?',(rid,)).fetchone()[0])
                check(preserved['task']==task and preserved['attempts'][0]['score']==score and preserved['attempts'][0]['output']=='answer','SQLite keeps original questions/answers/scores/history under deletion marker')
                legacy=copy.deepcopy(before);legacy['id']='legacy-monolithic';legacy['config']['name']='Legacy header';legacy.pop('summary',None)
                db.execute('INSERT INTO runs(id,body) VALUES(?,?)',(legacy['id'],json.dumps(legacy)));db.commit()
            p.terminate();p.wait(5);p=boot()
            check(all(r['id']!=rid for r in api('runs')) and next(r for r in api('trash') if r['id']==rid)['deleted_at']==response['deleted_at'],'restart retains deletion marker and hidden history')
            with sqlite3.connect(Path(data)/'app.sqlite3') as db:
                db.execute("CREATE TRIGGER fixture_block_restore BEFORE DELETE ON run_trash BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END")
            check(raw('trash/'+rid+'/restore',{})[0]==400 and any(r['id']==rid for r in api('trash')) and all(r['id']!=rid for r in api('runs')),'failed restore transaction retains recoverable trash marker')
            with sqlite3.connect(Path(data)/'app.sqlite3') as db:db.execute('DROP TRIGGER fixture_block_restore')
            api('trash/'+rid+'/restore',{})
            check(api('export/'+rid)==before,'restore preserves exact status/config/questions/outputs/scores/telemetry/raw data')
            check(api('trash')==[] and api('export/'+other_id)==other_before,'restore removes marker and unrelated record remains unchanged')
            api('trash/'+rid+'/restore',{})
            check(sum(r['id']==rid for r in api('runs'))==1,'repeated restore does not duplicate record')
            legacy_before=api('export/legacy-monolithic');api('runs/legacy-monolithic/delete',{});api('trash/legacy-monolithic/restore',{})
            check(api('export/legacy-monolithic')==legacy_before,'legacy inline-item records survive delete and restore')
            p.terminate();p.wait(5);p=boot()
            check(api('export/'+rid)==before,'restored history survives another restart')
            pack={'id':'trash-fixture','name':'Fixture','version':'1','sources':{},'tasks':[task,{**task,'id':'second'}]};api('packs',pack)
            started.clear();release.clear();live=start_run({'config':config})['id'];check(started.wait(5),'loopback fixture has an active generation')
            live_entry=next(r for r in api('runs') if r['id']==live)
            code,denied=raw(f'runs/{live}/delete',{})
            check(live_entry['busy'] and code==409 and denied['code']=='run_active','active generation deletion is rejected with busy flag')
            api(f'runs/{live}/pause',{})
            check(raw(f'runs/{live}/delete',{})[0]==409,'pausing run remains protected while in-flight work drains')
            release.set();wait(lambda:api('runs/'+live)['status']=='paused')
            wait(lambda:not next(r for r in api('runs') if r['id']==live)['busy'])
            paused=api('export/'+live);api(f'runs/{live}/delete',{});api(f'trash/{live}/restore',{})
            check(api('export/'+live)==paused and paused['items'][1]['status']=='pending','paused run with pending questions can be deleted and restored unchanged')
            started.clear();release.clear();barrier=threading.Barrier(2)
            def race(action):barrier.wait();return raw(f'runs/{live}/{action}',{})
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                a=pool.submit(race,'resume');b=pool.submit(race,'delete');resumed,deleted=a.result(),b.result()
            check((resumed[0]==200 and deleted[0]==409) or (resumed[0]==400 and deleted[0]==200),'resume/delete race admits exactly one state transition')
            if deleted[0]==200:
                check(all(r['id']!=live for r in api('runs')),'delete winner stays hidden without worker resurrection')
                api(f'trash/{live}/restore',{})
            else:
                api(f'runs/{live}/cancel',{});wait(lambda:api('runs/'+live)['status']=='cancelled')
                wait(lambda:not next(r for r in api('runs') if r['id']==live)['busy'])
                check(api(f'runs/{live}/delete',{})['ok'],'cancelled run becomes deletable after worker cleanup')
                api(f'trash/{live}/restore',{})
            release.set()
        finally:
            release.set();p.terminate();p.wait(5);log.close();fixture.shutdown()
    result={'passed':len(checks),'checks':checks,'scope':'temporary SQLite and loopback HTTP fixture only; production records untouched'}
    dest=Path(os.environ.get('BENCH_TEST_REPORT','/tmp/llm-bench-trash-contract.json'));dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
