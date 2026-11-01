import axe from "axe-core";
import { expect, test, type Page } from "@playwright/test";

// Automated WCAG 2.0 / 2.1 level A and AA checks (axe-core) on the states a person actually sees. This finds what a tool can find (colour contrast,
// names and labels, roles, structure). It is not a manual audit and does not replace testing with a screen reader.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

type AxeResult = { violations: Array<{ id: string; nodes: Array<{ target: unknown[] }> }> };

async function failures(page: Page): Promise<string[]> {
  await page.evaluate(axe.source); // evaluated through the debugger protocol, so a page's content security policy does not apply
  return page.evaluate(async (tags) => {
    const result = await (window as unknown as { axe: { run: (context: Document, options: object) => Promise<AxeResult> } }).axe.run(document, { runOnly: { type: "tag", values: tags } });
    return result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
  }, TAGS);
}

test("the console passes the automated accessibility checks while unconnected, configuring, editing macros and receiving data", async ({ page }) => {
  await page.addInitScript(() => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const readable = new ReadableStream<Uint8Array>({ start(streamController) { controller = streamController; } });
    const port = {
      readable,
      writable: new WritableStream<Uint8Array>(),
      async open() { window.setTimeout(() => controller?.enqueue(new TextEncoder().encode("READY\nCH0: 12.4\nWARN: supply high\n")), 20); },
      async close() { controller?.close(); }
    };
    Object.defineProperty(navigator, "serial", { configurable: true, value: { requestPort: async () => port, getPorts: async () => [] } });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "WirePulse" })).toBeVisible();
  expect(await failures(page), "unconnected").toEqual([]);

  await page.getByRole("button", { name: "Configure" }).click();
  expect(await failures(page), "Configure open").toEqual([]);
  await page.getByRole("button", { name: "Edit" }).click();
  expect(await failures(page), "macros in edit mode").toEqual([]);

  await page.getByRole("button", { name: "Connect device" }).click();
  await expect(page.getByText("WARN: supply high")).toBeVisible();
  await expect(page.getByText("12.4", { exact: true })).toBeVisible();
  expect(await failures(page), "connected, with log lines and telemetry").toEqual([]);
});

test("a browser without Web Serial shows its explanation in an accessible way", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, "serial", { configurable: true, value: undefined }); });
  await page.goto("/");
  await expect(page.getByText("Serial connection unavailable")).toBeVisible();
  expect(await failures(page)).toEqual([]);
});

test("every tab of the enterprise console passes the automated accessibility checks, with data in it", async ({ page }) => {
  const workspace = { id: "workspace-1", name: "Accessibility Lab", plan: "enterprise", role: "administrator", createdAt: "2026-11-01T00:00:00Z" };
  const stamp = "2026-11-01T03:59:10.900Z";
  const limits = { members: null, gateways: null, apiKeys: null, webhooks: null, scimTokens: null, queuedJobs: null, jobsPerMonth: null, reportsPerMonth: null, requestsPerMinute: null };
  const usage = { period: "2026-11-01", members: 1, pendingInvitations: 1, gateways: 1, apiKeys: 1, webhooks: 0, scimTokens: 1, queuedJobs: 0, jobsThisMonth: 0, reportsThisMonth: 0 };
  const hash = "0".repeat(64);
  const answers: Record<string, { status?: number; body: unknown }> = {
    "/v1/workspaces": { body: [workspace] },
    "/gateways": { body: [{ id: "g1", name: "Bench 3 PC", online: false, labels: { bench: "3", board: "esp32" }, lastHeartbeatAt: null, agentVersion: null, capabilities: {}, tokenExpiresAt: null, tokenRotatedAt: null, revokedAt: null, createdAt: stamp }] },
    "/members": { body: [{ subject: "dev-admin", email: "admin@wirepulse.local", role: "administrator", createdAt: stamp }] },
    "/invitations": { body: [{ id: "i1", email: "engineer@example.com", role: "engineer", invitedBy: "dev-admin", createdAt: stamp, expiresAt: "2026-11-08T03:59:10.900Z", acceptedBy: null, acceptedAt: null, revokedAt: null }] },
    "/api-keys": { body: [{ id: "k1", name: "ci-runner", role: "engineer", prefix: "wpk_hNZ0DEBL", createdBy: "dev-admin", createdAt: stamp, expiresAt: "2026-12-01T03:59:10.900Z", lastUsedAt: null, revokedAt: null }] },
    "/scim/tokens": { body: [{ id: "s1", name: "entra-provisioning", prefix: "wps_NaBGvi7v", createdBy: "dev-admin", createdAt: stamp, expiresAt: "2027-01-30T03:59:10.900Z", lastUsedAt: null, revokedAt: null }] },
    "/scim/users": { body: [] },
    "/webhooks": { status: 501, body: { error: "webhooks_not_configured" } },
    "/test-jobs": { body: [] },
    "/usage": { body: { plan: "enterprise", limits, usage } },
    "/audit-events": { body: [{ id: "5", chain_seq: "5", actor_subject: "dev-admin", action: "scim_token.created", resource_type: "scim_token", resource_id: "s1", request_id: "r1", ip_address: "127.0.0.1", details: { name: "entra-provisioning", expiresInDays: 90 }, created_at: stamp, prev_hash: hash, row_hash: hash }] },
    "/audit/verify": { body: { valid: true, checked: 5, firstBadSeq: null, lastSeq: 5, headHash: hash, complete: true, nextFromSeq: null } }
  };
  await page.route("http://enterprise.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const key = path === "/v1/workspaces" ? path : Object.keys(answers).find((suffix) => suffix !== "/v1/workspaces" && path.endsWith(suffix));
    const answer = key ? answers[key] : undefined;
    if (route.request().method() !== "GET" || !answer) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) });
    return route.fulfill({ status: answer.status ?? 200, contentType: "application/json", body: JSON.stringify(answer.body) });
  });
  await page.addInitScript(() => { Object.defineProperty(navigator, "serial", { configurable: true, value: { requestPort: async () => ({}), getPorts: async () => [] } }); });
  await page.goto("/");
  await page.getByPlaceholder("https://api.wirepulse.example.com").fill("http://enterprise.test");
  await page.getByPlaceholder("Paste short-lived token").fill("test-token");
  await page.getByRole("button", { name: "Connect workspace" }).click();
  await expect(page.getByRole("heading", { name: "Enterprise console · Accessibility Lab" })).toBeVisible();
  for (const tab of ["Jobs", "Gateways", "Team", "API keys", "Provisioning", "Webhooks", "Audit", "Usage"]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await expect(page.getByRole("tab", { name: tab, exact: true })).toHaveAttribute("aria-selected", "true");
    await page.waitForTimeout(400); // let the tab's own request finish and render
    expect(await failures(page), `tab ${tab}`).toEqual([]);
  }
});
