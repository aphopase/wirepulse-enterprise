#!/usr/bin/env bash
# PostgreSQL failover drill, in Docker, on throwaway containers: a primary and a streaming replica, PgBouncer in front of them, one API
# container behind PgBouncer, and scripts/loadtest.mjs driving it. Part-way through the load the primary is killed (SIGKILL, no clean
# shutdown), the replica is promoted, PgBouncer is pointed at it, and the drill reports how long the API was not ready and whether the
# load test's integrity checks (every acknowledged job still there, none handed out twice, every audit chain valid) still hold.
# Afterwards the dead primary is rebuilt as a standby of the new one, which is the failback step.
#
#   scripts/failover-drill.sh                        # asynchronous replication, PgBouncer in session mode
#   DRILL_SYNC=on scripts/failover-drill.sh          # synchronous replication: no acknowledged commit may be lost
#   DRILL_POOL_MODE=transaction scripts/failover-drill.sh     # the API's listener uses LISTEN_DATABASE_URL (a session-mode entry)
#   DRILL_POOL_MODE=transaction DRILL_LISTEN_URL=off ...      # without it: shows live updates silently stopping
#
# Needs Docker, node, and the API image (docker compose build api, or WIREPULSE_API_IMAGE). Everything it creates is named wp-fo-* and is
# removed at the end (DRILL_KEEP=1 keeps it for inspection; remove it with DRILL_PREFIX=wp-fo scripts/failover-drill.sh --clean).
# It tests the mechanics of promote-and-repoint with PgBouncer. It does not test an orchestrator (Patroni, a cloud service) deciding to
# fail over by itself, a network partition, or your storage.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PREFIX=${DRILL_PREFIX:-wp-fo}
NET=$PREFIX-net
API_IMAGE=${WIREPULSE_API_IMAGE:-wirepulse-api:local}
PG_IMAGE=${PG_IMAGE:-postgres:16-alpine}
API_PORT=${DRILL_API_PORT:-18730}
SYNC=${DRILL_SYNC:-off}
POOL_MODE=${DRILL_POOL_MODE:-session}
LOAD_SECONDS=${DRILL_SECONDS:-60}
FAULT_AT=${DRILL_FAULT_AT:-20}
DETECT_DELAY=${DRILL_DETECT_DELAY:-3} # what a monitor would take to decide the primary is gone
NAMES="$PREFIX-api $PREFIX-pgbouncer $PREFIX-primary $PREFIX-replica $PREFIX-oldprimary"
VOLUMES="$PREFIX-primary-data $PREFIX-replica-data $PREFIX-oldprimary-data"

