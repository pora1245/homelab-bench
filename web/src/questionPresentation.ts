import type { Obj } from "./common";
export type QuestionPresentation = { text: string; fullPrompt: string | null; options: string[] | null };

/** Display only. Recognizes the exact MMLU-Pro format emitted by import_full_datasets.py. */
export function questionPresentation(task: Obj): QuestionPresentation {
  const prompt = typeof task?.prompt === "string" ? task.prompt : "";
  const fallback: QuestionPresentation = { text: prompt, fullPrompt: null, options: null };
  const meta = task?.meta || {}, demos = meta.demonstration_ids;
  if (task?.scorer !== "choice" || !String(task?.id || "").startsWith("mmlu-pro:") ||
      typeof meta.category !== "string" || !Array.isArray(demos) ||
      !demos.every(id => Number.isInteger(id))) return fallback;
  const header = `The following are multiple choice questions (with answers) about ${meta.category}. Think step by step and output the answer as 'The answer is (X)' at the end.`;
  const parts = prompt.split("\n\nQuestion: ");
  // Ambiguous boundaries (including an embedded question marker) preserve the full input.
  if (parts[0] !== header || parts.length !== demos.length + 2 ||
      prompt.split("Question: ").length - 1 !== demos.length + 1) return fallback;
  const suffix = "\nAnswer: Let's think step by step.";
  const target = parts.at(-1)!;
  if (!target.endsWith(suffix)) return fallback;
  const text = target.slice(0, -suffix.length), sections = text.split("\nOptions:\n");
  if (sections.length !== 2 || !sections[0].trim()) return fallback;
  const lines = sections[1].split(/\n(?=[A-J]\. )/);
  if (lines.length < 2 || lines.length > 10 || !lines.every((line, i) =>
    line.startsWith(`${String.fromCharCode(65 + i)}. `) && line.slice(3).trim())) return fallback;
  return { text, fullPrompt: prompt, options: lines.map(line => line.slice(3).trim()) };
}
