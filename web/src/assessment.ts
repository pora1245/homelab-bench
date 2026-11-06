import frontierReferenceData from "./frontier-reference.json";
import {
  benchmarkLabel,
  benchmarkKey,
  isReferenceTask,
  taskBenchmarkId,
  type PublicBenchmarkId,
} from "./benchmarkLabels";

type Data = Record<string, any>;
export type ScoreState = "unavailable" | "partial" | "provisional" | "complete";
export type ScoreEstimate = {
  state: ScoreState;
  value: number | null;
  lower: number | null;
  upper: number | null;
  coverage: number;
  measuredOnly: number | null;
  reason: string;
};
export type BenchmarkEvidence = {
  id: PublicBenchmarkId;
  label: string;
  weight: number;
  selected: number;
  scored: number;
  required: number;
  points: number;
  percent: number | null;
  coverage: number;
};
export type PerformanceEvidence = {
  pairedCount: number;
  requiredCount: number;
  concurrency: number | null;
  decodeMedian: number | null;
  ttftMedian: number | null;
  decodeScore: number | null;
  ttftScore: number | null;
  sources: Record<string, number>;
};
export type AssessmentGuide = {
  id: string;
  title: string;
  evidence: string;
  next: string;
  kind: "measurement" | "quality" | "experience";
};
export type AssessmentV1 = {
  policy: string;
  intelligence: ScoreEstimate;
  performance: ScoreEstimate;
  overall: ScoreEstimate;
  benchmarks: BenchmarkEvidence[];
  performanceEvidence: PerformanceEvidence;
  referenceItems: number;
  unrecognizedItems: number;
  duplicateItems: number;
  scoredItems: number;
  requestedItems: number;
  requestErrors: number;
  scoringFailures: number;
  truncatedItems: number;
  guides: AssessmentGuide[];
};
export type Assessment = AssessmentV1 & {
  usability: { label: string; detail: string };
  legacyV1: Pick<AssessmentV1, "intelligence" | "performance" | "overall">;
  comparison: { key: string; details: string[]; complete: boolean };
};
export type RunAssessment = FrontierAssessment;

/**
 * Bench Home v1 — product index, not an official benchmark or a population rank.
 *
 * Intelligence uses fixed weights; no weight is reassigned when a component is
 * missing. For benchmark b, T_b=max(v1 quota, selected unique tasks), q_b is the
 * sum of valid recorded scores, and n_b is the number of valid recorded scores.
 * L=100*Σ(w_b*q_b/T_b), coverage=Σ(w_b*n_b/T_b), U=L+100*(1-coverage).
 * [L,U] is an arithmetic completion bound, NOT a statistical confidence interval.
 * `measuredOnly=L/coverage` describes only the scored part and never replaces
 * intelligence. Full quotas apply only to profile=full; other profiles use the
 * fixed quick quotas and remain provisional even at 100% coverage.
 *
 * Performance is a c1 response-experience index from >=10 paired, successful,
 * completed requests: D=clamp(100*log10(medianDecode/10));
 * T=clamp(100*ln(5000/medianTTFT)/ln(25)); P=.7D+.3T.
 * Anchors 10..100 tok/s and 200..5000 ms are fixed product conversion parameters,
 * not measured market averages, health limits, or official passing criteria.
 * Missing latency/Decode or concurrency!=1 => no P (never zero substitution).
 * Overall=.7*I+.3*P; if either part is absent, overall is not calculated.
 * Every function is pure: no clock, network, storage, or mutations of the record.
 */
export const BENCH_SCORE_POLICY_V1 = Object.freeze({
  id: "bench-home-v1",
  range: Object.freeze([0, 100] as const),
  intelligenceDomains: Object.freeze({
    math: 0.25,
    knowledge: 0.25,
    instructions: 0.25,
    coding: 0.25,
  }),
  benchmarks: Object.freeze([
    { id: "gsm8k", weight: 0.125, quick: 50, full: 1319 },
    { id: "math500", weight: 0.125, quick: 50, full: 500 },
    { id: "mmlu-pro", weight: 0.25, quick: 100, full: 12032 },
    { id: "ifeval", weight: 0.25, quick: 50, full: 541 },
    { id: "humaneval", weight: 0.25 / 3, quick: 25, full: 164 },
    { id: "mbpp", weight: 0.25 / 3, quick: 25, full: 500 },
    { id: "livecodebench", weight: 0.25 / 3, quick: 30, full: 1055 },
  ] as const),
  minimumPairedRequests: 10,
  decodeLowTps: 10,
  decodeHighTps: 100,
  ttftFastMs: 200,
  ttftSlowMs: 5000,
  performanceDecodeWeight: 0.7,
  performanceTtftWeight: 0.3,
  overallIntelligenceWeight: 0.7,
  overallPerformanceWeight: 0.3,
});

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, min = 0, max = 100) =>
  Math.min(max, Math.max(min, value));
const round = (value: number) => Math.round((value + Number.EPSILON) * 10) / 10;
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
export function responseExperienceScore(decodeTps: number, ttftMs: number) {
  const p = BENCH_SCORE_POLICY_V1;
  if (!finite(decodeTps) || decodeTps <= 0 || !finite(ttftMs) || ttftMs < 0)
    return null;
  const decode = clamp(
    (100 * Math.log(decodeTps / p.decodeLowTps)) /
      Math.log(p.decodeHighTps / p.decodeLowTps),
  );
  const ttft =
    ttftMs === 0
      ? 100
      : clamp(
          (100 * Math.log(p.ttftSlowMs / ttftMs)) /
            Math.log(p.ttftSlowMs / p.ttftFastMs),
        );
  return {
    decode,
    ttft,
    score: p.performanceDecodeWeight * decode + p.performanceTtftWeight * ttft,
  };
}
function recordedScore(item: Data): number | null {
  const score = item.attempts?.at(-1)?.score;
  if (
    !["done", "error"].includes(item.status) ||
    score?.state !== "scored" ||
    !finite(score.value) ||
    score.value < 0 ||
    score.value > 1
  )
    return null;
  return score.value;
}
function uniqueItems(run: Data) {
  const unique = new Map<string, Data>();
  for (const item of run.items || []) {
    const id = String(item.task?.id || "");
    if (id && !unique.has(id)) unique.set(id, item);
  }
  return [...unique.values()];
}

