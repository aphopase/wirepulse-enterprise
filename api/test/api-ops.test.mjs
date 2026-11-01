import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createApp } from "../src/app.mjs";
import { createDatabase } from "../src/db.mjs";
import { MigrationError, migrate } from "../src/migrate.mjs";
import { DEV_TOKEN, MIGRATION_NAMES, createClient, createTestDatabase, skip, sleep, startApi, startIssuer, waitFor, ws } from "./helpers.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let database; let issuer; let pool; let admin; let primary; let workspaceId;
const apps = [];
const launch = async (env = {}) => { const app = await startApi({ databaseUrl: database.url, issuer, env }); apps.push(app); return app; };
const metricsText = (app) => app.instance.metrics.registry.metrics();
const freePort = () => new Promise((resolve, reject) => { const probe = net.createServer(); probe.once("error", reject); probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });

// Runs a script (server or CLI) as a child process with a minimal environment and collects its output.
function run(script, args, env, { signalAfter, timeoutMs = 20_000 } = {}) {
  const child = spawn(process.execPath, [path.join(root, "src", script), ...args], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
  return { child, exited, output: () => output };
}

test.before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  issuer = await startIssuer();
  pool = new pg.Pool({ connectionString: database.url, max: 3 });
  primary = await launch();
  admin = createClient(primary.url, DEV_TOKEN);
  workspaceId = (await admin("/v1/workspaces", { method: "POST", body: { name: "ops" } })).body.id;
});
test.after(async () => {
  for (const app of apps) await app.stop().catch(() => {});
  await pool?.end(); await issuer?.stop(); await database?.drop();
});

test("per-subject limit throttles one identity without affecting another", { skip }, async () => {
  const app = await launch({ RATE_LIMIT_PER_MINUTE: "5" });
  const first = createClient(app.url, DEV_TOKEN);
  const statuses = []; for (let i = 0; i < 7; i += 1) statuses.push((await first("/v1/workspaces")).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
  const limited = await first("/v1/workspaces");
  assert.equal(limited.body.error, "rate_limited"); assert.ok(limited.body.requestId); assert.ok(limited.headers.get("ratelimit"), "standard RateLimit header present");
  assert.equal((await createClient(app.url, await issuer.sign({ sub: "someone-else" }))("/v1/workspaces")).status, 200);
  assert.match(await metricsText(app), /wirepulse_rate_limited_total\{limiter="subject"\} [1-9]/);
  assert.ok(app.logEntries().some((entry) => entry.security === true && entry.event === "rate_limited" && entry.limiter === "subject" && entry.subject === "dev-admin"));
});

test("per-IP limit covers anonymous traffic but never the health probes", { skip }, async () => {
  const app = await launch({ RATE_LIMIT_IP_PER_MINUTE: "4" });
  const anonymous = createClient(app.url);
  for (let i = 0; i < 20; i += 1) assert.equal((await anonymous("/healthz")).status, 200);
  for (let i = 0; i < 20; i += 1) assert.equal((await anonymous("/readyz")).status, 200);
  const statuses = []; for (let i = 0; i < 6; i += 1) statuses.push((await anonymous("/v1/workspaces")).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 429, 429]);
  assert.equal((await anonymous("/healthz")).status, 200, "probes stay reachable while an IP is throttled");
});

test("credential guessing is throttled; valid traffic is not counted", { skip }, async () => {
  const app = await launch({ AUTH_FAILURE_LIMIT_PER_MINUTE: "3" });
  const client = createClient(app.url, DEV_TOKEN);
  for (let i = 0; i < 12; i += 1) assert.equal((await client("/v1/workspaces")).status, 200, "successful requests never consume the failure budget");
  const bad = []; for (let i = 0; i < 5; i += 1) bad.push((await client("/v1/workspaces", { token: `wrong-token-${i}` })).status);
  assert.deepEqual(bad, [401, 401, 401, 429, 429]);
  assert.match(await metricsText(app), /wirepulse_rate_limited_total\{limiter="auth_failure"\} [1-9]/);
  // Gateway credentials share the same budget per client address.
  assert.equal((await createClient(app.url)("/gateway/v1/heartbeat", { method: "POST", token: "wpg_guess-guess-guess" })).status, 429);
});

