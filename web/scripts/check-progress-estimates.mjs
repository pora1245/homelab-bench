// Pure record calculations: no browser interactions, API calls, or model runs.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const load = async (entry) => {
  const built = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
};
const { estimateCompletion, estimateDuration } = await load('src/completionEstimate.ts');
const { assessRun, assessRunV4, EXPERIENCE_CASES } = await load('src/assessment.ts');
const concurrentFixture={id:'fixture-derived',status:'ready',aggregation:'concurrent-visible-decode-union',source_reference_id:'fixture',measurement_version:'client-visible-v1',concurrency:1,sample_count:1,decode_token_count:480,decode_active_ms:8000,decode_tps:60,ttft_median_ms:2000,minimum_visible_tokens:2,minimum_decode_span_ms:100};
const now = Date.parse('2026-11-07T00:00:00Z');
const iso = n => new Date(n).toISOString();
const pending = (id, status = 'pending') => ({ task: { id }, status, attempts: [] });
const done = (id, index, { wall = 10000, grade = 1000, speed = 60, tokens = 480, start = now - 600000 + index * 11000, score = 1 } = {}) => ({
  task: { id }, status: 'done', attempts: [{ started_at: iso(start), ended_at: iso(start + wall), error: null,
    finish_reason: 'stop', metrics: { wall_ms: wall, grading_ms: grade, output_tokens: tokens,
      visible_output_tokens: tokens, reasoning_tokens: 0, decode_tps: speed, decode_source: 'server',
      ttft_ms: 2000, ttft_source: 'client_visible_stream', client_visible_decode_tps: speed,
      measurement_version: 'client-visible-v1' }, score: { state: 'scored', value: score }, }],
});
const base = { status: 'running', config: { profile: 'full', concurrency: 1 },
  items: [...Array.from({ length: 30 }, (_, n) => done(`gsm8k:${n}`, n)), ...Array.from({ length: 10 }, (_, n) => pending(`gsm8k:${n + 30}`))] };
