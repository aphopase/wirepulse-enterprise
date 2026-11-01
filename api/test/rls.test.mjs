// Row-level security (migration 008): the database confines request handlers to the caller's workspace, as a second barrier behind the
// application's own checks. These tests go at the database directly, so they prove the barrier without relying on the handlers being right.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";
import { createAuth } from "../src/auth.mjs";
import { checkRowLevelSecurity } from "../src/db.mjs";
import { ADMIN_URL, DEV_TOKEN, createClient, createTestDatabase, skip, startApi, ws } from "./helpers.mjs";
import { spawn } from "node:child_process";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

let database; let api; let admin; let a; let b;
const profile = (name) => ({ name, definition: { settings: { baud: "115200" } } });

async function seed() {
  database = await createTestDatabase();
  api = await startApi({ databaseUrl: database.url });
  admin = createClient(api.url, DEV_TOKEN);
  // Two workspaces, each with a shared profile, created through the API.
  a = (await admin("/v1/workspaces", { method: "POST", body: { name: "Alpha" } })).body.id;
  b = (await admin("/v1/workspaces", { method: "POST", body: { name: "Beta" } })).body.id;
  for (const [id, name] of [[a, "alpha-profile"], [b, "beta-profile"]]) assert.equal((await admin(`${ws(id)}/profiles`, { method: "POST", body: profile(name) })).status, 201);
}

test.before(async () => { if (!skip) await seed(); });
test.after(async () => { await api?.stop(); await database?.drop(); });

const db = () => api.restricted;
const names = (result) => result.rows.map((row) => row.name).sort();

test("the suite really runs on the restricted role: inside a workspace the session is wirepulse_app with that workspace named", { skip }, async () => {
  assert.equal(api.config.db.rowLevelSecurity, true);
  assert.equal(db().rowLevelSecurity, true);
  const inside = await db().inWorkspace(a, () => db().query("SELECT current_user AS who, current_setting('app.workspace_id') AS workspace"));
  assert.deepEqual(inside.rows[0], { who: "wirepulse_app", workspace: a });
  const system = await api.db.query("SELECT current_user AS who");
  assert.notEqual(system.rows[0].who, "wirepulse_app", "the unrestricted path is the connecting role");
});

test("a query with no workspace filter at all sees only the caller's workspace, in every table that holds workspace data", { skip }, async () => {
  const profiles = await db().inWorkspace(a, () => db().query("SELECT name FROM shared_profiles"));
  assert.deepEqual(names(profiles), ["alpha-profile"]);
  assert.deepEqual(names(await db().inWorkspace(b, () => db().query("SELECT name FROM shared_profiles"))), ["beta-profile"]);
  assert.deepEqual((await db().inWorkspace(a, () => db().query("SELECT id FROM workspaces"))).rows.map((row) => row.id), [a]);
  assert.equal((await api.db.query("SELECT count(*)::int AS n FROM shared_profiles")).rows[0].n, 2, "both rows exist");
  // Every table the migration protects answers the same way: no row of another workspace, and nothing at all outside a workspace.
  const tables = (await api.db.query("SELECT c.relname FROM pg_class c JOIN pg_policy p ON p.polrelid = c.oid ORDER BY 1")).rows.map((row) => row.relname);
  assert.equal(tables.length, 19);
  for (const table of tables) {
    const own = table === "workspaces" ? "id" : "workspace_id";
    const foreign = await db().inWorkspace(a, () => db().query(`SELECT count(*)::int AS n FROM ${table} WHERE ${own} <> $1`, [a]));
    assert.equal(foreign.rows[0].n, 0, `${table}: nothing of another workspace is visible`);
    const nowhere = await db().query(`SELECT count(*)::int AS n FROM ${table}`);
    assert.equal(nowhere.rows[0].n, 0, `${table}: outside any workspace nothing is visible (fail closed)`);
  }
});

