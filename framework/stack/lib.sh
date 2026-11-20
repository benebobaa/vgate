# shellcheck shell=bash
# Shared building blocks of services/<svc>/stack.sh (sourced, not run). A service's script keeps only what is its
# own: its dependencies (compose services), the command that starts the app, and seeding or reset of test data.
#
#   source "$(dirname "$0")/../../framework/stack/lib.sh"
#   stack_init <service>          # sets STACK_LOG_DIR, STACK_LOG, STACK_PID_FILE, STACK_BUILD_FILE
#   app_up <url> <port> <seconds> <dir> <cmd...>
#                                 # up, never adopting: reuses only the app this project started from this build;
#                                 # refuses (exit 3) when something else holds the port
#   app_start <dir> <cmd...>      # starts the app detached, records its pid and the commit it is built from
#   app_wait <url> <seconds>      # waits until the health URL answers 2xx (tails the log on timeout)
#   app_stop                      # stops what app_start started
#   app_status <url> [repo] [port]
#                                 # app UP/DOWN, the running build, the repo's current commit; with the port, an app
#                                 # this project did not start is named instead of vouched for, and a stale one flagged
#   url_port <url>                # the URL's port (scheme default when it names none)
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
  STACK_START_FILE="$STACK_LOG_DIR/$STACK_NAME.started"
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
  proc_start $! >"$STACK_START_FILE"
}

