/** Mirrors src/metrics_quality.rs. Exclusions describe integrity, not a speed ceiling. */
type Data = Record<string, any>;
export const METRIC_KEYS = ["ttft_ms", "decode_tps", "client_visible_decode_tps", "prefill_tps", "throughput"] as const;
const finite = (v:any):v is number => typeof v === "number" && Number.isFinite(v);
export const metricReason: Record<string,string> = {
  invalid_request_duration:"응답 시간 오류",invalid_value:"유효하지 않은 수치",ttft_exceeds_request:"TTFT가 응답 시간 초과",
  inconsistent_token_counts:"토큰 집계 불일치",visible_token_count_unavailable:"가시 출력 토큰 미제공",
  insufficient_visible_tokens:"가시 출력 토큰 부족",insufficient_stream_chunks:"스트리밍 청크 부족",
  short_visible_interval:"수신 구간이 너무 짧음",interval_exceeds_request:"측정 구간이 응답 시간 초과",
  invalid_server_interval:"서버 측정 구간 오류",inconsistent_server_timing:"서버 시간·토큰 불일치",
  source_unavailable:"측정 출처 미확인",prefill_not_server_measured:"Prefill 실측 근거 없음",
};
export function metricQuality(attempt:Data):Data {
  if (attempt?.metric_quality?.version === "metric-integrity-v1") return attempt.metric_quality;
  const m=attempt?.metrics || {}, valid:Data={}, excluded:Data={}, missing:string[]=[];
  const mismatch = (finite(m.reasoning_tokens)&&finite(m.output_tokens)&&m.reasoning_tokens>m.output_tokens)
    || (finite(m.visible_output_tokens)&&finite(m.output_tokens)&&m.visible_output_tokens>m.output_tokens)
    || ([m.visible_output_tokens,m.reasoning_tokens,m.output_tokens].every(finite)&&m.visible_output_tokens+m.reasoning_tokens!==m.output_tokens);
  const wallBad=!finite(m.wall_ms)||m.wall_ms<=0;
  function visible(v:number) {
    if(mismatch)return "inconsistent_token_counts";
    if(m.visible_output_tokens==null)return "visible_token_count_unavailable";
    if(m.visible_output_tokens<2)return "insufficient_visible_tokens";
    if(m.visible_stream_chunks!=null&&m.visible_stream_chunks<2)return "insufficient_stream_chunks";
    const span=m.visible_decode_span_ms ?? m.visible_output_tokens*1000/v;
    if(!finite(span)||span<100)return "short_visible_interval";
    if(span>m.wall_ms+10)return "interval_exceeds_request";
    return "";
  }
  function native(v:number,ms:any,tokens:any) {
    if(ms!=null&&(!finite(ms)||ms<=0))return "invalid_server_interval";
    if(ms!=null&&ms>m.wall_ms+10)return "interval_exceeds_request";
    if(ms!=null&&tokens!=null){const expected=tokens*1000/ms;if(tokens===0||Math.abs(expected-v)>Math.max(Math.abs(expected)*.05,1))return "inconsistent_server_timing";}
    return "";
  }
  for(const key of METRIC_KEYS.filter(k=>k!=="throughput")){
    const v=m[key];let reason="";
    if(v==null){valid[key]=false;missing.push(key);continue;}
    if(wallBad)reason="invalid_request_duration";
    else if(!finite(v)||v<0||(key!=="ttft_ms"&&v===0))reason="invalid_value";
    else if(key==="ttft_ms"&&v>m.wall_ms+10)reason="ttft_exceeds_request";
    else if(key==="decode_tps"){
      if(m.decode_source==="server")reason=native(v,m.server_decode_ms,m.server_decode_tokens);
      else if(["client_estimate","client_visible_estimate"].includes(m.decode_source))reason=visible(v);
      else reason="source_unavailable";
    }else if(key==="client_visible_decode_tps")reason=visible(v);
    else if(key==="prefill_tps")reason=m.prefill_source==="server"?native(v,m.server_prefill_ms,m.server_prefill_tokens):"prefill_not_server_measured";
    valid[key]=!reason;if(reason)excluded[key]=reason;
  }
  const tokens=m.measurement_version?m.visible_output_tokens:m.output_tokens;
  const reason=wallBad?"invalid_request_duration":mismatch?"inconsistent_token_counts":"";
  valid.throughput=tokens!=null&&!reason;if(tokens==null)missing.push("throughput");else if(reason)excluded.throughput=reason;
  return {version:"metric-integrity-v1",valid,excluded,missing};
}
export function validMetric(attempt:Data,key:string):boolean{return metricQuality(attempt).valid[key]===true;}