test("writes are confined too: another workspace's rows cannot be changed, deleted or inserted", { skip }, async () => {
  const foreign = (await api.db.query("SELECT id FROM shared_profiles WHERE workspace_id = $1", [b])).rows[0].id;
  const update = await db().inWorkspace(a, () => db().query("UPDATE shared_profiles SET name = 'hijacked' WHERE id = $1", [foreign]));
  assert.equal(update.rowCount, 0);
  const remove = await db().inWorkspace(a, () => db().query("DELETE FROM shared_profiles WHERE id = $1", [foreign]));
  assert.equal(remove.rowCount, 0);
  await assert.rejects(
    db().inWorkspace(a, () => db().query("INSERT INTO shared_profiles (workspace_id, name, definition, created_by, updated_by) VALUES ($1, 'planted', '{}', 'x', 'x')", [b])),
    (error) => error.code === "42501" && /row-level security/.test(error.message)
  );
  // Nor can a row be moved out of the caller's own workspace.
  await assert.rejects(db().inWorkspace(a, () => db().query("UPDATE shared_profiles SET workspace_id = $1", [b])), (error) => error.code === "42501");
  assert.equal((await api.db.query("SELECT name FROM shared_profiles WHERE id = $1", [foreign])).rows[0].name, "beta-profile");
  assert.equal((await api.db.query("SELECT count(*)::int AS n FROM shared_profiles WHERE name = 'planted'")).rows[0].n, 0);
});

test("transactions are confined the same way, and the workspace never outlives the transaction on a pooled connection", { skip }, async () => {
  const inside = await db().inWorkspace(a, () => db().transaction(async (client) => {
    const first = (await client.query("SELECT name FROM shared_profiles")).rows.map((row) => row.name);
    const second = (await client.query("SELECT name FROM shared_profiles")).rows.map((row) => row.name);
    return [first, second];
  }));
  assert.deepEqual(inside, [["alpha-profile"], ["alpha-profile"]]);
  // The pool has five connections. Alternate scoped and unscoped work well past that: an unscoped query must never see a left-over workspace.
  for (let i = 0; i < 40; i += 1) {
    if (i % 2 === 0) await db().inWorkspace(i % 4 === 0 ? a : b, () => db().query("SELECT 1"));
    else assert.equal((await db().query("SELECT count(*)::int AS n FROM shared_profiles")).rows[0].n, 0, `unscoped query ${i} saw rows`);
  }
  // Concurrent requests for two workspaces on one pool do not see each other's rows.
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => {
    const id = i % 2 ? a : b;
    return db().inWorkspace(id, async () => { await new Promise((resolve) => { setTimeout(resolve, i % 3); }); return [id, names(await db().query("SELECT name FROM shared_profiles"))]; });
  }));
  for (const [id, seen] of results) assert.deepEqual(seen, [id === a ? "alpha-profile" : "beta-profile"]);
  // A failed transaction rolls the role back as well.
  await assert.rejects(db().inWorkspace(a, () => db().transaction(async (client) => { await client.query("SELECT 1"); throw new Error("boom"); })), /boom/);
  assert.equal((await api.db.query("SELECT current_user AS who")).rows[0].who === "wirepulse_app", false);
});

test("the workspace id is validated before it reaches a statement", { skip }, async () => {
  for (const bad of ["", "not-a-uuid", `${a}'; DROP TABLE workspaces; --`, null, undefined, 7]) assert.throws(() => db().inWorkspace(bad, () => {}), /needs a workspace id/);
  assert.equal((await api.db.query("SELECT to_regclass('public.workspaces') IS NOT NULL AS present")).rows[0].present, true);
});

test("a handler that forgets its workspace filter leaks nothing: the same route, no WHERE clause, other workspaces' rows stay out", { skip }, async () => {
  // A deliberately careless route: it reads every profile and filters nothing. Authentication and the workspace scope are the real ones.
  const auth = createAuth({ config: { production: false, dev: api.config.dev, oidc: null }, db: db(), log: api.log, metrics: null });
  const app = express();
  app.use("/v1", auth.identity);
  app.get("/v1/workspaces/:workspaceId/careless", auth.requireRole("viewer"), async (_req, res, next) => {
    try { res.json((await db().query("SELECT name FROM shared_profiles")).rows.map((row) => row.name)); } catch (error) { next(error); }
  });
  const server = http.createServer(app);
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  try {
    const careless = createClient(`http://127.0.0.1:${server.address().port}`, DEV_TOKEN);
    assert.deepEqual((await careless(`${ws(a)}/careless`)).body, ["alpha-profile"]);
    assert.deepEqual((await careless(`${ws(b)}/careless`)).body, ["beta-profile"]);
    // The same careless query on the unrestricted connection shows what the barrier is holding back.
    assert.deepEqual(names(await api.db.query("SELECT name FROM shared_profiles")), ["alpha-profile", "beta-profile"]);
  } finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); }
});

