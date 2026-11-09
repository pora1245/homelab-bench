import { useMemo } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  Compass,
  FileText,
  FlaskConical,
  Gauge,
  Layers3,
  Plus,
  Sparkles,
} from "lucide-react";
import { Help, runStatus, number, time, type Obj } from "./common";
import {
  assessRun,
  supplementalBenchmarks,
  type ScoreEstimate,
} from "./assessment";
import { benchmarkHelp } from "./benchmarkLabels";
import "./home.css";

export type HomeTestIntent = {
  pack_id: "basic-bench-v2";
  profile: "1h" | "10m";
};
export type HomeReportFormat = "overview" | "intelligence" | "performance";
export type HomeProps = {
  /** Parent supplies the selected record; Home evaluates that record only. */
  run: Obj | null;
  loading?: boolean;
  hasTarget: boolean;
  onOpenConnections: () => void;
  onNewTest: (intent?: HomeTestIntent) => void;
  onOpenReport: (runId: string, format: HomeReportFormat) => void;
};

const statusText = (score: ScoreEstimate) =>
  ({
    unavailable: "자료 필요",
    partial: "부분 평가 · 잠정",
    provisional: "잠정",
    complete: "완료",
  })[score.state];
const scoreHelp = {
  overview:
    "100점 만점입니다. 지능 70%·API 사용성 30%의 기하평균이며, 성능 1,000점 이상은 종합 계산에서 만점으로 처리합니다. 성능 점수 자체는 계속 올라갑니다. 진행 중에는 채점된 영역 기준 잠정 점수를 표시합니다. 미평가 영역은 상세에서 확인할 수 있습니다.",
  intelligence:
    "수학·지식·지시 이행·코딩에 각각 25%의 고정 비중을 적용합니다. 진행 중에는 채점된 평가별 평균을 이 비중으로 합산한 잠정 점수입니다. 미평가 영역을 대신 채우지 않으며, 완료 점수와 구분합니다. 가능한 최종 범위는 상세에 표시합니다.",
  performance:
    "단일 요청의 가시 Decode와 TTFT를 GPT-6.1 Sol 실측 기준과 비교해 기본점수를 계산합니다. 같은 문항·설정에서 검증된 동시 처리 이득은 최대 30% 가산하며, 성능 점수에는 상한이 없습니다. 동시 요청의 길어진 TTFT로 기본점수를 낮추지 않습니다. 문항 구성·추론 설정·부하의 영향을 받습니다.",
};
function ScoreCard({
  title,
  score,
  kind,
  onReport,
}: {
  title: string;
  score: ScoreEstimate;
  kind: HomeReportFormat;
  onReport: () => void;
}) {
  const bounded = kind !== "performance";
  const displayScore = (value: number | null) => value == null ? "—" : number(value, bounded ? 1 : 0);
  const numeric =
    score.value != null
      ? displayScore(score.value)
      : score.lower != null
        ? `${displayScore(bounded ? score.lower : Math.floor(score.lower))}–${displayScore(bounded ? score.upper : Math.ceil(score.upper ?? score.lower))}`
        : "—";
  return (
    <article className={`home-score home-score-${kind}`}>
      <div className="home-score-heading">
        <span>{title}</span>
        <Help label={title + " 점수 설명"} text={scoreHelp[kind]} />
      </div>
      <div
        className="home-score-value"
        aria-label={
          score.value != null
            ? `${score.value}점`
            : score.lower != null
              ? `잠정 ${score.lower}에서 ${score.upper}점`
              : "미산출"
        }
      >
        {numeric}
        <small>{bounded ? "/ 100" : "점"}</small>
      </div>
      <div className="home-score-status">
        <i className={score.state} />
        {statusText(score)}
      </div>
      {bounded ? <div className="home-score-scale" aria-hidden="true">
        {score.lower != null && (
          <>
            <i className="known" style={{ width: `${score.value ?? score.lower}%` }} />
            <i
              className="unmeasured"
              style={{
                left: `${score.lower}%`,
                width: `${score.value == null ? Math.max(0, (score.upper ?? score.lower) - score.lower) : 0}%`,
              }}
            />
          </>
        )}
      </div> : <div className="home-score-baseline">상한 없음 · 기준 1,000점</div>}
      <p>
        {kind === "performance"
          ? "현재 시험 조건의 응답 경험"
          : score.state === "partial"
            ? `평가 범위 ${number(score.coverage)}%`
            : score.state === "unavailable"
              ? "측정 대기"
              : kind === "intelligence"
                ? "영역별 가중 점수"
                : "지능 + 응답 성능"}
      </p>
      <button className="home-report-link" onClick={onReport}>
        {title} 보고서
        <ArrowUpRight size={14} />
      </button>
    </article>
  );
}

