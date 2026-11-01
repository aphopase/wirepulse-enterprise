#!/usr/bin/env bash
# PostgreSQL failover decided by an orchestrator, in Docker: three Patroni-managed PostgreSQL members, a three-member etcd, HAProxy in front
# (deploy/patroni/), one API container behind HAProxy, and scripts/loadtest.mjs driving it. Nothing here promotes, repoints or restarts by
# hand: Patroni notices the fault, elects a new leader, HAProxy follows the leader's health endpoint, and the drill only measures.
# Three faults, one after the other on the same cluster, each under load:
#   kill        the leader is killed (SIGKILL). Docker does not restart a container stopped with `docker kill`, so the drill starts it again
#               once a new leader exists (a node coming back after the election); Patroni rejoins it, with pg_rewind if it diverged
#   switchover  a planned switchover to a standby (`patronictl switchover`)
#   partition   the leader keeps its clients and its replication links but loses the consensus store (etcd). It must stop accepting writes
#               before a new leader may exist; the drill writes to it directly every 0.5 s and checks that none succeeds after the election.
# After each one it waits for three healthy members and checks that they hold the same data.
#
#   scripts/patroni-drill.sh                       # asynchronous replication
#   DRILL_SYNC=true scripts/patroni-drill.sh       # synchronous_mode: an acknowledged commit must survive every fault
#   DRILL_SCENARIOS="kill" DRILL_SECONDS=60 scripts/patroni-drill.sh
#   DRILL_OUT=/some/dir scripts/patroni-drill.sh   # keep the raw output of every scenario
#
# Needs Docker with the compose plugin, node, curl and the API image (docker compose build api, or WIREPULSE_API_IMAGE). Everything it creates is
# named wp-pat* and is removed at the end (DRILL_KEEP=1 keeps it; DRILL_PROJECT=wp-pat scripts/patroni-drill.sh --clean removes it).
# What this does not show: a real network (everything is on one Docker host, so etcd and PostgreSQL share its fate), your storage, or a
# cloud-managed database.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROJECT=${DRILL_PROJECT:-wp-pat}
DC=(docker compose -p "$PROJECT" -f "$ROOT/deploy/patroni/docker-compose.yml")
API_IMAGE=${WIREPULSE_API_IMAGE:-wirepulse-api:local}
API_PORT=${DRILL_API_PORT:-18740}
SYNC=${DRILL_SYNC:-false}
LOAD_SECONDS=${DRILL_SECONDS:-80}
FAULT_AT=${DRILL_FAULT_AT:-20}
PARTITION_HOLD=${DRILL_PARTITION_HOLD:-30}  # seconds the leader stays cut off from etcd
SCENARIOS=${DRILL_SCENARIOS:-kill switchover partition}
MAX_UNAVAILABLE=${DRILL_MAX_UNAVAILABLE:-45} # the drill fails if the API is not ready again within this many seconds of the fault

