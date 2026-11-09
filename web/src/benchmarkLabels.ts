type Data = Record<string, any>;
type Benchmark = { label: string; help: string };
export type PublicBenchmarkId = "gsm8k" | "math500" | "mmlu-pro" | "ifeval" | "humaneval" | "mbpp" | "livecodebench";

const benchmarks: Record<string, Benchmark> = {
  bbh: { label: "복합 논리 추론 · BIG-Bench Hard", help: "논리·기호·상식 등 27개 하위 과제를 공식 3-shot CoT 예시로 평가합니다. 고정 정답 추출 규칙의 문항 정확도이며 논문의 과제별 평균과 다릅니다. 공식 원문 불완전·상충 정답이 있는 5문항은 보존하되 점수에서 제외합니다. 별도 확장 평가로, 기존 지능·종합 점수의 가중치에는 포함하지 않습니다." },
  experience: { label: "응답 사용성 · API Experience", help: "영어·한국어·코드·JSON의 고정 입력을 각각 3회 실행합니다. 예열 1회는 제외하고 첫 답변 시간과 가시 출력 속도를 프론티어 API 기준과 비교합니다. 지능 정답률은 채점하지 않습니다." },
  gsm8k: {
    label: "수학 추론 · GSM8K",
    help: "일상적인 문장형 수학 문제의 추론과 계산을 평가합니다. 최종 수치 정답을 비교한 정확도이며, 빠른 시험은 전체 시험에서 고정 추출한 표본입니다.",
  },
  math500: {
    label: "고난도 수학 추론 · MATH-500",
    help: "대수·기하 등 고난도 수학 문제 해결을 평가합니다. 최종 수학 답안의 동치 여부를 채점하며 풀이 과정 자체의 점수는 아닙니다.",
  },
  "mmlu-pro": {
    label: "지식·추론 · MMLU-Pro",
    help: "여러 전문 분야의 지식과 추론을 객관식 문제로 평가합니다. 선택 답안이 정답과 일치한 비율을 표시합니다.",
  },
  ifeval: {
    label: "지시 이행 · IFEval",
    help: "길이·형식·필수 표현 등 검증 가능한 지시 이행을 평가합니다. 공식 strict 규칙으로 한 문항의 모든 지시를 만족한 비율을 표시합니다.",
  },
  humaneval: {
    label: "함수 구현 · HumanEval",
    help: "설명과 함수 서명에 맞는 Python 함수 구현을 평가합니다. 문항당 답변 한 번으로 테스트를 통과한 비율(Pass@1)이며 격리된 코드 채점 환경이 필요합니다.",
  },
  mbpp: {
    label: "기초 프로그래밍 · MBPP",
    help: "짧은 설명에 맞는 기초 Python 프로그램 작성을 평가합니다. 문항당 답변 한 번으로 테스트를 통과한 비율(Pass@1)을 표시합니다.",
  },
  livecodebench: {
    label: "알고리즘 문제 해결 · LiveCodeBench",
    help: "코딩 문제의 알고리즘 설계와 구현을 평가합니다. 공개·비공개 테스트를 통과한 비율(Pass@1)이며 설치된 데이터 버전과 문제 기간을 함께 확인해야 합니다.",
  },
  "ko-core": {
    label: "자체 정형 지시(참고)",
    help: "한국어로 지정한 JSON 구조·필드 이름·값의 정확한 일치를 확인하는 자체 진단 자료입니다. 일반 한국어 능력 점수가 아니며 종합 능력 집계에서 제외합니다. 기존 문제와 점수는 그대로 보존합니다.",
  },
};

