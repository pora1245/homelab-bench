type Data = Record<string, any>;
export const THROUGHPUT_DEFINITION = "현재 동시 요청 구간의 완료된 유효 응답이 생성한 전체 출력 토큰(추론 포함)을 첫 요청 시작부터 마지막 응답 완료까지의 시간으로 나눕니다. Prefill·요청 사이 채점·대기·일시정지를 포함하며, 개별 요청의 Decode 속도와 다릅니다. 진행 중 요청은 최종 토큰 수를 받기 전까지 제외되므로 재개 직후 수치가 흔들릴 수 있습니다. 가시 출력·추론 분해는 같은 유효 응답 모두가 해당 토큰 수를 제공한 경우에만 표시합니다.";
export const throughputReason: Record<string,string> = {
  invalid_token_count:"토큰 수 형식 오류", inconsistent_token_counts:"출력·추론·가시 토큰 불일치",
  invalid_request_duration:"응답 시간 오류", invalid_timestamp:"요청 시각 오류", token_sum_overflow:"토큰 합계 범위 초과",
};
const count = (v:unknown):v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const stamp = (v:unknown) => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v) ? Date.parse(v) : NaN;

/** Same request-concurrency fallback as Run::request_concurrency; no mutation. */
function requestConcurrency(run:Data, attempt:Data):number {
  if (count(attempt.metrics?.request_concurrency)) return attempt.metrics.request_concurrency;
  const start = stamp(attempt.started_at);
  for (const segment of [...(run.execution_segments || [])].reverse()) {
    const at = stamp(segment.started_at);
    if (Number.isFinite(at) && start >= at && count(segment.concurrency)) return segment.concurrency;
  }
  return run.config?.concurrency;
}

/**
 * Total output throughput for the current execution segment. The existing
 * API output_throughput_tps is not reused: it means visible-output throughput.
 * Optional breakdowns share the total's exact numerator sample set and span.
 */
export function aggregateThroughput(run:Data | null | undefined) {
  const record = run || {}, segment = record.execution_segments?.at(-1);
  const segmentStart = stamp(segment?.started_at);
  const concurrency = count(segment?.concurrency) ? segment.concurrency : record.config?.concurrency;
  let eligible=0, missing=0, excluded=0, ignoredPrevious=0, otherConcurrency=0;
  let n=0, total=0, visible=0, reasoning=0, visibleKnown=0, reasoningKnown=0;
  let first=Infinity, last=-Infinity;
  const reasons:Record<string,number>={};
  const exclude = (reason:string) => { excluded++; reasons[reason]=(reasons[reason] || 0)+1; };
  for (const item of record.items || []) {
    const a=item.attempts?.at(-1), m=a?.metrics || {};
    if (!a || !["done","error","grading"].includes(item.status) || !a.ended_at || a.error != null || item.task?.meta?.warmup === true) continue;
    const start=stamp(a.started_at), end=stamp(a.ended_at);
    // Match the backend's current segment / actual request concurrency scope.
    if (Number.isFinite(segmentStart) && !(start >= segmentStart)) { ignoredPrevious++; continue; }
    if (requestConcurrency(record,a) !== concurrency) { otherConcurrency++; continue; }
    eligible++;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) { exclude("invalid_timestamp"); continue; }
    if (typeof m.wall_ms !== "number" || !Number.isFinite(m.wall_ms) || m.wall_ms <= 0) { exclude("invalid_request_duration"); continue; }
    const t=m.output_tokens, v=m.visible_output_tokens, r=m.reasoning_tokens;
    if ([t,v,r].some(value=>value!=null&&!count(value))) { exclude("invalid_token_count"); continue; }
    if (t == null) { missing++; continue; }
    if ((v!=null && v>t) || (r!=null && r>t) || (v!=null && r!=null && v+r!==t)) { exclude("inconsistent_token_counts"); continue; }
    if (!Number.isSafeInteger(total+t) || (v!=null&&!Number.isSafeInteger(visible+v)) || (r!=null&&!Number.isSafeInteger(reasoning+r))) { exclude("token_sum_overflow"); continue; }
    n++; total+=t;
    if (v!=null) { visible+=v; visibleKnown++; }
    if (r!=null) { reasoning+=r; reasoningKnown++; }
    first=Math.min(first,start); last=Math.max(last,end);
  }
  const span=n>0 ? last-first : null;
  const usable=record.provenance === "live_api" && span!=null && span>0;
  const visibleComplete=n>0&&visibleKnown===n, reasoningComplete=n>0&&reasoningKnown===n;
  return {
    version:"total-output-throughput-v1", tps:usable?total*1000/span!:null,
    visible_tps:usable&&visibleComplete?visible*1000/span!:null,
    reasoning_tps:usable&&reasoningComplete?reasoning*1000/span!:null,
    total_tokens:n?total:null, visible_tokens:visibleComplete?visible:null, reasoning_tokens:reasoningComplete?reasoning:null,
    n, eligible, missing, excluded, reasons, visible_known_n:visibleKnown, reasoning_known_n:reasoningKnown,
    span_ms:span, started_at:n?new Date(first).toISOString():null, ended_at:n?new Date(last).toISOString():null,
    scope:{started_at:segment?.started_at || null,concurrency,request_count:eligible,ignored_previous_requests:ignoredPrevious,other_concurrency_requests:otherConcurrency},
  };
}
