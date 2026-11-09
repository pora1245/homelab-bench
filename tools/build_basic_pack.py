#!/usr/bin/env python3
"""One nested basic pack, calibrated from saved Qwen c1 request time (not grading).
Private responses stay in --output; public manifest contains IDs and aggregate costs.
"""
import argparse, collections, hashlib, json, statistics
from pathlib import Path
from build_timed_packs import build, FILES, WEIGHTS, STAGES
from prepare_screening import read, same_task, valid_answer


def calibration(deep, qwen_sets, audit, datasets):
    original = {x['task']['id']:x for x in deep}
    observations = collections.defaultdict(list)
    for items in qwen_sets:
        for x in items:
            if x['task']['id'] not in original or not x.get('attempts'): continue
            if not same_task(x['task'],original[x['task']['id']]['task']) or not valid_answer(x): continue
            a=x['attempts'][-1]; m=a.get('metrics') or {}
            if m.get('request_concurrency',1)!=1: continue
            tokens=m.get('output_tokens'); wall=m.get('wall_ms')
            if not tokens or not wall or wall<=0 or a.get('finish_reason')=='length': continue
            observations[x['task']['id']].append((wall/1000,tokens))
    # Reuse the audited eligibility rules, but use every eligible original item,
    # including items outside the previous 8h selection.
    candidates=[]; fixes={x['id']:x for x in audit['rows']}; dedup=set()
    sources=[]; tasks={}
    for scorer,file in FILES.items():
        b=(datasets/file).read_bytes(); p=json.loads(b)
        sources.append({'file':'datasets/'+file,'sha256':hashlib.sha256(b).hexdigest(),'id':p['id'],'version':p['version']})
        tasks.update({t['id']:t for t in p['tasks']})
    ratios=collections.defaultdict(list)
    for tid,obs in observations.items():
        x=original[tid]; dt=(x['attempts'][-1].get('metrics') or {}).get('output_tokens')
        if dt: ratios[x['task']['scorer']].append(statistics.median(o[0] for o in obs)/(dt/60))
    excluded=collections.Counter()
    for x in deep:
        t=x['task']; kind=t['scorer']; tid=t['id']
        if kind not in WEIGHTS or not x.get('attempts'):continue
        a=x['attempts'][-1]; s=a.get('score') or {}; f=fixes.get(tid)
        state=f['new_state'] if f else s.get('state'); value=f['new_value'] if f else s.get('value')
        dt=(a.get('metrics')or{}).get('output_tokens')
        if a.get('error') or state!='scored' or a.get('finish_reason')=='length' or not dt or (f and f['extraction_method']=='missing_explicit_marker'):
            excluded['invalid_length_or_unresolved']+=1;continue
        if tid not in tasks or not same_task(t,tasks[tid]):excluded['source_mismatch']+=1;continue
        identity=json.dumps([t['prompt'],t['answer'],kind,t['max_tokens']],sort_keys=True)
        if identity in dedup:excluded['duplicate']+=1;continue
        dedup.add(identity)
        obs=observations.get(tid); ratio=statistics.median(ratios[kind]) if ratios[kind] else 2.0
        seconds=statistics.median(o[0] for o in obs) if obs else dt/60*ratio
        meta=t.get('meta') or {}
        category='|'.join(sorted(set(meta.get('instruction_id_list',[])))) if kind=='ifeval' else str(meta.get('category')or kind)
        candidates.append({'id':tid,'scorer':kind,'category':category,'level':str(meta.get('level','')),'value':value,
          'seconds':seconds,'measured':bool(obs),'samples':len(obs or []),'rank':hashlib.sha256(('basic-qwen-v2:'+tid).encode()).hexdigest()})
    for kind in WEIGHTS:
        rr=sorted([x for x in candidates if x['scorer']==kind],key=lambda x:(x['seconds'],x['id']))
        for i,x in enumerate(rr):x['band']=min(3,i*4//len(rr))
    picked={};modes=[]
    for mode,seconds,_ in STAGES:
        # Keep 2% scheduler/client reserve; all measured costs exclude grading.
        budget=seconds*.98
        for kind,w in WEIGHTS.items():
            limit=budget*w; spent=sum(x['seconds'] for x in picked.values() if x['scorer']==kind)
            if mode=='10m':
                pool=sorted([x for x in candidates if x['scorer']==kind and x['measured']],key=lambda x:x['rank'])
                for n in range(3):
                    x=next((x for x in pool if x['id'] not in picked and x['seconds']<=(limit-spent)/(3-n)),None)
                    if x is None:raise ValueError('10분 최소 3문항 예산 부족: '+kind)
                    picked[x['id']]=x;spent+=x['seconds']
            groups=collections.defaultdict(list)
            for x in candidates:
                if x['scorer']==kind and x['id'] not in picked and (mode not in ['10m','1h'] or x['measured']):
                    groups[(x['category'],x['level'],x['band'],x['value']==1)].append(x)
            for rr in groups.values():rr.sort(key=lambda x:x['rank'])
            keys=sorted(groups,key=lambda k:hashlib.sha256(('basic-qwen-v2:'+str(k)).encode()).hexdigest())
            while keys:
                next_keys=[]
                for k in keys:
                    rr=groups[k]; pos=next((i for i,x in enumerate(rr) if spent+x['seconds']<=limit),None)
                    if pos is None:continue
                    x=rr.pop(pos);picked[x['id']]=x;spent+=x['seconds']
                    if rr:next_keys.append(k)
                keys=next_keys
        rr=sorted(picked.values(),key=lambda x:(list(WEIGHTS).index(x['scorer']),x['rank']))
        counts=collections.Counter(tasks[x['id']]['subject'] for x in rr)
        by={k:{'count':sum(x['scorer']==k for x in rr),'measured':sum(x['scorer']==k and x['measured'] for x in rr),'seconds':sum(x['seconds'] for x in rr if x['scorer']==k),'categories':len({x['category'] for x in rr if x['scorer']==k})} for k in WEIGHTS}
        assert all(v['count'] for v in by.values())
        modes.append({'id':mode,'name':{'10m':'10분','1h':'1시간','4h':'4시간','8h':'8시간'}[mode],
          'task_ids':[x['id'] for x in rr],'count':len(rr),'subjects':dict(counts),'reference_seconds':seconds,
          'predicted_request_seconds':sum(x['seconds'] for x in rr),'planned_seconds':sum(x['seconds'] for x in rr)+seconds*.02,
          'measured_count':sum(x['measured'] for x in rr),'estimated_count':sum(not x['measured'] for x in rr),'breakdown':by})
    assert all(set(a['task_ids'])<=set(b['task_ids']) for a,b in zip(modes,modes[1:]))
    manifest={'id':'basic-bench-v2','name':'기본 벤치팩','version':'2026-11-08.2','source_files':sources,'modes':modes,
      'sources':{'basic_pack':True,'benchmark':'GSM8K · MATH-500 · MMLU-Pro · BBH · IFEval · HumanEval · MBPP',
      'timing_basis':'Qwen3.8 Flash IQ3 · RTX3060 · c1 · template default xhigh; measured request wall time excludes grading. Unmeasured long-mode items use per-scorer median Qwen/DeepSeek cost ratio.',
      'calibration_version':'qwen-c1-v2','reference_model':'qwen3.8-flash-next-iq3_xxs-3060','reference_concurrency':1,
      'reference_reasoning':'xhigh (engine default; high alias)','reference_tps':60,'reference_tps_note':'목표 기준. v2 시간 보정에는 Qwen 실제 요청 시간을 사용.',
      'full_replay_verified':False,'source_count':21567,'license':'구성 데이터셋별 기존 고지 유지','redistribution':'reviewed_source_subset'}}
    return manifest,{'observations':len(observations),'excluded':dict(excluded),'scorer_cost_ratios':{k:statistics.median(v) for k,v in ratios.items()},'selected':list(picked.values())}

def main():
    p=argparse.ArgumentParser();p.add_argument('--data',type=Path,required=True);p.add_argument('--datasets',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    sets=[read(a.data/'qwen-items-current.json.gz')]
    for f in ['qwen-screening-final.json','product-quick-final.json']:sets.append(read(a.data/f)['items'])
    public,private=calibration(read(a.data/'deepseek-items.json.gz'),sets,read(a.data/'bbh-v5-audit.json'),a.datasets)
    a.output.mkdir(parents=True,exist_ok=False)
    (a.output/'manifest-v2.json').write_text(json.dumps(public,ensure_ascii=False,indent=2)+'\n')
    (a.output/'cost-private.json').write_text(json.dumps(private,ensure_ascii=False,indent=2)+'\n')
    for m in public['modes']:print(m['id'],m['count'],round(m['planned_seconds']/60,2),'measured',m['measured_count'],'estimated',m['estimated_count'],{k:v['count'] for k,v in m['breakdown'].items()})
if __name__=='__main__':main()