/** Expansion packs keep their own accuracy; v3's fixed weights stay unchanged. */
export function supplementalBenchmarks(run: Data) {
  return ["bbh"].map((id) => {
    const items = uniqueItems(run).filter((item) => benchmarkKey(item.task) === id);
    const scores = items.map(recordedScore).filter(finite);
    return { id, label: benchmarkLabel(id), selected: items.length, scored: scores.length,
      percent: scores.length ? round(100 * scores.reduce((sum, score) => sum + score, 0) / scores.length) : null };
  }).filter((row) => row.selected > 0);
}
const unavailable = (reason: string): ScoreEstimate => ({
  state: "unavailable",
  value: null,
  lower: null,
  upper: null,
  coverage: 0,
  measuredOnly: null,
  reason,
});

export function assessIntelligence(run: Data, items = uniqueItems(run)) {
  const full = run.config?.profile === "full";
  const benchmarks: BenchmarkEvidence[] = BENCH_SCORE_POLICY_V1.benchmarks.map(
    (component) => {
      const selected = items.filter(
        (item) => taskBenchmarkId(item.task) === component.id,
      );
      const values = selected.map(recordedScore).filter(finite);
      const required = Math.max(
        full ? component.full : component.quick,
        selected.length,
      );
      const points = values.reduce((sum, value) => sum + value, 0);
      return {
        id: component.id,
        label: benchmarkLabel(component.id),
        weight: component.weight,
        selected: selected.length,
        scored: values.length,
        required,
        points,
        percent: values.length ? round((100 * points) / values.length) : null,
        coverage: values.length / required,
      };
    },
  );
  const covered = benchmarks.reduce((sum, b) => sum + b.weight * b.coverage, 0);
  if (!covered)
    return {
      score: unavailable("공개 평가 문항의 유효한 채점 결과가 필요합니다."),
      benchmarks,
    };
  const lower =
    100 *
    benchmarks.reduce((sum, b) => sum + (b.weight * b.points) / b.required, 0);
  const upper = Math.min(100, lower + 100 * (1 - covered));
  const filled = covered >= 1 - 1e-9;
  const completed = filled && full && run.status === "completed";
  const score: ScoreEstimate = {
    state: filled ? (completed ? "complete" : "provisional") : "partial",
    value: filled ? round(lower) : null,
    lower: filled ? round(lower) : Math.floor(lower * 10) / 10,
    upper: filled ? round(lower) : Math.ceil(upper * 10) / 10,
    coverage: filled ? 100 : Math.min(99.9, round(covered * 100)),
    measuredOnly: round(lower / covered),
    reason: filled
      ? completed
        ? "v1 구성의 전체 평가 결과입니다."
        : "v1 구성은 채웠으며 빠른·일부 표본의 잠정 결과입니다."
      : "아직 채점하지 않은 영역 때문에 전체 점수는 범위로 표시합니다.",
  };
  return { score, benchmarks };
}
export function assessPerformance(run: Data, items = uniqueItems(run)) {
  const pairs = items
    .filter((item) => {
      const a = item.attempts?.at(-1),
        m = a?.metrics;
      return (
        ["done", "error"].includes(item.status) &&
        a?.ended_at &&
        a.error == null &&
        finite(m?.decode_tps) &&
        m.decode_tps > 0 &&
        finite(m?.ttft_ms) &&
        m.ttft_ms >= 0
      );
    })
    .map((item) => item.attempts.at(-1).metrics);
  const evidence: PerformanceEvidence = {
    pairedCount: pairs.length,
    requiredCount: BENCH_SCORE_POLICY_V1.minimumPairedRequests,
    concurrency: finite(run.config?.concurrency)
      ? run.config.concurrency
      : null,
    decodeMedian: median(pairs.map((m) => m.decode_tps)),
    ttftMedian: median(pairs.map((m) => m.ttft_ms)),
    decodeScore: null,
    ttftScore: null,
    sources: {},
  };
  pairs.forEach((m) => {
    const source = m.decode_source || "unknown";
    evidence.sources[source] = (evidence.sources[source] || 0) + 1;
  });
  if (evidence.concurrency !== 1)
    return {
      score: unavailable(
        "단일 요청(c1) 시험에서 TTFT와 Decode를 함께 측정하면 산출합니다. 동시 요청 결과는 별도로 해석합니다.",
      ),
      evidence,
    };
  if (pairs.length < evidence.requiredCount)
    return {
      score: unavailable(
        `TTFT와 Decode가 함께 기록된 정상 응답 ${evidence.requiredCount}건이 필요합니다. 현재 ${pairs.length}건입니다.`,
      ),
      evidence,
    };
  const result = responseExperienceScore(
    evidence.decodeMedian!,
    evidence.ttftMedian!,
  )!;
  evidence.decodeScore = round(result.decode);
  evidence.ttftScore = round(result.ttft);
  const value = round(result.score);
  return {
    score: {
      state: run.status === "completed" ? "complete" : "provisional",
      value,
      lower: value,
      upper: value,
      coverage: 100,
      measuredOnly: null,
      reason:
        "같은 정상 응답들의 중앙값으로 계산한 단일 요청 응답 경험 지표입니다.",
    } as ScoreEstimate,
    evidence,
  };
}
export function combineScores(
  intelligence: ScoreEstimate,
  performance: ScoreEstimate,
): ScoreEstimate {
  if (
    intelligence.lower == null ||
    intelligence.upper == null ||
    performance.value == null
  )
    return unavailable(
      "지능 평가와 단일 요청 성능 측정을 함께 모으면 종합 점수가 나옵니다.",
    );
  const p = BENCH_SCORE_POLICY_V1,
    rawLower =
      p.overallIntelligenceWeight * intelligence.lower +
      p.overallPerformanceWeight * performance.value,
    rawUpper =
      p.overallIntelligenceWeight * intelligence.upper +
      p.overallPerformanceWeight * performance.value;
  const partial = intelligence.value == null;
  const lower = partial ? Math.floor(rawLower * 10) / 10 : round(rawLower),
    upper = partial ? Math.ceil(rawUpper * 10) / 10 : lower;
  const value = partial ? null : lower;
  return {
    state:
      value == null
        ? "partial"
        : intelligence.state === "complete" && performance.state === "complete"
          ? "complete"
          : "provisional",
    value,
    lower,
    upper,
    coverage: partial
      ? Math.min(
          99.9,
          round(
            p.overallIntelligenceWeight * intelligence.coverage +
              100 * p.overallPerformanceWeight,
          ),
        )
      : 100,
    measuredOnly: null,
    reason:
      value == null
        ? "지능 평가의 빈 영역이 채워질 때까지 가능한 점수 범위입니다."
        : "지능 70%와 단일 요청 성능 30%를 반영한 자체 종합 지표입니다.",
  };
}
function guidesFor(
  run: Data,
  assessment: Omit<AssessmentV1, "guides">,
): AssessmentGuide[] {
  const guides: AssessmentGuide[] = [];
  const sourceFailures = uniqueItems(run).filter((item) => ["source_incomplete", "source_conflict"].includes(item.attempts?.at(-1)?.score?.extra?.error_code)).length;
  if (sourceFailures) guides.push({ id: "source", kind: "measurement", title: "원본 자료의 결함을 구분했습니다", evidence: `${sourceFailures}문항은 원문 불완전·정답 상충으로 채점에서 제외했습니다. 모델 오답이나 0점이 아닙니다.`, next: "문항 상세에서 원본 사유를 확인하세요. 채점 환경을 재설치해도 해결되지 않으며, 교정된 새 평가팩이 필요합니다." });
  if (assessment.scoringFailures > sourceFailures)
    guides.push({
      id: "scoring",
      kind: "measurement",
      title: "채점이 멈춘 답안부터 확인하세요",
      evidence: `수집한 답안 ${assessment.scoringFailures - sourceFailures}건의 유효한 채점 결과가 없습니다.`,
      next: "보고서에서 채점 사유를 확인하고 환경을 복구한 뒤 저장된 답안을 재채점하세요.",
    });
  if (assessment.requestErrors)
    guides.push({
      id: "requests",
      kind: "measurement",
      title: "실패한 요청을 먼저 해결하세요",
      evidence: `모델 요청 오류 ${assessment.requestErrors}건이 기록됐습니다.`,
      next: "보고서의 오류 내용과 제한시간을 확인한 뒤 같은 조건으로 다시 시험하세요.",
    });
  if (assessment.truncatedItems)
    guides.push({
      id: "length",
      kind: "measurement",
      title: "답변을 끝낼 출력 공간이 필요합니다",
      evidence: `출력 한도에 도달한 문항이 ${assessment.truncatedItems}건 있습니다.`,
      next: "추론·출력 토큰 한도를 확인하고 같은 문제에서 답변이 끝까지 나오는지 재시험하세요.",
    });
  const slow = assessment.performanceEvidence;
  if (
    slow.pairedCount >= slow.requiredCount &&
    slow.concurrency === 1 &&
    slow.ttftMedian != null &&
    slow.ttftMedian > 2000
  )
    guides.push({
      id: "latency",
      kind: "experience",
      title: "첫 답변까지의 대기를 줄여보세요",
      evidence: `단일 요청 TTFT 중앙값은 ${(slow.ttftMedian / 1000).toFixed(2)}초입니다.`,
      next: "입력 길이·캐시·엔진 옵션을 같은 조건에서 확인하세요. 모델 처리와 통신 대기를 나눠 측정하면 원인을 좁힐 수 있습니다.",
    });
  else if (
    slow.pairedCount >= slow.requiredCount &&
    slow.concurrency === 1 &&
    slow.decodeMedian != null &&
    slow.decodeMedian < 20
  )
    guides.push({
      id: "decode",
      kind: "experience",
      title: "토큰 생성 속도를 확인해보세요",
      evidence: `단일 요청 Decode 중앙값은 ${slow.decodeMedian.toFixed(1)} tok/s입니다.`,
      next: "같은 문항과 출력 조건을 유지하고 엔진·Offload 설정을 하나씩 바꿔 다시 측정하세요.",
    });
  const weakest = assessment.benchmarks
    .filter(
      (b) =>
        b.scored >=
          Math.min(
            b.required,
            BENCH_SCORE_POLICY_V1.benchmarks.find((p) => p.id === b.id)!.quick,
          ) && b.percent != null,
    )
    .sort((a, b) => a.percent! - b.percent!)[0];
  if (weakest && weakest.percent! < 60)
    guides.push({
      id: "quality",
      kind: "quality",
      title: "어려워한 유형을 먼저 살펴보세요",
      evidence: `${weakest.label}: 채점 ${weakest.scored}문항에서 ${weakest.percent}점입니다.`,
      next: "오답의 근거를 읽고 같은 문제·채점 규칙에서 추론 설정이나 모델을 바꿔 확인하세요.",
    });
  if (assessment.intelligence.coverage < 100)
    guides.push({
      id: "coverage",
      kind: "measurement",
      title: "측정 범위를 채우면 판단이 분명해집니다",
      evidence: `v1 지능 구성의 ${assessment.intelligence.coverage}%를 확인했습니다.`,
      next: "종합 시험에서 빠진 수학·지식·지시 이행·코딩 영역을 함께 평가하세요.",
    });
  if (assessment.performance.state === "unavailable")
    guides.push({
      id: "timing",
      kind: "measurement",
      title: "응답 경험도 함께 측정하세요",
      evidence: assessment.performance.reason,
      next: "단일 요청(c1)과 스트리밍으로 정상 응답을 10건 이상 기록하세요.",
    });
  if (!guides.length)
    guides.push({
      id: "covered",
      kind: "quality",
      title: "이제 실제 용도에 가까운 문제를 보세요",
      evidence: "이번 구성에서 품질과 단일 요청 응답 경험을 함께 확인했습니다.",
      next: "보고서의 과목별 결과를 읽고, 필요한 업무와 비슷한 평가팩으로 범위를 넓혀보세요.",
    });
  return guides.slice(0, 3);
}

