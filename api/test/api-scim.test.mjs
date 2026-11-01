// SCIM 2.0 provisioning: an identity provider creates and deactivates people, WirePulse grants and withdraws workspace access to match.
// Two API instances share one database, so a deprovisioned person's open live stream must end on the instance they are connected to
// even when the identity provider's call lands on the other. The wire format against docs/openapi.yaml is in openapi.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { DEV_TOKEN, createClient, createTestDatabase, skip, sleep, startApi, startIssuer, waitFor, ws } from "./helpers.mjs";

let database; let issuer; let api; let other; let pool; let admin;
const SCIM = "application/scim+json";
const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

test.before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  issuer = await startIssuer();
  const small = { DB_POOL_SIZE: "4" };
  api = await startApi({ databaseUrl: database.url, issuer, env: small });
  other = await startApi({ databaseUrl: database.url, issuer, env: small });
  pool = new pg.Pool({ connectionString: database.url, max: 3 });
  admin = createClient(api.url, DEV_TOKEN);
});
test.after(async () => { await other?.stop(); await api?.stop(); await pool?.end(); await issuer?.stop(); await database?.drop(); });

// A workspace with a SCIM token. `plan` is the plan the token is created under; `then` moves the workspace afterwards (a token keeps working).
async function provisioned(name, { plan = "business", then = null } = {}) {
  const workspaceId = (await admin("/v1/workspaces", { method: "POST", body: { name } })).body.id;
  await pool.query("UPDATE workspaces SET plan = $2 WHERE id = $1", [workspaceId, plan]);
  const issued = await admin(`${ws(workspaceId)}/scim/tokens`, { method: "POST", body: { name: "idp" } });
  assert.equal(issued.status, 201, issued.text);
  if (then) await pool.query("UPDATE workspaces SET plan = $2 WHERE id = $1", [workspaceId, then]);
  return { id: workspaceId, base: ws(workspaceId), tokenId: issued.body.id, token: issued.body.token, idp: createClient(api.url, issued.body.token), idpOther: createClient(other.url, issued.body.token) };
}
const person = async (instance, sub, email, options = {}) => createClient(instance.url, await issuer.sign({ sub, ...(email ? { email } : {}), ...options }));
const create = (w, userName, extra = {}) => w.idp("/scim/v2/Users", { method: "POST", body: { schemas: [USER], userName, ...extra } });
const deactivate = (w, id, client = w.idp) => client(`/scim/v2/Users/${id}`, { method: "PATCH", body: { schemas: [PATCH], Operations: [{ op: "Replace", path: "active", value: false }] } });
const reactivate = (w, id) => w.idp(`/scim/v2/Users/${id}`, { method: "PATCH", body: { schemas: [PATCH], Operations: [{ op: "Replace", path: "active", value: true }] } });
const members = async (w) => (await pool.query("SELECT subject, email, role FROM workspace_members WHERE workspace_id = $1 ORDER BY subject", [w.id])).rows;
const record = async (w, id) => (await pool.query("SELECT * FROM scim_users WHERE id = $1 AND workspace_id = $2", [id, w.id])).rows[0];
const actions = async (w) => (await pool.query("SELECT action, actor_subject, details FROM audit_events WHERE workspace_id = $1 ORDER BY chain_seq", [w.id])).rows;
const usage = async (w, client = admin) => (await client(`${w.base}/usage`)).body.usage;

