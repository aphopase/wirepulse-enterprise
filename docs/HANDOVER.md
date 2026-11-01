# Handover: from source repository to a verified installation

Read this first. It is the short path; [DEPLOYMENT.md](../DEPLOYMENT.md) is the reference.

## 1. Identify the source revision

```sh
git clone https://github.com/aphopase/wirepulse-application.git
cd wirepulse-application
git rev-parse HEAD                 # record the exact revision you assess or deploy
git status --short                 # must be empty before you build from it
```

The repository contains the control plane (`api/`), the gateway agent (`gateway/`), browser sources, tests, Compose and Kubernetes manifests, the OpenAPI definition (`docs/openapi.yaml`), and these documents. It contains no credentials or environment file. Generate any deployment artifacts, including an SBOM, from the exact recorded revision and retain them with your change record.

## 2. Decide before you install

| Decision | Why it matters |
|---|---|
| Which OpenID Connect provider issues the tokens, and its issuer URL and audience | The API accepts nothing else. Before deployment, validate a real access token using `node src/check-token.mjs` and complete the identity-provider pilot in [PILOT-GUIDE.md](PILOT-GUIDE.md). |
| The https address of the API and of the console | Set `CORS_ORIGINS` and the proxy. A private certificate authority needs the override in [Proxies, private CAs and TLS verification](../DEPLOYMENT.md#proxies-private-cas-and-tls-verification). |
| How many proxy hops sit in front of the API | `TRUST_PROXY`. Wrong values break rate limits and audit addresses. |
| Where backups go and how often | The database is the only state. See [DR and service objectives](DR-AND-SLO.md). |
| Which lab machine runs each gateway | One agent per serial device; outbound https only. |

## 3. Install and prove it

Follow [Deploy the control plane](../DEPLOYMENT.md#deploy-the-control-plane) steps 1 to 5, then step 6:

```sh
node scripts/acceptance.mjs --url https://api.example.com --token "$ADMIN_TOKEN" --metrics-token "$METRICS_TOKEN"
```

The command exits zero only when all of its checks pass. Keep its output with your change record. Then register a gateway ([Run a gateway agent](../DEPLOYMENT.md#run-a-gateway-agent)), queue a suite from the console against the real device, and confirm the job finishes with verified evidence.

## 4. Before real use

- [ ] Backups scheduled, and one restore rehearsed into a scratch database with `audit/verify` returning `valid: true`.
- [ ] Metrics scraped and the alerts in [Monitoring](../DEPLOYMENT.md#monitoring) created; logs shipped somewhere database administrators cannot edit; `AUDIT_ANCHOR_INTERVAL_MINUTES` set.
- [ ] A second administrator exists that is not managed by your identity provider.
- [ ] If you run several replicas: a load balancer that health-checks `/readyz` (the HAProxy example in `deploy/` does), and a failover of your PostgreSQL rehearsed on your own infrastructure. `scripts/failover-drill.sh` is a starting point for a throwaway exercise, not evidence for your environment. If a connection pooler sits in front of the database, read [Connection pooling](../DEPLOYMENT.md#connection-pooling-pgbouncer) first and validate live updates through that pooler.
- [ ] Your device matrix run on the real hardware you test: adapters, resets, reconnects, long outputs. Automated tests cannot replace this.
- [ ] If you provision people with SCIM: one test user created, changed and deactivated by your provider, and the membership disappearing confirmed. If you use Groups, create one, change its membership and remove a member; confirm every member is already a provisioned User in the workspace and that Group membership neither grants access nor changes a role.
- [ ] A penetration test by people before exposing the API outside your network. Give the testers [PENTEST-BRIEF.md](PENTEST-BRIEF.md) (scope, what to attack, known limits), `docs/openapi.yaml`, [SECURITY.md](../SECURITY.md), the [threat model](THREAT-MODEL.md) and a staging environment.

## 5. What was verified, and what was not

This public source edition must be validated from the commit you install. Run the API, gateway, browser, deployment, and supply-chain checks described in the repository, and keep their exact pass/fail/skip summaries with your change record. Do not rely on results from another source edition or environment.

Still validate with your own environment: identity provider, real USB/UART devices, a live SCIM client, mail provider, public webhook receivers, load and failover at your scale, independent penetration testing, and any compliance audit. The rationale is in [Readiness and known limits](../DEPLOYMENT.md#readiness-and-known-limits); prepared answers for security review are in [SECURITY-QUESTIONNAIRE.md](SECURITY-QUESTIONNAIRE.md).
