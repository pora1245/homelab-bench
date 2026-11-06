// Pure scheduling estimates from synthetic records; no model or UI calls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const built = await build({ entryPoints: ['src/completionEstimate.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false });
const { estimateCompletion } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const now = Date.parse('2026-11-07T00:00:00Z');
const iso = value => new Date(value).toISOString();
const pending = id => ({ task: { id }, status: 'pending', attempts: [] });
const attempt = (start, concurrency, wall = 10000, grading = 1000) => ({
  started_at: iso(start), ended_at: iso(start + wall), finish_reason: 'stop', error: null,
  metrics: { wall_ms: wall, grading_ms: grading, request_concurrency: concurrency },
  score: { state: 'scored', value: 1 },
});
const fixture = ({ configured = 2, observed = configured, batchOverhead = 0 } = {}) => {
  const sample_ids = Array.from({ length: 8 }, (_, index) => `gsm8k:${index}`);
  const samples = sample_ids.map((task_id, index) => ({ task_id,
    attempt: attempt(now - 600000 + Math.floor(index / observed) * 11000, configured) }));
  return { status: 'running', config: { concurrency: configured, auto_concurrency: true },
    execution_segments: [{ started_at: iso(now - 300000), concurrency: configured, reason: 'auto_tuned' }],
    items: sample_ids.map(pending), concurrency_tuning: {
      version: 'auto-concurrency-v1', status: 'completed', selected_concurrency: configured, selected_round_index: 0,
      max_concurrency: 8, sample_ids, budget_ms: 600000, elapsed_ms: 240000,
      // These diagnostics are not an additional multiplier for observed timing.
      throughput_gain: 5, completion_gain: 5,
      rounds: [{ concurrency: configured, status: 'completed',
        elapsed_ms: Math.ceil(samples.length / observed) * 11000 + batchOverhead, samples }],
    },
  };
};
let count = 0;
const check = (name, body) => { body(); count++; console.log('PASS ' + name); };
const addMain = (run, { count = 8, observed = run.config.concurrency, wall = 10000, grade = 1000 } = {}) => {
  for (let index = 0; index < count; index++) run.items.push({ task: { id: `gsm8k:main${index}` },
    status: 'done', attempts: [attempt(now - 200000 + Math.floor(index / observed) * (wall + grade), run.config.concurrency, wall, grade)] });
};