// A live job stream; `ended` says the server closed it.
async function openStream(instance, w, token) {
  const controller = new AbortController();
  const response = await fetch(`${instance.url}${w.base}/test-jobs/stream`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
  assert.equal(response.status, 200);
  const state = { ended: false, ready: false };
  (async () => {
    try { for await (const chunk of response.body) if (/event: ready/.test(new TextDecoder().decode(chunk))) state.ready = true; state.ended = true; } catch { state.ended = true; }
  })();
  await waitFor(() => state.ready, { message: "stream ready" });
  return { state, close: () => controller.abort() };
}

test("tokens: administrators only, shown once, hashed, limited by plan, and refused when revoked, expired or of another kind", { skip }, async () => {
  const workspaceId = (await admin("/v1/workspaces", { method: "POST", body: { name: "scim tokens" } })).body.id;
  const base = ws(workspaceId);
  for (const plan of ["free", "team"]) {
    await pool.query("UPDATE workspaces SET plan = $2 WHERE id = $1", [workspaceId, plan]);
    const refused = await admin(`${base}/scim/tokens`, { method: "POST", body: { name: "idp" } });
    assert.equal(refused.status, 403, plan);
    assert.deepEqual([refused.body.error, refused.body.details.resource, refused.body.details.limit], ["plan_limit_reached", "scim_tokens", 0]);
  }
  await pool.query("UPDATE workspaces SET plan = 'business' WHERE id = $1", [workspaceId]);

  assert.equal((await admin(`${base}/scim/tokens`, { method: "POST", body: { name: "idp", expiresInDays: 400000 } })).status, 400);
  assert.equal((await admin(`${base}/scim/tokens`, { method: "POST", body: { name: "idp", surprise: true } })).status, 400);
  const first = await admin(`${base}/scim/tokens`, { method: "POST", body: { name: "idp", expiresInDays: 30 } });
  assert.equal(first.status, 201);
  assert.match(first.body.token, /^wps_/);
  assert.equal(first.body.prefix, first.body.token.slice(0, 12));
  const days = (Date.parse(first.body.expiresAt) - Date.parse(first.body.createdAt)) / 86_400_000;
  assert.ok(Math.abs(days - 30) < 0.01, `expires in ${days} days`);
  assert.equal((await admin(`${base}/scim/tokens`, { method: "POST", body: { name: "IDP" } })).status, 409, "an active token name is unique in the workspace");
  const second = await admin(`${base}/scim/tokens`, { method: "POST", body: { name: "entra" } });
  assert.equal(second.status, 201);
  const third = await admin(`${base}/scim/tokens`, { method: "POST", body: { name: "third" } });
  assert.deepEqual([third.status, third.body.error], [403, "plan_limit_reached"], "the business plan allows two");
  assert.equal((await usage({ base })).scimTokens, 2);

  // Only the hash is stored, and the listing never shows the token.
  const stored = (await pool.query("SELECT token_hash FROM scim_tokens WHERE id = $1", [first.body.id])).rows[0];
  assert.equal(stored.token_hash, (await pool.query("SELECT encode(sha256($1::bytea), 'hex') AS h", [first.body.token])).rows[0].h);
  const listed = await admin(`${base}/scim/tokens`);
  assert.ok(!listed.text.includes(first.body.token) && !listed.text.includes("token_hash"));
  assert.deepEqual(listed.body.map((token) => token.name).sort(), ["entra", "idp"]);

  // Administrators only: an engineer who is a member is refused, and so is an API key.
  const engineer = await person(api, "scim-engineer", "engineer@example.com");
  await pool.query("INSERT INTO workspace_members (workspace_id, subject, email, role) VALUES ($1, 'scim-engineer', 'engineer@example.com', 'engineer')", [workspaceId]);
  assert.equal((await engineer(`${base}/scim/tokens`)).status, 403);
  assert.equal((await engineer(`${base}/scim/tokens`, { method: "POST", body: { name: "mine" } })).status, 403);
  assert.equal((await engineer(`${base}/scim/users`)).status, 403);
  assert.equal((await engineer(`${base}/scim/tokens/${first.body.id}`, { method: "DELETE" })).status, 403);
  const key = (await admin(`${base}/api-keys`, { method: "POST", body: { name: "ci", role: "maintainer" } })).body.token;
  assert.equal((await createClient(api.url, key)(`${base}/scim/tokens`)).status, 403);

  // What works as a SCIM credential: this token, on both instances, until it is revoked or expires. What does not: anything else.
  const idp = createClient(api.url, first.body.token);
  assert.equal((await idp("/scim/v2/Users")).status, 200);
  assert.equal((await createClient(other.url, first.body.token)("/scim/v2/Users")).status, 200);
  assert.notEqual((await pool.query("SELECT last_used_at FROM scim_tokens WHERE id = $1", [first.body.id])).rows[0].last_used_at, null, "last use is recorded");
  for (const wrong of [DEV_TOKEN, key, "wps_" + "x".repeat(43), "", "Bearer", first.body.token.replace("wps_", "wpk_")]) {
    const refused = await createClient(api.url, wrong || null)("/scim/v2/Users");
    assert.equal(refused.status, 401, `"${wrong.slice(0, 8)}"`);
    assert.equal(refused.headers.get("content-type").split(";")[0], SCIM);
    assert.deepEqual([refused.body.status, refused.body.detail], ["401", "invalid_scim_token"]);
  }
  // It is not a credential for anything else.
  assert.equal((await idp(`${base}/members`)).status, 401);
  assert.equal((await idp("/v1/workspaces")).status, 401);
  assert.equal((await idp("/gateway/v1/heartbeat", { method: "POST", body: {} })).status, 401);

  await pool.query("UPDATE scim_tokens SET expires_at = now() - interval '1 second' WHERE id = $1", [first.body.id]);
  assert.equal((await idp("/scim/v2/Users")).status, 401, "an expired token is refused");
  assert.equal((await usage({ base })).scimTokens, 1, "an expired token no longer counts toward the limit");
  assert.equal((await admin(`${base}/scim/tokens`, { method: "POST", body: { name: "idp" } })).status, 409, "an expired token keeps its name until it is revoked");
  assert.equal((await admin(`${base}/scim/tokens/${first.body.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await admin(`${base}/scim/tokens`, { method: "POST", body: { name: "idp" } })).status, 201);

  const revoked = createClient(api.url, second.body.token);
  assert.equal((await revoked("/scim/v2/Users")).status, 200);
  assert.equal((await admin(`${base}/scim/tokens/${second.body.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await revoked("/scim/v2/Users")).status, 401, "a revoked token stops working at once, on every instance");
  assert.equal((await createClient(other.url, second.body.token)("/scim/v2/Users")).status, 401);
  assert.equal((await admin(`${base}/scim/tokens/${second.body.id}`, { method: "DELETE" })).status, 404);
});

test("the protocol: users are created, found, replaced and patched the way Okta and Entra ID do it", { skip }, async () => {
  const w = await provisioned("scim protocol");
  const neighbour = await provisioned("scim protocol neighbour");

  const made = await create(w, "Pat.Doe@Example.com", { externalId: "okta-1", displayName: "Pat Doe", name: { givenName: "Pat", familyName: "Doe" }, roles: [{ value: "Engineer", primary: true }] });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.headers.get("content-type").split(";")[0], SCIM);
  assert.equal(made.headers.get("location"), made.body.meta.location);
  assert.deepEqual([made.body.userName, made.body.emails, made.body.active, made.body.roles], ["Pat.Doe@Example.com", [{ value: "pat.doe@example.com", type: "work", primary: true }], true, [{ value: "engineer", primary: true }]]);
  assert.deepEqual(made.body.name, { givenName: "Pat", familyName: "Doe" });
  const patId = made.body.id;
  assert.equal((await record(w, patId)).subject, null, "nobody has signed in yet");
  assert.deepEqual(await members(w), [{ subject: "dev-admin", email: "admin@wirepulse.local", role: "administrator" }], "provisioning does not by itself create a member");

  // The email comes from `emails` (primary first, then work, then the first), else from an email-format userName; role defaults to viewer.
  const viaEmails = await create(w, "lee", { emails: [{ value: "lee.home@example.com", type: "home" }, { value: "lee@example.com", type: "work" }] });
  assert.deepEqual([viaEmails.status, viaEmails.body.emails[0].value, viaEmails.body.roles[0].value], [201, "lee@example.com", "viewer"]);
  assert.equal((await create(w, "no-address")).status, 400);
  assert.equal((await create(w, "kim@example.com", { emails: [{ value: "not an address" }] })).status, 400);
  assert.equal((await create(w, "kim@example.com", { roles: [{ value: "emperor" }] })).status, 400);
  assert.equal((await create(w, "kim@example.com", { active: "maybe" })).status, 400);
  assert.equal((await create(w, "kim@example.com", { externalId: "x".repeat(300) })).status, 400);
  assert.equal((await w.idp("/scim/v2/Users", { method: "POST", body: [] })).status, 400);
  const malformed = await w.idp("/scim/v2/Users", { method: "POST", rawBody: "{not json", headers: { "content-type": SCIM } });
  assert.deepEqual([malformed.status, malformed.body.scimType], [400, "invalidSyntax"]);
  assert.equal((await create(w, "kim@example.com", { unknownAttribute: { anything: true }, "urn:custom:2.0:User": { badge: 7 } })).status, 201, "what is not stored is ignored");

  // Uniqueness is per workspace and says which attribute collided.
  const dupName = await create(w, "pat.doe@example.com");
  assert.deepEqual([dupName.status, dupName.body.scimType, dupName.body.detail], [409, "uniqueness", "userName already exists"]);
  const dupMail = await create(w, "someone-else", { emails: [{ value: "PAT.DOE@example.com", primary: true }] });
  assert.deepEqual([dupMail.status, dupMail.body.scimType, dupMail.body.detail], [409, "uniqueness", "email already exists"]);
  const dupExternal = await create(w, "new.person@example.com", { externalId: "okta-1" });
  assert.deepEqual([dupExternal.status, dupExternal.body.detail], [409, "externalId already exists"]);
  assert.equal((await create(neighbour, "pat.doe@example.com", { externalId: "okta-1" })).status, 201, "another workspace is another namespace");

  // Looking people up: the equality filters identity providers send before they create.
  const filter = async (expression) => w.idp(`/scim/v2/Users?filter=${encodeURIComponent(expression)}`);
  for (const expression of ['userName eq "PAT.DOE@example.com"', 'externalId eq "okta-1"', `id eq "${patId}"`, 'emails.value eq "Pat.Doe@Example.com"', 'USERNAME EQ "pat.doe@example.com"']) {
    const found = await filter(expression);
    assert.deepEqual([found.status, found.body.totalResults, found.body.Resources?.[0]?.id], [200, 1, patId], expression);
  }
  assert.equal((await filter('userName eq "nobody@example.com"')).body.totalResults, 0);
  for (const bad of ['displayName eq "Pat"', 'userName co "pat"', "userName eq pat", 'userName eq "a" and active eq true', 'emails[type eq "work"]']) {
    const refused = await filter(bad);
    assert.deepEqual([refused.status, refused.body.scimType], [400, "invalidFilter"], bad);
  }
  const everyone = await w.idp("/scim/v2/Users");
  assert.deepEqual([everyone.body.totalResults, everyone.body.startIndex, everyone.body.itemsPerPage], [3, 1, 3]);
  const secondPage = await w.idp("/scim/v2/Users?startIndex=2&count=1");
  assert.deepEqual([secondPage.body.totalResults, secondPage.body.startIndex, secondPage.body.itemsPerPage, secondPage.body.Resources[0].id], [3, 2, 1, viaEmails.body.id]);
  assert.deepEqual((await w.idp("/scim/v2/Users?count=0")).body.Resources, []);
  assert.equal((await w.idp("/scim/v2/Users?startIndex=50")).body.Resources.length, 0);
  assert.equal((await w.idp("/scim/v2/Users?count=100000")).status, 200, "an oversized page is capped, not refused");

  // Reading one; another workspace's user is simply not there.
  assert.equal((await w.idp(`/scim/v2/Users/${patId}`)).body.externalId, "okta-1");
  const foreign = (await neighbour.idp("/scim/v2/Users")).body.Resources[0].id;
  for (const id of [foreign, "00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
    const missing = await w.idp(`/scim/v2/Users/${id}`);
    assert.deepEqual([missing.status, missing.body.status, missing.headers.get("content-type").split(";")[0]], [404, "404", SCIM], id);
  }
  assert.equal((await w.idp(`/scim/v2/Users/${foreign}`, { method: "PATCH", body: { Operations: [{ op: "replace", path: "active", value: false }] } })).status, 404);
  assert.equal((await w.idp(`/scim/v2/Users/${foreign}`, { method: "DELETE" })).status, 404);
  assert.equal((await neighbour.idp(`/scim/v2/Users/${foreign}`)).status, 200, "and it was left alone");
  assert.equal((await w.idp("/scim/v2/Groups")).status, 200, "Groups are a supported resource");

  // PUT replaces what is stated; roles and active stay when omitted.
  const put = await w.idp(`/scim/v2/Users/${patId}`, { method: "PUT", body: { userName: "pat.doe@example.com", displayName: "Pat D.", emails: [{ value: "pat.doe@example.com", primary: true }] } });
  assert.deepEqual([put.status, put.body.displayName, put.body.externalId, put.body.name, put.body.roles[0].value, put.body.active], [200, "Pat D.", undefined, undefined, "engineer", true]);
  const putRole = await w.idp(`/scim/v2/Users/${patId}`, { method: "PUT", body: { userName: "pat.doe@example.com", roles: [{ value: "maintainer" }], active: true } });
  assert.equal(putRole.body.roles[0].value, "maintainer");
  assert.equal((await w.idp(`/scim/v2/Users/${patId}`, { method: "PUT", body: { displayName: "no userName" } })).status, 400);
  assert.equal((await w.idp(`/scim/v2/Users/${viaEmails.body.id}`, { method: "PUT", body: { userName: "pat.doe@example.com" } })).status, 409);

  // PATCH the way Okta sends it (no path, an object) and the way Entra ID does (capitalised ops, "False").
  const okta = await w.idp(`/scim/v2/Users/${patId}`, { method: "PATCH", body: { schemas: [PATCH], Operations: [{ op: "replace", value: { displayName: "Patricia", "name.givenName": "Patricia", active: true, unknownThing: 1 } }] } });
  assert.deepEqual([okta.status, okta.body.displayName, okta.body.name.givenName], [200, "Patricia", "Patricia"]);
  const entra = await w.idp(`/scim/v2/Users/${patId}`, { method: "PATCH", body: { schemas: [PATCH], Operations: [{ op: "Replace", path: "displayName", value: "Pat Entra" }, { op: "Add", path: "emails[type eq \"work\"].value", value: "pat.entra@example.com" }, { op: "Replace", path: "roles", value: [{ value: "viewer" }] }, { op: "Remove", path: "externalId" }, { op: "Replace", path: "urn:custom:attribute", value: "ignored" }] } });
  assert.deepEqual([entra.status, entra.body.displayName, entra.body.emails[0].value, entra.body.roles[0].value, entra.body.externalId], [200, "Pat Entra", "pat.entra@example.com", "viewer", undefined]);
  assert.equal((await w.idp(`/scim/v2/Users/${patId}`, { method: "PATCH", body: { Operations: [{ op: "Replace", path: `${USER}:displayName`, value: "Namespaced" }] } })).body.displayName, "Namespaced");
  for (const bad of [{ Operations: [] }, { Operations: [{ op: "move", path: "active", value: true }] }, { Operations: [{ op: "replace", path: "active", value: "perhaps" }] }, { Operations: [{ op: "remove", path: "userName" }] },
    { Operations: [{ op: "remove", path: "active" }] }, { Operations: [{ op: "remove" }] }, { Operations: [{ op: "replace", value: "just text" }] }, { Operations: [{ op: "replace", path: "roles", value: [{ value: "emperor" }] }] }, {}]) {
    assert.equal((await w.idp(`/scim/v2/Users/${patId}`, { method: "PATCH", body: bad })).status, 400, JSON.stringify(bad));
  }
  const unchanged = await record(w, patId);
  assert.equal((await w.idp(`/scim/v2/Users/${patId}`, { method: "PATCH", body: { Operations: [{ op: "replace", path: "displayName", value: "Namespaced" }] } })).status, 200);
  assert.equal((await record(w, patId)).updated_at.getTime(), unchanged.updated_at.getTime(), "a patch that changes nothing writes nothing");

  assert.equal((await w.idp(`/scim/v2/Users/${patId}`, { method: "DELETE" })).status, 204);
  assert.equal((await w.idp(`/scim/v2/Users/${patId}`)).status, 404);
  assert.equal((await create(w, "pat.doe@example.com", { externalId: "okta-1" })).status, 201, "a deleted person can be provisioned again");

  // The administrator's own view of the same records.
  const listed = (await admin(`${w.base}/scim/users`)).body;
  assert.deepEqual(listed.map((row) => [row.userName, row.state]).sort(), [["kim@example.com", "pending"], ["lee", "pending"], ["pat.doe@example.com", "pending"]]);
  assert.ok(listed.every((row) => row.email && row.role && row.createdAt));
  assert.deepEqual((await usage(w)).pendingInvitations, 3, "provisioned people who have not signed in yet hold a seat");
});

test("SCIM Groups are workspace-scoped directory membership and do not change access", { skip }, async () => {
  const w = await provisioned("scim groups");
  const neighbour = await provisioned("scim groups neighbour");
  const pat = (await create(w, "scim-group-pat@example.com")).body;
  const lee = (await create(w, "scim-group-lee@example.com")).body;
  const foreign = (await create(neighbour, "scim-group-foreign@example.com")).body;

  const made = await w.idp("/scim/v2/Groups", { method: "POST", body: { schemas: [GROUP], displayName: "Hardware", externalId: "okta-hardware", members: [{ value: pat.id }, { value: lee.id }] } });
  assert.equal(made.status, 201, made.text);
  assert.deepEqual([made.body.displayName, made.body.externalId, made.body.members.map((member) => member.value).sort()], ["Hardware", "okta-hardware", [pat.id, lee.id].sort()]);
  assert.equal(made.headers.get("location"), made.body.meta.location);
  const groupId = made.body.id;
  assert.equal((await w.idp(`/scim/v2/Groups?filter=${encodeURIComponent('displayName eq "hardware"')}`)).body.Resources[0].id, groupId);
  assert.equal((await w.idp(`/scim/v2/Groups?filter=${encodeURIComponent('externalId eq "okta-hardware"')}`)).body.totalResults, 1);
  assert.deepEqual((await w.idp("/scim/v2/Groups?attributes=displayName,members.value")).body.Resources[0].members.map((member) => Object.keys(member)), [["value"], ["value"]]);
  assert.equal((await w.idp(`/scim/v2/Groups/${groupId}?excludedAttributes=members`)).body.members, undefined);
  assert.deepEqual((await w.idp("/scim/v2/Groups/.search", { method: "POST", body: { filter: 'id eq "' + groupId + '"' } })).body.Resources.map((entry) => entry.id), [groupId]);

  const patched = await w.idp(`/scim/v2/Groups/${groupId}`, { method: "PATCH", body: { schemas: [PATCH], Operations: [{ op: "Add", path: "members", value: { value: pat.id } }, { op: "Remove", path: "members", value: { value: lee.id } }, { op: "Replace", path: "displayName", value: "Lab hardware" }] } });
  assert.deepEqual([patched.status, patched.body.displayName, patched.body.members.map((member) => member.value)], [200, "Lab hardware", [pat.id]]);
  const replaced = await w.idp(`/scim/v2/Groups/${groupId}`, { method: "PUT", body: { displayName: "Firmware", members: [{ value: lee.id }] } });
  assert.deepEqual([replaced.status, replaced.body.displayName, replaced.body.externalId, replaced.body.members.map((member) => member.value)], [200, "Firmware", undefined, [lee.id]]);
  assert.equal((await w.idp(`/scim/v2/Groups/${groupId}`, { method: "PATCH", body: { Operations: [{ op: "Add", path: "members", value: { value: foreign.id } }] } })).status, 400, "another workspace's user is never a member");
  assert.equal((await w.idp("/scim/v2/Groups", { method: "POST", body: { displayName: "No such user", members: [{ value: "00000000-0000-4000-8000-000000000000" }] } })).status, 400);
  assert.equal((await neighbour.idp(`/scim/v2/Groups/${groupId}`)).status, 404);
  assert.equal((await w.idp(`/scim/v2/Groups/${groupId}`, { method: "DELETE" })).status, 204);
  assert.equal((await w.idp(`/scim/v2/Groups/${groupId}`)).status, 404);
  assert.deepEqual((await actions(w)).filter((event) => event.action.startsWith("scim.group_")).map((event) => event.action), ["scim.group_created", "scim.group_updated", "scim.group_updated", "scim.group_deleted"]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM scim_group_members WHERE workspace_id = $1", [w.id])).rows[0].n, 0, "group deletion removes its memberships");
});

test("a provisioned person gets access on their first verified sign-in, and only the right person does", { skip }, async () => {
  const w = await provisioned("scim binding");
  const pat = (await create(w, "pat@example.com", { roles: [{ value: "engineer" }] })).body;
  assert.deepEqual([(await usage(w)).members, (await usage(w)).pendingInvitations], [1, 1]);

  // Not the same address, an unverified address, no address at all: nothing is granted.
  const stranger = await person(api, "stranger", "stranger@example.com");
  const unverified = await person(api, "unverified", "pat@example.com", { emailVerified: false });
  const noEmail = await person(api, "no-email");
  for (const client of [stranger, unverified, noEmail]) {
    assert.equal((await client(`${w.base}/test-suites`)).status, 403);
    assert.deepEqual((await client("/v1/workspaces")).body, []);
  }
  assert.equal((await record(w, pat.id)).subject, null);

  // The first request in the workspace is enough (no need to list workspaces first), and the address is compared in lower case.
  const patSignedIn = await person(api, "pat-sub", "Pat@Example.COM");
  assert.equal((await patSignedIn(`${w.base}/test-suites`)).status, 200);
  assert.equal((await patSignedIn(`${w.base}/scim/tokens`)).status, 403, "with the role the identity provider gave: engineers do not administer");
  assert.deepEqual((await members(w)).find((member) => member.subject === "pat-sub"), { subject: "pat-sub", email: "pat@example.com", role: "engineer" });
  const bound = await record(w, pat.id);
  assert.deepEqual([bound.subject, bound.bound_at !== null], ["pat-sub", true]);
  assert.deepEqual([(await usage(w)).members, (await usage(w)).pendingInvitations], [2, 0], "the seat moved from waiting to taken");
  assert.equal((await admin(`${w.base}/scim/users`)).body[0].state, "active");

  // One record binds to one person: a second account with the same verified address gets nothing, and neither does a returning one.
  const impostor = await person(api, "pat-second-account", "pat@example.com");
  assert.equal((await impostor(`${w.base}/test-suites`)).status, 403);
  assert.deepEqual((await impostor("/v1/workspaces")).body, []);
  assert.equal((await members(w)).filter((member) => member.email === "pat@example.com").length, 1);

  // Listing workspaces is the other way in (it is what a console does first), and it works for several workspaces at once.
  const second = await provisioned("scim binding two");
  const third = await provisioned("scim binding three");
  await create(second, "lena@example.com", { roles: [{ value: "maintainer" }] });
  await create(third, "lena@example.com");
  const lena = await person(api, "lena-sub", "lena@example.com");
  const workspaces = (await lena("/v1/workspaces")).body;
  assert.deepEqual(workspaces.map((workspace) => [workspace.name, workspace.role]), [["scim binding three", "viewer"], ["scim binding two", "maintainer"]]);

  // An API key never binds, whatever email its creator has.
  const key = createClient(api.url, (await admin(`${w.base}/api-keys`, { method: "POST", body: { name: "ci", role: "viewer" } })).body.token);
  assert.equal((await key(`${second.base}/test-suites`)).status, 403);

  // Inactive people are not bound.
  const sleeper = (await create(w, "sleeper@example.com", { active: false })).body;
  const sleeperClient = await person(api, "sleeper-sub", "sleeper@example.com");
  assert.equal((await sleeperClient(`${w.base}/test-suites`)).status, 403);
  assert.equal((await record(w, sleeper.id)).subject, null);

  // Signing in from several tabs at once binds once.
  const quick = (await create(w, "quick@example.com")).body;
  const quickClient = await person(api, "quick-sub", "quick@example.com");
  const answers = await Promise.all(Array.from({ length: 12 }, () => quickClient(`${w.base}/test-suites`)));
  assert.ok(answers.every((answer) => answer.status === 200), answers.map((answer) => answer.status).join());
  assert.equal((await actions(w)).filter((event) => event.action === "scim.member_bound" && event.actor_subject === "quick-sub").length, 1);
  assert.equal((await record(w, quick.id)).subject, "quick-sub");

  // Two accounts with the same verified address racing: exactly one wins.
  const raced = (await create(w, "race@example.com")).body;
  const contenders = await Promise.all(["race-a", "race-b"].map((sub) => person(api, sub, "race@example.com")));
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => contenders[index % 2](`${w.base}/test-suites`).then((response) => [index % 2 === 0 ? "race-a" : "race-b", response.status])));
  const winner = (await record(w, raced.id)).subject;
  assert.ok(["race-a", "race-b"].includes(winner));
  for (const [sub, status] of results) assert.equal(status, sub === winner ? 200 : 403, `${sub} against winner ${winner}`);
  assert.equal((await members(w)).filter((member) => member.email === "race@example.com").length, 1);
});

test("an invited member is adopted, keeps their role, and cannot outlive their provisioning record", { skip }, async () => {
  const w = await provisioned("scim adoption");
  const invite = async (email, role) => (await admin(`${w.base}/invitations`, { method: "POST", body: { email, role } })).body;
  const accept = async (client, invitation) => assert.equal((await client(`/v1/invitations/${invitation.id}/accept`, { method: "POST" })).status, 200);

  // Already a member when the identity provider creates them: no second seat, the role is kept unless the provider sends one.
  const sam = await person(api, "sam-sub", "sam@example.com");
  await accept(sam, await invite("sam@example.com", "maintainer"));
  const before = (await usage(w)).members;
  const adopted = await create(w, "sam@example.com");
  assert.deepEqual([adopted.status, adopted.body.roles[0].value], [201, "maintainer"]);
  assert.deepEqual([(await record(w, adopted.body.id)).subject, (await usage(w)).members], ["sam-sub", before]);
  const demoted = await w.idp(`/scim/v2/Users/${adopted.body.id}`, { method: "PATCH", body: { Operations: [{ op: "Replace", path: "roles", value: [{ value: "viewer" }] }] } });
  assert.equal(demoted.body.roles[0].value, "viewer");
  assert.equal((await members(w)).find((member) => member.subject === "sam-sub").role, "viewer", "a role change reaches the live membership");
  assert.equal((await sam(`${w.base}/test-suites`, { method: "POST", body: { name: "x", definition: {} } })).status, 403);
  await w.idp(`/scim/v2/Users/${adopted.body.id}`, { method: "PATCH", body: { Operations: [{ op: "Replace", path: "roles", value: [{ value: "engineer" }] }] } });
  assert.equal((await sam(`${w.base}/test-suites`, { method: "POST", body: { name: "x", definition: {} } })).status, 201);

  // A role sent at creation overrides the one the member has.
  const kay = await person(api, "kay-sub", "kay@example.com");
  await accept(kay, await invite("kay@example.com", "administrator"));
  assert.equal((await create(w, "kay@example.com", { roles: [{ value: "viewer" }] })).body.roles[0].value, "viewer");
  assert.equal((await members(w)).find((member) => member.subject === "kay-sub").role, "viewer");

  // Invited and accepted AFTER being provisioned: the record is not bound to them, but deactivating still removes them (same address).
  const robin = (await create(w, "robin@example.com", { roles: [{ value: "engineer" }] })).body;
  const robinClient = await person(api, "robin-sub", "robin@example.com");
  await accept(robinClient, await invite("robin@example.com", "engineer"));
  assert.equal((await robinClient(`${w.base}/test-suites`)).status, 200);
  assert.equal((await record(w, robin.id)).subject, null, "accepting an invitation does not bind");
  assert.equal((await deactivate(w, robin.id)).status, 200);
  assert.equal((await robinClient(`${w.base}/test-suites`)).status, 403, "the leaver is out although they came in by invitation");
  assert.ok(!(await members(w)).some((member) => member.subject === "robin-sub"));
  const gone = (await actions(w)).find((event) => event.action === "scim.user_deactivated");
  assert.equal(gone.details.membersRemoved, 1);

  // Provisioned as inactive while already a member: access is withdrawn straight away.
  const ivy = await person(api, "ivy-sub", "ivy@example.com");
  await accept(ivy, await invite("ivy@example.com", "viewer"));
  assert.equal((await create(w, "ivy@example.com", { active: false })).status, 201);
  assert.equal((await ivy(`${w.base}/test-suites`)).status, 403);
});

test("deactivating or deleting someone removes their access at once and ends their live streams on every instance", { skip }, async () => {
  const w = await provisioned("scim leavers");
  const leaver = (await create(w, "leaver@example.com", { roles: [{ value: "engineer" }] })).body;
  const bystander = (await create(w, "bystander@example.com", { roles: [{ value: "engineer" }] })).body;
  const leaverToken = await issuer.sign({ sub: "leaver-sub", email: "leaver@example.com" });
  const bystanderToken = await issuer.sign({ sub: "bystander-sub", email: "bystander@example.com" });
  const leaverClient = createClient(api.url, leaverToken);
  assert.equal((await leaverClient(`${w.base}/test-suites`)).status, 200);
  assert.equal((await createClient(api.url, bystanderToken)(`${w.base}/test-suites`)).status, 200);

  const leaverHere = await openStream(api, w, leaverToken);
  const leaverThere = await openStream(other, w, leaverToken);
  const bystanderThere = await openStream(other, w, bystanderToken);
  try {
    // The identity provider's call lands on the instance neither of the leaver's streams is on... for one of them.
    const response = await deactivate(w, leaver.id, w.idpOther);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.active, false);
    await waitFor(() => leaverHere.state.ended && leaverThere.state.ended, { message: "the leaver's streams on both instances to end" });
    assert.equal(bystanderThere.state.ended, false, "other people's streams are left alone");
    assert.equal((await leaverClient(`${w.base}/test-suites`)).status, 403);
    assert.equal((await leaverClient("/v1/workspaces")).status, 200);
    assert.deepEqual((await leaverClient("/v1/workspaces")).body, [], "and the workspace is gone from their list, and not re-bound");
    assert.equal((await openStreamStatus(api, w, leaverToken)), 403);
  } finally { leaverHere.close(); leaverThere.close(); bystanderThere.close(); }

  const removed = await record(w, leaver.id);
  assert.deepEqual([removed.active, removed.deactivated_at !== null, removed.subject], [false, true, "leaver-sub"]);
  assert.ok(!(await members(w)).some((member) => member.subject === "leaver-sub"));
  assert.deepEqual((await admin(`${w.base}/scim/users`)).body.find((row) => row.id === leaver.id).state, "deactivated");
  assert.equal((await deactivate(w, leaver.id)).status, 200, "deactivating twice is harmless");

  // Reactivation restores the same person with the role on record, and a seat is checked.
  assert.equal((await reactivate(w, leaver.id)).body.active, true);
  assert.equal((await leaverClient(`${w.base}/test-suites`)).status, 200);
  assert.equal((await members(w)).find((member) => member.subject === "leaver-sub").role, "engineer");

  // Deleting is the same for access, and the record goes too.
  const stream = await openStream(other, w, leaverToken);
  try {
    assert.equal((await w.idp(`/scim/v2/Users/${leaver.id}`, { method: "DELETE" })).status, 204);
    await waitFor(() => stream.state.ended, { message: "the stream of a deleted person to end" });
  } finally { stream.close(); }
  assert.equal((await leaverClient(`${w.base}/test-suites`)).status, 403);
  assert.equal(await record(w, leaver.id), undefined);
  assert.equal((await leaverClient("/v1/workspaces")).body.length, 0, "a deleted record cannot bind them again");
  assert.equal((await createClient(api.url, bystanderToken)(`${w.base}/test-suites`)).status, 200);
  assert.ok(bystander.id);

  // The workspace's own member removal ends streams too.
  const cleo = (await create(w, "cleo@example.com")).body;
  const cleoToken = await issuer.sign({ sub: "cleo-sub", email: "cleo@example.com" });
  assert.equal((await createClient(api.url, cleoToken)(`${w.base}/test-suites`)).status, 200);
  const cleoStream = await openStream(other, w, cleoToken);
  try {
    assert.equal((await admin(`${w.base}/members/cleo-sub`, { method: "DELETE" })).status, 204);
    await waitFor(() => cleoStream.state.ended, { message: "the stream of a removed member to end" });
  } finally { cleoStream.close(); }
  assert.ok(cleo.id);
});

async function openStreamStatus(instance, w, token) {
  const controller = new AbortController();
  try { return (await fetch(`${instance.url}${w.base}/test-jobs/stream`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal })).status; } finally { controller.abort(); }
}