export function assessRunV1(run: Data | null | undefined): AssessmentV1 {
  const record = run || {},
    items = uniqueItems(record),
    intelligence = assessIntelligence(record, items),
    performance = assessPerformance(record, items);
  const result: Omit<AssessmentV1, "guides"> = {
    policy: BENCH_SCORE_POLICY_V1.id,
    intelligence: intelligence.score,
    performance: performance.score,
    overall: combineScores(intelligence.score, performance.score),
    benchmarks: intelligence.benchmarks,
    performanceEvidence: performance.evidence,
    referenceItems: items.filter((item) => isReferenceTask(item.task)).length,
    unrecognizedItems: items.filter(
      (item) => !taskBenchmarkId(item.task) && !isReferenceTask(item.task) && benchmarkKey(item.task) !== "bbh",
    ).length,
    duplicateItems: (record.items?.length || 0) - items.length,
    scoredItems: items.filter((item) => recordedScore(item) != null).length,
    requestedItems: items.length,
    requestErrors: items.filter((item) => item.status === "error").length,
    scoringFailures: items.filter(
      (item) => item.status === "done" && recordedScore(item) == null,
    ).length,
    truncatedItems: items.filter(
      (item) => item.attempts?.at(-1)?.finish_reason === "length",
    ).length,
  };
  return { ...result, guides: guidesFor(record, result) };
}