test("a burst of valid requests, larger than the failure budget, is not mistaken for credential guessing", { skip }, async () => {
  const app = await launch({ AUTH_FAILURE_LIMIT_PER_MINUTE: "3" });
  const client = createClient(app.url, DEV_TOKEN);
  // The budget is for rejected credentials; forty requests in flight at once, all valid, must not touch it (they used to, and a
  // gateway fleet or CI runner behind one address locked itself out).
  const burst = await Promise.all(Array.from({ length: 40 }, () => client("/v1/workspaces")));
  assert.deepEqual(burst.map((response) => response.status), Array(40).fill(200));
  const gateway = (await client(`${ws(workspaceId)}/gateways`, { method: "POST", body: { name: "burst-gw" } })).body;
  const heartbeats = await Promise.all(Array.from({ length: 40 }, () => createClient(app.url, gateway.token)("/gateway/v1/heartbeat", { method: "POST", body: {} })));
  assert.deepEqual(heartbeats.map((response) => response.status), Array(40).fill(200));
  const bad = []; for (let i = 0; i < 5; i += 1) bad.push(await client("/v1/workspaces", { token: `wrong-token-${i}` }));
  assert.deepEqual(bad.map((response) => response.status), [401, 401, 401, 429, 429], "real failures still lock the address");
  assert.ok(Number(bad[3].headers.get("retry-after")) >= 1, "and the refusal says when to come back");
  assert.equal((await client("/v1/workspaces", { token: "wpk_never-seen-before" })).status, 429, "a locked address still refuses credentials it has not seen");
});

test("a locked address still serves the credentials this replica verified, so one guesser does not lock out a shared office address", { skip }, async () => {
  const app = await launch({ AUTH_FAILURE_LIMIT_PER_MINUTE: "3" });
  const colleague = createClient(app.url, await issuer.sign({ sub: "colleague" }));
  const stranger = createClient(app.url, await issuer.sign({ sub: "not-yet-seen" }));
  const operator = createClient(app.url, DEV_TOKEN);
  const gateway = (await operator(`${ws(workspaceId)}/gateways`, { method: "POST", body: { name: "nat-gw" } })).body;
  const key = (await operator(`${ws(workspaceId)}/api-keys`, { method: "POST", body: { name: "nat-key", role: "viewer" } })).body;
  assert.equal((await colleague("/v1/workspaces")).status, 200);
  assert.equal((await createClient(app.url, gateway.token)("/gateway/v1/heartbeat", { method: "POST", body: {} })).status, 200);
  assert.equal((await createClient(app.url, key.token)(`${ws(workspaceId)}/gateways`)).status, 200);

  const guesses = []; for (let i = 0; i < 5; i += 1) guesses.push((await colleague("/v1/workspaces", { token: `guess-${i}` })).status);
  assert.deepEqual(guesses, [401, 401, 401, 429, 429], "the address is locked by the guesser");

  assert.equal((await colleague("/v1/workspaces")).status, 200, "a signed-in colleague on the same address is not");
  assert.equal((await operator("/v1/workspaces")).status, 200);
  assert.equal((await createClient(app.url, gateway.token)("/gateway/v1/heartbeat", { method: "POST", body: {} })).status, 200, "nor is a gateway behind it");
  assert.equal((await createClient(app.url, key.token)(`${ws(workspaceId)}/gateways`)).status, 200, "nor an API key");
  assert.equal((await stranger("/v1/workspaces")).status, 429, "a valid credential this replica has not verified yet waits out the window like any other");
  assert.equal((await colleague("/v1/workspaces", { token: "guess-again" })).status, 429, "and the guesser stays locked");

  // The shortcut skips only the throttle: a credential revoked after it was cached fails the real check, and is counted as a failure.
  assert.equal((await operator(`${ws(workspaceId)}/api-keys/${key.id}`, { method: "DELETE" })).status < 300, true);
  assert.equal((await createClient(app.url, key.token)(`${ws(workspaceId)}/gateways`)).status, 401);
});