test("the last administrator cannot be removed through provisioning, and seats are enforced", { skip }, async () => {
  const w = await provisioned("scim guards", { then: "free" });
  // dev-admin is the workspace's only administrator; the identity provider knows them as boss.
  const boss = (await create(w, "admin@wirepulse.local", { roles: [{ value: "administrator" }] })).body;
  assert.equal(boss.roles[0].value, "administrator");
  assert.equal((await record(w, boss.id)).subject, "dev-admin", "adopted by the address on their membership");
  for (const attempt of [() => deactivate(w, boss.id), () => w.idp(`/scim/v2/Users/${boss.id}`, { method: "DELETE" }), () => w.idp(`/scim/v2/Users/${boss.id}`, { method: "PATCH", body: { Operations: [{ op: "Replace", path: "roles", value: [{ value: "viewer" }] }] } })]) {
    const refused = await attempt();
    assert.deepEqual([refused.status, refused.body.detail], [409, "last_administrator"]);
  }
  assert.deepEqual((await members(w)).map((member) => [member.subject, member.role]), [["dev-admin", "administrator"]]);
  assert.equal((await admin(`${w.base}/test-suites`)).status, 200);
  assert.equal((await record(w, boss.id)).active, true, "and the record is unchanged");
  // With a second administrator the first can go.
  await pool.query("INSERT INTO workspace_members (workspace_id, subject, email, role) VALUES ($1, 'second-admin', 'second@example.com', 'administrator')", [w.id]);
  assert.equal((await deactivate(w, boss.id)).status, 200);
  assert.deepEqual((await members(w)).map((member) => member.subject), ["second-admin"]);
  const second = await person(api, "second-admin", "second@example.com");

  // Seats: the free plan has three; one is taken by the remaining administrator, provisioned people waiting count.
  assert.equal((await create(w, "a@example.com")).status, 201);
  assert.equal((await create(w, "b@example.com")).status, 201);
  const full = await create(w, "c@example.com");
  assert.deepEqual([full.status, full.body.scimType, full.body.detail], [403, undefined, "plan_limit_reached: members is limited to 3 on the free plan"]);
  const inactive = (await create(w, "c@example.com", { active: false }));
  assert.equal(inactive.status, 201, "someone without access needs no seat");
  const refused = await reactivate(w, inactive.body.id);
  assert.equal(refused.status, 403, "and gets one only when there is room");
  assert.equal((await record(w, inactive.body.id)).active, false);
  const a = (await w.idp(`/scim/v2/Users?filter=${encodeURIComponent('userName eq "a@example.com"')}`)).body.Resources[0];
  assert.equal((await deactivate(w, a.id)).status, 200);
  assert.equal((await reactivate(w, inactive.body.id)).status, 200, "a deactivation frees the seat");
  assert.equal((await usage(w, second)).members + (await usage(w, second)).pendingInvitations, 3);

  // Many at once cannot overshoot the plan.
  const crowd = await provisioned("scim crowd", { then: "free" });
  const created = await Promise.all(Array.from({ length: 8 }, (_, index) => create(crowd, `crowd${index}@example.com`)));
  assert.deepEqual(created.map((response) => response.status).sort(), [201, 201, 403, 403, 403, 403, 403, 403], "two seats were free");
  // The same person created twice at once is created once.
  const roomy = await provisioned("scim twins");
  const twins = await Promise.all(Array.from({ length: 6 }, () => create(roomy, "twin@example.com")));
  assert.deepEqual(twins.map((response) => response.status).sort(), [201, 409, 409, 409, 409, 409]);
  assert.equal((await roomy.idp("/scim/v2/Users")).body.totalResults, 1);
});

