# shellcheck shell=bash
# Shared building blocks of services/<svc>/stack.sh (sourced, not run). A service's script keeps only what is its
# own: its dependencies (compose services), the command that starts the app, and seeding or reset of test data.
#
#   source "$(dirname "$0")/../../framework/stack/lib.sh"
#   stack_init <service>          # sets STACK_LOG_DIR, STACK_LOG, STACK_PID_FILE, STACK_BUILD_FILE
#   app_start <dir> <cmd...>      # starts the app detached, records its pid and the commit it is built from
#   app_wait <url> <seconds>      # waits until the health URL answers 2xx (tails the log on timeout)
#   app_stop                      # stops what app_start started
#   app_status <url> [repo]       # app UP/DOWN, the running build, the repo's current commit
#   wait_until <seconds> <what> <cmd...>
#   build_id <repo>               # <short sha>, "+uncommitted" when tracked files differ (line endings ignored)
#
# The variable BUILD_REPO (default: none) names the git checkout the app is built from; app_start records its
# build_id so `status` and the sync skill can tell which commit the tests ran against.
#
# Paths (vgate sets the VGATE_* variables; run by hand in the framework's checkout, all of them are that checkout):
#   STACK_RUNTIME   the vgate runtime: its node_modules/.bin has tsx and the other tools
#   STACK_ROOT      the project under test (the directory of vgate.yaml)
#   STACK_REPORTS   the project's reports directory
# A service's stack.sh finds this file through VGATE_STACK_LIB:
#   source "${VGATE_STACK_LIB:?run through vgate (vgate up), which names the stack library}"

STACK_RUNTIME="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STACK_ROOT="${VGATE_PROJECT:-$STACK_RUNTIME}"
STACK_REPORTS="${VGATE_REPORTS:-$STACK_ROOT/reports}"

stack_init() {
  STACK_NAME=$1
  STACK_LOG_DIR="$STACK_REPORTS/stack"
  STACK_LOG="$STACK_LOG_DIR/$STACK_NAME.log"
  STACK_PID_FILE="$STACK_LOG_DIR/$STACK_NAME.pid"
  STACK_BUILD_FILE="$STACK_LOG_DIR/$STACK_NAME.build"
  mkdir -p "$STACK_LOG_DIR"
}

wait_until() { # <seconds> <description> <command...>
  local seconds=$1 what=$2
  shift 2
  for _ in $(seq 1 "$seconds"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "Timed out after ${seconds}s waiting for $what" >&2
  return 1
}

http_ok() { curl -fsS -m 3 -o /dev/null "$1" 2>/dev/null; }

build_id() { # <repo>
  local repo=${1:-} sha
  [ -n "$repo" ] || { echo unknown; return; }
  sha=$(git -C "$repo" rev-parse --short HEAD 2>/dev/null) || { echo unknown; return; }
  if git -C "$repo" diff --quiet --ignore-cr-at-eol HEAD 2>/dev/null; then echo "$sha"; else echo "$sha+uncommitted"; fi
}

# Every stream of the background job is redirected and the subshell execs the command: nothing keeps the caller's
# stdout open, so `task up | tee` or a CI job that reads the output to the end does not hang while the app runs.
app_start() { # <dir> <command...>
  local dir=$1
  shift
  echo "Starting $STACK_NAME (log: $STACK_LOG)"
  build_id "${BUILD_REPO:-}" >"$STACK_BUILD_FILE"
  (cd "$dir" && exec nohup "$@") >"$STACK_LOG" 2>&1 </dev/null &
  echo $! >"$STACK_PID_FILE"
}

app_wait() { # <health url> <seconds>
  if ! wait_until "$2" "$STACK_NAME health at $1" http_ok "$1"; then
    tail -40 "$STACK_LOG" >&2
    return 1
  fi
  echo "$STACK_NAME UP at $1"
}

app_stop() {
  if [ -f "$STACK_PID_FILE" ]; then
    local pid
    pid=$(cat "$STACK_PID_FILE")
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    rm -f "$STACK_PID_FILE" "$STACK_BUILD_FILE"
    echo "Stopped $STACK_NAME (pid $pid)"
  else
    echo "No $STACK_NAME started by this script (pid file absent); a manually started app keeps running"
  fi
}

app_status() { # <health url> [repo]
  if http_ok "$1"; then echo "app       UP   $1"; else echo "app       DOWN $1"; fi
  # Unknown when the app was started by hand: then nothing records what it was built from.
  if [ -f "$STACK_BUILD_FILE" ]; then
    echo "build     $(cat "$STACK_BUILD_FILE")"
  else
    echo "build     unknown (not started by this script)"
  fi
  if [ -n "${2:-}" ]; then echo "repo HEAD $(build_id "$2")"; fi
}
