import frontierReferenceData from "./frontier-reference.json";
import concurrentReferenceData from "./frontier-concurrent-reference.json";
import { validMetric } from "./metricQuality";
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
  baselineDecode?: number | null;
  baselineTtft?: number | null;
  segmentStartedAt?: string | null;
  observedCount?: number;
  excludedCount?: number;
  excludedReasons?: Record<string, number>;
  concurrentDecodeTps?: number | null;
  decodeActiveMs?: number | null;
  decodeTokenCount?: number | null;
  effectiveDecodeConcurrency?: number | null;
  peakDecodeConcurrency?: number | null;
  aggregateIssue?: string;
  singleScore?: number | null;
  singleN?: number;
  singleSource?: "ordinary" | "calibration" | "legacy-experience" | "none";
  singleBenchmarkCounts?: Record<string, number>;
  concurrencyBonus?: number | null;
  concurrencyBonusPercent?: number | null;
  throughputGain?: number | null;
  completionGain?: number | null;
  bonusState?: "measured" | "no_gain" | "unmeasured" | "invalid" | "pending";
  bonusReason?: string;
  bonusConcurrency?: number | null;
  bonusSampleCount?: number;
  legacySingleCount?: number;
  legacySingleScore?: number | null;
  cacheControl?: string;
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
  concurrent_baseline?: {
    id: string; status: string; aggregation: string; source_reference_id: string;
    measurement_version: string; concurrency: number; sample_count: number;
    decode_token_count: number; decode_active_ms: number; decode_tps: number; ttft_median_ms: number;
    minimum_visible_tokens: number; minimum_decode_span_ms: number;
  };
};
export const FRONTIER_REFERENCE: FrontierReference = frontierReferenceData;
export const CONCURRENT_FRONTIER_REFERENCE: FrontierReference = {
  ...FRONTIER_REFERENCE, concurrent_baseline: concurrentReferenceData,
};
export const BENCH_SCORE_POLICY_V3 = Object.freeze({
  id: "bench-api-experience-v3.1", protocol: "api-experience-v1", outputValidation: "api-experience-output-v2", baselineScore: 1000,
  repeatsPerCase: 3, overallIntelligenceWeight: 0.7, overallPerformanceWeight: 0.3,
});
export type CaseEvidence = { id: ExperienceCase; count: number; decode: number | null; ttft: number | null; decodeRatio: number | null; ttftRatio: number | null };
export type FrontierAssessment = Assessment & {
  legacyV2: Pick<AssessmentV1, "intelligence" | "performance" | "overall">;
  reference: FrontierReference;
  experienceCases: CaseEvidence[];
  /** Display-only observed scores. Completion bounds and historical indices stay above. */
  currentScores: CurrentScores;
};

export type CurrentScores = {
  intelligence: ScoreEstimate;
  performance: ScoreEstimate;
  overall: ScoreEstimate;
  evaluatedBenchmarks: number;
  totalBenchmarks: number;
  evaluatedDomains: string[];
  scored: number;
  selected: number;
};

/**
 * The provisional headline uses each observed benchmark's mean at its fixed
 * weight, normalized over observed weights only. Thus 1,000 MMLU items do not
 * overpower 50 math items. This is an observed-part score, never an imputation
 * for missing domains. Final bounds above retain their original meaning.
 */
