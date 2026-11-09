#!/usr/bin/env python3
"""Historical 100-question public-core-v1 reconstruction tool (2026-11-05).
Normal installation uses the shipped basic-bench-v2 manifest; do not run this tool.
It downloads pinned assets and rewrites the legacy pack/vendor files for research
reproduction. It does not build or calibrate the released four-mode basic pack.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
IFEVAL = "107e33477ec7418e16b6a2c50f68dab8d82cf9b1"
HUMAN = "6d43fb980f9fee3c892a914eda09951f772ad10d"

def fetch(url, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=30) as response:
        content = response.read()
    destination.write_bytes(content)
    return content

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--existing", type=Path, required=True)
    args = parser.parse_args()
    records = [json.loads(line) for line in args.existing.read_text().splitlines()]
    tasks = []
    names = {"gsm8k": ("수학 추론", "numeric"), "mmlu_pro": ("지식·논리", "choice"), "ifeval": ("지시 이행", "ifeval")}
    for benchmark, (subject, scorer) in names.items():
        for row in [r for r in records if r["benchmark"] == benchmark][:25]:
            tasks.append({"id": benchmark + ":" + row["id"], "subject": subject, "prompt": row["prompt"], "answer": row["answer"], "scorer": scorer, "max_tokens": row["max_tokens"], "meta": row["meta"]})
    vendor = ROOT / "scorers/vendor"
    sources = []
    for file in ("evaluation_lib.py", "instructions.py", "instructions_registry.py", "instructions_util.py"):
        url = f"https://raw.githubusercontent.com/google-research/google-research/{IFEVAL}/instruction_following_eval/{file}"
        content = fetch(url, vendor / "instruction_following_eval" / file)
        sources.append({"url": url, "sha256": hashlib.sha256(content).hexdigest()})
    human_data = fetch(f"https://raw.githubusercontent.com/openai/human-eval/{HUMAN}/data/HumanEval.jsonl.gz", ROOT / "datasets/sources/HumanEval.jsonl.gz")
    fetch(f"https://raw.githubusercontent.com/openai/human-eval/{HUMAN}/human_eval/execution.py", ROOT / "scorers/vendor/humaneval_execution.py")
    for row in [json.loads(l) for l in gzip.decompress(human_data).decode().splitlines()][:25]:
        tasks.append({"id": row["task_id"], "subject": "코드", "prompt": row["prompt"], "answer": "공식 단위 테스트 통과", "scorer": "humaneval", "max_tokens": 4096, "meta": {"test": row["test"], "entry_point": row["entry_point"], "canonical_solution": row["canonical_solution"]}})
    licenses = ROOT / "LICENSES"
    fetch("https://raw.githubusercontent.com/openai/grade-school-math/3101c7d5072418e28b9008a6636bde82a006892c/LICENSE", licenses / "GSM8K-MIT.txt")
    fetch(f"https://raw.githubusercontent.com/openai/human-eval/{HUMAN}/LICENSE", licenses / "HumanEval-MIT.txt")
    fetch(f"https://raw.githubusercontent.com/google-research/google-research/{IFEVAL}/LICENSE", licenses / "IFEval-Apache-2.0.txt")
    fetch("https://raw.githubusercontent.com/TIGER-AI-Lab/MMLU-Pro/main/LICENSE", licenses / "MMLU-Pro-repository-Apache-2.0.txt")
    fetch("https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro/raw/b189ec765aa7ed75c8acfea42df31fdae71f97be/README.md", licenses / "MMLU-Pro-dataset-card.md")
    pack = {"id": "public-core-v1", "name": "공개 벤치 기본팩", "version": "2026-11-05.1", "sources": {
        "gsm8k": {"license": "MIT", "revision": "740312add88f781978c0658806c59bc2815b9866", "url": "https://huggingface.co/datasets/openai/gsm8k"},
        "mmlu_pro": {"license": "MIT", "revision": "b189ec765aa7ed75c8acfea42df31fdae71f97be", "url": "https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro"},
        "ifeval": {"license": "Apache-2.0", "revision": IFEVAL, "url": "https://github.com/google-research/google-research/tree/master/instruction_following_eval"},
        "humaneval": {"license": "MIT", "revision": HUMAN, "url": "https://github.com/openai/human-eval"},
        "selection": "각 과목 고정 25문항. 공개 650 고정팩 순서와 HumanEval ID 순서. 공식 전체 점수와 구분.",
        "input_sha256": hashlib.sha256(args.existing.read_bytes()).hexdigest(),
        "vendored_files": sources,
    }, "tasks": tasks}
    (ROOT / "datasets/public-core.json").write_text(json.dumps(pack, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"pack":pack["id"], "count":len(tasks), "sha256":hashlib.sha256((ROOT / "datasets/public-core.json").read_bytes()).hexdigest()}))

if __name__ == "__main__":
    main()