test("everything provisioning does is in the audit trail, attributed to the token, and the chain verifies", { skip }, async () => {
  const w = await provisioned("scim audit");
  const pat = (await create(w, "pat@example.com", { roles: [{ value: "engineer" }] })).body;
  await w.idp(`/scim/v2/Users/${pat.id}`, { method: "PATCH", body: { Operations: [{ op: "Replace", path: "displayName", value: "Pat" }] } });
  const patClient = await person(api, "pat-sub", "pat@example.com");
  await patClient(`${w.base}/test-suites`);
  await deactivate(w, pat.id);
  await reactivate(w, pat.id);
  await w.idp(`/scim/v2/Users/${pat.id}`, { method: "DELETE" });
  await create(w, "pat@example.com");
  await admin(`${w.base}/scim/tokens/${w.tokenId}`, { method: "DELETE" });

  const trail = await actions(w);
  const names = trail.map((event) => event.action).filter((action) => action.startsWith("scim"));
  assert.deepEqual(names, ["scim_token.created", "scim.user_provisioned", "scim.user_updated", "scim.member_bound", "scim.user_deactivated", "scim.user_reactivated", "scim.user_deleted", "scim.user_provisioned", "scim_token.revoked"]);
  for (const event of trail.filter((entry) => /^scim\.user_/.test(entry.action))) assert.equal(event.actor_subject, `scim:${w.tokenId}`, event.action);
  assert.equal(trail.find((event) => event.action === "scim.member_bound").actor_subject, "pat-sub");
  assert.equal(trail.find((event) => event.action === "scim_token.created").actor_subject, "dev-admin");
  assert.deepEqual(trail.find((event) => event.action === "scim.user_deactivated").details.changed, ["active"]);
  assert.ok(!JSON.stringify(trail).includes(w.token), "the token is never written to the trail");
  const verdict = (await pool.query("SELECT checked, first_bad_seq FROM wirepulse_audit_verify($1, 0, 100000)", [w.id])).rows[0];
  assert.equal(verdict.first_bad_seq, null);
  assert.equal((await admin(`${w.base}/audit/verify`)).body.valid, true);
});