test("the unrestricted path is used only where a request has no workspace yet", () => {
  // A guard against the barrier being quietly bypassed: only these files may reach for db.system / system.query. Adding one is a conscious
  // decision (update this list in the same change, with the reason).
  const allowed = {
    "app.mjs": "builds system and hands it to the background workers and metrics",
    "auth.mjs": "credential lookups happen before the workspace is known",
    "admin.mjs": "creating and listing workspaces, answering invitations",
    "server.mjs": "migrations and the start-up check"
  };
  const users = fs.readdirSync(SRC).filter((name) => name.endsWith(".mjs") && name !== "db.mjs" && /\bdb\.system\b|\bsystem\.(query|transaction)\b|\bsystem\b\s*=\s*db/.test(fs.readFileSync(path.join(SRC, name), "utf8")));
  for (const name of users) assert.ok(name in allowed, `${name} uses the unrestricted database path; if that is intended, add it here with the reason`);
  for (const name of Object.keys(allowed)) assert.ok(users.includes(name), `${name} no longer uses it; remove it from the list`);
});

test("start-up check: passes on a proper database and names what is wrong when it is not", { skip }, async () => {
  assert.deepEqual(await checkRowLevelSecurity(api.db), []);
  // A table that holds workspace data and has no policy.
  await api.db.query("CREATE TABLE rogue_notes (id serial PRIMARY KEY, workspace_id uuid NOT NULL)");
  try {
    const problems = await checkRowLevelSecurity(api.db);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /row-level security is off on: rogue_notes/);
  } finally { await api.db.query("DROP TABLE rogue_notes"); }
  // A protected table whose protection was switched off.
  await api.db.query("ALTER TABLE gateways DISABLE ROW LEVEL SECURITY");
  try { assert.match((await checkRowLevelSecurity(api.db)).join("\n"), /row-level security is off on: gateways/); } finally { await api.db.query("ALTER TABLE gateways ENABLE ROW LEVEL SECURITY"); }
  assert.deepEqual(await checkRowLevelSecurity(api.db), []);
});

test("start-up check: a connecting role that is not the owner (its own lookups would be filtered) or cannot become the restricted role is refused", { skip }, async () => {
  const role = `rls_probe_${Math.random().toString(16).slice(2, 10)}`;
  const adminClient = new pg.Client({ connectionString: ADMIN_URL });
  await adminClient.connect();
  let probe;
  try {
    await adminClient.query(`CREATE ROLE ${role} LOGIN PASSWORD 'probe-pw'`);
    await adminClient.query(`GRANT CONNECT ON DATABASE ${new URL(database.url).pathname.slice(1)} TO ${role}`);
    const url = new URL(database.url); url.username = role; url.password = "probe-pw";
    probe = new pg.Client({ connectionString: url.toString() });
    await probe.connect();
    const executor = { query: (text, values) => probe.query(text, values), async transaction(fn) { await probe.query("BEGIN"); try { const out = await fn(probe); await probe.query("COMMIT"); return out; } catch (error) { await probe.query("ROLLBACK"); throw error; } } };
    const problems = await checkRowLevelSecurity(executor);
    assert.ok(problems.some((line) => /neither owns the tables nor bypasses/.test(line)), problems.join("\n"));
    assert.ok(problems.some((line) => /cannot switch to wirepulse_app/.test(line)), problems.join("\n"));
  } finally {
    await probe?.end();
    await adminClient.query(`REVOKE CONNECT ON DATABASE ${new URL(database.url).pathname.slice(1)} FROM ${role}`);
    await adminClient.query(`DROP ROLE IF EXISTS ${role}`);
    await adminClient.end();
  }
});

test("migration 009: a role that created wirepulse_app without being a superuser (member with ADMIN OPTION only, PostgreSQL 16) gets the SET option", { skip }, async () => {
  const role = `rls_creator_${Math.random().toString(16).slice(2, 10)}`;
  const adminClient = new pg.Client({ connectionString: ADMIN_URL });
  await adminClient.connect();
  let probe;
  try {
    if (Number((await adminClient.query("SHOW server_version_num")).rows[0].server_version_num) < 160000) return; // before 16 membership alone is enough
    await adminClient.query(`CREATE ROLE ${role} LOGIN PASSWORD 'probe-pw'`);
    await adminClient.query(`GRANT wirepulse_app TO ${role} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`); // what CREATE ROLE by a CREATEROLE user leaves behind
    const url = new URL(ADMIN_URL); url.username = role; url.password = "probe-pw";
    probe = new pg.Client({ connectionString: url.toString() });
    await probe.connect();
    const canSwitch = async () => { try { await probe.query("BEGIN"); await probe.query("SET LOCAL ROLE wirepulse_app"); return true; } catch { return false; } finally { await probe.query("ROLLBACK"); } };
    assert.equal(await canSwitch(), false, "the setup must reproduce the refusal");
    const sql = fs.readFileSync(path.join(SRC, "..", "migrations", "009_app_role_set_option.sql"), "utf8");
    await probe.query(sql);
    assert.equal(await canSwitch(), true);
    await probe.query(sql); // already granted: nothing to do, no error
  } finally {
    await probe?.end();
    await adminClient.query(`DROP ROLE IF EXISTS ${role}`);
    await adminClient.end();
  }
});

