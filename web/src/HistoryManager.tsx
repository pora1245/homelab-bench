import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArchiveRestore,
  Check,
  Clock3,
  LoaderCircle,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { api, number, runStatus, time, type Obj } from "./common";
import "./history-manager.css";

export type HistoryManagerProps = {
  runs: Obj[];
  selectedId: string;
  onChanged: (removedId?: string) => Promise<void>;
  onClose: () => void;
  onError: (message: string) => void;
};

const activeStatuses = new Set(["running", "pausing", "cancelling", "scoring"]);
const active = (run: Obj) =>
  activeStatuses.has(run.status) ||
  run.busy === true ||
  run.active === true ||
  run.is_active === true;
const name = (run: Obj) => run.name || run.config?.name || "이름 없는 시험";
const messageOf = (error: unknown) => String(error).replace(/^Error: /, "");

export function HistoryManager({
  runs,
  selectedId,
  onChanged,
  onClose,
  onError,
}: HistoryManagerProps) {
  const [tab, setTab] = useState<"records" | "trash">("records");
  const [trash, setTrash] = useState<Obj[]>([]);
  const [loading, setLoading] = useState(true);
  const [trashLoaded, setTrashLoaded] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const pendingChangedId = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const loadSequence = useRef(0);
  const latestCallbacks = useRef({ onClose, onError, busy });
  latestCallbacks.current = { onClose, onError, busy };
  const headingId = useId(),
    descriptionId = useId(),
    recordsId = useId(),
    trashId = useId(),
    panelId = useId();
  const visibleRuns = runs.filter((run) => !hiddenIds.has(run.id));
  const confirmation = visibleRuns.find((run) => run.id === confirmId);

  const loadTrash = useCallback(async () => {
    const sequence = ++loadSequence.current;
    if (mounted.current) setLoading(true);
    try {
      const result = await api("trash");
      if (!Array.isArray(result))
        throw new Error(
          "휴지통 목록을 불러오지 못했습니다. 다시 시도해 주세요.",
        );
      if (mounted.current && sequence === loadSequence.current) {
        setTrash(result);
        setTrashLoaded(true);
      }
    } finally {
      if (mounted.current && sequence === loadSequence.current)
        setLoading(false);
    }
  }, []);

  const reportError = useCallback((error: unknown) => {
    if (!mounted.current) return;
    const message = messageOf(error);
    setError(message);
    latestCallbacks.current.onError(message);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const previousFocus = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    void loadTrash().catch(reportError);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!latestCallbacks.current.busy) latestCallbacks.current.onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex="0"]',
        ) || [],
      ).filter((element) => element.getClientRects().length);
      const first = focusable[0],
        last = focusable.at(-1);
      if (!first) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !dialog.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialog.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      mounted.current = false;
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", onKey);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [loadTrash, reportError]);

  useEffect(() => {
    if (confirmId) cancelButton.current?.focus();
    else if (deleteTrigger.current?.isConnected) deleteTrigger.current.focus();
    else closeButton.current?.focus();
  }, [confirmId]);
  useEffect(() => {
    if (confirmId && !visibleRuns.some((run) => run.id === confirmId))
      setConfirmId(null);
  }, [confirmId, visibleRuns]);

  async function refreshTrash() {
    setError("");
    try {
      await loadTrash();
      await refreshParent();
    } catch (error) {
      reportError(error);
    }
  }
  async function refreshParent() {
    await onChanged(pendingChangedId.current);
    pendingChangedId.current = undefined;
  }
  async function moveToTrash() {
    if (!confirmation || busy || active(confirmation)) return;
    const removed = confirmation;
    setBusy(`delete:${removed.id}`);
    setError("");
    setNotice("");
    onError("");
    try {
      await api(`runs/${encodeURIComponent(removed.id)}/delete`, {});
      if (!mounted.current) return;
      setHiddenIds((previous) => new Set(previous).add(removed.id));
      pendingChangedId.current = removed.id;
      setConfirmId(null);
      setNotice("시험 이력을 휴지통으로 옮겼습니다.");
      const refreshes = await Promise.allSettled([
        loadTrash(),
        refreshParent(),
      ]);
      const failed = refreshes.find((result) => result.status === "rejected");
      if (failed?.status === "rejected")
        reportError(
          `휴지통 이동은 완료했지만 목록 새로고침에 실패했습니다. ${messageOf(failed.reason)}`,
        );
    } catch (error) {
      reportError(error);
    } finally {
      if (mounted.current) setBusy("");
    }
  }
  async function restore(run: Obj) {
    if (busy) return;
    setBusy(`restore:${run.id}`);
    setError("");
    setNotice("");
    onError("");
    try {
      await api(`trash/${encodeURIComponent(run.id)}/restore`, {});
      if (!mounted.current) return;
      setTrash((previous) => previous.filter((item) => item.id !== run.id));
      setHiddenIds((previous) => {
        const next = new Set(previous);
        next.delete(run.id);
        return next;
      });
      setNotice("시험 이력을 복원했습니다. 기록 탭에서 확인할 수 있습니다.");
      pendingChangedId.current = undefined;
      try {
        await refreshParent();
      } catch (error) {
        reportError(
          `복원은 완료했지만 목록 새로고침에 실패했습니다. ${messageOf(error)}`,
        );
      }
    } catch (error) {
      reportError(error);
    } finally {
      if (mounted.current) setBusy("");
    }
  }
  function changeTab(next: "records" | "trash") {
    if (busy) return;
    setTab(next);
    setConfirmId(null);
  }

  return createPortal(
    <div
      className="history-manager-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialog}
        className="history-manager"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={descriptionId}
        aria-busy={Boolean(busy)}
      >
        <header className="hm-heading">
          <div>
            <span>HISTORY</span>
            <h2 id={headingId}>시험 이력 관리</h2>
          </div>
          <button
            ref={closeButton}
            type="button"
            className="hm-close"
            onClick={onClose}
            disabled={Boolean(busy)}
            aria-label="시험 이력 관리 닫기"
          >
            <X size={20} />
          </button>
        </header>
        <p className="hm-description" id={descriptionId}>
          삭제한 이력은 휴지통으로 옮깁니다. 문제·답변·채점 결과는 보존되며
          복원할 수 있습니다.
        </p>
        {!confirmation && (
          <div
            className="hm-tabs"
            role="tablist"
            aria-label="시험 이력 분류"
            onKeyDown={(event) => {
              if (
                ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              ) {
                event.preventDefault();
                if (busy) return;
                const next =
                  event.key === "Home"
                    ? "records"
                    : event.key === "End"
                      ? "trash"
                      : tab === "records"
                        ? "trash"
                        : "records";
                changeTab(next);
                document
                  .getElementById(next === "records" ? recordsId : trashId)
                  ?.focus();
              }
            }}
          >
            <button
              id={recordsId}
              role="tab"
              aria-selected={tab === "records"}
              aria-controls={panelId}
              tabIndex={tab === "records" ? 0 : -1}
              disabled={Boolean(busy)}
              onClick={() => changeTab("records")}
            >
              <Clock3 size={15} />
              기록 <span>{visibleRuns.length}</span>
            </button>
            <button
              id={trashId}
              role="tab"
              aria-selected={tab === "trash"}
              aria-controls={panelId}
              tabIndex={tab === "trash" ? 0 : -1}
              disabled={Boolean(busy)}
              onClick={() => changeTab("trash")}
            >
              <Trash2 size={15} />
              휴지통 <span>{loading ? "…" : trash.length}</span>
            </button>
          </div>
        )}
        {error && (
          <div className="hm-error" role="alert">
            {error}
            <button
              type="button"
              disabled={loading || Boolean(busy)}
              onClick={refreshTrash}
            >
              <RefreshCw size={13} />
              목록 다시 확인
            </button>
          </div>
        )}
        {notice && (
          <p className="hm-notice" role="status">
            <Check size={15} />
            {notice}
          </p>
        )}
        {confirmation ? (
          <section className="hm-confirm" aria-label="휴지통 이동 확인">
            <div className="hm-confirm-icon">
              <Trash2 size={23} />
            </div>
            <h3>이 이력을 휴지통으로 옮길까요?</h3>
            <div className="hm-confirm-record">
              <strong>{name(confirmation)}</strong>
              <span>
                {time(confirmation.created_at)} · {runStatus(confirmation)}
              </span>
            </div>
            <p>
              {confirmation.id === selectedId
                ? "현재 선택한 시험이 기록 목록에서 사라집니다. 휴지통에서 복원할 수 있습니다."
                : "기록 목록에서 숨겨지고 휴지통에서 복원할 수 있습니다."}
            </p>
            {active(confirmation) && (
              <p className="hm-active-note">
                시험이 진행 중입니다. 종료한 뒤 다시 삭제해 주세요.
              </p>
            )}
            <div className="hm-confirm-actions">
              <button
                ref={cancelButton}
                type="button"
                onClick={() => setConfirmId(null)}
                disabled={Boolean(busy)}
              >
                취소
              </button>
              <button
                className="hm-delete-confirm"
                type="button"
                onClick={moveToTrash}
                disabled={Boolean(busy) || active(confirmation)}
              >
                {busy ? (
                  <LoaderCircle size={15} className="hm-spin" />
                ) : (
                  <Trash2 size={15} />
                )}
                휴지통으로 이동
              </button>
            </div>
          </section>
        ) : (
          <section
            className="hm-panel"
            role="tabpanel"
            id={panelId}
            aria-labelledby={tab === "records" ? recordsId : trashId}
          >
            {tab === "trash" && (
              <div className="hm-trash-heading">
                <span>원래 문제와 답변을 보존하고 있습니다.</span>
                <button
                  type="button"
                  onClick={refreshTrash}
                  disabled={loading || Boolean(busy)}
                  aria-label="휴지통 새로고침"
                >
                  <RefreshCw size={14} className={loading ? "hm-spin" : ""} />
                </button>
              </div>
            )}
            {tab === "trash" && loading && !trash.length ? (
              <p className="hm-empty">휴지통을 불러오고 있습니다.</p>
            ) : (
              (tab === "records" ? visibleRuns : trash).map((run) => (
                <article
                  className={`hm-record ${run.id === selectedId ? "hm-selected" : ""}`}
                  key={run.id}
                >
                  <div className="hm-record-info">
                    <div className="hm-record-title">
                      <strong>{name(run)}</strong>
                      {run.id === selectedId && tab === "records" && (
                        <span>선택됨</span>
                      )}
                    </div>
                    <p className="hm-record-model">
                      {run.model || run.config?.model || "모델 미기록"}
                    </p>
                    <div className="hm-record-meta">
                      <span>{time(run.created_at)}</span>
                      <span>{runStatus(run)}</span>
                      {run.summary?.total != null && (
                        <span>{number(run.summary.total, 0)}문항</span>
                      )}
                    </div>
                    {tab === "trash" && run.deleted_at && (
                      <p className="hm-deleted-at">
                        휴지통 이동 {time(run.deleted_at)}
                      </p>
                    )}
                    {tab === "records" && active(run) && (
                      <p className="hm-active-note">
                        진행 중인 시험은 종료 후 삭제할 수 있습니다.
                      </p>
                    )}
                  </div>
                  {tab === "records" ? (
                    <button
                      type="button"
                      className="hm-record-action hm-delete"
                      aria-label={`${name(run)} 삭제`}
                      disabled={Boolean(busy) || active(run)}
                      onClick={(event) => {
                        deleteTrigger.current = event.currentTarget;
                        setConfirmId(run.id);
                        setError("");
                        setNotice("");
                      }}
                    >
                      <Trash2 size={15} />
                      <span>삭제</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="hm-record-action hm-restore"
                      aria-label={`${name(run)} 복원`}
                      disabled={Boolean(busy)}
                      onClick={() => restore(run)}
                    >
                      {busy === `restore:${run.id}` ? (
                        <LoaderCircle size={15} className="hm-spin" />
                      ) : (
                        <ArchiveRestore size={15} />
                      )}
                      <span>복원</span>
                    </button>
                  )}
                </article>
              ))
            )}
            {!(tab === "trash" && loading) &&
              !(tab === "records" ? visibleRuns : trash).length && (
                <div className="hm-empty">
                  {tab === "records"
                    ? "보관 중인 시험 이력이 없습니다."
                    : trashLoaded
                      ? "휴지통이 비어 있습니다."
                      : "휴지통을 불러오지 못했습니다."}
                </div>
              )}
          </section>
        )}
      </div>
    </div>,
    document.body,
  );
}
