# Security questionnaire: prepared answers

For the security and procurement team reviewing WirePulse. Each answer says what the public source implements, with a status:

- **Yes**: the capability is present in the public source; validate it from the exact revision and deployment you operate.
- **Partly**: the capability has a stated limit or depends on deployment validation.
- **You**: your deployment decides it (infrastructure, identity provider, policy).
- **No**: not provided.

The product is software you host. Nothing here describes a vendor-operated service, and nothing here is a certification. The public source edition must be validated from its exact commit; record the results of the repository checks and your deployment exercises. See [DEPLOYMENT.md](../DEPLOYMENT.md#readiness-and-known-limits), [SECURITY.md](../SECURITY.md) and [THREAT-MODEL.md](THREAT-MODEL.md).

## Hosting and data

| Question | Answer | Status |
|---|---|---|
| Where is data stored? | In the PostgreSQL database you run. Nothing is sent to the vendor. Redis, if used, holds rate-limit counters only. | Yes |
| What personal data is stored? | Identity-provider subject ids; member and invited email addresses; display names for SCIM-provisioned people; IP addresses and actor ids in the audit log. | Yes |
| Is device (serial) data uploaded? | No. Serial bytes stay in the browser or on the lab machine. The server receives test definitions, pass/fail results and hash-linked evidence (fingerprints and timings, no raw text). Validate this boundary against your use cases and integrations. | Yes |
| Data residency? | Wherever you deploy it. | You |
| Encryption in transit? | The API speaks plain HTTP to its proxy; TLS is terminated by your reverse proxy or load balancer. The database connection supports verified TLS (`DB_SSL=verify`, `DB_SSL_CA_FILE`). SMTP requires STARTTLS or TLS; webhooks and the identity provider are reached over https with certificate verification. | Partly (TLS in front of the API is yours) |
| Encryption at rest? | Not done by the application. Use an encrypted volume or managed-database encryption, and encrypt backups. | You |
| Retention and deletion? | Retention periods for jobs, reports and audit are configurable (default: keep). Workspace offboarding soft-deletes, then a purge worker removes the data after a grace period (default 30 days); each purge is audited. | Yes |
| Backups? | A procedure is documented ([DR and service objectives](DR-AND-SLO.md)). Scheduling, storage, and restore rehearsal are yours. | Partly |
| Customer data export? | JUnit XML of results; NDJSON export of the audit log; the database is yours. | Yes |

## Access control

| Question | Answer | Status |
|---|---|---|
| Authentication? | OpenID Connect against your provider (browser sign-in uses the authorization code flow with PKCE as a public client; pasting a token also works); the API validates signatures, issuer, audience and expiry, and refuses unsigned tokens. Machine access uses separate token types (API key, gateway, SCIM). | Yes |
| MFA? | Enforced by your identity provider. | You |
| SSO providers tested? | The repository includes Keycloak and token-shape coverage for Okta, Entra ID and Auth0. It does not establish interoperability with a live Okta, Entra ID, Auth0 or Google Workspace tenant. Check the audience and `email_verified` claims your tenant issues with `node src/check-token.mjs` (see [PILOT-GUIDE.md](PILOT-GUIDE.md)). Google is not a direct option: it needs a broker in front (PILOT-GUIDE, section 1). | Partly |
| SAML? | Not supported directly (no hand-written XML-signature code). A SAML 2.0 provider can work through an OIDC bridge. Validate that bridge and its browser flow with the provider you operate. | Via bridge |
| Role-based access? | Four roles per workspace (viewer, engineer, maintainer, administrator). Workspace isolation is enforced in application code and behind it by PostgreSQL row-level security (request handlers run as a role the database confines to the caller's workspace). RLS protects against missing-filter mistakes in handlers, not against SQL injection or a compromised API process. | Yes |
| Automated provisioning and deprovisioning? | SCIM 2.0 Users and Groups. The repository includes protocol, integration, and route-contract coverage. A Group is workspace-scoped directory metadata, may reference only existing provisioned Users in that workspace, and never grants access or changes a role. Validate against your live SCIM provider (the procedure is [PILOT-GUIDE.md](PILOT-GUIDE.md)). | Partly |
| Service credentials? | Gateway, API and SCIM tokens are random, shown once, stored as hashes, rotatable; API and SCIM tokens always expire. | Yes |
| Session handling? | The API is stateless; it accepts bearer tokens. The console keeps the token in memory only. Token lifetime is set at your identity provider. | Yes |
| Password policy? | There are no WirePulse passwords. | Yes |
| Privileged access to the system itself? | Anyone with database or host access can read all data. Restrict and audit it. | You |

## Logging and monitoring

| Question | Answer | Status |
|---|---|---|
| Audit trail? | Administrative actions are written to an append-only, hash-chained audit log per workspace; verification and NDJSON export are in the API. Optional anchoring writes the chain head to the application log at an interval, for shipping to a system the database administrators cannot edit. | Yes |
| Application logs? | JSON logs with request identifiers; authorization headers and token fields are redacted. Shipping and retention are yours. | Yes |
| Metrics and alerts? | Prometheus `/metrics` behind a token; suggested alerts are listed in the deployment guide. | Yes |
| SIEM integration? | Via your log shipper; no native connector. | Partly |

## Application security

| Question | Answer | Status |
|---|---|---|
| Secure development practice? | The repository includes API, gateway, browser, accessibility, protocol, and security-focused test suites, a written threat model, and continuous-integration workflows. Run and retain the exact results for the revision you deploy. No formal secure-SDLC certification. | Partly |
| Automated vulnerability scanning? | The workflows provide OWASP ZAP, Trivy, `npm audit`, and CycloneDX SBOM generation paths. Run them against the exact source and artifacts you deploy; any result is point-in-time and does not replace a penetration test. | Partly |
| Third-party penetration test? | None. Commission one before external exposure; [PENTEST-BRIEF.md](PENTEST-BRIEF.md) is the scope and hand-over document for the testers. | No |
| Dependency management? | Lockfiles for the API, gateway and console; runtime dependencies are few. Re-scan in your CI. | Yes |
| Input validation and injection? | Strict request schemas; values reach SQL only as bound parameters; malformed identifiers and control characters return 400. | Yes |
| Rate limiting and abuse controls? | Per user, per IP, per gateway and failed-authentication limits, shared across replicas with Redis; request-size, queue and stream caps; plan quotas. | Yes |
| SSRF and outbound calls? | Webhook destinations are checked against a deny-list at connection time; link-local and metadata addresses are never reachable. | Yes |
| Secrets management? | Every setting can come from a file (Docker/Kubernetes secrets). Nothing secret is in the image or repository. | Yes |
| Container hardening? | Non-root user, read-only filesystem, all capabilities dropped, no new privileges, minimal runtime image. | Yes |
| Is the code protected against copying and tampering in delivery? | This public source edition is governed by the proprietary [LICENSE](../LICENSE). It does not include runtime copy-protection, signing, or tamper-detection tooling; apply your normal repository, build, registry, and deployment controls. | No |
| Software bill of materials? | `scripts/sbom.sh` generates CycloneDX SBOMs. Generate and archive them with the exact release artifacts you operate. | Partly |

## Resilience and operations

| Question | Answer | Status |
|---|---|---|
| High availability? | You can run several API replicas behind a load balancer, with Redis for shared rate limits, and use a PostgreSQL pooler or failover solution you operate. The repository includes Compose, Kubernetes, PgBouncer, and Patroni examples; validate their behavior, including stalled replicas, live updates, failure recovery, and retry behavior, on your infrastructure. | Partly |
| RPO / RTO? | Depends on your backup method and database size; see [DR and service objectives](DR-AND-SLO.md). No figure is promised. | You |
| Disaster recovery tested? | The repository documents backup, restore, audit verification, and failover procedures. Rehearse them against the environment you operate, including any cross-site recovery requirement. | Partly |
| Incident response? | The product provides a runbook for audit-anchor mismatches. A general incident process is yours. | You |
| Vulnerability disclosure? | See [SECURITY.md](../SECURITY.md). | Yes |
| Change and upgrade process? | Versioned source, migrations that run in a one-shot service before the new API starts, an acceptance script, and Kubernetes upgrade guidance are included. Validate upgrades and rollback with the schema ahead before production. | Partly |

## Compliance

| Question | Answer | Status |
|---|---|---|
| SOC 2, ISO 27001, PCI, HIPAA? | None. Self-hosting means your own controls apply; the product provides audit, access control and retention features that support them. | No |
| Sub-processors? | None: the vendor operates no service. Optional integrations you configure (SMTP relay, webhook receivers, identity provider) are yours. | Yes |
| GDPR data-subject requests? | Personal data is limited to the fields listed above, in one database you control. Removal of a person: deactivate through SCIM or remove the membership; audit entries are append-only by design and keep the actor identifier. Decide with your privacy officer whether that fits your policy. | Partly |
| Licence and warranty? | Set by your agreement. The repository carries a proprietary [LICENSE](../LICENSE); it does not include runtime licence enforcement. | You |
