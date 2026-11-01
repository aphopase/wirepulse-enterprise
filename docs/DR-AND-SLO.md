# Disaster recovery and service objectives

This page tells you what happens when each part fails, what you can promise your own users, and what you must add to meet a stricter promise. The objectives below are starting points to adopt after measuring your own deployment; this public source edition does not establish figures for your hardware, network or database.

## Where the state is

| Component | Holds | If lost |
|---|---|---|
| PostgreSQL | Everything: workspaces, members, jobs, evidence, reports, audit, outbox | Restore from backup. This is the one component you cannot rebuild. |
| Secrets directory and `.env` | Database password, `WEBHOOK_SIGNING_KEY`, `METRICS_TOKEN` | Keep a separate encrypted copy. A different `WEBHOOK_SIGNING_KEY` silently changes every webhook secret. |
| Redis (optional) | Rate-limit counters only | Nothing to restore. Limits fall back to per-replica counters until it returns. |
| API replicas, gateway agents, browser app | Nothing | Redeploy. Gateways keep their token files; jobs they held are requeued when the lease expires. |

## Recovery point and recovery time

| Backup method | Worst-case data loss (RPO) | Provided here |
|---|---|---|
| Scheduled `pg_dump` (see [Backup and restore](../DEPLOYMENT.md#backup-and-restore)) | Everything since the last dump: your schedule, for example 24 h or 1 h | Commands and a restore-verification procedure; rehearse it for your deployment. |
| WAL archiving / point-in-time recovery, or a managed database's PITR | Seconds to minutes, depending on your setup | Not configured by this repository; use your database platform. |

Recovery time (RTO) is the time to provision a host, restore the database, and start the stack. The restore time grows with database size and is the part you must measure. Rehearse it on a copy at production size, write the time down, and repeat after major upgrades. The sequence:

1. Stop the API (or leave a replacement host with the API stopped).
2. Restore the latest backup into an empty database (`pg_restore`, as documented).
3. Start the stack with the same secrets and `.env` (`docker compose up -d`). The `migrate` service brings the schema up to the running version first.
4. Check: `/readyz` is 200; `scripts/acceptance.mjs` passes; for an administrator, `GET /v1/workspaces/<id>/audit/verify` returns `valid: true` with the same `headHash` as before. If you shipped audit anchors, compare the last `audit.anchor` log line with the restored chain; rows after the backup point are legitimately gone, which the anchor check will report until you re-baseline (see [Audit log](../DEPLOYMENT.md#audit-log)).
5. Tell gateway operators nothing: agents reconnect on their own. Jobs that were mid-run when the database was restored were lost with the data newer than the backup; re-queue them.

## Failure scenarios

The table describes the intended behavior. Validate every row you rely on with the exact version and infrastructure you operate.

| Failure | Expected behaviour | Validation needed |
|---|---|---|
| One API replica stops | Other ready replicas can serve; `restart: unless-stopped` restarts a stopped Compose service; the load balancer should probe `/readyz`. A forced termination can fail in-flight requests, so clients must retry safe operations. | Test rolling update, crash, and stalled-replica handling with your load balancer and workload. |
| PostgreSQL restarts | Requests can receive `503 database_unavailable`; `/readyz` is unavailable while the database is unreachable or read-only. Clients should retry safe operations. | Rehearse database restart and recovery, including stream reconnection and audit verification. |
| PostgreSQL is lost | Everything stops until a replica is promoted or you restore. The Compose files do not perform failover automatically; `deploy/patroni/` is an example configuration, not a production guarantee. | Rehearse detection, promotion, fencing, client retry, replication loss bounds, and failback. |
| Redis stops | Rate limits fall back to per-replica counters until Redis returns. | Test loss and return of the Redis service with your chosen configuration. |
| Identity provider unreachable | New sign-ins fail; machine credentials (gateway tokens, API keys, SCIM tokens) do not depend on IdP discovery. | Test discovery and key-rotation behavior against your provider. |
| Gateway or lab machine offline | It becomes offline after its configured deadline; its job lease expires and the job is requeued up to `JOB_MAX_ATTEMPTS`, then marked `timed_out`. | Test disconnect, device loss, and duplicate-safe job execution on real lab hardware. |
| Whole host or site lost | Rebuild from backup and the separately kept secrets. | Rehearse from an independent location if this is within your recovery scope. |
| A workspace deleted by mistake | Administrator offboarding is soft for `WORKSPACE_PURGE_GRACE_DAYS` (30 by default), then the purge worker removes data. | Rehearse restore during the grace period and confirm your retention policy. |
| A bad upgrade | Each migration runs in a transaction. Additive migrations and rolling rollout permit rollback to a previous image only while that image remains compatible with the newer schema. Destructive changes require a restore plan. | Rehearse a failed migration, rollback with the schema ahead, and recovery from a destructive-change mistake. |

## Service objectives you can adopt

Measure these from `/metrics` and the probes. Treat the targets as a first draft to adjust once you have a month of data.

| Objective | Measured by | Starting target |
|---|---|---|
| API available | Fraction of `/readyz` probes that succeed, from outside, per month | 99.5% on one instance; 99.9% needs several replicas, a highly available database and a load balancer, none of which is provided here. |
| API latency | `wirepulse_http_request_duration_seconds` p95, excluding the live stream | Set after measuring your production-like deployment. |
| Jobs start promptly | `wirepulse_oldest_queued_job_age_seconds` while `wirepulse_gateways_online` > 0 | Under the job timeouts your suites use; alert when it exceeds that. |
| Results are trustworthy | Audit chains verify (`audit/verify`, anchor mismatches = 0) | No tolerance: a mismatch is an incident. |
| Recovery | Time and data loss from your last restore rehearsal | Whatever the rehearsal shows; do not publish a figure you have not rehearsed. |

Alerts that map to these are listed under [Monitoring](../DEPLOYMENT.md#monitoring).

## What you need to add for stricter promises

- Automatic database failover with fencing: `deploy/patroni/` is an example configuration. Validate it on the hosts, storage, network and failure modes you will operate. Choose synchronous replication if an acknowledged job must never be lost.
- Continuous archiving for an RPO of minutes, and backups stored off the host in a second location, encrypted.
- Zero-downtime upgrades: the rules, `upgrade.sh` and the Kubernetes manifests are in [Zero-downtime upgrades](../DEPLOYMENT.md#zero-downtime-upgrades). Review every migration against the expand-and-contract rules (nothing checks that automatically), and rehearse the procedure on the Kubernetes you will run.
- Capacity limits for your scale: measure load, failure behavior and recovery for your workload.
- Runbooks and on-call for your organisation; this page does not replace them.