# Compose will not read the file without these; any value does for removing a cluster. The run sets random ones below.
export POSTGRES_PASSWORD=x REPLICATION_PASSWORD=x WIREPULSE_PASSWORD=x
clean() { docker rm -f "$PROJECT-api" >/dev/null 2>&1 || true; "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; } # the API container first: it sits on the data network, which cannot be removed while it is attached
if [ "${1:-}" = "--clean" ]; then clean; exit 0; fi
clean
WORK=$(mktemp -d /tmp/wp-patroni.XXXXXX)
finish() {
  jobs -p | xargs -r kill 2>/dev/null || true
  [ -n "${DRILL_OUT:-}" ] && { mkdir -p "$DRILL_OUT"; cp -r "$WORK"/* "$DRILL_OUT"/ 2>/dev/null || true; }
  [ "${DRILL_KEEP:-}" = 1 ] && { echo "kept: project $PROJECT, files $WORK"; return; }
  clean; rm -rf "$WORK"
}
trap finish EXIT

docker image inspect "$API_IMAGE" >/dev/null 2>&1 || docker build -q -t "$API_IMAGE" "$ROOT/api" >/dev/null
rand() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
export POSTGRES_PASSWORD=$(rand 12) REPLICATION_PASSWORD=$(rand 12) WIREPULSE_PASSWORD=$(rand 12) SYNCHRONOUS_MODE=$SYNC
TOKEN=drill-$(rand 8)
now() { date +%s.%N; }
FAILED=0
fail() { echo "FAIL: $*"; FAILED=1; }
# WAIT_SECONDS is a deadline, not an attempt count: a check can itself take many seconds while the cluster is unwell.
wait_for() { local what=$1 end=$((SECONDS + ${WAIT_SECONDS:-120})); shift; while [ "$SECONDS" -lt "$end" ]; do "$@" >/dev/null 2>&1 && return 0; sleep 1; done; echo "timed out waiting for $what" >&2; return 1; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);'"$1"'})' "${@:2}"; }

# Asks the first member that answers. SKIP names one to leave out (the member cut off from etcd answers slowly or not at all).
ctl() { local m; for m in pg1 pg2 pg3; do [ "$m" = "${SKIP:-}" ] && continue; timeout 20 "${DC[@]}" exec -T "$m" /opt/patroni/bin/patronictl -c /tmp/patroni.yml "$@" 2>/dev/null && return 0; done; return 1; }
leader() { ctl list -f json | json 'console.log((m.find(x=>x.Role==="Leader"&&x.State==="running")||{}).Member||"")' 2>/dev/null || true; }
standby() { ctl list -f json | json 'console.log((m.find(x=>/Sync Standby/.test(x.Role))||m.find(x=>x.Role==="Replica")||{}).Member||"")' 2>/dev/null || true; }
timeline() { ctl list -f json | json 'console.log((m.find(x=>x.Role==="Leader")||{}).TL||"")' 2>/dev/null || true; }
# Exactly one running leader and two standbys that are streaming (and, with synchronous_mode, one of them synchronous).
healthy() {
  ctl list -f json | json 'const l=m.filter(x=>x.Role==="Leader"&&x.State==="running"),r=m.filter(x=>/Replica|Sync Standby/.test(x.Role)&&/streaming|running/.test(x.State)),sy=m.filter(x=>x.Role==="Sync Standby");
    process.exit(m.length===3&&l.length===1&&r.length===2&&(process.argv[1]!=="true"||sy.length===1)?0:1)' "$SYNC"
}
psql_on() { local m=$1; shift; "${DC[@]}" exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" "$m" psql -h 127.0.0.1 -U postgres -d wirepulse -tA "$@"; }
show_cluster() { ctl list || true; }

echo "== starting etcd (3), Patroni/PostgreSQL (3), HAProxy; synchronous_mode: $SYNC"
"${DC[@]}" up -d --build >/dev/null 2>"$WORK/compose-up.txt" || { cat "$WORK/compose-up.txt" >&2; exit 1; }
WAIT_SECONDS=180 wait_for "one leader and two streaming standbys" healthy
show_cluster
LEADER0=$(leader)
echo "cluster formed; leader $LEADER0, Patroni $("${DC[@]}" exec -T pg1 /opt/patroni/bin/patronictl version 2>/dev/null | tr -d '\r')"

echo "== schema and API (through HAProxy :5000, which routes to whichever member answers 200 on /primary)"
NET=${PROJECT}_data
DB_URL="postgresql://wirepulse:$WIREPULSE_PASSWORD@haproxy:5000/wirepulse"
# Applying the schema through HAProxy also proves that it routes to the leader and that the wirepulse role can log in.
wait_for "the schema to apply through HAProxy" docker run --rm --network "$NET" -e NODE_ENV=development -e DEV_BEARER_TOKEN="$TOKEN" -e MIGRATE_ON_START=false -e DATABASE_URL="$DB_URL" "$API_IMAGE" node src/migrate-cli.mjs
psql_on "$LEADER0" -c "CREATE TABLE drill_split_probe (member text, at timestamptz)" >/dev/null
docker run -d --name "$PROJECT-api" --network "$NET" -p "127.0.0.1:$API_PORT:8080" --read-only --tmpfs /tmp --cap-drop ALL \
  -e NODE_ENV=development -e PORT=8080 -e DEV_BEARER_TOKEN="$TOKEN" -e MIGRATE_ON_START=false -e DATABASE_URL="$DB_URL" -e DB_POOL_SIZE=10 \
  -e RATE_LIMIT_PER_MINUTE=1000000 -e RATE_LIMIT_IP_PER_MINUTE=1000000 -e GATEWAY_RATE_LIMIT_PER_MINUTE=1000000 "$API_IMAGE" >/dev/null
wait_for "the API to be ready" curl -fs "http://127.0.0.1:$API_PORT/readyz"

JOB='{"definition":{"tests":[{"id":"t1","name":"ready","commands":"status","expectedText":"READY","telemetryToken":"","telemetryOperator":">=","telemetryValue":"","timeoutMs":500,"retries":0}],"profile":{"settings":{"baud":"115200"}}}}'
api() { local method=$1 path=$2; shift 2; curl -fs -m 10 -X "$method" "http://127.0.0.1:$API_PORT$path" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$@"; }
# live_update <label>: a stream opened now must report its LISTEN connection as up and deliver a job created afterwards.
live_update() {
  local out="$WORK/stream-$1.txt" ws sse ok=0
  ws=$(api POST /v1/workspaces -d "{\"name\":\"live-$1\"}" | json 'console.log(m.id)') || return 1
  curl -sN -m 60 "http://127.0.0.1:$API_PORT/v1/workspaces/$ws/test-jobs/stream" -H "authorization: Bearer $TOKEN" > "$out" 2>/dev/null &
  sse=$!
  if WAIT_SECONDS=30 wait_for "a stream with a connected listener" grep -q '"listener":true' "$out"; then
    api POST "/v1/workspaces/$ws/test-jobs" -d "${JOB%\}}"',"idempotencyKey":"live-'"$1"'"}' >/dev/null || true
    WAIT_SECONDS=10 wait_for "a job event on the stream" grep -q '^event: job' "$out" && ok=1
  fi
  kill "$sse" 2>/dev/null || true; wait "$sse" 2>/dev/null || true
  [ "$ok" = 1 ]
}
if live_update before; then echo "live updates through HAProxy: a job created after the stream opened was delivered"; else fail "live updates not delivered before any fault"; fi

# ---- faults. Each sets OLD (the leader at the time) and returns once the fault has been applied (or, for the partition, once it has healed).
cname() { echo "$PROJECT-$1-1"; }
fault_kill() {
  "${DC[@]}" kill "$OLD" >/dev/null 2>&1
  local end=$((SECONDS + 90)) l=""
  while [ "$SECONDS" -lt "$end" ]; do l=$(leader); [ -n "$l" ] && [ "$l" != "$OLD" ] && break; sleep 1; done
  sleep 3
  echo "$OLD killed; new leader ${l:-none}; starting $OLD again"
  "${DC[@]}" start "$OLD" >/dev/null 2>&1
}
fault_switchover() { local cand; cand=$(standby); echo "switchover $OLD -> $cand"; ctl switchover --leader "$OLD" --candidate "$cand" --force 2>&1 | tail -3; }
fault_partition() {
  # Cut the leader off from etcd only. It still reaches HAProxy, the application and its standbys.
  docker network disconnect "${PROJECT}_etcd" "$(cname "$OLD")"
  ( while :; do
      t=$(now)
      if timeout 5 "${DC[@]}" exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" "$OLD" psql -h 127.0.0.1 -U postgres -d wirepulse -tA -c "INSERT INTO drill_split_probe VALUES ('$OLD', now())" >/dev/null 2>&1; then echo "$t ok"; else echo "$t refused"; fi
      sleep 0.3
    done ) > "$WORK/partition-direct-writes.log" &
  PROBE=$!
  sleep "$PARTITION_HOLD"
  kill "$PROBE" 2>/dev/null || true; wait "$PROBE" 2>/dev/null || true
  docker network connect --alias "$OLD" "${PROJECT}_etcd" "$(cname "$OLD")"
}

run_scenario() {
  local name=$1 out="$WORK/$1" t_fault t_leader since
  mkdir -p "$out"; since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  healthy || fail "$name: cluster not healthy before the fault"
  OLD=$(leader); local tl_before; tl_before=$(timeline)
  SKIP=""; [ "$name" = partition ] && SKIP=$OLD
  echo; echo "== scenario: $name   (leader $OLD, timeline $tl_before)  load ${LOAD_SECONDS}s, fault at +${FAULT_AT}s"
  ( while :; do b=$(curl -s -m 1 -w ' %{http_code}' "http://127.0.0.1:$API_PORT/readyz" || true); printf '%s %s\n' "$(now)" "${b##* }"
      case $b in *read_only*) now >> "$out/read-only.log";; esac; sleep 0.2; done ) > "$out/ready.log" &
  local watch=$!
  node "$ROOT/scripts/loadtest.mjs" --url "http://127.0.0.1:$API_PORT" --token "$TOKEN" --seconds "$LOAD_SECONDS" --workspaces 2 --gateways 4 --submitters 6 --readers 4 > "$out/load.txt" 2>&1 &
  local load=$!
  sleep "$FAULT_AT"
  t_fault=$(now)
  # Watch for a leader other than the old one (or, after a restart, the same member on a higher timeline).
  ( for _ in $(seq 1 120); do l=$(leader); tl=$(timeline); [ -n "$l" ] && { [ "$l" != "$OLD" ] || [ "${tl:-0}" -gt "$tl_before" ]; } && { echo "$(now) $l $tl"; break; }; sleep 0.5; done ) > "$out/new-leader.txt" &
  local elect=$!
  "fault_$name" 2>&1 | tee "$out/fault.txt" | sed 's/^/   /'
  wait "$load" || true
  wait "$elect" 2>/dev/null || true
  kill "$watch" 2>/dev/null || true; wait "$watch" 2>/dev/null || true

  echo "-- load test output"; sed 's/^/   /' "$out/load.txt"
  read -r t_leader NEWLEADER NEWTL < "$out/new-leader.txt" || { fail "$name: no new leader was elected"; return; }
  echo "-- timeline (seconds after the fault)"
  awk -v fault="$t_fault" -v leader="$t_leader" -v max="$MAX_UNAVAILABLE" '
    BEGIN { printf "   new leader seen +%.1f s\n", leader-fault }
    $1 >= fault && $2 != 200 && !down { down = $1; code = $2 }
    $1 >= fault && down && $2 == 200 && !up { up = $1 }
    END { if (!down) print "   the API never reported not-ready (every /readyz probe returned 200)";
          else if (!up) { print "   the API did NOT become ready again"; exit 2 }
          else { printf "   first not-ready probe +%.1f s (HTTP %s), ready again +%.1f s: not ready for %.1f s\n", down-fault, code, up-fault, up-down; if (up-fault > max) exit 3 } }' "$out/ready.log" \
    || fail "$name: the API was not ready again within ${MAX_UNAVAILABLE} s of the fault"
  echo "   leader $OLD -> $NEWLEADER"
  awk -v fault="$t_fault" '{ n++; if (!a) a = $1; z = $1 } END { if (n) printf "   /readyz reported database: read_only on %d probes, from +%.1f s to +%.1f s\n", n, a-fault, z-fault; else print "   /readyz never reported database: read_only" }' "$out/read-only.log" 2>/dev/null \
    || echo "   /readyz never reported database: read_only"

  # Integrity: the load test checks every acknowledged job and every audit chain, and no job handed out twice.
  grep -q 'handed out twice 0' "$out/load.txt" || fail "$name: a job was handed out more than once"
  [ "$(grep -c 'audit chain valid' "$out/load.txt")" = 2 ] || fail "$name: an audit chain is not valid"
  grep -E '^- workspace .* jobs passed' "$out/load.txt" | sed 's/^/   NOT all jobs passed: /' || true

  if [ "$name" = partition ]; then
    awk -v elected="$t_leader" -v fault="$t_fault" '
      { total++; if ($2 == "ok") { ok++; last = $1 } else if (!first_refused) first_refused = $1 }
      END { printf "   direct writes to the isolated leader: %d attempts, %d accepted, last accepted +%.1f s after the fault, first refused +%.1f s\n", total, ok, last ? last-fault : 0, first_refused ? first_refused-fault : -1;
            printf "   new leader elected +%.1f s after the fault\n", elected-fault;
            if (last > elected) exit 4 }' "$WORK/partition-direct-writes.log" \
      || fail "partition: the isolated old leader accepted a write AFTER the new leader was elected (split brain)"
    echo "   (a write accepted before the election is not a split brain: the old leader was still the leader then)"
  fi

  echo "-- after the fault"
  SKIP=""
  WAIT_SECONDS=180 wait_for "three healthy members" healthy && show_cluster | sed 's/^/   /' || fail "$name: the cluster did not return to one leader and two streaming standbys"
  local tl_after; tl_after=$(timeline)
  [ "${tl_after:-0}" -gt "$tl_before" ] && echo "   timeline $tl_before -> $tl_after" || fail "$name: timeline did not advance ($tl_before -> ${tl_after:-?})"
  # What the API logged as errors during the scenario, by SQLSTATE or message: a 500 here is a failure mode the API does not recognise.
  docker logs --since "$since" "$PROJECT-api" > "$out/api.log" 2>&1 || true
  echo "   API errors logged during the scenario:"
  node -e 'const c={};for(const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n")){try{const j=JSON.parse(l);if(j.level==="error"||j.level==="warn"){const k=j.level+" "+j.msg+" ["+(j.err?.code||j.err?.message||"").toString().slice(0,80)+"]";c[k]=(c[k]||0)+1}}catch{}}for(const [k,v] of Object.entries(c).sort((a,b)=>b[1]-a[1]).slice(0,8))console.log("     "+v+" x "+k);if(!Object.keys(c).length)console.log("     none")' "$out/api.log"
  if docker logs "$(cname "$OLD")" 2>&1 | grep -qi 'pg_rewind\|rewind'; then echo "   old leader $OLD logged pg_rewind activity"; fi
  # The same data on every member, once the standbys have caught up.
  sleep 3
  local counts=""
  for m in pg1 pg2 pg3; do counts="$counts $(psql_on "$m" -c "SELECT count(*) FROM test_jobs")"; done
  [ "$(echo $counts | tr ' ' '\n' | sort -u | wc -l)" = 1 ] && echo "   test_jobs rows on pg1/pg2/pg3:$counts (identical)" || fail "$name: members hold different data:$counts"
  if [ "$name" = kill ]; then
    if live_update "after-$name"; then echo "   live updates after the failover: a new stream delivered a job"; else fail "live updates not delivered after the failover"; fi
  fi
}

for s in $SCENARIOS; do run_scenario "$s"; done
echo
[ "$FAILED" = 0 ] || { echo "PATRONI DRILL FAILED: see the FAIL lines above"; exit 1; }
echo "PATRONI DRILL PASSED"