export function benchmarkKey(value: string | Data): string {
  const id = String(typeof value === "string" ? value : value?.id || "").toLowerCase();
  if (id.startsWith("experience:") || id.startsWith("api-experience")) return "experience";
  if (id.startsWith("gsm8k")) return "gsm8k";
  if (id.startsWith("bbh")) return "bbh";
  if (id.startsWith("math500") || id.startsWith("math-500")) return "math500";
  if (id.startsWith("mmlu-pro")) return "mmlu-pro";
  if (id.startsWith("ifeval")) return "ifeval";
  if (id.startsWith("humaneval")) return "humaneval";
  if (id.startsWith("mbpp")) return "mbpp";
  if (id.startsWith("livecodebench") || id.startsWith("lcb:")) return "livecodebench";
  if (id.startsWith("ko-core") || id.startsWith("korean-core")) return "ko-core";
  if (id.startsWith("collection-full")) return "collection";
  if (id.startsWith("public-core")) return "legacy";
  return "";
}

export function taskBenchmarkKey(task: Data): string {
  const key = benchmarkKey(task);
  if (key) return key;
  return ({ humaneval: "humaneval", mbpp: "mbpp", livecodebench: "livecodebench", math: "math500", ifeval: "ifeval" } as Record<string, string>)[task?.scorer] || "";
}

export function taskBenchmarkId(task: Data): PublicBenchmarkId | null {
  // Aggregate scores require a dataset identity; a reused scorer is not provenance.
  const key = benchmarkKey(task);
  return key && key !== "experience" && key !== "ko-core" && key !== "collection" && key !== "legacy" && key !== "bbh" ? key as PublicBenchmarkId : null;
}

export function benchmarkLabel(value: string | Data): string {
  const key = benchmarkKey(value);
  const id = typeof value === "string" ? value : value?.id;
  const timed: Record<string,string> = {"timed-10m-v1":"간단 시험 · 10분", "timed-1h-v1":"소형 시험 · 1시간", "timed-4h-v1":"상세 시험 · 4시간", "timed-8h-v1":"전체 시험 · 8시간"};
  if (id === "basic-bench-v2") return "기본 벤치팩";
  if (timed[id]) return timed[id];
  if (key === "collection") return "원본 전 문항 · 종합 평가팩";
  if (key === "legacy") return "기존 공개 평가팩";
  return benchmarks[key]?.label || (typeof value === "string" ? value : value?.name || value?.id) || "평가팩 미기록";
}

export function benchmarkHelp(value: string | Data): string {
  const id = typeof value === "string" ? value : value?.id;
  if (id === "basic-bench-v2") return "수학·지식·논리·지시 이행·코딩을 함께 평가합니다. 10분·1시간·4시간·8시간 중 선택하며, 작은 시험의 문항은 큰 시험에 포함됩니다. Qwen 단일 요청 약 60 tok/s의 실측 기준이며 모델·추론·동시 요청 설정에 따라 실제 시간은 달라집니다.";
  if (String(id).startsWith("timed-")) return "기존 공개 벤치 7종의 고정 발췌입니다. 추론 포함 단일 생성 60 tok/s와 비생성 시간 여유 10%를 기준으로 구성했습니다. 모델별 풀이 길이에 따라 실제 시간은 달라집니다. 작은 팩의 모든 문항은 큰 팩에도 포함되며 원본 전체 점수와 구분합니다.";
  const key = benchmarkKey(value);
  if (key === "collection") return "설치된 평가팩을 함께 실행합니다. 기존 7종의 지능 가중치는 고정하며, BIG-Bench Hard는 별도 확장 정확도로 표시합니다. 문제를 푸는 동안 응답 시간과 생성 속도도 함께 측정합니다.";
  if (key === "legacy") return "기존 실행을 보존하기 위한 표본 평가팩입니다. 당시의 문항·채점 결과를 유지합니다.";
  return benchmarks[key]?.help || "평가팩에 기록된 출처·문항 범위·채점 방법을 확인하세요.";
}

export function isReferenceTask(task: Data): boolean {
  return taskBenchmarkKey(task) === "ko-core";
}

export function referenceSubjectLabel(subject: string): string {
  return subject === "한국어" ? benchmarks["ko-core"].label : subject;
}

export function taskBenchmarkLabel(task: Data): string {
  return benchmarks[taskBenchmarkKey(task)]?.label || referenceSubjectLabel(task?.subject || "평가 분야 미기록");
}
