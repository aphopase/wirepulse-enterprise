// Sign-in and SCIM binding against a real identity provider (Keycloak), not the in-process fake the other tests use. Skipped unless
// WP_TEST_KEYCLOAK_URL names a realm prepared by scripts/test-keycloak.sh. This proves WirePulse validates a real provider's discovery
// document, signing keys, issuer, audience and email_verified claim. It is not Okta or Entra, and the SCIM calls are made by the test,
// not by a provider's own provisioning engine.
import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT, decodeProtectedHeader, generateKeyPair } from "jose";
import { createClient, createTestDatabase, skip as noDatabase, startApi, ws } from "./helpers.mjs";

const ISSUER = process.env.WP_TEST_KEYCLOAK_URL;
const skip = noDatabase || (ISSUER ? false : "WP_TEST_KEYCLOAK_URL not set (scripts/test-keycloak.sh prepares the realm)");
const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

let database; let api;
test.before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  api = await startApi({ databaseUrl: database.url, env: { OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: "wirepulse-api", DEV_BEARER_TOKEN: "" } });
});
test.after(async () => { await api?.stop(); await database?.drop(); });

// What a browser would obtain after sign-in, taken with the password grant because there is no browser here.
async function tokenFor(username, client = "wirepulse-console") {
  const response = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: client, username, password: `${username}-password` })
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.access_token;
}
const claimsOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

test("a token the real provider signed is accepted; forged, altered, unsigned and wrongly addressed ones are not", { skip }, async () => {
  const token = await tokenFor("pat");
  const claims = claimsOf(token);
  assert.deepEqual([claims.iss, claims.aud.includes("wirepulse-api"), claims.email_verified], [ISSUER, true, true], "the realm hands out what this test assumes");
  const status = async (bearer) => (await createClient(api.url, bearer)("/v1/workspaces")).status;

  assert.equal(await status(token), 200);
  assert.equal(await status(null), 401, "no credential");

  const [header, payload, signature] = token.split(".");
  assert.equal(await status([header, encode({ ...claims, email: "root@example.com" }), signature].join(".")), 401, "payload changed after signing");
  assert.equal(await status(`${encode({ alg: "none", typ: "JWT" })}.${payload}.`), 401, "unsigned");

  const { privateKey } = await generateKeyPair("RS256");
  const forged = await new SignJWT({ email: claims.email, email_verified: true }).setProtectedHeader({ alg: "RS256", kid: decodeProtectedHeader(token).kid })
    .setSubject(claims.sub).setIssuer(ISSUER).setAudience("wirepulse-api").setIssuedAt().setExpirationTime("5m").sign(privateKey);
  assert.equal(await status(forged), 401, "right key id, wrong key");

  const elsewhere = await tokenFor("pat", "other-app");
  assert.equal(claimsOf(elsewhere).aud.includes("wirepulse-api"), false);
  assert.equal(await status(elsewhere), 401, "a genuine token that was issued for another application");
});

test("people provisioned over SCIM are bound by the verified email in their real token, and lose access when deactivated", { skip }, async () => {
  const pat = createClient(api.url, await tokenFor("pat"));
  const workspace = await pat("/v1/workspaces", { method: "POST", body: { name: "keycloak" } });
  assert.equal(workspace.status, 201, workspace.text);
  const base = ws(workspace.body.id);
  const issued = await pat(`${base}/scim/tokens`, { method: "POST", body: { name: "idp" } });
  assert.equal(issued.status, 201, issued.text);
  const idp = createClient(api.url, issued.body.token);

  const provisioned = {};
  for (const name of ["kim", "lee"]) {
    const created = await idp("/scim/v2/Users", { method: "POST", body: { schemas: [USER], userName: `${name}@example.com` } });
    assert.equal(created.status, 201, created.text);
    provisioned[name] = created.body.id;
  }

  const lee = createClient(api.url, await tokenFor("lee"));
  assert.equal(claimsOf(await tokenFor("lee")).email_verified, false);
  const refused = await lee(`${base}/usage`);
  assert.deepEqual([refused.status, refused.body.error], [403, "insufficient_workspace_role"], "an unverified address binds nobody");
  assert.equal((await lee("/v1/workspaces")).text.includes(workspace.body.id), false);
  assert.equal((await lee(`${base}/usage`)).status, 403, "still nothing after trying to list");

  const kim = createClient(api.url, await tokenFor("kim"));
  assert.equal((await kim(`${base}/usage`)).status, 200, "a verified address binds on the first request");
  assert.equal((await kim("/v1/workspaces")).text.includes(workspace.body.id), true);

  const removed = await idp(`/scim/v2/Users/${provisioned.kim}`, { method: "PATCH", body: { schemas: [PATCH], Operations: [{ op: "Replace", path: "active", value: false }] } });
  assert.equal(removed.status, 200, removed.text);
  // Keycloak's token is still valid for minutes; what ended is the membership.
  assert.equal((await kim(`${base}/usage`)).status, 403, "deactivated, token or not");
  assert.equal((await kim("/v1/workspaces")).text.includes(workspace.body.id), false);
});
