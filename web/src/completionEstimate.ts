import { validMetric } from "./metricQuality";

type Data = Record<string, any>;
export type CompletionEstimate = {
  state: "estimating" | "insufficient" | "paused" | "stopped" | "completed";
  remainingMs: number | null;
  lowerMs: number | null;
  upperMs: number | null;
  finishAtMs: number | null;
  confidence: "low" | "medium";
  samples: number;
  remaining: number;
  unseen: number;
  effectiveConcurrency: number;
  basis: string;
  reason: string;
};
type Observation = {
  group: string; benchmark: string; wall: number; grading: number;
  start: number; end: number; tokens: number | null; speed: number | null;
  speedKind: string | null;
  concurrency: number | null;
};
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const mean = (v: number[]) => v.reduce((sum, n) => sum + n, 0) / v.length;
const quantile = (v: number[], p: number) => {
  const sorted = [...v].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
};
const stamp = (v: unknown) => typeof v === "string" ? Date.parse(v) : NaN;
const last = (i: Data) => i.attempts?.at(-1);
const benchmarkOf = (i: Data) => String(i.task?.id || "").split(":")[0] || String(i.task?.scorer || "unknown");
const groupOf = (i: Data) => `${benchmarkOf(i)}:${i.task?.meta?.level ?? i.task?.meta?.difficulty ?? "all"}`;
const terminal = (i: Data) => ["done", "error"].includes(i.status);

function observation(item: Data, nowMs: number): Observation | null {
  const a = last(item), m = a?.metrics;
  if (!a || !a.ended_at || a.error != null || !positive(m?.wall_ms)) return null;
  const start = stamp(a.started_at), end = stamp(a.ended_at);
  if (!finite(start) || !finite(end) || end <= start || end > nowMs + 10000) return null;
  // Separate grading measurements are preferred. For old records, only use
  // the original grading timestamp (a later rescore is not response latency).
  const extra = a.score?.extra || {}, graded = stamp(extra.graded_at);
  const legacyGrade = !extra.grading_history_count && !extra.grading_history?.length &&
    finite(graded) && graded >= end && graded - end <= 300000 ? graded - end : 0;
  const grading = finite(extra.grading_ms) && extra.grading_ms >= 0 ? extra.grading_ms
    : finite(m.grading_ms) && m.grading_ms >= 0 ? m.grading_ms : legacyGrade;
  let speed: number | null = null, tokens: number | null = null, speedKind: string | null = null;
  // Total output tokens may include reasoning; visible speed may not. Never
  // divide total tokens by visible Decode or add Decode to an existing wall.
  if (m.decode_source === "server" && validMetric(a, "decode_tps") && positive(m.output_tokens)) {
    speed = m.decode_tps; tokens = m.output_tokens; speedKind = "server";
  } else if (validMetric(a, "client_visible_decode_tps") && positive(m.visible_output_tokens)) {
    speed = m.client_visible_decode_tps; tokens = m.visible_output_tokens; speedKind = "visible";
  }
  return { group: groupOf(item), benchmark: benchmarkOf(item), wall: m.wall_ms, grading,
    start, end: end + grading, tokens, speed, speedKind,
    concurrency: positive(m.request_concurrency) ? m.request_concurrency : null };
}

/** Observed concurrency, excluding long idle gaps such as a user pause. */
function parallelism(rows: Observation[], configured: number): number {
  if (configured <= 1 || rows.length < 5) return 1;
  const sorted = [...rows].sort((a, b) => a.start - b.start);
  const typical = quantile(rows.map((r) => r.wall + r.grading), .5);
  let cursor = sorted[0].start, active = 0, sum = 0;
  for (const r of sorted) {
    sum += Math.max(0, r.end - r.start);
    if (r.start > cursor) {
      const gap = r.start - cursor;
      // Small dispatch gaps affect throughput; long pauses do not.
      if (gap <= Math.max(30000, 3 * typical)) active += gap;
    }
    active += Math.max(0, r.end - Math.max(cursor, r.start));
    cursor = Math.max(cursor, r.end);
  }
  return active > 0 ? Math.max(1, Math.min(configured, sum / active)) : 1;
}

