#!/bin/zsh
set -eu
bench_script_dir="${0:A:h}"
if [[ -f "$bench_script_dir/../tools/prepare_graders.py" ]]; then
  cd -- "$bench_script_dir/.."
else
  cd -- "$bench_script_dir"
fi
APP_DIR="$PWD"
bench_find_python() {
  local bench_candidate
  for bench_candidate in "${BENCH_SETUP_PYTHON:-}" "$APP_DIR/.venv/bin/python" /opt/homebrew/bin/python3 /usr/local/bin/python3 /Library/Frameworks/Python.framework/Versions/3.14/bin/python3.14 /Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13 /Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12; do
    if [[ -n "$bench_candidate" ]] && command -v "$bench_candidate" >/dev/null 2>&1 && "$bench_candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; then
      print -r -- "$bench_candidate"
      return 0
    fi
  done
  return 1
}
bench_python="$(bench_find_python)" || {
  zsh "$bench_script_dir/Install-Python.command"
  bench_python="$(bench_find_python)" || {
    print "Python 준비가 아직 끝나지 않았습니다. 앱의 내장 채점·성능 시험은 먼저 사용할 수 있습니다."
    exit 1
  }
}
"$bench_python" tools/prepare_graders.py --data-dir "${BENCH_DATA_DIR:-$APP_DIR/data}"
print "수학·지시 이행 채점 준비 완료. 지식·추론·성능은 내장 채점기를 사용합니다."
print "코드 시험은 선택 사항이며 Setup-Code-Grader.command에서 따로 준비합니다."