# When a process started, as ps prints it: with the pid, it tells the process app_start started from a later one that
# reuses its pid (after a reboot or a crash).
proc_start() { # <pid>
  local stat
  # Linux: the start time in clock ticks since boot (field 22 of /proc/<pid>/stat) never changes, whereas ps derives
  # lstart from a boot time that NTP adjustments move. The fields are counted after the command name's ")".
  if [ -r "/proc/$1/stat" ]; then
    stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 0
    stat=${stat##*) }
    # shellcheck disable=SC2086
    set -- $stat
    echo "ticks ${20:-}"
    return 0
  fi
  # Elsewhere (macOS) lstart is stored at start. Fixed locale and zone: another LANG or TZ must print the same text.
  LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null
}

# The pid app_start recorded, while that same process still runs; fails otherwise. Without a recorded start time (an
# app started by an older vgate) the pid alone is trusted.
recorded_pid() {
  [ -f "$STACK_PID_FILE" ] || return 1
  local pid
  pid=$(cat "$STACK_PID_FILE")
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  if [ -f "$STACK_START_FILE" ] && [ "$(proc_start "$pid")" != "$(cat "$STACK_START_FILE")" ]; then return 1; fi
  echo "$pid"
}

# The pid listening on a TCP port (empty when free or unknown).
port_pid() { # <port>
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1
}

# The port of a URL: the explicit one, else the scheme's default.
url_port() { # <url>
  local host=${1#*://} port
  host=${host%%[/?#]*}
  host=${host##*@}
  case $host in
    *\]) ;; # [IPv6] without a port
    *:*)
      port=${host##*:}
      case $port in
        '' | *[!0-9]*) echo "url_port: no port number in $1" >&2; return 1 ;;
      esac
      echo "$port"
      return
      ;;
  esac
  case $(printf '%s' "$1" | tr '[:upper:]' '[:lower:]') in https://*) echo 443 ;; *) echo 80 ;; esac
}

# The executable name of a process: /proc/<pid>/exe on Linux (ps comm is the thread name there, which runtimes such as
# Node 24 rename to MainThread), falling back to ps comm elsewhere or when /proc/<pid>/exe cannot be read (in practice
# on Linux, lsof needs the same /proc permission to see the listener in the first place).
# STACK_PROC_ROOT: procfs root (tests point it at a fixture).
proc_name() { # <pid>
  local exe name
  exe=$(readlink "${STACK_PROC_ROOT:-/proc}/$1/exe" 2>/dev/null || true)
  exe=${exe%' (deleted)'}
  name=${exe##*/}
  if [ -z "$name" ]; then
    name=$(ps -o comm= -p "$1" 2>/dev/null || true)
    name=${name#"${name%%[![:space:]]*}"}
    name=${name%"${name##*[![:space:]]}"}
    name=${name##*/}
  fi
  echo "$name"
}

port_holder() { # <port>: "name (pid N)" of what listens there, empty when free
  local pid name
  pid=$(port_pid "$1")
  [ -n "$pid" ] || return 0
  name=$(proc_name "$pid")
  echo "${name:-a process} (pid $pid)"
}

is_descendant() { # <pid> <ancestor pid>: the process is the ancestor or runs under it
  local p=$1
  for _ in $(seq 1 64); do
    [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null || return 1
    [ "$p" = "$2" ] && return 0
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
  return 1
}

# The app on the port is the one app_start started for this project, whatever build it runs.
app_started() { # <port>
  local pid listener
  pid=$(recorded_pid) || return 1
  listener=$(port_pid "$1")
  if [ -n "$listener" ]; then is_descendant "$listener" "$pid" || return 1; fi
}

# The recorded build is the one checked out now.
build_current() {
  [ -f "$STACK_BUILD_FILE" ] && [ "$(cat "$STACK_BUILD_FILE")" = "$(build_id "${BUILD_REPO:-}")" ]
}

# The app on the port is the one app_start started for this project, from the build checked out now. A listener vgate
# cannot see (no lsof, or another user's socket) is never taken for ours: up restarts its own app rather than adopt it.
app_owned() { # <port>
  app_started "$1" && [ -n "$(port_pid "$1")" ] && build_current
}

# Nothing listens on the port and nothing answers at the URL.
port_free() { # <port> <url>
  [ -z "$(port_pid "$1")" ] && ! http_ok "$2"
}

# A process and everything under it, parents first.
process_tree() { # <pid>
  local child
  echo "$1"
  for child in $(pgrep -P "$1" 2>/dev/null); do process_tree "$child"; done
}

# Starts the app unless this project's app from this build already runs. Anything else answering on the port (another
# checkout's app, a hand-started server) would be tested in this code's place, so it is refused, never adopted.
app_up() { # <health url> <port> <seconds> <dir> <command...>
  local url=$1 port=$2 seconds=$3 holder old old_tree p
  shift 3
  if app_owned "$port" && http_ok "$url"; then
    echo "$STACK_NAME already UP at $url (pid $(cat "$STACK_PID_FILE"), build $(cat "$STACK_BUILD_FILE"))"
    return 0
  fi
  # Ours, but stale (another build) or unhealthy: replace it, waiting until it has let go of the port.
  if old=$(recorded_pid); then
    old_tree=$(process_tree "$old")
    app_stop
    # STACK_RELEASE_SECONDS: how long a stopped app may take to let go of its port (tests shorten it).
    if ! wait_until "${STACK_RELEASE_SECONDS:-15}" "$STACK_NAME to release port $port" port_free "$port" "$url" \
      2>/dev/null; then
      for p in $old_tree; do
        if kill -0 "$p" 2>/dev/null; then
          echo "Refusing to start $STACK_NAME: its previous app (pid $p) still runs ${STACK_RELEASE_SECONDS:-15}s after it was told to stop," \
            "so port $port is not free. Stop it (kill $p) and run up again." >&2
          return 3
        fi
      done
    fi
  fi
  holder=$(port_holder "$port")
  if [ -n "$holder" ] || http_ok "$url"; then
    echo "Refusing to start $STACK_NAME: port $port is held by ${holder:-a process vgate cannot name}, which this" \
      "project did not start (another checkout's app?). Stop it or free the port; vgate never tests an app it did" \
      "not start." >&2
    return 3
  fi
  app_start "$@"
  app_wait "$url" "$seconds"
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
    if pid=$(recorded_pid); then
      # The whole tree: the server is often a grandchild (npm run -> sh -> node), and a survivor keeps the port.
      # shellcheck disable=SC2046
      kill $(process_tree "$pid") 2>/dev/null || true
      echo "Stopped $STACK_NAME (pid $pid)"
    else
      pid=$(cat "$STACK_PID_FILE")
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        # Alive, but started at another time than the recorded app: the pid was reused. Kill nothing.
        echo "$STACK_NAME (pid $pid) no longer runs: that pid now belongs to a process started later; not killed"
      else
        echo "$STACK_NAME (pid $pid) no longer runs; nothing to stop"
      fi
    fi
    rm -f "$STACK_PID_FILE" "$STACK_BUILD_FILE" "$STACK_START_FILE"
  else
    echo "No $STACK_NAME started by this script (pid file absent); a manually started app keeps running"
  fi
}

app_status() { # <health url> [repo] [port]
  local url=$1 repo=${2:-} port=${3:-} holder
  if http_ok "$url"; then echo "app       UP   $url"; else echo "app       DOWN $url"; fi
  # With the port, the build line is only trusted for the app this project started: a process left on the port by
  # an earlier run or another checkout answers the health check too, and its build is not the one recorded here.
  if [ -n "$port" ] && ! app_started "$port"; then
    holder=$(port_holder "$port")
    if [ -n "$holder" ] || http_ok "$url"; then
      echo "build     not this project's: port $port is held by ${holder:-a process vgate cannot name} (vgate up refuses it)"
      if [ -n "$repo" ]; then echo "repo HEAD $(build_id "$repo")"; fi
      return 0
    fi
  fi
  # Unknown when the app was started by hand: then nothing records what it was built from.
  if [ ! -f "$STACK_BUILD_FILE" ]; then
    echo "build     unknown (not started by this script)"
  elif [ -n "$port" ] && http_ok "$url" && [ -z "$(port_pid "$port")" ]; then
    # Something answers, but vgate cannot see the listener (no lsof, or another user's socket): it may not be ours.
    echo "build     $(cat "$STACK_BUILD_FILE")? unverified: vgate cannot see who listens on port $port (vgate up will not reuse it)"
  elif [ -n "$port" ] && app_started "$port" && ! build_current; then
    # Ours, from an older checkout: up replaces it rather than refusing it.
    echo "build     $(cat "$STACK_BUILD_FILE") (stale: the checkout is $(build_id "${BUILD_REPO:-}") now; vgate up restarts it)"
  else
    echo "build     $(cat "$STACK_BUILD_FILE")"
  fi
  if [ -n "$repo" ]; then echo "repo HEAD $(build_id "$repo")"; fi
}
