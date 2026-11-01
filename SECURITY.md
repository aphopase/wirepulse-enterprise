# Security

## Reporting a vulnerability

Report suspected vulnerabilities **privately through GitHub**: open the repository's **Security** tab, choose **Report a vulnerability**, and fill in the form (direct link: <https://github.com/aphopase/wirepulse-application/security/advisories/new>). The report is visible only to you and the maintainers. Please do not open a public issue, pull request or discussion for a vulnerability, and do not post details in chat.

Include the version (`package.json`), the affected endpoint or file, the steps to reproduce, and what you observed. Do not include real customer data or live credentials.

What to expect: an acknowledgement, a statement of whether the report is reproduced, and a fix or a documented mitigation, with credit if you want it. This project does not publish a response-time commitment; any time limits for a customer are set in that customer's written agreement.

Testing your own deployment is fine. Do not test anyone else's, and stop and report if you reach data that is not yours.

If you run WirePulse yourself and find a problem in your own deployment (for example an audit-anchor mismatch), the runbook is in [DEPLOYMENT.md](DEPLOYMENT.md#audit-log).

## Supported versions

Fixes go to the latest released version. Upgrade by rebuilding and running `docker compose up -d --build`; the one-shot `migrate` service runs before the new API starts. Take a backup first ([Backup and restore](DEPLOYMENT.md#backup-and-restore)).

## What the product does to protect you

- Authentication is delegated to your OpenID Connect provider (so your MFA and joiner/leaver policy apply). The API accepts only tokens signed by that provider's published keys for the configured issuer and audience, and refuses unsigned, tampered and wrong-audience tokens. If the provider cannot be reached or its certificate cannot be verified, requests are refused (401).
- Authorisation is by role per workspace (viewer, engineer, maintainer, administrator). A non-member, an unknown workspace and a too-low role get the same response, so workspace identifiers cannot be probed.
- Gateway tokens, API keys and SCIM tokens are random, shown once, stored only as hashes, always expiring (API keys, SCIM tokens) or revocable (gateways), and can be rotated. SCIM Groups are workspace-scoped directory metadata: every member must already be a provisioned User in that workspace, and membership never grants access or changes a role.
- Every administrative action is written to an append-only audit log that forms a SHA-256 hash chain per workspace; it can be verified and exported, and optionally anchored to your own log pipeline.
- Test results are tamper-evident: the server re-verifies the hash-linked evidence and decides the final status itself. Raw serial bytes never leave the lab machine or browser.
- The production configuration fails to start without OIDC and https origins, rejects the development token, and hides `/metrics` unless a token is set. Containers run as non-root with a read-only filesystem and no extra Linux capabilities.
- Outgoing webhooks are signed and cannot reach link-local, cloud-metadata or (by default) private addresses.

## What the product does not do

State these to your own security reviewers rather than discover them later.

- It does not encrypt data at rest. Use an encrypted volume or your managed database's encryption, and encrypt backups.
- It does not terminate TLS. Put a reverse proxy or load balancer with a valid certificate in front of it.
- Evidence proves that a result was not changed after it was recorded and that its chain is consistent. It does not prove that the physical test took place as described: a gateway machine whose token is stolen can submit a fabricated but internally consistent record. Protect gateway machines and tokens like any build agent.
- Workspace isolation is enforced by the application on every query and checked by tests. Since migration 008 PostgreSQL row-level security is a second barrier: request handlers run as a role the database confines to the caller's workspace, so a handler that forgets its workspace filter leaks nothing. It protects against mistakes in handlers, not against SQL injection or a compromised API process (which can switch role back), and a database administrator can still read every workspace. Details and limits: [DEPLOYMENT.md](DEPLOYMENT.md#database-level-tenant-isolation-row-level-security).
- There has been no third-party penetration test and no compliance audit (SOC 2, ISO 27001). Automated scans (OWASP ZAP, Trivy, `npm audit`) and tests are listed, with their limits, in [DEPLOYMENT.md](DEPLOYMENT.md#readiness-and-known-limits).
- The repository includes Keycloak coverage and token-shape checks for Okta, Entra ID and Auth0, but it does not establish interoperability with a live tenant of any of them or with Google Workspace. SCIM must also be validated with the live provider you operate. [docs/PILOT-GUIDE.md](docs/PILOT-GUIDE.md) is the procedure for that check; until it is complete, treat provider compatibility as unproven.
- It has not been run against real USB or UART devices; the tests use a simulated serial transport and a pseudo-terminal.

More: [threat model](docs/THREAT-MODEL.md), [disaster recovery and service objectives](docs/DR-AND-SLO.md), [security questionnaire answers](docs/SECURITY-QUESTIONNAIRE.md).
