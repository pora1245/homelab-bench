import { useEffect, useRef, useState } from "react";
import type { PointerEvent, KeyboardEvent } from "react";
import { BookOpen, MessageSquare, ArrowDown } from "lucide-react";
import { Help, labels, number, Obj, tips } from "./common";
import { answerComparison } from "./answerComparison";
import { questionPresentation } from "./questionPresentation";
import { taskBenchmarkLabel } from "./benchmarkLabels";
import { judgment } from "./ItemStatus";
import { metricQuality, metricReason, validMetric } from "./metricQuality";
const clampRatio = (v: number) => Math.max(20, Math.min(60, v));
const format = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2);

export function ExamReader({ item }: { item?: Obj }) {
  const [ratio, setRatio] = useState(() => { try { const v = Number(localStorage.getItem("bench-question-height")); return v >= 20 && v <= 60 ? v : 35; } catch { return 35; } });
  const [followOutput, setFollowOutput] = useState(true);
  const frame = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement>(null), dragging = useRef(false);
  const attempt = item?.attempts?.at(-1), score = attempt?.score, comparison = answerComparison(item || {});
  const question = questionPresentation(item?.task || {});
  const quality = metricQuality(attempt || {});
  const metricText = (key: string, unit: string) => validMetric(attempt || {}, key) ? `${number(attempt?.metrics?.[key])} ${unit}` : attempt?.metrics?.[key] != null ? "집계 제외" : "—";
  const exclusion = (key: string) => quality.excluded?.[key] ? `${metricReason[quality.excluded[key]] || "계측 오류"}. 원시 기록은 보존됩니다.` : "";
  const completed = !!item && ["done", "error"].includes(item.status), generating = item?.status === "running";
  const output = attempt?.output || (generating ? "답변 생성 중…" : "답변 대기 중");
  const save = (v: number) => { const next = clampRatio(v); setRatio(next); try { localStorage.setItem("bench-question-height", String(next)); } catch {} };
  const resize = (e: PointerEvent<HTMLDivElement>) => { if (!dragging.current || !frame.current) return; const b = frame.current.getBoundingClientRect(); save((e.clientY - b.top) / b.height * 100); };
  const resizeKey = (e: KeyboardEvent<HTMLDivElement>) => { const v = e.key === "ArrowUp" ? ratio - 5 : e.key === "ArrowDown" ? ratio + 5 : e.key === "Home" ? 20 : e.key === "End" ? 60 : undefined; if (v != null) { e.preventDefault(); save(v); } };
  // Completion must return to the answer comparison, not retain the streaming scroll position.
  useEffect(() => { setFollowOutput(true); if (body.current) body.current.scrollTop = 0; }, [item?.task?.id]);
  useEffect(() => {
    if (!body.current) return;
    if (completed) body.current.scrollTop = 0;
    else if (generating && followOutput) body.current.scrollTop = body.current.scrollHeight;
  }, [attempt?.output, followOutput, generating, completed]);

  return <div ref={frame} className="exam-reader" style={{ gridTemplateRows: `minmax(140px, ${ratio}fr) 12px minmax(240px, ${100 - ratio}fr)` }}>
    <article className="panel question reader-panel">
      <div className="panel-heading"><h2><BookOpen size={17} />문제</h2><span className="pill">{item ? taskBenchmarkLabel(item.task) : "준비 중"}</span></div>
      <div className="reader-scroll question-scroll" tabIndex={0} aria-label="문제 원문"><pre>{question.text || "문항 준비 중"}</pre>{question.fullPrompt && <details key={`${item?.task.id}:prompt`} className="full-response"><summary>모델에 전달한 전체 입력</summary><pre>{question.fullPrompt}</pre></details>}<p className="question-id">{item?.task.id}</p></div>
    </article>
    <div className="reader-divider" role="separator" aria-label="문제와 답변 높이 조절" aria-orientation="horizontal" aria-valuemin={20} aria-valuemax={60} aria-valuenow={Math.round(ratio)} tabIndex={0}
      onPointerDown={e => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); resize(e); }} onPointerMove={resize} onPointerUp={e => { dragging.current = false; e.currentTarget.releasePointerCapture(e.pointerId); }} onPointerCancel={() => { dragging.current = false; }} onLostPointerCapture={() => { dragging.current = false; }} onKeyDown={resizeKey} title="드래그하거나 위·아래 화살표로 높이를 조절합니다"><span /></div>
    <article className="panel answer reader-panel">
      <div className="panel-heading"><h2><MessageSquare size={17} />{completed ? "정답과 답안" : "모델 답변"}</h2><span className={generating ? "live-mark" : "muted"}>{generating ? <><i className="dot pulse" />생성 중</> : labels[item?.status] || "대기"}</span></div>
      <div className="reader-scroll answer-scroll" ref={body} tabIndex={0} aria-label={completed ? "정답과 모델 답안 비교" : "모델 답변 원문"} onScroll={e => { if (generating) { const el = e.currentTarget; setFollowOutput(el.scrollHeight - el.clientHeight - el.scrollTop < 48); } }}>
        {completed ? <>
          {comparison.sameLongAnswer ? <section className="answer-shared" aria-label="기준 정답과 동일한 모델 최종답">
            <div className="comparison-label"><strong>기준 정답 · 모델 최종답</strong><span className="answer-match">동일한 답안</span><Help text="정답 판정과 두 답안의 완전한 문자열 일치를 확인해 본문을 한 번 표시합니다. 모델 답변 원문은 아래에서 확인할 수 있습니다." label="동일 답안 표시 안내" /></div>
            <pre tabIndex={0}>{comparison.referenceText}</pre>
          </section> : <div className="answer-pair" aria-label="정답과 최종 답안">
            <section className="answer-pair-cell reference-cell"><div className="comparison-label"><strong>{comparison.referenceLabel}</strong><Help text={comparison.note} label="답안 비교 안내" /></div><pre tabIndex={0} aria-label={comparison.referenceLabel}>{comparison.referenceText}</pre></section>
            <section className="answer-pair-cell candidate-cell"><div className="comparison-label"><strong>{comparison.candidateLabel}</strong></div><pre tabIndex={0} aria-label={comparison.candidateLabel}>{comparison.candidateText}</pre></section>
          </div>}
          {score && <div className={"score comparison-verdict " + (score.value === 1 ? "pass" : score.value === 0 ? "fail" : "unscored")}><strong>{judgment(item || {}).label}</strong><Help text={score.detail || "저장된 채점 결과입니다."} label="판정 근거" /></div>}
          {attempt?.error && <div className="inline-error">{attempt.error}</div>}
          {comparison.showFullOutput && <details key={`${item?.task.id}:output`} className="full-response"><summary>답변 원문</summary><pre className="model-output">{attempt?.output}</pre></details>}
          {attempt?.reasoning && <details key={`${item?.task.id}:reasoning`} className="full-response"><summary>추론 내용</summary><pre>{attempt.reasoning}</pre></details>}
          <details key={`${item?.task.id}:criteria`} className="comparison-criteria"><summary>채점 근거</summary>
            {score?.detail && <p>{score.detail}</p>}
            {item?.task.answer != null && <pre>{format(item.task.answer)}</pre>}
            {item?.task.meta?.test && <pre aria-label="공식 채점 테스트">{item.task.meta.test}</pre>}
            {item?.task.meta?.test_list && <pre aria-label="공식 채점 테스트">{format(item.task.meta.test_list)}</pre>}
            {item?.task.scorer === "ifeval" && <pre>{format({ conditions: item.task.meta?.instruction_id_list, parameters: item.task.meta?.kwargs, strict: score?.extra?.strict })}</pre>}
            {item?.task.meta?.canonical_solution && <details><summary>공식 예시 풀이</summary><pre>{item.task.meta.canonical_solution}</pre></details>}
            {item?.task.meta?.reference_code && <details><summary>공식 예시 풀이</summary><pre>{item.task.meta.reference_code}</pre></details>}
            <p className="subtle">{score?.scorer_version || item?.task.scorer}</p>
          </details>
        </> : <><pre className="model-output">{output}</pre>{attempt?.error && <div className="inline-error">{attempt.error}</div>}</>}
      </div>
      <div className="reader-footer">
        {generating && !followOutput && <button type="button" className="text-button" onClick={() => setFollowOutput(true)}><ArrowDown size={14} />최신 답변</button>}
        <div className="attempt-meta">
          <span>TTFT <b>{metricText("ttft_ms", "ms")}</b><Help text={exclusion("ttft_ms") || attempt?.metrics?.ttft_reason || tips.TTFT} label="TTFT 설명" /></span>
          <span>Decode <b>{metricText("decode_tps", "tok/s")}</b><Help text={exclusion("decode_tps") || (attempt?.metrics?.decode_source === "server" ? "서버 측정" : attempt?.metrics?.decode_source === "client_estimate" ? "클라이언트 추정" : "속도 미수집")} label="Decode 측정 출처" /></span>
          {attempt?.finish_reason === "length" && <strong className="warning">출력 한도 도달</strong>}
        </div>
      </div>
    </article>
  </div>;
}
