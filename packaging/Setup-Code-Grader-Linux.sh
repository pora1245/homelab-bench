#!/usr/bin/env bash
# Optional existing Docker backend only; no Docker/VM installation.
set -euo pipefail
bench_script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
if [[ -f "$bench_script_dir/../scorers/Dockerfile" ]]; then cd -- "$bench_script_dir/.."; else cd -- "$bench_script_dir"; fi
if ! command -v docker >/dev/null 2>&1 || [[ "$(docker info --format '{{.OSType}}' 2>/dev/null)" != linux ]]; then
  printf '%s\n' 'Optional code grading needs an existing, running Docker Linux environment.' 'Non-code tests remain available without Docker.' >&2
  exit 1
fi
docker build -t llm-bench-code:py311 - < scorers/Dockerfile
printf '%s\n' 'Optional code grader prepared. Recheck readiness in the app.'
