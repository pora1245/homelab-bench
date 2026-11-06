#!/usr/bin/env bash
set -euo pipefail
source "$(cd -- "$(dirname -- "$0")" && pwd)/collector-posix.sh"
if [[ -t 0 && $# -eq 0 ]]; then
  printf '%s\n' 'Enter this model server LAN/Tailscale IP:port for remote access.' 'Example: 100.64.0.10:18761. Empty keeps the saved address or loopback-only default.'
  IFS= read -r -p 'Collector bind address: ' bench_selected_bind
  if [[ -n "$bench_selected_bind" ]]; then set -- --bind "$bench_selected_bind"; fi
fi
bench_prepare_collector "$@"
