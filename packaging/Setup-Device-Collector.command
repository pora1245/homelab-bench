#!/bin/bash
set -euo pipefail
source "$(cd -- "$(dirname -- "$0")" && pwd)/collector-posix.sh"
if [[ -t 0 && $# -eq 0 ]]; then
  printf '%s\n' '외부 벤치 앱에서 연결하려면 이 모델 서버의 LAN 또는 Tailscale IP:포트를 입력하세요.' '예: 100.64.0.10:18761 · 빈 입력은 기존 설정 또는 이 PC 전용 주소를 사용합니다.'
  IFS= read -r -p '수집기 연결 주소: ' bench_selected_bind
  if [[ -n "$bench_selected_bind" ]]; then set -- --bind "$bench_selected_bind"; fi
fi
bench_prepare_collector "$@"