export function currentScores(
  run: Data,
  benchmarks: BenchmarkEvidence[],
  intelligence: ScoreEstimate,
  performance: ScoreEstimate,
): CurrentScores {
  const observed = benchmarks.filter((b) => b.scored > 0);
  const weight = observed.reduce((sum, b) => sum + b.weight, 0);
  const value = weight > 0
    ? round(100 * observed.reduce((sum, b) => sum + b.weight * b.points / b.scored, 0) / weight)
    : null;
  const domain = (id: string) => ["gsm8k", "math500"].includes(id) ? "수학"
    : id === "mmlu-pro" ? "지식·추론" : id === "ifeval" ? "지시 이행" : "코딩";
  const evaluatedDomains = [...new Set(observed.map((b) => domain(b.id)))];
  const currentIntelligence: ScoreEstimate = value == null ? intelligence : {
    ...intelligence, value, measuredOnly: value,
    reason: intelligence.state === "complete" ? "전체 평가 완료"
      : `채점된 ${evaluatedDomains.join("·")} 기준 잠정 점수입니다. 미평가 영역은 포함하지 않았습니다.`,
  };
  // Use a point for the provisional combination, without replacing the saved
  // completion bounds. Retain incomplete coverage/state on the display result.
  const combined = value == null ? unavailable("지능·성능 측정 필요")
    : combineScoresV3({ ...currentIntelligence, lower: value, upper: value }, performance);
  if (combined.value != null) {
    combined.coverage = intelligence.coverage;
    combined.state = intelligence.state === "complete" && performance.state === "complete"
      ? "complete" : intelligence.state === "partial" ? "partial" : "provisional";
    combined.reason = combined.state === "complete" ? "전체 평가 완료" : "현재 지능·성능에 따른 잠정 점수";
  }
  return {
    intelligence: currentIntelligence, performance, overall: combined,
    evaluatedBenchmarks: observed.length, totalBenchmarks: benchmarks.length,
    evaluatedDomains, scored: benchmarks.reduce((n, b) => n + b.scored, 0),
    selected: benchmarks.reduce((n, b) => n + b.selected, 0),
  };
}
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
        (m?.request_concurrency ?? run.config?.concurrency) === 1 &&
        m?.measurement_version === "client-visible-v1" && m?.ttft_source === "client_visible_stream" && finite(m?.ttft_ms) && m.ttft_ms > 0 &&
        finite(m?.client_visible_decode_tps) && m.client_visible_decode_tps > 0 &&
        validMetric(a, "ttft_ms") && validMetric(a, "client_visible_decode_tps");
    });
    const decode = median(valid.map((i) => i.attempts.at(-1).metrics.client_visible_decode_tps));
    const ttft = median(valid.map((i) => i.attempts.at(-1).metrics.ttft_ms));
    return { id, count: valid.length, decode, ttft,
      decodeRatio: ready && decode != null ? decode / b!.decode_tps : null,
      ttftRatio: ready && ttft != null ? b!.ttft_ms / ttft : null };
  });
  const n = cases.reduce((sum, c) => sum + c.count, 0);
  const evidence: PerformanceEvidence = {
    pairedCount: n, requiredCount: 12, concurrency: n > 0 ? 1 : finite(run.config?.concurrency) ? run.config.concurrency : null,
    decodeMedian: median(cases.filter((c) => c.decode != null).map((c) => c.decode!)),
    ttftMedian: median(cases.filter((c) => c.ttft != null).map((c) => c.ttft!)),
    decodeScore: null, ttftScore: null, sources: n ? { client_visible_stream: n } : {},
  };
  const fail = (reason: string) => ({ score: unavailable(reason), evidence, cases });
  if (!ready) return fail("프론티어 API 기준 측정을 완료하면 성능 점수가 표시됩니다.");
  const pendingFixedPerformance = items.some((item) =>
    EXPERIENCE_CASES.some((id) => [1, 2, 3].some((r) => item.task?.id === `experience:${id}:${r}`)) &&
    item.task?.meta?.performance_protocol === BENCH_SCORE_POLICY_V3.protocol &&
    !["done", "error"].includes(item.status));
  if (pendingFixedPerformance && cases.some((c) => c.count !== 3))
    return fail("성능 측정 대기 · 이 시험의 c1 고정 성능 문항이 완료되면 점수가 자동으로 표시됩니다.");
  if (evidence.concurrency !== 1 && !items.some((item) => experienceItem(item) && item.attempts?.at(-1)?.metrics?.request_concurrency === 1))
    return fail("기준 API와 같은 단일 요청(c1) 성능 시험이 필요합니다.");
  const needsRevalidation = items.some((item) => experienceItem(item) && item.task?.meta?.warmup !== true &&
    item.attempts?.at(-1)?.score?.state === "measured" &&
    item.attempts.at(-1).score.scorer_version !== BENCH_SCORE_POLICY_V3.outputValidation);
  if (cases.some((c) => c.count !== 3) && needsRevalidation)
    return fail("저장된 성능 결과에 이전 검증 규칙이 남아 있습니다. 앱이 기록을 불러올 때 자동 반영하며 모델을 다시 호출하지 않습니다.");
  if (cases.some((c) => c.count !== 3)) {
    const terminal = items.filter((item) =>
      EXPERIENCE_CASES.some((id) => [1, 2, 3].some((r) => item.task?.id === `experience:${id}:${r}`)) &&
      item.task?.meta?.performance_protocol === BENCH_SCORE_POLICY_V3.protocol &&
      ["done", "error"].includes(item.status) && item.attempts?.length);
    const limited = terminal.filter((item) => item.attempts.at(-1).finish_reason === "length");
    const details: string[] = [];
    if (limited.length) {
      const labels: Record<ExperienceCase, string> = { english: "영어", korean: "한국어", code: "코드", structured: "JSON" };
      const groups = EXPERIENCE_CASES.flatMap((id) => {
        const count = limited.filter((item) => item.task.id.startsWith(`experience:${id}:`)).length;
        return count ? [`${labels[id]} ${count}건`] : [];
      });
      details.push(`출력 한도 도달: ${groups.join(", ")}`);
    }
    const normal = terminal.filter((item) => {
      const a = item.attempts.at(-1);
      return a.error == null && a.finish_reason === "stop";
    });
    const invalidOutputs = normal.filter((item) => item.attempts.at(-1).score?.extra?.valid_output === false).length;
    if (invalidOutputs) details.push(`출력 검증 실패 ${invalidOutputs}건`);
    const missingMetrics = normal.filter((item) => {
      const a = item.attempts.at(-1), m = a.metrics;
      return a.score?.extra?.valid_output === true &&
        (m?.ttft_ms == null || m?.client_visible_decode_tps == null);
    }).length;
    if (missingMetrics) details.push(`TTFT·Decode 계측 누락 ${missingMetrics}건`);
    const requestErrors = terminal.filter((item) => item.attempts.at(-1).error != null).length;
    if (requestErrors) details.push(`요청 실패 ${requestErrors}건`);
    if (details.length) return fail(`성능 미산출 · ${details.join(" · ")} · 정상 유효 ${n}/12건`);
    return fail(`고정 성능 시험에서 영어·한국어·코드·JSON 각 3회가 필요합니다. 현재 유효 표본 ${n}/12건이며 예열·오류·출력 잘림·다른 측정 정의는 제외합니다.`);
  }
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
    return unavailable("지능 채점 결과와 성능 점수를 계산할 수 있는 시험 계측 기록이 필요합니다.");
  const convert = (i: number) => i === 0 ? 0 : 100 * (i / 100) ** 0.7 * Math.min(p / 1000, 1) ** 0.3;
  const partial = intelligence.value == null;
  const lower = partial ? Math.max(0, indexBound(convert(lo), false)) : clamp(round(convert(lo)));
  const upper = partial ? Math.min(100, indexBound(convert(hi), true)) : lower;
  return { state: partial ? "partial" : intelligence.state === "complete" && performance.state === "complete" ? "complete" : "provisional",
    value: partial ? null : lower, lower, upper, coverage: partial ? Math.min(99.9, round(.7 * intelligence.coverage + 30)) : 100,
    measuredOnly: null, reason: "종합은 100점 만점입니다. 지능 70%·API 사용성 30%의 기하평균이며, 기준 API 이상의 성능은 종합에서 만점으로 처리합니다. 비중은 공개된 제품 정책이고 시장 통계로 정한 값이 아닙니다." };
}
/** Historical fixed-prompt v3 policy; retained only for result reproduction. */
export function assessRunV3(run: Data | null | undefined, ref: FrontierReference = FRONTIER_REFERENCE): FrontierAssessment {
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
    `시험 동시 요청 ${record.config?.concurrency ?? "미기록"} · 성능 측정 동시 요청 ${e.concurrency ?? "미기록"} · 실행 추론 강도 ${record.config?.reasoning_effort || "기본/미지정"} · API 방식 ${record.config?.api_format || "chat_completions"}`,
    "API 서비스 부하와 네트워크, 모델 토크나이저·출력 분량의 차이는 실제 사용 경험 차이에 포함됩니다. 순수 GPU 처리량 비교는 아닙니다.",
    "지능 점수는 공개 벤치 정답 채점으로 독립 계산합니다. API보다 빠르다고 더 정확하다는 뜻은 아닙니다.",
  ];
  const result: FrontierAssessment = {
    ...legacy, policy: BENCH_SCORE_POLICY_V3.id, intelligence: quality.intelligence,
    performance: score, overall: combineScoresV3(quality.intelligence, score), performanceEvidence: e,
    scoringFailures: quality.scoringFailures, referenceItems: quality.referenceItems, unrecognizedItems: quality.unrecognizedItems,
    usability, reference: ref, experienceCases: performance.cases,
    currentScores: currentScores(record, quality.benchmarks, quality.intelligence, score),
    legacyV2: { intelligence: legacy.intelligence, performance: legacy.performance, overall: legacy.overall },
    comparison: { key: `${BENCH_SCORE_POLICY_V3.id}:${ref.id}`, details: comparisonDetails, complete: score.value != null },
  };
  const guides = guidesFor(record, result).filter((g) => !["latency", "decode", "timing"].includes(g.id)).map((g) => ({ ...g, evidence: g.evidence.replaceAll("v1 지능 구성", "고정 지능 구성") }));
  const pendingPerformance = allItems.some((item) => experienceItem(item) && !["done", "error"].includes(item.status));
  const terminalFixedPerformance = allItems.some((item) =>
    EXPERIENCE_CASES.some((id) => [1, 2, 3].some((r) => item.task?.id === `experience:${id}:${r}`)) &&
    item.task?.meta?.performance_protocol === BENCH_SCORE_POLICY_V3.protocol &&
    ["done", "error"].includes(item.status));
  if (score.value == null) guides.unshift(pendingPerformance
    ? { id: "frontier", kind: "measurement", title: "성능 측정 대기", evidence: `유효 측정 ${e.pairedCount}/12건`, next: "이 시험의 성능 문항이 끝나면 점수가 갱신됩니다." }
    : terminalFixedPerformance && !score.reason.startsWith("저장된 성능 결과")
      ? { id: "frontier", kind: "measurement", title: "성능 측정 결과 확인", evidence: score.reason, next: "출력 한도·추론 설정을 바꾸면 기준 API와의 비교 조건도 달라집니다." }
    : { id: "frontier", kind: "measurement", title: score.reason.startsWith("저장된 성능 결과") ? "저장된 성능 결과 자동 반영" : "API 사용성 시험을 함께 실행하세요", evidence: score.reason, next: score.reason.startsWith("저장된 성능 결과") ? "기존 응답과 측정값으로 자동 처리합니다. 별도의 시험이나 재계산 작업은 필요하지 않습니다." : "새 시험에서 API 사용성 시험을 선택하거나 성능 측정을 포함한 종합 시험을 실행하세요. 이전 원시 결과와 채점은 그대로 보존됩니다." });
  else if (score.value < 1000) guides.unshift({ id: "frontier-speed", kind: "experience", title: "응답 속도와 첫 답변 대기를 확인하세요", evidence: usability.detail, next: "같은 모델에서 엔진·장비·추론 설정을 하나씩 바꿔 측정하세요. API 연결이라면 통신·서비스 대기 영향도 함께 확인하세요." });
  return { ...result, guides: guides.slice(0, 3) };
}

