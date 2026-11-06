#!/usr/bin/env python3
"""Offline comparison with published Codex outputs, never runs a model.

--upstream-root points to the official repository at the pinned revision.
Responses are read in place and never copied into the beta bundle.
"""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream-root", required=True, type=Path)
    parser.add_argument("--output", type=Path,
                        default=ROOT / "evidence/bbh-2026-11-06/published-output-audit.json")
    args = parser.parse_args()
    manifest = json.loads((ROOT / "datasets/sources/bbh-published-results-manifest.json").read_text())
    for source in manifest["files"]:
        data = (args.upstream_root / source["path"]).read_bytes()
        if len(data) != source["bytes"] or hashlib.sha256(data).hexdigest() != source["sha256"]:
            raise ValueError(f"Published response hash mismatch: {source['path']}")
    pack = json.loads((ROOT / "datasets/bbh-cot-full-v1.json").read_text())
    by_id = {t["id"]: t for t in pack["tasks"]}
    prompts = collections.defaultdict(list)
    for task in pack["tasks"]:
        prompts[task["prompt"]].append(task)
    duplicates = [{"ids": [t["id"] for t in group], "targets": [t["answer"] for t in group],
                   "conflicting_targets": len({t["answer"] for t in group}) > 1}
                  for group in prompts.values() if len(group) > 1]
    tasks, mismatches = [], []
    for source in manifest["files"]:
        if not source["path"].endswith(".json"):
            continue
        path = args.upstream_root / source["path"]
        outputs = json.loads(path.read_text())["outputs"]
        correct, valid_count, valid_correct = 0, 0, 0
        category = path.stem.split("_few_shot_template_")[0]
        for index, example in enumerate(outputs):
            task = by_id[f"bbh:{category}:{index:04d}"]
            if task["prompt"] != example["input"]:
                mismatches.append({"source": source["path"], "index": index,
                                   "reason": "Official dataset has truncated snarks:0088; published response has complete question"})
            if task["answer"] != example["target"]:
                raise ValueError("Official evaluation and published output targets differ")
            markers = list(re.finditer(r"\bthe answer is\b", example["prediction"], re.I))
            tail = example["prediction"][markers[-1].end():] if markers else ""
            line = next((line.strip() for line in tail.splitlines() if line.strip()), None)
            answer = line.removesuffix(".").strip() if line else None
            correct += answer == example["target"]
            if not task["meta"].get("source_issue"):
                valid_count += 1
                valid_correct += answer == example["target"]
        original = json.loads(path.with_name(path.stem + "_eval_metrics.jsonl").read_text())["accuracy"]
        accuracy = correct / len(outputs) * 100
        tasks.append({"source": source["path"], "source_sha256": source["sha256"],
                      "count": len(outputs), "app_extraction_correct": correct,
                      "app_extraction_accuracy": accuracy, "published_accuracy": original,
                      "app_valid_count_after_source_exclusions": valid_count,
                      "app_valid_accuracy_after_source_exclusions": 100 * valid_correct / valid_count,
                      "same_accuracy": abs(accuracy - original) < 1e-8})
    result = {"source": "Published code-davinci-002 outputs from pinned official repository; no new inference",
              "revision": manifest["revision"], "scorer_protocol": "bbh-marker-exact-v1",
              "comparison_scope": "Extraction-rule audit on complete published inputs BEFORE 5 source-quality exclusions is compared with official 6511-item results. App-valid 6506-item accuracy is separate. Aggregate parity does not prove identical per-item official decisions (not published).",
              "count": sum(t["count"] for t in tasks), "prompt_matches": sum(t["count"] for t in tasks)-len(mismatches),
              "tasks_with_same_accuracy": sum(t["same_accuracy"] for t in tasks),
              "prompt_mismatches": mismatches, "duplicate_prompts": duplicates, "tasks": tasks}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"count": result["count"], "same_task_accuracy": result["tasks_with_same_accuracy"],
                      "prompt_matches": result["prompt_matches"]}))


if __name__ == "__main__":
    main()
