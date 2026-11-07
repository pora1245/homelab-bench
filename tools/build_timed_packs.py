#!/usr/bin/env python3
"""Freeze nested timed subsets from saved answers. No API calls or record writes.
The public manifest contains task IDs, source hashes and aggregate costs only.
"""
import argparse, collections, hashlib, json, math
from pathlib import Path
from prepare_screening import read, same_task, valid_answer

VERSION = 'timed-60-v1'
WEIGHTS = {'numeric': .05, 'math': .20, 'choice': .25, 'bbh': .15,
           'ifeval': .15, 'humaneval': .10, 'mbpp': .10}
FILES = {'numeric':'gsm8k-test-v1.json','math':'math500-test-v1.json',
         'choice':'mmlu-pro-test-v1.json','bbh':'bbh-cot-full-v1.json',
         'ifeval':'ifeval-full-v1.json','humaneval':'humaneval-full-v1.json','mbpp':'mbpp-test-v1.json'}
STAGES = [('10m',600,'간단 시험 · 10분'),('1h',3600,'소형 시험 · 1시간'),
          ('4h',14400,'상세 시험 · 4시간'),('8h',28800,'전체 시험 · 8시간')]

def digest(v):
    return hashlib.sha256(json.dumps(v,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
def token_count(x):
    a=x['attempts'][-1]; n=(a.get('metrics') or {}).get('output_tokens')
    return n if isinstance(n,(int,float)) and math.isfinite(n) and n>0 else None

def build(deep,qwen,audit,datasets,seed):
    qa={x['task']['id']:x for x in qwen}; aa={x['id']:x for x in audit['rows']}
    original={}; sources=[]
    for scorer,file in FILES.items():
        p=datasets/file; b=p.read_bytes(); pack=json.loads(b)
        sources.append({'file':'datasets/'+file,'sha256':hashlib.sha256(b).hexdigest(),'id':pack['id'],'version':pack['version']})
        original.update({t['id']:t for t in pack['tasks']})
    candidates=[]; excluded=collections.Counter(); dedup=set()
    for x in deep:
        t=x['task']; scorer=t['scorer']; tid=t['id']
        if scorer not in WEIGHTS: continue
        a=x['attempts'][-1]; score=a.get('score') or {}; fix=aa.get(tid)
        state=fix['new_state'] if fix else score.get('state')
        val=fix['new_value'] if fix else score.get('value')
        reason=None
        if a.get('error') or state!='scored': reason='invalid_or_unavailable'
        elif a.get('finish_reason')=='length': reason='length_review'
        elif fix and fix['extraction_method']=='missing_explicit_marker': reason='extraction_review'
        elif not token_count(x): reason='missing_tokens'
        elif tid not in original or not same_task(t,original[tid]): reason='source_mismatch'
        if reason: excluded[reason]+=1; continue
        duplicate=digest({k:t.get(k) for k in ['prompt','answer','scorer','max_tokens','meta']})
        # Exclude only identical input/reference/grading conditions; metadata IDs
        # are not part of identity. Distinct few-shot templates remain distinct.
        identity=digest([t['prompt'],t['answer'],scorer,t['max_tokens']])
        if identity in dedup: excluded['identical_duplicate']+=1;continue
        dedup.add(identity)
        y=qa.get(tid); qt=None
        if y and valid_answer(y) and same_task(t,y['task']): qt=token_count(y)
        cost=max(token_count(x),qt or 0)
        meta=t.get('meta') or {}
        if scorer=='ifeval': category='|'.join(sorted(set(meta.get('instruction_id_list',[]))))
        else: category=str(meta.get('category') or scorer)
        roles=['observed_error_check' if val==0 else 'basic_correctness_check']
        # These are documented source-metadata proxies, not a claim that every
        # problem's semantic difficulty was independently reviewed.
        if ((scorer=='math' and int(meta.get('level') or 0)>=4)
            or (scorer=='ifeval' and len(meta.get('instruction_id_list',[]))>=2)
            or 'seven_objects' in category):
            roles.append('complex_condition_check')
        candidates.append({'id':tid,'scorer':scorer,'category':category,'level':str(meta.get('level','')),
            'value':val,'tokens':cost,'deep_tokens':token_count(x),'qwen_tokens':qt,'task_hash':duplicate,
            'roles':roles,'role_basis':'saved outcome and source metadata; semantic classification unverified',
            'rank':hashlib.sha256((seed+':'+tid).encode()).hexdigest()})
    # Round-robin source strata, outcome and length bands. IDs are shuffled by
    # fixed hash, never sorted by cheapest cost or proximity to a target score.
    for scorer in WEIGHTS:
        rows=sorted([x for x in candidates if x['scorer']==scorer],key=lambda x:(x['tokens'],x['id']))
        for i,x in enumerate(rows): x['band']=min(3,i*4//len(rows))
    picked={}; packs=[]
    for suffix,seconds,name in STAGES:
        budget=int(seconds*60*.9); conflicts=[]
        for scorer,weight in WEIGHTS.items():
            limit=int(round(budget*weight)); spent=sum(x['tokens'] for x in picked.values() if x['scorer']==scorer)
            groups=collections.defaultdict(list)
            for x in candidates:
                if x['scorer']==scorer and x['id'] not in picked:
                    key=(x['category'],x['level'],x['band'],x['value']==1)
                    groups[key].append(x)
            for rows in groups.values(): rows.sort(key=lambda x:x['rank'])
            keys=sorted(groups,key=lambda k:hashlib.sha256((seed+str(k)).encode()).hexdigest())
            while keys:
                next_keys=[]
                for key in keys:
                    rows=groups[key]
                    # Scan only within each stratum when its head does not fit.
                    pos=next((i for i,x in enumerate(rows) if spent+x['tokens']<=limit),None)
                    if pos is None: continue
                    x=rows.pop(pos);picked[x['id']]=x;spent+=x['tokens']
                    if rows:next_keys.append(key)
                keys=next_keys
            if not any(x['scorer']==scorer for x in picked.values()): conflicts.append(scorer)
        rows=sorted(picked.values(),key=lambda x:(list(WEIGHTS).index(x['scorer']),x['rank']))
        by={}
        for scorer in WEIGHTS:
            rr=[x for x in rows if x['scorer']==scorer]
            by[scorer]={'count':len(rr),'generation_tokens':sum(x['tokens'] for x in rr),
               'categories':len({x['category'] for x in rr}),'levels':sorted({x['level'] for x in rr if x['level']}),
               'long_band_count':sum(x['band']==3 for x in rr),'wrong_count':sum(x['value']==0 for x in rr),
               'paired_cost_count':sum(x['qwen_tokens'] is not None for x in rr)}
        total=sum(x['tokens'] for x in rows)
        packs.append({'id':f'timed-{suffix}-v1','name':name,'version':'2026-11-08.1',
            'task_ids':[x['id'] for x in rows], 'sources':{
                'timed_pack':True,'reference_seconds':seconds,'reference_tps':60,'seed':seed,
                'selection_version':VERSION,'official_full_score':False,'generation_budget':budget,
                'selected_generation_tokens':total,'generation_seconds_at_reference':total/60,
                'overhead_reserve_seconds':seconds*.1,'planned_seconds':total/60+seconds*.1,
                'timing_basis':'max observed total generated tokens where paired; DeepSeek otherwise; grading excluded',
                'single_model_cost_count':sum(x['qwen_tokens'] is None for x in rows),
                'source_count':21567,'installed_count':len(rows),'quick_count':len(rows),
                'quick_ids':[x['id'] for x in rows],'components':sources,'subject_breakdown':by,
                'missing_fields':conflicts,'length_retries_pending':excluded['length_review'],
                'selection':'Fixed nested excerpt; source prompts, references and grading conditions unchanged',
                'license':'구성 데이터셋별 기존 고지 유지','redistribution':'reviewed_source_subset'}})
        assert total<=budget
    assert all(set(a['task_ids'])<=set(b['task_ids']) for a,b in zip(packs,packs[1:]))
    assert len({x['category'] for x in picked.values() if x['scorer']=='bbh'})==27
    assert len({x['category'] for x in picked.values() if x['scorer']=='choice'})==14
    assert all(not x['sources']['missing_fields'] for x in packs)
    public={'version':VERSION,'source_files':sources,'packs':packs}
    private={'seed':seed,'excluded':dict(excluded),'eligible':len(candidates),'selected':list(picked.values())}
    return public,private

def main():
    p=argparse.ArgumentParser();p.add_argument('--deepseek',type=Path,required=True);p.add_argument('--qwen',type=Path,required=True);p.add_argument('--bbh-audit',type=Path,required=True);p.add_argument('--datasets',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--seed',default='timed-60-v1');a=p.parse_args()
    out,private=build(read(a.deepseek),read(a.qwen),read(a.bbh_audit),a.datasets,a.seed)
    a.output.mkdir(parents=True,exist_ok=False)
    (a.output/'manifest-v1.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
    (a.output/'selection-private.json').write_text(json.dumps(private,ensure_ascii=False,indent=2)+'\n')
    for pack in out['packs']:print(pack['id'],len(pack['task_ids']),round(pack['sources']['planned_seconds']/60,2),{k:v['count'] for k,v in pack['sources']['subject_breakdown'].items()})
if __name__=='__main__':main()
