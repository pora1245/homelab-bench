import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  House,
  History,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Cpu,
  FileText,
  FlaskConical,
  Layers3,
  Pause,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Square,
  Upload,
  X,
} from "lucide-react";
import {
  api,
  duration,
  Field,
  Help,
  labels,
  runStatus,
  Metric,
  number,
  Obj,
  time,
  tips,
  temperatureOmitted,
} from "./common";
import { Connections } from "./Connections";
import { MetricCoverage, PreflightLabel, TimingSummary } from "./LiveInsights";
import { Report } from "./Report";
import { aggregateThroughput, THROUGHPUT_DEFINITION } from "./throughput";
import { Home } from "./Home";
import { HistoryManager } from "./HistoryManager";
import { ExamReader } from "./ExamReader";
import { ItemStatus, correctness, judgment } from "./ItemStatus";
import { benchmarkLabel, benchmarkHelp, taskBenchmarkLabel, referenceSubjectLabel } from "./benchmarkLabels";
import "./style.css";
import "./exam-workspace.css";
import "./insights.css";

const isRunActive = (value: Obj) => value.busy === true || ["running", "pausing", "cancelling", "scoring"].includes(value.status);
const parallelRunHelp = "시험별로 일시정지·재개·중단할 수 있습니다. 같은 서버의 CPU·RAM·PCIe를 공유하면 측정 성능에 영향을 줄 수 있습니다.";