export const BENCH_SCORE_POLICY_V4 = Object.freeze({
  id: "bench-live-api-v4.1", baselineScore: 1000, minimumPairedRequests: 1,
  measurementVersion: "client-visible-v1", baselineAggregation: "concurrent-visible-decode-union",
  sampleAggregation: "concurrent-visible-decode-union", minimumVisibleTokens: 2, minimumDecodeSpanMs: 100,
  decodeWeight: 0.5, ttftWeight: 0.5,
  overallIntelligenceWeight: 0.7, overallPerformanceWeight: 0.3,
});

/** Derived from the same original Sol 12 responses; the v3 reference is immutable. */
export function frontierBaseline(ref: FrontierReference = CONCURRENT_FRONTIER_REFERENCE) {
  const b = ref.concurrent_baseline;
  if (!referenceReady(ref) || !b || b.status !== "ready" || !b.id || b.source_reference_id !== ref.id ||
      b.aggregation !== BENCH_SCORE_POLICY_V4.baselineAggregation ||
      b.measurement_version !== BENCH_SCORE_POLICY_V4.measurementVersion || b.concurrency !== 1 ||
      b.minimum_visible_tokens !== BENCH_SCORE_POLICY_V4.minimumVisibleTokens ||
      b.minimum_decode_span_ms !== BENCH_SCORE_POLICY_V4.minimumDecodeSpanMs ||
      !Number.isSafeInteger(b.sample_count) || b.sample_count < 1 ||
      !Number.isSafeInteger(b.decode_token_count) || b.decode_token_count < BENCH_SCORE_POLICY_V4.minimumVisibleTokens ||
      !finite(b.decode_active_ms) || b.decode_active_ms <= 0 ||
      !finite(b.decode_tps) || b.decode_tps <= 0 || !finite(b.ttft_median_ms) || b.ttft_median_ms <= 0 ||
      Math.abs(b.decode_token_count * 1000 / b.decode_active_ms - b.decode_tps) > b.decode_tps * 1e-6)
    return { decode: null, ttft: null };
  return { decode: b.decode_tps, ttft: b.ttft_median_ms };
}

const requestStamp = (value: unknown) => typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
  ? Date.parse(value) : NaN;
const concurrencyValue = (value: unknown): value is number => finite(value) && Number.isInteger(value) && value >= 1;
function actualConcurrency(run: Data, attempt: Data): number | null {
  if (concurrencyValue(attempt.metrics?.request_concurrency)) return attempt.metrics.request_concurrency;
  const start = requestStamp(attempt.started_at);
  for (const segment of [...(run.execution_segments || [])].reverse()) {
    const at = requestStamp(segment.started_at);
    if (finite(at) && start >= at && concurrencyValue(segment.concurrency)) return segment.concurrency;
  }
  return concurrencyValue(run.config?.concurrency) ? run.config.concurrency : null;
}
const ordinaryItem = (item: Data) => !experienceItem(item) && item.task?.scorer !== "experience" &&
  item.task?.meta?.performance_protocol !== "api-experience-v1" && item.task?.meta?.warmup !== true;

/**
 * V4 uses measurements already produced by ordinary exam answers. A single
 * valid pair produces a provisional score; no separate prompts or retries.
 * Both axes use the same completed-response sample. Decode is visible tokens
 * per union of actual visible decoding intervals; TTFT remains actual latency.
 * Neither configured concurrency nor reasoning-inclusive server rate is multiplied in.
 */
