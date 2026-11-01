// The browser console against the real control plane: real API, real PostgreSQL, real gateway agent (simulated serial device).
// Needs WP_TEST_DATABASE_URL, like the API tests; skipped without it. Run with the dev server on :5173 (npm run dev), or on another origin named by WP_E2E_ORIGIN.
import { expect, test, type Page } from "@playwright/test";
// Plain ESM helpers shared with the API test-suite (no type declarations).
// @ts-ignore
import { DEV_TOKEN, createClient, createTestDatabase, sampleDefinition, skip, startApi, startReceiver, ws } from "../api/test/helpers.mjs";
// @ts-ignore
import { verifySignature } from "../api/src/webhook-send.mjs";
// @ts-ignore
import { createAgent, createAgentLog } from "../gateway/src/agent.mjs";
// @ts-ignore
import { createSimulatedTransport } from "../gateway/src/transports.mjs";

const ORIGIN = process.env.WP_E2E_ORIGIN ?? "http://127.0.0.1:5173";
test.skip(!!skip, String(skip));
test.describe.configure({ mode: "serial" });

let database: any; let api: any; let admin: any;
const agents: Array<{ agent: any; done: Promise<unknown> }> = [];

test.beforeAll(async () => {
  database = await createTestDatabase();
  // Webhooks are on, may reach loopback (the receiver below), and give up after one attempt so a failed delivery is visible at once.
  api = await startApi({ databaseUrl: database.url, env: { CORS_ORIGINS: ORIGIN, WEBHOOK_SIGNING_KEY: "live-console-webhook-signing-key-0123456789", WEBHOOK_ALLOWED_CIDRS: "127.0.0.0/8", OUTBOX_INTERVAL_MS: "200", OUTBOX_MAX_ATTEMPTS: "1" } });
  admin = createClient(api.url, DEV_TOKEN);
});
test.afterAll(async () => {
  for (const { agent, done } of agents.splice(0)) { agent.stop(); await done; }
  await api?.stop();
  await database?.drop();
});

function startAgent(token: string) {
  const agent = createAgent({
    config: { apiUrl: api.url, token, serialPath: "/dev/ttyTEST", pollMs: 50, leaseRenewMs: 500, heartbeatMs: 300, requestTimeoutMs: 3000, maxBackoffMs: 200, shutdownGraceMs: 300 },
    log: createAgentLog({ write: () => undefined, secrets: [token] }),
    openTransport: async () => createSimulatedTransport({ responder: () => ["READY"] })
  });
  const handle = { agent, done: agent.run().then(() => null, (error: unknown) => error) };
  agents.push(handle);
  return handle;
}