/** V2 changes only presentation indices; source responses and verdicts are immutable. */
export const BENCH_SCORE_POLICY_V2 = Object.freeze({
  id: "bench-score-v2",
  intelligenceRange: Object.freeze([0, 100] as const),
  baselineScore: 1000,
  baselineDecodeTps: 50,
  baselineTtftMs: 1000,
  minimumPairedRequests: BENCH_SCORE_POLICY_V1.minimumPairedRequests,
  performanceDecodeWeight: 0.7,
  performanceTtftWeight: 0.3,
  overallIntelligenceWeight: 0.7,
  overallPerformanceWeight: 0.3,
});
function indexRound(value: number): number {
  const rounded = round(value);
  // Preserve finite very large or positive very small indices instead of
  // turning them into Infinity or zero merely for one-decimal presentation.
  return finite(rounded) && (value === 0 || rounded !== 0) ? rounded : value;
}
function indexBound(value: number, upper: boolean): number {
  if (Math.abs(value) >= Number.MAX_SAFE_INTEGER / 10) return value;
  return (upper ? Math.ceil(value * 10) : Math.floor(value * 10)) / 10;
}

export function performanceScoreV2(decodeTps: number, ttftMs: number) {
  if (!finite(decodeTps) || decodeTps <= 0 || !finite(ttftMs) || ttftMs <= 0)
    return null;
  const p = BENCH_SCORE_POLICY_V2;
  // Logarithms avoid an intermediate overflow in 1000 / a very small TTFT.
  const score = p.baselineScore * Math.exp(
    p.performanceDecodeWeight * (Math.log(decodeTps) - Math.log(p.baselineDecodeTps)) +
    p.performanceTtftWeight * (Math.log(p.baselineTtftMs) - Math.log(ttftMs)),
  );
  if (!finite(score) || score <= 0) return null;
  const decode = p.baselineScore * decodeTps / p.baselineDecodeTps;
  const ttft = p.baselineScore * p.baselineTtftMs / ttftMs;
  return { score, decode: finite(decode) ? decode : null, ttft: finite(ttft) ? ttft : null };
}

function v2TimingItems(items: Data[]): Data[] {
  return items.filter((item) => {
    const a = item.attempts?.at(-1), m = a?.metrics;
    return ["done", "error"].includes(item.status) && a?.ended_at && a.error == null &&
      finite(m?.decode_tps) && m.decode_tps > 0 && finite(m?.ttft_ms) && m.ttft_ms > 0;
  });
}

