import type { Obj } from "./common";

export type AnswerComparison = {
  referenceLabel: string;
  referenceText: string;
  candidateLabel: string;
  candidateText: string;
  note: string;
  showFullOutput: boolean;
};

const display = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";

/** Presentation only. Uses the saved answer and verdict evidence without grading again. */
export function answerComparison(item: Obj): AnswerComparison {
  const task = item?.task || {}, attempt = item?.attempts?.at(-1);
  const output = typeof attempt?.output === "string" ? attempt.output : "";
  const hasOutput = output.trim().length > 0;
  const completed = ["done", "error"].includes(item?.status);
  if (task.scorer === "experience" || String(task.id).startsWith("experience:")) return {
    referenceLabel: "측정 기준", referenceText: task.meta?.warmup ? "연결·출력 확인용 예열입니다. 성능 점수에서는 제외합니다." : "정답률을 채점하지 않는 응답 사용성 시험입니다. 완료된 유효 출력의 TTFT와 가시 출력 속도를 비교합니다.",
    candidateLabel: "모델 출력", candidateText: hasOutput ? output : "모델 답변을 기다리고 있습니다.",
    note: "정확성 평가는 별도 지능 평가팩으로 진행합니다.", showFullOutput:false,
  };
  if (!completed || task.answer == null) {
    return {
      referenceLabel: "정답 · 공개 대기",
      referenceText: completed ? "정답 정보를 불러오는 중입니다." : "답변이 완료되면 정답과 채점 기준을 표시합니다.",
      candidateLabel: item?.status === "running" ? "모델 답변 · 생성 중" : "모델 답변",
      candidateText: hasOutput ? output : "모델 답변을 기다리고 있습니다.",
      note: "정답 자료가 공개되기 전에는 정답이나 예시 풀이를 표시하지 않습니다.",
      showFullOutput: false,
    };
  }

  const comparison: AnswerComparison = {
    referenceLabel: "정답",
    referenceText: display(task.answer),
    candidateLabel: "모델 답변",
    candidateText: hasOutput ? output : "저장된 모델 답변이 없습니다.",
    note: "저장된 정답과 모델 답변을 표시합니다. 판정은 기존 채점 결과를 따릅니다.",
    showFullOutput: false,
  };
  const score = attempt?.score, detail = typeof score?.detail === "string" ? score.detail : "";
  const prefix = task.scorer === "numeric" ? "최종 수치 추출: " : task.scorer === "choice" ? "선택 답안: " : "";
  if (prefix && detail.startsWith(prefix)) {
    comparison.candidateLabel = "채점에 사용된 답";
    comparison.candidateText = detail.slice(prefix.length);
    comparison.note = "기존 채점 기록에서 추출한 답입니다. 전체 모델 출력은 별도로 보존하며 답을 다시 추출하거나 판정하지 않습니다.";
    comparison.showFullOutput = hasOutput;
    return comparison;
  }
  if (task.scorer === "math" && score?.extra?.candidate_parsed != null) {
    comparison.candidateLabel = "채점기가 해석한 수식";
    comparison.candidateText = display(score.extra.candidate_parsed);
    comparison.note = "채점기에 저장된 수식 해석 결과입니다. 원래 출력은 별도로 보존하며 수식 동치 여부는 기존 판정을 따릅니다.";
    comparison.showFullOutput = hasOutput;
    return comparison;
  }
  if (task.scorer === "json") {
    comparison.referenceLabel = "요구한 JSON 구조·값";
    comparison.candidateLabel = "모델이 출력한 JSON 원문";
    comparison.note = "모델 출력의 키·값·구조를 바꾸지 않습니다. 정답 JSON은 읽기 쉽게 들여쓰기만 적용합니다.";
    return comparison;
  }
  if (["humaneval", "mbpp", "livecodebench"].includes(task.scorer)) {
    const example = [task.meta?.canonical_solution, task.meta?.code, task.meta?.reference_code]
      .find((value) => typeof value === "string" && value.trim());
    comparison.referenceLabel = example ? "공식 예시 풀이" : "정답 기준";
    comparison.referenceText = example || comparison.referenceText;
    comparison.candidateLabel = "모델이 작성한 코드·답변";
    comparison.note = example
      ? "예시와 다른 구현도 정답 테스트를 통과하면 정답입니다. 코드 문자열이 같은지를 비교하는 평가가 아닙니다."
      : "저장된 공식 예시 풀이가 없어 정답 기준을 표시합니다. 모델 코드는 테스트 통과 여부로 채점합니다.";
    return comparison;
  }
  if (task.scorer === "ifeval") {
    comparison.referenceLabel = "지시 이행 기준";
    comparison.note = "정답 문장이 하나로 정해진 문제가 아닙니다. 문제에 명시된 지시 조건을 만족하는지 공식 strict 규칙으로 확인합니다.";
  }
  return comparison;
}