// Connects the page to the API and creates (and selects) a workspace of the given name.
async function openWorkspace(page: Page, name: string) {
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/");
  await page.getByPlaceholder("https://api.wirepulse.example.com").fill(api.url);
  await page.getByPlaceholder("Paste short-lived token").fill(DEV_TOKEN);
  await page.getByRole("button", { name: "Connect workspace" }).click();
  await expect(page.getByText(/^Connected\./)).toBeVisible();
  await page.getByPlaceholder("New workspace name").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Enterprise console · ${name}` })).toBeVisible();
  const workspace = (await admin("/v1/workspaces")).body.find((item: { name: string }) => item.name === name);
  return workspace.id as string;
}
const console_ = (page: Page) => page.getByRole("region", { name: "Enterprise console" });
const tab = (page: Page, name: string) => console_(page).getByRole("tab", { name });
const secretOf = async (page: Page) => (await page.getByTestId("one-time-secret").textContent()) ?? "";

test("a registered gateway runs a queued job and the console follows it live, down to the verified evidence", async ({ page }) => {
  await openWorkspace(page, "Live Lab");

  await tab(page, "Gateways").click();
  await console_(page).getByLabel("Name").fill("Bench 1");
  await console_(page).getByLabel("Labels (key=value, …)").fill("bench=1, board=esp32");
  await console_(page).getByRole("button", { name: "Register gateway" }).click();
  const token = await secretOf(page);
  expect(token).toMatch(/^wpg_[A-Za-z0-9_-]{40,}$/);
  await console_(page).getByRole("button", { name: "I have saved it — hide" }).click();
  await expect(page.getByTestId("one-time-secret")).toHaveCount(0);
  await expect(console_(page).getByText("Labels: bench=1, board=esp32")).toBeVisible();
  await expect(console_(page).getByText("offline", { exact: true })).toBeVisible();

  startAgent(token);
  await expect(async () => {
    await console_(page).getByRole("button", { name: "Refresh" }).click();
    await expect(console_(page).getByText("online", { exact: true })).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 10_000 });
  await expect(console_(page).getByText("Serial ports: /dev/ttyTEST")).toBeVisible();

  await tab(page, "Jobs").click();
  await expect(console_(page).getByText("Live", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Queue gateway job" }).click();
  const row = console_(page).locator(".ec-job").first();
  await expect(row.locator(".ec-badge")).toHaveText("passed", { timeout: 15_000 });
  await expect(row).toContainText("1 passed · 0 failed · 1 total");
  await expect(row).toContainText("on Bench 1");

  await row.getByRole("button", { name: "Details" }).click();
  await expect(row.locator("dd", { hasText: /^[a-f0-9]{64}$/ }).first()).toBeVisible();
  await expect(row).toContainText("Engine fingerprint");

  const [download] = await Promise.all([page.waitForEvent("download"), row.getByRole("button", { name: "JUnit XML" }).click()]);
  const xml = await (await import("node:fs/promises")).readFile((await download.path())!, "utf8");
  expect(download.suggestedFilename()).toMatch(/^wirepulse-[0-9a-f]{8}\.xml$/);
  expect(xml).toContain("<testsuite");
  expect(xml).not.toContain("READY"); // evidence and reports never carry the device's bytes
});

test("rotating a gateway token stops the old agent and shows the new token once; revoking is final", async ({ page }) => {
  const workspaceId = await openWorkspace(page, "Rotation Lab");
  await tab(page, "Gateways").click();
  await console_(page).getByLabel("Name").fill("Bench 2");
  await console_(page).getByRole("button", { name: "Register gateway" }).click();
  const first = await secretOf(page);
  const old = startAgent(first);
  await console_(page).getByRole("button", { name: "I have saved it — hide" }).click();

  await console_(page).getByRole("button", { name: "Rotate token" }).click();
  const second = await secretOf(page);
  expect(second).toMatch(/^wpg_/); expect(second).not.toBe(first);
  const error = await Promise.race([old.done, new Promise((resolve) => setTimeout(() => resolve("still running"), 8000))]);
  expect(String((error as Error)?.message ?? error)).toMatch(/rejected the gateway token/);
  expect(await page.content()).not.toContain(first);

  await console_(page).getByRole("button", { name: "I have saved it — hide" }).click();
  await console_(page).getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(console_(page).getByText("revoked", { exact: true })).toBeVisible();
  await expect(console_(page).getByRole("button", { name: "Rotate token" })).toHaveCount(0);
  expect((await admin(`${ws(workspaceId)}/gateways`)).body[0].revokedAt).not.toBeNull();
});

test("team and API keys: invite (email only when configured), create a CI key that works, revoke it and it stops", async ({ page }) => {
  const workspaceId = await openWorkspace(page, "Team Lab");

  await tab(page, "Team").click();
  await expect(console_(page).getByText("admin@wirepulse.local")).toBeVisible();
  await console_(page).getByLabel("Email").fill("colleague@example.com");
  await console_(page).locator("label").filter({ hasText: "Role" }).locator("select").selectOption("viewer");
  await console_(page).getByRole("button", { name: "Invite" }).click();
  await expect(console_(page).getByRole("status")).toContainText("emailed only if this server has email configured");
  await expect(console_(page).getByText("colleague@example.com", { exact: true })).toBeVisible();
  await console_(page).getByRole("button", { name: "Revoke" }).click();
  await expect(console_(page).getByText(/^revoked$/)).toBeVisible();

  await tab(page, "API keys").click();
  await console_(page).getByLabel("Name").fill("nightly-ci");
  await console_(page).getByRole("button", { name: "Create key" }).click();
  const key = await secretOf(page);
  expect(key).toMatch(/^wpk_/);
  expect((await createClient(api.url, key)(`${ws(workspaceId)}/test-jobs`)).status).toBe(200);
  await console_(page).getByRole("button", { name: "I have saved it — hide" }).click();
  await console_(page).getByRole("button", { name: "Revoke" }).click();
  await expect(console_(page).getByText(/revoked · last used/)).toBeVisible();
  expect((await createClient(api.url, key)(`${ws(workspaceId)}/test-jobs`)).status).toBe(401);
});

test("when the live stream is unavailable the console says so and keeps the list fresh by polling", async ({ page }) => {
  test.setTimeout(60_000);
  await page.route(/\/test-jobs\/stream/, (route) => route.abort());
  const workspaceId = await openWorkspace(page, "Polling Lab");
  await expect(console_(page).getByText(/Reconnecting — refreshing every 10 s/)).toBeVisible();

  const queued = await admin(`${ws(workspaceId)}/test-jobs`, { method: "POST", body: { definition: sampleDefinition(), idempotencyKey: "polled" } });
  expect(queued.status).toBe(201);
  await expect(console_(page).locator(".ec-job").first()).toContainText(queued.body.id.slice(0, 8), { timeout: 20_000 });
  await expect(console_(page).locator(".ec-job .ec-badge").first()).toHaveText("queued");
});

test("the usage tab shows the plan and its consumption, and a limit that is reached is explained in plain words", async ({ page }) => {
  const workspaceId = await openWorkspace(page, "Usage Lab");
  await tab(page, "Usage").click();
  await expect(console_(page).getByTestId("plan-name")).toHaveText("enterprise");
  await expect(console_(page).locator(".ec-job", { hasText: "Gateways" })).toContainText("unlimited");

  await api.db.query("UPDATE workspaces SET plan = 'free' WHERE id = $1", [workspaceId]);
  await console_(page).getByRole("button", { name: "Refresh" }).click();
  await expect(console_(page).getByTestId("plan-name")).toHaveText("free");
  await expect(console_(page).locator(".ec-job", { hasText: "Members" })).toContainText("1 of 3");
  await expect(console_(page).locator(".ec-job", { hasText: "Gateways" })).toContainText("0 of 1");
  await expect(console_(page).locator(".ec-job", { hasText: "Requests per minute" })).toContainText("up to 120");

  await tab(page, "Gateways").click();
  await console_(page).getByLabel("Name").fill("First");
  await console_(page).getByRole("button", { name: "Register gateway" }).click();
  await console_(page).getByRole("button", { name: "I have saved it — hide" }).click();
  await console_(page).getByLabel("Name").fill("Second");
  await console_(page).getByRole("button", { name: "Register gateway" }).click();
  await expect(console_(page).getByRole("status")).toContainText("the free plan limit for gateways (1) is reached");
  expect((await admin(`${ws(workspaceId)}/gateways`)).body).toHaveLength(1);

  await tab(page, "Usage").click();
  await expect(console_(page).locator(".ec-job", { hasText: "Gateways" })).toContainText("1 of 1");
});

test("webhooks: create one, receive a signed delivery for a finished job, rotate the secret, and redeliver a failed delivery", async ({ page }) => {
  test.setTimeout(60_000);
  const receiver = await startReceiver();
  try {
    const workspaceId = await openWorkspace(page, "Hook Lab");
    await tab(page, "Webhooks").click();

    // A destination the server would not be allowed to call is refused when the webhook is configured.
    await console_(page).getByLabel("Name").fill("Internal");
    await console_(page).getByLabel("URL").fill("http://10.1.2.3/hook");
    await console_(page).getByRole("button", { name: "Add webhook" }).click();
    await expect(console_(page).getByRole("status")).toContainText("webhook_destination_not_allowed");
    await expect(console_(page).getByText("No webhooks.")).toBeVisible();

    await console_(page).getByLabel("Name").fill("CI status");
    await console_(page).getByLabel("URL").fill(`${receiver.url}/hooks/ci`);
    await console_(page).getByRole("button", { name: "Add webhook" }).click();
    const first = await secretOf(page);
    expect(first).toMatch(/^whsec_[A-Za-z0-9_-]{40,}$/);
    await console_(page).getByRole("button", { name: "I have saved it — hide" }).click();
    const hook = console_(page).locator(".ec-job", { hasText: "CI status" });
    await expect(hook).toContainText("enabled");
    await expect(hook).toContainText("secret v1");

    // A real job, run by a real agent, ends in a signed delivery that verifies with the secret that was shown.
    const gateway = (await admin(`${ws(workspaceId)}/gateways`, { method: "POST", body: { name: "Bench", labels: {} } })).body;
    startAgent(gateway.token);
    await page.getByRole("button", { name: "Queue gateway job" }).click();
    await expect.poll(() => receiver.requests.length, { timeout: 20_000 }).toBeGreaterThan(0);
    const delivered = receiver.requests[0];
    expect(delivered.url).toBe("/hooks/ci");
    expect(delivered.headers["x-wirepulse-event"]).toBe("job.finished");
    expect(verifySignature(first, delivered.headers["x-wirepulse-signature"], delivered.body)).toBe(true);
    expect(delivered.body).not.toContain("READY"); // the notification names the job, never the device's bytes

    // Delivery status changes after the request is made, so the list has a Refresh button.
    const deliveryBadges = (status: string, count: number) => async () => {
      await hook.getByRole("button", { name: "Refresh deliveries" }).click();
      await expect(hook.locator(".ec-badge", { hasText: status })).toHaveCount(count, { timeout: 500 });
    };
    await hook.getByRole("button", { name: "Deliveries" }).click();
    await expect(deliveryBadges("delivered", 1)).toPass({ timeout: 10_000 });

    // Rotating moves signing to a new secret at once; the old one no longer verifies.
    await hook.getByRole("button", { name: "Rotate secret" }).click();
    const second = await secretOf(page);
    expect(second).toMatch(/^whsec_/); expect(second).not.toBe(first);
    await console_(page).getByRole("button", { name: "I have saved it — hide" }).click();
    await expect(hook).toContainText("secret v2");
    await hook.getByRole("button", { name: "Send test" }).click();
    await expect.poll(() => receiver.requests.length, { timeout: 20_000 }).toBe(2);
    const ping = receiver.requests[1];
    expect(ping.headers["x-wirepulse-event"]).toBe("webhook.ping");
    expect(verifySignature(second, ping.headers["x-wirepulse-signature"], ping.body)).toBe(true);
    expect(verifySignature(first, ping.headers["x-wirepulse-signature"], ping.body)).toBe(false);

    // A receiver that is down turns the delivery into a failed one, which can be sent again once it is back.
    receiver.setHandler((_req: unknown, res: { statusCode: number; end(): void }) => { res.statusCode = 500; res.end(); });
    await hook.getByRole("button", { name: "Send test" }).click();
    await expect(deliveryBadges("failed", 1)).toPass({ timeout: 10_000 });
    await expect(hook).toContainText("HTTP 500");
    receiver.setHandler((_req: unknown, res: { statusCode: number; end(): void }) => { res.statusCode = 200; res.end("ok"); });
    await hook.getByRole("button", { name: "Redeliver" }).click();
    await expect.poll(async () => (await admin(`${ws(workspaceId)}/webhooks/${(await admin(`${ws(workspaceId)}/webhooks`)).body[0].id}/deliveries`)).body.filter((item: { status: string }) => item.status === "delivered").length, { timeout: 20_000 }).toBe(3);

    await hook.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(console_(page).getByText("No webhooks.")).toBeVisible();
  } finally { await receiver.close(); }
});

test("deleting a workspace needs its exact name, and it is gone at once", async ({ page }) => {
  const workspaceId = await openWorkspace(page, "Doomed Lab");
  await tab(page, "Usage").click();
  const confirm = console_(page).getByLabel("Type the workspace name to confirm");
  const button = console_(page).getByRole("button", { name: "Delete workspace" });
  await expect(button).toBeDisabled();
  await confirm.fill("Doomed");
  await expect(button).toBeDisabled();
  await confirm.fill("Doomed Lab");
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByRole("heading", { name: "Enterprise console · Doomed Lab" })).toHaveCount(0);
  await expect(page.getByText(/^Workspace deleted\./)).toBeVisible();
  expect((await admin(`${ws(workspaceId)}/usage`)).status).toBe(403); // a deleted workspace answers like one the caller never belonged to
  expect((await admin("/v1/workspaces")).body.some((item: { id: string }) => item.id === workspaceId)).toBe(false);
});

test("a viewer sees usage but none of the administrator controls", async ({ page }) => {
  const workspaceId = await openWorkspace(page, "Viewer Lab");
  const key = (await admin(`${ws(workspaceId)}/api-keys`, { method: "POST", body: { name: "read-only", role: "viewer", expiresInDays: 1 } })).body.token;
  await page.goto("/");
  await page.getByPlaceholder("https://api.wirepulse.example.com").fill(api.url);
  await page.getByPlaceholder("Paste short-lived token").fill(key);
  await page.getByRole("button", { name: "Connect workspace" }).click();
  await expect(page.getByRole("heading", { name: "Enterprise console · Viewer Lab" })).toBeVisible();
  await expect(console_(page).getByRole("tab")).toHaveText(["Jobs", "Gateways", "Usage"]);
  await tab(page, "Usage").click();
  await expect(console_(page).getByTestId("plan-name")).toHaveText("enterprise");
  await expect(console_(page).getByRole("button", { name: "Delete workspace" })).toHaveCount(0);
});

test("when the server has webhooks switched off the Webhooks tab says so instead of failing", async ({ page }) => {
  await page.route(/\/webhooks$/, (route) => route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ error: "webhooks_not_configured" }) }));
  await openWorkspace(page, "No Hooks Lab");
  await tab(page, "Webhooks").click();
  await expect(console_(page).getByText(/Webhooks are not enabled on this server/)).toBeVisible();
  await expect(console_(page).getByRole("button", { name: "Add webhook" })).toHaveCount(0);
  await expect(console_(page).getByRole("status")).toHaveText("");
});

test("provisioning: an administrator issues a SCIM token, sees who the identity provider created, is warned before the token lapses, and revoking it locks the provider out", async ({ page }) => {
  const workspaceId = await openWorkspace(page, "Provision Lab");
  const scim = (token: string, method: string, path: string, body?: unknown) => fetch(`${api.url}/scim/v2${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const person = (userName: string, role = "engineer") => ({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName, emails: [{ value: userName, primary: true }], roles: [{ value: role }], active: true });

  await tab(page, "Provisioning").click();
  await expect(console_(page).getByTestId("scim-base-url")).toHaveText(`${api.url}/scim/v2`);
  await expect(console_(page).getByText("No provisioning tokens.")).toBeVisible();
  await expect(console_(page).getByText("Nobody has been provisioned yet.")).toBeVisible();

  await console_(page).getByLabel("Name").fill("okta-production");
  await console_(page).getByRole("button", { name: "Create token" }).click();
  const token = await secretOf(page);
  expect(token).toMatch(/^wps_[A-Za-z0-9_-]{40,}$/);
  await console_(page).getByRole("button", { name: "I have saved it — hide" }).click();
  expect(await page.content()).not.toContain(token); // never rendered again once hidden
  const row = console_(page).locator(".ec-job", { hasText: "okta-production" });
  await expect(row.getByTestId("scim-token-state")).toHaveText("ok");
  await expect(row).toContainText("Never used");

  // What the identity provider does, with the token the page just showed.
  const created = await scim(token, "POST", "/Users", person("quinn@example.com"));
  expect(created.status).toBe(201);
  const quinn = (await created.json()) as { id: string };
  await console_(page).getByRole("button", { name: "Refresh", exact: true }).click();
  const quinnRow = console_(page).locator(".ec-job", { hasText: "quinn@example.com" });
  await expect(quinnRow.getByTestId("provisioned-state")).toHaveText("pending");
  await expect(quinnRow).toContainText("engineer");
  await expect(row).not.toContainText("Never used");

  // The provider cannot demote the workspace's only administrator; provisioned with the role they hold, the record binds on their next sign-in.
  const demotion = await scim(token, "POST", "/Users", person("admin@wirepulse.local", "viewer"));
  expect([demotion.status, ((await demotion.json()) as { detail: string }).detail]).toEqual([409, "last_administrator"]);
  expect((await scim(token, "POST", "/Users", person("admin@wirepulse.local", "administrator"))).status).toBe(201);
  expect((await admin("/v1/workspaces")).status).toBe(200);
  await console_(page).getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(console_(page).locator(".ec-job", { hasText: "admin@wirepulse.local" }).getByTestId("provisioned-state")).toHaveText("active");
  expect((await admin(`${ws(workspaceId)}/members`)).body.find((member: { email: string }) => member.email === "admin@wirepulse.local").role).toBe("administrator");

  // The provider deactivates the leaver; the console shows it.
  expect((await scim(token, "PATCH", `/Users/${quinn.id}`, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", path: "active", value: false }] })).status).toBe(200);
  await console_(page).getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(quinnRow.getByTestId("provisioned-state")).toHaveText("deactivated");

  // A token about to expire is flagged, an expired one is flagged louder, and with none usable the page says deprovisioning has stopped.
  await api.db.query("UPDATE scim_tokens SET expires_at = now() + interval '5 days' WHERE workspace_id = $1", [workspaceId]);
  await tab(page, "Usage").click();
  await tab(page, "Provisioning").click();
  await expect(row.getByTestId("scim-token-state")).toHaveText("expiring");
  await expect(row.getByRole("alert")).toContainText("expires in 5 days");
  await api.db.query("UPDATE scim_tokens SET expires_at = now() - interval '1 day' WHERE workspace_id = $1", [workspaceId]);
  await tab(page, "Usage").click();
  await tab(page, "Provisioning").click();
  await expect(row.getByTestId("scim-token-state")).toHaveText("expired");
  await expect(row.getByRole("alert")).toContainText("can no longer remove leavers");
  await expect(console_(page).getByText(/No usable token/)).toBeVisible();
  expect((await scim(token, "GET", "/Users")).status).toBe(401);

  // Replacement token: works, and revoking it from the console locks the provider out at once.
  await console_(page).getByLabel("Name").fill("okta-rotated");
  await console_(page).getByRole("button", { name: "Create token" }).click();
  const replacement = await secretOf(page);
  await console_(page).getByRole("button", { name: "I have saved it — hide" }).click();
  expect((await scim(replacement, "GET", "/Users")).status).toBe(200);
  const fresh = console_(page).locator(".ec-job", { hasText: "okta-rotated" });
  await fresh.getByRole("button", { name: "Revoke" }).click();
  await expect(fresh.getByTestId("scim-token-state")).toHaveText("revoked");
  expect((await scim(replacement, "GET", "/Users")).status).toBe(401);

  // A plan without provisioning explains the limit in plain words instead of failing opaquely.
  await api.db.query("UPDATE workspaces SET plan = 'free' WHERE id = $1", [workspaceId]);
  await console_(page).getByLabel("Name").fill("not-allowed");
  await console_(page).getByRole("button", { name: "Create token" }).click();
  await expect(console_(page).getByRole("status")).toContainText("the free plan limit for provisioning tokens (0) is reached");
});

test("audit: the administrator reads the trail, filters and pages it, verifies the hash chain, exports it, and is told when it has been tampered with", async ({ page }) => {
  test.setTimeout(60_000);
  const workspaceId = await openWorkspace(page, "Audit Lab");
  const gateway = (await admin(`${ws(workspaceId)}/gateways`, { method: "POST", body: { name: "Bench A", labels: {} } })).body;
  expect((await admin(`${ws(workspaceId)}/gateways/${gateway.id}`, { method: "DELETE" })).status).toBe(204);
  // Enough further events that the trail spans more than one page.
  for (let i = 0; i < 55; i += 1) expect((await admin(`${ws(workspaceId)}/profiles`, { method: "POST", body: { name: `profile ${i}`, definition: sampleDefinition() } })).status).toBe(201);

  await tab(page, "Audit").click();
  const rows = console_(page).locator(".ec-job");
  await expect(rows).toHaveCount(50);
  await expect(rows.first()).toContainText("profile.created");
  await console_(page).getByRole("button", { name: "Load older events" }).click();
  const exported = (await admin(`${ws(workspaceId)}/audit-events/export.ndjson`)).text.trim().split("\n").map((line: string) => JSON.parse(line));
  await expect(rows).toHaveCount(exported.length); // 1 workspace + 1 gateway + 1 revoke + 55 profiles, nothing lost or repeated across the page boundary
  await expect(console_(page).getByRole("button", { name: "Load older events" })).toHaveCount(0);
  await expect(rows.last()).toContainText("workspace.created");

  // A filter narrows the trail to one action and shows who did it.
  await console_(page).getByLabel("Action (exact)").fill("gateway.revoked");
  await console_(page).getByRole("button", { name: "Apply filter" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("dev-admin");
  await rows.first().getByRole("button", { name: "Details" }).click();
  await expect(rows.first().locator("dd code", { hasText: /^[a-f0-9]{64}$/ })).toHaveCount(2); // previous and entry hash
  await console_(page).getByLabel("Action (exact)").fill("");
  const today = new Date().toISOString().slice(0, 10);
  await console_(page).getByLabel("From (UTC date)").fill("2999-01-01");
  await console_(page).getByRole("button", { name: "Apply filter" }).click();
  await expect(console_(page).getByText("No audit events match.")).toBeVisible();
  await console_(page).getByLabel("From (UTC date)").fill(today);
  await console_(page).getByLabel("To (UTC date, inclusive)").fill(today);
  await console_(page).getByRole("button", { name: "Apply filter" }).click();
  await expect(rows.first()).toBeVisible(); // today's events are inside "today", whatever the hour
  await console_(page).getByLabel("From (UTC date)").fill("");
  await console_(page).getByLabel("To (UTC date, inclusive)").fill("");
  await console_(page).getByRole("button", { name: "Apply filter" }).click();

  // The chain verifies, and the head hash on screen is the one the server reports and the export ends with.
  await console_(page).getByRole("button", { name: "Verify chain" }).click();
  await expect(console_(page).getByTestId("audit-verification")).toContainText("Chain intact");
  await expect(console_(page).getByTestId("audit-verification")).toContainText(`${exported.length} events checked`);
  const head = (await admin(`${ws(workspaceId)}/audit/verify`)).body.headHash;
  expect(head).toBe(exported.at(-1).row_hash);
  await expect(console_(page).getByTestId("audit-head-hash")).toHaveText(head);

  // The file a browser saves is the same export, in chain order.
  const [download] = await Promise.all([page.waitForEvent("download"), console_(page).getByRole("button", { name: "Export (NDJSON)" }).click()]);
  const saved = (await (await import("node:fs/promises")).readFile((await download.path())!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(download.suggestedFilename()).toMatch(/^wirepulse-audit-[0-9a-f]{8}\.ndjson$/);
  expect(saved.map((event: { chain_seq: string }) => event.chain_seq)).toEqual(exported.map((event: { chain_seq: string }) => event.chain_seq));
  expect(saved.at(-1).row_hash).toBe(head);

  // Someone with database rights who rewrites an entry is caught, and the console says where.
  const original = (await api.db.query("SELECT details FROM audit_events WHERE workspace_id = $1 AND chain_seq = 2", [workspaceId])).rows[0].details;
  try {
    await api.db.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only");
    await api.db.query(`UPDATE audit_events SET details = '{"name":"forged"}' WHERE workspace_id = $1 AND chain_seq = 2`, [workspaceId]);
    await api.db.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only");
    await console_(page).getByRole("button", { name: "Verify chain" }).click();
    await expect(console_(page).getByTestId("audit-verification")).toContainText("Chain broken");
    await expect(console_(page).getByTestId("audit-verification")).toContainText("#2");
    await expect(console_(page).getByTestId("audit-head-hash")).toHaveCount(0);
  } finally {
    await api.db.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only");
    await api.db.query("UPDATE audit_events SET details = $2 WHERE workspace_id = $1 AND chain_seq = 2", [workspaceId, original]);
    await api.db.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only");
  }
  await console_(page).getByRole("button", { name: "Verify chain" }).click();
  await expect(console_(page).getByTestId("audit-verification")).toContainText("Chain intact");
});