export function assessLivePerformance(run: Data, ref: FrontierReference = CONCURRENT_FRONTIER_REFERENCE) {
  const segment = run.execution_segments?.at(-1), segmentStart = requestStamp(segment?.started_at);
  const concurrency = concurrencyValue(segment?.concurrency) ? segment.concurrency
    : concurrencyValue(run.config?.concurrency) ? run.config.concurrency : null;
  const baseline = frontierBaseline(ref), items = uniqueItems(run).filter(ordinaryItem);
  const paired: Data[] = [], sampleIds: string[] = [], reasons: Record<string, number> = {};
  const intervals: { start: number; end: number; span: number; tokens: number }[] = [];
  let observed = 0;
  const exclude = (reason: string) => { reasons[reason] = (reasons[reason] || 0) + 1; };
  for (const item of items) {
    const a = item.attempts?.at(-1), m = a?.metrics;
    if (!a || !["done", "error", "grading"].includes(item.status) || !a.ended_at) continue;
    const start = requestStamp(a.started_at), end = requestStamp(a.ended_at);
    if (finite(segmentStart) && !(start >= segmentStart)) continue;
    if (actualConcurrency(run, a) !== concurrency) continue;
    observed++;
    if (!finite(start) || !finite(end) || end <= start) { exclude("invalid_timestamp"); continue; }
    if (a.error != null) { exclude("request_error"); continue; }
    if (a.finish_reason !== "stop") { exclude(a.finish_reason === "length" ? "output_limit" : "incomplete_response"); continue; }
    if (m?.measurement_version !== BENCH_SCORE_POLICY_V4.measurementVersion || m?.ttft_source !== "client_visible_stream") {
      exclude("measurement_definition"); continue;
    }
    if (m?.ttft_ms == null || m?.client_visible_decode_tps == null) { exclude("missing_pair"); continue; }
    if (!finite(m.ttft_ms) || m.ttft_ms <= 0 || !finite(m.client_visible_decode_tps) || m.client_visible_decode_tps <= 0 ||
      !validMetric(a, "ttft_ms") || !validMetric(a, "client_visible_decode_tps")) { exclude("invalid_pair"); continue; }
    const tokens = m.visible_output_tokens;
    if (!Number.isSafeInteger(tokens) || tokens < BENCH_SCORE_POLICY_V4.minimumVisibleTokens) { exclude("short_visible_output"); continue; }
    const span = m.visible_decode_span_ms ?? tokens * 1000 / m.client_visible_decode_tps;
    if (!finite(span) || span < BENCH_SCORE_POLICY_V4.minimumDecodeSpanMs || !finite(m.wall_ms) || m.wall_ms <= 0 ||
        m.ttft_ms + span > m.wall_ms + 10 || start + m.ttft_ms + span > end + 10) { exclude("invalid_decode_interval"); continue; }
    if (Math.abs(end - start - m.wall_ms) > Math.max(100, m.wall_ms * .01)) { exclude("clock_duration_mismatch"); continue; }
    const expectedRate = tokens * 1000 / span;
    if (Math.abs(expectedRate - m.client_visible_decode_tps) > Math.max(.01, expectedRate * .01)) { exclude("inconsistent_visible_rate"); continue; }
    paired.push(a);
    sampleIds.push(String(item.task.id));
    intervals.push({ start: start + m.ttft_ms, end: start + m.ttft_ms + span, span, tokens });
  }
  const n = paired.length;
  // Use an origin near the observations before sweep arithmetic, reducing
  // cancellation with epoch milliseconds. Disjoint intervals exclude pauses.
  const origin = intervals.length ? intervals.reduce((first, v) => Math.min(first, v.start), Infinity) : 0;
  const events = intervals.flatMap((v) => [{ at: v.start - origin, change: 1 }, { at: v.end - origin, change: -1 }])
    .sort((a, b) => a.at - b.at || a.change - b.change);
  let active = 0, previous = 0, unionMs = 0, peak = 0;
  for (const event of events) {
    if (active > 0) unionMs += event.at - previous;
    active += event.change;
    peak = Math.max(peak, active);
    previous = event.at;
  }
  const tokenCount = intervals.reduce((sum, v) => sum + v.tokens, 0);
  const sumMs = intervals.reduce((sum, v) => sum + v.span, 0);
  const aggregateIssue = n && (!Number.isSafeInteger(tokenCount) || !finite(unionMs) || unionMs <= 0) ? "invalid_decode_total"
    : n && concurrency == null ? "unknown_concurrency"
    : n && concurrency != null && peak > concurrency ? "concurrency_overlap" : "";
  const concurrentDecode = n && !aggregateIssue ? tokenCount * 1000 / unionMs : null;
  const evidence: PerformanceEvidence = {
    pairedCount: n, requiredCount: 1, concurrency,
    decodeMedian: median(paired.map((a) => a.metrics.client_visible_decode_tps)),
    ttftMedian: median(paired.map((a) => a.metrics.ttft_ms)),
    decodeScore: null, ttftScore: null, sources: n ? { client_visible_stream: n } : {},
    baselineDecode: baseline.decode, baselineTtft: baseline.ttft,
    segmentStartedAt: finite(segmentStart) ? segment.started_at : null,
    observedCount: observed, excludedCount: observed - n, excludedReasons: reasons,
    concurrentDecodeTps: concurrentDecode, decodeActiveMs: n ? unionMs : null, decodeTokenCount: n ? tokenCount : null,
    effectiveDecodeConcurrency: n && unionMs > 0 ? sumMs / unionMs : null,
    peakDecodeConcurrency: n ? peak : null, aggregateIssue,
  };
  const fail = (reason: string) => ({ score: unavailable(reason), evidence, sampleIds });
  if (baseline.decode == null || baseline.ttft == null) return fail("프론티어 API 기준 실측 자료를 확인할 수 없습니다.");
  if (!n) return fail(observed
    ? `현재 동시 요청 구간의 완료 응답 ${observed}건에 유효한 TTFT·Decode 쌍이 없습니다.`
    : "이 시험의 답변에서 TTFT·Decode가 측정되면 성능 점수가 표시됩니다.");
  if (aggregateIssue) return fail(aggregateIssue === "concurrency_overlap"
    ? "가시 Decode 구간의 실제 중첩이 기록된 동시 요청 수를 초과합니다. 요청 시각을 확인하세요."
    : aggregateIssue === "unknown_concurrency" ? "동시 요청 수가 기록되지 않아 가시 Decode 구간을 검증할 수 없습니다."
    : "가시 Decode 구간과 토큰 합계를 확인할 수 없습니다.");
  const decodeRatio = concurrentDecode! / baseline.decode, ttftRatio = baseline.ttft / evidence.ttftMedian!;
  const value = indexRound(1000 * geometric([decodeRatio, ttftRatio]));
  if (!finite(value) || value <= 0) return fail("성능 점수의 수치 범위를 확인할 수 없습니다.");
  evidence.decodeScore = indexRound(1000 * decodeRatio);
  evidence.ttftScore = indexRound(1000 * ttftRatio);
  const completed = run.status === "completed" && items.every((item) => ["done", "error"].includes(item.status));
  const state: ScoreState = completed ? "complete"
    : ["cancelled", "failed", "error"].includes(run.status) ? "partial" : "provisional";
  const score: ScoreEstimate = {
    state, value, lower: value, upper: value, coverage: round(100 * n / observed), measuredOnly: value,
    reason: `${completed ? "최종" : "잠정"} 성능 · 이 시험의 유효 응답 ${n}건 · 동시 요청 ${concurrency ?? "미기록"}. ${ref.model} 실측을 1,000점으로 환산합니다.`,
  };
  return { score, evidence, sampleIds };
}