test("start-up: the server refuses to run when the barrier is missing, and runs without it only when told to", { skip }, async () => {
  const fresh = await createTestDatabase();
  const run = (extra) => {
    const child = spawn(process.execPath, [path.join(SRC, "server.mjs")], { env: { PATH: process.env.PATH, DATABASE_URL: fresh.url, PORT: "0", DEV_BEARER_TOKEN: DEV_TOKEN, LOG_LEVEL: "info", ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    return { child, output: () => output, exited: new Promise((resolve) => { child.on("exit", (code) => resolve({ code, output })); }) };
  };
  try {
    // Migrate, then take the protection off one table behind the migration's back.
    const first = run({}); // migrates on start and listens
    await new Promise((resolve) => { const t = setInterval(() => { if (/WirePulse API listening/.test(first.output())) { clearInterval(t); resolve(); } }, 50); });
    first.child.kill("SIGTERM"); await first.exited;
    const client = new pg.Client({ connectionString: fresh.url }); await client.connect();
    await client.query("ALTER TABLE webhooks DISABLE ROW LEVEL SECURITY"); await client.end();

    const refused = await run({ MIGRATE_ON_START: "false" }).exited;
    assert.equal(refused.code, 1);
    assert.match(refused.output, /row-level security is not in place/); assert.match(refused.output, /off on: webhooks/);

    const optedOut = run({ MIGRATE_ON_START: "false", DB_ROW_LEVEL_SECURITY: "false" });
    await new Promise((resolve) => { const t = setInterval(() => { if (/WirePulse API listening/.test(optedOut.output())) { clearInterval(t); resolve(); } }, 50); });
    assert.match(optedOut.output(), /DB_ROW_LEVEL_SECURITY=false: only the application's own workspace checks separate tenants/);
    optedOut.child.kill("SIGTERM"); assert.equal((await optedOut.exited).code, 0);
  } finally { await fresh.drop(); }
});

test("with DB_ROW_LEVEL_SECURITY=false the API behaves the same for a legitimate caller, and the database does not filter", { skip }, async () => {
  const plainDb = await createTestDatabase();
  const plain = await startApi({ databaseUrl: plainDb.url, env: { DB_ROW_LEVEL_SECURITY: "false" } });
  try {
    assert.equal(plain.restricted.rowLevelSecurity, false);
    const client = createClient(plain.url, DEV_TOKEN);
    const id = (await client("/v1/workspaces", { method: "POST", body: { name: "Plain" } })).body.id;
    assert.equal((await client(`${ws(id)}/profiles`, { method: "POST", body: profile("p") })).status, 201);
    assert.equal((await client(`${ws(id)}/profiles`)).body.length, 1);
    assert.equal((await plain.restricted.query("SELECT count(*)::int AS n FROM shared_profiles")).rows[0].n, 1, "no database-level filtering when it is switched off");
  } finally { await plain.stop(); await plainDb.drop(); }
});

test("the people and machines the API serves are unaffected: an API key sees only its own workspace", { skip }, async () => {
  const intruder = createClient(api.url, "intruder-token-not-valid");
  assert.equal((await intruder(`${ws(a)}/profiles`)).status, 401);
  const key = (await admin(`${ws(a)}/api-keys`, { method: "POST", body: { name: "ci", role: "viewer" } })).body;
  const keyClient = createClient(api.url, key.token);
  assert.deepEqual((await keyClient(`${ws(a)}/profiles`)).body.map((row) => row.name), ["alpha-profile"]);
  assert.equal((await keyClient(`${ws(b)}/profiles`)).status, 403, "a key is bound to its own workspace");
  assert.deepEqual((await keyClient("/v1/workspaces")).body.map((row) => row.id), [a]);
});
