"""Freeze a completed product run as the versioned API-experience reference.
No model calls. Refuses partial, truncated, different-input or unvalidated runs.
"""
import argparse,hashlib,json,statistics,datetime
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('run');p.add_argument('--output',default=str(ROOT/'web/src/frontier-reference.json'));a=p.parse_args()
dest=Path(a.output)
if dest.exists(): assert json.loads(dest.read_text()).get('status')!='ready', 'Ready references are immutable; choose a new output file/version'
r=json.loads(Path(a.run).read_text());cfg=r['config']
assert r['status']=='completed' and r['provenance']=='live_api'
assert cfg['model']=='gpt-6.1-sol' and cfg['api_format']=='responses' and cfg['reasoning_effort']=='low' and cfg['concurrency']==1
assert cfg['pack_id']=='api-experience-v1' and cfg['max_tokens']==4096
pack=json.loads((ROOT/'datasets/api-experience-v1.json').read_text());expected={t['id']:t for t in pack['tasks']}
assert len(r['items'])==len(expected)==13
assert {i['task']['id'] for i in r['items']}==set(expected)
for i in r['items']:
 t=i['task'];v=i['attempts'][-1];m=v['metrics'];original=expected[t['id']]
 assert t['prompt']==original['prompt'] and t['meta']==original['meta']
 request=v['raw'][0];assert request['kind']=='request' and request['api_format']=='responses'
 body=request['body'];assert body['model']=='gpt-6.1-sol' and body['reasoning']['effort']=='low'
 assert body['input']==[{'role':'user','content':original['prompt']}] and body['max_output_tokens']==min(original['max_tokens'],4096)
 assert body['stream'] is True and body['store'] is False and 'temperature' not in body
 assert hashlib.sha256(t['prompt'].encode()).hexdigest()==t['meta']['prompt_sha256']
 assert i['status']=='done' and v['error'] is None and v['finish_reason']=='stop' and v['ended_at']
 assert v['score']['state']=='measured' and v['score']['extra']['valid_output'] is True
 assert v['score']['scorer_version']=='api-experience-output-v2', 'Revalidate stored performance outputs without new model requests first'
 assert m['measurement_version']=='client-visible-v1' and m['ttft_source']=='client_visible_stream'
 if not t['meta'].get('warmup'): assert m['client_visible_decode_tps']>0 and m['ttft_ms']>0
ref={'status':'ready','id':'bench-api-experience-v1-gpt61sol-'+r['created_at'][:10].replace('-','')+'-'+r['id'][:8],'protocol':'api-experience-v1','output_validation':'api-experience-output-v2','model':cfg['model'],'reasoning_effort':cfg['reasoning_effort'],'measured_at':r['created_at'],'run_id':r['id'],'suite_hash':r['suite_hash'],'measurement_version':'client-visible-v1','concurrency':1,'max_output_tokens':4096,'temperature':'omitted (reasoning model default)','cases':{}}
for key in ('english','korean','code','structured'):
 items=[i for i in r['items'] if i['task']['meta'].get('experience_case')==key]
 assert len(items)==3
 metrics=[i['attempts'][-1]['metrics'] for i in items];d=[m['client_visible_decode_tps'] for m in metrics];t=[m['ttft_ms'] for m in metrics]
 ref['cases'][key]={'decode_tps':statistics.median(d),'ttft_ms':statistics.median(t),'prompt_sha256':items[0]['task']['meta']['prompt_sha256'],'count':3,'decode_range':[min(d),max(d)],'ttft_range_ms':[min(t),max(t)]}
Path(a.output).write_text(json.dumps(ref,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(ref,ensure_ascii=False,indent=2))
