#!/usr/bin/env python3
"""Offline product API contract: synthetic Responses output, never model scores."""
import copy, hashlib, http.server, json, os, socket, sqlite3, subprocess, tempfile, threading, time, urllib.error, urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
checks=[]; requests=[]; paths=[]
def check(ok,label):
    assert ok,label
    checks.append(label)
class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        paths.append(self.path)
        self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
        self.wfile.write(json.dumps({'data':[{'id':'fixture'}]}).encode())
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));requests.append(body);paths.append(self.path)
        prompt=body['input']
        if isinstance(prompt,list):
            prompt=prompt[0]['content']
            if isinstance(prompt,list):prompt=prompt[0]['text']
        assert isinstance(prompt,str)
        if '준비 완료' in prompt: text='준비 완료'
        elif 'JSON array' in prompt: text='```json\n'+json.dumps([{'id':n,'name':'fruit','description':'synthetic fixture description'} for n in range(1,25)])+'\n```'
        elif 'LRU cache' in prompt:text='```python\nclass Cache:\n    def get(self, key): return None\n    def put(self, key, value): pass\n```'
        else:text='Synthetic visible output. '*30
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
        def event(v):
            self.wfile.write(('data: '+json.dumps(v)+'\n\n').encode());self.wfile.flush()
        event({'type':'response.reasoning_summary_text.delta','delta':'Thinking'})
        time.sleep(.03)
        half=len(text)//2
        event({'type':'response.output_text.delta','delta':text[:half]})
        time.sleep(.03)
        event({'type':'response.output_text.delta','delta':text[half:]})
        event({'type':'response.completed','response':{'status':'completed','model':'fixture','usage':{'input_tokens':30,'output_tokens':100,'output_tokens_details':{'reasoning_tokens':20}},'output':[]}})
