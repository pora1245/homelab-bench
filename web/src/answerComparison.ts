import type { Obj } from "./common";
import { questionPresentation } from "./questionPresentation";

export type AnswerComparison = {
  referenceLabel: string;
  referenceText: string;
  candidateLabel: string;
  candidateText: string;
  note: string;
  showFullOutput: boolean;
  sameLongAnswer?: boolean;
};

const display = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";

// Only add option text from the evaluated question, never from few-shot examples.
function choiceText(answer: string, task: Obj): string {
  if (!/^[A-J]$/.test(answer)) return answer;
  const options = task.meta?.options;
  if (Array.isArray(options) && typeof options[answer.charCodeAt(0) - 65] === "string")
    return `${answer}. ${options[answer.charCodeAt(0) - 65]}`;
  const verified = questionPresentation(task).options;
  const text = verified?.[answer.charCodeAt(0) - 65];
  return text ? `${answer}. ${text}` : answer;
}

const instructionNames: Record<string, string> = {
  "change_case:capital_word_frequency": "대문자 단어 횟수",
  "change_case:english_capital": "영문 대문자 사용", "change_case:english_lowercase": "영문 소문자 사용",
  "combination:repeat_prompt": "질문 반복", "combination:two_responses": "두 가지 답변",
  "detectable_content:number_placeholders": "자리표시자 개수", "detectable_content:postscript": "추신",
  "detectable_format:constrained_response": "지정 답변", "detectable_format:json_format": "JSON 형식",
  "detectable_format:multiple_sections": "섹션 구성", "detectable_format:number_bullet_lists": "목록 항목 수",
  "detectable_format:number_highlighted_sections": "강조 구간 수", "detectable_format:title": "제목 형식",
  "keywords:existence": "필수 단어", "keywords:forbidden_words": "금지 단어", "keywords:frequency": "단어 횟수",
  "keywords:letter_frequency": "문자 횟수", "language:response_language": "답변 언어",
  "length_constraints:nth_paragraph_first_word": "문단 시작 단어", "length_constraints:number_paragraphs": "문단 수",
  "length_constraints:number_sentences": "문장 수", "length_constraints:number_words": "단어 수",
  "punctuation:no_comma": "쉼표 사용 금지", "startend:end_checker": "끝 문구", "startend:quotation": "따옴표로 감싸기",
};
function requirementText(id: string, kwargs: Obj = {}): string {
  const name = instructionNames[id] || "문제에 지정된 조건";
  const values = Object.values(kwargs).filter(v => v != null && v !== "").map(v =>
    v === "at least" ? "이상" : v === "less than" ? "미만" : Array.isArray(v) ? v.join(", ") : String(v));
  return values.length ? `${name}: ${values.join(" · ")}` : name;
}

function finishComparison(comparison: AnswerComparison, score: Obj | undefined): AnswerComparison {
  return {
    ...comparison,
    // Deduplicate presentation only after a complete, positive grading result.
    // Different expressions, partial credit and failed formats remain separate.
    sameLongAnswer: score?.state === "scored" && score.value === 1 &&
      comparison.referenceText.length >= 80 &&
      comparison.referenceText === comparison.candidateText,
  };
}