test("one workspace's token reaches only its own people, and offboarding the workspace ends the token", { skip }, async () => {
  const a = await provisioned("scim tenant a");
  const b = await provisioned("scim tenant b");
  const inA = (await create(a, "same@example.com")).body;
  const inB = (await create(b, "same@example.com")).body;
  assert.notEqual(inA.id, inB.id);
  assert.equal((await a.idp(`/scim/v2/Users?filter=${encodeURIComponent('userName eq "same@example.com"')}`)).body.Resources[0].id, inA.id);
  assert.equal((await a.idp(`/scim/v2/Users/${inB.id}`)).status, 404);
  const samePerson = await person(api, "same-sub", "same@example.com");
  assert.deepEqual((await samePerson("/v1/workspaces")).body.map((workspace) => workspace.name), ["scim tenant a", "scim tenant b"]);
  assert.equal((await deactivate(a, inA.id)).status, 200);
  assert.deepEqual((await samePerson("/v1/workspaces")).body.map((workspace) => workspace.name), ["scim tenant b"], "deprovisioning in one workspace leaves the other alone");
  assert.equal((await samePerson(`${b.base}/test-suites`)).status, 200);
  assert.equal((await admin(`${b.base}?confirm=${encodeURIComponent("scim tenant b")}`, { method: "DELETE" })).status, 200);
  assert.equal((await b.idp("/scim/v2/Users")).status, 401);
  assert.equal((await b.idpOther("/scim/v2/Users")).status, 401);
});