const defaults = {
  name: "",
  pack_id: "timed-10m-v1",
  profile: "full",
  subjects: [] as string[],
  temperature: 0,
  max_tokens: 8192,
  concurrency: 8,
  auto_concurrency: true,
  timeout_s: 600,
  reasoning_effort: "",
  note: "",
  base_url: "",
  model: "",
  telemetry_url: "",
};
const packMeta = (pack: Obj) => pack?.sources?.metadata || pack?.sources || {};
const selectablePack = (pack: Obj) => !packMeta(pack).legacy && !pack.id.startsWith("diagnostic-") && !["korean-core-v1", "api-experience-v1"].includes(pack.id);
function requiredScorers(packId: string, subjects?: string[], missingPacks: string[] = []) {
  if (packId === "collection-full-v1" || packId.startsWith("timed-")) return [
    ...(!subjects || subjects.includes("고난도 수학") ? ["math"] : []),
    ...(!subjects || subjects.includes("지시 이행") ? ["ifeval"] : []),
    ...(!subjects || subjects.includes("코드") ? ["humaneval", "mbpp", "livecodebench"] : []),
  ].filter((name) => !(packId.startsWith("timed-") && name === "livecodebench") && !missingPacks.includes(({math:"math500-test-v1",ifeval:"ifeval-full-v1",humaneval:"humaneval-full-v1",mbpp:"mbpp-test-v1",livecodebench:"livecodebench-v6-v1"} as Record<string,string>)[name]));
  return ["ifeval", "math500", "humaneval", "mbpp", "livecodebench"].filter((name) => packId.startsWith(name)).map((name) => name === "math500" ? "math" : name);
}
type ScorerReadiness = "checking" | "ready" | "not-ready" | "failed";
const readinessLabels: Record<ScorerReadiness, string> = {
  checking: "채점 환경 확인 중", ready: "채점 준비 완료",
  "not-ready": "채점 환경 준비 필요", failed: "채점 환경 확인 실패",
};
function scorerReadiness(names: string[], result: Obj | null, checking: boolean, error: string) {
  if (!names.length) return { state: "ready" as ScorerReadiness, detail: "내장 채점기로 바로 평가할 수 있습니다." };
  if (checking) return { state: "checking" as ScorerReadiness, detail: "선택한 과목의 채점기를 확인하고 있습니다. 확인이 끝나면 시험을 시작할 수 있습니다." };
  if (error) return { state: "failed" as ScorerReadiness, detail: error };
  if (!result) return { state: "checking" as ScorerReadiness, detail: "채점 환경 상태를 확인하고 있습니다." };
  const missing = names.filter((name) => typeof result.scorers?.[name]?.available !== "boolean");
  if (missing.length) return { state: "failed" as ScorerReadiness, detail: `채점 상태 응답이 누락됐습니다 (${missing.join(", ")}). 상태를 다시 확인해 주세요.` };
  const failed = names.map((name) => result.scorers[name]).filter((v) => !v.available);
  if (failed.length) return { state: "not-ready" as ScorerReadiness, detail: [...new Set(failed.map((v) => [v.error, v.remedy].filter(Boolean).join(" · ")))].join("\n") || "선택한 과목의 채점 환경을 준비한 뒤 상태를 다시 확인해 주세요." };
  return { state: "ready" as ScorerReadiness, detail: "선택한 과목의 채점기가 준비되었습니다." };
}
function App() {
  const [runs, setRuns] = useState<Obj[]>([]),
    [packs, setPacks] = useState<Obj[]>([]),
    [connections, setConnections] = useState<Obj[]>([]),
    [devices, setDevices] = useState<Obj[]>([]);
  const [run, setRun] = useState<Obj | null>(null),
    [selected, setSelected] = useState(localStorage.getItem("bench-run") || ""),
    [tab, setTab] = useState(localStorage.getItem("bench-tab") || "home");
  const [online, setOnline] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [modal, setModal] = useState(false),
    [historyOpen, setHistoryOpen] = useState(false);
  const [form, setForm] = useState({ ...defaults }),
    [targetId, setTargetId] = useState(""),
    [judgeId, setJudgeId] = useState(""),
    [deviceId, setDeviceId] = useState("");
  const [readiness, setReadiness] = useState<Obj | null>(null),
    [readinessChecking, setReadinessChecking] = useState(false),
    [readinessError, setReadinessError] = useState("");
  const readinessSequence = useRef(0);
  const [setup, setSetup] = useState<Obj | null>(null);
  async function checkReadiness(names?: string[]) {
    const sequence = ++readinessSequence.current;
    setReadiness(null);
    setReadinessError("");
    setReadinessChecking(true);
    try {
      const result = await api("readiness" + (names ? `?scorers=${encodeURIComponent(names.join(","))}` : ""));
      if (sequence === readinessSequence.current) setReadiness(result);
    } catch (e) {
      if (sequence === readinessSequence.current)
        setReadinessError(`채점 상태를 가져오지 못했습니다. ${String(e).replace(/^Error: /, "")}`);
    } finally {
      if (sequence === readinessSequence.current) setReadinessChecking(false);
    }
  }
  useEffect(() => () => { readinessSequence.current += 1; }, []);
  const modalError = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (modal && error) modalError.current?.scrollIntoView({block: "nearest"});
  }, [modal, error]);
  const [detail, setDetail] = useState<{
    runId: string;
    index: number;
    item: Obj;
  } | null>(null);
  const detailTarget = useRef<{
      id: string;
      index: number;
      active: boolean;
    } | null>(null),
    detailSequence = useRef(0),
    detailInFlight = useRef<string | null>(null);
  const [itemIndex, setItemIndex] = useState<number | null>(null),
    [ledgerPage, setLedgerPage] = useState(0),
    [legacyKey, setLegacyKey] = useState("");
  const selectedRef = useRef(selected),
    refreshLock = useRef(false),
    file = useRef<HTMLInputElement>(null);
  selectedRef.current = selected;
  useEffect(() => { localStorage.setItem("bench-tab", tab); window.scrollTo({ top: 0 }); }, [tab]);
  useEffect(() => { if (tab === "packs" && !modal) void checkReadiness(); }, [tab, modal]);
  async function refreshProfiles() {
    const [c, d, p] = await Promise.all([
      api("connections"),
      api("devices"),
      api("packs"),
    ]);
    setConnections(c);
    setDevices(d);
    setPacks(p);
  }
  async function refresh() {
    if (refreshLock.current) return;
    refreshLock.current = true;
    try {
      const list = await api("runs");
      setRuns(list);
      const id = selectedRef.current;
      if (!id || !list.some((entry: Obj) => entry.id === id)) {
        const next = list[0]?.id || "";
        selectedRef.current = next;
        setSelected(next);
        if (!next) setRun(null);
      } else {
        const value = await api("runs/" + id + "?view=compact");
        if (selectedRef.current === id) setRun(value);
      }
      setOnline(true);
    } catch (e) {
      setOnline(false);
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      refreshLock.current = false;
    }
  }
  async function historyChanged(removedId?: string) {
    const list = await api("runs");
    setRuns(list);
    const id = selectedRef.current;
    if (id === removedId || !list.some((entry: Obj) => entry.id === id)) {
      const next = list[0]?.id || "";
      selectedRef.current = next;
      setRun(null);
      setSelected(next);
    }
    setError("");
  }
  async function refreshDetail(id: string, index: number) {
    const key = `${id}:${index}`;
    if (detailInFlight.current === key) return;
    detailInFlight.current = key;
    const seq = ++detailSequence.current;
    try {
      const value = await api(`runs/${id}/items/${index}`);
      if (seq === detailSequence.current && selectedRef.current === id)
        setDetail({ runId: id, index, item: value });
    } catch (e) {
      if (seq === detailSequence.current && selectedRef.current === id) setError(String(e));
    } finally {
      if (detailInFlight.current === key) detailInFlight.current = null;
    }
  }
  useEffect(() => {
    refreshProfiles().catch((e) => setError(String(e)));
    api("setup").then(setSetup).catch(e => setError(String(e)));
    refresh();
    const stream = new EventSource("/api/events");
    let timer: ReturnType<typeof setTimeout> | undefined,
      detailTimer: ReturnType<typeof setTimeout> | undefined;
    stream.onmessage = () => {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          refresh();
        }, 1000);
      if (!detailTimer)
        detailTimer = setTimeout(() => {
          detailTimer = undefined;
          const target = detailTarget.current;
          if (target?.active) refreshDetail(target.id, target.index);
        }, 400);
    };
    stream.onopen = () => {
      setOnline(true);
      refresh();
    };
    stream.onerror = () => setOnline(false);
    return () => {
      stream.close();
      clearTimeout(timer);
      clearTimeout(detailTimer);
    };
  }, []);
  useEffect(() => {
    localStorage.setItem("bench-run", selected);
    setItemIndex(null);
    setLedgerPage(0);
    setLegacyKey("");
    setRun(null);
    if (selected) {
      let live = true;
      api("runs/" + selected + "?view=compact")
        .then((v) => {
          if (live) setRun(v);
        })
        .catch((e) => { if (live) setError(String(e)); });
      return () => {
        live = false;
      };
    }
    setRun(null);
  }, [selected]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModal(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  }
  function selectTarget(id: string) {
    setTargetId(id);
    const profile = connections.find((v) => v.id === id);
    if (profile) setForm((previous) => ({ ...previous, ...profile.defaults,
      auto_concurrency: previous.auto_concurrency !== false,
      ...(previous.auto_concurrency !== false ? { concurrency: Number.isInteger(previous.concurrency) && previous.concurrency >= 1 && previous.concurrency <= 8 ? previous.concurrency : 8 } : {}),
    }));
    setDeviceId(preferredDevice(profile));
  }
  function preferredDevice(profile?: Obj) {
    if (profile?.device_id && devices.some((d) => d.id === profile.device_id)) return profile.device_id;
    // localhost can be a gateway or tunnel. Only an explicit profile association is authoritative.
    return "";
  }
  function initialSubjects(packId: string) {
    const subjects = Object.keys(packs.find(p => p.id === packId)?.subjects || {});
    return setup?.preferences.completed && !setup.preferences.code_grading && subjects.some(s => s !== "코드")
      ? subjects.filter(s => s !== "코드") : [];
  }
  function newTest() {
    setMeasurementCheck(null); setLimitedMetrics(false);
    const target =
      connections.find((v) => v.kind === "target" && v.is_default) ||
      connections.find((v) => v.kind === "target");
    if (!target) {
      setModal(false);
      setTab("connections");
      return;
    }
    const preferred =
      packs.find((p) => p.id === form.pack_id && selectablePack(p)) ||
      packs.find(selectablePack);
    setTargetId(target?.id || "");
    setJudgeId(
      connections.find((v) => v.kind === "judge" && v.is_default)?.id || "",
    );
    setDeviceId(preferredDevice(target));
    setForm({
      ...defaults,
      ...target?.defaults,
      auto_concurrency: true,
      concurrency: 8,
      pack_id: preferred?.id || defaults.pack_id,
      subjects: initialSubjects(preferred?.id || defaults.pack_id),
    });
    setModal(true);
    setError("");
  }
  const [measurementCheck, setMeasurementCheck] = useState<Obj | null>(null);
  const [limitedMetrics, setLimitedMetrics] = useState(false);
  const measurementKey = JSON.stringify({form,targetId,deviceId,judgeId,connections,devices});
  const freshMeasurement = measurementCheck?.key === measurementKey && Date.now() < Date.parse(measurementCheck.checked_at) + (measurementCheck.expires_in_seconds || 1800) * 1000 ? measurementCheck : null;
  async function prepareStart() {
    if (selectedReadiness.state !== "ready") throw Error(selectedReadiness.detail);
    if (!targetId) throw Error("시험할 모델을 선택하세요.");
    const checked = await api(`connections/${targetId}/check`, {});
    if (!checked.ok) throw Error(checked.error || "모델 API에 연결할 수 없습니다.");
    const target = connections.find((v) => v.id === targetId);
    if (Array.isArray(checked.models) && !checked.models.some((v: Obj | string) => (typeof v === "string" ? v : v.id) === target?.model))
      throw Error("저장한 모델 ID가 서버에 없습니다. 연결 관리에서 수정하세요.");
    const options = checked.models?.find((v: Obj) => v.id === target?.model)?.reasoning?.options;
    const reasoning = options?.find((v: Obj) => v.value === form.reasoning_effort);
    if (form.reasoning_effort && options?.length && !reasoning)
      throw Error(`지원하는 추론 강도: ${options.map((v: Obj) => v.value).join(", ")}`);
    return {
      connection_id: targetId, judge_connection_id: judgeId, device_id: deviceId,
      config: {...form,api_format:target?.api_format || "chat_completions",reasoning_parameters:reasoning?.parameters || null,
        connection_id:targetId,judge_connection_id:judgeId,device_id:deviceId},
    };
  }
  function start() {
    act(async () => {
      const payload = await prepareStart();
      if (!freshMeasurement || freshMeasurement.status === "failed") {
        const result = await api("preflight", payload);
        setMeasurementCheck({...result,key:measurementKey});
        setLimitedMetrics(false);
        return;
      }
      if (freshMeasurement.requires_acknowledgement && !limitedMetrics)
        throw Error("누락된 계측 항목을 확인하세요.");
      const result = await api("runs", {...payload,preflight_token:freshMeasurement.preflight_token,
        allow_limited_metrics:limitedMetrics});
      setSelected(result.id); setModal(false); setTab("live");
      setMeasurementCheck(null); setLimitedMetrics(false);
      await refresh();
    });
  }
  function control(action: string, extra: Obj = {}) {
    act(async () => {
      await api(
        `runs/${selected}/${action}`,
        { ...(legacyKey ? { api_key: legacyKey } : {}), ...extra },
      );
      await refresh();
    });
  }
  const selectablePacks = packs.filter(selectablePack).sort((a,b) => {
    const order = ["timed-10m-v1", "timed-1h-v1", "timed-4h-v1", "timed-8h-v1"];
    return (order.includes(a.id) ? order.indexOf(a.id) : 99) - (order.includes(b.id) ? order.indexOf(b.id) : 99);
  }),
    chosenPack = packs.find((p) => p.id === form.pack_id),
    meta = packMeta(chosenPack || {});
  const availableSubjects = Object.keys(chosenPack?.subjects || {}),
    selectedSubjects = availableSubjects.filter(
      (s) => !form.subjects.length || form.subjects.includes(s),
    );
  const fullCount = selectedSubjects.reduce(
    (n, s) => n + (chosenPack?.subjects[s] || 0),
    0,
  );
  const quickSubjects = chosenPack?.quick_subjects || meta.quick_subjects;
  const quickCount = quickSubjects
    ? selectedSubjects.reduce((n, s) => n + (quickSubjects[s] || 0), 0)
    : !form.subjects.length
      ? (chosenPack?.quick_count ??
        meta.quick_count ??
        Math.min(5, chosenPack?.count || 0))
      : null;
  const codePack = (form.pack_id.startsWith("timed-") || [
    "collection-full-v1",
    "humaneval-full-v1",
    "mbpp-test-v1",
    "livecodebench-v6-v1",
  ].includes(form.pack_id)) && selectedSubjects.includes("코드");
  const requiredScorerNames = requiredScorers(form.pack_id, selectedSubjects, meta.missing_components);
  const selectedReadiness = scorerReadiness(requiredScorerNames, readiness, readinessChecking, readinessError);
  const readinessKey = requiredScorerNames.join(",");
  useEffect(() => {
    if (modal) void checkReadiness(requiredScorerNames);
  }, [modal, readinessKey]);
  const nonCodeSubjects = selectedSubjects.filter((subject) => subject !== "코드");
  const canSkipCode = (form.pack_id === "collection-full-v1" || form.pack_id.startsWith("timed-")) && codePack && nonCodeSubjects.length > 0
    && ["not-ready", "failed"].includes(selectedReadiness.state);
  const expectedCount = form.profile === "full" ? fullCount : quickCount;
  const totalThroughput = useMemo(() => aggregateThroughput(run), [run]);
  const summary = run?.summary || {},
    items: Obj[] = run?.items || [],
    total = summary.total || 0,
    completed = summary.completed || 0;
  const active = ["running", "pausing", "cancelling", "scoring"].includes(
    run?.status || "",
  );
  const activeRuns = runs.filter(isRunActive);
  const runningIndex = items.findIndex((i) => i.status === "running" || i.status === "grading" || i.status === "scoring");
  const currentIndex = Math.max(
    0,
    Math.min(
      items.length - 1,
      itemIndex ??
        (runningIndex >= 0
          ? runningIndex
          : Math.max(
              0,
              items.reduce((last, v, i) => (v.attempts?.length ? i : last), -1),
            )),
    ),
  );
  detailTarget.current = run
    ? { id: run.id, index: currentIndex, active: active && tab === "live" }
    : null;
  useEffect(() => {
    if (run && tab === "live" && items.length)
      refreshDetail(run.id, currentIndex);
  }, [run, currentIndex, tab]);
  const item =
      detail?.runId === run?.id && detail?.index === currentIndex
        ? detail.item
        : items[currentIndex];
  const subjects = Object.entries(summary.subjects || {}) as [string, Obj][],
    scored = subjects.reduce((n, [, v]) => n + v.scored, 0);
  const outcome = correctness(items);
  const displayRunStatus = runStatus(run);
  const pageCount = Math.max(1, Math.ceil(items.length / 50)),
    actualLedger = itemIndex === null
      ? Math.floor(currentIndex / 50)
      : Math.max(0, Math.min(ledgerPage, pageCount - 1));
  function selectQuestion(index: number) {
    const next = Math.max(0, Math.min(items.length - 1, index));
    setItemIndex(next);
    setLedgerPage(Math.floor(next / 50));
  }
  function selectLedgerPage(page: number) {
    const next = Math.max(0, Math.min(pageCount - 1, page));
    setLedgerPage(next);
    setItemIndex(Math.min(items.length - 1, next * 50));
  }
  function toggleFollowing(enabled: boolean) {
    if (enabled) setItemIndex(null);
    else selectQuestion(currentIndex);
  }
  const titles: Obj = {
    home: "홈",
    live: "시험 현황",
    results: "보고서",
    packs: "평가팩",
    connections: "연결 관리",
  };
  return (
    <div className={`app ${tab === "live" && run ? "live-view" : ""}`}>
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setTab("home");
          }}
        >
          <FlaskConical size={28} />
          <span>
            bench<small>LOCAL EVALUATION</small>
          </span>
        </a>
        <button className="primary new-test" onClick={newTest}>
          <Plus size={18} />새 시험
        </button>
        <nav>
          {(
            [
              ["home", House],
              ["live", Activity],
              ["results", FileText],
              ["packs", Layers3],
              ["connections", Plug],
            ] as const
          ).map(([name, Icon]) => (
            <button
              key={name as string}
              className={tab === name ? "active" : ""}
              onClick={() => setTab(name as string)}
            >
              <Icon size={18} />
              <span>{titles[name as string]}</span>
            </button>
          ))}
        </nav>
        <div className="history-heading">
          시험 기록 <span>{runs.length}</span>
          <button className="icon history-manage-side" aria-label="시험 기록 관리" onClick={() => setHistoryOpen(true)}><History size={15} /></button>
        </div>
        <div className="history">
          {runs.map((r) => (
            <button
              key={r.id}
              className={"run-link " + (selected === r.id ? "current" : "")}
              onClick={() => {
                setSelected(r.id);
              }}
            >
              <i className={"dot " + (isRunActive(r) ? "pulse" : "")} />
              <span>
                <strong>{r.name || "이름 없는 시험"}</strong>
                <small>
                  {time(r.created_at)} · {runStatus(r)}
                </small>
                {isRunActive(r) && <small className="run-progress">{number(r.summary?.completed || 0, 0)} / {number(r.summary?.total || 0, 0)}문항 완료</small>}
              </span>
              <ChevronRight size={14} />
            </button>
          ))}
          {!runs.length && (
            <p className="subtle">완료한 시험과 진행 기록이 여기에 모입니다.</p>
          )}
        </div>
        <div className="local">
          <i className={"dot " + (online ? "green" : "")} />
          <span>
            {online ? "로컬 실행기 연결됨" : "연결 확인 중"}
            <small>기록은 벤치 앱 실행 장비에 저장됩니다</small>
          </span>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            작업 공간 <ChevronRight size={13} />
            <strong>{titles[tab]}</strong>
          </div>
          <select
            className="history-picker"
            aria-label="시험 기록 선택"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">시험 기록</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {runStatus(r)}
              </option>
            ))}
          </select>
          {activeRuns.length > 1 ? <span className="parallel-runs" role="status">{activeRuns.length}개 진행<Help text={parallelRunHelp} label="동시 시험 안내"/></span> : <span className="version">LOCAL BETA</span>}
          <button className="icon history-manage-mobile" aria-label="시험 기록 관리" onClick={() => setHistoryOpen(true)}><History size={18} /></button>
          <button
            className="mobile-new icon"
            aria-label="새 시험"
            onClick={newTest}
          >
            <Plus size={20} />
          </button>
        </header>
        {historyOpen && <HistoryManager runs={runs} selectedId={selected} onChanged={historyChanged} onClose={() => setHistoryOpen(false)} onError={setError} />}
        <div className={`content ${tab === "live" && run ? "live-content" : ""}`}>
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button
                className="icon"
                aria-label="오류 안내 닫기"
                onClick={() => setError("")}
              >
                <X size={17} />
              </button>
            </div>
          )}
          {tab === "home" ? (
            <Home
              run={run?.id === selected ? run : null}
              loading={!!selected && run?.id !== selected}
              hasTarget={connections.some((v) => v.kind === "target")}
              onOpenConnections={() => setTab("connections")}
              onNewTest={(intent) => {
                newTest();
                if (intent) setForm((previous) => {
                  const packId = selectablePacks.some(p => p.id === intent.pack_id) ? intent.pack_id : previous.pack_id;
                  return { ...previous, ...intent, pack_id: packId, subjects: initialSubjects(packId) };
                });
              }}
              onOpenReport={(id, format) => {
                localStorage.setItem("bench-report-format", format);
                localStorage.setItem("bench-report-page", "0");
                setSelected(id);
                setTab("results");
              }}
            />
          ) : tab === "connections" ? (
            <Connections
              connections={connections}
              devices={devices}
              setup={setup}
              refresh={refreshProfiles}
              onError={setError}
            />
          ) : tab === "packs" ? (
            <>
              <div className="page-title">
                <div>
                  <span className="eyebrow">BENCHMARK PACKS</span>
                  <h1>평가팩</h1>
                  <p>평가할 능력을 선택하세요.</p>
                </div>
                <button onClick={() => file.current?.click()}>
                  <Upload size={16} />
                  평가팩 추가
                </button>
                <input
                  hidden
                  ref={file}
                  type="file"
                  accept=".json,application/json"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f)
                      act(async () => {
                        await api("packs", JSON.parse(await f.text()));
                        await refreshProfiles();
                      });
                    e.target.value = "";
                  }}
                />
              </div>
              <div className="pack-list" role="list" aria-label="평가팩 목록">
                {selectablePacks.map((p) => {
                  const m = packMeta(p);
                  const scorerNames = requiredScorers(p.id, undefined, packMeta(p).missing_components);
                  const status = scorerReadiness(scorerNames, readiness, readinessChecking, readinessError);
                  return <article key={p.id} className="pack-list-row" role="listitem">
                    <div className="pack-list-main"><h2>{benchmarkLabel(p)} <Help text={benchmarkHelp(p)} label={`${benchmarkLabel(p)} 도움말`} /></h2><span className="subtle">{m.timed_pack ? `${number(p.count,0)}문항 · 단일 60 tok/s 기준` : `전체 ${number(p.count,0)}문항 · 빠른 ${number(p.quick_count ?? m.quick_count,0)}문항`}</span></div>
                    <div className="pack-list-status"><span className="pill">설치됨</span><span className={`scorer-status scorer-status-${status.state}`} role="status">{readinessLabels[status.state]}</span><Help label={`${benchmarkLabel(p)} 채점 환경 안내`} text={status.detail}/></div>
                    <button className="pack-start" onClick={() => { newTest(); setForm((previous) => ({...previous,pack_id:p.id,profile:p.id.startsWith("timed-") ? "full" : previous.profile,subjects:[]})); }}>시험 시작 <ChevronRight size={15}/></button>
                    <details className="pack-list-details"><summary>출처·평가 방식</summary><dl className="source-details">{[["데이터셋",m.benchmark || p.name],["분할",m.split],["채점 방식",m.protocol],["라이선스",m.license],["자료 버전",m.source_revision],["배포 조건",m.redistribution]].filter(([,v])=>v!=null).map(([k,v])=><div key={String(k)}><dt>{String(k)}</dt><dd>{String(v)}</dd></div>)}</dl></details>
                  </article>;
                })}
              </div>
              {packs.some((p) => packMeta(p).legacy) && (
                <p className="subtle">
                  이전 표본팩으로 실행한 기록은 시험 기록에서 계속 열 수
                  있습니다.
                </p>
              )}
            </>
          ) : selected && run?.id !== selected ? (
            <div className="empty" role="status" aria-busy="true"><RefreshCw size={26} /><p>선택한 시험을 불러오고 있습니다.</p></div>
          ) : !run ? (
            <div className="empty-state">
              <FlaskConical size={46} />
              <span className="eyebrow">READY WHEN YOU ARE</span>
              <h1>모델의 실력을 확인하세요</h1>
              <p>
                저장한 모델과 평가팩을 고르면
                <br />
                문제 풀이부터 채점까지 진행 과정을 볼 수 있습니다.
              </p>
              <button className="primary" onClick={newTest}>
                <Plus size={17} />첫 시험 시작
              </button>
            </div>
          ) : (
            <>
              {tab === "results" ? <>
              <div className="page-title run-title">
                <div>
                  <span className="eyebrow">
                    {tab === "results" ? "EVALUATION REPORT" : "LIVE EXAM"}
                  </span>
                  <h1 title={run.config.name || "모델 평가"}>{run.config.name || "모델 평가"}</h1>
                  <p className="model-line" title={`${run.config.model} · ${time(run.created_at)}`}>
                    {run.config.model}
                    <span>·</span>
                    {time(run.created_at)}
                  </p>
                </div>
                <div className="run-actions">
                  <span className={"status " + (active ? "active" : "")}>
                    {active && <i className="dot pulse" />}
                    {displayRunStatus}
                  </span>
                  {active ? (
                    <>
                      <button
                        disabled={busy || run.status !== "running"}
                        onClick={() => control("pause")}
                      >
                        <Pause size={15} />
                        일시정지
                      </button>
                      <button disabled={busy} onClick={() => control("cancel")}>
                        <Square size={14} />
                        중단
                      </button>
                    </>
                  ) : ["paused", "interrupted", "cancelled"].includes(
                      run.status,
                    ) ? (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => control("resume")}
                    >
                      <Play size={15} />
                      이어서 시험
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="progress-summary">
                <span>
                  {number(completed, 0)}
                  <small> / {number(total, 0)}문항 응답</small>
                </span>
                <span>
                  <Clock3 size={14} />
                  {duration(summary.active_ms || run.active_ms || 0)}
                </span>
              </div>
              <div className="progress-track">
                <div
                  style={{
                    width: (total ? (completed / total) * 100 : 0) + "%",
                  }}
                />
              </div>
              {run.error && <div className="error-banner">{run.error}</div>}
              {!active &&
                !run.config.connection_id &&
                ["paused", "interrupted", "cancelled"].includes(run.status) && (
                  <div className="legacy-resume">
                    <Field
                      label="이전 시험 API 키"
                      help="저장된 연결을 사용하기 전에 만든 시험입니다. 인증이 필요한 경우에만 재개할 키를 입력하세요."
                    >
                      <input
                        type="password"
                        autoComplete="off"
                        value={legacyKey}
                        onChange={(e) => setLegacyKey(e.target.value)}
                        placeholder="인증이 필요한 경우"
                      />
                    </Field>
                  </div>
                )}
                <Report run={run} onError={setError} />
              <details className="run-conditions">
                <summary>평가 조건과 기록 정보</summary>
                <dl>
                  <div>
                    <dt>평가팩</dt>
                    <dd>
                      {benchmarkLabel(run.config.pack_id)} · v{run.pack_version}
                    </dd>
                  </div>
                  <div>
                    <dt>선택 방식</dt>
                    <dd>
                      {run.config.pack_id?.startsWith("timed-") ? "시간 기준 고정 발췌" : run.config.profile === "quick"
                        ? "빠른 시험"
                        : run.config.profile === "full"
                          ? "원본 전체"
                          : "기존 표본 시험"}
                    </dd>
                  </div>
                  <div>
                    <dt>실행 조건</dt>
                    <dd>
                      Temperature {temperatureOmitted(run.config) ? "공급자 기본 (미전송)" : run.config.temperature} · 최대 출력{" "}
                      {number(run.config.max_tokens, 0)} tokens · 동시 요청{" "}
                      {run.config.concurrency}
                    </dd>
                  </div>
                  <div>
                    <dt>평가 항목 해시</dt>
                    <dd>{run.suite_hash}</dd>
                  </div>
                  <div>
                    <dt>실행 ID</dt>
                    <dd>{run.id}</dd>
                  </div>
                  {run.config.note && (
                    <div>
                      <dt>메모</dt>
                      <dd>{run.config.note}</dd>
                    </div>
                  )}
                </dl>
                {!active && (
                  <button disabled={busy} onClick={() => control("rescore")}>
                    <RefreshCw size={14} />
                    저장된 답변 재채점
                  </button>
                )}
              </details>
              </> : <>
                <div className="exam-workspace">
                  <section className="exam-overview" aria-label="시험 진행 현황">
              <div className="page-title run-title">
                <div>
                  <span className="eyebrow">
                    {tab === "results" ? "EVALUATION REPORT" : "LIVE EXAM"}
                  </span>
                  <h1 title={run.config.name || "모델 평가"}>{run.config.name || "모델 평가"}</h1>
                  {!String(run.config.name || "").includes(run.config.model) && <p className="model-line" title={run.config.model}>
                    {run.config.model}
                  </p>}
                </div>
                <div className="run-actions">
                  <span className={"status " + (active ? "active" : "")}>
                    {active && <i className="dot pulse" />}
                    {displayRunStatus}
                  </span>
                  {active ? (
                    <>
                      <button
                        disabled={busy || run.status !== "running"}
                        onClick={() => control("pause")}
                      >
                        <Pause size={15} />
                        일시정지
                      </button>
                      <button disabled={busy} onClick={() => control("cancel")}>
                        <Square size={14} />
                        중단
                      </button>
                    </>
                  ) : ["paused", "interrupted", "cancelled"].includes(
                      run.status,
                    ) ? (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => control("resume")}
                    >
                      <Play size={15} />
                      이어서 시험
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="progress-summary">
                <span>
                  {number(completed, 0)}
                  <small> / {number(total, 0)}문항 응답</small>
                </span>
              </div>
              <div className="progress-track">
                <div
                  style={{
                    width: (total ? (completed / total) * 100 : 0) + "%",
                  }}
                />
              </div>
              <TimingSummary run={run} elapsedMs={summary.active_ms || run.active_ms || 0} />
              {run.error && <div className="error-banner">{run.error}</div>}
              {!active &&
                !run.config.connection_id &&
                ["paused", "interrupted", "cancelled"].includes(run.status) && (
                  <div className="legacy-resume">
                    <Field
                      label="이전 시험 API 키"
                      help="저장된 연결을 사용하기 전에 만든 시험입니다. 인증이 필요한 경우에만 재개할 키를 입력하세요."
                    >
                      <input
                        type="password"
                        autoComplete="off"
                        value={legacyKey}
                        onChange={(e) => setLegacyKey(e.target.value)}
                        placeholder="인증이 필요한 경우"
                      />
                    </Field>
                  </div>
                )}
                  {run.status === "paused" && <div className="concurrency-control">
                    <label>동시 요청 <select aria-label="남은 문항 동시 요청 수" disabled={busy} value={run.config.auto_concurrency ? "auto" : run.config.concurrency} onChange={e=>e.target.value === "auto" ? control("auto-concurrency",{enabled:true,max_concurrency:8}) : control("concurrency",{concurrency:Number(e.target.value)})}>
                      <option value="auto">자동 선택 · 최대 8개</option>
                      {[1,2,3,4,5,6,7,8].map(n=><option key={n} value={n}>{n}개</option>)}
                    </select></label><Help text="자동은 재개 후 같은 표본으로 처리 효과를 확인합니다. 직접 지정하면 남은 문항에 적용하며 기존 답변은 보존합니다."/>
                  </div>}
                  <div className="metric-grid">
                    <Metric
                      label="Decode"
                      value={summary.decode_tps?.median}
                      unit="tok/s"
                      note={`요청당 · ${summary.decode_tps?.n || 0}건 중앙값`}
                      help={`${tips.Decode} 현재 동시 ${summary.current_segment_stats?.scope?.concurrency || run.config.concurrency} 구간의 측정값입니다. 이전 응답 기록은 보존됩니다.`}
                    />
                    <Metric
                      label="TTFT"
                      value={summary.ttft_ms?.median}
                      unit="ms"
                      note={
                        summary.ttft_ms?.n
                          ? `${summary.ttft_ms.n}건 · 중앙값`
                          : "측정값 없음"
                      }
                    />
                    <Metric
                      label="Prefill"
                      value={summary.prefill_tps?.median}
                      unit="tok/s"
                      note={
                        summary.prefill_tps?.n
                          ? `${summary.prefill_tps.n}건 · 서버 측정`
                          : "서버 측정값 없음"
                      }
                    />
                    <Metric
                      label="Throughput"
                      value={totalThroughput.tps}
                      unit="tok/s"
                      note={`추론 포함 · 동시 ${totalThroughput.scope.concurrency} · 완료 ${totalThroughput.n}건`}
                      help={`${THROUGHPUT_DEFINITION} 가시 출력 ${totalThroughput.visible_tps == null ? "분해 미수집" : `${number(totalThroughput.visible_tps)} tok/s`}; 추론 ${totalThroughput.reasoning_tps == null ? "분해 미수집" : `${number(totalThroughput.reasoning_tps)} tok/s`}. 전체 토큰 유효 ${totalThroughput.n}/${totalThroughput.eligible}건 · 제외 ${totalThroughput.excluded} · 미수집 ${totalThroughput.missing}.`}
                    />
                  </div>
                  {items.length > 0 && items.every((i:Obj) => i.task.scorer === "experience") ? <div className="run-notes">성능 전용 시험 · 출력 검증 후 측정 완료로 표시합니다. 정답률은 별도 지능 시험에서 평가합니다.</div> : <div className="correctness-summary" aria-label="채점 결과 요약">
                    <div><span>정답</span><strong>{outcome.correct || 0}<small>문항</small></strong></div>
                    <div><span>오답</span><strong>{outcome.incorrect || 0}<small>문항</small></strong></div>
                    <div><span>현재 정답률 {active && <em>진행 중</em>}</span><strong>{number(outcome.rate)}<small>{outcome.rate == null ? "미산출" : "%"}</small></strong></div>
                    <p>채점 완료 {outcome.scored}문항 기준{outcome.partial ? ` · 부분 점수 ${outcome.partial}문항` : ""}<Help label="정답률 도움말" text="완전 정답 수를 채점 완료 문항 수로 나눕니다. 부분 점수는 별도로 표시하며 요청 오류·채점 실패·대기 문항은 분모에 포함하지 않습니다. 과목별 점수는 원래 채점 규칙을 따릅니다." /></p>
                  </div>}
                  <div className="run-notes">
                    <span>
                      채점 {scored}/{summary.quality_total ?? total}
                    </span>
                    {!!summary.errors && <span>요청 오류 {summary.errors}건</span>}
                    {!!summary.score_errors && <span>채점 실패 {summary.score_errors}건</span>}
                    {!!summary.measurement_errors && <span>출력 검증 실패 {summary.measurement_errors}건</span>}
                    {!!summary.truncated && <span>출력 잘림 {summary.truncated}건</span>}
                    <Help text={tips.score} label="점수 집계 도움말" />
                  </div>
                    <ItemStatus items={items} current={currentIndex} page={actualLedger} following={itemIndex === null} onPage={selectLedgerPage} onSelect={selectQuestion} />
                  </section>
                  <section className="exam-reading" aria-label="문제와 답변 영역">
                  <div className="exam-toolbar">
                    <h2>
                      <BookOpen size={18} />
                      문제와 답변
                      <span>
                        {currentIndex + 1} / {items.length}
                      </span>
                    </h2>
                    <div className="item-controls">
                      <label className="checkline">
                        <input
                          type="checkbox"
                          checked={itemIndex === null}
                          onChange={(e) =>
                            toggleFollowing(e.target.checked)
                          }
                        />
                        진행 따라가기
                      </label>
                      <button
                        className="icon"
                        aria-label="이전 문항"
                        disabled={!currentIndex}
                        onClick={() => selectQuestion(currentIndex - 1)}
                      >
                        <ChevronLeft size={17} />
                      </button>
                      <button
                        className="icon"
                        aria-label="다음 문항"
                        disabled={currentIndex + 1 >= items.length}
                        onClick={() => selectQuestion(currentIndex + 1)}
                      >
                        <ChevronRight size={17} />
                      </button>
                    </div>
                  </div>
                    <ExamReader key={selected + ":" + (item?.task?.id || currentIndex)} item={item} />
                  </section>
                </div>
                <details className="exam-details">
                  <summary>과목별 결과 · 시험 장비 · 계측 상세</summary>
                  <MetricCoverage run={run} />
                  <div className="summary-grid">
                    <section className="panel subject-panel">
                      <div className="panel-heading">
                        <h2>과목별 결과</h2>
                        <Help text={tips.score} label="과목별 결과 도움말" />
                      </div>
                      {summary.quality_total === 0 && <p className="subtle">성능 전용 시험입니다. 지능 점수는 지능 평가팩을 실행하면 표시됩니다.</p>}
                      {subjects.filter(([subject]) => items.some((i:Obj) => i.task.subject === subject && i.task.scorer !== "experience")).map(([subject, v]) => (
                        <div className="subject-row" key={subject}>
                          <div>
                            <strong>{referenceSubjectLabel(subject)}</strong>
                            <small>
                              {v.scored}/{v.total}문항 채점
                            </small>
                          </div>
                          <div className="subject-bar">
                            <i style={{ width: (v.percent || 0) + "%" }} />
                          </div>
                          <b>
                            {number(v.percent, 1)}
                            <small>%</small>
                          </b>
                        </div>
                      ))}
                    </section>
                    <Hardware
                      run={run}
                      onManage={() => setTab("connections")}
                    />
                  </div>
                  <section className="panel ledger">
                    <div className="panel-heading">
                      <h2>
                        문항 기록<span>{number(items.length, 0)}</span>
                      </h2>
                      <div className="item-controls">
                        <button
                          className="icon"
                          aria-label="이전 기록 페이지"
                          disabled={!actualLedger}
                          onClick={() => selectLedgerPage(actualLedger - 1)}
                        >
                          <ChevronLeft size={17} />
                        </button>
                        <span>
                          {actualLedger + 1} / {pageCount}
                        </span>
                        <button
                          className="icon"
                          aria-label="다음 기록 페이지"
                          disabled={actualLedger + 1 >= pageCount}
                          onClick={() => selectLedgerPage(actualLedger + 1)}
                        >
                          <ChevronRight size={17} />
                        </button>
                      </div>
                    </div>
                    <div className="ledger-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>문항</th>
                            <th>과목</th>
                            <th>상태</th>
                            <th>점수</th>
                            <th>TTFT</th>
                            <th>Decode</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items
                            .slice(actualLedger * 50, actualLedger * 50 + 50)
                            .map((v, i) => {
                              const a = v.attempts?.at(-1);
                              return (
                                <tr
                                  key={v.task.id}
                                  className={
                                    actualLedger * 50 + i === currentIndex
                                      ? "selected"
                                      : ""
                                  }
                                >
                                  <td>
                                    <button
                                      onClick={() => {
                                        selectQuestion(actualLedger * 50 + i);
                                        document
                                          .querySelector(".exam-toolbar")
                                          ?.scrollIntoView({
                                            behavior: "smooth",
                                            block: "start",
                                          });
                                      }}
                                    >
                                      {v.task.id}
                                    </button>
                                  </td>
                                  <td>{taskBenchmarkLabel(v.task)}</td>
                                  <td><span className={`judgment-label ${judgment(v).key}`}>{judgment(v).symbol} {judgment(v).label}</span></td>
                                  <td>
                                    {a?.score?.value == null
                                      ? "—"
                                      : number(a.score.value * 100, 0) + "%"}
                                  </td>
                                  <td>{number(a?.metrics?.ttft_ms)} ms</td>
                                  <td>
                                    {number(a?.metrics?.decode_tps)} tok/s
                                  </td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </div>
                  </section>
              <details className="run-conditions">
                <summary>평가 조건과 기록 정보</summary>
                <dl>
                  <div><dt>모델</dt><dd>{run.config.model}</dd></div>
                  <div><dt>시작</dt><dd>{time(run.created_at)}</dd></div>
                  <div>
                    <dt>평가팩</dt>
                    <dd>
                      {benchmarkLabel(run.config.pack_id)} · v{run.pack_version}
                    </dd>
                  </div>
                  <div>
                    <dt>선택 방식</dt>
                    <dd>
                      {run.config.pack_id?.startsWith("timed-") ? "시간 기준 고정 발췌" : run.config.profile === "quick"
                        ? "빠른 시험"
                        : run.config.profile === "full"
                          ? "원본 전체"
                          : "기존 표본 시험"}
                    </dd>
                  </div>
                  <div>
                    <dt>실행 조건</dt>
                    <dd>
                      Temperature {temperatureOmitted(run.config) ? "공급자 기본 (미전송)" : run.config.temperature} · 최대 출력{" "}
                      {number(run.config.max_tokens, 0)} tokens · 동시 요청{" "}
                      {run.config.concurrency}
                    </dd>
                  </div>
                  <div>
                    <dt>평가 항목 해시</dt>
                    <dd>{run.suite_hash}</dd>
                  </div>
                  <div>
                    <dt>실행 ID</dt>
                    <dd>{run.id}</dd>
                  </div>
                  {run.config.note && (
                    <div>
                      <dt>메모</dt>
                      <dd>{run.config.note}</dd>
                    </div>
                  )}
                </dl>
                {!active && (
                  <button disabled={busy} onClick={() => control("rescore")}>
                    <RefreshCw size={14} />
                    저장된 답변 재채점
                  </button>
                )}
              </details>
                </details>
              </>}
            </>
          )}
          <footer>
            bench · 로컬 모델 평가{" "}
            <span>문제·응답·채점 근거를 함께 보관합니다</span>
          </footer>
        </div>
      </main>
      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => e.target === e.currentTarget && setModal(false)}
        >
          <section
            className="modal new-exam"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-exam-title"
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">NEW EXAM</span>
                <h2 id="new-exam-title">새 시험</h2>
              </div>
              <button
                className="icon"
                aria-label="닫기"
                onClick={() => setModal(false)}
              >
                <X size={20} />
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                start();
              }}
            >
              {!connections.some((v) => v.kind === "target") && <div className="setup-notice"><strong>시험할 모델 연결이 아직 없습니다.</strong><p>아래 ‘모델·장비 추가 또는 수정’에서 API를 한 번 저장하면 다음 시험부터 그대로 사용할 수 있습니다.</p></div>}
              {activeRuns.length > 0 && <p className="parallel-start-note">현재 {activeRuns.length}개 시험이 진행 중입니다. 새 시험을 함께 실행할 수 있습니다.<Help text={parallelRunHelp} label="동시 시험 실행 안내"/></p>}
              <div className="form-grid">
                <Field label="시험 이름" wide>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="비워두면 모델명과 시작 시각으로 저장"
                  />
                </Field>
                <Field
                  label="시험할 모델"
                  help="연결 관리에 저장한 모델입니다. 다른 평가팩을 선택해도 연결 정보는 유지됩니다."
                >
                  <select
                    required
                    value={targetId}
                    onChange={(e) => selectTarget(e.target.value)}
                  >
                    <option value="">모델 선택</option>
                    {connections
                      .filter((v) => v.kind === "target")
                      .map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name} · {v.model}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field
                  label="모델 실행 장비"
                  help="모델을 실제로 실행하는 장비를 선택하세요. 로컬 수집은 벤치 앱 실행기의 장비 정보이며 브라우저를 연 기기와 다를 수 있습니다. 원격 모델은 해당 서버에 설치한 수집기로 연결합니다."
                >
                  <select
                    value={deviceId}
                    onChange={(e) => setDeviceId(e.target.value)}
                  >
                    <option value="">장비 수집 안 함</option>
                    {devices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                        {d.mode === "local" ? " · 벤치 앱 실행 장비" : ""}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <button
                type="button"
                className="text-button manage-shortcut"
                onClick={() => {
                  setModal(false);
                  setTab("connections");
                }}
              >
                모델·장비 추가 또는 수정
                <ChevronRight size={14} />
              </button>
              <div className="form-section">
                <Field label="평가팩">
                  <select
                    value={form.pack_id}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        pack_id: e.target.value,
                        profile: e.target.value.startsWith("timed-") ? "full" : form.profile,
                        subjects: initialSubjects(e.target.value),
                      })
                    }
                  >
                    {selectablePacks.map((p) => (
                      <option key={p.id} value={p.id}>
                        {benchmarkLabel(p)} · {number(p.count, 0)}문항
                      </option>
                    ))}
                  </select>
                </Field>
                {!meta.timed_pack && <div className="mode-selector">
                  {[
                    ["quick", "빠른 시험", "고정 문항으로 간단히 확인"],
                    ["full", "원본 전체", "선택한 과목의 모든 문항"],
                  ].map(([key, title, description]) => (
                    <button
                      type="button"
                      key={key}
                      className={form.profile === key ? "selected" : ""}
                      onClick={() => setForm({ ...form, profile: key })}
                    >
                      <span>{title}</span>
                      <small>{description}</small>
                      <strong>
                        {number(key === "full" ? fullCount : quickCount, 0)}문항
                      </strong>
                    </button>
                  ))}
                </div>
                }
                {meta.timed_pack && <p className="subtle">단일 요청 60 tok/s 기준 · 실제 시간은 모델의 풀이 길이에 따라 달라집니다.</p>}
                <div className="pack-installed">
                  <CheckCircle2 size={14} />
                  원본 {number(meta.source_count ?? chosenPack?.count, 0)} ·
                  설치 {number(chosenPack?.count, 0)} · 이번 시험{" "}
                  {number(expectedCount, 0)}문항
                </div>
                <div className="pack-readiness">
                  {Array.isArray(meta.missing_components) && meta.missing_components.length > 0 && <span className="warning">미설치 {meta.missing_components.length}개 팩 · 해당 영역은 미평가</span>}
                  {codePack && (
                    <span>
                      코드 채점 · 선택 설치
                      <Help
                        text="현재 코드 문항은 별도로 준비한 Docker 채점 환경에서 실행합니다. 다른 과목에는 Docker가 필요하지 않습니다. 코드 채점 준비 스크립트는 다운로드한 앱의 packaging 폴더에 있습니다."
                        label="코드 채점 환경 도움말"
                      />
                    </span>
                  )}
                  <span className={`scorer-status scorer-status-${selectedReadiness.state}`} role="status" aria-live="polite">
                    {selectedReadiness.state === "checking" ? <RefreshCw className="scorer-checking-icon" size={14}/> : selectedReadiness.state === "ready" ? <CheckCircle2 size={14}/> : null}
                    {readinessLabels[selectedReadiness.state]}
                    {!requiredScorerNames.length && " · 내장 채점"}
                  </span>
                  {!!requiredScorerNames.length && <button type="button" className="text-button" disabled={readinessChecking} onClick={() => void checkReadiness(requiredScorerNames)}>{readinessChecking ? "확인 중…" : "다시 확인"}</button>}
                  {selectedReadiness.state !== "ready" && <p className="scorer-readiness-detail">{selectedReadiness.detail}</p>}
                  {canSkipCode && <div className="scorer-optional-action">
                    <button type="button" className="text-button" onClick={() => setForm({ ...form, subjects: nonCodeSubjects })}>코드 과목 제외하고 계속</button>
                    <Help label="코드 과목 제외 안내" text="선택한 시험에서 코드 문항을 제외합니다. 제외한 영역은 0점이 아닌 미측정으로 남고, 지능·종합 점수는 측정 범위를 반영합니다. 코드 채점 환경은 나중에 별도로 준비할 수 있습니다."/>
                  </div>}
                </div>
                <div className="subjects-select">
                  {availableSubjects.map((subject) => (
                    <label key={subject}>
                      <input
                        type="checkbox"
                        checked={
                          !form.subjects.length ||
                          form.subjects.includes(subject)
                        }
                        onChange={(e) => {
                          const existing = form.subjects.length
                            ? form.subjects
                            : availableSubjects;
                          const next = e.target.checked
                            ? [
                                ...existing.filter((s) => s !== "__none__"),
                                subject,
                              ]
                            : existing.filter((s) => s !== subject);
                          setForm({
                            ...form,
                            subjects: next.length ? next : ["__none__"],
                          });
                        }}
                      />
                      {subject}
                      <small>{number(chosenPack?.subjects[subject], 0)}</small>
                    </label>
                  ))}
                </div>
              </div>
              <div className="start-concurrency">
                <Field label="동시작업" help="자동은 같은 문항을 단일 요청과 동시 요청으로 비교합니다. 실제 처리량과 완료 시간이 개선될 때만 동시작업을 사용하며, 효과가 없거나 확인하지 못하면 단일 요청으로 진행합니다. 확인은 최대 10분이며 표본 답변은 별도로 보관합니다.">
                  <select aria-label="동시작업 방식" value={form.auto_concurrency ? "auto" : "manual"} onChange={e => setForm({ ...form, auto_concurrency: e.target.value === "auto", concurrency: e.target.value === "auto" ? 8 : 1 })}>
                    <option value="auto">자동 선택</option><option value="manual">직접 지정</option>
                  </select>
                </Field>
                <Field label={form.auto_concurrency ? "최대 동시작업" : "동시작업 수"} help="각 문항은 독립된 대화로 전송됩니다. 자동 선택은 설정한 최대치 안에서 1·2·4·8개를 비교합니다.">
                  <select aria-label="새 시험 동시작업 수" value={form.concurrency} onChange={e => setForm({ ...form, concurrency: Number(e.target.value) })}>
                    {(form.auto_concurrency ? [1,2,4,8] : [1,2,3,4,5,6,7,8]).map(n => <option key={n} value={n}>{n}개</option>)}
                  </select>
                </Field>
              </div>
              <details className="advanced">
                <summary>실행 조건 조정</summary>
                <div className="form-grid">
                  <Field label="Temperature" help="Responses 추론 모델에는 전송하지 않습니다. 해당 모델은 공급자 기본 설정으로 실행하며 실제 요청을 기록합니다.">
                    <input
                      type="number"
                      min="0"
                      max="2"
                      step="0.1"
                      disabled={temperatureOmitted({...form,...connections.find((c)=>c.id===targetId)})}
                      value={form.temperature}
                      onChange={(e) =>
                        setForm({ ...form, temperature: +e.target.value })
                      }
                    />
                  </Field>
                  <Field
                    label="최대 출력 토큰"
                    help="추론 토큰을 포함한 출력 한도입니다. 한도에 도달한 답변은 잘림으로 기록합니다."
                  >
                    <input
                      type="number"
                      min="1"
                      max="32768"
                      value={form.max_tokens}
                      onChange={(e) =>
                        setForm({ ...form, max_tokens: +e.target.value })
                      }
                    />
                  </Field>
                  <Field label="문항 제한시간 (초)">
                    <input
                      type="number"
                      min="5"
                      max="1800"
                      value={form.timeout_s}
                      onChange={(e) =>
                        setForm({ ...form, timeout_s: +e.target.value })
                      }
                    />
                  </Field>
                  <Field
                    label="추론 강도"
                    help="GPT-6.1 Sol은 low·medium·high·xhigh·max입니다. API가 지원하는 값을 사용합니다. Responses 추론 요청에서는 Temperature를 전송하지 않습니다."
                  >
                    <input
                      value={form.reasoning_effort}
                      onChange={(e) =>
                        setForm({ ...form, reasoning_effort: e.target.value })
                      }
                      placeholder="서버 기본"
                    />
                  </Field>
                  <Field
                    label="채점용 모델"
                    help="평가팩이 모델 채점을 요구하는 경우에만 사용합니다. 규칙·정답·실행 기반의 공식 채점은 해당 채점기로 수행합니다."
                  >
                    <select
                      value={judgeId}
                      onChange={(e) => setJudgeId(e.target.value)}
                    >
                      <option value="">사용 안 함</option>
                      {connections
                        .filter((v) => v.kind === "judge")
                        .map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label="메모" wide>
                    <textarea
                      rows={2}
                      value={form.note}
                      onChange={(e) =>
                        setForm({ ...form, note: e.target.value })
                      }
                    />
                  </Field>
                </div>
              </details>
              {freshMeasurement && <section className="measurement-preflight" aria-label="계측 사전검증">
                <div className="panel-heading"><h3>{freshMeasurement.status === "ready" ? "계측 확인 완료" : freshMeasurement.status === "failed" ? "계측 확인 실패" : "계측 누락 확인"}</h3>
                  <Help text="실제 스트리밍 요청으로 확인합니다. 이 요청은 시험 점수에 포함되지 않습니다. 계측값과 장비 상태는 시험 중에도 확인합니다."/>
                </div>
                <div className="preflight-checks">{(freshMeasurement.checks || []).map((check:Obj) => <div key={check.id} className={`preflight-check ${check.status}`}>
                  <span>{check.label || PreflightLabel[check.id] || check.id}</span><b>{check.status === "ok" ? "정상" : check.status === "unsupported" ? "미지원·미제공" : "확인 필요"}</b>
                  {check.detail && <Help text={check.detail} label={`${check.label || check.id} 확인 내용`}/>}</div>)}</div>
                {freshMeasurement.requires_acknowledgement && freshMeasurement.status !== "failed" && <label className="checkline preflight-consent">
                  <input type="checkbox" checked={limitedMetrics} onChange={e=>setLimitedMetrics(e.target.checked)}/>
                  누락 항목을 기록하고 시험 진행
                </label>}
                <button type="button" className="text-button" disabled={busy} onClick={()=>{setMeasurementCheck(null);setLimitedMetrics(false);}}>다시 확인</button>
              </section>}
              {error && <p className="inline-error" role="alert" ref={modalError}>{error}</p>}
              <div className="modal-footer">
                <span>
                  {number(expectedCount, 0)}문항 · {form.auto_concurrency ? `자동 · 최대 ${form.concurrency}개` : `동시 ${form.concurrency}개`}
                </span>
                <button
                  className="primary"
                  type="submit"
                  disabled={busy || !targetId || !expectedCount || selectedReadiness.state !== "ready" || (!!freshMeasurement?.requires_acknowledgement && freshMeasurement.status !== "failed" && !limitedMetrics)}
                >
                  {busy ? "확인 중…" : !freshMeasurement || freshMeasurement.status === "failed" ? "계측 확인" : "시험 시작"}
                  <Play size={15} />
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
function Hardware({ run, onManage }: { run: Obj; onManage: () => void }) {
  const sample = run.telemetry?.at(-1),
    data = sample?.data,
    gpus: Obj[] = data?.gpus || [],
    hasData = data && Object.keys(data).length > 0;
  return (
    <section className="panel hardware">
      <div className="panel-heading">
        <h2>
          <Cpu size={19} />
          시험 장비
        </h2>
        <span className="muted">
          {run.config.device_name || "장비 선택 안 함"}
        </span>
      </div>
      {!hasData ? (
        <div className="device-empty">
          <Cpu size={32} />
          <p>{sample?.error || "이 시험에 수집된 장비 표본이 없습니다."}</p>
          <button onClick={onManage}>장비 연결 관리</button>
        </div>
      ) : (
        <>
          <div className="device-summary">
            <span>
              CPU <b>{number(data.cpu_pct)}%</b>
            </span>
            <span>
              RAM{" "}
              <b>
                {number(
                  typeof data.ram_used_bytes === "number" ? data.ram_used_bytes / 1024 ** 3 : null,
                )}{" "}
                /{" "}
                {number(
                  data.ram_total_bytes
                    ? data.ram_total_bytes / 1024 ** 3
                    : null,
                )}{" "}
                GiB
              </b>
            </span>
          </div>
          {gpus.map((g, i) => (
            <div className="gpu-card" key={g.index ?? i}>
              <strong>{g.name || `GPU ${g.index ?? i}`}</strong>
              <div className="gpu-stats">
                <span>
                  사용률 <b>{number(g.utilization_pct)}%</b>
                </span>
                <span>
                  온도 <b>{number(g.temperature_c)}°C</b>
                </span>
                <span>
                  전력 <b>{number(g.power_w)} W</b>
                </span>
                <span>
                  VRAM <Help text={tips.VRAM} label="VRAM 도움말" />
                  <b>
                    {number(typeof g.vram_used_mib === "number" ? g.vram_used_mib / 1024 : null)} /{" "}
                    {number(g.vram_total_mib ? g.vram_total_mib / 1024 : null)}{" "}
                    GiB
                  </b>
                </span>
              </div>
            </div>
          ))}
          <TelemetryChart samples={run.telemetry || []} />
          <div className="telemetry-footer">
            시험 중 {number(run.telemetry_count ?? run.telemetry?.length, 0)}개 표본 · 마지막{" "}
            {time(sample.received_at)}
            {sample.error && <span className="warning"> · {sample.error}</span>}
          </div>
        </>
      )}
    </section>
  );
}
function TelemetryChart({ samples }: { samples: Obj[] }) {
  const values = samples.slice(-120).map((s) => s.data?.cpu_pct),
    valid = values.filter((v) => typeof v === "number");
  if (valid.length < 2) return null;
  const points = values.map((v, i) =>
    typeof v === "number"
      ? `${(i / Math.max(1, values.length - 1)) * 440},${75 - Math.max(0, Math.min(100, v)) * 0.65}`
      : null,
  );
  const segments: string[] = [];
  let segment: string[] = [];
  points.forEach((p) => {
    if (p) segment.push(p);
    else if (segment.length) {
      segments.push(segment.join(" "));
      segment = [];
    }
  });
  if (segment.length) segments.push(segment.join(" "));
  return (
    <div className="telemetry-chart">
      <div>
        CPU 사용률 <span>최근 {values.length}개 표본 · 0–100%</span>
      </div>
      <svg viewBox="0 0 440 85" role="img" aria-label="시험 중 CPU 사용률 추이">
        <line x1="0" y1="75" x2="440" y2="75" stroke="var(--line)" />
        {segments.map((p, i) => (
          <polyline
            key={i}
            points={p}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
          />
        ))}
      </svg>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