/**
 * Pure estimate from recorded responses, grouped by benchmark/difficulty.
 * Explicit nowMs makes tests reproducible; no timers or model calls occur here.
 * The range is a planning envelope, not a statistical confidence interval.
 */
export function estimateCompletion(run: Data | null | undefined, nowMs: number): CompletionEstimate {
  const items: Data[] = run?.items || [];
  const pending = items.filter((i) => !terminal(i));
  const allRows = items.map((i) => observation(i, nowMs)).filter((v): v is Observation => v != null)
    .sort((a, b) => a.end - b.end);
  const segment = run?.execution_segments?.at(-1);
  const segmentStart = stamp(segment?.started_at);
  const configured = positive(segment?.concurrency) ? segment.concurrency
    : positive(run?.config?.concurrency) ? run.config.concurrency : 1;
  const onlyExperienceRemaining = pending.length > 0 && pending.every((i) => benchmarkOf(i) === "experience");
  const timingConcurrency = onlyExperienceRemaining ? 1 : configured;
  // A concurrency change is a new timing regime. Never mix its latency or
  // observed parallelism with previous c1/c4 measurements.
  // Calibration may deliberately use short questions; never extrapolate its
  // batch time or measured gain to the full exam. Await five main observations.
  const rows = allRows.filter((r) => (!finite(segmentStart) || r.start >= segmentStart)
    && (r.concurrency == null || r.concurrency === timingConcurrency)
    && (onlyExperienceRemaining ? r.benchmark === "experience" : r.benchmark !== "experience"));
  const base: CompletionEstimate = {
    state: "insufficient", remainingMs: null, lowerMs: null, upperMs: null, finishAtMs: null,
    confidence: "low", samples: rows.length, remaining: pending.length, unseen: 0,
    effectiveConcurrency: 1, basis: "분야별 응답·채점 시간과 최근 Decode", reason: "처리 기록을 모으는 중",
  };
  if (run?.status === "completed") return { ...base, state: "completed", remainingMs: 0,
    lowerMs: 0, upperMs: 0, remaining: 0, finishAtMs: allRows.length ? allRows.at(-1)!.end : null, reason: "완료" };
  if (["cancelled", "failed", "error"].includes(run?.status))
    return { ...base, state: "stopped", reason: "중단됨" };
  const paused = ["paused", "pausing", "interrupted", "cancelling"].includes(run?.status);
  const tuning = run?.concurrency_tuning;
  if (run?.config?.auto_concurrency === true && tuning?.version === "auto-concurrency-v1" && ["baseline", "testing"].includes(tuning.status)) {
    const c = tuning.rounds?.at(-1)?.concurrency;
    return { ...base, state: paused ? "paused" : "insufficient", samples: 0,
      basis: "실행 방식 선택 후 과목별 응답·채점 시간으로 계산",
      reason: paused ? "실행 방식 확인 일시정지" : tuning.status === "baseline"
        ? "단일 요청 기준 측정 중" : positive(c) ? `동시 ${c}개 처리 효과 확인 중` : "동시 처리 효과 확인 중" };
  }
  if (rows.length < 5 || !pending.length || !positive(nowMs))
    return { ...base, state: paused ? "paused" : "insufficient", reason: paused ? "재개 후 재계산"
      : run?.status === "scoring" ? "재채점 중" : run?.execution_segments?.length > 1 ? "동시 요청 변경 후 재계산 중" : "처리 기록을 모으는 중" };

  // Last 100 observations in each domain keep the estimate responsive without
  // allowing the last single difficult item to determine the entire exam.
  const byGroup = new Map<string, Observation[]>(), byBenchmark = new Map<string, Observation[]>();
  for (const r of rows) {
    byGroup.set(r.group, [...(byGroup.get(r.group) || []).slice(-99), r]);
    byBenchmark.set(r.benchmark, [...(byBenchmark.get(r.benchmark) || []).slice(-99), r]);
  }
  const recent = rows.slice(-100), fallback = rows.slice(-300);
  const speeds = new Map<string, number>();
  for (const kind of ["server", "visible"]) {
    const values = recent.filter((r) => r.speedKind === kind && positive(r.speed)).map((r) => r.speed!);
    if (values.length >= 5) speeds.set(kind, quantile(values, .5));
  }
  const adjust = (r: Observation) => {
    const speed = r.speedKind ? speeds.get(r.speedKind) : undefined;
    if (!positive(speed) || !positive(r.speed) || !positive(r.tokens)) return r.wall + r.grading;
    const generated = r.tokens / r.speed * 1000;
    // Inconsistent token/rate definitions cannot explain the observed wall.
    if (generated > r.wall * 1.05) return r.wall + r.grading;
    return Math.max(0, r.wall - generated) + r.tokens / speed * 1000 + r.grading;
  };
  const concurrency = parallelism(recent, timingConcurrency);
  let central = 0, low = 0, high = 0, unseen = 0;
  const estimates = new Map<string, { unknown: boolean; typical: number; lower: number; upper: number; gradeMean: number; gradeHigh: number }>();
  for (const item of pending) {
    const key = groupOf(item);
    let estimate = estimates.get(key);
    if (!estimate) {
      const groupRows = byGroup.get(key) || [];
      const benchmarkRows = byBenchmark.get(benchmarkOf(item)) || [];
      const available = groupRows.length >= 5 ? groupRows : benchmarkRows.length >= 5 ? benchmarkRows : fallback;
      const values = available.map(adjust), typical = mean(values), grades = available.map((r) => r.grading);
      estimate = { unknown: benchmarkRows.length < 5, typical,
        lower: Math.min(typical * .85, quantile(values, .25)),
        upper: Math.max(typical * 1.25, quantile(values, .9)),
        gradeMean: mean(grades), gradeHigh: quantile(grades, .9), };
      estimates.set(key, estimate);
    }
    const { unknown, typical } = estimate;
    if (unknown) unseen++;
    let center = typical;
    let lower = estimate.lower;
    let upper = estimate.upper;
    if (unknown) { lower *= .5; upper *= 3; }
    const a = last(item);
    if (["grading", "scoring"].includes(item.status) && a?.ended_at) {
      center = Math.max(200, estimate.gradeMean); lower = 0; upper = Math.max(1000, estimate.gradeHigh * 2);
    } else if (item.status === "running" && a?.started_at) {
      const elapsed = Math.max(0, nowMs - stamp(a.started_at));
      if (finite(elapsed)) {
        // An overdue response is still running, not automatically complete.
        center = Math.max(typical * .25, center - elapsed);
        lower = Math.max(0, lower - elapsed);
        upper = Math.max(center * 1.5, upper - elapsed);
      }
    }
    // Fixed response-experience cases run serially even in a concurrent exam.
    const divisor = benchmarkOf(item) === "experience" ? 1 : concurrency;
    central += center / divisor; low += lower / divisor; high += upper / divisor;
  }
  return { ...base, state: paused ? "paused" : "estimating", remainingMs: Math.round(central),
    lowerMs: Math.round(low), upperMs: Math.round(high), finishAtMs: paused ? null : nowMs + Math.round(central),
    confidence: unseen || rows.length < 30 ? "low" : "medium", unseen, effectiveConcurrency: concurrency,
    reason: paused ? "재개 후 재계산" : unseen ? "미측정 분야는 추정 · 과목별 진행에 따라 갱신" : "최근 처리 속도 반영",
  };
}

export function estimateDuration(ms: number | null): string {
  if (!finite(ms)) return "—";
  if (ms <= 0) return "0분";
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return `${hours}시간${rest ? ` ${rest}분` : ""}`;
}