test("a leaver's API keys die with their access, whichever way they are removed, and nobody else's do", { skip }, async () => {
  const w = await provisioned("scim keys");
  const keyOf = async (client, name) => {
    const response = await client(`${w.base}/api-keys`, { method: "POST", body: { name, role: "engineer" } });
    assert.equal(response.status, 201, response.text);
    return { id: response.body.id, client: createClient(api.url, response.body.token) };
  };
  const works = async (key) => (await key.client(`${w.base}/test-suites`)).status;
  const apiKeysIn = async (audit) => (await actions(w)).find((event) => event.action === audit)?.details.apiKeysRevoked ?? [];

  const stays = await keyOf(admin, "ci-stays");
  // Three administrators, each of whom makes a key; each leaves a different way.
  const leavers = {};
  for (const name of ["deactivated", "deleted", "removed"]) {
    const record = (await create(w, `${name}@example.com`, { roles: [{ value: "administrator" }] })).body;
    const client = await person(api, `${name}-sub`, `${name}@example.com`);
    leavers[name] = { record, first: await keyOf(client, `${name}-1`), second: await keyOf(client, `${name}-2`) };
  }
  for (const { first, second } of Object.values(leavers)) assert.deepEqual([await works(first), await works(second)], [200, 200]);

  // Deactivated in the identity provider.
  assert.equal((await deactivate(w, leavers.deactivated.record.id)).status, 200);
  assert.deepEqual([await works(leavers.deactivated.first), await works(leavers.deactivated.second)], [401, 401]);
  assert.deepEqual((await apiKeysIn("scim.user_deactivated")).sort(), [leavers.deactivated.first.id, leavers.deactivated.second.id].sort());
  // Coming back restores their access, not the credentials they made: those stay revoked.
  assert.equal((await reactivate(w, leavers.deactivated.record.id)).status, 200);
  assert.equal(await works(leavers.deactivated.first), 401);

  // Deleted in the identity provider.
  assert.equal((await w.idp(`/scim/v2/Users/${leavers.deleted.record.id}`, { method: "DELETE" })).status, 204);
  assert.deepEqual([await works(leavers.deleted.first), await works(leavers.deleted.second)], [401, 401]);
  assert.equal((await apiKeysIn("scim.user_deleted")).length, 2);

  // Removed by an administrator in the console, which is not provisioning.
  assert.equal((await admin(`${w.base}/members/removed-sub`, { method: "DELETE" })).status, 204);
  assert.deepEqual([await works(leavers.removed.first), await works(leavers.removed.second)], [401, 401]);
  assert.equal((await apiKeysIn("member.removed")).length, 2);

  assert.equal(await works(stays), 200, "a key made by someone who is still here is left alone");
  const revoked = (await pool.query("SELECT count(*)::int AS n FROM api_keys WHERE workspace_id = $1 AND revoked_at IS NOT NULL", [w.id])).rows[0].n;
  assert.equal(revoked, 6);
  assert.equal((await admin(`${w.base}/audit/verify`)).body.valid, true);
});