export function assessPerformanceV2(run: Data, items = uniqueItems(run)) {
  const paired = v2TimingItems(items);
  const metrics = paired.map((item) => item.attempts.at(-1).metrics);
  const evidence: PerformanceEvidence = {
    pairedCount: paired.length,
    requiredCount: BENCH_SCORE_POLICY_V2.minimumPairedRequests,
    concurrency: finite(run.config?.concurrency) ? run.config.concurrency : null,
    decodeMedian: median(metrics.map((m) => m.decode_tps)),
    ttftMedian: median(metrics.map((m) => m.ttft_ms)),
    decodeScore: null,
    ttftScore: null,
    sources: {},
  };
  metrics.forEach((m) => {
    const source = m.decode_source || "unknown";
    evidence.sources[source] = (evidence.sources[source] || 0) + 1;
  });
  if (evidence.concurrency !== 1)
    return { score: unavailable("단일 요청(c1)의 정상 응답에서만 v2 성능을 산출합니다. 동시 요청 시험은 별도로 해석합니다."), evidence };
  if (paired.length < evidence.requiredCount)
    return { score: unavailable(`양수 TTFT와 Decode가 같은 정상 응답에 기록된 사례 ${evidence.requiredCount}건이 필요합니다. 현재 ${paired.length}건이며 0ms·누락·오류는 제외합니다.`), evidence };
  const result = performanceScoreV2(evidence.decodeMedian!, evidence.ttftMedian!);
  if (!result)
    return { score: unavailable("측정값의 수치 범위를 확인할 수 없어 v2 성능을 산출하지 않습니다."), evidence };
  evidence.decodeScore = result.decode == null ? null : indexRound(result.decode);
  evidence.ttftScore = result.ttft == null ? null : indexRound(result.ttft);
  const value = indexRound(result.score);
  return {
    score: {
      state: run.status === "completed" ? "complete" : "provisional",
      value, lower: value, upper: value, coverage: 100, measuredOnly: null,
      reason: "Decode 50 tok/s·TTFT 1,000ms를 1,000점으로 둔 상한 없는 자체 지표입니다. 이번 기록의 응답 중앙값으로 계산하며 표준 부하 시험 결과를 뜻하지 않습니다.",
    } as ScoreEstimate,
    evidence,
  };
}

export function combineScoresV2(intelligence: ScoreEstimate, performance: ScoreEstimate): ScoreEstimate {
  const lo = intelligence.lower, hi = intelligence.upper, p = performance.value;
  if (!finite(lo) || !finite(hi) || lo < 0 || hi > 100 || hi < lo || !finite(p) || p <= 0)
    return unavailable("지능 평가의 유효한 점수·범위와 v2 단일 요청 성능이 함께 있어야 종합 점수를 산출합니다.");
  const convert = (i: number) => i === 0 ? 0 :
    1000 * Math.exp(0.7 * (Math.log(i) - Math.log(100)) + 0.3 * (Math.log(p) - Math.log(1000)));
  const rawLower = convert(lo), rawUpper = convert(hi);
  if (!finite(rawLower) || !finite(rawUpper))
    return unavailable("종합 점수의 수치 범위를 확인할 수 없습니다.");
  const partial = intelligence.value == null;
  const lower = partial ? indexBound(rawLower, false) : indexRound(rawLower);
  const upper = partial ? indexBound(rawUpper, true) : lower;
  return {
    state: partial ? "partial" : intelligence.state === "complete" && performance.state === "complete" ? "complete" : "provisional",
    value: partial ? null : lower, lower, upper,
    coverage: partial ? Math.min(99.9, round(0.7 * intelligence.coverage + 30)) : 100,
    measuredOnly: null,
    reason: partial
      ? "미측정 지능 영역의 산술적 가능 범위를 v2 종합식으로 변환했습니다. 통계적 신뢰구간이 아닙니다."
      : "지능/100의 0.7승과 성능/1,000의 0.3승을 곱한 자체 종합 지표입니다. 지능이 0점이면 종합도 0점입니다.",
  };
}

export function usabilityFor(evidence: PerformanceEvidence): Assessment["usability"] {
  const d = evidence.decodeMedian, t = evidence.ttftMedian;
  if (evidence.concurrency !== 1 || evidence.pairedCount < evidence.requiredCount || !finite(d) || d <= 0 || !finite(t) || t <= 0)
    return { label: "응답 경험 확인 필요", detail: "양수 TTFT·Decode가 함께 기록된 단일 요청 정상 응답 10건 이상이 필요합니다." };
  const detail = `이번 문항의 Decode 중앙값 ${round(d)} tok/s·TTFT 중앙값 ${round(t)}ms 기준입니다. 모델 품질이나 다른 입력 길이의 대화 경험까지 보장하지 않습니다.`;
  if (d >= 30 && t <= 1000) return { label: "대화에 쾌적함", detail };
  if (d >= 20 && t <= 2000) return { label: "일반 대화에 무난함", detail };
  if (d < 20 && t > 2000) return { label: "첫 응답 대기와 답변 생성이 느림", detail };
  if (t > 2000) return { label: "첫 응답 대기가 김", detail };
  return { label: "답변 생성 속도가 느림", detail };
}

