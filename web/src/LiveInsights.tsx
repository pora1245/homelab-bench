import {useEffect,useMemo,useState} from "react";
import {estimateCompletion,estimateDuration} from "./completionEstimate";
import {duration,Help,Obj,time} from "./common";
import {metricReason} from "./metricQuality";
import {aggregateThroughput,throughputReason} from "./throughput";
export const PreflightLabel:Record<string,string>={response:"응답",ttft_ms:"TTFT",decode_tps:"Decode",client_visible_decode_tps:"가시 출력 Decode",prefill_tps:"Prefill",input_tokens:"입력 토큰",output_tokens:"출력 토큰",reasoning_tokens:"추론 토큰",reasoning_ttft_ms:"첫 추론 토큰",finish_reason:"종료 상태",device:"장비 연결",device_utilization_pct:"GPU 사용률",device_temperature_c:"GPU 온도",device_power_w:"GPU 전력"};
export function TimingSummary({run,elapsedMs}:{run:Obj;elapsedMs:number}){
 const [now,setNow]=useState(Date.now());useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),15000);return()=>clearInterval(t);},[]);
 const eta=useMemo(()=>estimateCompletion(run,now),[run,now]);
 const tuning=run.config?.auto_concurrency === true && ["baseline","testing"].includes(run.concurrency_tuning?.status);
 const selection=run.config?.auto_concurrency === true && ["completed","unavailable"].includes(run.concurrency_tuning?.status) && run.concurrency_tuning?.reason
  ? `자동 선택 c${run.concurrency_tuning.selected_concurrency || 1} · ${String(run.concurrency_tuning.reason).replace(/[.。]+$/, "")}. ` : "";
 const waiting=tuning&&run.status!=="paused"?"효과 확인 중":eta.state==="paused"?"재개 후":eta.state==="stopped"?"중단":"계산 중";
 const remaining=eta.state==="estimating"||eta.state==="completed"?estimateDuration(eta.remainingMs):waiting;
 const finish=eta.finishAtMs!=null&&["estimating","completed"].includes(eta.state)?time(new Date(eta.finishAtMs).toISOString()):waiting;
 const elapsed=elapsedMs>=3600000?`${Math.floor(elapsedMs/3600000)}시간 ${Math.floor(elapsedMs/60000)%60}분`:duration(elapsedMs);
 return <div className="timing-summary" aria-label="시험 시간" title={tuning ? eta.reason : undefined}>
  <div><span>경과</span><b>{elapsed}</b></div>
  <div><span>남음</span><b>{remaining}</b></div>
  <div><span>{eta.state==="completed"?"완료":"완료 예상"}<Help label="시험 시간 도움말" text={`${selection}경과 시간은 시험 실행 시간을 합산합니다. ${eta.reason}. ${eta.basis}. ${eta.remainingMs!=null?`예상 범위 ${estimateDuration(eta.lowerMs)}–${estimateDuration(eta.upperMs)}. `:""}${eta.confidence==="low"&&eta.state==="estimating"?"아직 측정하지 않은 구간의 추정값을 포함합니다. ":""}문항 구성·답변 길이·동시 처리량에 따라 달라집니다.`}/></span><b>{finish}</b></div>
 </div>;
}
export function MetricCoverage({run,expanded=false}:{run:Obj;expanded?:boolean}){
 const total=aggregateThroughput(run);
 const q=run.summary?.metric_quality;if(!q)return null;
 const keys=["ttft_ms","decode_tps","client_visible_decode_tps","prefill_tps","throughput"];
 const issues=total.excluded+total.missing>0||keys.some(k=>(q.metrics?.[k]?.excluded||0)+(q.metrics?.[k]?.missing||0)>0);
 const recent=keys.filter(k=>(q.recent_missing?.[k]||0)>0);
 return <details className={`metric-coverage ${issues?"has-issues":""}`} open={expanded||undefined}>
  <summary>{!q.eligible?"계측 대기":issues?"계측 누락·제외 있음":"계측 정상"}</summary>
  {recent.length>0&&<p>최근 {q.recent_sample_count}건 미수집: {recent.map(k=>k==="throughput"?"가시 출력 Throughput":PreflightLabel[k]||k).join(" · ")}</p>}
  <div className="coverage-table"><div><b>Throughput · 추론 포함</b><span>{total.n}/{total.eligible}건</span><span>제외 {total.excluded} · 미수집 {total.missing}</span>{Object.entries(total.reasons).map(([reason,count])=><small key={reason}>{throughputReason[reason]||reason} {count}건</small>)}</div>{keys.map(k=>{const row=q.metrics?.[k]||{};return <div key={k}><b>{k==="throughput"?"가시 출력 Throughput":PreflightLabel[k]||k}</b><span>{row.valid||0}/{q.eligible||0}건</span><span>제외 {row.excluded||0} · 미수집 {row.missing||0}</span>
  {Object.entries(row.reasons||{}).map(([reason,count])=><small key={reason}>{metricReason[reason]||reason} {String(count)}건</small>)}</div>;})}</div>
  <p>원본은 보존하며, 검증에 실패한 계측값만 집계에서 제외합니다.</p>
 </details>;
}
