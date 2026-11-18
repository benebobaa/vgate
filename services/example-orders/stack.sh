#!/usr/bin/env bash
# Local stack of example-orders: its dependencies in compose.yaml (Postgres, Redis, Kafka, WireMock, toxiproxy) and
# the app (server.ts) on the host.
#   stack.sh up | down | status | reset
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# vgate names the stack library (VGATE_STACK_LIB); run by hand in the framework's checkout, it is next door.
# shellcheck source=../../framework/stack/lib.sh
source "${VGATE_STACK_LIB:-$HERE/../../framework/stack/lib.sh}"
stack_init example-orders

PORT="${EXAMPLE_ORDERS_PORT:-8091}"
HEALTH="http://localhost:$PORT/health"
BUILD_REPO="$STACK_ROOT" # the service's code lives in this repo
COMPOSE=(docker compose -f "$HERE/compose.yaml" -p example-orders)
TOPIC=orders.created
# Where the containers' ports answer: localhost, or the Docker-in-Docker host in CI (compose.yaml).
DEPS_HOST="${STACK_HOST:-localhost}"
KAFKA_BIN=/opt/kafka/bin

kafka_topics() { "${COMPOSE[@]}" exec -T kafka "$KAFKA_BIN/kafka-topics.sh" --bootstrap-server localhost:9092 "$@"; }

deps_up() {
  "${COMPOSE[@]}" up -d postgres redis kafka wiremock toxiproxy
  wait_until 60 "PostgreSQL" "${COMPOSE[@]}" exec -T postgres pg_isready -U orders -d orders
  wait_until 30 "Redis" "${COMPOSE[@]}" exec -T redis redis-cli ping
  wait_until 30 "WireMock" http_ok "http://$DEPS_HOST:58080/__admin/health"
  wait_until 30 "toxiproxy" http_ok "http://$DEPS_HOST:58474/version"
  wait_until 120 "Kafka" kafka_topics --list
  # Three partitions, so the tests' consumer is exercised across partitions, as with a real topic.
  kafka_topics --create --if-not-exists --topic "$TOPIC" --partitions 3 --replication-factor 1 >/dev/null
}

up() {
  deps_up
  if http_ok "$HEALTH"; then echo "example-orders already UP at $HEALTH"; return; fi
  app_start "$STACK_ROOT" env ORDERS_PORT="$PORT" \
    ORDERS_DB_URL="postgres://orders:orders@$DEPS_HOST:55432/orders" \
    ORDERS_REDIS_URL="redis://$DEPS_HOST:56379" \
    ORDERS_KAFKA_BROKERS="$DEPS_HOST:59092" \
    ORDERS_PAYMENTS_URL="http://$DEPS_HOST:58081" \
    "$STACK_RUNTIME/node_modules/.bin/tsx" "$HERE/server.ts"
  app_wait "$HEALTH" 60
}

# stop, not down: down removes the containers and their data with them.
down() {
  app_stop
  "${COMPOSE[@]}" stop
}

status() {
  app_status "$HEALTH" "$STACK_ROOT"
  "${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Status}}'
}

# Destructive: empties the orders table, Redis, WireMock's stubs and journal, toxiproxy's faults and the topic.
reset() {
  "${COMPOSE[@]}" exec -T postgres psql -U orders -d orders -q -c 'TRUNCATE orders' 2>/dev/null || true
  "${COMPOSE[@]}" exec -T redis redis-cli FLUSHALL >/dev/null
  curl -fsS -X POST "http://$DEPS_HOST:58080/__admin/reset" >/dev/null
  curl -fsS -X POST "http://$DEPS_HOST:58474/reset" >/dev/null
  kafka_topics --delete --if-exists --topic "$TOPIC" >/dev/null
  wait_until 30 "topic $TOPIC deleted" sh -c "! ${COMPOSE[*]} exec -T kafka $KAFKA_BIN/kafka-topics.sh --bootstrap-server localhost:9092 --list | grep -qx $TOPIC"
  kafka_topics --create --if-not-exists --topic "$TOPIC" --partitions 3 --replication-factor 1 >/dev/null
  app_stop
  up
  echo "example-orders data reset"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  reset) reset ;;
  *) echo "Usage: $0 up|down|status|reset" >&2; exit 2 ;;
esac
