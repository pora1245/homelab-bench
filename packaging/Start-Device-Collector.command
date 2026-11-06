#!/bin/bash
set -euo pipefail
source "$(cd -- "$(dirname -- "$0")" && pwd)/collector-posix.sh"
bench_start_collector "$@"
