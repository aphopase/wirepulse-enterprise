# WirePulse on Kubernetes

Manifests for the control-plane API (`base/`), a test-only overlay that brings its own PostgreSQL and Redis (`overlays/kind-test/`), and `upgrade.sh`, which applies an additive migration before a rolling release.

PostgreSQL is **not** part of the base. Use a managed database or an operator you already run (Patroni-based operators, CloudNativePG, your provider's service). The overlay's single-pod PostgreSQL has no backups or failover and is for tests only.

## What is in `base/`

| File | What it is |
|---|---|
| `deployment.yaml` | 3 replicas, `RollingUpdate` with `maxUnavailable: 0` / `maxSurge: 1`, restricted Pod Security profile (non-root, read-only root filesystem, all capabilities dropped, `RuntimeDefault` seccomp), `/healthz` for liveness and start-up, `/readyz` for readiness, a `preStop` sleep of 8 s and a 30 s termination grace period, spread across nodes |
| `service.yaml` | ClusterIP Service on port 80 |
| `pdb.yaml` | `maxUnavailable: 1`: a node drain moves one API pod at a time |
| `hpa.yaml` | 3–10 replicas on 70% CPU, slow scale-down. Needs metrics-server in the cluster (most managed services have it) |
| `networkpolicy.yaml` | Ingress only from the `ingress-nginx` and `monitoring` namespaces on 8080; egress to DNS, and ports 5432, 6379, 443, 587, 465 |
| `configmap.yaml` | Non-secret settings; `MIGRATE_ON_START` is `false` |
| `migrate-job.yaml` | The schema migration as a Job, applied by `upgrade.sh` (not listed in `kustomization.yaml` on purpose) |

## Before you apply it

1. **A Secret** named `wirepulse-secrets` with the key `database_url` in the `wirepulse` namespace:
   `kubectl -n wirepulse create secret generic wirepulse-secrets --from-file=database_url=./database_url`.
   Add `SMTP_URL`, `WEBHOOK_SIGNING_KEY` or `METRICS_TOKEN` to it only if you use them (each also accepts a `_FILE` form, see [DEPLOYMENT.md](../../DEPLOYMENT.md#configuration-reference)).
2. **Edit `configmap.yaml`**: `OIDC_ISSUER`, `OIDC_AUDIENCE`, `CORS_ORIGINS`, `TRUST_PROXY` (the number of proxies in front, normally your ingress controller). With `NODE_ENV=production` the API refuses to start without them.
3. **An image** the cluster can pull: set it with `images:` in `base/kustomization.yaml` (it pins `wirepulse-api:0.1.0` now) or in an overlay of your own.
4. **An ingress controller** in a namespace called `ingress-nginx` (or change the label in `networkpolicy.yaml`), with no response buffering and a long idle timeout on `…/test-jobs/stream` (live updates are Server-Sent Events). Monitoring scrapes need the `monitoring` namespace and a `METRICS_TOKEN`.
5. **A CNI that enforces NetworkPolicy**, or delete `networkpolicy.yaml` from the kustomization. If you use a pooler on another port (PgBouncer on 6432), add that port to the egress rule.
6. **Reachability of PostgreSQL** on the port in `database_url` from the cluster.

## First install

`MIGRATE_ON_START=false`, so an API pod refuses to start (`database schema is behind`) until the schema exists. On the very first install run the migration before, or right after, the Deployment:

```sh
kubectl apply -k deploy/kubernetes/base
sed 's#image: wirepulse-api$#image: registry.example.com/wirepulse-api:0.1.0#' deploy/kubernetes/base/migrate-job.yaml | kubectl -n wirepulse apply -f -
kubectl -n wirepulse wait --for=condition=complete job/wirepulse-migrate --timeout=5m
kubectl -n wirepulse rollout restart deployment/wirepulse-api     # skips the crash-loop back-off of pods that started too early
```

Every later release uses `upgrade.sh`, which does this in the right order.

## Upgrading

```sh
NAMESPACE=wirepulse deploy/kubernetes/upgrade.sh registry.example.com/wirepulse-api:0.2.0
```

1. Deletes the previous migration Job and runs a new one **with the new image** while the old pods keep serving. If the migration fails or times out (`MIGRATE_TIMEOUT`, 15 min), the script stops, prints the Job's log and **does not touch the Deployment**.
2. Rolls the Deployment one pod at a time (a new pod must be ready before an old one is removed). If it is not ready within `ROLLOUT_TIMEOUT` (10 min) the script runs `kubectl rollout undo` and exits non-zero.

This is only safe if the migration is **additive** and the previous release runs on the new schema: add tables and nullable or defaulted columns, never rename, drop or tighten anything in the same release that stops using it ("expand, deploy, contract"). The rules and migration-lock handling are in [Zero-downtime upgrades](../../DEPLOYMENT.md#zero-downtime-upgrades). Rolling back to the previous image while the schema is ahead is supported for the same reason.

## What happens during disruptions

| Event | What the manifests do |
|---|---|
| Rolling update | A new pod must pass `/readyz` before an old one is stopped. The old pod keeps serving through an 8 s `preStop` sleep while endpoints and kube-proxy rules catch up, then on `SIGTERM` answers with `Connection: close` for `SHUTDOWN_DRAIN_MS` (2 s) before it closes, so keep-alive clients reconnect to another pod instead of failing |
| Pod deleted | Same as above |
| Pod killed without grace (`--grace-period=0`, OOM kill, node loss) | Requests in flight on that pod fail and clients must retry; a job whose completion was lost waits for its lease (`JOB_LEASE_SECONDS`, 60 s) and is handed out again |
| Node drain | The PodDisruptionBudget lets one API pod go at a time |
| Database briefly unreachable | `/readyz` goes 503 on every pod and requests answer `503 database_unavailable`; pods are not restarted (`/healthz` does not touch the database) and recover by themselves |
| Bad image | The new pod never becomes ready; `maxUnavailable: 0` keeps the old pods serving and `upgrade.sh` rolls back |

`/readyz` is coupled to the database on purpose, so a database outage makes the Service return 503 instead of letting requests fail one by one. The consequence is that all pods leave the Service together during a database pause.

## Validation

The public source edition includes these manifests and the upgrade procedure, but not the former Kubernetes test harness or its historical performance claims. Before production use, validate the procedure on the cluster, database, ingress, CNI, and workload you will operate. At minimum rehearse an additive migration, a rollback with the schema ahead, a failed migration, pod disruption, readiness removal, NetworkPolicy, autoscaling, and database recovery.

**Not tested**

- A managed Kubernetes service: an ingress controller and cloud load balancer in front of the Service, a real StorageClass, several zones or node pools, node loss (the drain is an orderly eviction), and your cluster's admission policies. kind runs everything on one Docker host.
- Egress policy beyond the two ports probed (one listed, one not), and on CNIs other than kindnet. Add the address and port of an external managed database or identity provider to the policy yourself.
- PostgreSQL on Kubernetes: the overlay's single pod is a fixture; an operator (CloudNativePG, a Patroni operator) was not tried.
- Helm, Argo CD or Flux: the manifests are plain Kustomize.
- A crash inside a running pod fails the requests it was serving; clients and gateways must retry, and a job whose completion was lost waits for its lease and is handed out again.
