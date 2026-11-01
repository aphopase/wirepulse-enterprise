# Threat model

Scope: the self-hosted control plane (API + PostgreSQL, optional Redis), the gateway agent, and the browser console. It lists what was considered, what stops each threat in this code, and what is left to you. It is a design document written by the people who built the system and has not been reviewed by an outside party.

## What is protected

| Asset | Why it matters |
|---|---|
| Test results and their evidence | They are used to decide whether hardware ships. A forged pass is the worst outcome. |
| Workspace data: profiles, suites, reports, job history | Describes your devices and test methods. |
| Identities, roles and IdP-managed Group membership | Roles decide who can queue jobs, run gateways, and change membership; Group membership is directory metadata and must never become an authorization input. |
| Tokens: gateway (`wpg_`), API key (`wpk_`), SCIM, metrics, webhook secrets | Bearer credentials; whoever holds one acts as its owner. |
| The audit log | The record of who did what; its value is that it cannot be quietly rewritten. |
| Serial data from the device | Often proprietary. By design it never reaches the server. |

## Parties and trust boundaries

```
 browser console ──https──► reverse proxy (yours) ──► API replicas ──► PostgreSQL
 CI / scripts   ──https──►                              │   └──────► Redis (rate-limit counters only)
 gateway agent  ──https──►                              ├─────────► identity provider (OIDC discovery, keys; SCIM calls come in)
   └─ serial/USB ─► device                              └─────────► webhook receivers, SMTP relay (outbound)
```

Trusted: your reverse proxy, your identity provider, your PostgreSQL and its administrators, the operating system of the lab machine running a gateway. Not trusted: every request body, every token until validated, webhook receivers, the network between components unless you add TLS.

## Threats and what answers them

| Threat | What stops it | Left to you / residual risk |
|---|---|---|
| Unauthenticated access | Every route but the probes requires a validated token; unsigned (`alg: none`), tampered, wrong-issuer and wrong-audience tokens are refused | Keep the issuer and audience settings correct; scope your IdP client so only intended applications obtain tokens for this audience |
| Stolen user token | Tokens are the IdP's short-lived access tokens; the console keeps the access token (and a refresh token, if the IdP issues one) in memory only. The one thing it writes to sessionStorage is the sign-in request in flight (state, PKCE verifier, nonce), removed when the IdP sends the browser back; state and PKCE are checked on return | Short IdP token lifetimes; MFA at the IdP |
| Privilege escalation inside a workspace | Role check on every route; API keys are capped at maintainer and cannot create keys; the last administrator cannot be removed; SCIM Group membership is never read as an authorization input | A matrix test covers routes by role; it is not a proof for routes added later |
| Reading another workspace | Every query is scoped to the workspace and the caller's membership; SCIM Group-member links are constrained to provisioned Users in the same workspace by application checks, a database trigger and row-level security; non-member and too-low role get the same 403, unknown ids cannot be probed | Isolation is in application code and, behind it, PostgreSQL row-level security (the request role is confined to the caller's workspace). RLS does not stop SQL injection or a compromised API process, which can switch role back; database administrators see everything |
| Forged or altered results | The server re-verifies the hash chain, checks payload shapes, and derives pass/fail itself; the agent's own status is ignored; a report can only name a suite in its own workspace | A holder of a valid gateway token can submit a fabricated but consistent record. Protect gateway hosts and tokens; rotate on suspicion; revoke retires a gateway |
| A second gateway or replay claiming the same job | Claims are taken under row locks; leases expire and renew | Rehearse duplicate-safe device behavior, failure recovery, and redelivery in your deployment. |
| Injection | Request values reach SQL only as bound parameters (the only text interpolated into a statement is fixed column lists); strict request validation; malformed identifiers and control characters are rejected | A human penetration test has not been done. Run the included scans and tests against the exact deployed revision. |
| SSRF through webhooks | Destination is resolved and checked against a deny-list (link-local, cloud metadata, private ranges unless allow-listed) at connection time, which covers DNS rebinding and redirects | Allow-list only receivers you control |
| Webhook forgery against receivers | HMAC signature per webhook, derived from `WEBHOOK_SIGNING_KEY`; secrets can be rotated | Receivers must verify the signature and the timestamp; keep the signing key with your backups |
| Brute force, abuse, denial of service | Per-user, per-IP, per-gateway and failed-authentication limits (shared through Redis across replicas); request-size limits; stream and queue caps; plan quotas | Layer 7 limits do not replace network-level DDoS protection; put a CDN or provider shield in front of a public service |
| Audit tampering | Append-only table enforced by a trigger; per-workspace hash chain; periodic anchors logged to a system you control | A database superuser can rewrite the tail and re-chain it. Only the anchor lines you ship to a store they cannot edit expose that |
| Leaked secrets in logs or dumps | Structured logs redact authorization headers and token fields; tokens are stored as hashes; email bodies are removed after the final attempt | Database dumps still contain audit data and hashes: encrypt and restrict them. Keep `WEBHOOK_SIGNING_KEY` out of the repository |
| Leaver keeps access | SCIM deactivation removes membership and closes live streams, including on other replicas; API keys and SCIM tokens expire | Needs your IdP to send SCIM. Validate it with a live IdP; without SCIM, remove people by hand. |
| Compromised dependency or image | Lockfiles, SBOM generation, minimal runtime image (no npm, corepack or yarn), and scan workflows are included | New advisories appear daily: scan in your CI, review results, and rebuild images regularly. |
| Misconfiguration | Production mode fails to start without OIDC and https origins; the development token and TLS-skipping settings are refused; `scripts/acceptance.mjs` checks the result | Only as good as `.env`. Review `TRUST_PROXY` against your actual proxy count. |
| Loss of the database | Backup and restore procedure and audit verification are documented | See [DR and service objectives](DR-AND-SLO.md): the single database is the one point of failure. Rehearse recovery yourself. |

## Out of scope / not addressed

- Physical attacks on the lab machine or the device under test; a malicious device that returns crafted text is handled as data (matched against expected text), not as code.
- Side channels, malicious browsers or extensions on a user's machine.
- Billing fraud: there is no payment integration.
- Denial of service by someone who controls your network or your identity provider.
- Compliance regimes: nothing here is a certification.
