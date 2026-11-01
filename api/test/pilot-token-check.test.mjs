import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkToken } from "../src/check-token.mjs";
import { AUDIENCE, startIssuer } from "./helpers.mjs";

// The pilot diagnostic (src/check-token.mjs) is run by people with a real token from a customer's identity provider, so what it says
// about the common ways that goes wrong is tested here against a local provider. It does not show anything about a real provider.
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "check-token.mjs");
const oidcFor = (issuer, extra = {}) => ({ issuer: issuer.issuer, audience: AUDIENCE, jwksUri: null, trustUnverifiedEmail: false, ...extra });
const check = (issuer, token, extra) => checkToken({ token, oidc: oidcFor(issuer, extra), production: false });

function run(args, env, stdin) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });
}

test("a good token is accepted and the identity WirePulse would use is reported", async () => {
  const issuer = await startIssuer();
  try {
    const result = await check(issuer, await issuer.sign({ sub: "u1", email: "Ann@Example.com" }));
    assert.equal(result.verdict, "accepted");
    assert.deepEqual(result.identity, { subject: "u1", email: "ann@example.com", emailVerified: true });
    assert.deepEqual(result.notes, []);
  } finally { await issuer.stop(); }
});

test("an accepted token without an email says what that costs and how to fix it", async () => {
  const issuer = await startIssuer();
  try {
    const result = await check(issuer, await issuer.sign({ sub: "AAAA", claims: { ver: "2.0", preferred_username: "alice@contoso.example" } }));
    assert.equal(result.verdict, "accepted");
    assert.equal(result.identity.email, null);
    assert.match(result.notes.join("\n"), /cannot accept an invitation.*email_verified: true.*OIDC_TRUST_UNVERIFIED_EMAIL/s);
    const unverified = await check(issuer, await issuer.sign({ sub: "AAAA", claims: { email: "a@b.example", email_verified: "true" } }));
    assert.match(unverified.notes.join("\n"), /only the boolean true counts/);
  } finally { await issuer.stop(); }
});

test("a rejected token names the claim that does not match", async () => {
  const issuer = await startIssuer();
  try {
    const wrongAudience = await check(issuer, await issuer.sign({ aud: "api://someone-else" }));
    assert.equal(wrongAudience.verdict, "rejected");
    assert.equal(wrongAudience.reason, "ERR_JWT_CLAIM_VALIDATION_FAILED");
    assert.match(wrongAudience.notes.join("\n"), /Audience mismatch: the token says aud = api:\/\/someone-else; WirePulse expects OIDC_AUDIENCE = wirepulse-test/);

    const wrongIssuer = await check(issuer, await issuer.sign({ iss: "https://sts.windows.net/11111111-2222-3333-4444-555555555555/" }));
    assert.equal(wrongIssuer.verdict, "rejected");
    assert.match(wrongIssuer.notes.join("\n"), /Issuer mismatch.*sts\.windows\.net/s);
    assert.match(wrongIssuer.notes.join("\n"), /Entra v1\.0 issuer/);

    const expired = await check(issuer, await issuer.sign({ exp: Math.floor(Date.now() / 1000) - 3600 }));
    assert.equal(expired.reason, "ERR_JWT_EXPIRED");
    assert.match(expired.notes.join("\n"), /expired .*\(60 min ago\)/);
  } finally { await issuer.stop(); }
});

test("a token signed by a key the issuer does not publish, and one that is not a signed JWT, are rejected with a reason", async () => {
  const issuer = await startIssuer();
  try {
    const forged = await check(issuer, await issuer.sign({ signWith: issuer.foreignKey }));
    assert.equal(forged.verdict, "rejected");
    assert.equal(forged.reason, "ERR_JWS_SIGNATURE_VERIFICATION_FAILED");
    assert.match(forged.notes.join("\n"), /not signed by any key the issuer publishes/);

    const opaque = await check(issuer, "00abcdefghijklmnopqrstuvwxyz");
    assert.equal(opaque.verdict, "rejected");
    assert.equal(opaque.reason, "malformed_token");
    assert.match(opaque.notes.join("\n"), /not a three-part JWT/);
  } finally { await issuer.stop(); }
});

test("an unreachable issuer is reported as such, and a WirePulse credential is not mistaken for an identity-provider token", async () => {
  const issuer = await startIssuer();
  const token = await issuer.sign({});
  await issuer.stop();
  const unreachable = await check(issuer, token);
  assert.equal(unreachable.verdict, "rejected");
  assert.match(unreachable.notes.join("\n"), /Could not reach .*openid-configuration/);
  const key = await checkToken({ token: "wpk_abcdef", oidc: oidcFor(issuer), production: false });
  assert.equal(key.verdict, "not_checked");
});

test("the command line: reads the token from stdin, exits 0 when accepted and 1 when rejected, 2 when unconfigured, and never prints the token", async () => {
  const issuer = await startIssuer();
  try {
    const env = { OIDC_ISSUER: `${issuer.issuer}/`, OIDC_AUDIENCE: AUDIENCE };
    const good = await issuer.sign({ sub: "u9", email: "zed@example.com" });
    const accepted = await run(["--insecure-http"], env, `Bearer ${good}\n`);
    assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
    assert.match(accepted.stdout, /VERDICT: ACCEPTED.*subject u9, email zed@example\.com/);
    assert.ok(!accepted.stdout.includes(good) && !accepted.stderr.includes(good), "the token must not be echoed");

    const json = await run(["--insecure-http", "--json"], env, good);
    assert.equal(JSON.parse(json.stdout).verdict, "accepted");

    const rejected = await run(["--insecure-http"], env, await issuer.sign({ aud: "other" }));
    assert.equal(rejected.code, 1);
    assert.match(rejected.stdout, /VERDICT: REJECTED \(reason: ERR_JWT_CLAIM_VALIDATION_FAILED\)/);

    assert.equal((await run([], {}, good)).code, 2);
    assert.equal((await run(["--insecure-http"], env, "  \n")).code, 2);
  } finally { await issuer.stop(); }
});