const SEARCH = "urn:ietf:params:scim:api:messages:2.0:SearchRequest";

test("discovery documents are read-only, and users can be narrowed with attributes or searched with a body", { skip }, async () => {
  const w = await provisioned("scim discovery");
  const neighbour = await provisioned("scim discovery neighbour");
  const pat = (await create(w, "pat@example.com", { externalId: "okta-1", displayName: "Pat Doe", name: { givenName: "Pat", familyName: "Doe" }, roles: [{ value: "engineer" }] })).body;
  await create(w, "lee@example.com", { displayName: "Lee" });
  const keys = (body) => Object.keys(body).sort();

  // A single discovery document is fetched by its id, which is a name or a URN rather than a UUID; an unknown id is a 404.
  const type = await w.idp("/scim/v2/ResourceTypes/User");
  assert.deepEqual([type.status, type.body.endpoint], [200, "/Users"]);
  const groupType = await w.idp("/scim/v2/ResourceTypes/Group");
  assert.deepEqual([groupType.status, groupType.body.endpoint], [200, "/Groups"]);
  const schema = await w.idp(`/scim/v2/Schemas/${USER}`);
  assert.deepEqual([schema.status, schema.body.id], [200, USER]);
  const groupSchema = await w.idp(`/scim/v2/Schemas/${GROUP}`);
  assert.deepEqual([groupSchema.status, groupSchema.body.id], [200, GROUP]);
  assert.deepEqual((await w.idp("/scim/v2/Schemas")).body.Resources.map((entry) => entry.id), [USER, GROUP]);
  for (const missing of ["/scim/v2/ResourceTypes/Nope", "/scim/v2/Schemas/urn:nope"]) assert.equal((await w.idp(missing)).status, 404, missing);

  // They cannot be written: 405 with Allow, but only for a caller who got past authentication.
  for (const [method, path] of [["POST", "/scim/v2/Schemas"], ["PUT", "/scim/v2/ResourceTypes/User"], ["DELETE", `/scim/v2/Schemas/${USER}`], ["PATCH", "/scim/v2/ServiceProviderConfig"]]) {
    const refused = await w.idp(path, { method, body: {} });
    assert.deepEqual([refused.status, refused.headers.get("allow"), refused.body.status], [405, "GET", "405"], `${method} ${path}`);
    assert.equal((await createClient(api.url, "wps_not-a-token")(path, { method, body: {} })).status, 401, `${method} ${path} without a valid token`);
  }

  // attributes keeps the named attributes (and always the id and schemas); excludedAttributes drops them; attributes wins when both are sent.
  const one = (query) => w.idp(`/scim/v2/Users/${pat.id}?${query}`);
  const narrowed = await one("attributes=userName,name.givenName");
  assert.deepEqual([keys(narrowed.body), narrowed.body.name], [["id", "name", "schemas", "userName"], { givenName: "Pat" }]);
  assert.deepEqual(keys((await one("attributes=USERNAME")).body), ["id", "schemas", "userName"], "names are case-insensitive");
  assert.deepEqual(keys((await one(`attributes=${USER}:displayName`)).body), ["displayName", "id", "schemas"], "a schema-qualified name is accepted");
  const without = (await one("excludedAttributes=roles,emails,name.familyName")).body;
  assert.deepEqual([without.roles, without.emails, without.name, without.userName], [undefined, undefined, { givenName: "Pat" }, "pat@example.com"]);
  assert.deepEqual(keys((await one("attributes=userName&excludedAttributes=userName")).body), ["id", "schemas", "userName"]);
  assert.deepEqual(keys((await one("")).body), keys(pat), "without either parameter nothing is removed");
  const listed = (await w.idp("/scim/v2/Users?attributes=userName")).body;
  assert.deepEqual([listed.totalResults, ...listed.Resources.map((entry) => keys(entry).join())], [2, "id,schemas,userName", "id,schemas,userName"]);

  // The same list as a POST, at the Users endpoint and at the root; identity providers send it as scim+json.
  for (const path of ["/scim/v2/Users/.search", "/scim/v2/.search"]) {
    const found = await w.idp(path, { method: "POST", headers: { "content-type": SCIM }, body: { schemas: [SEARCH], filter: 'userName eq "pat@example.com"', attributes: ["userName"] } });
    assert.equal(found.status, 200, found.text);
    assert.equal(found.headers.get("content-type").split(";")[0], SCIM);
    assert.deepEqual([found.body.totalResults, found.body.Resources.map(keys), found.body.Resources[0].id], [1, [["id", "schemas", "userName"]], pat.id], path);
    const page = (await w.idp(path, { method: "POST", body: { startIndex: 2, count: 1 } })).body;
    assert.deepEqual([page.totalResults, page.startIndex, page.itemsPerPage], [2, 2, 1], path);
    assert.deepEqual((await w.idp(path, { method: "POST", body: { count: 0 } })).body.Resources, [], path);
    assert.equal((await w.idp(path, { method: "POST", body: {} })).body.totalResults, 2, "an empty search lists everyone");
    const badFilter = await w.idp(path, { method: "POST", body: { filter: "displayName sw P" } });
    assert.deepEqual([badFilter.status, badFilter.body.scimType], [400, "invalidFilter"], path);
    assert.equal((await w.idp(path, { method: "POST", body: { count: "1" } })).status, 400, "a string where a number belongs is refused");
    assert.equal((await neighbour.idp(path, { method: "POST", body: { filter: 'userName eq "pat@example.com"' } })).body.totalResults, 0, "another workspace's token finds nobody here");
    assert.equal((await createClient(api.url, "wps_not-a-token")(path, { method: "POST", body: {} })).status, 401, path);
  }
});

