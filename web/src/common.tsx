import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleHelp } from "lucide-react";

export type Obj = Record<string, any>;
export async function api(path: string, body?: unknown): Promise<any> {
  const response = await fetch(
    "/api/" + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const text = await response.text();
  let value: any;
  try { value = JSON.parse(text); }
  catch { throw new Error(`요청 오류 (${response.status}): ${text.slice(0, 240) || "실행기 응답을 확인하세요."}`); }
  if (!response.ok)
    throw new Error(value.error || "요청을 완료하지 못했습니다.");
  return value;
}
export const number = (v: any, digits = 1) =>
  typeof v === "number" && Number.isFinite(v)
    ? v.toLocaleString("ko-KR", { maximumFractionDigits: digits })
    : "—";
export const time = (v: any) =>
  v
    ? new Date(v).toLocaleString("ko-KR", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
export const duration = (v: number) =>
  v >= 60000
    ? `${Math.floor(v / 60000)}분 ${Math.round((v % 60000) / 1000)}초`
    : `${number(v / 1000)}초`;
export const labels: Obj = {
  pending: "대기",
  running: "시험 중",
  pausing: "현재 문항 마치는 중",
  paused: "일시정지",
  interrupted: "재개 가능",
  cancelled: "중단됨",
  cancelling: "중단 중",
  completed: "완료",
  done: "답변 완료",
  error: "요청 오류",
  scoring: "채점 중",
  grading: "채점 중",
};
export function runStatus(run?: Obj | null) {
  if (run?.status === "completed" && run.summary?.score_errors > 0)
    return "답변 수집 완료 · 채점 실패";
  return labels[run?.status] || run?.status || "불러오는 중";
}
export const tips: Obj = {
  TTFT: "Time To First Token. 벤치 실행기가 모델 API에 요청한 시점부터 실제 답변의 첫 텍스트를 받은 시점까지입니다. 추론·네트워크·대기를 포함하고 브라우저 표시 지연은 제외합니다. 과거 기록은 당시 정의를 유지합니다.",
  Decode:
    "요청 하나의 첫 출력 이후 토큰 생성 속도입니다. 여러 요청의 합계가 아니며 카드에는 요청별 측정값의 중앙값을 표시합니다. 서버 제공값을 우선합니다. 스트리밍 추정값은 벤치 실행기의 API 수신 시각으로 계산하며 브라우저 표시 속도가 아닙니다. 단위는 tok/s입니다.",
  Prefill:
    "입력 토큰을 처리하는 속도입니다. 서버가 별도로 제공한 측정값만 표시합니다. TTFT에는 대기와 통신도 포함되므로 Prefill로 대신 계산하지 않습니다.",
  Throughput:
    "현재 동시 요청 구간의 전체 출력 토큰(추론 포함)을 첫 요청 시작부터 마지막 응답 완료까지의 시간으로 나눈 처리량입니다. Prefill·요청 사이 채점·대기·일시정지를 포함합니다. 전체 토큰 미제공 응답은 제외하며 가시 토큰으로 대신하지 않습니다.",
  VRAM: "GPU의 전용 메모리 사용량입니다. 선택한 시험 장비에서 실제 수집한 값이며 연결되지 않으면 —로 표시합니다.",
  score:
    "점수는 채점된 문항만 분모로 사용합니다. 요청 오류·미채점·출력 잘림 수를 함께 확인해야 합니다. 문항이 적은 시험의 점수는 더 긴 모드나 원본 전체 평가 점수를 대신하지 않습니다.",
  key: "입력한 키는 이 실행기의 비공개 파일(소유자만 읽기·쓰기)에 저장합니다. 브라우저에 키를 다시 돌려주지 않습니다. 수정 화면에서 비워두면 기존 키를 유지합니다.",
};

export function Help({
  text,
  label = "도움말",
}: {
  text: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false),
    [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const button = useRef<HTMLButtonElement>(null),
    popup = useRef<HTMLDivElement>(null);
  const id = useId();
  const show = () => {
    const r = button.current?.getBoundingClientRect();
    if (r)
      setPosition({
        top: Math.max(12, Math.min(r.bottom + 8, window.innerHeight - 190)),
        left: Math.max(12, Math.min(r.left - 120, window.innerWidth - 332)),
      });
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (
        !button.current?.contains(e.target as Node) &&
        !popup.current?.contains(e.target as Node)
      ) {
        setOpen(false);
        setPinned(false);
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setPinned(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <span className="help-control">
      <button
        ref={button}
        type="button"
        className="help-button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={() => !pinned && setOpen(false)}
        onFocus={show}
        onBlur={() => !pinned && setOpen(false)}
        onClick={() => {
          if (pinned) {
            setPinned(false);
            setOpen(false);
          } else {
            setPinned(true);
            show();
          }
        }}
      >
        <CircleHelp size={15} />
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            id={id}
            role="tooltip"
            className="help-popover"
            style={position}
          >
            {text}
          </div>,
          document.body,
        )}
    </span>
  );
}
export function Field({
  label,
  help,
  children,
  wide = false,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const id = useId();
  return (
    <div className={"field" + (wide ? " wide" : "")}>
      <div className="field-label">
        <label htmlFor={id}>{label}</label>
        {help && <Help text={help} label={label + " 도움말"} />}
      </div>
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<any>, { id })
        : children}
    </div>
  );
}
export function Metric({
  label,
  value,
  unit,
  note,
  help,
}: {
  label: string;
  value: any;
  unit?: string;
  note?: string;
  help?: string;
}) {
  return (
    <div className="metric">
      <div className="metric-label">
        {label}
        <Help text={help || tips[label] || tips.score} label={label + " 도움말"} />
      </div>
      <div className="metric-value">
        {typeof value === "number" ? number(value) : value || "—"}
        <small>{unit}</small>
      </div>
      {note && (
        <div className="metric-note">{value == null ? "미수집" : note}</div>
      )}
    </div>
  );
}

// Mirrors the provider's omitted temperature policy; actual request body remains the source of truth.
export function temperatureOmitted(config: Obj): boolean {
  const effort = typeof config.reasoning_parameters?.reasoning_effort === "string" ? config.reasoning_parameters.reasoning_effort : config.reasoning_effort;
  return config.api_format === "responses" && !!(effort || /^(gpt-5|gpt-6|o1|o3|o4)/.test(config.model || ""));
}