/** Current public assessment. Fixed performance packs never gate v4 scores. */
export function assessRunV4(run: Data | null | undefined, ref: FrontierReference = CONCURRENT_FRONTIER_REFERENCE): FrontierAssessment {
  const record = run || {}, legacy = assessRunV2(record), allItems = uniqueItems(record);
  const qualityItems = allItems.filter(ordinaryItem);
  const quality = assessRunV1({ ...record, items: qualityItems });
  const { score, evidence: e, sampleIds } = assessLivePerformance(record, ref);
  const baseComparison = comparisonFor(record, qualityItems);
  const modelKnown = typeof record.config?.model === "string" && !!record.config.model.trim();
  const comparisonKey = conditionFingerprint({
    previousConditions: baseComparison.key, policy: BENCH_SCORE_POLICY_V4.id,
    model: modelKnown ? record.config.model : null, apiFormat: record.config?.api_format || "chat_completions",
    reference: { id: ref.id, model: ref.model, measuredAt: ref.measured_at,
      baselineDecode: e.baselineDecode, baselineTtft: e.baselineTtft,
      aggregation: BENCH_SCORE_POLICY_V4.baselineAggregation, derivedId: ref.concurrent_baseline?.id },
    measurementVersion: BENCH_SCORE_POLICY_V4.measurementVersion,
    sampleAggregation: BENCH_SCORE_POLICY_V4.sampleAggregation,
    scope: { startedAt: e.segmentStartedAt, concurrency: e.concurrency }, sampleIds,
  });
  const usability = score.value == null ? { label: "성능 측정 대기", detail: score.reason } : {
    label: score.value >= 1000 ? "기준 API 이상의 응답 경험" : "기준 API보다 느린 응답 경험",
    detail: `출력 속도 지수 ${Math.round(e.decodeScore!)}점 · 첫 답변 지수 ${Math.round(e.ttftScore!)}점 · 유효 응답 ${e.pairedCount}건. 각각 1,000점이 기준과 같습니다.`,
  };
  const result: FrontierAssessment = {
    ...legacy, ...quality, policy: BENCH_SCORE_POLICY_V4.id,
    performance: score, overall: combineScoresV3(quality.intelligence, score), performanceEvidence: e,
    usability, reference: ref, experienceCases: [],
    currentScores: currentScores(record, quality.benchmarks, quality.intelligence, score),
    legacyV2: { intelligence: legacy.intelligence, performance: legacy.performance, overall: legacy.overall },
    comparison: { key: `${BENCH_SCORE_POLICY_V4.id}:${comparisonKey}`,
      complete: baseComparison.complete && modelKnown && referenceReady(ref) && score.value != null, details: [
      ...baseComparison.details.filter((s) => !s.startsWith("성능 계산에 사용한 정상 paired 표본"))
        .map((s) => s.replace("성능 측정 출처(Decode/TTFT):", "기록된 계측 출처(Decode/TTFT):")),
      `기준 ${ref.model} · 추론 ${ref.reasoning_effort} · 측정 ${ref.measured_at || "준비 중"} · 기준 버전 ${ref.id}`,
      "기존 Sol 12응답의 가시 토큰/Decode 구간 합집합과 TTFT 중앙값을 같은 방식으로 재집계한 파생 기준을 사용합니다. 원본 기준 자료는 유지합니다.",
      "현재 동시 요청 구간의 정상 일반 응답에서 가시 출력 토큰 합계를 실제 Decode 구간 합집합 시간으로 나눕니다. TTFT는 같은 응답들의 중앙값입니다.",
      "성능 = 1,000 × √((동시 가시 Decode/기준 Decode) × (기준 TTFT/TTFT)). 설정 동시 수를 곱하거나 TTFT를 나누지 않습니다. 추론·Prefill·대기는 Decode 구간에서 제외되며 전체 Throughput과 다릅니다.",
      `유효 응답 ${e.pairedCount}건 · 동시 요청 ${e.concurrency ?? "미기록"} · 추론 ${record.config?.reasoning_effort || "기본/미지정"} · API ${record.config?.api_format || "chat_completions"}`,
      "문항 구성·출력 길이·추론·동시 요청·서비스 부하·네트워크가 다른 실제 API 사용성 지수입니다. 동일 문항을 통제한 엔진·GPU 성능 비교가 아닙니다.",
      ...(modelKnown ? [] : ["확인 불가: 시험 모델 식별 정보"]),
    ] },
  };
  const guides = guidesFor(record, result).filter((g) => !["latency", "decode", "timing"].includes(g.id))
    .map((g) => ({ ...g, evidence: g.evidence.replaceAll("v1 지능 구성", "고정 지능 구성") }));
  if (score.value == null) {
    const terminal = ["completed", "cancelled", "failed", "error"].includes(record.status);
    guides.unshift({ id: "frontier", kind: "measurement", title: terminal ? "성능 계측 확인" : "성능 측정 대기", evidence: score.reason,
      next: terminal ? "저장된 응답의 계측 누락·제외 사유를 확인하세요."
        : record.status === "paused" ? "이 시험을 재개해 응답의 계측값이 반영되면 자동으로 갱신됩니다."
        : "진행 중인 시험 응답의 계측값이 반영되면 자동으로 갱신됩니다." });
  }
  else if (score.value < 1000) guides.unshift({ id: "frontier-speed", kind: "experience", title: "응답 속도와 첫 답변 대기를 확인하세요", evidence: usability.detail,
    next: "현재 문항·추론·동시 요청 조건을 함께 확인하세요. 성능 지수는 지능 점수와 별도로 해석합니다." });
  return { ...result, guides: guides.slice(0, 3) };
}