/** Display saved grading evidence. Never re-extract an answer or change a verdict. */
export function answerComparison(item: Obj): AnswerComparison {
  const task = item?.task || {}, attempt = item?.attempts?.at(-1);
  const output = typeof attempt?.output === "string" ? attempt.output : "";
  const hasOutput = output.trim().length > 0;
  const completed = ["done", "error"].includes(item?.status);
  const score = attempt?.score, detail = typeof score?.detail === "string" ? score.detail : "";
  const extra = score?.extra || {};
  const waiting = completed ? "정답 정보를 불러오는 중" : "답변 완료 후 표시";
  if (task.scorer === "experience" || String(task.id).startsWith("experience:")) return {
    referenceLabel: "측정 기준", referenceText: task.meta?.warmup ? "예열 · 점수 제외" : "유효한 답변의 TTFT·Decode 측정",
    candidateLabel: "측정 결과", candidateText: completed ? detail || "측정 결과 없음" : "측정 중",
    note: "정답률은 별도 지능 평가에서 채점합니다.", showFullOutput: hasOutput,
  };
  if (!completed || task.answer == null) return {
    referenceLabel: "정답", referenceText: waiting,
    candidateLabel: "최종 답안", candidateText: item?.status === "running" ? "생성 중" : "대기",
    note: "답변이 완료되면 저장된 정답과 채점 결과를 표시합니다.", showFullOutput: false,
  };
  const comparison: AnswerComparison = {
    referenceLabel: "정답", referenceText: display(task.answer),
    candidateLabel: "최종 답안", candidateText: hasOutput ? output : "저장된 답안 없음",
    note: "저장된 정답과 채점에 사용된 답안입니다. 판정과 원문은 변경하지 않습니다.",
    showFullOutput: hasOutput,
  };
  if (task.scorer === "numeric" || task.scorer === "choice") {
    const prefix = task.scorer === "numeric" ? "최종 수치 추출: " : "선택 답안: ";
    const saved = extra.extracted_answer ?? (detail.startsWith(prefix) ? detail.slice(prefix.length) : null);
    comparison.candidateText = saved == null ? "채점 추출값 없음" : String(saved);
    if (task.scorer === "choice") {
      comparison.referenceLabel = "기준 정답";
      comparison.candidateLabel = "모델 선택";
      comparison.referenceText = choiceText(comparison.referenceText, task);
      comparison.note = "기준 정답에는 문제의 보기를 표시합니다. 모델 선택은 실제 출력에서 채점기가 추출한 선택값이며, 보기 문장을 덧붙이지 않습니다.";
    }
    return finishComparison(comparison, score);
  }
  if (task.scorer === "math") {
    comparison.candidateText = extra.candidate_parsed == null ? "채점 수식 기록 없음" :
      String(extra.candidate_parsed).trim() === "[]" ? "수식 추출 실패" : display(extra.candidate_parsed);
    comparison.note = "모델 답안은 채점기가 해석한 수식입니다. 여러 표현이 추출되면 함께 표시합니다.";
    return finishComparison(comparison, score);
  }
  if (task.scorer === "bbh") {
    comparison.candidateText = extra.extracted_answer == null ? "답안 추출값 없음" : display(extra.extracted_answer);
    return finishComparison(comparison, score);
  }
  if (task.scorer === "json") {
    comparison.referenceLabel = "요구한 JSON";
    comparison.candidateLabel = "제출한 JSON";
    try { comparison.candidateText = JSON.stringify(JSON.parse(output), null, 2); }
    catch { comparison.candidateText = hasOutput ? output : "저장된 답안 없음"; }
    comparison.note = "키·값·구조는 유지하고 들여쓰기만 정리합니다. 유효하지 않은 JSON은 원문을 표시합니다.";
    return finishComparison(comparison, score);
  }
  if (["humaneval", "mbpp", "livecodebench"].includes(task.scorer)) {
    comparison.referenceLabel = "통과 조건";
    comparison.referenceText = "공식 테스트 모두 통과";
    comparison.candidateLabel = "코드 실행 결과";
    const tests = extra.test_results;
    comparison.candidateText = Array.isArray(tests)
      ? `${tests.filter(v => v === true || v === 1).length} / ${tests.length} 테스트 통과`
      : score?.state === "scored" && score.value === 1 ? "모든 테스트 통과"
      : score?.state === "scored" && score.value === 0 ? "테스트 실패"
      : "채점 결과 없음";
    comparison.note = "예시 코드와 달라도 공식 테스트를 통과하면 정답입니다. 제출 코드는 답변 원문에서 확인할 수 있습니다.";
    return finishComparison(comparison, score);
  }
  if (task.scorer === "ifeval") {
    const ids = Array.isArray(task.meta?.instruction_id_list) ? task.meta.instruction_id_list : [];
    const checks = Array.isArray(extra.strict) ? extra.strict : [];
    comparison.referenceLabel = "요구 조건";
    comparison.referenceText = ids.length ? ids.map((id: string, i: number) =>
      `${i + 1}. ${requirementText(id, task.meta?.kwargs?.[i])}`).join("\n") : "문제의 모든 지시 조건 충족";
    comparison.candidateLabel = "조건별 결과";
    comparison.candidateText = ids.length ? ids.map((_: string, i: number) =>
      `${i + 1}. ${checks[i] === true ? "충족" : checks[i] === false ? "불충족" : "미채점"}`).join("\n")
      : detail || "채점 결과 없음";
    comparison.note = "단일 정답 문장 대신 공식 strict 조건의 충족 여부를 비교합니다.";
  }
  return finishComparison(comparison, score);
}
