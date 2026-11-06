import { useId, useState } from "react";
import { Obj, number } from "./common";

export function judgment(item: Obj) {
  const attempt = item.attempts?.at(-1), score = attempt?.score;
  if (item.status === "running") return { key: "running", label: "생성 중", symbol: "…" };
  if (["grading", "scoring"].includes(item.status)) return { key: "waiting", label: "채점 중", symbol: "…" };
  // Cancellation/restart preserves the interrupted attempt under a pending item.
  // A new running/grading attempt above always takes precedence over that history.
  if (item.status === "pending" && (item.verdict === "interrupted" || (typeof attempt?.error === "string" && attempt.error.includes("중단"))))
    return { key: "cancelled", label: "중단", symbol: "−" };
  if (attempt?.error || item.status === "error") return { key: "error", label: "요청 오류", symbol: "!" };
  if (typeof score?.value === "number" && Number.isFinite(score.value) && score.value >= 0 && score.value <= 1 && score.state === "scored") {
    if (score.value === 1) return { key: "correct", label: "정답", symbol: "✓" };
    if (score.value === 0) return { key: "incorrect", label: "오답", symbol: "×" };
    return { key: "partial", label: `부분 점수 ${number(score.value * 100)}점`, symbol: "◐" };
  }
  if (score?.state === "measured" && score.extra?.valid_output === false) return { key: "unavailable", label: "출력 검증 실패", symbol: "!" };
  if (score?.state === "measured") return { key: "measured", label: "측정 완료", symbol: "✓" };
  if (score?.state === "invalid_output") return { key: "unavailable", label: "출력 검증 실패", symbol: "!" };
  if (score?.extra?.error_code === "source_incomplete") return { key: "unavailable", label: "원본 자료 불완전 · 채점 제외", symbol: "!" };
  if (score?.extra?.error_code === "source_conflict") return { key: "unavailable", label: "원본 정답 상충 · 채점 제외", symbol: "!" };
  if (score) return { key: "unavailable", label: "채점 실패", symbol: "!" };
  if (item.status === "cancelled" || item.status === "interrupted") return { key: "cancelled", label: "중단", symbol: "−" };
  if (attempt?.ended_at) return { key: "waiting", label: "채점 대기", symbol: "…" };
  return { key: "pending", label: "미시작", symbol: "·" };
}
export function correctness(items: Obj[]): Record<string, any> {
  const counts: Record<string, number> = {};
  items.forEach((item) => { const key = judgment(item).key; counts[key] = (counts[key] || 0) + 1; });
  const scored = (counts.correct || 0) + (counts.incorrect || 0) + (counts.partial || 0);
  return { ...counts, scored, rate: scored ? 100 * (counts.correct || 0) / scored : null };
}
export function ItemStatus({ items, current, page, onPage, onSelect }: {
  items: Obj[]; current: number; page: number; onPage: (page: number) => void; onSelect: (index: number) => void;
}) {
  const [expanded, setExpanded] = useState(() => {
    try { return localStorage.getItem("bench-item-status-expanded") !== "false"; }
    catch { return true; }
  });
  const contentId = useId();
  const pages = Math.max(1, Math.ceil(items.length / 50));
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    try { localStorage.setItem("bench-item-status-expanded", String(next)); }
    catch { /* The control still works when storage is unavailable. */ }
  };
  return <section className="item-status-panel" aria-label="문항별 판정">
    <div className="item-status-heading"><strong>문항별 판정</strong>
      <span className="item-status-summary">전체 {number(items.length, 0)}문항 · {Number.isInteger(current) && current >= 0 && current < items.length ? `현재 ${number(current + 1, 0)}번` : "현재 문항 없음"}</span>
      <button type="button" className="item-status-toggle" aria-expanded={expanded} aria-controls={contentId} aria-label={`문항별 판정 ${expanded ? "접기" : "펼치기"}`} onClick={toggle}><span aria-hidden="true">{expanded ? "▾" : "▸"}</span>{expanded ? "접기" : "펼치기"}</button>
    </div>
    <div id={contentId} className="item-status-content">{expanded && <>
    <div className="item-status-toolbar"><span>문항을 누르면 답변과 판정 근거를 확인합니다</span>
      {pages > 1 && <div className="item-controls"><button type="button" disabled={!page} aria-label="이전 판정 목록" onClick={() => onPage(page - 1)}>‹</button><span>{page + 1} / {pages}</span><button type="button" disabled={page + 1 >= pages} aria-label="다음 판정 목록" onClick={() => onPage(page + 1)}>›</button></div>}
    </div>
    <div className="item-status-grid">{items.slice(page * 50, page * 50 + 50).map((item, i) => {
      const index = page * 50 + i, state = judgment(item);
      return <button key={item.task.id} className={`question-state ${state.key} ${index === current ? "selected" : ""}`} aria-label={`${index + 1}번 문항 · ${state.label}`} aria-current={index === current ? "true" : undefined} title={`${item.task.id} · ${state.label}`} onClick={() => onSelect(index)}><span>{index + 1}</span><b>{state.symbol}</b></button>;
    })}</div>
    <div className="item-state-legend"><span>✓ 정답·측정 완료</span><span>× 오답</span><span>◐ 부분 점수</span><span>… 생성·채점 중</span><span>! 요청·채점 실패</span><span>· 미시작</span></div>
    </>}</div>
  </section>;
}
