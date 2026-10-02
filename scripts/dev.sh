#!/usr/bin/env bash
# Run Go server (:3000) and Vite (:5173) together; Ctrl+C stops both.
set -u
cd "$(dirname "$0")/.."
mkdir -p web/dist

pids=()
cleanup() {
  trap '' INT TERM EXIT
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
}
trap cleanup INT TERM EXIT

WEB_DIR=web/dist go run ./cmd/server & pids+=($!)
(cd web && exec pnpm dev) & pids+=($!)

# Exit as soon as either process dies.
wait -n
