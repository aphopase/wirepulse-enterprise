import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { createAuth } from "./auth.mjs";

// Pilot diagnostic: takes a real access token from your identity provider and says what WirePulse would do with it, using the same
// verification code the API runs (createAuth), not a copy of it. The verdict comes from that code; the notes are advice derived from the
// decoded claims. The token is never printed or sent anywhere; only the issuer's discovery document and key URL are fetched.
//
//   OIDC_ISSUER=https://... OIDC_AUDIENCE=... node src/check-token.mjs < token.txt
//   docker compose run --rm -T api node src/check-token.mjs < token.txt        # inside the API image, with the API's own environment
//
// Options: --token-file <path>, --json, --insecure-http (accept http issuer and key URLs, as a development API would).
// Exit status: 0 accepted, 1 rejected, 2 could not run (no token, no OIDC_ISSUER/OIDC_AUDIENCE).

const silent = { info() {}, error() {}, debug() {} };
const GRAPH_AUDIENCES = new Set(["00000003-0000-0000-c000-000000000000", "https://graph.microsoft.com", "https://graph.microsoft.com/"]);

function decode(token) {
  const out = { header: null, claims: null, problem: null };
  if (token.split(".").length !== 3) { out.problem = token.split(".").length === 5 ? "encrypted (JWE)" : "not a three-part JWT (an opaque token?)"; return out; }
  try { out.header = decodeProtectedHeader(token); out.claims = decodeJwt(token); } catch (error) { out.problem = `unreadable: ${error.message}`; }
  return out;
}

const shown = (value) => (Array.isArray(value) ? value.join(", ") : String(value));
const when = (seconds, now) => `${new Date(seconds * 1000).toISOString()} (${seconds >= now ? `in ${Math.round((seconds - now) / 60)} min` : `${Math.round((now - seconds) / 60)} min ago`})`;

