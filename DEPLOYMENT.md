# Self-hosted WirePulse deployment

WirePulse has three parts. Only the first needs no server.

| Part | Where it runs | What it does |
|---|---|---|
| Browser app (`dist/`) | any static host | Serial monitor and validation. Serial bytes stay in the browser. |
| Control plane (`api/` + PostgreSQL) | your server, via `docker-compose.yml` | Workspaces, roles, shared profiles and suites, job queue, evidence verification, audit. |
| Gateway agent (`gateway/`) | the lab machine with the device attached | Claims queued jobs, drives the serial port, uploads hash-linked evidence (never raw bytes). |

The full HTTP contract is [docs/openapi.yaml](docs/openapi.yaml) (OpenAPI 3.0.3). The test suite checks the live server against it. For what is and is not covered by tests, see [Readiness and known limits](#readiness-and-known-limits). First time here: [docs/HANDOVER.md](docs/HANDOVER.md). Security: [SECURITY.md](SECURITY.md), [threat model](docs/THREAT-MODEL.md), [disaster recovery and service objectives](docs/DR-AND-SLO.md).

Two deployment shapes use the same image and the same code:

- **Self-hosted, one organisation.** The defaults: every workspace is on the `enterprise` plan (no per-workspace limits), no Redis, no outbound mail, no webhooks. Start here.
- **Multi-tenant service (SaaS).** Several API replicas behind a load balancer, Redis for shared rate limits, per-workspace plans and quotas, webhooks, invitation email, workspace offboarding. See [Scale out](#scale-out-several-api-replicas) and [Running it as a service](#running-it-as-a-service-plans-quotas-offboarding).

## Prerequisites

- Docker Engine with Compose v2 on a Linux host
- An HTTPS reverse proxy or ingress in front of the API (Caddy, nginx, Traefik, a cloud load balancer)
- An OpenID Connect provider that enforces your MFA policy; the API validates its JWTs
- DNS and certificates for the browser app and the API
- Optional: Redis (shared rate limits across replicas; exercised with Redis 7), an SMTP relay (invitation email), a signing key (webhooks)

## Deploy the control plane

1. **Create the database secrets** on a local disk (not a root-squashed network mount, which cannot be bind-mounted):

   ```sh
   sudo ./scripts/init-secrets.sh /etc/wirepulse/secrets      # or just ./scripts/init-secrets.sh for ./secrets
   export WIREPULSE_SECRETS_DIR=/etc/wirepulse/secrets         # also put this in your service environment
   ```

   The script writes a random password and the matching `DATABASE_URL`. It never overwrites existing files. The files are mode 0644 inside a 0700 directory, because the containers read them as non-root users.

2. **Configure** `cp .env.example .env` and set `CORS_ORIGINS` (the exact https origin of the browser app), `OIDC_ISSUER`, `OIDC_AUDIENCE` and `TRUST_PROXY` (number of proxy hops in front of the API).

3. **Start**:

   ```sh
   docker compose up -d --build
   docker compose ps          # postgres healthy, migrate exited 0, api healthy
   ```

   Compose runs a one-shot `migrate` service first, then the API with `MIGRATE_ON_START=false`, so several API replicas can never race to migrate. To upgrade, rebuild and run `docker compose up -d --build` again; the migration runs before the new API starts.

4. **Put the reverse proxy in front** of `127.0.0.1:${API_PORT:-8080}`. Do not publish PostgreSQL; in this compose file it sits on an internal network with no published port. For the live job stream (`GET …/test-jobs/stream`, Server-Sent Events) the proxy must not buffer responses and must allow idle reads of a few minutes (nginx: `proxy_buffering off; proxy_read_timeout 3600s;`). The server sends a keep-alive comment every 15 s and closes each stream after `SSE_MAX_LIFETIME_SECONDS` (default 1800); the browser reconnects.

5. **Probe**: `GET /healthz` (liveness) and `GET /readyz` (readiness: 503 while the database is failing or read-only, or the server is shutting down). Point the load balancer at `/readyz`.

6. **Accept the installation.** With an administrator's access token (any token your identity provider issues for the API audience), run once after installing or upgrading, and keep the output with your change record:

   ```sh
   node scripts/acceptance.mjs --url https://api.example.com --token "$ADMIN_TOKEN" [--metrics-token "$METRICS_TOKEN"]
   ```

   It makes 13 checks and exits 0 only if all pass: the probes answer; no credential, a garbage token and an unsigned (`alg: none`) token are refused with 401; hardening headers are present and `x-powered-by` is not; `/metrics` is closed to anonymous callers (and answers with its token); your token is accepted; a malformed identifier and a NUL character give a clean 400; and a 15-second job cycle (queue, claim by simulated gateways, run, verified evidence, valid audit chain) completes. It then offboards the `loadtest-*` workspaces it created. It writes and deletes data in the target, so run it on a deployment you operate, not in the middle of a customer's incident.

The default configuration is production: the API refuses to start unless OIDC and https CORS origins are configured, `DEV_BEARER_TOKEN` is rejected, and `/metrics` is hidden unless `METRICS_TOKEN` is set. For a local trial set `NODE_ENV=development`, `DEV_BEARER_TOKEN`, `CORS_ORIGINS=http://localhost:5173` in `.env`.

Container hardening already applied: non-root user, read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, tini as PID 1 (so `docker stop` triggers the graceful shutdown and exits 0), CPU and memory limits, rotated JSON logs, healthchecks.

## Host the browser app

```sh
npm ci && npm run build        # type-checks, then writes dist/
```

Serve `dist/` from any static host over HTTPS. Set a restrictive Content-Security-Policy at that host; the app only needs to connect to itself and to your API origin (`connect-src 'self' https://api.example.com`). Users enter the API URL in the sidebar and press **Sign in with SSO** (see [Browser sign-in](#browser-sign-in-sso)); where that is not configured they paste a short-lived OIDC access token instead. Either way the token is kept in memory only.

### Browser sign-in (SSO)

The console can send people to your identity provider and take them back signed in, instead of asking them to paste a token. It uses the OpenID Connect authorization code flow with PKCE (S256) as a *public* client: there is no client secret anywhere, the code verifier never leaves the browser tab, and the access token (and a refresh token, if the provider issues one) lives in memory only. The one thing written to `sessionStorage` is the request in flight (state, nonce, verifier), and it is removed the moment the provider sends the browser back.

1. **At the provider**, create a public client (Keycloak: *Client authentication off*, *Standard flow on*, PKCE method `S256`; Okta: an *OIDC single-page app*; Entra ID: a *Single-page application* redirect; Auth0: a *Single Page Application*). Redirect URI: the exact address the console is served from (origin and path, for example `https://wirepulse.example.com/`). Allow that origin for CORS at the provider (Keycloak calls it *Web origins*): the browser calls the token endpoint itself.
2. **Make the API's tokens acceptable.** The access token this client receives must be one the API already accepts: issuer `OIDC_ISSUER`, audience `OIDC_AUDIENCE`, and the `email` / `email_verified` claims described under *SSO with your identity provider* below. In Keycloak add an audience mapper; at Auth0 set `OIDC_AUTHORIZE_AUDIENCE=true`.
3. **Set `OIDC_CLIENT_ID`** (and, if you need other scopes, `OIDC_SCOPES`) on the API and restart it. `GET /auth/config` then returns the issuer, client id and scopes, which are public by nature (they are in every authorization URL). Without `OIDC_CLIENT_ID` it returns `{"sso":null}` and the console shows only the token field.
4. **Let the console reach the provider.** If you serve the console with a Content-Security-Policy, add the provider's origin to `connect-src`. The browser needs a secure context (https, or `localhost` for a trial).

What the console checks: the provider's discovery document names the issuer the API advertises; the authorization and token endpoints are https (plain http only for a provider on the same machine); the `state` returned equals the one sent; a pending request older than 10 minutes is refused; the `nonce` in the ID token, when the provider returns one, matches. With a refresh token the access token is renewed a minute before it expires; without one, or when the provider refuses it, the console ends the session and the person signs in again.

The repository includes browser coverage against a throwaway Keycloak and test cases for browser sign-in state, refusal, token renewal, and `GET /auth/config`; `scripts/test-keycloak.sh` starts its test clients. This does not establish interoperability with Okta, Entra ID, Auth0, or Google, whose consent screens, refresh-token rules, and CORS settings can differ. Run the [pilot](docs/PILOT-GUIDE.md) with your provider before relying on browser sign-in. Single sign-out (ending the provider's own session) is not implemented: **Sign out** in the console forgets the tokens in the tab.

## Configuration reference

All settings can be given as `NAME` or `NAME_FILE` (the file's contents), so any of them can be a Docker or Kubernetes secret. Defaults are in [api/src/config.mjs](api/src/config.mjs), which is the authority. `docker-compose.yml` passes the container the settings listed in `.env.example` (plus a few more under `x-env`); to set any other setting, or a `*_FILE` variant, add it to `x-env` there.

| Setting | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string |
| `LISTEN_DATABASE_URL` | `DATABASE_URL` | Connection string for the one `LISTEN` connection per replica (live updates). Set it only when `DATABASE_URL` goes through a transaction-mode pooler: `LISTEN` needs a session-level connection, see [Connection pooling](#connection-pooling-pgbouncer) |
| `DB_POOL_SIZE` | 10 | Connections per API instance, plus one dedicated listener connection. Keep `instances × (DB_POOL_SIZE + 1)` below PostgreSQL's `max_connections` (100 by default), with headroom for the migration job and your own tools |
| `MIGRATE_ON_START` | `true` (`false` in the Compose and Kubernetes files) | Whether an API replica applies pending migrations itself at start. Leave it `true` for a single instance; with several replicas let one migrate step own the schema (the `migrate` service, the Kubernetes Job) |
| `MIGRATE_LOCK_TIMEOUT_MS`, `MIGRATE_LOCK_RETRY_SECONDS` | 1000, 120 | A migration waits at most this long for a table lock, then gives up and tries again with a growing pause, for up to the retry window (see [Zero-downtime upgrades](#zero-downtime-upgrades)). Without the limit an `ALTER TABLE` waiting behind one long transaction blocks every query queued after it |
| `SHUTDOWN_DRAIN_MS` | 2000 (0–8000) | After `SIGTERM` the replica keeps answering for this long with `Connection: close`, so keep-alive clients and a balancer reconnect elsewhere before the listener closes. Keep it below the platform's termination grace period |
| `DB_SSL`, `DB_SSL_CA_FILE` | `off` | `verify` + a CA file for a managed database (`require` encrypts but does not verify the server) |
| `CORS_ORIGINS` | none in production | Exact browser origin(s) |
| `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URI` | issuer and audience required in production | Token validation. The signing keys are located through `<issuer>/.well-known/openid-configuration` (the document every standard provider publishes); set `OIDC_JWKS_URI` (https) only if yours does not. The issuer is reached over TLS with certificate verification; trust a private CA with `NODE_EXTRA_CA_CERTS`. If the provider is unreachable at startup, sign-ins fail (401) and discovery is retried after 30 seconds. |
| `OIDC_CLIENT_ID`, `OIDC_SCOPES`, `OIDC_AUTHORIZE_AUDIENCE` | unset, `openid email profile`, `false` | Turns on **Sign in with SSO** in the console: the id of a *public* client at your provider (authorization code with PKCE, no secret). The API only advertises these through `GET /auth/config`; it never sees the browser's tokens except as bearer tokens, which it validates as before. `OIDC_AUTHORIZE_AUDIENCE=true` adds `audience=<OIDC_AUDIENCE>` to the authorization request, which Auth0 needs to issue a token for this API. Setup in [Browser sign-in](#browser-sign-in-sso) |
| `OIDC_TRUST_UNVERIFIED_EMAIL` | `false` | Keep `false`: invitations are matched to a verified email only |
| `TRUST_PROXY` | unset | Proxy hops; without it rate limits and audit see the proxy's address (warned at startup) |
| `RATE_LIMIT_PER_MINUTE` / `_IP_` / `GATEWAY_` / `AUTH_FAILURE_` | 240 / 1200 / 600 / 30 | Per user, per IP, per gateway, and failed authentications per IP. Shared across replicas when `REDIS_URL` is set, otherwise counted per instance. When an IP has used up its failures, a request that carries a credential this replica verified in the last 5 minutes still gets through the throttle (and is then checked in full), so one person mistyping behind an office NAT does not lock out colleagues who are signed in; a credential the replica has not seen recently is refused like any other until the minute ends |
| `REDIS_URL` | unset | `redis://` or `rediss://`. Holds rate-limit counters only (nothing else is stored there). While Redis is unreachable each instance falls back to its own counters and logs the failure; it recovers by itself |
| `JOB_LEASE_SECONDS`, `JOB_MAX_ATTEMPTS` | 60, 3 | A gateway that stops renewing loses its job; after the last attempt the job is `timed_out` |
| `MAX_QUEUED_JOBS_PER_WORKSPACE`, `QUEUE_TTL_SECONDS` | 1000, 86400 | Queue limit per workspace (429 `queue_full`; the lower of this and the plan's `queuedJobs` applies, counted under a lock so concurrent submissions cannot overshoot) and expiry of never-claimed jobs |
| `SSE_MAX_CLIENTS`, `SSE_MAX_CLIENTS_PER_WORKSPACE`, `SSE_MAX_LIFETIME_SECONDS` | 500, 100, 1800 | Live-stream caps per instance: 503 `too_many_streams` for the instance as a whole, 429 `too_many_streams_for_workspace` for one workspace (so a tenant with many API keys cannot fill the instance and push the others to polling), 429 `too_many_streams_for_subject` at 10 per user. Keep the per-workspace cap below the instance cap |
| `DB_ROW_LEVEL_SECURITY` | `true` | Request handlers run as a database role that PostgreSQL confines to the caller's workspace. Needs the role `wirepulse_app` (migration 008 creates it, so the migrating user needs `CREATEROLE`) and a runtime user that owns the tables; the API refuses to start if that is not so. `false` is the escape hatch for a database where it cannot be arranged (warned at start). See [Database-level tenant isolation](#database-level-tenant-isolation-row-level-security) |
| `INVITATION_TTL_DAYS`, `API_KEY_MAX_DAYS` | 7, 365 | API keys always expire |
| `SCIM_TOKEN_MAX_DAYS` | 365 | Longest lifetime of a SCIM provisioning token (1–3650); SCIM tokens always expire (see [Provisioning people](#provisioning-people-scim-20)) |
| `RETENTION_DAYS_JOBS/REPORTS/AUDIT` | `0` (keep) | Irreversible deletion; each purge is audited |
| `AUDIT_ANCHOR_INTERVAL_MINUTES` | `0` (off) | Every N minutes each workspace's audit chain head is verified against the previous anchor, then logged as an anchor (see [Audit log](#audit-log)) |
| `DEFAULT_PLAN` | `enterprise` | Plan given to new workspaces: `free`, `team`, `business` or `enterprise` (unlimited). **Set `free` for a public service** (see the launch checklist) |
| `MAX_WORKSPACES_PER_USER` | `0` (no cap) | Live workspaces one person may have created (counts those not offboarded). **Set a cap for a public service** |
| `WORKSPACE_PURGE_GRACE_DAYS`, `WORKSPACE_PURGE_INTERVAL_MS` | 30, 300000 | How long an offboarded workspace can still be restored, and how often the purge worker looks |
| `SMTP_URL`, `SMTP_FROM`, `INVITE_BASE_URL` | unset | Invitation email. `smtp://user:pass@host:587` must upgrade with STARTTLS or nothing is sent; `smtps://` uses TLS from the first byte; `?tls=none` (a trusted local relay only) is refused in production. `SMTP_FROM` is required with `SMTP_URL`. `INVITE_BASE_URL` is the link put in the mail (your browser app's address) |
| `WEBHOOK_SIGNING_KEY` | unset (webhooks off) | At least 32 characters of secret. Per-webhook secrets are derived from it; without it the webhook routes answer 501 `webhooks_not_configured` |
| `WEBHOOK_ALLOWED_CIDRS` | none | Private ranges webhooks may reach (for example `10.20.0.0/16` for an internal receiver). Public addresses need no entry; link-local and cloud-metadata addresses are never reachable |
| `WEBHOOK_ALLOW_PRIVATE_NETWORKS` | `false` | Switches the SSRF protection off. Refused at startup in production |
| `WEBHOOK_TIMEOUT_MS` | 5000 | One deadline for resolving, connecting and getting response headers |
| `OUTBOX_INTERVAL_MS`, `OUTBOX_MAX_ATTEMPTS`, `OUTBOX_RETENTION_DAYS` | 2000, 8, 14 | Delivery worker poll interval, attempts per message (1–30), and how long delivered or failed messages are kept |
| `METRICS_TOKEN`, `METRICS_PORT` | unset | Bearer token (≥ 24 chars) on `/metrics`, or serve it on a separate internal port |
| `LOG_LEVEL` | `info` | pino JSON logs; secrets and tokens are redacted |

## Run a gateway agent

The agent runs on the machine the device is plugged into. It only makes outbound HTTPS calls; no inbound port is needed.

1. In the console: **Gateways → Register gateway** (maintainer or above). The `wpg_…` token is shown once and stored server-side only as a hash. Labels such as `bench=1` select where a job runs: a gateway only claims jobs whose `requirements` are all present in its labels.
2. On the lab machine: install Node 20, copy `gateway/` to `/opt/wirepulse/gateway`, run `npm ci --omit=dev` there (the `serialport` module is an optional dependency and needed for real hardware).
3. Install the unit [gateway/deploy/wirepulse-gateway.service](gateway/deploy/wirepulse-gateway.service) (the token goes in a file, see the comments in the unit), then `systemctl enable --now wirepulse-gateway`. Settings: `WIREPULSE_API_URL` (https; plain http only for localhost), `WIREPULSE_SERIAL_PATH`, `WIREPULSE_GATEWAY_TOKEN_FILE`, and optional `WIREPULSE_POLL_MS`, `_HEARTBEAT_MS`, `_LEASE_RENEW_MS`, `_REQUEST_TIMEOUT_MS`, `_MAX_BACKOFF_MS`, `_SHUTDOWN_GRACE_MS`.
4. **Rotate** a token: Gateways → **Rotate token**, write the new token to the token file, `systemctl restart wirepulse-gateway`. The old agent stops by itself the next time it contacts the server (it logs that the token was rejected). **Revoke** retires the gateway for good.
5. A gateway is shown online if it sent a heartbeat in the last 90 s. If the device cannot be opened, the agent does not report the job as failed; its lease expires and the job is requeued (up to `JOB_MAX_ATTEMPTS`).

The server decides every job's final status itself by re-verifying the hash-linked evidence; the agent's claim is not trusted.

## Roles

| Role | Can additionally |
|---|---|
| viewer | list and read jobs, stream, download JUnit XML; read profiles, suites (with version history) and reports; list gateways; read the workspace's plan and usage |
| engineer | queue and cancel jobs; create and update profiles and suites; upload test reports |
| maintainer | register, label, rotate and revoke gateways; delete profiles and suites; list members |
| administrator | manage members, invitations, API keys and webhooks; list, export and verify the audit log; delete (offboard) the workspace, as a person only |

A non-member, an unknown workspace and a too-low role all receive the same `403 insufficient_workspace_role`, so workspace ids cannot be probed. A missing object inside an accessible workspace is `404`. API keys (`wpk_…`) are workspace-scoped, at most maintainer, always expiring, and can only be created by a person, not by another key. An invitation is matched to the invitee's verified OIDC email when they sign in and accept. If SMTP is configured the server also emails the invitee; otherwise tell the invitee yourself (see [Invitation email](#invitation-email)).

## Scale out: several API replicas

`docker-compose.scale.yml` is an overlay that runs several identical API replicas behind nginx (`deploy/nginx.scale.conf`) and adds Redis:

```sh
docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d --build --scale api=3
```

Nothing depends on which replica served a request, so any load balancer works; what is shared, and how:

| What | Where it is coordinated |
|---|---|
| Jobs, claims, quotas, audit | PostgreSQL row locks and advisory locks |
| Live job updates (SSE) | PostgreSQL `LISTEN/NOTIFY`: a client connected to one replica sees changes made through another |
| Rate limits | Redis when `REDIS_URL` is set. Without it each replica counts alone, so the effective limit is the configured one times the number of replicas |
| Background workers (lease sweep, outbox, retention, anchoring, purge) | Run on every replica and coordinate in PostgreSQL (`FOR UPDATE SKIP LOCKED`, advisory locks); a crashed worker's rows come back when its lease runs out |

Things to get right:

- **Database connections.** Each replica holds up to `DB_POOL_SIZE` pooled connections plus one for `LISTEN`. Keep `replicas × (DB_POOL_SIZE + 1)` below `max_connections`.
- **Redis is optional state.** It holds rate-limit counters only. If it is unreachable the API uses per-replica counters, logs a warning, and returns to shared counters when Redis recovers. Validate that fallback for your topology.
- **Your own load balancer.** Health check `/readyz` and eject a replica that fails it; do not buffer responses and use an idle timeout of at least a few minutes on `…/test-jobs/stream`; set `TRUST_PROXY` to the number of hops in front of the API. Keep connection and ordinary route read timeouts short. `deploy/haproxy.scale.cfg` is an example with active health checks.
- **Failed and hung replicas.** The nginx example has no active health checks. A request already sent to a failing replica can fail; clients must retry safe operations, and job submission should use `idempotencyKey`. Use a balancer that detects unhealthy replicas and rehearse crash, freeze, recovery, and client-retry behavior on your infrastructure.
- **A lost claim or completion is redelivered.** If a replica dies while a gateway is claiming or completing a job, the gateway may not learn the outcome. The job remains leased until `JOB_LEASE_SECONDS` expires, then returns to the queue. Job execution is therefore at-least-once: a test can run a second time on the device.
- **Rolling restarts.** On `SIGTERM` a replica stops reporting ready, finishes in-flight requests, and closes streams so browsers reconnect. A forced exit can still fail an in-flight request; retry safe calls and use idempotency keys.
- **Schema upgrades** run once in the `migrate` service before any new replica starts. For an upgrade with old and new replicas side by side, use the additive migration rules in [Zero-downtime upgrades](#zero-downtime-upgrades).

### Load balancer with health checks (HAProxy)

`deploy/haproxy.scale.cfg` is an example load balancer with active health checks. It is behind a compose profile, so it is not started unless you ask:

```sh
docker compose -f docker-compose.yml -f docker-compose.scale.yml --profile haproxy up -d --scale api=6
# the HAProxy listener is on HAPROXY_PORT (default 8081); the nginx one stays on LB_PORT
```

It probes every replica's `/readyz`, follows `--scale api=N` through Docker DNS, does not retry a POST that may have reached a backend, and routes `…/test-jobs/stream` with a long timeout. It does not terminate TLS; put a certificate-bearing proxy in front or configure TLS yourself. Run fault-injection and client-retry exercises before relying on these settings in production.

### Connection pooling (PgBouncer)

Use session pooling for `LISTEN`, or give the listener a dedicated session-pooled connection. In transaction pooling, set `LISTEN_DATABASE_URL` to a separate session-mode database entry; otherwise live updates may not arrive. The API sends `statement_timeout` and `idle_in_transaction_session_timeout` on connection, so configure PgBouncer to accept those startup parameters and apply the same limits to the PostgreSQL role:

```ini
ignore_startup_parameters = statement_timeout,idle_in_transaction_session_timeout

[databases]
wirepulse        = host=pg-primary port=5432 dbname=wirepulse
wirepulse_listen = host=pg-primary port=5432 dbname=wirepulse pool_mode=session
```

```sql
ALTER ROLE wirepulse SET statement_timeout = '15s';
ALTER ROLE wirepulse SET idle_in_transaction_session_timeout = '15s';
```

```sh
DATABASE_URL=postgresql://wirepulse:…@pgbouncer:6432/wirepulse
LISTEN_DATABASE_URL=postgresql://wirepulse:…@pgbouncer:6432/wirepulse_listen
```

In session mode, leave `LISTEN_DATABASE_URL` unset. Set `max_client_conn` for `replicas × (DB_POOL_SIZE + 1)`, account for the listener connections, and use bounded connection and queue timeouts. Validate TLS, authentication, failover, live updates, and recovery with the exact pooler configuration you operate.

### Load and integrity test

`scripts/loadtest.mjs` drives a running deployment (one instance or many behind a balancer) with simulated gateways that claim and complete jobs with hash-linked evidence, while submitters and readers hit the API:

```sh
node scripts/loadtest.mjs --url http://127.0.0.1:8080 --token "$ADMIN_TOKEN" --seconds 30 --workspaces 2 --gateways 6
```

It prints throughput and latency percentiles, and exits non-zero if its required invariants are not met. It creates `loadtest-…` workspaces and leaves them behind; offboard them afterward. Do not point it at production. Size your deployment by running it on representative hardware and retaining the output with your release evidence.

### Zero-downtime upgrades

An upgrade without downtime means old and new replicas serve at the same time against one database. It is safe only if **the previous release keeps working on the new schema**, so each release follows “expand, deploy, contract”:

1. **Expand** (release N): migrations only add. New tables, new nullable or defaulted columns, and new indexes. Do not rename, drop, retype, or make a field `NOT NULL` while old code can run against the schema.
2. **Deploy**: run the migration first, then roll replicas one at a time (`deploy/kubernetes/upgrade.sh` does this in that order).
3. **Contract** (release N+1 or later): after no deployed or rollback-target release needs the old shape, remove it in a later migration.

The migration runner records a checksum for each applied file, takes an advisory lock, and applies each file in its own transaction. With `MIGRATE_ON_START=false`, an older image can start against a schema with later additive migrations, but an image refuses to start when migrations it requires are missing. `MIGRATE_LOCK_TIMEOUT_MS` bounds waiting for a table lock; retrying is bounded by `MIGRATE_LOCK_RETRY_SECONDS`.

During a rolling update, gateway agents and browser tabs from either release may talk to either replica version. Keep `/v1` changes additive and review every migration for compatibility. The API stops accepting work on `SIGTERM`, `/readyz` turns 503, and the Kubernetes manifests keep a terminating pod in service briefly while endpoints update. These mechanisms are not a guarantee of zero dropped requests: clients must retry safe operations and gateway job execution is at-least-once.

### Kubernetes

Manifests for the API are in [deploy/kubernetes/](deploy/kubernetes/) (a base, a test-only overlay with its own PostgreSQL and Redis, and `upgrade.sh`). PostgreSQL is not part of the base; use a managed database or an operator. Rehearse upgrades, rollbacks, migration failures, pod disruption, network policy, autoscaling, and database recovery on the cluster and workload you will operate before relying on this procedure.

## Running it as a service: plans, quotas, offboarding

Every workspace has a **plan**. New workspaces get `DEFAULT_PLAN`; the operator moves a workspace between plans. A self-hosted organisation keeps the default `enterprise` plan, which has no limits. The limits are in [api/src/plans.mjs](api/src/plans.mjs) (`—` = unlimited):

| Limit | free | team | business | enterprise |
|---|---|---|---|---|
| Members (including pending invitations) | 3 | 15 | 100 | — |
| Gateways (not revoked) | 1 | 5 | 50 | — |
| API keys (active) | 2 | 10 | 50 | — |
| SCIM provisioning tokens (not revoked) | 0 | 0 | 2 | — |
| Webhooks | 1 | 5 | 25 | — |
| Queued jobs | 50 | 500 | 5,000 | — |
| Jobs created per UTC month | 500 | 10,000 | 200,000 | — |
| Reports per UTC month (uploads and jobs finished by a gateway) | 100 | 2,000 | 50,000 | — |
| Requests per minute, whole workspace | 120 | 600 | 3,000 | — |

- Creating something over a limit answers `403 plan_limit_reached` with `details: { resource, plan, limit }`; a full queue answers `429 queue_full`; the workspace request budget answers `429 rate_limited`. The check and the insert share a workspace lock to prevent concurrent requests from overshooting a limit; validate this behavior under your expected concurrency.
- Moving a workspace to a smaller plan removes nothing: existing gateways, keys and members stay, and new ones are refused until usage is under the new limit.
- `GET /v1/workspaces/{id}/usage` (any member) and the console's **Usage** tab show the plan, limits and current usage. Monthly counters reset at the start of each UTC month.
- `MAX_WORKSPACES_PER_USER` caps how many live workspaces one person can have created (`403 workspace_limit_reached`).

**Operator commands.** Run them where the API's environment is (they use `DATABASE_URL`). Output is JSON; every change is written to the workspace's audit trail with the operator's OS user name as the actor.

```sh
docker compose exec api node src/admin-cli.mjs plan show <workspaceId>
docker compose exec api node src/admin-cli.mjs plan set <workspaceId> team
docker compose exec api node src/admin-cli.mjs workspace list [--deleted]
docker compose exec api node src/admin-cli.mjs workspace restore <workspaceId>
```

**Billing is not included.** Plans are changed by the operator; there is no payment provider, invoice or trial logic. Connect your billing system by having it call `plan set` (or write the `workspaces.plan` column and the audit event the same way) when a subscription changes.

**Abuse controls.** Anyone your identity provider lets sign in can create workspaces, so set sign-up controls at the IdP, run with `DEFAULT_PLAN=free` and set `MAX_WORKSPACES_PER_USER`. The one message the server sends to an address chosen by a tenant is the invitation email; it is bounded by the plan's member limit (pending invitations count) times the per-user workspace cap, and each message is a fixed plain-text template whose only tenant-chosen text is the workspace name. Watch `wirepulse_rate_limited_total` and `wirepulse_outbox_messages_total{kind="email"}`.

### Offboarding and restore

An administrator (a person, not an API key) deletes a workspace with `DELETE /v1/workspaces/{id}?confirm=<exact workspace name>`, or from the console's Usage tab. Immediately:

- the workspace answers `403` on every route, like a non-member; queued, assigned and running jobs are cancelled, its API keys, gateways and invitations are revoked, its webhooks are disabled and pending outbox messages are marked failed;
- the content is kept for `WORKSPACE_PURGE_GRACE_DAYS` (default 30), and the person's workspace cap is freed.

Within the grace period the operator can undo it with `workspace restore <id>`. The workspace returns **without** its API keys, gateways and invitations (they were revoked; create new ones) and with its webhooks disabled (re-enable them). After the grace period the purge worker deletes the content in slices of at most 1,000 rows per table, on any replica; a restore racing the deadline ends in exactly one state, whole or gone. Restore after the deadline is refused even if the purge has not started.

Export what you need **before** deleting: after deletion the API refuses the workspace's routes, including audit export, and an operator can read the rest only from the database. The workspace row stays behind as a tombstone together with its **audit trail**, which is append-only evidence and is not deleted by the purge. It contains actor ids, client IP addresses, request ids and event details such as names and invited email addresses, but not job results, profiles or serial data. Set `RETENTION_DAYS_AUDIT` to match your privacy policy; there is no per-person erasure of audit rows, so decide with your data-protection owner how to answer an erasure request.

### Database-level tenant isolation (row-level security)

Every query a request handler runs already filters by workspace, and tests check that. Migration `008_row_level_security.sql` adds a second barrier inside PostgreSQL, so that a handler which forgets its `WHERE workspace_id = …` still cannot read or change another tenant's rows.

- **How.** The migration creates the role `wirepulse_app` (`NOLOGIN`, not a superuser, no `BYPASSRLS`) and a policy `workspace_isolation` on all 19 tables that hold workspace data (`workspaces` by `id`, the others by `workspace_id`). Each statement of a request runs in a transaction that begins `SET LOCAL ROLE wirepulse_app` with `app.workspace_id` set to the workspace the caller was authorised for; both settings are transaction-local, so a pooled connection never carries a workspace into the next request, and outside a workspace the policies match nothing (fail closed). Reads, updates and deletes of another workspace's rows see or change zero rows, and inserting or moving a row into another workspace is refused with `42501`.
- **What runs unrestricted.** Looking up whose token a request carries (user, API key, gateway, SCIM) happens before the workspace is known, so it runs as the connecting role, as do the background workers (lease sweeper, outbox, retention, purge, anchoring), metrics, migrations, and the few routes that are across workspaces by nature (create and list workspaces, list and accept invitations). A test (`api/test/rls.test.mjs`) pins the list of source files that may use the unrestricted path, so adding one is a visible decision.
- **The start-up check.** The API exits with status 1 and a readable message if: the role is missing, a superuser or `BYPASSRLS`; a table that holds `workspace_id` has row-level security off; the connecting role neither owns the tables nor bypasses row-level security (the policies would then filter the API's own lookups); or it cannot become `wirepulse_app`.
- **What you must arrange.** The migrating user needs `CREATEROLE` (or be a superuser), or you create the role first (`CREATE ROLE wirepulse_app NOLOGIN;`) and `GRANT wirepulse_app TO <the user the API connects as>;`. On PostgreSQL 16 and later a role created by a non-superuser belongs to its creator with the ADMIN option only, which does not allow `SET ROLE`; migration `009_app_role_set_option.sql` grants that missing option, so a `CREATEROLE` user (the usual arrangement on a managed service) works. The API must connect as the user that ran the migrations, because it owns the tables (the policies are `ENABLE`d, not `FORCE`d, on purpose). Roles belong to the PostgreSQL server, not to a database: two WirePulse databases on one server share `wirepulse_app`. If a managed service forbids all this, set `DB_ROW_LEVEL_SECURITY=false`; the API then logs a warning and only its own checks separate tenants.
- **What it does not do.** It protects against mistakes in handlers. Anyone who can run arbitrary SQL as the application (SQL injection, a compromised process) can `RESET ROLE`; the connecting role and any superuser are not filtered. It does not replace the application's own checks or separate databases for tenants who need them.
- **Cost.** Each protected query runs in a short transaction that sets the restricted role and workspace locally. Measure its cost, connection-pool behavior, and error handling for your workload before setting capacity targets.
- **Validation.** `api/test/rls.test.mjs` directly exercises the workspace policies, transaction-local settings, start-up checks, and the `DB_ROW_LEVEL_SECURITY=false` fallback. Run the full suite against the exact PostgreSQL and pooler configuration you intend to operate; managed PostgreSQL services and other PostgreSQL versions need their own validation.

## Provisioning people and directory groups: SCIM 2.0

With SCIM, your identity provider (IdP) creates, updates and, above all, **removes** people in a workspace, so a leaver loses access when the IdP deactivates them instead of whenever somebody remembers. It can also keep directory Groups in sync. Sign-in itself stays OIDC; SCIM Users decide who is a member and with which role, while Groups are descriptive metadata only. It is available on plans with a SCIM-token allowance (`business`: 2, `enterprise`: unlimited; `free` and `team`: none, which answers `403 plan_limit_reached`).

**Set up (per workspace, by an administrator)**

1. Console → **Provisioning** → **Create token** (or `POST /v1/workspaces/{id}/scim/tokens` with `{ "name": "okta-production", "expiresInDays": 180 }`). The `wps_…` token is shown once. Its lifetime is at most `SCIM_TOKEN_MAX_DAYS` (default 365; the default when none is given is 365 or that cap, whichever is smaller).
2. In the IdP, create a SCIM 2.0 application with the **SCIM base URL** `https://<your api host>/scim/v2`, bearer-token (header) authentication with that token, and `userName` as the unique identifier. Turn on create, update and deactivate pushes. Menu names differ by IdP and version; follow its SCIM documentation. These steps were written from the SCIM standard (RFC 7643/7644), **not** exercised against a real Okta or Microsoft Entra ID tenant.
3. Map the IdP's role to the SCIM `roles` attribute with exactly one of `viewer`, `engineer`, `maintainer`, `administrator`. A person sent without a role is a `viewer`; an unknown role value is refused (`400 invalidValue`) rather than guessed.
4. Rotate before expiry: create a second token, give it to the IdP, then revoke the old one. **An expired token is refused, so the IdP can no longer remove leavers** (the console flags a token `expiring` 14 days ahead and `expired` after, and the Provisioning tab says when no token is usable). To be told without opening the console, alert on `wirepulse_scim_token_seconds_to_expiry` (the soonest expiry among tokens that are not revoked, `+Inf` when there are none; negative means a token has lapsed and was never revoked, so revoke it once it is replaced) and on `wirepulse_auth_failures_total{kind="scim"}`, which rises when an IdP keeps using a dead token; see [Operations](#operations).

**What it does**

- Endpoints under `/scim/v2`: `ServiceProviderConfig`, `ResourceTypes` and `Schemas` (each listed or fetched by id; read-only, any other method answers `405` with `Allow: GET`), and `Users` (list with `filter` on `userName`, `externalId`, `id` or `emails.value` using `eq`, up to 200 per page; `attributes` and `excludedAttributes` on reads; get; create; replace; patch with `add`/`replace`/`remove`, including the shapes Okta and Entra send; delete), plus `POST /Users/.search` and `POST /.search`, the same list with its parameters in a body. Responses use `application/scim+json` and SCIM error bodies. Unknown attributes are ignored.
- **Where WirePulse departs from the SCIM schema, on purpose.** A person has one email (always `type: work`, `primary: true`) and one role (always `primary: true`), because a workspace membership has exactly one of each. Removing `roles` resets the person to `viewer` instead of leaving them without a role, and `active` cannot be removed (it is required; set it to `false` to deactivate). A client that checks the server's answer against exactly what it sent will notice these four; Okta and Entra ID do not.
- **Groups:** `Groups` supports list, read, create, replace, patch, delete and `POST /Groups/.search`, with filters on `displayName`, `externalId` and `id`. Groups are IdP-managed, workspace-scoped directory metadata. Every member must already be a provisioned User in that workspace; membership never grants workspace access or changes a role. Use the User `roles` attribute for roles, not Groups.
- **Not supported:** Bulk, sorting, ETags and password change.
- **Provisioning is not membership.** A created person is *pending*: they become a member when they sign in with a **verified** email equal to the record's email (checked on their first request to that workspace and when they list their workspaces). The record binds to one sign-in subject; a second account with the same address, an unverified address, or an API key never binds. Pending people count against the plan's member limit like invitations do. Someone who is already a member is adopted by email and **keeps their role** unless the IdP sends one.
- **Deactivation and deletion remove access immediately:** the membership (matched by the bound subject or the same email) is deleted in one transaction, and any live job stream they hold open is closed on every replica (PostgreSQL `LISTEN`/`NOTIFY`). Setting `active` back to `true` re-grants the membership, subject to the seat limit. The **last administrator cannot be removed or demoted** through SCIM (`409`); appoint another first.
- **Concurrency:** two requests creating the same person yield one `201` and `409 uniqueness` for the rest; concurrent first requests from a newly provisioned person succeed.
- **Audit:** `scim.user_provisioned`, `scim.user_updated`, `scim.user_deactivated`, `scim.user_reactivated`, `scim.user_deleted`, `scim.member_bound`, `scim_token.created`, `scim_token.revoked`; SCIM calls are attributed to `scim:<token id>`. Deleting a workspace revokes its SCIM tokens and the purge removes the records.

**What it does not do**

- **API keys follow their creator.** Deactivating or deleting a person (and removing a member in the console) revokes the keys *they created*, in the same transaction, and lists their ids in the audit event (`apiKeysRevoked`). Re-activating them does not bring those keys back. Consequences: a CI key made by someone who then leaves stops working, so create CI keys from a long-standing administrator; a key created by somebody else, or for them by an administrator, is not touched; and a person who is only *demoted* keeps the keys they made until they expire or are revoked (Console → API keys). Keep key lifetimes short.
- Removing someone does not stop a job they already queued, and it cannot recall a copy of data they already downloaded.
- Live streams close promptly only while the PostgreSQL notification channel works; a stream that missed the notification ends at its maximum lifetime (`SSE_MAX_LIFETIME_SECONDS`, default 30 minutes), and a new request is refused at once either way because membership is checked on every request.
- Role changes made in the console for a provisioned person are overwritten the next time the IdP sends a role.

## Integrations: webhooks and invitation email

Both leave through a durable **outbox** table written in the same transaction as the change that caused them, so a message exists exactly when the change committed. A worker on every replica delivers due rows (`FOR UPDATE SKIP LOCKED` plus a lease). Delivery is **at-least-once**: a receiver must tolerate the same event twice. Due rows are taken in turns across workspaces (every workspace's oldest row before any workspace's second), so a workspace with a large backlog or a dead endpoint does not make the others wait behind it; alone, it still gets the whole batch of 20. The fair claim ranks every due row; measure it against your expected due-row volume and database capacity. A hung endpoint can still hold up the batch it is in for up to `WEBHOOK_TIMEOUT_MS`, because a batch finishes when its slowest delivery does.

### Webhooks

Set `WEBHOOK_SIGNING_KEY` (≥ 32 characters; use `WEBHOOK_SIGNING_KEY_FILE` for a secret) to turn the routes on; without it they answer `501 webhooks_not_configured`. An administrator adds an endpoint under **Webhooks** in the console (or `POST /v1/workspaces/{id}/webhooks`). The `whsec_…` secret is shown once, at creation and at rotation; it is derived from the signing key and the webhook id and is not stored. Events: `job.finished` (any final status, including `timed_out`) and `webhook.ping` (the "Send test" button). Nothing else is sent.

The request is a `POST` with `Content-Type: application/json`, a body like `{"id":"<delivery id>","type":"job.finished","createdAt":"…","workspaceId":"…","data":{…the job, as GET …/test-jobs/{id} without the definition…}}` and these headers:

| Header | Meaning |
|---|---|
| `X-WirePulse-Event` | event type |
| `X-WirePulse-Delivery` | delivery id: stable across retries and redelivery; deduplicate on it |
| `X-WirePulse-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" keyed with the secret>` |

A receiver must verify the signature over the **raw** body in constant time and reject timestamps older than about 5 minutes. Reference implementation (Node):

```js
import crypto from "node:crypto";
export function verify(secret, header, rawBody, toleranceSeconds = 300) {
  const parts = Object.fromEntries(String(header).split(",").map((p) => p.trim().split("=")));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
```

- **Success** is any 2xx within `WEBHOOK_TIMEOUT_MS`; redirects are not followed and the response body is never read or stored.
- **Retries** after a failure wait about 10 s, 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, then 4 h (±20 %), up to `OUTBOX_MAX_ATTEMPTS` (default 8, so about 3 h 40 min in all; the 4 h step and the 6 h cap only matter if you raise it). The body is byte-identical on every attempt; only the timestamp and signature change. A delivery that ends `failed` can be redelivered from the console or `POST …/deliveries/{deliveryId}/redeliver`, with the same delivery id.
- **Rotation.** "Rotate secret" invalidates the old secret at once for messages not yet sent, and there is no overlap window: update the receiver first or accept a few failed deliveries and redeliver them. Changing `WEBHOOK_SIGNING_KEY` rotates every secret at once.
- **SSRF policy.** The destination is resolved once and the connection goes to exactly that vetted address (no DNS-rebinding gap); TLS certificates are always verified. Link-local, cloud-metadata, multicast and reserved addresses can never be reached. Private ranges (RFC 1918, loopback, CGNAT, ULA…) are refused unless inside `WEBHOOK_ALLOWED_CIDRS`; plain `http://` is accepted only for such an allow-listed address. A refused destination is a permanent failure and is shown to tenants only as `destination_blocked`.
- The stored failure reason is deliberately coarse (`timeout`, `dns_failed`, `tls_error`, `connection_failed`, `request_failed`, a status code) so a tenant cannot map the network behind an allow-listed range.
- **Not built:** automatic disabling of a failing endpoint, dual-secret rotation, a ping rate limit, and event types beyond the two above. Receivers that are down for longer than the retry window need a redelivery.

### Invitation email

With `SMTP_URL` and `SMTP_FROM` set, creating an invitation also queues one plain-text email through the outbox (fixed template, the operator's `INVITE_BASE_URL` as the only link). Without SMTP nothing is sent and the administrator must tell the invitee; the API response does not say whether mail was queued, and the console words this neutrally. `smtp://` must negotiate STARTTLS or the message is not sent (there is no silent downgrade); certificates are verified. The message body is removed from the outbox once the attempt is final. A relay that rejects the recipient (a 55x reply) is a permanent failure; temporary failures retry on the schedule above. Validate the behavior with the SMTP service you operate.

### Proxies, private CAs and TLS verification

Outgoing webhook and SMTP connections verify certificates explicitly, even if the container's environment sets `NODE_TLS_REJECT_UNAUTHORIZED=0` (a test proves this). Do not set that variable anyway. If your receivers or relay use a private CA, add it with `NODE_EXTRA_CA_CERTS=/path/ca.pem` (mount the file read-only into the container); this is separate from `DB_SSL_CA_FILE`, which applies to PostgreSQL only. The same applies to an identity provider whose certificate comes from a private CA: the API fetches `<issuer>/.well-known/openid-configuration` and the signing keys over https and if it cannot verify that certificate it refuses every request with 401 (it fails closed). `docker-compose.yml` does not pass this variable through, so add it in a `docker-compose.override.yml` next to it (Compose reads that file automatically and merges it):

```yaml
services:
  api:
    volumes: ["./private-ca.pem:/etc/ssl/private-ca.pem:ro"]
    environment:
      NODE_EXTRA_CA_CERTS: /etc/ssl/private-ca.pem
    # extra_hosts: ["idp.internal.example:10.0.0.5"]    # only if the identity provider's name is not in DNS for the container
```

A provider with a publicly trusted certificate needs none of this. Webhook and SMTP connections do not use an outbound HTTP proxy.

## Operations

### Monitoring

`/metrics` is Prometheus text. Beyond default process metrics: `wirepulse_http_request_duration_seconds`, `wirepulse_jobs{status}`, `wirepulse_oldest_queued_job_age_seconds`, `wirepulse_gateways_online`, `wirepulse_sse_clients`, `wirepulse_listener_connected`, `wirepulse_db_pool_connections`, `wirepulse_rate_limited_total{limiter}`, `wirepulse_rate_limit_store_errors_total`, `wirepulse_auth_failures_total`, `wirepulse_outbox_messages_total{kind,result}`, `wirepulse_webhook_deliveries_total{result}`, `wirepulse_audit_anchors_total{result}`, `wirepulse_workspaces_purged_total`, `wirepulse_retention_deleted_total`, `wirepulse_scim_token_seconds_to_expiry`. Suggested alerts:

- `/readyz` failing for more than 1 minute
- `wirepulse_listener_connected == 0` (live updates fall back to polling)
- `wirepulse_oldest_queued_job_age_seconds` above your queue SLO while `wirepulse_gateways_online == 0`
- 5xx ratio or p95 latency above target
- sustained `429`s or `auth_failure` log lines: probing, or a misconfigured client. Only failed authentications count toward `AUTH_FAILURE_LIMIT_PER_MINUTE`. Once an IP is over the limit, requests are refused until the minute window passes, except those carrying a credential some replica verified in the last 5 minutes (shared through Redis when `REDIS_URL` is set, otherwise only the replica that verified it knows; the credential is still checked in full); behind a shared NAT, a person no replica has seen recently is locked out along with the broken client for up to a minute, and the exemption is best effort (fix the client, or raise the limit)
- `increase(wirepulse_audit_anchors_total{result="mismatch"}[1h]) > 0` or the log event `audit.anchor_mismatch`: see [Audit log](#audit-log); treat as a security incident until explained
- `increase(wirepulse_rate_limit_store_errors_total[5m]) > 0` for longer than a few minutes (Redis down: limits are per replica meanwhile)
- `wirepulse_scim_token_seconds_to_expiry < 14 * 86400`: a SCIM token is within two weeks of lapsing (or has lapsed), and an IdP with a dead token cannot deactivate leavers. Rotate it; the alert does not clear until the old token is revoked
- `wirepulse_outbox_messages_total{result="failed"}` growing: webhook receivers or the SMTP relay are failing

### Backup and restore

Back up the database; it holds everything. Keep the secrets directory separately, and keep `WEBHOOK_SIGNING_KEY` with it: webhook secrets are derived from that key and are not stored, so a restore under a different key silently changes every webhook secret and receivers start rejecting deliveries. Dumps contain audit data (actor ids, IP addresses, invited email addresses), the hashes of gateway tokens and API keys, and pending outbox messages: encrypt them and restrict access.

```sh
docker compose exec -T postgres pg_dump -U wirepulse -d wirepulse --format=custom --no-owner > wirepulse-$(date +%F).dump
```

Rehearse a restore into a scratch database and check it through a second API instance before you need it:

```sh
docker compose exec -T postgres createdb -U wirepulse wirepulse_restore
docker compose exec -T postgres pg_restore -U wirepulse -d wirepulse_restore --no-owner --exit-on-error < wirepulse-2026-10-27.dump
# start an API against wirepulse_restore (same DATABASE_URL with the database name changed, MIGRATE_ON_START=false)
# then, as an administrator: GET /v1/workspaces/<id>/audit/verify → valid: true, same headHash as production
```

For disaster recovery, stop the API, restore into an empty database, and start the stack. Dump-based backups lose everything since the last dump; for a tighter recovery point use PostgreSQL WAL archiving or your provider's point-in-time recovery, which this repository does not configure. Rehearse this exact sequence for every deployment.

### PostgreSQL failover

`scripts/failover-drill.sh` is a throwaway-container exercise for a primary, streaming replica, PgBouncer, and an API instance. It is a starting point, not evidence for your environment. For manual promotion, first confirm the replica has caught up as far as your recovery policy requires, promote it, repoint the pooler or `DATABASE_URL`, and rebuild the former primary as a standby of the new primary:

```sh
psql -h replica -U wirepulse -d wirepulse -tAc "SELECT pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()"
psql -h replica -U wirepulse -d wirepulse -tAc "SELECT pg_promote(true, 60)"
# Reload the pooler or update DATABASE_URL to point to the promoted replica.
pg_basebackup -h pg-replica -U replicator -D "$PGDATA" -R -X stream --checkpoint=fast
```

Asynchronous replication can lose transactions that the former primary acknowledged but had not replicated. Synchronous replication changes that trade-off by blocking writes when a required standby is unavailable. Your promotion mechanism must fence the former primary before it can accept writes again; otherwise a split brain can corrupt data. Test detection, promotion, fencing, client retry, live-update recovery, data-loss bounds, and failback with the hosts, storage, network and managed services you actually operate.

#### Orchestrated failover (Patroni)

[deploy/patroni/](deploy/patroni/) and `scripts/patroni-drill.sh` provide an example of Patroni with etcd and HAProxy. It does not establish a recovery-time target or validate your topology. Choose and validate the consensus, replication, health-check, fencing, and recovery settings for your environment, including real network partitions and loss of quorum.

### Audit log

Audit rows form a SHA-256 hash chain per workspace and the table is append-only (enforced by a database trigger). `GET …/audit/verify` recomputes the chain; `GET …/audit-events/export.ndjson` exports it. A database superuser could rewrite the tail of a chain and re-chain it, and only a copy of the head kept outside the database would reveal that.

**Anchoring.** Set `AUDIT_ANCHOR_INTERVAL_MINUTES` (for example `15`; the first run is 30 s after start). Then, for every workspace and on one replica at a time, the server checks that the audit row the previous anchor points at still exists with the same hash, recomputes the chain from that anchor onward, and records the new head as the next anchor. Each new anchor is also written to the log (`event: "audit.anchor"`, `workspaceId`, `seq`, `headHash`). **Ship those log lines to a system the database administrators cannot edit** (your SIEM or a write-once bucket): that copy is the independent evidence. The `audit_anchors` table is in the same database, so by itself it only detects accidental damage and an attacker who forgets to fix it.

A problem is logged at `error` level every cycle as `event: "audit.anchor_mismatch"` (`security: true`) with a `reason`, counted in `wirepulse_audit_anchors_total{result="mismatch"}`, and the anchor is **not** advanced, so it cannot go quiet by itself:

| `reason` | Meaning |
|---|---|
| `row_missing` | the audited row at the anchored position is gone |
| `hash_changed` | the row is there with different content |
| `chain_broken` | a row after the anchor does not follow from the one before (`firstBadSeq` says where) |

Rows removed by `RETENTION_DAYS_AUDIT` are not a mismatch; an anchor older than the retention window is dropped with them.

**Runbook for a mismatch.** (1) Do not delete anything yet. (2) Compare with your shipped log: find the last `audit.anchor` line for that workspace and compare its `headHash` with the `row_hash` of the event whose `chain_seq` equals its `seq` in `GET …/audit-events/export.ndjson`. (3) If someone edited history, preserve the database and the log and follow your incident process. (4) If there is an innocent explanation (for example you restored an older backup into this database, so rows after the backup point are legitimately gone), re-baseline that one workspace by deleting its anchors: `DELETE FROM audit_anchors WHERE workspace_id = '<workspace id>';`. The next cycle anchors the current head. This silences the alarm, so write down why in your change record first.

Known limits: the anchor check starts at the previous anchor and does not re-read older history each cycle (use `GET …/audit/verify` for a full recompute), and a workspace whose chain is very long is verified in batches over several cycles.

## Readiness and known limits

This public source edition is awaiting its own final validation. Do not treat test results from a different source edition, deployment, or environment as evidence for this one. Run the repository checks, inspect the resulting artifacts, and record the exact pass/fail/skip results for the commit you deploy.

Before production use, validate all of the following in an environment representative of your operation:

- **Real serial hardware.** Automated coverage uses simulated ports and pseudo-terminals, not USB/UART adapters, device drivers, baud clocks, wiring, resets, reconnects, or sustained device traffic.
- **Identity and provisioning.** The repository exercises OIDC and SCIM protocol behavior, but you must validate your identity provider, browser sign-in configuration, SCIM User and Group synchronization, role mapping, and verified-email claims. Group membership is directory metadata only and must never grant workspace access or alter a role.
- **Operations and capacity.** Run load, backup/restore, database-failover, rolling-update, and disaster-recovery exercises for your infrastructure and workload. Job execution is at-least-once after a gateway or network failure; job definitions must tolerate a retry.
- **Security assessment.** Automated checks and static scans are not a penetration test or compliance certification. Commission an independent assessment before external exposure and validate remediation in your own environment.
- **External integrations.** Validate SMTP, public webhook receivers, your TLS termination, managed database or pooler, Redis behavior, and all monitoring and alerting paths you use.
- **Legal and commercial readiness.** The proprietary [LICENSE](LICENSE) governs this source edition. It has no included runtime licence enforcement, billing system, compliance certification, support commitment, or service-level agreement.

### Deliberately not built

- Native SAML sign-in. Use a tested OIDC bridge for SAML-only identity providers.
- SCIM Bulk, sorting, ETags, and password changes. SCIM Users and Groups are supported; Groups remain directory metadata only, never an authorization mechanism.
- Billing and payments.
- Multi-region deployment or customer-managed-key storage.