def free_port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def main():
    fixture=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture);threading.Thread(target=fixture.serve_forever,daemon=True).start()
    base=f'http://127.0.0.1:{free_port()}';target=f'http://127.0.0.1:{fixture.server_port}/v1/responses'
    def api(path,body=None):
        req=urllib.request.Request(base+'/api/'+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=15) as r:return json.load(r)
    def wait(rid):
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            r=api('runs/'+rid)
            if r['status']=='completed':return r
            time.sleep(.05)
        raise AssertionError('fixture did not complete')
    with tempfile.TemporaryDirectory(prefix='bench-experience-') as d:
        with open(Path(d)/'server.log','w') as log:
            def boot():
                process=subprocess.Popen([str(ROOT/'target/debug/llm-bench')],cwd=ROOT,env=dict(os.environ,BENCH_PORT=base.rsplit(':',1)[1],BENCH_DATA_DIR=d),stdout=log,stderr=log)
                for _ in range(100):
                    try:
                        if api('health')['ok']:return process
                    except Exception:time.sleep(.05)
                process.terminate();process.wait(timeout=10)
                raise AssertionError('fixture app did not start')
            p=boot()
            try:
                packs=api('packs'); exp=next(x for x in packs if x['id']=='api-experience-v1'); collection=next(x for x in packs if x['id']=='collection-full-v1')
                check(exp['count']==13 and exp['sources']['quick_count']==13,'experience full/quick include 12 measurements + warmup')
                components=collection['sources']['components']
                originals=[json.loads((ROOT/'datasets'/f"{component['id']}.json").read_text()) for component in components]
                expected_count=sum(len(pack['tasks']) for pack in originals)
                expected_quick=sum(len(pack['sources']['quick_ids']) for pack in originals)
                check(collection['count']==expected_count and collection['sources']['quick_count']==expected_quick,f'collection matches installed original packs ({expected_count} full / {expected_quick} quick)')
                source=json.loads((ROOT/'datasets/api-experience-v1.json').read_text())
                check(all(t['meta']['prompt_sha256']==hashlib.sha256(t['prompt'].encode()).hexdigest() for t in source['tasks']),'all fixed prompt hashes match')
                c=api('connections',{'name':'Responses fixture','kind':'target','base_url':target,'api_format':'responses','model':'fixture','defaults':{'temperature':0,'max_tokens':4096,'concurrency':1,'timeout_s':30,'reasoning_effort':'low'},'api_key':'SYNTHETIC-ONLY'})
                check(c['api_format']=='responses','connection stores Responses format')
                check(api(f"connections/{c['id']}/check",{})['ok'] and paths[-1]=='/v1/models','model list normalizes Responses URL')
                config={'name':'Offline experience fixture','base_url':'http://invalid.invalid','model':'ignored','pack_id':'api-experience-v1','profile':'quick','subjects':[],'temperature':0,'max_tokens':4096,'concurrency':1,'timeout_s':30,'reasoning_effort':'low'}
                started=api('runs',{'config':config,'connection_id':c['id']});rid=started['id']
                r=wait(rid)
                check(r['status']=='completed' and len(requests)==13,'product executes all 13 requests via saved connection')
                check(r['config']['api_format']=='responses' and set(paths[1:])=={'/v1/responses'},'saved format controls inference route')
                check(all(i['attempts'][-1]['score']['state']=='measured' and i['attempts'][-1]['score']['value'] is None for i in r['items']),'performance outcomes do not become intelligence points')
                check(all(i['attempts'][-1]['score']['extra']['valid_output'] for i in r['items']),'all synthetic output gates pass')
                check(r['summary']['score_errors']==0 and r['summary']['scored']==0,'measurements are not scoring errors or knowledge successes')
                check(all(i['attempts'][-1]['metrics']['client_visible_decode_tps']>0 for i in r['items']),'client visible output speed retained')
                check(all(i['attempts'][-1]['metrics']['visible_output_tokens']==80 for i in r['items']),'reasoning tokens excluded from visible output')
                check('SYNTHETIC-ONLY' not in json.dumps(r),'run response does not expose saved key')
                check(all('answer' not in req and 'meta' not in req for req in requests),'reference and scoring metadata excluded from target requests')
                compact=api('runs/'+rid+'?view=compact')
                check(compact['items'][1]['task']['meta']['performance_protocol']=='api-experience-v1','compact run preserves scoring protocol metadata')
                wrapped=[i['attempts'][-1]['score'] for i in compact['items'] if i['task']['meta']['experience_case'] in ('code','structured')]
                check(len(wrapped)==6 and all(s['scorer_version']=='api-experience-output-v2' and s['extra']['valid_output'] and s['extra']['format_compliant'] is False and s['extra']['presentation_wrapper']=='markdown_fence' for s in wrapped),'compact run separates wrapper format compliance from valid workload')

                # Import a legacy record with a quality witness. Revalidation
                # must work from saved output without asking either API again.
                legacy=api('export/'+rid)
                for item in legacy['items']:
                    item['attempts'][-1]['score']={'value':None,'state':'measured','detail':'legacy fixture gate','scorer_version':'api-experience-v1','extra':{'valid_output':item['task']['meta']['experience_case'] not in ('code','structured')}}
                quality=copy.deepcopy(legacy['items'][0])
                quality['task'].update(id='quality-witness',scorer='judge',meta={},answer={'rubric':'never call the judge during performance revalidation'})
                quality['attempts'][-1]['score']={'value':1,'state':'scored','detail':'preserve this quality result','scorer_version':'quality-witness-v1','extra':{'evidence':'immutable'}}
                legacy['items'].append(quality)
                legacy['config']['judge']={'base_url':target,'model':'never-call-judge','max_tokens':64}
                before_calls=len(requests)
                imported=api('import',legacy)['id']
                before=api('export/'+imported)
                check(all(i['attempts'][-1]['score']['scorer_version']=='api-experience-output-v2' for i in before['items'][:-1]),'import automatically upgrades legacy performance results')
                original_quality=copy.deepcopy(legacy['items'][-1]);original_quality.pop('verdict',None)
                imported_quality=copy.deepcopy(before['items'][-1]);imported_quality.pop('verdict',None)
                check(len(requests)==before_calls and imported_quality==original_quality,'import invokes neither model nor judge and preserves quality witness')
                def seed_legacy_scores():
                    # Only the synthetic stopped app DB is edited to reproduce
                    # an installation containing pre-upgrade saved results.
                    old_scores={i['task']['id']:i['attempts'][-1]['score'] for i in legacy['items']}
                    with sqlite3.connect(Path(d,'app.sqlite3')) as conn:
                        for position,body in conn.execute('SELECT position,body FROM run_items WHERE run_id=?',(imported,)).fetchall():
                            item=json.loads(body)
                            if item['task']['scorer']=='experience':
                                item['attempts'][-1]['score']=old_scores[item['task']['id']]
                                conn.execute('UPDATE run_items SET body=? WHERE run_id=? AND position=?',(json.dumps(item),imported,position))
                def database_snapshot():
                    with sqlite3.connect(Path(d,'app.sqlite3')) as conn:
                        return [conn.execute('SELECT id,body FROM runs ORDER BY id').fetchall(),conn.execute('SELECT run_id,position,body FROM run_items ORDER BY run_id,position').fetchall()]
                p.terminate();p.wait(timeout=10)
                seed_legacy_scores()
                p=boot()
                after=api('export/'+imported)
                check(len(requests)==before_calls,'startup upgrade makes zero model or judge requests')
                check(after['items'][-1]==before['items'][-1],'quality task and score remain byte-for-byte equivalent')
                def without_performance_scores(record):
                    result=copy.deepcopy(record)
                    result.pop('summary',None)
                    for item in result['items']:
                        if item['task']['scorer']=='experience':
                            # Verdict derives from score, not original evidence.
                            item.pop('verdict',None)
                            for attempt in item['attempts']:attempt.pop('score',None)
                    return result
                check(without_performance_scores(after)==without_performance_scores(before),'raw output, raw frames, metrics, config, telemetry and quality evidence are unchanged')
                for old,item in zip(legacy['items'][:-1],after['items'][:-1]):
                    score=item['attempts'][-1]['score']
                    check(score['extra']['grading_history'][0]['score']==old['attempts'][-1]['score'],'legacy performance judgment is preserved: '+item['task']['id'])
                check(all(i['attempts'][-1]['score']['extra']['valid_output'] and i['attempts'][-1]['score']['scorer_version']=='api-experience-output-v2' for i in after['items'][:-1]),'same stored fenced output passes v2 without inference')
                check(after['items'][0]['attempts'][-1]['score']['extra']['warmup'] is True,'warmup identity is preserved for score exclusion')
                saved=database_snapshot()
                p.terminate();p.wait(timeout=10);p=boot()
                check(api('export/'+imported)==after and database_snapshot()==saved and len(requests)==before_calls,'second restart changes neither records, grading history, timestamps nor stored DB bodies')
                try:
                    api('runs/'+imported+'/rescore-performance',{})
                    raise AssertionError('removed manual action still available')
                except urllib.error.HTTPError as e:
                    check(e.code==400,'manual performance revalidation action is not exposed')

                api('runs/'+imported+'/delete',{})
                p.terminate();p.wait(timeout=10);seed_legacy_scores();p=boot()
                before_restore=database_snapshot()
                with sqlite3.connect(Path(d,'app.sqlite3')) as conn:
                    conn.execute("CREATE TRIGGER fixture_block_upgrade BEFORE UPDATE ON run_items BEGIN SELECT RAISE(ABORT,'fixture upgrade write failure'); END")
                try:
                    api('trash/'+imported+'/restore',{})
                    raise AssertionError('restore accepted a failed upgrade write')
                except urllib.error.HTTPError as e:
                    check(e.code==400 and any(r['id']==imported for r in api('trash')) and database_snapshot()==before_restore,'failed restore upgrade keeps trash marker and original DB evidence atomically')
                with sqlite3.connect(Path(d,'app.sqlite3')) as conn:
                    conn.execute('DROP TRIGGER fixture_block_upgrade')
                api('trash/'+imported+'/restore',{})
                restored=api('export/'+imported)
                check(all(i['attempts'][-1]['score']['scorer_version']=='api-experience-output-v2' and len(i['attempts'][-1]['score']['extra']['grading_history'])==1 for i in restored['items'][:-1]),'trash restore automatically upgrades legacy results once')
                check(without_performance_scores(restored)==without_performance_scores(before) and len(requests)==before_calls,'trash restore preserves evidence and quality without inference')
                # Existing all-task action remains available for an experience-only run.
                api('runs/'+rid+'/rescore',{})
                rescored=wait(rid)
                check(len(requests)==before_calls and all(i['attempts'][-1]['score']['extra']['grading_history'] for i in rescored['items']),'existing rescore still preserves history and reuses performance output')
                print(json.dumps({'passed':len(checks),'checks':checks},ensure_ascii=False,indent=2))
            finally:p.terminate();p.wait(timeout=10)
    fixture.shutdown()
if __name__=='__main__':main()