/** Single-request experience is the base; matched parallel work can only add a bonus. */
export const BENCH_SCORE_POLICY_V5 = Object.freeze({
  id: "bench-single-bonus-v5", baselineScore: 1000,
  measurementVersion: "client-visible-v1", minimumThroughputGain: 1.1, minimumCompletionGain: 1.1,
  bonusPerDoubling: 0.1, maximumBonus: 0.3,
  decodeWeight: 0.5, ttftWeight: 0.5,
  overallIntelligenceWeight: 0.7, overallPerformanceWeight: 0.3,
});

function requestConcurrencyV5(run: Data, attempt: Data): number | null {
  const explicit = attempt.metrics?.request_concurrency ?? attempt.request_concurrency;
  if (explicit != null) return concurrencyValue(explicit) ? explicit : null;
  const start = requestStamp(attempt.started_at);
  const segments = [...(run.execution_segments || [])].sort((a, b) => requestStamp(b.started_at) - requestStamp(a.started_at));
  for (const segment of segments) {
    if (finite(start) && start >= requestStamp(segment.started_at))
      return concurrencyValue(segment.concurrency) ? segment.concurrency : null;
  }
  if (concurrencyValue(run.initial_concurrency)) return run.initial_concurrency;
  // Config may have changed after old responses. Only use it if there is no
  // recorded transition; otherwise an unknown old request stays unknown.
  return !segments.length && concurrencyValue(run.config?.concurrency) ? run.config.concurrency : null;
}

const tuningSettingsKeys = ["base_url", "model", "api_format", "temperature", "max_tokens", "reasoning_effort", "reasoning_parameters", "execution_info"] as const;
function tuningSettingsMatch(run: Data): boolean {
  const t = run.concurrency_tuning, snapshot = t?.settings_snapshot;
  return t?.version === "auto-concurrency-v1" && /^[a-f0-9]{64}$/.test(t.settings_fingerprint || "") &&
    snapshot && tuningSettingsKeys.every((key) => Object.hasOwn(snapshot, key) &&
      stable(snapshot[key] ?? null) === stable(run.config?.[key] ?? null));
}

