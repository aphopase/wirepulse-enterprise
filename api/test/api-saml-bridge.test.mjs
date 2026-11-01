// Sign-in with a SAML 2.0 identity provider through an OIDC broker, which is how WirePulse supports SAML (it speaks OIDC only). Keycloak
// plays both roles here: one realm is the company's SAML IdP, the other is the OIDC provider WirePulse trusts and that sends people to the
// IdP. A real browser walks the whole redirect chain (signed SAML response, PKCE code exchange) and the token it ends with goes to the API.
// Skipped unless WP_TEST_SAML_KEYCLOAK_URL names a Keycloak prepared by scripts/test-saml-bridge.sh and a browser is installed. This
// shows the bridge works against Keycloak's SAML implementation; it is not Okta, Entra or ADFS, and the SCIM calls are made by the test.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createClient, createTestDatabase, skip as noDatabase, startApi, ws } from "./helpers.mjs";

const KEYCLOAK = process.env.WP_TEST_SAML_KEYCLOAK_URL;
const IDP_REALM = "wp-corp-saml-idp"; // stands in for the customer's SAML identity provider
const BROKER_REALM = "wp-saml-bridge"; // the OIDC issuer WirePulse trusts
const ISSUER = `${KEYCLOAK}/realms/${BROKER_REALM}`;
const CALLBACK = "http://127.0.0.1:5173/callback";
const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

let chromium = null;
let browserSkip = "";
try { ({ chromium } = await import("playwright-core")); } catch { browserSkip = "playwright-core is not installed (npm install at the repository root)"; }
const skip = noDatabase || (KEYCLOAK ? browserSkip || false : "WP_TEST_SAML_KEYCLOAK_URL not set (scripts/test-saml-bridge.sh starts Keycloak)");

let database; let api; let browser; let adminToken;

async function admin(path, { method = "GET", body, type = "application/json" } = {}) {
  const response = await fetch(`${KEYCLOAK}/admin/realms${path}`, {
    method, headers: { authorization: `Bearer ${adminToken}`, "content-type": type },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
  });
  const text = await response.text();
  assert.ok(response.status < 300, `${method} ${path} -> ${response.status} ${text}`);
  return text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
}

const attributeMappers = ["email", "firstName", "lastName"];

async function prepareRealms() {
  const login = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "admin", password: "admin-password" })
  });
  adminToken = (await login.json()).access_token;
  assert.ok(adminToken, "could not sign in to the Keycloak admin API");
  for (const realm of [IDP_REALM, BROKER_REALM]) await fetch(`${KEYCLOAK}/admin/realms/${realm}`, { method: "DELETE", headers: { authorization: `Bearer ${adminToken}` } });

  // The company's SAML identity provider, with three people. All have verified addresses at the company.
  await admin("", { method: "POST", body: { realm: IDP_REALM, enabled: true, sslRequired: "none" } });
  for (const name of ["sam", "ria", "lou"]) {
    await admin(`/${IDP_REALM}/users`, { method: "POST", body: {
      username: name, email: `${name}@corp.example`, emailVerified: true, firstName: name, lastName: "Corp", enabled: true,
      credentials: [{ type: "password", value: `${name}-password`, temporary: false }]
    } });
  }

  // The OIDC provider WirePulse trusts. Its console client carries the audience mapper, as in scripts/test-keycloak.sh.
  await admin("", { method: "POST", body: { realm: BROKER_REALM, enabled: true, sslRequired: "none" } });
  await admin(`/${BROKER_REALM}/clients`, { method: "POST", body: {
    clientId: "wirepulse-console", publicClient: true, standardFlowEnabled: true, directAccessGrantsEnabled: false,
    redirectUris: ["http://127.0.0.1:5173/*"], attributes: { "pkce.code.challenge.method": "S256" },
    protocolMappers: [{ name: "api-audience", protocol: "openid-connect", protocolMapper: "oidc-audience-mapper",
      config: { "included.custom.audience": "wirepulse-api", "access.token.claim": "true", "id.token.claim": "false" } }]
  } });

  // Two ways to connect the same SAML provider. Trusting the email it asserts is what a company would configure; without that Keycloak
  // marks the address unverified and WirePulse must not bind anybody to it.
  for (const [alias, trustEmail] of [["corp-saml", true], ["corp-saml-untrusted", false]]) {
    const imported = await admin(`/${BROKER_REALM}/identity-provider/import-config`, { method: "POST", body: {
      providerId: "saml", fromUrl: `${KEYCLOAK}/realms/${IDP_REALM}/protocol/saml/descriptor`
    } });
    await admin(`/${BROKER_REALM}/identity-provider/instances`, { method: "POST", body: {
      alias, providerId: "saml", enabled: true, trustEmail, firstBrokerLoginFlowAlias: "first broker login",
      // Each connection is a different service provider to the company, so each needs its own entity ID.
      config: { ...imported, entityId: `${ISSUER}/sp/${alias}`, syncMode: "IMPORT", validateSignature: "true" }
    } });
    for (const attribute of attributeMappers) {
      await admin(`/${BROKER_REALM}/identity-provider/instances/${alias}/mappers`, { method: "POST", body: {
        name: attribute, identityProviderAlias: alias, identityProviderMapper: "saml-user-attribute-idp-mapper",
        config: { syncMode: "INHERIT", "attribute.name": attribute, "user.attribute": attribute }
      } });
    }
    // The company registers WirePulse's broker endpoint as a SAML client of its provider, from the service-provider descriptor.
    const sp = await (await fetch(`${KEYCLOAK}/realms/${BROKER_REALM}/broker/${alias}/endpoint/descriptor`)).text();
    const client = await admin(`/${IDP_REALM}/client-description-converter`, { method: "POST", body: sp, type: "application/xml" });
    client.protocolMappers = attributeMappers.map((attribute) => ({
      name: attribute, protocol: "saml", protocolMapper: "saml-user-property-mapper",
      config: { "user.attribute": attribute, "attribute.name": attribute, "friendly.name": attribute, "attribute.nameformat": "Basic" }
    }));
    await admin(`/${IDP_REALM}/clients`, { method: "POST", body: client });
  }
}

