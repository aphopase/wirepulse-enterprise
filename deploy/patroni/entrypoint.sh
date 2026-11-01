#!/bin/sh
# Writes the Patroni configuration from environment variables and runs Patroni. The DCS_* names are ours on purpose: Patroni itself reads any
# PATRONI_ETCD_* variable as a setting for the etcd v2 client and prefers it over the etcd3 section of the file (found the hard way). Required: PATRONI_NAME, DCS_ETCD_HOSTS,
# POSTGRES_PASSWORD (superuser), REPLICATION_PASSWORD, WIREPULSE_PASSWORD. Optional: SYNCHRONOUS_MODE=true|false (read only when the cluster is first created;
# change it later with `patronictl edit-config`).
set -eu
: "${PATRONI_NAME:?}" "${DCS_ETCD_HOSTS:?}" "${POSTGRES_PASSWORD:?}" "${REPLICATION_PASSWORD:?}" "${WIREPULSE_PASSWORD:?}"
DATA=/var/lib/postgresql/data/pgdata
mkdir -p "$DATA" && chmod 700 "$DATA"
cat > /tmp/post_bootstrap.sh <<'SCRIPT'
#!/bin/sh
# Runs once, on the first member, right after initdb. The connection URL is $1.
psql "$1" -v ON_ERROR_STOP=1 <<SQL
-- CREATEROLE: the migrating user creates the restricted role wirepulse_app (migration 008; DEPLOYMENT.md, row-level security).
CREATE ROLE wirepulse LOGIN CREATEROLE PASSWORD '$WIREPULSE_PASSWORD';
CREATE DATABASE wirepulse OWNER wirepulse;
ALTER ROLE wirepulse SET statement_timeout = '15s';
ALTER ROLE wirepulse SET idle_in_transaction_session_timeout = '15s';
SQL
SCRIPT
chmod 755 /tmp/post_bootstrap.sh
cat > /tmp/patroni.yml <<EOF2
scope: ${PATRONI_SCOPE:-wirepulse}
name: $PATRONI_NAME
etcd3:
  hosts: $DCS_ETCD_HOSTS
restapi:
  listen: 0.0.0.0:8008
  connect_address: $PATRONI_NAME:8008
bootstrap:
  dcs:
    # A leader that cannot renew its key within ttl stops being leader. The standbys wait ttl, then elect one. Failover time is about ttl + loop_wait.
    # Patroni raises a ttl below 20 to 20 for etcd3 (it logs "ttl=10 can't be smaller than 20"), so 20 is the shortest that is honest.
    ttl: ${DCS_TTL:-20}
    loop_wait: ${DCS_LOOP_WAIT:-3}
    retry_timeout: ${DCS_RETRY_TIMEOUT:-5}
    maximum_lag_on_failover: 1048576
    synchronous_mode: ${SYNCHRONOUS_MODE:-false}
    postgresql:
      use_pg_rewind: true
      use_slots: true
      parameters:
        wal_level: replica
        hot_standby: "on"
        wal_log_hints: "on"
        max_wal_senders: 10
        max_replication_slots: 10
        max_connections: 200
  initdb:
    - encoding: UTF8
    - data-checksums
  pg_hba:
    - local all all trust
    - host replication replicator 0.0.0.0/0 scram-sha-256
    - host all all 0.0.0.0/0 scram-sha-256
  post_bootstrap: /tmp/post_bootstrap.sh
postgresql:
  listen: 0.0.0.0:5432
  connect_address: $PATRONI_NAME:5432
  data_dir: $DATA
  bin_dir: /usr/lib/postgresql/16/bin
  pgpass: /tmp/pgpass
  # Without this a new member waits for a spread checkpoint on the leader (about 100 s on an idle one) before its copy starts.
  basebackup:
    - checkpoint: fast
  authentication:
    superuser: { username: postgres, password: "$POSTGRES_PASSWORD" }
    replication: { username: replicator, password: "$REPLICATION_PASSWORD" }
  parameters:
    unix_socket_directories: /var/run/postgresql
tags:
  nofailover: false
  noloadbalance: false
EOF2
exec /opt/patroni/bin/patroni /tmp/patroni.yml
