#!/usr/bin/env bash
# Local stack of the example-web service: the notes API (services/example/server.ts) and the web UI in front of it,
# both in-memory, no Docker.
#   stack.sh up | down | status | reset
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# vgate names the stack library (VGATE_STACK_LIB); run by hand in the framework's checkout, it is next door.
# shellcheck source=../../framework/stack/lib.sh
source "${VGATE_STACK_LIB:-$HERE/../../framework/stack/lib.sh}"

API_PORT="${EXAMPLE_WEB_API_PORT:-8093}"
WEB_PORT="${EXAMPLE_WEB_PORT:-8094}"
TSX="$STACK_RUNTIME/node_modules/.bin/tsx"
BUILD_REPO="$STACK_ROOT" # the service's code lives in this repo

api() { stack_init example-web-api; }
web() { stack_init example-web; }

up() {
  api
  app_up "http://localhost:$API_PORT/health" "$API_PORT" 30 "$STACK_ROOT" \
    env EXAMPLE_PORT="$API_PORT" "$TSX" "$HERE/../example/server.ts"
  web
  app_up "http://localhost:$WEB_PORT/health" "$WEB_PORT" 30 "$STACK_ROOT" \
    env EXAMPLE_WEB_PORT="$WEB_PORT" EXAMPLE_WEB_API="http://localhost:$API_PORT" "$TSX" "$HERE/server.ts"
}

down() {
  web
  app_stop
  api
  app_stop
}

status() {
  api
  app_status "http://localhost:$API_PORT/health" "$STACK_ROOT" "$API_PORT"
  web
  app_status "http://localhost:$WEB_PORT/health" "$STACK_ROOT" "$WEB_PORT"
}

# The data lives in memory: a restart is the reset.
reset() {
  down
  up
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  reset) reset ;;
  *) echo "Usage: $0 up|down|status|reset" >&2; exit 2 ;;
esac
