// V4 calculations only: no API requests, browser interactions, or inference.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
const built=await build({entryPoints:['src/assessment.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {assessRunV4:assessRun,assessRunV3,assessLivePerformance,frontierBaseline,EXPERIENCE_CASES,BENCH_SCORE_POLICY_V1,CONCURRENT_FRONTIER_REFERENCE}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const hash='a'.repeat(64), at='2026-11-07T01:00:00Z';
const ref={status:'ready',id:'fixture-reference',protocol:'api-experience-v1',model:'fixture-sol',reasoning_effort:'low',measured_at:at,run_id:'reference',suite_hash:'reference-suite',cases:Object.fromEntries(EXPERIENCE_CASES.map(c=>[c,{decode_tps:100,ttft_ms:2000,prompt_sha256:hash}])),concurrent_baseline:{id:'fixture-derived',status:'ready',aggregation:'concurrent-visible-decode-union',source_reference_id:'fixture-reference',measurement_version:'client-visible-v1',concurrency:1,sample_count:1,decode_token_count:2000,decode_active_ms:20000,decode_tps:100,ttft_median_ms:2000,minimum_visible_tokens:2,minimum_decode_span_ms:100}};
function item(id='gsm8k:0', {speed=100,ttft=2000,c=8,start=at,state='done',answer=1}={}) {
  return {task:{id,scorer:'numeric'},status:state,attempts:[{started_at:start,ended_at:new Date(Date.parse(start)+120000).toISOString(),error:null,finish_reason:'stop',
    metrics:{request_concurrency:c,wall_ms:120000,output_tokens:3000,reasoning_tokens:1000,visible_output_tokens:2000,visible_stream_chunks:40,visible_decode_span_ms:2000/speed*1000,ttft_ms:ttft,ttft_source:'client_visible_stream',client_visible_decode_tps:speed,decode_tps:99999,decode_source:'server',measurement_version:'client-visible-v1'},
    score:{state:'scored',value:answer}}]};
}
const run={status:'running',config:{profile:'quick',concurrency:8},items:[item()]};
let count=0;const check=(name,fn)=>{fn();count++;console.log('PASS '+name)};
check('one ordinary answer immediately produces a provisional score without fixed prompts',()=>{
  const a=assessRun(run,ref);assert.equal(a.policy,'bench-live-api-v4.1');assert.equal(a.performance.value,1000);assert.equal(a.performance.state,'provisional');assert.equal(a.performanceEvidence.pairedCount,1);assert.equal(a.performanceEvidence.requiredCount,1);assert.equal(a.performanceEvidence.concurrency,8);assert.ok(a.currentScores.overall.value>0);assert.deepEqual(a.experienceCases,[]);
});
check('aggregate-only Sol reference reproduces 1000 and original reference stays unchanged',()=>{
  const original=readFileSync('src/frontier-reference.json','utf8'),derived=JSON.parse(readFileSync('src/frontier-concurrent-reference.json','utf8'));
  assert.equal(derived.samples,undefined);assert.equal(derived.sample_count,12);
  const baseline=frontierBaseline();assert.ok(Math.abs(baseline.decode-57.75201039058354)<1e-9);assert.equal(baseline.ttft,2879.7764585);
  const i=item('gsm8k:synthetic-baseline',{c:1,speed:baseline.decode,ttft:baseline.ttft});
  Object.assign(i.attempts[0].metrics,{wall_ms:200000,output_tokens:derived.decode_token_count,reasoning_tokens:0,visible_output_tokens:derived.decode_token_count,visible_decode_span_ms:derived.decode_active_ms});
  i.attempts[0].ended_at=new Date(Date.parse(at)+200000).toISOString();
  const r={status:'completed',config:{profile:'quick',concurrency:1},items:[i]},before=JSON.stringify(r),a=assessRun(r);
  assert.equal(a.performance.value,1000);assert.equal(a.performanceEvidence.decodeTokenCount,9391);assert.ok(Math.abs(a.performanceEvidence.effectiveDecodeConcurrency-1)<1e-7);
  assert.equal(JSON.stringify(r),before);assert.equal(readFileSync('src/frontier-reference.json','utf8'),original);assert.equal(derived.source_reference_id,CONCURRENT_FRONTIER_REFERENCE.id);
});
check('Decode and reciprocal TTFT have equal log weight; no concurrency multiplier',()=>{
  const r={...run,items:[item('gsm8k:0',{speed:400})]};assert.equal(assessRun(r,ref).performance.value,2000);
  assert.equal(assessRun({...run,config:{concurrency:1},items:[item('gsm8k:0',{c:1,speed:400})]},ref).performance.value,2000);
  assert.equal(assessRun({...run,items:[item('gsm8k:0',{ttft:8000})]},ref).performance.value,500);
});
check('ordinary response correctness and grading failure do not change timing score',()=>{
  const r=structuredClone(run);r.items[0].attempts[0].score={state:'unavailable',value:null};
  assert.equal(assessRun(r,ref).performance.value,1000);assert.equal(assessRun(r,ref).currentScores.intelligence.value,null);
  r.items[0].status='grading';assert.equal(assessRun(r,ref).performance.value,1000);
});
check('fixed performance outcomes, pending slots and warmup never gate or bias v4',()=>{
  const r=structuredClone(run);
  r.items.push(item('experience:korean:1',{speed:1}),item('custom:warmup',{speed:1}),{task:{id:'experience:english:2'},status:'pending',attempts:[]});
  r.items[1].attempts[0].finish_reason='length';r.items[2].task.meta={warmup:true};
  assert.equal(assessRun(r,ref).performance.value,1000);assert.equal(assessRun(r,ref).performanceEvidence.pairedCount,1);
  assert.equal(assessRun({...r,items:r.items.slice(1)},ref).performance.value,null);
});
check('latest concurrency segment excludes old c1 and filters actual request concurrency',()=>{
  const r={...run,execution_segments:[{started_at:'2026-11-07T00:00:00Z',concurrency:1},{started_at:at,concurrency:8}],items:[item('gsm8k:old',{c:1,speed:400,start:'2026-11-07T00:01:00Z'}),item('gsm8k:wrong-c',{c:1,speed:400}),item('gsm8k:new')]};
  const a=assessRun(r,ref);assert.equal(a.performance.value,1000);assert.equal(a.performanceEvidence.pairedCount,1);assert.equal(a.performanceEvidence.segmentStartedAt,at);
  r.items.pop();assert.equal(assessRun(r,ref).performance.value,null);
});
check('missing concurrency metadata follows persisted segments then old config',()=>{
  const r=structuredClone(run);delete r.items[0].attempts[0].metrics.request_concurrency;
  assert.equal(assessRun(r,ref).performance.value,1000);r.execution_segments=[{started_at:at,concurrency:8}];assert.equal(assessRun(r,ref).performance.value,1000);
});
check('client visible definition is mandatory and server or total decoding is never substituted',()=>{
  for(const change of [m=>delete m.client_visible_decode_tps,m=>m.measurement_version='legacy',m=>m.ttft_source='client_stream']){
    const r=structuredClone(run);change(r.items[0].attempts[0].metrics);assert.equal(assessRun(r,ref).performance.value,null);
  }
});
check('counter mismatch, short interval and impossible TTFT are excluded without editing raw',()=>{
  for(const change of [m=>m.visible_output_tokens=3000,m=>m.visible_decode_span_ms=50,m=>m.ttft_ms=120500]){
    const r=structuredClone(run);change(r.items[0].attempts[0].metrics);const before=JSON.stringify(r),a=assessRun(r,ref);assert.equal(a.performance.value,null);assert.equal(a.performanceEvidence.excludedCount,1);assert.equal(JSON.stringify(r),before);
  }
});
check('backend metric quality rejection takes precedence over a plausible displayed rate',()=>{
  const r=structuredClone(run);r.items[0].attempts[0].metric_quality={version:'metric-integrity-v1',valid:{ttft_ms:true,client_visible_decode_tps:false},excluded:{client_visible_decode_tps:'inconsistent_token_counts'}};
  assert.equal(assessRun(r,ref).performance.value,null);
});
check('response failures and truncation are excluded, not scored as zero',()=>{
  for(const change of [a=>a.error='fixture',a=>a.finish_reason='length',a=>a.ended_at=null,a=>a.started_at='bad']){
    const r=structuredClone(run);change(r.items[0].attempts[0]);assert.equal(assessRun(r,ref).performance.value,null);
  }
});
check('genuine slow decoding remains in active time instead of statistical trimming',()=>{
  const r={...run,items:[item('gsm8k:0'),item('gsm8k:1'),item('gsm8k:2',{speed:20})]};
  const a=assessRun(r,ref);assert.equal(a.performance.value,774.6);assert.equal(a.performanceEvidence.pairedCount,3);assert.equal(a.performanceEvidence.concurrentDecodeTps,60);
});
check('completed exams finalize performance while running and stopped exams keep their state',()=>{
  assert.equal(assessRun({...run,status:'completed'},ref).performance.state,'complete');
  assert.equal(assessRun({...run,status:'paused'},ref).performance.state,'provisional');
  assert.equal(assessRun({...run,status:'cancelled'},ref).performance.state,'partial');
  const r={...run,status:'completed',items:[...run.items,{task:{id:'gsm8k:pending'},status:'pending',attempts:[]}]};assert.equal(assessRun(r,ref).performance.state,'provisional');
});
check('performance remains uncapped; full quality and overall remain capped at 100',()=>{
  let serial=0;const quality=BENCH_SCORE_POLICY_V1.benchmarks.flatMap(b=>Array.from({length:b.quick},(_,n)=>item(`${b.id}:${n}`,{speed:400,ttft:500,start:new Date(Date.parse(at)+serial++*120000).toISOString()})));
  const a=assessRun({...run,status:'completed',items:quality},ref);assert.equal(a.performance.value,4000);assert.equal(a.intelligence.value,100);assert.equal(a.overall.value,100);
});
check('empty or missing reference evidence never invents a score or requests a separate test',()=>{
  const a=assessRun({...run,items:[]},ref);assert.equal(a.performance.value,null);assert.equal(a.overall.value,null);assert.match(a.guides[0].next,/진행 중인 시험/);assert.doesNotMatch(a.guides[0].next,/새 시험|성능팩|12건/);
  assert.equal(assessRun(run,{...ref,status:'pending'}).performance.value,null);
});
check('v3 reproduction stays available but does not control current scoring',()=>{
  assert.equal(assessRunV3(run,ref).performance.value,null);assert.equal(assessRun(run,ref).performance.value,1000);
});
check('a numeric v4 score does not claim complete comparison metadata',()=>{
  const a=assessRun(run,ref);assert.equal(a.performance.value,1000);assert.equal(a.comparison.complete,false);
  assert.ok(a.comparison.details.some(s=>s.includes('확인 불가')));
});
check('comparison fingerprints retain conditions and identify model, scope, reference and sample changes',()=>{
  const base={...run,config:{...run.config,model:'fixture-a',pack_id:'fixture-pack'}};
  const key=assessRun(base,ref).comparison.key;
  for(const change of [r=>r.config.model='fixture-b',r=>r.config.pack_id='other-pack',r=>{r.config.concurrency=4;r.items[0].attempts[0].metrics.request_concurrency=4},r=>r.execution_segments=[{started_at:at,concurrency:8}],r=>r.items[0].task.id='gsm8k:other']){
    const r=structuredClone(base);change(r);assert.notEqual(assessRun(r,ref).comparison.key,key);
  }
  const changedRef=structuredClone(ref);changedRef.concurrent_baseline.decode_tps*=2;changedRef.concurrent_baseline.decode_active_ms/=2;assert.notEqual(assessRun(base,changedRef).comparison.key,key);
});
check('two overlapping decoders double Decode; configured concurrency alone does not',()=>{
  const r={...run,config:{...run.config,concurrency:2},items:[item('gsm8k:a',{c:2}),item('gsm8k:b',{c:2})]};
  const a=assessRun(r,ref);assert.equal(a.performanceEvidence.concurrentDecodeTps,200);assert.equal(a.performanceEvidence.effectiveDecodeConcurrency,2);assert.equal(a.performance.value,1414.2);
  r.config.concurrency=8;for(const i of r.items)i.attempts[0].metrics.request_concurrency=8;assert.equal(assessRun(r,ref).performance.value,1414.2);
  r.items[1].attempts[0].started_at=new Date(Date.parse(at)+120000).toISOString();r.items[1].attempts[0].ended_at=new Date(Date.parse(at)+240000).toISOString();
  const serial=assessRun(r,ref);assert.equal(serial.performanceEvidence.concurrentDecodeTps,100);assert.equal(serial.performanceEvidence.effectiveDecodeConcurrency,1);assert.equal(serial.performance.value,1000);
});
check('real TTFT under concurrency is retained without division by configured c',()=>{
  const a=assessRun({...run,items:[item('gsm8k:a',{ttft:8000}),item('gsm8k:b',{ttft:8000})]},ref);
  assert.equal(a.performanceEvidence.ttftMedian,8000);assert.equal(a.performanceEvidence.concurrentDecodeTps,200);assert.equal(a.performance.value,707.1);
});
check('clock jumps, combined interval overflow and inconsistent rate fail without changing raw',()=>{
  for(const change of [a=>a.ended_at=new Date(Date.parse(a.ended_at)+10000).toISOString(),a=>a.metrics.ttft_ms=110000,a=>a.metrics.visible_decode_span_ms=21000,a=>{a.metrics.visible_output_tokens=1;a.metrics.output_tokens=1001}]){
    const r=structuredClone(run);change(r.items[0].attempts[0]);const before=JSON.stringify(r);assert.equal(assessRun(r,ref).performance.value,null);assert.equal(JSON.stringify(r),before);
  }
});
check('overlap exceeding recorded concurrency is unavailable, not an inflated score',()=>{
  const a=assessRun({...run,config:{concurrency:1},items:[item('gsm8k:a',{c:1}),item('gsm8k:b',{c:1})]},ref);
  assert.equal(a.performance.value,null);assert.equal(a.performanceEvidence.aggregateIssue,'concurrency_overlap');assert.equal(a.performanceEvidence.concurrentDecodeTps,null);
});
check('pause/resume at unchanged concurrency retains samples and excludes pause gaps',()=>{
  const r={...run,execution_segments:[{started_at:at,concurrency:8}],items:[item('gsm8k:a'),item('gsm8k:b',{start:new Date(Date.parse(at)+3600000).toISOString()})]};
  const paused=assessRun({...r,status:'paused'},ref),resumed=assessRun({...r,status:'running'},ref);
  assert.equal(paused.performance.value,1000);assert.equal(resumed.performance.value,1000);assert.equal(resumed.performanceEvidence.pairedCount,2);assert.equal(resumed.performanceEvidence.decodeActiveMs,40000);
});
check('missing or mismatched derived baseline cannot substitute old case medians',()=>{
  const old=structuredClone(ref);delete old.concurrent_baseline;assert.equal(assessRun(run,old).performance.value,null);
  const wrong=structuredClone(ref);wrong.concurrent_baseline.source_reference_id='other';assert.equal(assessRun(run,wrong).performance.value,null);
});
console.log(`${count} live performance v4.1 contracts passed; no inference executed.`);