// What the console would do: authorization-code flow with PKCE, sent straight to the company login with kc_idp_hint. Returns the access token.
async function signInThroughSaml(alias, username) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.route(`${CALLBACK}**`, (route) => route.fulfill({ status: 200, contentType: "text/plain", body: "callback" }));
    const verifier = crypto.randomBytes(32).toString("base64url");
    const authorize = new URL(`${ISSUER}/protocol/openid-connect/auth`);
    for (const [key, value] of Object.entries({
      client_id: "wirepulse-console", response_type: "code", scope: "openid email profile", redirect_uri: CALLBACK,
      state: crypto.randomBytes(8).toString("hex"), nonce: crypto.randomBytes(8).toString("hex"), kc_idp_hint: alias,
      code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256"
    })) authorize.searchParams.set(key, value);
    await page.goto(authorize.toString());
    // The broker hands the browser to the company login through an auto-submitted SAML request.
    await page.waitForURL((url) => url.pathname.includes(`/realms/${IDP_REALM}/`), { timeout: 30_000 });
    await page.fill("#username", username);
    await page.fill("#password", `${username}-password`);
    await page.click("#kc-login");
    await page.waitForURL(`${CALLBACK}**`, { timeout: 30_000 });
    const code = new URL(page.url()).searchParams.get("code");
    assert.ok(code, `no authorization code in ${page.url()}`);
    const response = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: "wirepulse-console", code, redirect_uri: CALLBACK, code_verifier: verifier })
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body.access_token;
  } finally { await context.close(); }
}
const claimsOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url"));

test.before(async () => {
  if (skip) return;
  await prepareRealms();
  browser = await chromium.launch();
  database = await createTestDatabase();
  api = await startApi({ databaseUrl: database.url, env: { OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: "wirepulse-api", DEV_BEARER_TOKEN: "" } });
});
test.after(async () => {
  await browser?.close();
  await api?.stop();
  await database?.drop();
  if (adminToken) for (const realm of [IDP_REALM, BROKER_REALM]) await fetch(`${KEYCLOAK}/admin/realms/${realm}`, { method: "DELETE", headers: { authorization: `Bearer ${adminToken}` } });
});

test("people signed in by a SAML provider through the OIDC broker get a token the API accepts, and nobody else's", { skip }, async () => {
  const token = await signInThroughSaml("corp-saml", "sam");
  const claims = claimsOf(token);
  assert.deepEqual([claims.iss, claims.aud.includes("wirepulse-api"), claims.email, claims.email_verified], [ISSUER, true, "sam@corp.example", true]);
  assert.equal((await createClient(api.url, token)("/v1/workspaces")).status, 200);
  assert.equal((await createClient(api.url, null)("/v1/workspaces")).status, 401, "no credential");
});

test("a person provisioned over SCIM is bound by the SAML-asserted email, and loses access when deactivated; an unverified assertion binds nobody", { skip }, async () => {
  const sam = createClient(api.url, await signInThroughSaml("corp-saml", "sam"));
  const workspace = await sam("/v1/workspaces", { method: "POST", body: { name: "saml" } });
  assert.equal(workspace.status, 201, workspace.text);
  const base = ws(workspace.body.id);
  const issued = await sam(`${base}/scim/tokens`, { method: "POST", body: { name: "idp" } });
  assert.equal(issued.status, 201, issued.text);
  const idp = createClient(api.url, issued.body.token);

  const provisioned = {};
  for (const name of ["ria", "lou"]) {
    const created = await idp("/scim/v2/Users", { method: "POST", body: { schemas: [USER], userName: `${name}@corp.example` } });
    assert.equal(created.status, 201, created.text);
    provisioned[name] = created.body.id;
  }

  const ria = createClient(api.url, await signInThroughSaml("corp-saml", "ria"));
  assert.equal((await ria(`${base}/usage`)).status, 200, "a verified SAML email reaches the workspace it was provisioned into");

  const louToken = await signInThroughSaml("corp-saml-untrusted", "lou");
  assert.equal(claimsOf(louToken).email_verified, false, "without trusting the provider's email, Keycloak marks it unverified");
  const refused = await createClient(api.url, louToken)(`${base}/usage`);
  assert.deepEqual([refused.status, refused.body.error], [403, "insufficient_workspace_role"], "an unverified address binds nobody");

  const off = await idp(`/scim/v2/Users/${provisioned.ria}`, { method: "PATCH", body: { schemas: [PATCH], Operations: [{ op: "replace", path: "active", value: false }] } });
  assert.equal(off.status, 200, off.text);
  assert.equal((await ria(`${base}/usage`)).status, 403, "deactivated in the provisioning feed: the still-valid token no longer works");
});