// Advice, from what the token says about itself and what the verifier answered. Wording is deliberately conditional: it is a pointer to
// the likely cause, and the verdict above it is the fact.
function notes({ decoded, oidc, verdict, reason, identity, now }) {
  const out = [];
  const { header, claims, problem } = decoded;
  if (problem) { out.push(`The token is ${problem}. WirePulse verifies signed JWT access tokens. Ask for an access token for your own API (not an opaque or encrypted one).`); return out; }
  const audiences = [].concat(claims.aud ?? []);
  if (header.nonce || audiences.some((aud) => GRAPH_AUDIENCES.has(aud))) out.push("This looks like a token for Microsoft Graph. Nobody but Graph can validate those. Request a token for your own API's scope instead (an app registration with \"Expose an API\").");
  if (verdict === "rejected") {
    if (reason === "ERR_JWT_EXPIRED") out.push(`The token expired ${when(claims.exp, now)}. Get a fresh one. If it is fresh, the clock of this machine may be off (30 s of skew is tolerated).`);
    if (reason === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      if (String(claims.iss).replace(/\/$/, "") !== oidc.issuer) out.push(`Issuer mismatch: the token says iss = ${claims.iss}; WirePulse expects exactly OIDC_ISSUER = ${oidc.issuer}.`);
      if (!audiences.includes(oidc.audience)) out.push(`Audience mismatch: the token says aud = ${shown(audiences)}; WirePulse expects OIDC_AUDIENCE = ${oidc.audience}.`);
      if (claims.nbf && claims.nbf > now + 30) out.push(`The token is not valid until ${when(claims.nbf, now)}; check this machine's clock.`);
      if (/^https:\/\/sts\.windows\.net\//.test(claims.iss)) out.push("iss is a Microsoft Entra v1.0 issuer. Set the API app registration to issue v2.0 access tokens (requestedAccessTokenVersion = 2 in its manifest; accessTokenAcceptedVersion in older manifests), so that iss is https://login.microsoftonline.com/<tenant>/v2.0, the issuer of the v2.0 discovery document.");
      if (/\.okta\.com\/?$/.test(claims.iss) || /\.oktapreview\.com\/?$/.test(claims.iss)) out.push("iss is Okta's org authorization server, whose access tokens are meant for Okta's own APIs. Use a custom authorization server (iss like https://<org>.okta.com/oauth2/<id>) and put its audience in OIDC_AUDIENCE.");
    }
    if (reason === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" || reason === "ERR_JWKS_NO_MATCHING_KEY") out.push(`The token (alg ${header.alg}, kid ${header.kid ?? "none"}) was not signed by any key the issuer publishes. Wrong tenant or authorization server, or a token minted for a different issuer than OIDC_ISSUER names.`);
    if (reason === "ERR_JOSE_ALG_NOT_ALLOWED") out.push(`alg ${header.alg} is not accepted: WirePulse takes only asymmetric signatures (RS/PS/ES/EdDSA). HS256 tokens are signed with a shared secret and cannot be verified from published keys.`);
    if (reason === "oidc_discovery_unavailable" || reason === "fetch failed" || reason === 23 || reason === "ERR_JWKS_TIMEOUT") out.push(`Could not reach ${oidc.issuer}/.well-known/openid-configuration or the key URL it names (timeout is 5 s). Check DNS, egress and proxy settings from where the API runs. A failed discovery is retried every 30 s.`);
    if (reason === "oidc_discovery_invalid") out.push(`${oidc.issuer}/.well-known/openid-configuration did not answer 200 with an issuer equal to OIDC_ISSUER and a jwks_uri. Open that URL in a browser and compare. Alternatively set OIDC_JWKS_URI to the key URL by hand.`);
    if (reason === "oidc_discovery_insecure") out.push("The discovery document's jwks_uri is not https. Production requires https; use --insecure-http only for a development issuer.");
    if (reason === "subject_missing") out.push("The token has no sub claim.");
  } else {
    if (!identity.email) out.push("Accepted, but with no email address. The user can sign in, yet cannot accept an invitation and cannot be bound to a SCIM-provisioned account by email (both answer 403 insufficient_workspace_role). Add an email claim and email_verified: true to the access token. If the provider cannot emit email_verified, OIDC_TRUST_UNVERIFIED_EMAIL=true makes the email claim count, which is safe only when the issuer is a single organisation that controls its users' addresses.");
    if (claims.email && !identity.email) out.push(`The token carries email = ${claims.email} but email_verified is ${JSON.stringify(claims.email_verified)}; only the boolean true counts.`);
    if (claims.exp && claims.exp - now < 120) out.push(`The token expires ${when(claims.exp, now)}; run the check on a fresher one before drawing conclusions.`);
  }
  return out;
}

export async function checkToken({ token, oidc, production = true, now = Math.floor(Date.now() / 1000) }) {
  token = token.trim().replace(/^Bearer\s+/i, "");
  const decoded = decode(token);
  const result = { configured: { issuer: oidc.issuer, audience: oidc.audience, jwksUri: oidc.jwksUri, trustUnverifiedEmail: oidc.trustUnverifiedEmail }, header: decoded.header, claims: decoded.claims, problem: decoded.problem, verdict: null, reason: null, identity: null, notes: [] };
  if (token.startsWith("wpk_") || token.startsWith("wpg_") || token.startsWith("wps_")) {
    result.verdict = "not_checked";
    result.notes.push("That is a WirePulse API key, gateway token or SCIM token, not a token from your identity provider.");
    return result;
  }
  // Not a signed JWT at all: the API refuses it too, but without a token to read there is nothing to say about the issuer, so do not
  // go and fetch its keys (an unreachable issuer would then be reported as the reason).
  if (decoded.problem) { result.verdict = "rejected"; result.reason = "malformed_token"; result.notes = notes({ decoded, oidc, verdict: result.verdict, reason: result.reason, identity: null, now }); return result; }
  const events = [];
  const auth = createAuth({ config: { production, oidc, dev: null }, db: null, log: { ...silent, warn: (event) => events.push(event) }, metrics: null });
  const req = { get: (name) => (name.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined), ip: "127.0.0.1", path: "/v1/workspaces", requestId: "check-token" };
  let failure = null;
  await auth.identity(req, { status() { return this; }, json() { return this; } }, (error) => { failure = error; });
  if (failure) throw failure;
  if (req.identity) { result.verdict = "accepted"; result.identity = { subject: req.identity.subject, email: req.identity.email, emailVerified: req.identity.emailVerified }; }
  else { result.verdict = "rejected"; result.reason = events[0]?.reason ?? "unknown"; }
  result.notes = notes({ decoded, oidc, verdict: result.verdict, reason: result.reason, identity: result.identity, now });
  return result;
}

function render(result, now) {
  const lines = [`WirePulse token check against ${result.configured.issuer} (audience ${result.configured.audience})`, ""];
  const { header, claims } = result;
  if (result.problem) lines.push(`Token: ${result.problem}`);
  else {
    const named = ["iss", "aud", "sub", "exp", "email", "email_verified", "preferred_username", "upn", "name", "ver", "tid", "scp", "scope"];
    const row = (label, value) => lines.push(`${label.padEnd(19)}: ${value}`);
    row("header", `alg ${header.alg}, kid ${header.kid ?? "-"}, typ ${header.typ ?? "-"}`);
    for (const name of named) if (claims[name] !== undefined) row(name, name === "exp" ? when(claims.exp, now) : shown(claims[name]));
    row("other claim names", Object.keys(claims).filter((name) => !named.includes(name)).join(", ") || "none");
  }
  lines.push("");
  if (result.verdict === "accepted") lines.push(`VERDICT: ACCEPTED. WirePulse would treat this caller as subject ${result.identity.subject}, email ${result.identity.email ?? "none"} (verified: ${result.identity.emailVerified}).`);
  else if (result.verdict === "rejected") lines.push(`VERDICT: REJECTED (reason: ${result.reason}). The API would answer 401 invalid_bearer_token.`);
  else lines.push("VERDICT: NOT CHECKED.");
  for (const note of result.notes) lines.push("", `- ${note}`);
  return lines.join("\n");
}

async function main(argv, env) {
  const flag = (name) => argv.includes(name);
  const fileAt = argv.indexOf("--token-file");
  const issuer = env.OIDC_ISSUER?.replace(/\/$/, ""); const audience = env.OIDC_AUDIENCE;
  if (!issuer || !audience) { console.error("OIDC_ISSUER and OIDC_AUDIENCE must be set, with the values the API runs with."); return 2; }
  const raw = fileAt >= 0 ? fs.readFileSync(argv[fileAt + 1], "utf8") : fs.readFileSync(0, "utf8");
  if (!raw.trim()) { console.error("No token. Pipe it in (node src/check-token.mjs < token.txt) or pass --token-file <path>."); return 2; }
  const oidc = { issuer, audience, jwksUri: env.OIDC_JWKS_URI ?? null, trustUnverifiedEmail: env.OIDC_TRUST_UNVERIFIED_EMAIL === "true" };
  const now = Math.floor(Date.now() / 1000);
  const result = await checkToken({ token: raw, oidc, production: !flag("--insecure-http"), now });
  console.log(flag("--json") ? JSON.stringify(result, null, 2) : render(result, now));
  return result.verdict === "accepted" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (error) => { console.error(`check failed: ${error.message}`); process.exitCode = 2; });
}
