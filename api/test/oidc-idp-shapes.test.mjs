import assert from "node:assert/strict";
import test from "node:test";
import { createAuth } from "../src/auth.mjs";
import { AUDIENCE, startIssuer } from "./helpers.mjs";

// SIMULATION, not a test against Microsoft Entra ID, Okta or Auth0: a local provider signs tokens whose CLAIMS are shaped the way those products
// document their access tokens, so the real verification and identity code runs on them. What this settles is what the API does with such
// a token. It does not show that your tenant issues one; for that, decode a real access token from your tenant (jwt.ms or the IdP's token
// preview) and compare. The signature, issuer and audience checks are the same as for any other provider and are covered elsewhere.
const silent = { warn() {}, info() {}, error() {}, debug() {} };

async function identityFor(issuer, token, { trustUnverifiedEmail = false } = {}) {
  const auth = createAuth({ config: { production: false, oidc: { issuer: issuer.issuer, audience: AUDIENCE, jwksUri: null, trustUnverifiedEmail }, dev: null }, db: null, log: silent, metrics: null });
  const req = { get: (name) => (name.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined), ip: "127.0.0.1", path: "/v1/workspaces", requestId: "r" };
  const res = { status() { return this; }, json() { return this; } };
  let proceeded = false;
  await auth.identity(req, res, (error) => { if (error) throw error; proceeded = true; });
  return { proceeded, identity: req.identity };
}

test("simulated Entra ID v2 access token (no email claims): signs in by subject, carries no email, so it cannot accept an invitation", async () => {
  const issuer = await startIssuer();
  try {
    const token = await issuer.sign({ sub: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", aud: AUDIENCE, claims: { ver: "2.0", tid: "11111111-2222-3333-4444-555555555555", oid: "66666666-7777-8888-9999-000000000000", preferred_username: "alice@contoso.example", name: "Alice", scp: "access_as_user" } });
    const { proceeded, identity } = await identityFor(issuer, token);
    assert.equal(proceeded, true);
    assert.equal(identity.subject, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    assert.equal(identity.email, null, "preferred_username is a display name, never an address to match invitations against");
    assert.equal(identity.emailVerified, false);
  } finally { await issuer.stop(); }
});

test("simulated Entra ID token with an optional email claim but no email_verified: ignored unless OIDC_TRUST_UNVERIFIED_EMAIL is set", async () => {
  const issuer = await startIssuer();
  try {
    const token = await issuer.sign({ sub: "s1", claims: { ver: "2.0", email: "Alice@Contoso.example" } });
    assert.equal((await identityFor(issuer, token)).identity.email, null);
    const trusted = (await identityFor(issuer, token, { trustUnverifiedEmail: true })).identity;
    assert.deepEqual([trusted.email, trusted.emailVerified], ["alice@contoso.example", true]);
  } finally { await issuer.stop(); }
});

test("simulated Okta access token: an audience array that includes ours, and an email claim with email_verified true, are accepted", async () => {
  const issuer = await startIssuer();
  try {
    const token = await issuer.sign({ sub: "00u1abcd", aud: [AUDIENCE, "api://other"], claims: { ver: 1, cid: "0oa1client", uid: "00u1abcd", scp: ["openid", "email"], email: "Bob@Example.com", email_verified: true } });
    const { proceeded, identity } = await identityFor(issuer, token);
    assert.equal(proceeded, true);
    assert.deepEqual([identity.subject, identity.email, identity.emailVerified], ["00u1abcd", "bob@example.com", true]);
  } finally { await issuer.stop(); }
});

test("an email_verified that is not the boolean true (the string \"true\", 1) is not trusted", async () => {
  const issuer = await startIssuer();
  try {
    for (const flag of ["true", 1, "True"]) {
      const token = await issuer.sign({ sub: "s2", claims: { email: "carol@example.com", email_verified: flag } });
      assert.equal((await identityFor(issuer, token)).identity.email, null, `email_verified ${JSON.stringify(flag)}`);
    }
  } finally { await issuer.stop(); }
});

test("simulated Auth0 access token: an iss with a trailing slash is the configured issuer, a different issuer is still refused", async () => {
  const issuer = await startIssuer();
  try {
    const token = await issuer.sign({ sub: "auth0|abc", iss: `${issuer.issuer}/`, claims: { email: "dan@example.com", email_verified: true, azp: "client1", scope: "openid profile email" } });
    const { proceeded, identity } = await identityFor(issuer, token);
    assert.equal(proceeded, true);
    assert.deepEqual([identity.subject, identity.email], ["auth0|abc", "dan@example.com"]);
    const foreign = await issuer.sign({ sub: "x", iss: `${issuer.issuer}/other` });
    assert.equal((await identityFor(issuer, foreign)).proceeded, false);
  } finally { await issuer.stop(); }
});