test("each gateway has its own request budget", { skip }, async () => {
  const app = await launch({ GATEWAY_RATE_LIMIT_PER_MINUTE: "3" });
  const operator = createClient(app.url, DEV_TOKEN);
  const one = (await operator(`${ws(workspaceId)}/gateways`, { method: "POST", body: { name: "rl-1" } })).body;
  const two = (await operator(`${ws(workspaceId)}/gateways`, { method: "POST", body: { name: "rl-2" } })).body;
  const first = createClient(app.url, one.token); const second = createClient(app.url, two.token);
  const statuses = []; for (let i = 0; i < 5; i += 1) statuses.push((await first("/gateway/v1/heartbeat", { method: "POST", body: {} })).status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  assert.equal((await second("/gateway/v1/heartbeat", { method: "POST", body: {} })).status, 200, "a noisy gateway cannot starve another one");
});

test("/metrics exposes operational series without high-cardinality labels or secrets", { skip }, async () => {
  const gateway = (await admin(`${ws(workspaceId)}/gateways`, { method: "POST", body: { name: "metrics-gw" } })).body;
  await createClient(primary.url, gateway.token)("/gateway/v1/heartbeat", { method: "POST", body: {} });
  await admin(`${ws(workspaceId)}/test-suites`); await admin("/v1/does-not-exist/at/all");
  const response = await createClient(primary.url)("/metrics");
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /^text\/plain/);
  for (const series of ["wirepulse_http_request_duration_seconds_bucket", "wirepulse_db_pool_connections{state=\"idle\"}", "wirepulse_jobs{status=\"queued\"}", "wirepulse_oldest_queued_job_age_seconds", "wirepulse_gateways_online", "wirepulse_sse_clients", "wirepulse_listener_connected 1", "wirepulse_process_cpu_user_seconds_total", "wirepulse_auth_failures_total"]) {
    assert.ok(response.text.includes(series), `missing ${series}`);
  }
  assert.match(response.text, /route="\/v1\/workspaces\/:workspaceId\/test-suites"/, "routes are labelled by pattern");
  assert.match(response.text, /route="unmatched"/);
  assert.ok(!response.text.includes(workspaceId), "identifiers must not become label values");
  assert.ok(!response.text.includes(gateway.token) && !response.text.includes(DEV_TOKEN));
  assert.match(response.text, /wirepulse_gateways_online [1-9]/);
});