/** Recheck the saved selected round, not a faster-looking subset or a new winner. */
function verifiedTuningRound(run: Data, index: unknown, requireScored = true): { round: Data; samples: Data[]; throughput: number } | null {
  const t = run.concurrency_tuning;
  if (!tuningSettingsMatch(run) || !Number.isInteger(index) || (index as number) < 0) return null;
  const r = t.rounds?.[index as number], ids = t.sample_ids;
  if (!r || r.status !== "completed" || r.settings_fingerprint !== t.settings_fingerprint ||
      !concurrencyValue(r.concurrency) || !finite(r.elapsed_ms) || r.elapsed_ms <= 0 ||
      !Array.isArray(ids) || !ids.length || ids.some((id: unknown) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length ||
      !Array.isArray(r.samples) || r.samples.length !== ids.length) return null;
  const roundStart = requestStamp(r.started_at), roundEnd = requestStamp(r.ended_at);
  if (!finite(roundStart) || !finite(roundEnd) || roundEnd <= roundStart || r.elapsed_ms > roundEnd - roundStart + 100) return null;
  const rows = new Map<string, Data>();
  let tokens = 0, sumWall = 0, maxWall = 0;
  for (const s of r.samples) {
    const a = s.attempt, m = a?.metrics;
    if (!ids.includes(s.task_id) || rows.has(s.task_id) || !/^[a-f0-9]{64}$/.test(s.prompt_sha256 || "") ||
        !a || a.error != null || !["stop", "eos", "end_turn"].includes(a.finish_reason) || !m ||
        !Number.isSafeInteger(m.output_tokens) || m.output_tokens <= 0 ||
        !finite(m.wall_ms) || m.wall_ms <= 0 || a.metric_quality?.valid?.throughput === false) return null;
    if (requireScored && (a.score?.state !== "scored" || !finite(a.score.value) || a.score.value < 0 || a.score.value > 1)) return null;
    if (m.request_concurrency != null && m.request_concurrency !== r.concurrency) return null;
    for (const key of ["visible_output_tokens", "reasoning_tokens"]) {
      if (m[key] != null && (!Number.isSafeInteger(m[key]) || m[key] < 0 || m[key] > m.output_tokens)) return null;
    }
    if (m.visible_output_tokens != null && m.reasoning_tokens != null && m.visible_output_tokens + m.reasoning_tokens !== m.output_tokens) return null;
    const start = requestStamp(a.started_at), end = requestStamp(a.ended_at);
    if (!finite(start) || !finite(end) || start < roundStart - 100 || end > roundEnd + 100 || end <= start ||
        Math.abs(end - start - m.wall_ms) > Math.max(100, m.wall_ms * .01)) return null;
    tokens += m.output_tokens; sumWall += m.wall_ms; maxWall = Math.max(maxWall, m.wall_ms);
    rows.set(s.task_id, s);
  }
  if (!Number.isSafeInteger(tokens) || !finite(sumWall) || r.elapsed_ms + 100 < Math.max(maxWall, sumWall / r.concurrency)) return null;
  const throughput = tokens * 1000 / r.elapsed_ms;
  if (!finite(throughput) || throughput <= 0 || (r.throughput_tps != null &&
      (!finite(r.throughput_tps) || Math.abs(r.throughput_tps - throughput) > Math.max(.01, throughput * .01)))) return null;
  return { round: r, samples: ids.map((id: string) => rows.get(id)!), throughput };
}

type BonusEvidence = Pick<PerformanceEvidence, "bonusState" | "bonusReason" | "throughputGain" | "completionGain" | "bonusConcurrency" | "bonusSampleCount" | "cacheControl"> & { fraction: number };
export function assessConcurrencyBonus(run: Data): BonusEvidence {
  const t = run.concurrency_tuning;
  const result: BonusEvidence = { fraction: 0, bonusState: "unmeasured", bonusReason: "동일 문항의 단일·동시 요청 비교가 기록되지 않았습니다.", throughputGain: null, completionGain: null, bonusConcurrency: null, bonusSampleCount: 0 };
  if (!t) return result;
  result.cacheControl = t.cache_control;
  if (["baseline", "testing"].includes(t.status)) return run.config?.auto_concurrency === true
    ? { ...result, bonusState: "pending", bonusReason: "동일 문항의 동시 처리 효과를 확인하고 있습니다." }
    : { ...result, bonusReason: "자동 비교가 중단되어 단일 요청 점수만 표시합니다." };
  const fail = (reason: string): BonusEvidence => ({ ...result, bonusState: "invalid", bonusReason: reason });
  if (t.status !== "completed" || !tuningSettingsMatch(run)) return fail("완료된 동일 설정 비교 근거가 없어 단일 요청 점수만 표시합니다.");
  const baseline = verifiedTuningRound(run, t.baseline_round_index);
  if (!baseline || baseline.round.concurrency !== 1 || baseline.samples.length < 2) return fail("단일 요청 비교 기준의 완결성·계측을 확인할 수 없습니다.");
  if (t.selected_concurrency === 1) return { ...result, bonusState: "no_gain", bonusReason: "동시 처리 이득이 확인되지 않아 단일 요청 점수를 유지합니다.", bonusConcurrency: 1, bonusSampleCount: baseline.samples.length };
  const selected = verifiedTuningRound(run, t.selected_round_index);
  if (!selected || selected.round.concurrency !== t.selected_concurrency || selected.round.concurrency <= 1 ||
      !concurrencyValue(t.max_concurrency) || t.max_concurrency > 8 || selected.round.concurrency > t.max_concurrency ||
      selected.samples.some((s, n) => s.task_id !== baseline.samples[n].task_id || s.prompt_sha256 !== baseline.samples[n].prompt_sha256 ||
        s.attempt.score.value < baseline.samples[n].attempt.score.value))
    return fail("동시 요청의 문항·설정·정상 완료 근거가 단일 요청 비교 기준과 일치하지 않습니다.");
  const gain = selected.throughput / baseline.throughput, completionGain = baseline.round.elapsed_ms / selected.round.elapsed_ms;
  if (!finite(gain) || !finite(completionGain) || !finite(t.throughput_gain) || !finite(t.completion_gain) ||
      Math.abs(gain - t.throughput_gain) > Math.max(.0001, gain * .01) ||
      Math.abs(completionGain - t.completion_gain) > Math.max(.0001, completionGain * .01))
    return fail("저장된 동시 처리 증가율이 원시 토큰·완료 시간과 일치하지 않습니다.");
  const measured = { ...result, throughputGain: gain, completionGain, bonusConcurrency: selected.round.concurrency, bonusSampleCount: baseline.samples.length };
  if (gain < BENCH_SCORE_POLICY_V5.minimumThroughputGain || completionGain < BENCH_SCORE_POLICY_V5.minimumCompletionGain)
    return { ...measured, bonusState: "no_gain", bonusReason: "처리량과 완료 시간 모두에서 10% 이상의 이득이 없어 가산하지 않습니다." };
  return { ...measured, bonusState: "measured", bonusReason: "동일 문항·설정의 전체 출력 Throughput 및 완료 시간 개선을 확인했습니다.",
    fraction: Math.min(BENCH_SCORE_POLICY_V5.maximumBonus, BENCH_SCORE_POLICY_V5.bonusPerDoubling * Math.log2(gain)) };
}

/** All valid ordinary c1 history is retained when the run changes to c4/c8. */
export function assessSingleBonusPerformance(run: Data, ref: FrontierReference = CONCURRENT_FRONTIER_REFERENCE) {
  const allItems = uniqueItems(run);
  const singleItems = (items: Data[], accept: (attempt: Data) => boolean = () => true): Data[] => items.flatMap((i) =>
    (i.attempts || []).flatMap((a: Data, index: number) => requestConcurrencyV5(run, a) === 1 && accept(a) ? [{
      ...i, task: { ...i.task, id: i.attempts.length > 1 ? `${i.task.id}:attempt:${index}` : i.task.id },
      // A later retry must not erase a completed earlier c1 observation.
      status: a.ended_at ? (a.error == null ? "done" : "error") : i.status,
      attempts: [{ ...a, finish_reason: ["eos", "end_turn"].includes(a.finish_reason) ? "stop" : a.finish_reason,
        metrics: { ...a.metrics, request_concurrency: 1 } }],
    }] : []));
  const assess = (items: Data[]) => assessLivePerformance({ ...run, config: { ...run.config, concurrency: 1 }, execution_segments: [], items }, ref);
  const ordinary = singleItems(allItems.filter(ordinaryItem));
  let measured = assess(ordinary), used = ordinary;
  let source: NonNullable<PerformanceEvidence["singleSource"]> = measured.score.value == null ? "none" : "ordinary";

  const legacyItems = singleItems(allItems.filter((i) => experienceItem(i) && i.task?.meta?.warmup !== true &&
      i.task?.meta?.performance_protocol === BENCH_SCORE_POLICY_V3.protocol),
    (a) => a.score?.state === "measured" && a.score?.scorer_version === BENCH_SCORE_POLICY_V3.outputValidation && a.score?.extra?.valid_output === true)
    .map((i) => ({ ...i, task: { ...i.task, id: `legacy-c1:${i.task.id}`, scorer: "legacy-timing", meta: {} } }));
  const legacy = assess(legacyItems);
  if (source === "none") {
    const baseline = verifiedTuningRound(run, run.concurrency_tuning?.baseline_round_index, false);
    if (baseline?.round.concurrency === 1) {
      const calibrationItems = baseline.samples.map((s) => ({ task: { id: s.task_id, scorer: "calibration-timing" }, status: "done",
        attempts: [{ ...s.attempt, finish_reason: ["eos", "end_turn"].includes(s.attempt.finish_reason) ? "stop" : s.attempt.finish_reason,
          metrics: { ...s.attempt.metrics, request_concurrency: 1 } }] }));
      const calibration = assess(calibrationItems);
      if (calibration.score.value != null) { measured = calibration; used = calibrationItems; source = "calibration"; }
      else if (!measured.evidence.observedCount && calibration.evidence.observedCount) {
        // Retain the reason a recorded probe was rejected (for example a
        // too-short visible interval), rather than reporting it as absent.
        measured = calibration; used = calibrationItems;
      }
    }
  }
  if (source === "none" && legacy.score.value != null) { measured = legacy; used = legacyItems; source = "legacy-experience"; }
  const bonus = assessConcurrencyBonus(run), base = measured.score.value;
  const fraction = bonus.bonusState === "measured" ? bonus.fraction : 0;
  const total = base == null ? null : indexRound(base * (1 + fraction));
  const counts: Record<string, number> = {};
  const validIds = new Set(measured.sampleIds);
  for (const i of used) if (validIds.has(String(i.task.id))) {
    const id = source === "legacy-experience" ? "legacy-experience" : benchmarkKey(i.task) || "custom";
    counts[id] = (counts[id] || 0) + 1;
  }
  const e: PerformanceEvidence = { ...measured.evidence,
    singleScore: base, singleN: measured.evidence.pairedCount, singleSource: source, singleBenchmarkCounts: counts,
    concurrencyBonus: total == null || !["measured", "no_gain"].includes(bonus.bonusState!) ? null : indexRound(total - base!),
    // null distinguishes "not measured" from a measured zero-gain result.
    concurrencyBonusPercent: ["measured", "no_gain"].includes(bonus.bonusState!) ? round(100 * fraction) : null,
    throughputGain: bonus.throughputGain, completionGain: bonus.completionGain,
    bonusState: bonus.bonusState, bonusReason: bonus.bonusReason, bonusConcurrency: bonus.bonusConcurrency,
    bonusSampleCount: bonus.bonusSampleCount, cacheControl: bonus.cacheControl,
    legacySingleCount: legacy.evidence.pairedCount, legacySingleScore: legacy.score.value,
  };
  const sourceText = source === "calibration" ? "시작 비교의 단일 요청" : source === "legacy-experience" ? "저장된 단일 요청 성능 문항" : "이 시험의 단일 요청";
  const score = total == null ? unavailable("유효한 단일 요청 TTFT·Decode가 아직 기록되지 않았습니다.") : {
    ...measured.score, value: total, lower: total, upper: total, measuredOnly: total,
    reason: `${sourceText} ${e.singleN}건 기준 ${base}점${bonus.bonusState === "measured" ? ` + 동시 처리 ${e.concurrencyBonusPercent}%` : bonus.bonusState === "no_gain" ? " · 동시 가산 없음" : " · 동시 처리 가산 미확정"}. ${ref.model} 실측은 1,000점입니다.`,
  };
  return { score, evidence: e, sampleIds: measured.sampleIds };
}

/** Current public assessment: ordinary scores never include calibration answers. */
export function assessRun(run: Data | null | undefined, ref: FrontierReference = CONCURRENT_FRONTIER_REFERENCE): FrontierAssessment {
  const record = run || {}, previous = assessRunV4(record, ref);
  const { score, evidence: e, sampleIds } = assessSingleBonusPerformance(record, ref);
  const baseComparison = comparisonFor(record, uniqueItems(record).filter(ordinaryItem));
  const key = conditionFingerprint({ conditions: baseComparison.key, policy: BENCH_SCORE_POLICY_V5.id,
    reference: ref.concurrent_baseline, model: record.config?.model, sampleIds,
    source: e.singleSource, tuning: record.concurrency_tuning ? {
      settings: record.concurrency_tuning.settings_fingerprint, baseline: record.concurrency_tuning.baseline_round_index,
      selected: record.concurrency_tuning.selected_round_index, gain: e.throughputGain, bonusState: e.bonusState,
    } : null });
  const bonusLabel = e.bonusState === "measured" ? `동시 처리 가산 ${e.concurrencyBonusPercent}%`
    : e.bonusState === "no_gain" ? "동시 가산 없음" : "동시 가산 미측정";
  const usability = score.value == null ? { label: "성능 측정 대기", detail: score.reason } : {
    label: score.value >= 1000 ? "기준 API 이상의 성능 지수" : "기준 API보다 낮은 성능 지수",
    detail: `단일 요청 ${Math.round(e.singleScore!)}점 · ${bonusLabel} · 단일 요청 유효 ${e.singleN}건`,
  };
  const result: FrontierAssessment = { ...previous, policy: BENCH_SCORE_POLICY_V5.id, performance: score,
    overall: combineScoresV3(previous.intelligence, score), performanceEvidence: e, usability,
    currentScores: currentScores(record, previous.benchmarks, previous.intelligence, score),
    comparison: { key: `${BENCH_SCORE_POLICY_V5.id}:${key}`, complete: baseComparison.complete && referenceReady(ref) && score.value != null, details: [
      ...baseComparison.details.filter((s) => !s.startsWith("성능 계산에 사용한 정상 paired 표본")),
      `기준 ${ref.model} · 추론 ${ref.reasoning_effort} · 측정 ${ref.measured_at || "준비 중"} · 기준 버전 ${ref.id}`,
      "단일 요청 기본점수 = 1,000 × √((단일 가시 Decode/기준 Decode) × (기준 TTFT/단일 TTFT)). 같은 Sol 12응답에서 재집계한 기준이며 원본 자료는 유지합니다.",
      "동시 처리 가산 = 기본점수 × min(30%, 10% × log₂(실측 Throughput 증가율)). 동일 문항·설정에서 정상 완료하고 처리량·완료 시간 모두 10% 이상 개선된 경우에만 적용하는 베타 정책입니다.",
      "동시 요청의 길어진 TTFT는 단일 요청 기본점수에 반영하지 않습니다. 동시 수를 곱해 처리량을 추정하지 않습니다.",
      `단일 요청 ${e.singleN}건 · 출처 ${e.singleSource} · ${bonusLabel}`,
      e.bonusReason || "",
      "문항 구성·출력 길이·추론·서비스 부하·네트워크가 다른 API 사용성 지수입니다. 캐시 정책은 공급자 기본값이며 이 지수만으로 GPU·엔진 우열을 단정하지 않습니다.",
    ].filter(Boolean) },
  };
  const guides = guidesFor(record, result).filter((g) => !["latency", "decode", "timing"].includes(g.id));
  if (score.value == null) guides.unshift({ id: "frontier", kind: "measurement", title: "단일 요청 계측 확인", evidence: score.reason,
    next: ["completed", "cancelled", "failed", "error"].includes(record.status) ? "저장된 응답의 단일 요청 기록과 제외 사유를 확인하세요." : "진행 중인 시험에서 단일 요청 계측이 반영되면 자동으로 표시됩니다." });
  else if (e.singleScore! < 1000) guides.unshift({ id: "frontier-speed", kind: "experience", title: "단일 요청 속도와 첫 답변 대기를 확인하세요", evidence: usability.detail,
    next: "모델·추론 설정과 서비스 대기를 함께 확인하세요. 동시 처리 이득은 별도로 가산합니다." });
  return { ...result, guides: guides.slice(0, 3) };
}