export function Home({
  run,
  loading = false,
  hasTarget,
  onOpenConnections,
  onNewTest,
  onOpenReport,
}: HomeProps) {
  const assessment = useMemo(() => assessRun(run), [run]);
  const performance = assessment.performanceEvidence;
  const current = assessment.currentScores;
  const completeSetup = () =>
    onNewTest({
      pack_id: "basic-bench-v2",
      profile: "1h",
    });
  if (loading && !run)
    return (
      <section className="bench-home home-loading" aria-busy="true">
        <div className="home-loading-dot" />
        <p>선택한 시험을 불러오고 있습니다.</p>
      </section>
    );
  if (!run)
    return (
      <section className="bench-home home-welcome">
        <div className="home-welcome-mark">
          <FlaskConical size={36} />
        </div>
        <span className="eyebrow">YOUR MODEL, MEASURED</span>
        <h1>{hasTarget ? "첫 시험으로 시작하세요" : "모델 연결이 필요합니다"}</h1>
        <p>
          {hasTarget ? <>모델이 얼마나 잘 답하고 얼마나 빠르게 반응하는지<br />한 번의 시험으로 확인합니다.</> : <>연결 관리에서 시험할 모델 API를 저장하세요.<br />저장한 연결은 다음 시험에서도 그대로 사용합니다.</>}
        </p>
        <button className="primary" onClick={hasTarget ? () => onNewTest() : onOpenConnections}>
          {hasTarget ? <Plus size={17} /> : <ArrowRight size={17} />}{hasTarget ? "새 시험" : "연결 관리"}
        </button>
        <div className="home-welcome-steps">
          <span>
            <Check size={15} />
            모델 선택
          </span>
          <ChevronRight size={14} />
          <span>문제 풀이</span>
          <ChevronRight size={14} />
          <span>결과 보고서</span>
        </div>
      </section>
    );
  const isActive = [
    "running",
    "pausing",
    "scoring",
    "pending",
    "cancelling",
  ].includes(run.status);
  const missing = assessment.benchmarks.filter((b) => b.coverage < 1);
  const supplemental = supplementalBenchmarks(run);
  return (
    <section className="bench-home">
      <div className="home-header">
        <div>
          <h1>시험 결과</h1>
        </div>
        <button className="primary" onClick={() => onNewTest()}>
          <Plus size={16} />새 시험
        </button>
      </div>
      <div className="home-run-line">
        <div className="home-run-icon">
          <FlaskConical size={18} />
        </div>
        <div>
          <strong>{run.config?.name || "선택한 시험"}</strong>
          <span>{run.config?.model || "모델 미기록"}</span>
        </div>
        <div className="home-run-meta">
          <span>{time(run.created_at)}</span>
          <small>
            {runStatus(run)} · 응답 {number(run.summary?.completed ?? 0, 0)} /{" "}
            {number(run.summary?.total ?? assessment.requestedItems, 0)}문항
          </small>
        </div>
      </div>
      {run.provenance === "imported_record" && <p className="warning">가져온 기록 · 원본 실행과 측정 조건을 이 앱에서 재검증하지 않았습니다. 점수는 저장된 자료의 환산 결과입니다.</p>}
      <div className="home-score-grid">
        <ScoreCard
          title="종합"
          kind="overview"
          score={current.overall}
          onReport={() => onOpenReport(run.id, "overview")}
        />
        <ScoreCard
          title="지능"
          kind="intelligence"
          score={current.intelligence}
          onReport={() => onOpenReport(run.id, "intelligence")}
        />
        <ScoreCard
          title="성능"
          kind="performance"
          score={current.performance}
          onReport={() => onOpenReport(run.id, "performance")}
        />
      </div>
      <div className="home-policy-line">
        <span>
          단일 성능 + 동시 처리 가산 · v5
          <Help
            label="점수의 의미"
            text="지능과 종합은 100점 만점, 성능은 기준 API가 1,000점이며 상한이 없습니다. 단일 요청의 Decode와 TTFT로 기본점수를 계산하고, 같은 표본에서 검증된 동시 처리 이득만 가산합니다. 단일 측정 이력은 동시작업으로 전환해도 유지합니다. 이전 점수 버전과 구분합니다."
          />
        </span>
        {isActive && <span className="home-progress-label">진행 중 결과</span>}
        <span>채점 {number(current.scored, 0)}/{number(current.selected, 0)} · {current.evaluatedDomains.length ? current.evaluatedDomains.join(" · ") : "평가 대기"}</span>
      </div>
      <div className="home-insight-grid">
        <article className="home-evidence">
          <div className="home-section-title">
            <h2>
              <Layers3 size={18} />
              평가 분야
            </h2>
            <Help
              label="평가 범위 설명"
              text="수학(GSM8K·MATH-500), 지식(MMLU-Pro), 지시 이행(IFEval), 코딩(HumanEval·MBPP·LiveCodeBench)을 고정 비중으로 계산합니다. 상단은 현재 채점된 평가별 평균을 고정 비중으로 합산한 잠정 점수입니다. 아직 없는 영역은 완료 범위에만 남깁니다."
            />
          </div>
          <div className="home-benchmark-list">
            {assessment.benchmarks.map((b) => (
              <div className="home-benchmark-row" key={b.id}>
                <div>
                  <span>{b.label}</span>
                  <Help label={b.label + " 설명"} text={benchmarkHelp(b.id)} />
                </div>
                <span className={b.scored ? "measured" : "missing"}>
                  {b.scored
                    ? `${number(b.percent)}% · ${b.scored}/${b.required}`
                    : "미측정"}
                </span>
              </div>
            ))}
            {supplemental.map((b) => (
              <div className="home-benchmark-row" key={b.id}>
                <div><span>{b.label}</span><Help label={b.label + " 설명"} text={benchmarkHelp(b.id)} /></div>
                <span className={b.scored ? "measured" : "missing"}>{b.percent == null ? "미채점" : `${number(b.percent)}% · ${b.scored}/${b.selected}`}</span>
              </div>
            ))}
          </div>
          {!!supplemental.length && <p className="home-reference-note">확장 평가의 정확도입니다. 기존 지능·종합 점수의 고정 비중은 유지합니다.</p>}
          {!!assessment.referenceItems && (
            <p className="home-reference-note">
              자체 정형 지시 {assessment.referenceItems}문항은 참고 결과로
              구분했습니다.
            </p>
          )}
          {missing.length > 0 && (
            <button className="home-fill-button" onClick={completeSetup}>
              종합 시험 설정
              <ArrowRight size={15} />
            </button>
          )}
        </article>
        <article className="home-experience">
          <div className="home-section-title">
            <h2>
              <Gauge size={18} />
              응답 성능
            </h2>
            <Help
              label="응답 경험의 측정 범위"
              text={`단일 요청 기록의 가시 Decode와 TTFT를 사용합니다. 기존 일반 문항의 c1 측정을 우선하고, 없으면 자동 선택의 c1 표본, 이전 단일 성능 표본 순서로 확인합니다. 동시 처리 가산은 같은 입력과 설정의 처리량·완료시간 개선을 검증한 경우에만 적용합니다. ${performance.bonusReason || ""}`}
            />
          </div>
          <div className="home-timing">
            <div>
              <span>첫 답변 · TTFT</span>
              <strong>
                {performance.ttftMedian == null
                  ? "—"
                  : number(performance.ttftMedian / 1000, 2)}
                <small>초</small>
              </strong>
              <p>유효 문제 풀이 기록의 중앙값</p>
            </div>
            <div>
              <span>단일 Decode</span>
              <strong>
                {performance.concurrentDecodeTps == null
                  ? "—"
                  : number(performance.concurrentDecodeTps)}
                <small>tok/s</small>
              </strong>
              <p>
                {`단일 유효 측정 ${number(performance.singleN || 0, 0)}건`}
              </p>
            </div>
          </div>
          <p className="home-reference-note">기본 {performance.singleScore == null ? "미측정" : `${number(performance.singleScore, 0)}점`} · 동시 처리 {performance.bonusState === "measured" ? `+${number(performance.concurrencyBonus || 0, 0)}점 (+${number(performance.concurrencyBonusPercent || 0)}%)` : performance.bonusState === "no_gain" ? "가산 없음" : performance.bonusState === "pending" ? "확인 중" : "미측정"}</p>
          <p className="home-reference-note">기준: {assessment.reference.model} · {assessment.reference.reasoning_effort} · {assessment.reference.measured_at ? time(assessment.reference.measured_at) : "측정 준비 중"}</p>
          <div className="home-usability"><strong>{assessment.usability.label}</strong><p>{assessment.usability.detail}</p></div>
          <div className="home-experience-summary">
            <Compass size={20} />
            <p>
              {assessment.performance.state === "unavailable"
                ? assessment.performance.reason
                : `단일 유효 ${number(performance.pairedCount, 0)}건 · ${performance.throughputGain != null ? `동시 처리량 ${number(performance.throughputGain, 2)}배` : "동시 처리 효과 미확정"}`}
            </p>
          </div>
          <div className="home-next">
            <span>
              {assessment.intelligence.state === "partial"
                ? "다음 한 단계"
                : "보고서에서 더 자세히"}
            </span>
            <h3>
              {assessment.intelligence.state === "partial"
                ? "아직 보지 못한 영역을 확인하세요"
                : "어떤 문제에서 차이가 났는지 보세요"}
            </h3>
            <p>
              {assessment.intelligence.state === "partial"
                ? `${missing.length}개 평가의 자료가 더 필요합니다. 나머지 분야가 채점되면 점수가 갱신됩니다.`
                : "점수의 근거와 실행 조건을 함께 읽으면 다음 시험을 고르기 쉽습니다."}
            </p>
            <button onClick={() => onOpenReport(run.id, "overview")}>
              <FileText size={15} />
              종합 보고서 보기
              <ArrowRight size={14} />
            </button>
          </div>
        </article>
      </div>
      <section className="home-guidance">
        <div className="home-section-title">
          <h2>
            <Sparkles size={18} />
            다음 시험을 위한 안내
          </h2>
          <span>선택한 기록을 바탕으로</span>
        </div>
        <div className="home-guide-grid">
          {assessment.guides.map((guide, index) => (
            <article className="home-guide" key={guide.id}>
              <span className="home-guide-number">0{index + 1}</span>
              <h3>{guide.title}</h3>
              <p className="home-guide-evidence">{guide.evidence}</p>
              <p>{guide.next}</p>
            </article>
          ))}
        </div>
      </section>
      <details className="home-formula">
        <summary>API 기준 점수와 산식 확인</summary>
        <div>
          <p><b>지능:</b> 수학·지식·지시 이행·코딩에 각각 25%를 적용한 100점 만점입니다. 수학은 GSM8K/MATH-500을 절반씩, 코딩은 세 평가를 같은 비중으로 계산합니다.</p>
          <p><b>잠정 점수:</b> 현재 채점된 평가별 평균에 고정 비중을 적용하고, 확인된 비중 안에서 계산합니다. 빠진 영역을 대신 채우지 않으며 전체 평가가 완료되기 전까지 잠정입니다.</p>
          {assessment.intelligence.state === "partial" && <p><b>가능한 최종 범위:</b> 지능 {number(assessment.intelligence.lower)}–{number(assessment.intelligence.upper)} / 100{assessment.overall.lower != null ? ` · 종합 ${number(assessment.overall.lower)}–${number(assessment.overall.upper)} / 100` : ""}. 남은 문항을 모두 틀리거나 맞았을 때의 범위이며 통계적 신뢰구간이 아닙니다.</p>}
          <p><b>성능:</b> 단일 요청 기본점수는 1,000 × √((단일 Decode / 기준 Decode) × (기준 TTFT / 단일 TTFT))입니다. 기준은 저장된 Sol c1 응답의 {number(performance.baselineDecode)} tok/s · {number(performance.baselineTtft)} ms입니다. 동일 문항·설정에서 검증된 Throughput 이득 2배마다 기본점수의 10%, 최대 30%를 가산합니다. 처리량과 완료 시간이 모두 10% 이상 개선되고 문항별 채점 결과가 나빠지지 않은 경우에만 적용합니다. 동시 요청의 TTFT로 기본점수를 낮추지 않으며, 성능 점수에는 상한이 없습니다.</p>
          <p><b>종합:</b> 100 × (지능 / 100)<sup>0.7</sup> × min(성능 / 1,000, 1)<sup>0.3</sup>. 100점 만점이며 진행 중에는 잠정 지능 점수로 계산합니다. 비중은 제품 정책으로 정한 값입니다.</p>
          <p><b>사용성:</b> 점수와 별도로 첫 반응과 생성 속도를 설명합니다. 답변의 정확성은 지능 평가로 확인합니다.</p>
          <p className="home-formula-id">정책 {assessment.policy} · 공식 점수·시장 순위가 아닌 자체 환산 지표</p>
          <h3>이 기록의 비교 조건</h3>
          <p>{assessment.comparison.complete ? "기록된 조건을 확인했습니다. 같은 조건의 결과끼리 비교하세요." : "확인되지 않은 조건이 있어 참고용으로 해석하세요."}</p>
          <ul>{assessment.comparison.details.map((detail, i) => <li key={i}>{detail}</li>)}</ul>
          <p className="home-comparison-key">조건 식별자: {assessment.comparison.key}</p>
          <p>기준 모델·추론 강도·측정일·집계 방식을 버전으로 고정합니다. 시험의 문항 구성과 동시 요청 수가 다르면 점수에도 영향을 줍니다.</p>
        </div>
      </details>
      <details className="home-formula home-legacy">
        <summary>이전 v1·v2 환산값 보기</summary>
        <div>
          <p>동일한 원시 기록에 이전 산식을 적용한 값입니다. 현재 API 기준 점수와 직접 비교하지 않습니다. 문제·모델 답변·채점 결과는 그대로 보존합니다.</p>
          <p><b>v1 · 100점 기준</b></p><div className="home-legacy-values">{([["종합", assessment.legacyV1.overall], ["지능", assessment.legacyV1.intelligence], ["성능", assessment.legacyV1.performance]] as const).map(([label, score]) => <span key={label}><b>{label}</b> {score.value != null ? number(score.value) : score.lower != null ? `${number(score.lower)}–${number(score.upper)}` : "—"} / 100</span>)}</div>
          <p><b>v2 · 이전 자체 환산 기준</b></p>
          <div className="home-legacy-values">{([["종합", assessment.legacyV2.overall], ["지능", assessment.legacyV2.intelligence], ["성능", assessment.legacyV2.performance]] as const).map(([label, score]) => <span key={label}><b>{label}</b> {score.value != null ? number(score.value) : score.lower != null ? `${number(score.lower)}–${number(score.upper)}` : "—"}{label === "지능" ? " / 100" : "점"}</span>)}</div>
        </div>
      </details>
    </section>
  );
}
