// Pure scoring-policy checks. These create no runs, make no API requests, and
// are not model benchmark results or browser/device interaction tests.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const source = fileURLToPath(new URL("../src/assessment.ts", import.meta.url));
const output = await build({
  entryPoints: [source],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`;
const { assessRunV2, assessRunV1: assessRun, responseExperienceScore, BENCH_SCORE_POLICY_V1, BENCH_SCORE_POLICY_V2, performanceScoreV2, combineScoresV2, comparisonFor } =
  await import(moduleUrl);

const timing = { decode_tps: 100, ttft_ms: 200, decode_source: "provider" };
const item = (id, value = 1, metrics = timing) => ({
  task: { id },
  status: "done",
  attempts: [
    {
      ended_at: "2026-11-06T00:00:00Z",
      error: null,
      score: { state: "scored", value },
      metrics,
    },
  ],
});
const record = (items, profile = "quick", concurrency = 1) => ({
  status: "completed",
  config: { profile, concurrency },
  items,
});
const allQuick = BENCH_SCORE_POLICY_V1.benchmarks.flatMap((b) =>
  Array.from({ length: b.quick }, (_, index) => item(`${b.id}:${index}`)),
);
const allFull = BENCH_SCORE_POLICY_V1.benchmarks.flatMap((b) =>
  Array.from({ length: b.full }, (_, index) => item(`${b.id}:${index}`)),
);
let passed = 0;
function check(name, validate) {
  validate();
  passed++;
  console.log(`PASS ${name}`);
}
check("empty record leaves every score uncalculated", () => {
  const a = assessRun(record([]));
  assert.deepEqual(
    [a.intelligence.value, a.performance.value, a.overall.value],
    [null, null, null],
  );
});
check("one perfect benchmark does not substitute for missing domains", () => {
  const a = assessRun(
    record(Array.from({ length: 50 }, (_, i) => item(`gsm8k:${i}`))),
  );
  assert.deepEqual(
    [
      a.intelligence.lower,
      a.intelligence.upper,
      a.intelligence.coverage,
      a.intelligence.measuredOnly,
    ],
    [12.5, 100, 12.5, 100],
  );
  assert.equal(a.overall.value, null);
});
check("all quick components produce a provisional point", () => {
  const a = assessRun(record(allQuick));
  assert.deepEqual(
    [a.intelligence.value, a.intelligence.state, a.overall.value],
    [100, "provisional", 100],
  );
});
check("actual wrong answers count as zero", () => {
  const a = assessRun(record(allQuick.map((i) => item(i.task.id, 0))));
  assert.equal(a.intelligence.value, 0);
});
check("scorer unavailable is missing, not wrong", () => {
  const items = allQuick.map((i) => ({
    ...i,
    attempts: [
      { ...i.attempts[0], score: { state: "unavailable", value: null } },
    ],
  }));
  const a = assessRun(record(items));
  assert.equal(a.intelligence.value, null);
  assert.equal(a.intelligence.coverage, 0);
});
check("concurrent requests have no c1 experience score", () => {
  const a = assessRun(record(allQuick, "quick", 4));
  assert.deepEqual([a.performance.value, a.overall.value], [null, null]);
});
check("missing TTFT is not replaced by zero", () => {
  const a = assessRun(
    record(
      allQuick.map((i) => item(i.task.id, 1, { ...timing, ttft_ms: null })),
    ),
  );
  assert.equal(a.performance.value, null);
});
check("reference diagnostics do not affect intelligence", () => {
  const a = assessRun(
    record([
      ...allQuick,
      ...Array.from({ length: 16 }, (_, i) => item(`ko-core:${i}`, 0)),
    ]),
  );
  assert.deepEqual([a.intelligence.value, a.referenceItems], [100, 16]);
});
check("custom math scorer is not a public MATH-500 component", () => {
  const custom = Array.from({ length: 50 }, (_, i) => ({
    ...item(`custom:${i}`),
    task: { id: `custom:${i}`, scorer: "math" },
  }));
  const a = assessRun(record(custom));
  assert.equal(a.intelligence.value, null);
  assert.equal(a.intelligence.coverage, 0);
  assert.equal(a.unrecognizedItems, 50);
});
check("fewer than ten paired timings is insufficient", () => {
  assert.equal(assessRun(record(allQuick.slice(0, 9))).performance.value, null);
});
check("timing pairs exclude failed and unfinished attempts", () => {
  const items = allQuick.slice(0, 10);
  items[0] = {
    ...items[0],
    attempts: [{ ...items[0].attempts[0], error: "fixture" }],
  };
  items[1] = {
    ...items[1],
    status: "running",
    attempts: [{ ...items[1].attempts[0], ended_at: null }],
  };
  assert.equal(assessRun(record(items)).performanceEvidence.pairedCount, 8);
});
check("full suite can complete", () => {
  const a = assessRun(record(allFull, "full"));
  assert.deepEqual(
    [a.intelligence.value, a.intelligence.state, a.intelligence.coverage],
    [100, "complete", 100],
  );
});
check("one missing full-suite item stays a nonzero-width interval", () => {
  const a = assessRun(
    record(
      allFull.filter((i) => i.task.id !== "mmlu-pro:0"),
      "full",
    ),
  );
  assert.equal(a.intelligence.value, null);
  assert.ok(a.intelligence.coverage < 100);
  assert.ok(a.intelligence.upper > a.intelligence.lower);
});
check("duplicates cannot inflate coverage", () => {
  const a = assessRun(record([...allQuick, ...allQuick]));
  assert.equal(a.intelligence.coverage, 100);
  assert.equal(a.duplicateItems, allQuick.length);
});
check("speed anchors and invalid values remain bounded", () => {
  assert.equal(responseExperienceScore(10, 5000).score, 0);
  assert.equal(responseExperienceScore(100, 200).score, 100);
  assert.equal(responseExperienceScore(1000, 0).score, 100);
  assert.equal(responseExperienceScore(0, 200), null);
  assert.equal(responseExperienceScore(10, -1), null);
  assert.equal(responseExperienceScore(NaN, 100), null);
});
check("source record is not mutated", () => {
  const r = record(allQuick);
  const before = JSON.stringify(r);
  assessRun(r);
  assert.equal(JSON.stringify(r), before);
});
const baselineTiming = { decode_tps: 50, ttft_ms: 1000, decode_source: "server", ttft_source: "client_stream" };
const baseline = record(allQuick.map((i) => item(i.task.id, 1, baselineTiming)));
const comparable = {
  ...baseline,
  suite_hash: "fixture-suite-hash-not-real-benchmark",
  pack_version: "fixture-1", protocol_version: "fixture-protocol", provenance: "fixture-only",
  config: { ...baseline.config, pack_id: "collection-full-v1", temperature: 0, max_tokens: 8192, timeout_s: 600, reasoning_effort: "low", reasoning_parameters: { thinking: false }, execution_info: { context_length: "65536", parallelism: "1", speculative: "off", cache: "off", offload: "none" } },
  items: baseline.items.map((i) => ({ ...i, attempts: [{ ...i.attempts[0], score: { ...i.attempts[0].score, scorer_version: "fixture-scorer-v1" } }] })),
};
check("v2 baseline is 1000 and legacy v1 is preserved", () => {
  const a = assessRunV2(baseline), legacy = assessRun(baseline);
  assert.equal(a.policy, BENCH_SCORE_POLICY_V2.id);
  assert.equal(a.performance.value, 1000);
  assert.equal(a.overall.value, 1000);
  assert.deepEqual(a.legacyV1, { intelligence: legacy.intelligence, performance: legacy.performance, overall: legacy.overall });
});
check("v2 geometric formula has no 100 or 1000 ceiling", () => {
  const score = performanceScoreV2(500, 100).score;
  assert.ok(Math.abs(score - 10000) < 1e-8);
  const a = assessRunV2(record(allQuick.map((i) => item(i.task.id, 1, { ...baselineTiming, decode_tps: 500, ttft_ms: 100 }))));
  assert.equal(a.performance.value, 10000);
  assert.ok(a.overall.value > 1000);
});
check("v2 finite extreme indices are not rounded into infinity or zero", () => {
  const fast = assessRunV2(record(baseline.items.slice(0, 10).map((i) => item(i.task.id, 1, { ...baselineTiming, decode_tps: 1e300, ttft_ms: 1e-300 }))));
  assert.ok(Number.isFinite(fast.performance.value));
  assert.ok(fast.performance.value > 1e300);
  const slow = assessRunV2(record(baseline.items.slice(0, 10).map((i) => item(i.task.id, 1, { ...baselineTiming, decode_tps: 1e-200, ttft_ms: 1e200 }))));
  assert.ok(slow.performance.value > 0);
  assert.ok(Number.isFinite(slow.overall.lower));
});
check("v2 rejects zero/negative/nonfinite TTFT without changing v1", () => {
  for (const t of [0, -1, NaN, Infinity]) assert.equal(performanceScoreV2(50, t), null);
  for (const d of [0, -1, NaN, Infinity]) assert.equal(performanceScoreV2(d, 1000), null);
  const zero = record(allQuick.map((i) => item(i.task.id, 1, { ...baselineTiming, ttft_ms: 0 })));
  assert.equal(assessRunV2(zero).performance.value, null);
  assert.equal(assessRunV2(zero).performanceEvidence.pairedCount, 0);
  assert.notEqual(assessRun(zero).performance.value, null);
});
check("v2 retains c1 and ten-pair evidence requirement", () => {
  assert.equal(assessRunV2(record(baseline.items.slice(0, 9))).performance.value, null);
  assert.equal(assessRunV2(record(baseline.items, "quick", 2)).performance.value, null);
  const mixed = [...baseline.items.slice(0, 10), item("gsm8k:invalid-timing", 1, { ...baselineTiming, ttft_ms: 0 })];
  const a = assessRunV2(record(mixed));
  assert.equal(a.performanceEvidence.pairedCount, 10);
  assert.equal(a.performance.value, 1000);
});
check("v2 intelligence zero forces overall zero despite fast responses", () => {
  const a = assessRunV2(record(allQuick.map((i) => item(i.task.id, 0, { ...baselineTiming, decode_tps: 500, ttft_ms: 100 }))));
  assert.equal(a.intelligence.value, 0);
  assert.equal(a.performance.value, 10000);
  assert.equal(a.overall.value, 0);
});
check("v2 incomplete intelligence keeps transformed outward-rounded bounds", () => {
  const a = assessRunV2(record(baseline.items.filter((i) => i.task.id.startsWith("gsm8k:"))));
  assert.equal(a.intelligence.value, null);
  assert.equal(a.overall.value, null);
  assert.equal(a.overall.lower, Math.floor(1000 * (0.125 ** 0.7) * 10) / 10);
  assert.equal(a.overall.upper, 1000);
  assert.ok(a.overall.upper > a.overall.lower);
});
check("v2 missing intelligence or performance stays uncalculated", () => {
  assert.equal(assessRunV2(record([])).overall.value, null);
  const unavailable = { state: "unavailable", value: null, lower: null, upper: null, coverage: 0, measuredOnly: null, reason: "fixture" };
  assert.equal(combineScoresV2(unavailable, assessRunV2(baseline).performance).value, null);
  assert.equal(combineScoresV2(assessRunV2(baseline).intelligence, unavailable).value, null);
});
check("v2 usability text uses separate observed thresholds", () => {
  const use = (decode_tps, ttft_ms) => assessRunV2(record(baseline.items.slice(0, 10).map((i) => item(i.task.id, 1, { ...baselineTiming, decode_tps, ttft_ms })))).usability.label;
  assert.equal(use(30, 1000), "대화에 쾌적함");
  assert.equal(use(20, 2000), "일반 대화에 무난함");
  assert.equal(use(19, 1000), "답변 생성 속도가 느림");
  assert.equal(use(30, 2001), "첫 응답 대기가 김");
  assert.equal(use(19, 2001), "첫 응답 대기와 답변 생성이 느림");
  assert.equal(use(50, 0), "응답 경험 확인 필요");
});
check("v2 comparison marks unknown recorded conditions incomplete", () => {
  assert.equal(comparisonFor(baseline).complete, false);
  assert.ok(comparisonFor(baseline).details.some((v) => v.includes("확인 불가")));
  assert.equal(comparisonFor(comparable).complete, true);
});
check("v2 explicit false controls are preserved rather than treated as missing", () => {
  const r = structuredClone(comparable);
  r.config.execution_info.cache = false;
  r.config.execution_info.speculative = false;
  r.config.execution_info.offload = false;
  assert.equal(comparisonFor(r).complete, true);
  const key = comparisonFor(r).key;
  r.config.execution_info.cache = null;
  assert.equal(comparisonFor(r).complete, false);
  assert.notEqual(comparisonFor(r).key, key);
});
check("v2 comparison key changes with actual input and measurement conditions", () => {
  const key = comparisonFor(comparable).key;
  const variations = [
    (r) => { r.suite_hash = "different-input"; },
    (r) => { r.config.pack_id = "gsm8k-test-v1"; },
    (r) => { r.pack_version = "fixture-2"; },
    (r) => { r.config.profile = "full"; },
    (r) => { r.config.concurrency = 2; },
    (r) => { r.config.temperature = 0.2; },
    (r) => { r.config.max_tokens = 4096; },
    (r) => { r.config.reasoning_parameters.thinking = true; },
    (r) => { r.config.execution_info.cache = "on"; },
    (r) => { r.items[0].attempts[0].metrics.ttft_source = "server"; },
    (r) => { r.items.reverse(); },
  ];
  for (const change of variations) { const r = structuredClone(comparable); change(r); assert.notEqual(comparisonFor(r).key, key); }
});
check("v2 comparison is deterministic and excludes compared model identity", () => {
  const r = structuredClone(comparable);
  r.config.model = "another-model";
  r.config.base_url = "http://private.invalid/v1";
  r.config.name = "renamed-run";
  assert.equal(comparisonFor(r).key, comparisonFor(comparable).key);
  assert.ok(!JSON.stringify(comparisonFor(r)).includes("private.invalid"));
  assert.ok(comparisonFor(r).details.some((v) => v.includes("표준 부하 시험을 새로 수행한 결과가 아닙니다")));
});
check("v2 comparison distinguishes actual paired sample subsets and per-item sources", () => {
  const a = structuredClone(comparable), b = structuredClone(comparable);
  a.items = a.items.slice(0, 20).map((i) => structuredClone(i));
  b.items = b.items.slice(0, 20).map((i) => structuredClone(i));
  a.items.slice(10).forEach((i) => { i.attempts[0].metrics.ttft_ms = null; });
  b.items.slice(0, 10).forEach((i) => { i.attempts[0].metrics.ttft_ms = null; });
  assert.equal(comparisonFor(a).complete, true);
  assert.equal(comparisonFor(b).complete, true);
  assert.notEqual(comparisonFor(a).key, comparisonFor(b).key);
  assert.ok(comparisonFor(a).details.some((v) => v.includes("paired 표본 10/20") && v.includes("제외 10문항")));
  const c = structuredClone(a), d = structuredClone(a);
  c.items[0].attempts[0].metrics.ttft_source = "server";
  d.items[1].attempts[0].metrics.ttft_source = "server";
  assert.notEqual(comparisonFor(c).key, comparisonFor(d).key);
  const faster = structuredClone(a);
  faster.items.slice(0, 10).forEach((i) => { i.attempts[0].metrics.decode_tps = 200; });
  assert.equal(comparisonFor(a).key, comparisonFor(faster).key);
});
check("v2 calculation leaves original run unchanged", () => {
  const before = JSON.stringify(comparable);
  assessRunV2(comparable);
  assert.equal(JSON.stringify(comparable), before);
});
console.log(
  `${passed} pure policy checks passed. No model inference was executed.`,
);

// Optional read-only inspection of one saved run; no paths, prompts, answers,
// credentials, or model identities are printed.
if (process.argv[2]) {
  const a = assessRunV2(JSON.parse(await readFile(process.argv[2], "utf8")));
  console.log(
    JSON.stringify(
      {
        policy: a.policy,
        intelligence: a.intelligence,
        performance: a.performance,
        overall: a.overall,
        timing: a.performanceEvidence,
        referenceItems: a.referenceItems,
        usability: a.usability,
        legacyV1: a.legacyV1,
        comparison: { complete: a.comparison.complete, key: a.comparison.key },
      },
      null,
      2,
    ),
  );
}