clean() { docker rm -f $NAMES >/dev/null 2>&1 || true; docker volume rm $VOLUMES >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
if [ "${1:-}" = "--clean" ]; then clean; exit 0; fi
clean
WORK=$(mktemp -d /tmp/wp-failover.XXXXXX)
chmod 755 "$WORK"
finish() { [ "${DRILL_KEEP:-}" = 1 ] && { echo "kept: containers $NAMES, files $WORK"; return; }; clean; rm -rf "$WORK"; }
trap finish EXIT

docker image inspect "$API_IMAGE" >/dev/null 2>&1 || docker build -q -t "$API_IMAGE" "$ROOT/api" >/dev/null
PW=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
TOKEN=drill-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
now() { date +%s.%N; }
psql_in() { local c=$1; shift; docker exec -e PGPASSWORD="$PW" "$c" psql -U wirepulse -d wirepulse -tA "$@"; }
# Conditions are functions so that they are evaluated again on every attempt.
streaming() { [ "$(psql_in "$1" -c "SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming'")" = 1 ]; }
synchronous() { [ "$(psql_in "$1" -c "SELECT count(*) FROM pg_stat_replication WHERE sync_state = 'sync'")" = 1 ]; }
JOB='{"definition":{"tests":[{"id":"t1","name":"ready","commands":"status","expectedText":"READY","telemetryToken":"","telemetryOperator":">=","telemetryValue":"","timeoutMs":500,"retries":0}],"profile":{"settings":{"baud":"115200"}}}}'
api() { local method=$1 path=$2; shift 2; curl -fs -m 10 -X "$method" "http://127.0.0.1:$API_PORT$path" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$@"; }
# live_update <label>: a stream opened now must report its LISTEN connection as up and then deliver a job created afterwards. Live updates
# need a session-level connection to PostgreSQL, so this is what shows whether the pool mode in use keeps them working.
live_update() {
  local out="$WORK/stream-$1.txt" ws sse
  ws=$(api POST /v1/workspaces -d "{\"name\":\"live-$1\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))') || return 1
  curl -sN -m 40 "http://127.0.0.1:$API_PORT/v1/workspaces/$ws/test-jobs/stream" -H "authorization: Bearer $TOKEN" > "$out" 2>/dev/null &
  sse=$!
  local ok=0
  if WAIT_SECONDS=${LIVE_WAIT:-30} wait_for "a stream with a connected listener" grep -q '"listener":true' "$out"; then
    api POST "/v1/workspaces/$ws/test-jobs" -d "${JOB%\}}"',"idempotencyKey":"live-'"$1"'"}' >/dev/null || true
    WAIT_SECONDS=${LIVE_WAIT_EVENT:-10} wait_for "a job event on the stream" grep -q '^event: job' "$out" && ok=1
  fi
  kill "$sse" 2>/dev/null || true; wait "$sse" 2>/dev/null || true
  [ "$ok" = 1 ]
}
FAILED=0
wait_for() { local what=$1; shift; for _ in $(seq 1 "${WAIT_SECONDS:-90}"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done; echo "timed out waiting for $what" >&2; return 1; }

echo "== starting primary and replica (synchronous replication: $SYNC)"
docker network create "$NET" >/dev/null
docker volume create "$PREFIX-primary-data" >/dev/null
docker run -d --name "$PREFIX-primary" --network "$NET" -v "$PREFIX-primary-data:/var/lib/postgresql/data" \
  -e POSTGRES_USER=wirepulse -e POSTGRES_DB=wirepulse -e POSTGRES_PASSWORD="$PW" "$PG_IMAGE" \
  postgres -c wal_level=replica -c max_wal_senders=5 -c max_replication_slots=5 -c wal_keep_size=256MB -c hot_standby=on >/dev/null
wait_for "the primary" docker exec "$PREFIX-primary" pg_isready -U wirepulse -d wirepulse
# The image's first start runs a temporary server; wait until the real one answers over the network.
wait_for "the primary on the network" docker run --rm --network "$NET" "$PG_IMAGE" pg_isready -h "$PREFIX-primary" -U wirepulse
psql_in "$PREFIX-primary" -c "CREATE ROLE replicator REPLICATION LOGIN PASSWORD '$PW'" >/dev/null
docker exec "$PREFIX-primary" sh -c 'echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"'
psql_in "$PREFIX-primary" -c "SELECT pg_reload_conf()" >/dev/null

# seed <volume> <upstream host>: a base backup of the upstream into the volume, set up as a standby of it.
seed() {
  docker volume create "$1" >/dev/null
  docker run --rm --network "$NET" -v "$1:/var/lib/postgresql/data" -e PGPASSWORD="$PW" --user root "$PG_IMAGE" sh -c \
    "pg_basebackup -h $2 -U replicator -D /var/lib/postgresql/data -R -X stream -w --checkpoint=fast && chown -R postgres:postgres /var/lib/postgresql/data && chmod 700 /var/lib/postgresql/data"
}
seed "$PREFIX-replica-data" "$PREFIX-primary"
docker run -d --name "$PREFIX-replica" --network "$NET" -v "$PREFIX-replica-data:/var/lib/postgresql/data" "$PG_IMAGE" postgres -c hot_standby=on >/dev/null
wait_for "the replica to stream" streaming "$PREFIX-primary"
if [ "$SYNC" = on ]; then
  psql_in "$PREFIX-primary" -c "ALTER SYSTEM SET synchronous_standby_names = '*'" >/dev/null
  psql_in "$PREFIX-primary" -c "SELECT pg_reload_conf()" >/dev/null
  wait_for "synchronous replication" synchronous "$PREFIX-primary"
fi

psql_in "$PREFIX-primary" -c "ALTER ROLE wirepulse SET statement_timeout = '15s'" >/dev/null
psql_in "$PREFIX-primary" -c "ALTER ROLE wirepulse SET idle_in_transaction_session_timeout = '15s'" >/dev/null

echo "== schema, PgBouncer ($POOL_MODE pool mode), API"
docker run --rm --network "$NET" -e NODE_ENV=development -e DEV_BEARER_TOKEN="$TOKEN" -e MIGRATE_ON_START=false \
  -e DATABASE_URL="postgresql://wirepulse:$PW@$PREFIX-primary:5432/wirepulse" "$API_IMAGE" node src/migrate-cli.mjs >/dev/null

cat > "$WORK/pgbouncer.ini" <<EOF
[databases]
wirepulse = host=$PREFIX-primary port=5432 dbname=wirepulse
# LISTEN/NOTIFY needs a session-level connection: with a transaction-mode pool the API's listener gets its own entry (LISTEN_DATABASE_URL).
wirepulse_listen = host=$PREFIX-primary port=5432 dbname=wirepulse pool_mode=session
[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
unix_socket_dir =
pidfile =
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
admin_users = wirepulse
pool_mode = $POOL_MODE
# The API sends these two as connection parameters, which PgBouncer refuses unless told to ignore them; the same limits are set on the
# database role instead (below), where they apply to every connection PgBouncer makes.
ignore_startup_parameters = statement_timeout,idle_in_transaction_session_timeout
default_pool_size = 20
max_client_conn = 500
server_connect_timeout = 5
server_login_retry = 1
query_wait_timeout = 20
${DRILL_PGBOUNCER_EXTRA:-}
EOF
printf '"wirepulse" "%s"\n' "$PW" > "$WORK/userlist.txt"
chmod 644 "$WORK/pgbouncer.ini" "$WORK/userlist.txt"
docker build -q -t wp-pgbouncer:drill - >/dev/null <<'EOF'
FROM alpine:3.20
RUN apk add --no-cache pgbouncer && adduser -D -u 1001 pgb
USER pgb
ENTRYPOINT ["pgbouncer", "/etc/pgbouncer/pgbouncer.ini"]
EOF
docker run -d --name "$PREFIX-pgbouncer" --network "$NET" -v "$WORK:/etc/pgbouncer:ro" --read-only --cap-drop ALL wp-pgbouncer:drill >/dev/null

LISTEN_URL=""
[ "$POOL_MODE" = transaction ] && [ "${DRILL_LISTEN_URL:-on}" = on ] && LISTEN_URL="postgresql://wirepulse:$PW@$PREFIX-pgbouncer:6432/wirepulse_listen"
docker run -d --name "$PREFIX-api" --network "$NET" -p "127.0.0.1:$API_PORT:8080" --read-only --tmpfs /tmp --cap-drop ALL \
  -e NODE_ENV=development -e PORT=8080 -e DEV_BEARER_TOKEN="$TOKEN" -e MIGRATE_ON_START=false \
  -e DATABASE_URL="postgresql://wirepulse:$PW@$PREFIX-pgbouncer:6432/wirepulse" -e DB_POOL_SIZE="${DRILL_DB_POOL_SIZE:-10}" \
  -e RATE_LIMIT_PER_MINUTE=1000000 -e RATE_LIMIT_IP_PER_MINUTE=1000000 -e GATEWAY_RATE_LIMIT_PER_MINUTE=1000000 \
  ${LISTEN_URL:+-e LISTEN_DATABASE_URL="$LISTEN_URL"} ${DRILL_API_ENV:+$DRILL_API_ENV} "$API_IMAGE" >/dev/null
wait_for "the API to be ready through PgBouncer" curl -fs "http://127.0.0.1:$API_PORT/readyz"
through_pgbouncer=$(docker exec -e PGPASSWORD="$PW" "$PREFIX-primary" psql -h "$PREFIX-pgbouncer" -p 6432 -U wirepulse -d wirepulse -tA -c "SHOW statement_timeout")
echo "statement_timeout seen through PgBouncer: $through_pgbouncer (the API's own setting is 15 s)"
[ "$through_pgbouncer" = 15s ] || { echo "the role's timeout does not reach connections made through PgBouncer" >&2; exit 1; }

if live_update before; then echo "live updates through PgBouncer ($POOL_MODE pool mode): a job created after the stream opened was delivered"
else echo "live updates through PgBouncer ($POOL_MODE pool mode): NOT delivered (LISTEN needs a session-level connection)"; FAILED=1; fi

echo "== load for ${LOAD_SECONDS}s; the primary is killed at +${FAULT_AT}s"
( while :; do printf '%s %s\n' "$(now)" "$(curl -s -o /dev/null -m 1 -w '%{http_code}' "http://127.0.0.1:$API_PORT/readyz" || true)"; sleep 0.2; done ) > "$WORK/ready.log" &
WATCH=$!
node "$ROOT/scripts/loadtest.mjs" --url "http://127.0.0.1:$API_PORT" --token "$TOKEN" --seconds "$LOAD_SECONDS" --workspaces 2 --gateways 4 --submitters 6 --readers 4 > "$WORK/load.txt" 2>&1 &
LOAD=$!
sleep "$FAULT_AT"
T_KILL=$(now); docker kill "$PREFIX-primary" >/dev/null
sleep "$DETECT_DELAY"
LAG=$(psql_in "$PREFIX-replica" -c "SELECT pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()") || LAG=unknown
T_PROMOTE=$(now); psql_in "$PREFIX-replica" -c "SELECT pg_promote(true, 60)" >/dev/null
T_PROMOTED=$(now)
sed -i "s/host=$PREFIX-primary/host=$PREFIX-replica/" "$WORK/pgbouncer.ini"
docker kill -s HUP "$PREFIX-pgbouncer" >/dev/null
T_REPOINT=$(now)
wait "$LOAD" || true
kill "$WATCH" 2>/dev/null || true; wait "$WATCH" 2>/dev/null || true

echo "== load test output"; cat "$WORK/load.txt"
echo "== failover timeline (seconds after the kill)"
awk -v kill="$T_KILL" -v promote="$T_PROMOTE" -v promoted="$T_PROMOTED" -v repoint="$T_REPOINT" -v lag="$LAG" '
  BEGIN { printf "replica had replayed everything it received at promotion: %s\n", lag;
          printf "promotion started +%.1f s, finished +%.1f s, PgBouncer repointed +%.1f s\n", promote-kill, promoted-kill, repoint-kill }
  $1 >= kill && $2 != 200 && !down { down = $1; downcode = $2 }
  $1 >= kill && down && $2 == 200 && !up { up = $1 }
  END { if (!down) print "the API never reported not-ready (all probes returned 200)"; else if (!up) print "the API did NOT become ready again"; else printf "first not-ready probe +%.1f s (HTTP %s), ready again +%.1f s: not ready for %.1f s\n", down-kill, downcode, up-kill, up-down }' "$WORK/ready.log"
echo "promoted server leaves recovery: $(psql_in "$PREFIX-replica" -c "SELECT NOT pg_is_in_recovery()")"

if LIVE_WAIT=60 live_update after; then echo "live updates after the failover: a new stream reconnected to the promoted server and delivered a job"
else echo "live updates after the failover: NOT delivered"; FAILED=1; fi

echo "== failback: rebuilding the old primary as a standby of the promoted server"
seed "$PREFIX-oldprimary-data" "$PREFIX-replica" >/dev/null
docker run -d --name "$PREFIX-oldprimary" --network "$NET" -v "$PREFIX-oldprimary-data:/var/lib/postgresql/data" "$PG_IMAGE" postgres -c hot_standby=on >/dev/null
if wait_for "the rebuilt standby to stream" streaming "$PREFIX-replica"; then
  echo "rebuilt old primary is streaming from the new primary"
else
  echo "rebuilt old primary did NOT start streaming"; exit 1
fi
grep -q '^RESULT ' "$WORK/load.txt" && echo "(the load test's own verdict above also lists the errors that the outage itself caused; they are expected)"
[ "$FAILED" = 0 ] || { echo "DRILL FAILED: see the lines above"; exit 1; }
echo "DRILL PASSED"
