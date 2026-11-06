#!/bin/zsh
set -eu
cd -- "$(dirname -- "$0")"
APP_DIR="$PWD"
for tool in cargo npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    print "$tool 설치가 필요합니다. BETA-START.md를 확인하세요."
    exit 1
  fi
done
(cd web; npm ci; npm run build)
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$APP_DIR=/llm-bench --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo"
cargo build --release --locked
mkdir -p bin
cp target/release/llm-bench bin/llm-bench
print "빌드 완료. Apple Silicon Mac에서는 Start-LLM-Bench.command로 실행합니다."
