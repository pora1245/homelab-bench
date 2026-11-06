#!/usr/bin/env python3
"""Reproduce BBH 3-shot CoT from hash-pinned official source; no model calls.

Default is offline. --download obtains only missing immutable source files.
Original files (including canary notices) are retained without modifications.
"""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "datasets/sources/bbh-manifest.json"
SOURCE = ROOT / "datasets/sources/bbh"
OUTPUT = ROOT / "datasets/bbh-cot-full-v1.json"
SEED = "llm-bench-bbh-quick-v1"
SCORER_VERSION = "bbh-marker-exact-v1"
PROMPT_SUFFIX = "\nA: Let's think step by step."
SOURCE_ISSUES = {
    "bbh:snarks:0088": ("source_incomplete", "원본자료 불완전: 공식 snarks.json의 0-based 88번 입력이 '(A) The NB'에서 잘려 선택지 B가 없습니다. 원본 보존, 점수 제외."),
    "bbh:causal_judgement:0032": ("source_conflict", "원본 정답 상충: causal_judgement:0032/0119의 입력은 같지만 정답이 No/Yes로 다릅니다. 원본 보존, 점수 제외."),
    "bbh:causal_judgement:0119": ("source_conflict", "원본 정답 상충: causal_judgement:0032/0119의 입력은 같지만 정답이 No/Yes로 다릅니다. 원본 보존, 점수 제외."),
    "bbh:causal_judgement:0036": ("source_conflict", "원본 정답 상충: causal_judgement:0036/0104의 입력은 같지만 정답이 No/Yes로 다릅니다. 원본 보존, 점수 제외."),
    "bbh:causal_judgement:0104": ("source_conflict", "원본 정답 상충: causal_judgement:0036/0104의 입력은 같지만 정답이 No/Yes로 다릅니다. 원본 보존, 점수 제외."),
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def sources(directory=SOURCE, download=False):
    manifest = json.loads(MANIFEST.read_text())
    for item in manifest["files"]:
        relative = Path(item["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Unsafe source path")
        path = directory / relative
        if not path.exists():
            if not download:
                raise FileNotFoundError(f"Missing {path}; use --download")
            with urllib.request.urlopen(item["url"], timeout=90) as response:
                data = response.read(item["bytes"] + 1)
            if len(data) != item["bytes"] or sha(data) != item["sha256"]:
                raise ValueError(f"Downloaded source hash/size mismatch: {relative}")
            path.parent.mkdir(parents=True, exist_ok=True)
            partial = path.with_name(path.name + ".part")
            partial.write_bytes(data)
            partial.replace(path)
        data = path.read_bytes()
        if len(data) != item["bytes"] or sha(data) != item["sha256"]:
            raise ValueError(f"Existing source hash/size mismatch: {relative}; not overwritten")
    return manifest


def prompt_template(text):
    header, separator, body = text.partition("\n-----\n")
    if not separator or "canary GUID" not in header or body.count("\nQ: ") != 3:
        raise ValueError("Official CoT template must contain its canary and exactly 3 exemplars")
    return body.strip()


def build(directory=SOURCE, download=False):
    manifest = sources(directory, download)
    tasks, groups, counts = [], {}, {}
    source_hashes = {f["path"]: f["sha256"] for f in manifest["files"]}
    data_files = sorted(f["path"] for f in manifest["files"]
                        if f["path"].startswith("bbh/") and f["path"].endswith(".json"))
    if len(data_files) != 27:
        raise ValueError("Expected 27 official BBH evaluation files")
    canaries = set()
    for relative in data_files:
        name = Path(relative).stem
        dataset = json.loads((directory / relative).read_text())
        canaries.add(dataset["canary"])
        template_file = f"cot-prompts/{name}.txt"
        template = prompt_template((directory / template_file).read_text())
        counts[name] = len(dataset["examples"])
        group = []
        for index, example in enumerate(dataset["examples"]):
            # The evaluated answer stays solely in Task.answer. Three public
            # worked examples in the official template are intentional 3-shot.
            prompt = template + "\n\nQ: " + example["input"] + PROMPT_SUFFIX
            identifier = f"bbh:{name}:{index:04d}"
            tasks.append({"id": identifier, "subject": "복합 논리 추론", "prompt": prompt,
                          "answer": example["target"], "scorer": "bbh", "max_tokens": 4096,
                          "meta": {"category": name, "source_index": index,
                                   "source_revision": manifest["revision"],
                                   "data_sha256": source_hashes[relative],
                                   "template_sha256": source_hashes[template_file],
                                   "prompt_sha256": sha(prompt.encode()),
                                   "prompt_protocol": "bbh-official-3shot-cot-v1",
                                   "scorer_protocol": SCORER_VERSION}})
            if identifier in SOURCE_ISSUES:
                code, reason = SOURCE_ISSUES[identifier]
                tasks[-1]["meta"].update(source_issue=reason, source_issue_code=code)
            group.append(identifier)
        groups[name] = sorted(group, key=lambda i: sha((SEED + i).encode()))
    if len(tasks) != 6511 or len(canaries) != 1:
        raise ValueError("Unexpected BBH cardinality or source canary")
    quick_ids = [group[index] for index in range(2) for _, group in sorted(groups.items())]
    return {"id": "bbh-cot-full-v1", "name": "복합 논리 추론 · BIG-Bench Hard (3-shot CoT)",
            "version": "2026-11-06.1", "sources": {
                "dataset": manifest["repository"], "source_revision": manifest["revision"],
                "license": "MIT", "redistribution": "allowed_with_notice",
                "license_note": "BBH repository MIT; preserve author/license/source and upstream BIG-bench attribution notices.",
                "source_count": 6511, "installed_count": 6511, "task_count": 27,
                "paper_task_count": 23, "counts_by_task": counts, "legacy": False,
                "quick_count": 54, "quick_ids": quick_ids,
                "source_issues": [{"id": i, "code": c, "reason": r, "scoring": "unavailable, never zero", "included_in_quick": i in quick_ids} for i, (c, r) in SOURCE_ISSUES.items()],
                "gradable_count": 6506,
                "selection": {"full": "all 27 official evaluation files, 6511 examples",
                              "quick": "2 examples per subtask by fixed SHA256 ordering", "seed": SEED},
                "prompt": "Official per-task 3-shot CoT body + Q: input + A: Let's think step by step.; one user message",
                "prompt_protocol": "bbh-official-3shot-cot-v1", "scorer_protocol": SCORER_VERSION,
                "metric": "item-level exact-match accuracy after explicit final-answer extraction",
                "limitations": [
                    "Official repository publishes data/prompts/results, not executable answer-extraction code. This app's strict extraction is versioned separately; exact official-score parity is not claimed.",
                    "Uses last case-insensitive 'the answer is' marker; first following nonempty line, trim surrounding whitespace and one trailing period, then case-sensitive exact match. No marker means incorrect; no choice guessing or semantic normalization.",
                    "Displayed accuracy weights questions equally. The paper reports an unweighted 23-task mean; they are different aggregations.",
                    "Current model's chat template, generation limits and reasoning settings can differ from the paper's completion API and greedy decoding.",
                    "BBH is a standalone diagnostic; the established seven-benchmark intelligence score weights are unchanged."],
                "answer_boundary": "Only task.prompt sent to target; evaluated target and meta remain with scorer. Official worked examples are public 3-shot context.",
                "canary": next(iter(canaries)),
                "source_files": [dict(f, name=f["path"]) for f in manifest["files"]]},
            "tasks": tasks}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--source-root", type=Path, default=SOURCE)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.dry_run:
        manifest = json.loads(MANIFEST.read_text())
        print(json.dumps({"network_used": False, "files_written": False,
                          "revision": manifest["revision"], "count": 6511, "quick_count": 54,
                          "files": [dict(f, exists=(args.source_root / f["path"]).exists())
                                    for f in manifest["files"]]}, ensure_ascii=False))
        return
    data = (json.dumps(build(args.source_root, args.download), ensure_ascii=False,
                       separators=(",", ":")) + "\n").encode()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(data)
    print(json.dumps({"path": str(args.output), "count": 6511, "quick_count": 54,
                      "sha256": sha(data), "bytes": len(data)}))


if __name__ == "__main__":
    main()