function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function conditionFingerprint(value: any): string {
  // Non-cryptographic display fingerprint. Not an integrity or authorization key.
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (const c of stable(value)) {
    const n = c.codePointAt(0)!;
    a = Math.imul(a ^ n, 0x01000193) >>> 0;
    b = Math.imul(b ^ n, 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

export function comparisonFor(run: Data, items = uniqueItems(run)): Assessment["comparison"] {
  const c = run.config || {}, missing: string[] = [];
  const textField = (value: any, label: string) => {
    if (typeof value === "string" && value.trim()) return value;
    missing.push(label); return null;
  };
  const numericField = (value: any, label: string, minimum: number, maximum = Infinity) => {
    if (finite(value) && value >= minimum && value <= maximum) return value;
    missing.push(label); return null;
  };
  const paired = v2TimingItems(items);
  const sourcePairs = [...new Set(paired.map((item) => {
    const m = item.attempts.at(-1).metrics;
    const decode = textField(m.decode_source, "Decode 측정 출처");
    const ttft = textField(m.ttft_source, "TTFT 측정 출처");
    if (decode === "unknown" || ttft === "unknown") missing.push("측정 출처의 실제 방법");
    return `${decode || "unknown"}/${ttft || "unknown"}`;
  }))].sort();
  if (!sourcePairs.length) missing.push("정상 성능 표본의 측정 출처");
  const scorers = [...new Set(items.map((item) => {
    const s = item.attempts?.at(-1)?.score;
    return s?.state === "scored" ? textField(s.scorer_version, "채점기 버전") : null;
  }).filter(Boolean))].sort();
  if (!scorers.length) missing.push("유효한 채점기 버전");
  const reasoningKnown = typeof c.reasoning_effort === "string" && Object.hasOwn(c, "reasoning_parameters");
  if (!reasoningKnown) missing.push("추론 옵션과 요청 파라미터");
  const controls = c.execution_info || {};
  const controlKnown = (value: any) => value != null && !(typeof value === "string" && !value.trim());
  const conditions = {
    policy: BENCH_SCORE_POLICY_V2.id,
    suite_hash: textField(run.suite_hash, "문항·입력 해시"),
    pack_id: textField(c.pack_id, "평가팩 ID"),
    pack_version: textField(run.pack_version, "평가팩 버전"),
    packs_versions: run.pack_versions || run.packsVersions || null,
    protocol: textField(run.protocol_version, "시험 프로토콜 버전"),
    provenance: textField(run.provenance, "기록 출처"),
    mode: textField(c.profile, "전체·빠른 실행 방식"),
    task_order: items.map((item) => item.task.id),
    concurrency: numericField(c.concurrency, "동시 요청 수", 1),
    temperature: numericField(c.temperature, "Temperature", 0, 2),
    max_tokens: numericField(c.max_tokens, "최대 출력 토큰", 1),
    timeout_s: numericField(c.timeout_s, "요청 제한시간", 1),
    reasoning_effort: reasoningKnown ? c.reasoning_effort : null,
    reasoning_parameters: reasoningKnown ? c.reasoning_parameters : null,
    recorded_controls: Object.fromEntries(["context_length", "parallelism", "speculative", "cache", "offload"].map((key) => [key, controlKnown(controls[key]) ? controls[key] : null])),
    metric_sources: sourcePairs,
    paired_samples: paired.map((item) => ({
      id: item.task.id,
      decode_source: item.attempts.at(-1).metrics.decode_source || null,
      ttft_source: item.attempts.at(-1).metrics.ttft_source || null,
    })),
    scored_versions: scorers,
  };
  const absentControls = ["context_length", "parallelism", "speculative", "cache", "offload"].filter((key) => !controlKnown(controls[key]));
  const details = [
    `문항·입력 해시 ${conditions.suite_hash ? "기록됨" : "확인 불가"} · 평가팩 ${benchmarkLabel(c.pack_id || "평가팩 미기록")} · 버전 ${run.pack_version || "확인 불가"}`,
    `실행 방식 ${c.profile || "확인 불가"} · 동시 요청 ${conditions.concurrency ?? "확인 불가"} · Temperature ${conditions.temperature ?? "확인 불가"} · 출력 한도 ${conditions.max_tokens ?? "확인 불가"}`,
    `성능 측정 출처(Decode/TTFT): ${sourcePairs.join(", ") || "확인 불가"}`,
    `성능 계산에 사용한 정상 paired 표본 ${paired.length}/${items.length}문항 · 미수집·오류·미완료·0ms 등 제외 ${items.length - paired.length}문항. 실제 사용한 문항 ID와 항목별 출처도 비교키에 포함합니다.`,
    "다른 평가팩·문항 해시·실행 조건의 점수는 직접 비교하지 않습니다. 같은 키도 모델·장비·실제 캐시 상태가 통제됐음을 보증하지 않습니다.",
    "기존 실행 기록으로 조건을 확인하며, 별도의 표준 부하 시험을 새로 수행한 결과가 아닙니다.",
  ];
  if (absentControls.length) {
    missing.push("서버 Context·병렬·Speculative·Cache·Offload 제어조건 일부");
    details.push("서버 제어조건 일부가 미기록입니다. 실제 적용값은 확인할 수 없습니다.");
  }
  if (missing.length) details.push(`확인 불가: ${[...new Set(missing)].join(" · ")}`);
  return { key: `${BENCH_SCORE_POLICY_V2.id}:${conditionFingerprint(conditions)}`, details, complete: missing.length === 0 };
}

export function assessRunV2(run: Data | null | undefined): Assessment {
  const record = run || {}, items = uniqueItems(record);
  const legacy = assessRunV1(record);
  const performance = assessPerformanceV2(record, items);
  const intelligence = { ...legacy.intelligence, reason: legacy.intelligence.reason.replaceAll("v1 구성", "고정 지능 구성") };
  const result = {
    ...legacy,
    policy: BENCH_SCORE_POLICY_V2.id,
    intelligence,
    performance: performance.score,
    overall: combineScoresV2(intelligence, performance.score),
    performanceEvidence: performance.evidence,
    usability: usabilityFor(performance.evidence),
    legacyV1: { intelligence: legacy.intelligence, performance: legacy.performance, overall: legacy.overall },
    comparison: comparisonFor(record, items),
  };
  return { ...result, guides: guidesFor(record, result).map((guide) => ({ ...guide, evidence: guide.evidence.replaceAll("v1 지능 구성", "고정 지능 구성") })) };
}


export const EXPERIENCE_CASES = ["english", "korean", "code", "structured"] as const;
export type ExperienceCase = typeof EXPERIENCE_CASES[number];
export type FrontierReference = {
  status: string; id: string; protocol: string; model: string; reasoning_effort: string;
  measured_at: string; run_id: string; suite_hash: string;
  cases: Partial<Record<ExperienceCase, { ttft_ms: number; decode_tps: number; prompt_sha256: string }>>;
};
export const FRONTIER_REFERENCE: FrontierReference = frontierReferenceData;
export const BENCH_SCORE_POLICY_V3 = Object.freeze({
  id: "bench-api-experience-v3.1", protocol: "api-experience-v1", outputValidation: "api-experience-output-v2", baselineScore: 1000,
  repeatsPerCase: 3, overallIntelligenceWeight: 0.7, overallPerformanceWeight: 0.3,
});
export type CaseEvidence = { id: ExperienceCase; count: number; decode: number | null; ttft: number | null; decodeRatio: number | null; ttftRatio: number | null };
export type FrontierAssessment = Assessment & {
  legacyV2: Pick<AssessmentV1, "intelligence" | "performance" | "overall">;
  reference: FrontierReference;
  experienceCases: CaseEvidence[];
};
const experienceItem = (item: Data) => String(item.task?.id || "").startsWith("experience:");
const geometric = (values: number[]) => Math.exp(values.reduce((sum, n) => sum + Math.log(n), 0) / values.length);
function referenceReady(ref: FrontierReference): boolean {
  return ref.status === "ready" && ref.protocol === BENCH_SCORE_POLICY_V3.protocol &&
    !!ref.id && !!ref.model && !!ref.measured_at && !!ref.run_id && !!ref.suite_hash &&
    EXPERIENCE_CASES.every((id) => {
      const c = ref.cases[id];
      return c && finite(c.decode_tps) && c.decode_tps > 0 && finite(c.ttft_ms) && c.ttft_ms > 0 && /^[a-f0-9]{64}$/.test(c.prompt_sha256);
    });
}
/** Every task type has equal weight; speed and latency each occupy half. */
export function assessFrontierPerformance(run: Data, ref: FrontierReference = FRONTIER_REFERENCE) {
  const items = uniqueItems(run), ready = referenceReady(ref);
  const cases: CaseEvidence[] = EXPERIENCE_CASES.map((id) => {
    const b = ref.cases[id];
    const valid = items.filter((item) => {
      const a = item.attempts?.at(-1), m = a?.metrics, meta = item.task?.meta;
      return [1, 2, 3].some((r) => item.task?.id === `experience:${id}:${r}`) &&
        item.status === "done" && a?.ended_at && a.error == null && a.finish_reason === "stop" &&
        a.score?.state === "measured" && a.score?.scorer_version === BENCH_SCORE_POLICY_V3.outputValidation && a.score?.extra?.valid_output === true &&
        meta?.performance_protocol === BENCH_SCORE_POLICY_V3.protocol &&
        (!ready || meta?.prompt_sha256 === b?.prompt_sha256) &&
        m?.measurement_version === "client-visible-v1" && m?.ttft_source === "client_visible_stream" && finite(m?.ttft_ms) && m.ttft_ms > 0 &&
        finite(m?.client_visible_decode_tps) && m.client_visible_decode_tps > 0;
    });
    const decode = median(valid.map((i) => i.attempts.at(-1).metrics.client_visible_decode_tps));
    const ttft = median(valid.map((i) => i.attempts.at(-1).metrics.ttft_ms));
    return { id, count: valid.length, decode, ttft,
      decodeRatio: ready && decode != null ? decode / b!.decode_tps : null,
      ttftRatio: ready && ttft != null ? b!.ttft_ms / ttft : null };
  });
  const n = cases.reduce((sum, c) => sum + c.count, 0);
  const evidence: PerformanceEvidence = {
    pairedCount: n, requiredCount: 12, concurrency: finite(run.config?.concurrency) ? run.config.concurrency : null,
    decodeMedian: median(cases.filter((c) => c.decode != null).map((c) => c.decode!)),
    ttftMedian: median(cases.filter((c) => c.ttft != null).map((c) => c.ttft!)),
    decodeScore: null, ttftScore: null, sources: n ? { client_visible_stream: n } : {},
  };
  const fail = (reason: string) => ({ score: unavailable(reason), evidence, cases });
  if (!ready) return fail("프론티어 API 기준 측정을 완료하면 성능 점수가 표시됩니다.");
  if (evidence.concurrency !== 1) return fail("기준 API와 같은 단일 요청(c1) 성능 시험이 필요합니다.");
  const needsRevalidation = items.some((item) => experienceItem(item) && item.task?.meta?.warmup !== true &&
    item.attempts?.at(-1)?.score?.state === "measured" &&
    item.attempts.at(-1).score.scorer_version !== BENCH_SCORE_POLICY_V3.outputValidation);
  if (cases.some((c) => c.count !== 3) && needsRevalidation)
    return fail("저장된 성능 결과에 이전 검증 규칙이 남아 있습니다. 앱이 기록을 불러올 때 자동 반영하며 모델을 다시 호출하지 않습니다.");
  if (cases.some((c) => c.count !== 3))
    return fail(`고정 성능 시험에서 영어·한국어·코드·JSON 각 3회가 필요합니다. 현재 유효 표본 ${n}/12건이며 예열·오류·출력 잘림·다른 측정 정의는 제외합니다.`);
  const ratios = cases.flatMap((c) => [c.decodeRatio!, c.ttftRatio!]);
  if (!ratios.every((r) => finite(r) && r > 0)) return fail("기준 대비 비율의 수치 범위를 확인할 수 없습니다.");
  const raw = 1000 * geometric(ratios);
  if (!finite(raw) || raw <= 0) return fail("성능 점수의 수치 범위를 확인할 수 없습니다.");
  const value = indexRound(raw);
  evidence.decodeScore = indexRound(1000 * geometric(cases.map((c) => c.decodeRatio!)));
  evidence.ttftScore = indexRound(1000 * geometric(cases.map((c) => c.ttftRatio!)));
  return { score: { state: "complete", value, lower: value, upper: value, coverage: 100, measuredOnly: null,
    reason: `${ref.model} (${ref.reasoning_effort})의 API 사용성을 1,000점으로 둡니다. 네 유형의 출력 속도·첫 답변 대기 비율을 같은 비중으로 계산하며 성능 점수에는 상한이 없습니다.` } as ScoreEstimate, evidence, cases };
}
export function combineScoresV3(intelligence: ScoreEstimate, performance: ScoreEstimate): ScoreEstimate {
  const lo = intelligence.lower, hi = intelligence.upper, p = performance.value;
  if (!finite(lo) || !finite(hi) || lo < 0 || hi > 100 || hi < lo || !finite(p) || p <= 0)
    return unavailable("지능 평가와 기준 API에 맞춘 성능 시험이 함께 있어야 종합 점수를 산출합니다.");
  const convert = (i: number) => i === 0 ? 0 : 100 * (i / 100) ** 0.7 * Math.min(p / 1000, 1) ** 0.3;
  const partial = intelligence.value == null;
  const lower = partial ? Math.max(0, indexBound(convert(lo), false)) : clamp(round(convert(lo)));
  const upper = partial ? Math.min(100, indexBound(convert(hi), true)) : lower;
  return { state: partial ? "partial" : intelligence.state === "complete" && performance.state === "complete" ? "complete" : "provisional",
    value: partial ? null : lower, lower, upper, coverage: partial ? Math.min(99.9, round(.7 * intelligence.coverage + 30)) : 100,
    measuredOnly: null, reason: "종합은 100점 만점입니다. 지능 70%·API 사용성 30%의 기하평균이며, 기준 API 이상의 성능은 종합에서 만점으로 처리합니다. 비중은 공개된 제품 정책이고 시장 통계로 정한 값이 아닙니다." };
}
export function assessRun(run: Data | null | undefined, ref: FrontierReference = FRONTIER_REFERENCE): FrontierAssessment {
  const record = run || {}, legacy = assessRunV2(record), allItems = uniqueItems(record);
  const qualityItems = allItems.filter((i) => !experienceItem(i));
  const quality = assessRunV1({ ...record, items: qualityItems });
  const performance = assessFrontierPerformance(record, ref);
  const score = performance.score, e = performance.evidence;
  const usability = score.value == null
    ? { label: "API 기준 사용성 측정 필요", detail: score.reason }
    : { label: score.value >= 1000 ? "기준 API 이상의 응답 경험" : "기준 API보다 느린 응답 경험",
      detail: `기준 API 대비 출력 속도 지수 ${Math.round(e.decodeScore!)}점 · 첫 답변 지수 ${Math.round(e.ttftScore!)}점입니다. 각각 1,000점이 기준과 같으며 네트워크·대기·추론이 실제 사용성에 포함됩니다. 정확성은 지능 평가에서 따로 확인합니다.` };
  const comparisonDetails = [
    `기준 ${ref.model} · 추론 ${ref.reasoning_effort} · 측정 ${ref.measured_at || "준비 중"} · 기준 버전 ${ref.id}`,
    "네 가지 고정 입력의 가시 출력 속도·TTFT를 동일한 클라이언트 정의로 비교합니다. 예열은 제외합니다.",
    `출력 검증 ${BENCH_SCORE_POLICY_V3.outputValidation}: 완결된 코드 블록은 측정에 포함하며 원문·토큰·시간은 그대로 사용합니다. 형식 준수는 별도 진단입니다.`,
    `단일 요청 ${record.config?.concurrency ?? "미기록"} · 실행 추론 강도 ${record.config?.reasoning_effort || "기본/미지정"} · API 방식 ${record.config?.api_format || "chat_completions"}`,
    "API 서비스 부하와 네트워크, 모델 토크나이저·출력 분량의 차이는 실제 사용 경험 차이에 포함됩니다. 순수 GPU 처리량 비교는 아닙니다.",
    "지능 점수는 공개 벤치 정답 채점으로 독립 계산합니다. API보다 빠르다고 더 정확하다는 뜻은 아닙니다.",
  ];
  const result: FrontierAssessment = {
    ...legacy, policy: BENCH_SCORE_POLICY_V3.id, intelligence: quality.intelligence,
    performance: score, overall: combineScoresV3(quality.intelligence, score), performanceEvidence: e,
    scoringFailures: quality.scoringFailures, referenceItems: quality.referenceItems, unrecognizedItems: quality.unrecognizedItems,
    usability, reference: ref, experienceCases: performance.cases,
    legacyV2: { intelligence: legacy.intelligence, performance: legacy.performance, overall: legacy.overall },
    comparison: { key: `${BENCH_SCORE_POLICY_V3.id}:${ref.id}`, details: comparisonDetails, complete: score.value != null },
  };
  const guides = guidesFor(record, result).filter((g) => !["latency", "decode", "timing"].includes(g.id)).map((g) => ({ ...g, evidence: g.evidence.replaceAll("v1 지능 구성", "고정 지능 구성") }));
  if (score.value == null) guides.unshift({ id: "frontier", kind: "measurement", title: score.reason.startsWith("저장된 성능 결과") ? "저장된 성능 결과 자동 반영" : "API 사용성 시험을 함께 실행하세요", evidence: score.reason, next: score.reason.startsWith("저장된 성능 결과") ? "기존 응답과 측정값으로 자동 처리합니다. 별도의 시험이나 재계산 작업은 필요하지 않습니다." : "새 시험에서 API 사용성 시험을 선택하거나 성능 측정을 포함한 종합 시험을 실행하세요. 이전 원시 결과와 채점은 그대로 보존됩니다." });
  else if (score.value < 1000) guides.unshift({ id: "frontier-speed", kind: "experience", title: "응답 속도와 첫 답변 대기를 확인하세요", evidence: usability.detail, next: "같은 모델에서 엔진·장비·추론 설정을 하나씩 바꿔 측정하세요. API 연결이라면 통신·서비스 대기 영향도 함께 확인하세요." });
  return { ...result, guides: guides.slice(0, 3) };
}
