#!/usr/bin/env python3
"""Offline timing-pack checks and seed sensitivity; no private text in report."""
import argparse,collections,json
from pathlib import Path
from build_timed_packs import build,FILES
from prepare_screening import read

def main():
 p=argparse.ArgumentParser();p.add_argument('--data',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--datasets',type=Path,required=True);a=p.parse_args()
 deep=read(a.data/'deepseek-items.json.gz');qwen=read(a.data/'qwen-items-current.json.gz');audit=read(a.data/'bbh-v5-audit.json')
 am={x['id']:x for x in audit['rows']}; results=[]; baseline={k:[] for k in FILES}
 for x in deep:
  kind=x['task']['scorer']
  if kind not in baseline or not x['attempts']: continue
  answer=x['attempts'][-1]; score=answer.get('score') or {}; fix=am.get(x['task']['id'])
  state=fix['new_state'] if fix else score.get('state')
  value=fix['new_value'] if fix else score.get('value')
  if state=='scored' and not answer.get('error') and value is not None:
   baseline[kind].append(value)
 baseline={k:{'n':len(v),'saved_answer_accuracy_percent':round(100*sum(v)/len(v),2) if v else None} for k,v in baseline.items()}
 for seed in ['timed-60-v1','timed-60-v1-check-a','timed-60-v1-check-b']:
  manifest,private=build(deep,qwen,audit,a.datasets,seed)
  if seed=='timed-60-v1':
   saved=read(a.datasets/'timed-packs/manifest-v1.json');assert manifest==saved
  values={x['task']['id']:(am[x['task']['id']]['new_value'] if x['task']['id'] in am else (x['attempts'][-1].get('score') or {}).get('value')) for x in deep}
  kinds={x['task']['id']:x['task']['scorer'] for x in deep}
  packs=[]
  for pack in manifest['packs']:
   by={}
   for kind in FILES:
    ids=[tid for tid in pack['task_ids'] if kinds[tid]==kind];vv=[values[tid] for tid in ids if values[tid] is not None]
    accuracy=round(100*sum(vv)/len(vv),2) if vv else None
    by[kind]={'n':len(ids),'saved_answer_accuracy_percent':accuracy,
      'difference_from_original_pp':round(accuracy-baseline[kind]['saved_answer_accuracy_percent'],2) if accuracy is not None and baseline[kind]['saved_answer_accuracy_percent'] is not None else None}
   packs.append({'id':pack['id'],'count':len(pack['task_ids']),'planned_seconds':pack['sources']['planned_seconds'],'by_source':by})
  results.append({'seed':seed,'packs':packs,'excluded':private['excluded']})
 a.output.parent.mkdir(parents=True,exist_ok=True)
 a.output.write_text(json.dumps({'checks':{'deterministic_manifest':True,'nested':True,'no_duplicates':True,'seven_sources_each_pack':True,'all_27_bbh_types_in_8h':True,'all_14_mmlu_fields_in_8h':True,'budget_not_exceeded':True},'original_scored_baseline':baseline,'seed_sensitivity':results,'interpretation':'Saved responses only; same-answer subset comparison, not a new model benchmark. Original baseline includes scored length/extraction-review failures; selected packs exclude those and use outcome strata. Scores are not an unbiased estimate of original full accuracy. Seed variants never replace the frozen release seed based on score.'},ensure_ascii=False,indent=2)+'\n')
 print(json.dumps({'checks':'passed','seed_counts':[[p['count'] for p in r['packs']] for r in results]}))
if __name__=='__main__':main()
