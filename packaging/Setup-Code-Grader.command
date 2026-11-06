#!/bin/zsh
# Optional existing Docker backend only. Native OS sandbox is not implemented.
set -eu
bench_script_dir="${0:A:h}"
if [[ -f "$bench_script_dir/../scorers/Dockerfile" ]]; then
  cd -- "$bench_script_dir/.."
else
  cd -- "$bench_script_dir"
fi
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  print "코드 시험에만 선택적으로 Docker 실행 환경이 필요합니다."
  print "기존 Docker Desktop 또는 Colima를 실행한 뒤 이 파일을 다시 여세요."
  print "수학·지식·추론·지시 이행·성능 시험은 Docker 없이 사용할 수 있습니다."
  exit 1
fi
print "기존 Docker에 격리 코드 채점 이미지를 준비합니다. 모델 시험은 실행하지 않습니다."
docker build -t llm-bench-code:py311 - < scorers/Dockerfile
print "코드 채점 이미지 준비 완료. 앱에서 상태 다시 확인을 눌러 주세요."
