#!/usr/bin/env python3
"""Synthetic loopback contracts. No real model calls, benchmark scores or credentials."""
import copy, hashlib, http.server, json, os, socket, sqlite3, subprocess, tempfile, threading, time, urllib.error, urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
CHECKS=[]; CALLS=[]; ACTIVE={}; SEEN={}; GUARD=threading.Lock(); SERIAL={}
def check(ok,label):
    assert ok,label
    CHECKS.append(label)
class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):
        self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps({'timestamp':'2026-11-07T00:00:00Z','cpu':{'usage':10},'gpus':[]} if self.path=='/metrics' else {'data':[{'id':'parallel'}]}).encode())
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        model=body['model'];prompt=body['messages'][0]['content']
        with GUARD:
            CALLS.append(copy.deepcopy(body)); ACTIVE[model]=ACTIVE.get(model,0)+1; active=ACTIVE[model]
            key=(model,prompt);seen=SEEN.get(key,0);SEEN[key]=seen+1
            lock=SERIAL.setdefault(model,threading.Lock())
        try:
            mode=model.split('-')[0]
            delay=.08 if mode!='slow' else .18
            if mode=='cache':delay=.25 if seen else .5
            # Four-way admission is slower than two; eight-way still wins.
            # The active=4 request is a tail, so make the next eight-way group
            # independently observable in CALLS rather than demand a winner.
            if mode=='valley' and active==4:delay=.9
            if mode in ('serial','cache'):lock.acquire()
            time.sleep(delay)
            if mode=='errors' and active>1:
                self.send_response(503);self.end_headers();return
            self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
            def event(v):self.wfile.write(('data: '+json.dumps(v)+'\n\n').encode());self.wfile.flush()
            answer='0' if mode=='regression' and active>1 else '1'
            event({'choices':[{'delta':{'content':'The answer is '},'finish_reason':None}]})
            time.sleep(.13)
            event({'choices':[{'delta':{'content':answer},'finish_reason':'length' if mode=='truncate' and active>1 else 'stop'}]})
            event({'choices':[],'usage':{'prompt_tokens':20,'completion_tokens':100,'prompt_tokens_details':{'cached_tokens':10 if seen else 0}}})
            self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
        except (BrokenPipeError,ConnectionResetError):pass
        finally:
            if mode in ('serial','cache'):lock.release()
            with GUARD:ACTIVE[model]-=1

def generated_samples(samples):
    # V2 drains generation before grading. A resumed sample may legitimately
    # acquire a score; generated text, usage and request evidence must match.
    result=copy.deepcopy(samples)
    for sample in result:
        sample['attempt'].pop('score',None)
        sample['attempt']['metrics'].pop('grading_ms',None)
    return result