test("/metrics honours METRICS_TOKEN and can move to a private port", { skip }, async () => {
  const token = "metrics-token-0123456789-abcdef";
  const guarded = await launch({ METRICS_TOKEN: token });
  const anonymous = createClient(guarded.url);
  assert.equal((await anonymous("/metrics")).status, 401);
  assert.equal((await anonymous("/metrics", { token: "wrong-metrics-token-0123456789" })).status, 401);
  assert.equal((await anonymous("/metrics", { token: DEV_TOKEN })).status, 401, "an API credential is not a metrics credential");
  assert.equal((await anonymous("/metrics", { token })).status, 200);

  const port = await freePort();
  const split = await launch({ METRICS_TOKEN: token, METRICS_PORT: String(port) });
  assert.equal((await createClient(split.url)("/metrics", { token })).status, 404, "not served on the public port");
  const privateScrape = await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(privateScrape.status, 200); assert.match(await privateScrape.text(), /wirepulse_jobs/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/metrics`)).status, 401);
});

test("production without a metrics token hides /metrics, and rejects the dev credential", { skip }, async () => {
  const app = await launch({ NODE_ENV: "production", DEV_BEARER_TOKEN: undefined, OIDC_ISSUER: "https://idp.example.invalid", OIDC_AUDIENCE: "wirepulse", CORS_ORIGINS: "https://app.example.com", DB_SSL: "off", TRUST_PROXY: "false" });
  const client = createClient(app.url);
  assert.equal((await client("/metrics")).status, 404);
  assert.equal((await client("/v1/workspaces", { token: DEV_TOKEN })).status, 401, "no dev backdoor in production");
  assert.equal((await client("/healthz")).status, 200);
  assert.equal((await client("/v1/workspaces", { headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" }, method: "OPTIONS" })).headers.get("access-control-allow-origin"), null);
  assert.ok(app.config.warnings.length >= 1);
});

test("one workspace cannot fill an instance's live streams: its own cap answers 429 while another workspace still connects", { skip }, async () => {
  const app = await launch({ SSE_MAX_CLIENTS_PER_WORKSPACE: "2" });
  const operator = createClient(app.url, DEV_TOKEN);
  const crowded = (await operator("/v1/workspaces", { method: "POST", body: { name: "crowded" } })).body.id;
  const quiet = (await operator("/v1/workspaces", { method: "POST", body: { name: "quiet" } })).body.id;
  const open = async (id) => { const controller = new AbortController(); const response = await fetch(`${app.url}${ws(id)}/test-jobs/stream`, { headers: { authorization: `Bearer ${DEV_TOKEN}` }, signal: controller.signal }); return { response, close: () => controller.abort() }; };
  const opened = [];
  try {
    opened.push(await open(crowded), await open(crowded));
    assert.deepEqual(opened.map((stream) => stream.response.status), [200, 200]);
    const refused = await open(crowded);
    assert.equal(refused.response.status, 429);
    assert.deepEqual(await refused.response.json(), { error: "too_many_streams_for_workspace" });
    const other = await open(quiet); opened.push(other);
    assert.equal(other.response.status, 200, "the other workspace is not affected");
    opened[0].close();
    await waitFor(async () => (await open(crowded).then((stream) => { opened.push(stream); return stream.response.status; })) === 200, { message: "a slot to free up when a stream closes" });
  } finally { for (const stream of opened) stream.close(); }
});

test("readiness fails for a database that is reachable but read-only (a replica, a demoted primary)", { skip }, async () => {
  const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } };
  const writable = createDatabase({ url: database.url, poolSize: 2, log: logger });
  const readOnly = createDatabase({ url: `${database.url}?options=-c%20default_transaction_read_only%3Don`, poolSize: 2, log: logger });
  const readOnlyApp = createApp({ config: primary.config, db: readOnly, log: logger });
  const server = http.createServer(readOnlyApp.app);
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  try {
    assert.deepEqual(await writable.health(), { readOnly: false });
    assert.deepEqual(await readOnly.health(), { readOnly: true });
    const ready = await fetch(`http://127.0.0.1:${server.address().port}/readyz`);
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), { status: "unavailable", checks: { database: "read_only" } });
    // Liveness does not look at the database: a read-only primary must not get its pods restarted.
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/healthz`)).status, 200);
    // And the instance with a writable database is ready.
    assert.equal((await fetch(`${primary.url}/readyz`)).status, 200);
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await writable.close(); await readOnly.close(); await readOnlyApp.stream.stop();
  }
});

test("shutdown drains: open streams end, the port closes, and it returns promptly", { skip }, async () => {
  const app = await launch();
  const controller = new AbortController();
  const stream = await fetch(`${app.url}${ws(workspaceId)}/test-jobs/stream`, { headers: { authorization: `Bearer ${DEV_TOKEN}`, accept: "text/event-stream" }, signal: controller.signal });
  assert.equal(stream.status, 200); assert.match(stream.headers.get("content-type"), /text\/event-stream/);
  const reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
  const started = Date.now();
  await app.stop();
  assert.ok(Date.now() - started < 4000, `shutdown took ${Date.now() - started}ms`);
  const ended = await Promise.race([reader.read().then((chunk) => chunk.done || chunk), sleep(3000).then(() => "still open")]).catch(() => true);
  assert.notEqual(ended, "still open", "the stream must be closed by shutdown");
  controller.abort();
  await assert.rejects(fetch(`${app.url}/healthz`), "port is closed");
});

test("shutdown drain: responses close their connection, new connections are still served, then the port closes", { skip }, async () => {
  const app = await launch();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const get = (path) => new Promise((resolve, reject) => { http.get(`${app.url}${path}`, { agent }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode, connection: res.headers.connection })); }).on("error", reject); });
  try {
    assert.deepEqual(await get("/healthz"), { status: 200, connection: "keep-alive" });
    const stopping = app.instance.shutdown({ graceMs: 1000, drainMs: 800 });
    await sleep(150);
    assert.deepEqual(await get("/healthz"), { status: 200, connection: "close" }, "the kept-alive connection is told to close");
    assert.equal((await fetch(`${app.url}/healthz`)).status, 200, "a new connection is still accepted during the drain");
    assert.equal((await fetch(`${app.url}/readyz`)).status, 503, "readiness already reports not ready");
    await stopping;
    await assert.rejects(fetch(`${app.url}/healthz`), "the port is closed afterwards");
  } finally { agent.destroy(); }
});

const freshEnv = (url, extra = {}) => ({ DATABASE_URL: url, PORT: "0", DEV_BEARER_TOKEN: DEV_TOKEN, LOG_LEVEL: "info", ...extra });

test("startup: refuses a stale schema, migrates on request, then serves and stops cleanly on SIGTERM", { skip }, async () => {
  const fresh = await createTestDatabase();
  try {
    const stale = run("server.mjs", [], freshEnv(fresh.url, { MIGRATE_ON_START: "false" }));
    const refused = await stale.exited;
    assert.equal(refused.code, 1); assert.match(refused.output, /database schema is behind/); assert.match(refused.output, /001_enterprise\.sql/);

    assert.equal((await run("migrate-cli.mjs", ["--status"], freshEnv(fresh.url)).exited).code, 2, "pending migrations are visible to a release pipeline");
    assert.equal((await run("migrate-cli.mjs", [], freshEnv(fresh.url)).exited).code, 0);
    assert.equal((await run("migrate-cli.mjs", ["--status"], freshEnv(fresh.url)).exited).code, 0);

    const server = run("server.mjs", [], freshEnv(fresh.url, { MIGRATE_ON_START: "false" }));
    const port = await waitFor(() => { const match = server.output().match(/"port":(\d+),"production":false[^\n]*WirePulse API listening/); return match ? Number(match[1]) : null; }, { message: "the server to listen" });
    assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 200);
    server.child.kill("SIGTERM");
    const stopped = await server.exited;
    assert.equal(stopped.code, 0); assert.equal(stopped.signal, null); assert.match(stopped.output, /"reason":"SIGTERM"[^\n]*shutting down/);
  } finally { await fresh.drop(); }
});

test("startup: a bad configuration fails fast without printing secrets", { skip }, async () => {
  const result = await run("server.mjs", [], { DATABASE_URL: "postgres://wp:s3cr3t-pass@127.0.0.1:1/x", NODE_ENV: "production" }).exited;
  assert.equal(result.code, 1);
  assert.match(result.output, /Invalid configuration/); assert.match(result.output, /OIDC_ISSUER and OIDC_AUDIENCE are required/);
  assert.ok(!result.output.includes("s3cr3t-pass"));
  const unreachable = await run("server.mjs", [], freshEnv("postgres://wp:s3cr3t-pass@127.0.0.1:1/x", { DB_CONNECT_TIMEOUT_MS: "500" })).exited;
  assert.equal(unreachable.code, 1); assert.match(unreachable.output, /startup failed/); assert.ok(!unreachable.output.includes("s3cr3t-pass"));
});

test("migrations: parallel runners apply each file once, edits are detected, and legacy schemas are adopted", { skip }, async () => {
  const logger = { info() {}, warn() {}, error() {} };
  const open = (url) => createDatabase({ url, poolSize: 3, log: logger });
  const racing = await createTestDatabase();
  try {
    const [a, b, c] = [open(racing.url), open(racing.url), open(racing.url)];
    try { await Promise.all([migrate(a, { log: logger }), migrate(b, { log: logger }), migrate(c, { log: logger })]); } finally { await Promise.all([a.close(), b.close(), c.close()]); }
    const check = new pg.Pool({ connectionString: racing.url, max: 3 });
    try {
      assert.deepEqual((await check.query("SELECT name FROM schema_migrations ORDER BY name")).rows.map((row) => row.name), MIGRATION_NAMES);
      const db = open(racing.url);
      try {
        await migrate(db, { log: logger });
        await check.query("UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE name = '002_gateways_and_jobs.sql'");
        await assert.rejects(migrate(db, { log: logger }), (error) => error instanceof MigrationError && /002_gateways_and_jobs\.sql was modified after it was applied/.test(error.message));
        await check.query("UPDATE schema_migrations SET checksum = NULL WHERE name = '002_gateways_and_jobs.sql'");
        await migrate(db, { log: logger });
      } finally { await db.close(); }
    } finally { await check.end(); }
  } finally { await racing.drop(); }

  // A database created by the original init-script deployment has the 001 schema but no migration history.
  const legacy = await createTestDatabase();
  try {
    const raw = new pg.Client({ connectionString: legacy.url }); await raw.connect();
    try { await raw.query(await fs.readFile(path.join(root, "migrations", "001_enterprise.sql"), "utf8")); } finally { await raw.end(); }
    const db = open(legacy.url);
    try { await migrate(db, { log: logger }); } finally { await db.close(); }
    const check = new pg.Pool({ connectionString: legacy.url, max: 3 });
    try {
      assert.equal((await check.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n, MIGRATION_NAMES.length);
      assert.equal((await check.query("SELECT to_regclass('public.test_jobs') IS NOT NULL AS present")).rows[0].present, true);
    } finally { await check.end(); }
  } finally { await legacy.drop(); }
});

test("retention does nothing unless explicitly enabled", { skip }, async () => {
  const { startRetention } = await import("../src/retention.mjs");
  const { createMetrics } = await import("../src/metrics.mjs");
  const before = (await pool.query("SELECT count(*)::int AS n FROM audit_events")).rows[0].n;
  const retention = startRetention({ db: primary.db, config: { retention: { jobsDays: 0, reportsDays: 0, auditDays: 0, intervalHours: 24 } }, log: primary.log, metrics: createMetrics({ db: primary.db }) });
  await retention.runOnce(); retention.stop();
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events")).rows[0].n, before);
});

test("migrations: a migration that cannot get its table lock gives up instead of holding back every other query on that table", { skip }, async () => {
  const logger = { info() {}, warn() {}, error() {} };
  const database = await createTestDatabase();
  const extra = await fs.mkdtemp(path.join(os.tmpdir(), "wp-migrations-"));
  const holder = new pg.Client({ connectionString: database.url });
  const reader = new pg.Pool({ connectionString: database.url, max: 3 });
  const db = createDatabase({ url: database.url, poolSize: 3, log: logger });
  try {
    await migrate(db, { log: logger });
    for (const name of await fs.readdir(path.join(root, "migrations"))) await fs.copyFile(path.join(root, "migrations", name), path.join(extra, name));
    await fs.writeFile(path.join(extra, "999_probe.sql"), "ALTER TABLE test_jobs ADD COLUMN probe_column text;\n");

    // One long transaction that has read the table, the situation of a report or a stuck client during a release.
    await holder.connect(); await holder.query("BEGIN"); await holder.query("SELECT count(*) FROM test_jobs");

    // Bounded: the ALTER waits 300 ms for its lock, fails, and nothing stays queued behind it.
    const started = Date.now();
    await assert.rejects(migrate(db, { log: logger, directory: extra, lockTimeoutMs: 300 }), (error) => error.code === "55P03");
    assert.ok(Date.now() - started < 3000, "gave up quickly");
    assert.equal((await reader.query("SELECT count(*)::int AS n FROM schema_migrations WHERE name = '999_probe.sql'")).rows[0].n, 0, "the failed migration was rolled back");
    const unblocked = Date.now(); await reader.query("SELECT count(*) FROM test_jobs");
    assert.ok(Date.now() - unblocked < 500, "readers are not held back after it gave up");

    // Unbounded (0): the same migration queues for its lock and a reader behind it is blocked until the long transaction ends. This is the outage the bound prevents.
    let migrated = false;
    const unbounded = migrate(db, { log: logger, directory: extra, lockTimeoutMs: 0 }).then(() => { migrated = true; });
    await sleep(700);
    assert.equal(migrated, false);
    let behind = false;
    const blockedReader = reader.query("SELECT count(*) FROM test_jobs").then(() => { behind = true; });
    await sleep(700);
    assert.equal(behind, false, "a reader queued behind the waiting ALTER is blocked");
    await holder.query("COMMIT");
    await Promise.all([unbounded, blockedReader]);
    assert.equal((await reader.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'test_jobs' AND column_name = 'probe_column'")).rows[0].n, 1);
  } finally {
    await holder.query("ROLLBACK").catch(() => {}); await holder.end().catch(() => {});
    await Promise.all([reader.end(), db.close()]); await fs.rm(extra, { recursive: true, force: true }); await database.drop();
  }
});

test("migrations: a blocked migration retries with short lock waits, readers are only briefly held, and it applies once the long transaction ends", { skip }, async () => {
  const logger = { info() {}, warn() {}, error() {} };
  const database = await createTestDatabase();
  const extra = await fs.mkdtemp(path.join(os.tmpdir(), "wp-migrations-"));
  const holder = new pg.Client({ connectionString: database.url });
  const reader = new pg.Pool({ connectionString: database.url, max: 2 });
  const db = createDatabase({ url: database.url, poolSize: 3, log: logger });
  try {
    await migrate(db, { log: logger });
    for (const name of await fs.readdir(path.join(root, "migrations"))) await fs.copyFile(path.join(root, "migrations", name), path.join(extra, name));
    await fs.writeFile(path.join(extra, "999_probe.sql"), "ALTER TABLE test_jobs ADD COLUMN probe_column text;\n");
    await holder.connect(); await holder.query("BEGIN"); await holder.query("SELECT count(*) FROM test_jobs");
    setTimeout(() => { holder.query("COMMIT").catch(() => {}); }, 1500);

    let slowest = 0; let running = true;
    const probing = (async () => { while (running) { const t = Date.now(); await reader.query("SELECT count(*) FROM test_jobs"); slowest = Math.max(slowest, Date.now() - t); await sleep(25); } })();
    const started = Date.now();
    await migrate(db, { log: logger, directory: extra, lockTimeoutMs: 200, lockRetryMs: 10_000 });
    running = false; await probing;
    assert.ok(Date.now() - started >= 1000, "it had to wait for the long transaction");
    assert.ok(slowest < 800, `a reader was held for ${slowest} ms; each attempt may hold readers only for about the lock timeout`);
    assert.equal((await reader.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'test_jobs' AND column_name = 'probe_column'")).rows[0].n, 1);
    assert.equal((await reader.query("SELECT count(*)::int AS n FROM schema_migrations WHERE name = '999_probe.sql'")).rows[0].n, 1);
  } finally {
    await holder.query("ROLLBACK").catch(() => {}); await holder.end().catch(() => {});
    await Promise.all([reader.end(), db.close()]); await fs.rm(extra, { recursive: true, force: true }); await database.drop();
  }
});