test("the soonest SCIM token expiry is exported for alerting, and revoked tokens are not counted", { skip }, async () => {
  const gauge = async () => /^wirepulse_scim_token_seconds_to_expiry (\S+)$/m.exec(await (await fetch(`${api.url}/metrics`)).text())?.[1];
  await pool.query("UPDATE scim_tokens SET revoked_at = now() WHERE revoked_at IS NULL"); // earlier tests left tokens of their own
  assert.equal(await gauge(), "+Inf", "with no token nothing is about to expire");

  const w = await provisioned("scim expiry gauge");
  const second = (await admin(`${w.base}/scim/tokens`, { method: "POST", body: { name: "second", expiresInDays: 300 } })).body;
  assert.ok(second.id, "the second token was issued");
  await pool.query("UPDATE scim_tokens SET expires_at = now() + interval '3 hours' WHERE id = $1", [w.tokenId]);
  const hours = Number(await gauge()) / 3600;
  assert.ok(hours > 2.9 && hours <= 3, `expected about 3 hours, got ${hours}`);

  await pool.query("UPDATE scim_tokens SET expires_at = now() - interval '1 hour' WHERE id = $1", [w.tokenId]);
  assert.ok(Number(await gauge()) < 0, "an expired token that was never revoked shows as negative");

  assert.equal((await admin(`${w.base}/scim/tokens/${w.tokenId}`, { method: "DELETE" })).status, 204);
  const days = Number(await gauge()) / 86400;
  assert.ok(days > 299 && days <= 300, `with the lapsed token revoked the other one counts, got ${days}`);
  assert.equal((await admin(`${w.base}/scim/tokens/${second.id}`, { method: "DELETE" })).status, 204);
  assert.equal(await gauge(), "+Inf", "nothing left, so no stale value");
});

test("a NUL character in a provisioned attribute, or in a filter, is an invalid value, not a server error", { skip }, async () => {
  // PostgreSQL text cannot hold U+0000; an identity provider that sends one must be told it is its mistake (400), not retry a 500.
  const w = await provisioned("scim nul");
  const nul = "a\u0000b";
  for (const [what, response] of Object.entries({
    "displayName on create": await create(w, "nul@example.com", { displayName: nul }),
    "externalId on create": await create(w, "nul2@example.com", { externalId: nul }),
    "a filter value": await w.idp(`/scim/v2/Users?filter=${encodeURIComponent(`userName eq "${nul}"`)}`)
  })) assert.deepEqual([response.status, response.body.schemas[0]], [400, "urn:ietf:params:scim:api:messages:2.0:Error"], what);
  assert.equal((await w.idp("/scim/v2/Users")).body.totalResults, 0, "nothing was created");
});
