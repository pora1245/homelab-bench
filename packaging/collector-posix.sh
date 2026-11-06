#!/usr/bin/env bash
# Shared by the explicitly launched macOS/Linux collector scripts.
set -euo pipefail
bench_collector_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "$bench_collector_script_dir/../bin" || -f "$bench_collector_script_dir/../Cargo.toml" ]]; then
  bench_collector_app_dir="$(cd -- "$bench_collector_script_dir/.." && pwd)"
else
  bench_collector_app_dir="$bench_collector_script_dir"
fi

bench_prepare_collector() {
  local bench_bind_override="" bench_arg
  while [[ $# -gt 0 ]]; do
    bench_arg="$1"; shift
    case "$bench_arg" in
      --bind) [[ $# -gt 0 ]] || { printf '%s\n' '--bind needs an IP:port value.' >&2; return 1; }; bench_bind_override="$1"; shift ;;
      *) printf 'Unknown option: %s\n' "$bench_arg" >&2; return 1 ;;
    esac
  done
  if [[ -n "${BENCH_AGENT_TOKEN:-}" ]]; then
    printf '%s\n' 'This launcher uses its private token file. Do not combine it with BENCH_AGENT_TOKEN.' >&2; return 1
  fi
  if [[ "$(uname -s)" == Darwin ]]; then
    bench_collector_default_dir="$HOME/Library/Application Support/LLM-Bench/collector"
  else
    bench_collector_default_dir="${XDG_STATE_HOME:-$HOME/.local/state}/llm-bench/collector"
  fi
  bench_collector_state="${BENCH_COLLECTOR_DIR:-$bench_collector_default_dir}"
  if [[ -L "$bench_collector_state" ]]; then printf '%s\n' 'Collector state directory must not be a symlink.' >&2; return 1; fi
  umask 077
  mkdir -p -- "$bench_collector_state"
  chmod 700 "$bench_collector_state"
  bench_collector_token="$bench_collector_state/agent-token.txt"
  for bench_file in "$bench_collector_token" "$bench_collector_state/bind-address.txt" "$bench_collector_state/collector-connection.json"; do
    if [[ -L "$bench_file" ]]; then printf '%s\n' 'Collector configuration must not be a symlink.' >&2; return 1; fi
  done
  if [[ -n "${BENCH_AGENT_TOKEN_FILE:-}" && "$BENCH_AGENT_TOKEN_FILE" != "$bench_collector_token" ]]; then
    printf '%s\n' 'This launcher manages agent-token.txt in BENCH_COLLECTOR_DIR. Use the binary directly for a custom token file.' >&2; return 1
  fi
  bench_collector_bind="${bench_bind_override:-${BENCH_AGENT_BIND:-}}"
  if [[ -z "$bench_collector_bind" && -f "$bench_collector_state/bind-address.txt" ]]; then
    IFS= read -r bench_collector_bind < "$bench_collector_state/bind-address.txt" || true
  fi
  bench_collector_bind="${bench_collector_bind:-127.0.0.1:18761}"
  if ! [[ "$bench_collector_bind" =~ ^([0-9]+\.){3}[0-9]+:[0-9]+$ || "$bench_collector_bind" =~ ^\[[0-9a-fA-F:.]+\]:[0-9]+$ ]]; then
    printf '%s\n' 'Bind must be an IP:port, such as 127.0.0.1:18761 or [::1]:18761.' >&2; return 1
  fi
  local bench_port="${bench_collector_bind##*:}"
  if (( 10#$bench_port < 1 || 10#$bench_port > 65535 )); then printf '%s\n' 'Port must be 1..65535.' >&2; return 1; fi
  if [[ ! -f "$bench_collector_token" ]]; then
    # Standard OS tools only. No Python, Docker or package manager required.
    (set -o noclobber; od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$bench_collector_token")
  fi
  chmod 600 "$bench_collector_token"
  local bench_token_size
  bench_token_size="$(wc -c < "$bench_collector_token" | tr -d ' ')"
  if [[ "$bench_token_size" -lt 32 || "$bench_token_size" -gt 4097 ]]; then
    printf '%s\n' 'Existing collector token is invalid; inspect the private file. Its value is never printed.' >&2; return 1
  fi
  printf '%s\n' "$bench_collector_bind" > "$bench_collector_state/bind-address.txt"
  local bench_url="\"http://$bench_collector_bind/metrics\"" bench_health="\"http://$bench_collector_bind/health\""
  if [[ "$bench_collector_bind" == 0.0.0.0:* || "$bench_collector_bind" == \[::\]:* ]]; then bench_url=null; bench_health=null; fi
  printf '{"schema_version":1,"bind":"%s","url":%s,"health_url":%s,"auth":"bearer","token_file":"agent-token.txt"}\n' "$bench_collector_bind" "$bench_url" "$bench_health" > "$bench_collector_state/collector-connection.json"
  chmod 600 "$bench_collector_state/bind-address.txt" "$bench_collector_state/collector-connection.json"
  printf 'Collector prepared. Bind: %s\nConnection file: %s/collector-connection.json\n' "$bench_collector_bind" "$bench_collector_state"
  printf '%s\n' 'The secret remains in agent-token.txt; do not paste it into logs. No firewall rule was changed.'
}

bench_start_collector() {
  bench_prepare_collector "$@"
  local bench_binary="$bench_collector_app_dir/bin/llm-bench"
  if [[ ! -x "$bench_binary" ]]; then printf '%s\n' 'The matching OS/architecture collector binary is missing.' >&2; return 1; fi
  export BENCH_AGENT_BIND="$bench_collector_bind"
  export BENCH_AGENT_TOKEN_FILE="$bench_collector_token"
  printf '%s\n' 'Read-only collector starting. Control-C stops it. The model server is not changed.'
  exec "$bench_binary" agent
}
