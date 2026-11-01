#!/usr/bin/env node
// Post-install acceptance check for a running WirePulse control plane: run it once after installing or upgrading, with an
// administrator's access token (WP_TOKEN or --token), and keep the output with your change record.
//   node scripts/acceptance.mjs --url https://api.example.com --token <bearer> [--metrics-token <token>]
//
// It checks what an operator needs to know before letting people in: the probes answer, authentication is enforced and fails closed,
// hardening headers are present, /metrics is not open to the world, a real sign-in works, and a complete job cycle works (queue, claim
// by a simulated gateway, run, upload verifiable evidence, audit chain verifies: scripts/loadtest.mjs does the cycle, briefly). Then it
// offboards the workspaces it created. It creates and offboards data in the target: use it on a deployment you operate, not on one that
// is serving a customer's incident. Exit code 0 only if every check passed.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const options = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) { console.error(`unexpected argument ${arg}`); process.exit(2); }
  options[arg.slice(2)] = process.argv[++i];
}
const base = (options.url ?? "").replace(/\/+$/, "");
const token = options.token ?? process.env.WP_TOKEN;
if (!/^https?:\/\//.test(base) || !token) { console.error("usage: acceptance.mjs --url https://host --token <bearer> [--metrics-token <token>]"); process.exit(2); }

const results = [];
const check = async (name, run) => {
  try { const detail = await run(); results.push({ name, ok: true, detail }); }
  catch (error) { results.push({ name, ok: false, detail: error.message }); }
  const last = results.at(-1);
  console.log(`${last.ok ? "PASS" : "FAIL"}  ${name}${last.detail ? `  (${last.detail})` : ""}`);
};
const expect = (condition, message) => { if (!condition) throw new Error(message); };
const get = (path, headers = {}) => fetch(base + path, { headers, redirect: "manual" });
// The job cycle below can use up this token's request budget (240 a minute per user by default); wait out a 429 instead of failing on it.
const authed = async (path, init = {}) => {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
    if (response.status !== 429 || attempt >= 45) return response;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
};

await check("liveness answers", async () => { const r = await get("/healthz"); expect(r.status === 200, `HTTP ${r.status}`); });
await check("readiness reports a working database", async () => {
  const r = await get("/readyz"); const body = await r.json().catch(() => ({}));
  expect(r.status === 200 && body.checks?.database === "ok", `HTTP ${r.status} ${JSON.stringify(body)}`);
});
await check("no credential is refused (401)", async () => { const r = await get("/v1/workspaces"); expect(r.status === 401, `HTTP ${r.status}`); });
await check("a garbage token is refused (401)", async () => { const r = await get("/v1/workspaces", { authorization: "Bearer not-a-real-token-0123456789" }); expect(r.status === 401, `HTTP ${r.status}`); });
await check("an unsigned token is refused (401)", async () => {
  const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"sub":"x","exp":4102444800}').toString("base64url")}.`;
  const r = await get("/v1/workspaces", { authorization: `Bearer ${unsigned}` }); expect(r.status === 401, `HTTP ${r.status}`);
});
await check("responses carry hardening headers and no server banner", async () => {
  const r = await authed("/v1/workspaces");
  expect(r.headers.get("x-content-type-options") === "nosniff", "x-content-type-options missing");
  expect(/default-src 'none'/.test(r.headers.get("content-security-policy") ?? ""), "content-security-policy missing");
  expect(r.headers.get("cache-control") === "no-store", "cache-control is not no-store");
  expect(r.headers.get("x-powered-by") === null, "x-powered-by is set");
});
await check("/metrics is not open to anonymous callers", async () => { const r = await get("/metrics"); expect(r.status !== 200, "anonymous /metrics returned 200"); });
if (options["metrics-token"]) await check("/metrics answers with its token", async () => { const r = await get("/metrics", { authorization: `Bearer ${options["metrics-token"]}` }); expect(r.status === 200, `HTTP ${r.status}`); });
await check("your access token is accepted", async () => { const r = await authed("/v1/workspaces"); expect(r.status === 200, `HTTP ${r.status}: the token, issuer or audience configuration is wrong`); });
await check("a malformed identifier is a clean 400", async () => { const r = await authed("/v1/workspaces/not-a-uuid/test-suites"); expect(r.status === 400, `HTTP ${r.status}`); });
await check("a NUL character is a clean 400, not a server error", async () => {
  const r = await authed("/v1/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"a\\u0000b"}' }); expect(r.status === 400, `HTTP ${r.status}`);
});

const listed = async () => { const r = await authed("/v1/workspaces"); return r.status === 200 ? r.json() : []; };
const before = new Set((await listed()).map((workspace) => workspace.id));
await check("a full job cycle completes with valid audit chains (15 s, simulated gateways)", async () => {
  const loadtest = fileURLToPath(new URL("./loadtest.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [loadtest, "--url", base, "--token", token, "--seconds", "15", "--workspaces", "1", "--gateways", "2", "--submitters", "3", "--readers", "2"], { encoding: "utf8", timeout: 120_000 });
  const lines = (run.stdout + run.stderr).trim().split("\n");
  expect(run.status === 0, lines.slice(-6).join(" | "));
  return lines.find((line) => /^jobs submitted/.test(line))?.trim().slice(0, 100) ?? "";
});
await check("the workspaces created by this check are offboarded", async () => {
  const created = (await listed()).filter((workspace) => !before.has(workspace.id) && /^loadtest-/.test(workspace.name));
  for (const workspace of created) {
    const r = await authed(`/v1/workspaces/${workspace.id}?confirm=${encodeURIComponent(workspace.name)}`, { method: "DELETE" });
    expect(r.status === 200, `HTTP ${r.status} offboarding ${workspace.name}`);
  }
  return `${created.length} workspace(s)`;
});

const failed = results.filter((result) => !result.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks FAILED` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
