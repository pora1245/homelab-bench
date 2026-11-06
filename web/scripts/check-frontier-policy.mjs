import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built=await build({entryPoints:['src/assessment.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {supplementalBenchmarks,assessRunV3:assessRun,assessRunV2,combineScoresV3,EXPERIENCE_CASES,BENCH_SCORE_POLICY_V1}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const hash='a'.repeat(64);
const reference={status:'ready',id:'fixture-reference',protocol:'api-experience-v1',model:'fixture',reasoning_effort:'low',measured_at:'2026-11-06T00:00:00Z',run_id:'fixture',suite_hash:'fixture-hash',cases:Object.fromEntries(EXPERIENCE_CASES.map(c=>[c,{ttft_ms:2000,decode_tps:100,prompt_sha256:hash}]))};
const timing={wall_ms:120000,visible_output_tokens:2000,output_tokens:2000,reasoning_tokens:0,measurement_version:'client-visible-v1',ttft_ms:2000,ttft_source:'client_visible_stream',client_visible_decode_tps:100,decode_tps:100,decode_source:'server'};
const item=(id,meta={},metrics=timing,score={state:'measured',value:null,scorer_version:'api-experience-output-v2',extra:{valid_output:true}})=>({task:{id,meta},status:'done',attempts:[{ended_at:'2026-11-06T00:00:00Z',error:null,finish_reason:'stop',metrics:{...metrics},score:structuredClone(score)}]});
const samples=EXPERIENCE_CASES.flatMap(c=>[1,2,3].map(n=>item(`experience:${c}:${n}`,{performance_protocol:'api-experience-v1',prompt_sha256:hash})));
const quality=BENCH_SCORE_POLICY_V1.benchmarks.flatMap(b=>Array.from({length:b.quick},(_,n)=>item(`${b.id}:${n}`,{},timing,{state:'scored',value:1,scorer_version:'fixture'})));
const run={status:'completed',config:{profile:'quick',concurrency:1},items:samples};
let count=0;const check=(name,fn)=>{fn();count++;console.log('PASS '+name)};
check('reference itself is 1000; missing intelligence remains unknown',()=>{const a=assessRun(run,reference);assert.equal(a.performance.value,1000);assert.equal(a.intelligence.value,null);assert.equal(a.overall.value,null);assert.equal(a.scoringFailures,0);assert.equal(a.unrecognizedItems,0)});
check('all cases and speed dimensions have equal log weight',()=>{const r=structuredClone(run);r.items.filter(i=>i.task.id.startsWith('experience:english:')).forEach(i=>i.attempts[0].metrics.client_visible_decode_tps*=4);assert.equal(assessRun(r,reference).performance.value,Math.round(1000*4**(1/8)*10)/10)});
check('performance uncapped and overall capped at 100',()=>{const r=structuredClone(run);r.items.forEach(i=>{i.attempts[0].metrics.client_visible_decode_tps*=10;i.attempts[0].metrics.ttft_ms/=10});r.items.push(...quality);const a=assessRun(r,reference);assert.equal(a.performance.value,10000);assert.equal(a.overall.value,100);assert.equal(a.intelligence.value,100)});
check('slow performance reduces overall and preserves intelligence',()=>{const r=structuredClone(run);r.items.forEach(i=>i.attempts[0].metrics.client_visible_decode_tps/=4);r.items.push(...quality);const a=assessRun(r,reference);assert.equal(a.performance.value,500);assert.equal(a.overall.value,Math.round(100*.5**.3*10)/10)});
check('warmup and quality metrics do not change performance',()=>{const r=structuredClone(run);r.items.push(item('experience:warmup:0',{}, {...timing,ttft_ms:1,client_visible_decode_tps:999999}),...quality);assert.equal(assessRun(r,reference).performance.value,1000);assert.equal(assessRun(r,reference).performanceEvidence.pairedCount,12)});
check('three valid samples per class and same protocol required',()=>{const changes=[r=>r.items.pop(),r=>r.items[0].status='error',r=>r.items[0].attempts[0].error='bad',r=>r.items[0].attempts[0].ended_at=null,r=>r.items[0].attempts[0].finish_reason='length',r=>r.items[0].attempts[0].finish_reason='content_filter',r=>r.items[0].attempts[0].finish_reason=null,r=>r.items[0].attempts[0].score.extra.valid_output=false,r=>r.items[0].attempts[0].metrics.ttft_ms=0,r=>r.items[0].attempts[0].metrics.client_visible_decode_tps=null,r=>r.items[0].attempts[0].metrics.ttft_source='client_stream',r=>r.items[0].attempts[0].metrics.measurement_version='legacy',r=>r.items[0].task.meta.prompt_sha256='b'.repeat(64),r=>r.items[0].task.meta.performance_protocol='wrong'];for(const change of changes){const r=structuredClone(run);change(r);assert.equal(assessRun(r,reference).performance.value,null)}});
check('one slow outlier does not replace per-case median',()=>{const r=structuredClone(run);r.items[0].attempts[0].metrics.ttft_ms=100000;assert.equal(assessRun(r,reference).performance.value,1000)});
check('legacy indices retained without new guessed score or mutation',()=>{const r={...run,items:quality},before=JSON.stringify(r),a=assessRun(r,reference);assert.equal(a.performance.value,null);assert.equal(a.overall.value,null);assert.equal(a.legacyV2.performance.value,assessRunV2(r).performance.value);assert.equal(JSON.stringify(r),before)});
check('pending/malformed reference and concurrency reject score',()=>{for(const ref of [{...reference,status:'pending'},{...reference,cases:{}},{...reference,run_id:''},{...reference,cases:{...reference.cases,english:{...reference.cases.english,decode_tps:0}}}])assert.equal(assessRun(run,ref).performance.value,null);assert.equal(assessRun({...run,config:{...run.config,concurrency:2}},reference).performance.value,null)});
check('partial intelligence yields completion bounds below 100',()=>{const a=assessRun({...run,items:[...samples,...quality.filter(i=>i.task.id.startsWith('gsm8k:'))]},reference);assert.equal(a.overall.value,null);assert.equal(a.overall.upper,100);assert.equal(a.overall.lower,Math.floor(100*.125**.7*10)/10)});
check('zero intelligence means zero overall',()=>{const a=assessRun({...run,items:[...samples,...quality.map(i=>({...i,attempts:[{...i.attempts[0],score:{state:'scored',value:0}}]}))]},reference);assert.equal(a.overall.value,0)});
check('invalid overall arguments remain unknown',()=>{const s={state:'complete',value:100,lower:100,upper:100,coverage:100,measuredOnly:null,reason:''};assert.equal(combineScoresV3({...s,upper:101},{...s,value:1000}).value,null);assert.equal(combineScoresV3(s,{...s,value:0}).value,null)});
check('BBH expansion accuracy leaves v3 index and original records unchanged',()=>{const base={...run,items:[...samples,...quality]};const extra=[item('bbh:logic:0',{},timing,{state:'scored',value:1}),item('bbh:logic:1',{},timing,{state:'scored',value:0}),item('bbh:logic:2',{},timing,{state:'unavailable',value:null})];const r={...base,items:[...base.items,...extra,extra[0]]},before=JSON.stringify(r);const a=assessRun(r,reference),b=assessRun(base,reference);assert.deepEqual(a.intelligence,b.intelligence);assert.deepEqual(a.overall,b.overall);assert.equal(a.unrecognizedItems,0);assert.deepEqual(supplementalBenchmarks(r).map(v=>({selected:v.selected,scored:v.scored,percent:v.percent})),[{selected:3,scored:2,percent:50}]);assert.equal(JSON.stringify(r),before)});
check('presentation warning keeps measured timing and intelligence independent',()=>{const r=structuredClone(run);r.items.filter(i=>i.task.id.startsWith('experience:code:')).forEach(i=>{i.attempts[0].score.extra.format_compliant=false;i.attempts[0].score.extra.presentation_wrapper='markdown_fence'});const before=JSON.stringify(r);assert.equal(assessRun(r,reference).performance.value,1000);assert.equal(assessRun(r,reference).intelligence.value,null);assert.equal(JSON.stringify(r),before)});
check('old output validators indicate automatic migration without another model test',()=>{const r=structuredClone(run);r.items.forEach(i=>i.attempts[0].score.scorer_version='api-experience-v1');const a=assessRun(r,reference);assert.equal(a.performance.value,null);assert.match(a.performance.reason,/모델을 다시 호출하지/);assert.match(a.guides[0].title,/자동 반영/)});
check('terminal output limits name affected cases and exclude warmup from counts',()=>{
  const r=structuredClone(run);
  const warmup=item('experience:warmup:0',{warmup:true,performance_protocol:'api-experience-v1'});
  r.items.push(warmup);
  for(const i of r.items.filter(i=>i.task.id.startsWith('experience:korean:')||i===warmup)){
    i.attempts[0].finish_reason='length';i.attempts[0].score.extra.valid_output=false;
    i.attempts[0].metrics.ttft_ms=null;i.attempts[0].metrics.client_visible_decode_tps=null;
  }
  const before=JSON.stringify(r),a=assessRun(r,reference);
  assert.equal(a.performance.value,null);assert.equal(a.performanceEvidence.pairedCount,9);
  assert.match(a.performance.reason,/출력 한도 도달: 한국어 3건/);assert.match(a.performance.reason,/정상 유효 9\/12건/);
  assert.doesNotMatch(a.performance.reason,/계측 누락|출력 검증 실패|4건/);assert.equal(JSON.stringify(r),before);
});
check('terminal invalid outputs and missing timing have distinct evidence',()=>{
  const r=structuredClone(run);r.items[0].attempts[0].metrics.ttft_ms=null;
  r.items.find(i=>i.task.id==='experience:code:1').attempts[0].score.extra.valid_output=false;
  const a=assessRun(r,reference);assert.equal(a.performance.value,null);
  assert.match(a.performance.reason,/출력 검증 실패 1건/);assert.match(a.performance.reason,/TTFT·Decode 계측 누락 1건/);
  assert.match(a.performance.reason,/정상 유효 10\/12건/);assert.doesNotMatch(a.performance.reason,/출력 한도 도달/);
});
check('pending fixed performance keeps automatic same-exam progress messaging',()=>{
  const r=structuredClone(run);r.status='running';r.items[0].attempts[0].finish_reason='length';
  r.items.at(-1).status='pending';r.items.at(-1).attempts=[];
  const a=assessRun(r,reference);assert.equal(a.performance.value,null);
  assert.match(a.performance.reason,/성능 측정 대기/);assert.match(a.performance.reason,/이 시험.*자동/);
  assert.match(a.guides[0].next,/이 시험/);assert.doesNotMatch(a.guides[0].next,/새 시험/);
});
check('terminal performance failure guides explain evidence without prescribing another test',()=>{
  const r=structuredClone(run);r.items[0].attempts[0].finish_reason='length';
  const a=assessRun(r,reference);assert.equal(a.guides[0].title,'성능 측정 결과 확인');
  assert.equal(a.guides[0].evidence,a.performance.reason);assert.match(a.guides[0].evidence,/출력 한도 도달: 영어 1건/);
  assert.match(a.guides[0].next,/비교 조건/);assert.doesNotMatch(a.guides[0].next,/새 시험|함께 실행|다시 실행/);
  const absent=assessRun({...run,items:quality},reference);
  assert.equal(absent.guides[0].title,'API 사용성 시험을 함께 실행하세요');assert.match(absent.guides[0].next,/새 시험/);
});
console.log(`${count} historical v3 frontier contracts passed; no inference executed.`);
