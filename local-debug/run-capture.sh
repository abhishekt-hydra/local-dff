#!/usr/bin/env bash
set -euo pipefail

debug_root="$(cd "$(dirname "$0")" && pwd)"
app_root="$(cd "$debug_root/.." && pwd)"
log_file="$debug_root/local-diffe.log"

(cd "$app_root/web" && npm run build)
(cd "$app_root" && cargo build)
debug_target="$(cd "$app_root" && cargo metadata --no-deps --format-version 1 | node -e 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>process.stdout.write(JSON.parse(input).target_directory))')"
"$debug_target/debug/local-diffe" >"$log_file" 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT

for attempt in {1..30}; do
  if curl -fsS http://127.0.0.1:4317/ >/dev/null; then break; fi
  sleep 1
done

(cd "$debug_root" && npm run capture)