def free_port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def main():
    fixture=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture);threading.Thread(target=fixture.serve_forever,daemon=True).start()
    base=f'http://127.0.0.1:{free_port()}';target=f'http://127.0.0.1:{fixture.server_port}/v1'
    def api(path,body=None):
        req=urllib.request.Request(base+'/api/'+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req,timeout=15) as r:return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code==422:raise AssertionError(e.read().decode()) from e
            raise
    def wait(rid,predicate=lambda r:r['status']=='completed',timeout=90):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            r=api('runs/'+rid)
            if predicate(r):return r
            time.sleep(.025)
        raise AssertionError('fixture run did not reach expected state: '+json.dumps(r.get('concurrency_tuning',{})))
    def seed(model,n=12,concurrency=1):
        config=dict(name='Offline auto concurrency fixture',base_url=target,model=model,pack_id='synthetic',profile='full',subjects=[],temperature=0,max_tokens=128,concurrency=concurrency,timeout_s=5,telemetry_url=target.removesuffix('/v1')+'/metrics')
        items=[dict(task=dict(id=f'task:{i}',subject=['math','knowledge'][i%2],prompt=f'Fixture question {i}: return one.',answer='1',scorer='numeric',max_tokens=128,meta={'private_reference':'DO-NOT-SEND'}),status='pending',attempts=[]) for i in range(n)]
        return dict(id='import-fixture',created_at='2026-11-07T00:00:00Z',config=config,status='paused',suite_hash='',protocol_version='test-only',pack_version='1',provenance='synthetic',items=items,telemetry=[],active_ms=0,error=None)
    def imported(model,n=12,concurrency=1):return api('import',seed(model,n,concurrency))['id']
    def enable(rid,max=8,**extra):return api('runs/'+rid+'/auto-concurrency',{'enabled':True,'max_concurrency':max,**extra})
    def resume(rid):api('runs/'+rid+'/resume',{'api_key':''})
    with tempfile.TemporaryDirectory(prefix='bench-auto-concurrency-') as directory:
        with open(Path(directory)/'server.log','w') as log:
            def boot():
                p=subprocess.Popen([str(ROOT/'target/debug/llm-bench')],cwd=ROOT,env=dict(os.environ,BENCH_PORT=base.rsplit(':',1)[1],BENCH_DATA_DIR=directory),stdout=log,stderr=log)
                for _ in range(150):
                    try:
                        if api('health')['ok']:return p
                    except Exception:time.sleep(.03)
                p.terminate();p.wait(timeout=10);raise AssertionError('app failed to boot')
            def rows(rid):
                with sqlite3.connect(Path(directory)/'app.sqlite3') as db:return db.execute('SELECT position,body FROM run_items WHERE run_id=? ORDER BY position',(rid,)).fetchall()
            p=boot()
            try:
                # Old/manual records stay untouched and make no probe requests.
                rid=imported('parallel-manual');before=api('export/'+rid);before_rows=rows(rid)
                check('auto_concurrency' not in before['config'] and 'concurrency_tuning' not in before,'old records omit new optional fields')
                resume(rid);manual=wait(rid)
                check(sum(b['model']=='parallel-manual' for b in CALLS)==12,'manual mode calls exactly the original questions')
                check(manual.get('concurrency_tuning') is None,'manual mode does not auto opt-in')

                for mode,expected in [('parallel',8),('serial',1),('cache',1),('errors',1),('truncate',1),('regression',1)]:
                    rid=imported(mode);before=api('export/'+rid);before_rows=rows(rid)
                    enable(rid)
                    check(rows(rid)==before_rows and api('export/'+rid)['suite_hash']==before['suite_hash'],mode+': opt-in preserves item rows and suite hash')
                    resume(rid);r=wait(rid);t=r['concurrency_tuning']
                    check(t['selected_concurrency']==expected and r['config']['concurrency']==expected,mode+': measured concurrency selection '+str([(q['concurrency'],round(q['elapsed_ms'])) for q in t['rounds']]))
                    check(len(r['items'])==12 and r['summary']['scored']==12 and all(len(i['attempts'])==1 for i in r['items']),mode+': calibration does not duplicate quality results')
                    check(all(set(s['task_id'] for s in q['samples'])==set(t['sample_ids']) for q in t['rounds'] if q['status']=='completed' and q['role']!='warmup'),mode+': every completed comparison round measures the identical sample IDs')
                    check(all(s['attempt']['metrics']['request_concurrency']==q['concurrency'] for q in t['rounds'] for s in q['samples']),mode+': per-request concurrency is durable')
                    compact=api('runs/'+rid+'?view=compact')['concurrency_tuning']
                    check(all(s['attempt']['raw'] is None and s['attempt']['output']=='' for q in compact['rounds'] for s in q['samples']),mode+': compact calibration evidence is redacted')
                    raw=api('export/'+rid)['concurrency_tuning']
                    check(any(s['attempt']['raw'] for q in raw['rounds'] for s in q['samples']),mode+': raw calibration output is retained locally')
                    if mode=='cache':check(sum(q['concurrency']==1 and q['status']=='completed' and q['role']!='warmup' for q in t['rounds'])>=3 and t['selected_concurrency']==1,'cache-only improvement does not select concurrency')
                    if mode=='parallel':
                        check(any(x.get('phase')=='concurrency_tuning' for x in r['telemetry']),'calibration collects device telemetry throughout its phase')
                        if os.environ.get('BENCH_TEST_EVIDENCE_DIR'):
                            dest=Path(os.environ['BENCH_TEST_EVIDENCE_DIR']);dest.mkdir(parents=True,exist_ok=True)
                            (dest/'auto-concurrency-export.json').write_text(json.dumps(api('export/'+rid)))
                            (dest/'auto-concurrency-compact.json').write_text(json.dumps(api('runs/'+rid+'?view=compact')))
                        check(t['version']=='auto-concurrency-v2' and t['rounds'][t['baseline_round_index']]['concurrency']==1 and t['rounds'][t['selected_round_index']]['concurrency']==8 and t['throughput_gain']>1.1,'parallel: confirmed baseline and selected round are explicit')
                        check(all(sum(q['concurrency']==c and q['status']=='completed' and q['role']!='warmup' for q in t['rounds'])>=3 for c in [1,2,4,8]),'parallel: all candidate levels measured at least three times')
                        check(all(q.get('inference_ms',0)>0 and q.get('overhead_ms',-1)>=0 for q in t['rounds'] if q['status']=='completed'),'parallel: request timing and round overhead are separated')
                        sample_tasks={i['task']['id']:i['task'] for i in before['items']}
                        check(all(s['prompt_sha256']==hashlib.sha256(sample_tasks[s['task_id']]['prompt'].encode()).hexdigest() for q in t['rounds'] for s in q['samples']),'probe prompt hash uses exact UTF-8 prompt')
                        record=api('export/'+rid);record['status']='paused';stopped=api('import',record)['id'];snapshot_rows=rows(stopped)
                        try:enable(stopped);raise AssertionError('completed calibration reran implicitly')
                        except urllib.error.HTTPError as e:check(e.code==400,'completed calibration requires explicit remeasure')
                        enable(stopped,remeasure=True)
                        check(rows(stopped)==snapshot_rows and len(api('export/'+stopped)['concurrency_tuning']['previous_measurements'])==1,'explicit remeasure preserves previous evidence and item rows')
                        for completed_count in (8,7):
                            historical=copy.deepcopy(record);historical['status']='paused'
                            for i,item in enumerate(historical['items']):
                                if i>=completed_count:
                                    item['status']='pending';item['attempts']=[];item['task']['subject']='unvisited-code'
                            # A previously wrong answer remains a timing candidate.
                            historical['items'][0]['attempts'][-1]['score']['value']=0
                            candidate_id=api('import',historical)['id'];candidate_rows=rows(candidate_id);prior_measurement=api('export/'+candidate_id)['concurrency_tuning']
                            enable(candidate_id,remeasure=True);planned=api('export/'+candidate_id)['concurrency_tuning']
                            completed_ids={i['task']['id'] for i in historical['items'][:completed_count]}
                            selected=set(planned['sample_ids'])
                            check(len(selected)==8 and completed_ids<=selected, f'historical pool {completed_count}: all known completed samples precede unmeasured subjects')
                            check(len(selected-completed_ids)==8-completed_count and rows(candidate_id)==candidate_rows,f'historical pool {completed_count}: only missing slots filled, original SQL rows unchanged')
                            check(planned['previous_measurements'][0]==prior_measurement,f'historical pool {completed_count}: prior calibration including failed evidence retained exactly')
                        api('runs/'+stopped+'/concurrency',{'concurrency':1})
                        check(not api('export/'+stopped)['config'].get('auto_concurrency',False),'manual concurrency disables automatic selection')

                # Pause drains a probe and resume after process restart skips it.
                rid=imported('slow-resume');enable(rid);resume(rid)
                progress=wait(rid,lambda r:any(q.get('role')!='warmup' and q.get('status')=='running' and len(q.get('samples',[]))>=1 for q in r.get('concurrency_tuning',{}).get('rounds',[])))
                partial_index=next(i for i,q in enumerate(progress['concurrency_tuning']['rounds']) if q['role']!='warmup' and q['status']=='running' and q['samples'])
                try:enable(rid);raise AssertionError('active calibration accepted settings change')
                except urllib.error.HTTPError as e:check(e.code==400,'auto settings require a drained paused run')
                api('runs/'+rid+'/pause',{});paused=wait(rid,lambda r:r['status']=='paused')
                samples=api('export/'+rid)['concurrency_tuning']['rounds'][partial_index]['samples']
                check(samples and not any(i['attempts'] for i in paused['items']),'pause retains probe progress without modifying question attempts')
                p.terminate();p.wait(timeout=10);p=boot();resume(rid);r=wait(rid)
                check(generated_samples(api('export/'+rid)['concurrency_tuning']['rounds'][partial_index]['samples'][:len(samples)])==generated_samples(samples),'restart/resume preserves completed probe attempts verbatim')
                check(r['status']=='completed' and r['concurrency_tuning']['rounds'][partial_index]['status']=='completed','restart completes the interrupted probe round')
                check(all('DO-NOT-SEND' not in json.dumps(b) and 'answer' not in b and b['temperature']==0 and b['max_tokens']==128 for b in CALLS),'all target payloads exclude answers and keep generation settings')

                # Use persisted synthetic elapsed time to exercise bounded fallback,
                # without waiting ten minutes or changing production timeouts.
                rid=imported('parallel-budget');enable(rid);record=api('export/'+rid)
                record['concurrency_tuning']['elapsed_ms']=600001
                rid=api('import',record)['id'];resume(rid);r=wait(rid)
                check(r['concurrency_tuning']['status']=='unavailable' and r['config']['concurrency']==1 and not r['concurrency_tuning']['rounds'],'exhausted total budget sends no calibration requests and falls back to c1')
                check(r['summary']['scored']==12,'budget fallback continues the original exam')

                # Failed/incomplete calibration must never downgrade a working run.
                for maximum in (4,8):
                    rid=imported('parallel-incumbent',concurrency=8);before_rows=rows(rid);enable(rid,max=maximum)
                    record=api('export/'+rid)
                    check(record['concurrency_tuning']['incumbent_concurrency']==8,'incumbent captures operating c8 independently of requested maximum '+str(maximum))
                    check(rows(rid)==before_rows,'incumbent capture preserves original rows '+str(maximum))
                    record['concurrency_tuning']['elapsed_ms']=600001
                    rid=api('import',record)['id'];resume(rid);r=wait(rid)
                    check(r['config']['concurrency']==8 and r['concurrency_tuning']['status']=='unavailable','budget exhaustion preserves working c8 even with lower search cap '+str(maximum))
                    check(r['summary']['scored']==12,'incumbent fallback still finishes original questions '+str(maximum))

                rid=imported('parallel-legacy',concurrency=8);enable(rid);record=api('export/'+rid)
                record['concurrency_tuning']['version']='auto-concurrency-v1'
                record['concurrency_tuning'].pop('incumbent_concurrency',None)
                rid=api('import',record)['id'];resume(rid);r=wait(rid)
                check(r['config']['concurrency']==8 and r['concurrency_tuning']['status']=='unavailable','unfinished legacy calibration keeps current concurrency instead of applying stale selection')
                check(not r['concurrency_tuning']['rounds'],'legacy migration does not silently remeasure')

                rid=imported('valley');enable(rid);resume(rid);r=wait(rid)
                check(any(q['concurrency']==8 for q in r['concurrency_tuning']['rounds']),'a weaker intermediate stage does not prevent testing c8')

                rid=imported('slow-cancel');enable(rid);resume(rid)
                progress=wait(rid,lambda r:any(q.get('role')!='warmup' and q.get('status')=='running' and len(q.get('samples',[]))>=1 for q in r.get('concurrency_tuning',{}).get('rounds',[])))
                partial_index=next(i for i,q in enumerate(progress['concurrency_tuning']['rounds']) if q['role']!='warmup' and q['status']=='running' and q['samples'])
                api('runs/'+rid+'/cancel',{});stopped=wait(rid,lambda r:r['status']=='cancelled')
                saved_samples=api('export/'+rid)['concurrency_tuning']['rounds'][partial_index]['samples']
                check(saved_samples and all(not i['attempts'] for i in stopped['items']),'cancel preserves finished probes and original unstarted items')
                resume(rid);wait(rid)
                check(generated_samples(api('export/'+rid)['concurrency_tuning']['rounds'][partial_index]['samples'][:len(saved_samples)])==generated_samples(saved_samples),'cancel/resume retains previously completed probe answers')

                rid=imported('parallel-midbudget');enable(rid);record=api('export/'+rid)
                record['concurrency_tuning']['elapsed_ms']=599950
                rid=api('import',record)['id'];resume(rid);r=wait(rid)
                check(r['concurrency_tuning']['status']=='unavailable' and r['config']['concurrency']==1 and r['summary']['scored']==12,'budget expiration interrupts calibration and continues the original exam')

                # New-run preflight must bind the automatic concurrency setting.
                original=seed('parallel-new',4); pack={'id':'synthetic-auto','name':'Fixture','version':'1','sources':{},'tasks':[i['task'] for i in original['items']]}
                api('packs',pack)
                request={'config':dict(original['config'],pack_id=pack['id'],concurrency=4,auto_concurrency=True),'api_key':''}
                preflight=api('preflight',request)
                changed=copy.deepcopy(request);changed['config']['auto_concurrency']=False
                try:api('runs',{**changed,'preflight_token':preflight['preflight_token'],'allow_limited_metrics':True});raise AssertionError('changed auto flag accepted preflight')
                except urllib.error.HTTPError as e:check(e.code==400,'preflight binds automatic concurrency mode')
                rid=api('runs',{**request,'preflight_token':preflight['preflight_token'],'allow_limited_metrics':True})['id'];r=wait(rid)
                check(r['config']['auto_concurrency'] and r['concurrency_tuning']['selected_concurrency']==4,'new run automatically calibrates then finishes original exam')

                # Tiny selected packs cap candidate concurrency by actual sample count.
                rid=imported('parallel-small',3);enable(rid);resume(rid);r=wait(rid)
                check(r['concurrency_tuning']['max_concurrency']==3 and max(q['concurrency'] for q in r['concurrency_tuning']['rounds'])<=3,'small pack never tests concurrency above its sample size')
                # A temporary per-subject cap changes admission, not the exam data.
                rid=imported('parallel-capped',concurrency=8);before=api('export/'+rid);before_rows=rows(rid)
                for bad_limit in (0,-1,100001,'2'):
                    try:api('runs/'+rid+'/subject-limit',{'limit':bad_limit});raise AssertionError('invalid subject limit accepted')
                    except urllib.error.HTTPError as e:check(e.code==400,'invalid per-subject limit rejected '+str(bad_limit))
                api('runs/'+rid+'/subject-limit',{'limit':2})
                capped=api('export/'+rid)
                check(capped['config']['subject_item_limit']==2 and capped['config']['concurrency']==8,'per-subject cap preserves fixed c8')
                check(rows(rid)==before_rows and capped['suite_hash']==before['suite_hash'],'setting per-subject cap preserves task rows and suite hash')
                resume(rid);r=wait(rid)
                check(r['summary']['completed']==4 and sum(i['status']=='pending' for i in r['items'])==8,'two subjects capped at two responses each even at c8')
                completed_rows={i:b for i,b in rows(rid) if json.loads(b)['status']=='done'}
                record=api('export/'+rid);record['status']='paused';lower=api('import',record)['id'];lower_rows=rows(lower)
                api('runs/'+lower+'/subject-limit',{'limit':1});resume(lower);r=wait(lower)
                check(r['summary']['completed']==4 and rows(lower)==lower_rows,'lowering cap below existing responses does not delete or rerun answers')
                record=api('export/'+lower);record['status']='paused';uncapped=api('import',record)['id']
                api('runs/'+uncapped+'/subject-limit',{'limit':None});resume(uncapped);r=wait(uncapped)
                check(r['summary']['completed']==12 and not r['config'].get('subject_item_limit'),'removing temporary cap resumes remaining original questions')

                print(json.dumps({'passed':len(CHECKS),'checks':CHECKS},ensure_ascii=False,indent=2))
            finally:p.terminate();p.wait(timeout=10)
    fixture.shutdown()
if __name__=='__main__':main()
