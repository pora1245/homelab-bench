#!/bin/zsh
set -eu
bench_script_dir="${0:A:h}"
if [[ -f "$bench_script_dir/../tools/prepare_graders.py" ]]; then
  cd -- "$bench_script_dir/.."
else
  cd -- "$bench_script_dir"
fi
APP_DIR="$PWD"
BENCH_PORT="${BENCH_PORT:-18760}"
export BENCH_PORT
export BENCH_DATA_DIR="${BENCH_DATA_DIR:-$APP_DIR/data}"
export BENCH_PYTHON="${BENCH_PYTHON:-$APP_DIR/.venv/bin/python}"
export BENCH_CODE_IMAGE="${BENCH_CODE_IMAGE:-llm-bench-code:py311}"
export BENCH_LCB_IMAGE="${BENCH_LCB_IMAGE:-llm-bench-code:py311}"
export NLTK_DATA="${NLTK_DATA:-$BENCH_DATA_DIR/nltk_data}"
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  print "이 실행 번들은 Apple Silicon Mac용입니다. 다른 OS·Intel Mac은 검증되지 않았습니다."
  exit 1
fi
if [[ ! -x bin/llm-bench || ! -f web/dist/index.html ]]; then
  print "실행 파일 또는 화면 파일이 없습니다. 번들 전체를 다시 압축 해제해 주세요."
  exit 1
fi
if curl -fsS --max-time 2 "http://127.0.0.1:$BENCH_PORT/api/health" >/dev/null 2>&1; then
  print "이미 실행 중인 Homelab Bench를 엽니다. 이 터미널에서는 새 실행기를 시작하지 않았습니다."
  open "http://127.0.0.1:$BENCH_PORT"
  exit 0
fi
if [[ "${BENCH_SKIP_SETUP:-0}" != 1 ]]; then
  if ! zsh "$bench_script_dir/Setup-Graders.command"; then
    print "일부 채점 환경이 준비되지 않아도 앱은 시작합니다. 준비된 평가팩부터 이용하세요."
  fi
fi
print "Homelab Bench: http://127.0.0.1:$BENCH_PORT"
print "기록 위치: $BENCH_DATA_DIR"
print "이 터미널에서 Control-C를 누르면 실행기를 종료합니다. 브라우저만 닫으면 실행기는 유지됩니다."
(for attempt in {1..30}; do
  if curl -fsS --max-time 1 "http://127.0.0.1:$BENCH_PORT/api/health" >/dev/null 2>&1; then
    open "http://127.0.0.1:$BENCH_PORT"
    break
  fi
  sleep 1
done) &
exec "$APP_DIR/bin/llm-bench"