check('calibration stages withhold a main-exam finish time', () => {
  for (const status of ['baseline', 'testing']) {
    const run = fixture(); run.concurrency_tuning.status = status;
    const estimate = estimateCompletion(run, now);
    assert.equal(estimate.state, 'insufficient'); assert.equal(estimate.remainingMs, null);
    assert.equal(estimate.finishAtMs, null); assert.equal(estimate.samples, 0);
    assert.match(estimate.reason, status === 'baseline' ? /단일/ : /동시 2개/);
  }
});
check('paused calibration has no moving finish time', () => {
  const run = fixture(); run.status = 'paused'; run.concurrency_tuning.status = 'testing';
  const estimate = estimateCompletion(run, now);
  assert.equal(estimate.state, 'paused'); assert.equal(estimate.finishAtMs, null);
  assert.match(estimate.reason, /일시정지/);
});
check('short completed comparison samples cannot bias the full exam ETA', () => {
  const estimate = estimateCompletion(fixture(), now);
  assert.equal(estimate.state, 'insufficient'); assert.equal(estimate.remainingMs, null);
  assert.equal(estimate.effectiveConcurrency, 1); assert.equal(estimate.samples, 0);
  assert.equal(estimate.remaining, 8); assert.equal(estimate.confidence, 'low');
});
check('configured eight never implies eight-fold measured parallelism', () => {
  const run = fixture({ configured: 8, observed: 1 }); addMain(run, { observed: 1 });
  const estimate = estimateCompletion(run, now);
  assert.equal(estimate.effectiveConcurrency, 1); assert.equal(estimate.remainingMs, 88000);
});
check('main wall and grading time are divided by measured concurrency only once', () => {
  const run = fixture({ batchOverhead: 6000 }); addMain(run);
  const estimate = estimateCompletion(run, now);
  assert.equal(estimate.remainingMs, 44000);
  // Completed tuning time is already in the run's elapsed time, not remaining work.
  assert.equal(estimate.finishAtMs, now + 44000);
});
check('single request selection uses actual main response and grading times', () => {
  const run = fixture({ configured: 1 }); addMain(run);
  const estimate = estimateCompletion(run, now);
  assert.equal(estimate.remainingMs, 88000); assert.equal(estimate.effectiveConcurrency, 1);
});
check('incomplete and invalid probe records cannot manufacture an ETA', () => {
  const changes = [
    run => { run.concurrency_tuning.rounds[0].samples.pop(); },
    run => { run.concurrency_tuning.status = 'unavailable'; },
    run => { run.concurrency_tuning.selected_concurrency = 4; },
    run => { run.concurrency_tuning.rounds[0].samples[0].attempt.finish_reason = 'length'; },
    run => { run.concurrency_tuning.rounds[0].samples[0].attempt.error = 'fixture failure'; },
    run => { run.concurrency_tuning.rounds[0].samples[0].attempt.metrics.request_concurrency = 1; },
    run => { run.concurrency_tuning.rounds[0].samples[0].task_id = 'gsm8k:1'; },
    run => { run.concurrency_tuning.rounds[0].elapsed_ms = 0; },
    run => { run.concurrency_tuning.sample_ids[0] = 'gsm8k:missing'; },
    run => { delete run.concurrency_tuning.selected_round_index; },
    run => { run.concurrency_tuning.selected_round_index = 4; },
  ];
  for (const change of changes) {
    const run = fixture(); change(run);
    const estimate = estimateCompletion(run, now);
    assert.equal(estimate.state, 'insufficient'); assert.equal(estimate.remainingMs, null);
  }
});
check('changing the selected confirmation round cannot change the full exam ETA', () => {
  const run = fixture({ configured: 1 });
  const confirmation = structuredClone(run.concurrency_tuning.rounds[0]);
  confirmation.elapsed_ms *= 2;
  run.concurrency_tuning.rounds.push(confirmation);
  assert.equal(estimateCompletion(run, now).remainingMs, null);
  run.concurrency_tuning.selected_round_index = 1;
  assert.equal(estimateCompletion(run, now).remainingMs, null);
});
check('main observations begin estimating only at the fifth response', () => {
  const run = fixture({ configured: 1 });
  addMain(run, { count: 4, wall: 2000, grade: 500 });
  assert.equal(estimateCompletion(run, now).state, 'insufficient');
  run.items.push({ task: { id: 'gsm8k:main4' }, status: 'done', attempts: [attempt(now - 190000, 1, 2000, 500)] });
  const estimate = estimateCompletion(run, now);
  assert.equal(estimate.samples, 5); assert.equal(estimate.remainingMs, 20000);
  assert.doesNotMatch(estimate.basis, /자동 선택/);
});
check('a later concurrency change cannot reuse an old selected round', () => {
  const run = fixture(); run.config.concurrency = 4;
  run.execution_segments.push({ started_at: iso(now - 100000), concurrency: 4 });
  const estimate = estimateCompletion(run, now);
  assert.equal(estimate.state, 'insufficient'); assert.equal(estimate.remainingMs, null);
});
check('old single-request rows cannot masquerade as the new main regime', () => {
  const run = fixture();
  for (let index = 0; index < 5; index++) run.items.push({ task: { id: `gsm8k:old${index}` },
    status: 'done', attempts: [attempt(now - 900000 + index * 2500, 1, 2000, 500)] });
  const estimate = estimateCompletion(run, now);
  assert.equal(estimate.remainingMs, null); assert.equal(estimate.samples, 0);
});
check('terminal run status takes precedence over stale calibration state', () => {
  for (const [status, expected] of [['completed', 'completed'], ['cancelled', 'stopped'], ['failed', 'stopped']]) {
    const run = fixture(); run.status = status; run.concurrency_tuning.status = 'testing';
    const estimate = estimateCompletion(run, now); assert.equal(estimate.state, expected);
    assert.equal(estimate.remainingMs, expected === 'completed' ? 0 : null);
  }
});
check('manual mode does not remain stuck on an interrupted automatic probe', () => {
  for (const automatic of [false, undefined]) {
    const run = fixture({ configured: 1 }); run.config.auto_concurrency = automatic;
    run.concurrency_tuning.status = 'testing';
    for (let index = 0; index < 5; index++) run.items.push({ task: { id: `gsm8k:main${index}` },
      status: 'done', attempts: [attempt(now - 200000 + index * 2500, 1, 2000, 500)] });
    const estimate = estimateCompletion(run, now);
    assert.equal(estimate.state, 'estimating'); assert.equal(estimate.remainingMs, 20000);
  }
});
check('an omitted false field cannot reuse a saved calibration seed', () => {
  const run = fixture(); delete run.config.auto_concurrency;
  assert.equal(estimateCompletion(run, now).state, 'insufficient');
});
check('a 60 to 200 token rate changes generation only, with fixed overhead retained', () => {
  const totalTokens = 60 * 8 * 3600;
  assert.equal(totalTokens / 200 / 3600, 2.4);
  const tokens = totalTokens / 10, wall = tokens / 200 * 1000 + 120000;
  const observations = Array.from({ length: 5 }, (_, index) => {
    const sample = attempt(now - 40000000 + index * 1000000, 1, wall, 0);
    Object.assign(sample.metrics, { output_tokens: tokens, decode_tps: 200, decode_source: 'server' });
    return { task: { id: `gsm8k:done${index}` }, status: 'done', attempts: [sample] };
  });
  const run = { status: 'running', config: { concurrency: 1 },
    items: [...observations, ...Array.from({ length: 10 }, (_, index) => pending(`gsm8k:remaining${index}`))] };
  const estimate = estimateCompletion(run, now);
  assert.equal(estimate.remainingMs, 9840000); // 2h24m generation + 20m observed overhead.
  assert.ok(estimate.remainingMs > 2.4 * 3600000);
});
check('estimation leaves saved answers and scheduler metadata unchanged', () => {
  const run = fixture(); const before = JSON.stringify(run);
  estimateCompletion(run, now); assert.equal(JSON.stringify(run), before);
});

// Optional backend-produced compact fixture; only synthetic loopback records.
if (process.argv[2]) check('actual backend compact record waits for five main responses', () => {
  const saved = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  assert.equal(saved.concurrency_tuning.version, 'auto-concurrency-v1');
  assert.equal(saved.concurrency_tuning.status, 'completed');
  const referenceNow = Math.max(Date.now(), ...saved.items.flatMap(item => item.attempts.map(a => Date.parse(a.ended_at)).filter(Number.isFinite))) + 1000;
  for (const mainCount of [0, 4, 5]) {
    const run = structuredClone(saved); run.status = 'running';
    run.items.forEach((item, index) => { if (index >= mainCount) { item.status = 'pending'; item.attempts = []; } });
    const estimate = estimateCompletion(run, referenceNow);
    assert.equal(estimate.samples, mainCount);
    assert.equal(estimate.state, mainCount < 5 ? 'insufficient' : 'estimating');
    if (mainCount < 5) assert.equal(estimate.finishAtMs, null);
    else assert.ok(estimate.remainingMs > 0 && Number.isFinite(estimate.remainingMs));
  }
});

console.log(`${count} auto ETA contracts passed; no inference executed.`);