let count = 0;
const check = (name, fn) => { fn(); count++; console.log('PASS ' + name); };
check('wall already includes Decode; no double counting', () => {
  const e = estimateCompletion(base, now); assert.equal(e.remainingMs, 110000); assert.equal(e.state, 'estimating');
  assert.equal(e.finishAtMs, now + 110000); assert.equal(e.unseen, 0); assert.equal(e.confidence, 'medium');
});
check('no measurements means no invented 60 tok/s ETA', () => {
  const e = estimateCompletion({ ...base, items: [pending('math500:0')] }, now);
  assert.equal(e.remainingMs, null); assert.equal(e.state, 'insufficient');
});
check('unseen benchmark widens range and marks uncertain', () => {
  const a = estimateCompletion(base, now), b = estimateCompletion({ ...base, items: [...base.items.slice(0, 30), ...Array.from({ length: 10 }, (_, n) => pending(`mmlu-pro:${n}`))] }, now);
  assert.equal(b.unseen, 10); assert.equal(b.confidence, 'low'); assert.ok(b.upperMs > a.upperMs); assert.ok(b.lowerMs < a.lowerMs);
});
check('different remaining subject mix uses separate measured times', () => {
  const r = { ...base, items: [...base.items.slice(0, 30), ...Array.from({ length: 10 }, (_, n) => done(`math500:${n}`, n, { wall: 30000, tokens: 1680 })), ...Array.from({ length: 10 }, (_, n) => pending(`math500:${n + 10}`))] };
  assert.equal(estimateCompletion(r, now).remainingMs, 310000);
});
check('paused/resumed and stopped states do not slide the finish timestamp', () => {
  const p = estimateCompletion({ ...base, status: 'paused' }, now);
  assert.equal(p.state, 'paused'); assert.equal(p.finishAtMs, null); assert.equal(p.remainingMs, 110000);
  const c = estimateCompletion({ ...base, status: 'cancelled' }, now); assert.equal(c.state, 'stopped'); assert.equal(c.finishAtMs, null);
  const end = estimateCompletion({ ...base, status: 'completed' }, now); assert.equal(end.remainingMs, 0); assert.equal(end.state, 'completed'); assert.ok(end.finishAtMs < now);
});
check('measured concurrency instead of blindly dividing by requested workers', () => {
  const serial = estimateCompletion({ ...base, config: { concurrency: 4 } }, now); assert.equal(serial.effectiveConcurrency, 1);
  const parallel = { ...base, config: { concurrency: 4 }, items: [...Array.from({ length: 20 }, (_, n) => done(`gsm8k:${n}`, n, { start: now - 600000 + Math.floor(n / 2) * 11000 })), ...base.items.slice(30)] };
  const e = estimateCompletion(parallel, now); assert.equal(e.effectiveConcurrency, 2); assert.equal(e.remainingMs, 55000);
});
check('short visible interval excluded from Decode adjustment without dropping real wall time', () => {
  const r = structuredClone(base); r.items.slice(0, 30).forEach(i => Object.assign(i.attempts[0].metrics, { decode_source: 'client_estimate', decode_tps: 84707, client_visible_decode_tps: 84707, visible_output_tokens: 8, output_tokens: 5000, reasoning_tokens: 4992 }));
  assert.equal(estimateCompletion(r, now).remainingMs, 110000);
});
check('record is not mutated', () => { const before = JSON.stringify(base); estimateCompletion(base, now); assessRun(base); assert.equal(JSON.stringify(base), before); });
check('partial observed score is a point while final bounds remain untouched', () => {
  const a = assessRun(base); assert.equal(a.intelligence.value, null); assert.equal(a.currentScores.intelligence.value, 100);
  assert.equal(a.currentScores.intelligence.state, 'partial'); assert.equal(a.currentScores.evaluatedDomains.length, 1); assert.ok(a.currentScores.performance.value > 0);
  assert.equal(a.currentScores.performance.state, 'provisional');
});
check('unequal number of sampled questions cannot overpower benchmark weights', () => {
  const r = { ...base, items: [...Array.from({ length: 50 }, (_, n) => done(`gsm8k:${n}`, n)), ...Array.from({ length: 5 }, (_, n) => done(`mmlu-pro:${n}`, n, { score: 0 }))] };
  assert.equal(assessRun(r).currentScores.intelligence.value, 33.3);
  assert.deepEqual(assessRun(r).currentScores.evaluatedDomains, ['수학', '지식·추론']);
});
check('grading failure stays unknown, never substitutes for wrong', () => {
  const r = structuredClone(base); r.items.slice(0, 30).forEach(i => i.attempts[0].score = { state: 'unavailable', value: null });
  assert.equal(assessRun(r).currentScores.intelligence.value, null);
});
check('overdue active request still has remaining time', () => {
  const r = { ...base, items: [...base.items.slice(0, 30), { ...pending('gsm8k:30', 'running'), attempts: [{ started_at: iso(now - 100000) }] }] };
  const e = estimateCompletion(r, now); assert.ok(e.remainingMs > 0); assert.ok(e.upperMs >= e.remainingMs);
});
check('all three scores displayed during an incomplete exam if performance is valid', () => {
  const hash = 'a'.repeat(64), ref = { status: 'ready', id: 'fixture', protocol: 'api-experience-v1', model: 'fixture', reasoning_effort: 'low', measured_at: iso(now), run_id: 'fixture', suite_hash: 'fixture', cases: Object.fromEntries(EXPERIENCE_CASES.map(c => [c, { ttft_ms: 2000, decode_tps: 60, prompt_sha256: hash }])) };
  ref.concurrent_baseline=concurrentFixture;
  const a = assessRun(base, ref);
  assert.equal(a.currentScores.performance.value, 1000); assert.equal(a.currentScores.overall.value, 100); assert.equal(a.currentScores.overall.state, 'partial'); assert.equal(a.overall.value, null);
});
check('duration labels remain finite', () => { assert.equal(estimateDuration(null), '—'); assert.equal(estimateDuration(0), '0분'); assert.equal(estimateDuration(3660000), '1시간 1분'); });
check('concurrency changes discard earlier timing regime', () => {
  const r = structuredClone(base); r.config.concurrency = 4;
  r.execution_segments = [{ started_at: iso(now - 700000), concurrency: 1 }, { started_at: iso(now - 100000), concurrency: 4 }];
  let e = estimateCompletion(r, now); assert.equal(e.state, 'insufficient'); assert.equal(e.samples, 0);
  for(let n=0;n<8;n++) { const i=done(`gsm8k:new${n}`,n,{wall:20000,tokens:1080,start:now-100000+Math.floor(n/4)*21000});i.attempts[0].metrics.request_concurrency=4;r.items.push(i); }
  e=estimateCompletion(r,now);assert.equal(e.samples,8);assert.equal(e.effectiveConcurrency,4);assert.equal(e.remainingMs,52500);
});
check('historical v4: ordinary c4 measurements score while legacy serial experience is ignored', () => {
  const hash='a'.repeat(64), ref={status:'ready',id:'fixture',protocol:'api-experience-v1',model:'fixture',reasoning_effort:'low',measured_at:iso(now),run_id:'fixture',suite_hash:'fixture',cases:Object.fromEntries(EXPERIENCE_CASES.map(c=>[c,{ttft_ms:2000,decode_tps:60,prompt_sha256:hash}]))};
  ref.concurrent_baseline=concurrentFixture;
  const perf=EXPERIENCE_CASES.flatMap(c=>[1,2,3].map(n=>{const i=done(`experience:${c}:${n}`,n);i.task.meta={performance_protocol:'api-experience-v1',prompt_sha256:hash};i.attempts[0].score={state:'measured',scorer_version:'api-experience-output-v2',extra:{valid_output:true}};i.attempts[0].metrics.request_concurrency=1;return i;}));
  const r={...base,config:{...base.config,concurrency:4},items:[...base.items,...perf]};
  assert.equal(assessRunV4(r,ref).performance.value,1000);assert.equal(assessRunV4(r,ref).performanceEvidence.concurrency,4);
  delete perf[0].attempts[0].metrics.request_concurrency;assert.equal(assessRunV4(r,ref).performance.value,1000);
});
check('historical v4: pending or completed fixed performance never gates ordinary c4 scores', () => {
  const hash='a'.repeat(64),ref={status:'ready',id:'fixture',protocol:'api-experience-v1',model:'fixture',reasoning_effort:'low',measured_at:iso(now),run_id:'fixture',suite_hash:'fixture',cases:Object.fromEntries(EXPERIENCE_CASES.map(c=>[c,{ttft_ms:2000,decode_tps:60,prompt_sha256:hash}]))};
  ref.concurrent_baseline=concurrentFixture;
  const perf=EXPERIENCE_CASES.flatMap(c=>[1,2,3].map(n=>({...pending(`experience:${c}:${n}`),task:{id:`experience:${c}:${n}`,meta:{performance_protocol:'api-experience-v1',prompt_sha256:hash}}})));
  const r={...base,config:{...base.config,concurrency:4},items:[...base.items,...perf]};
  let a=assessRunV4(r,ref);assert.equal(a.performance.value,1000);assert.equal(a.performanceEvidence.pairedCount,30);
  perf.forEach((item,n)=>{Object.assign(item,done(item.task.id,n));item.task.meta={performance_protocol:'api-experience-v1',prompt_sha256:hash};item.attempts[0].score={state:'measured',scorer_version:'api-experience-output-v2',extra:{valid_output:true}};});
  a=assessRunV4(r,ref);assert.equal(a.performance.value,1000);assert.equal(a.performanceEvidence.pairedCount,30);
});
console.log(`${count} progress contracts passed; no inference executed.`);
