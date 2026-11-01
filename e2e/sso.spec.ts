// Browser sign-in (authorization code with PKCE) against a real identity provider: a real Keycloak login page, the real API and PostgreSQL.
// Needs WP_TEST_DATABASE_URL and WP_TEST_KEYCLOAK_URL (scripts/test-keycloak.sh prepares the realm, including the console's public clients);
// skipped without them. Run with the dev server on :5173 (npm run dev), or on another origin named by WP_E2E_ORIGIN (then start the Keycloak with the same variable set). Keycloak is not Okta or Entra: this proves the console's flow
// (state, PKCE, code exchange, renewal, errors), not any particular vendor's quirks.
import { expect, test, type Page } from "@playwright/test";
// Plain ESM helpers shared with the API test-suite (no type declarations).
// @ts-ignore
import { createClient, createTestDatabase, skip as noDatabase, startApi } from "../api/test/helpers.mjs";

const ORIGIN = process.env.WP_E2E_ORIGIN ?? "http://127.0.0.1:5173";
const ISSUER = process.env.WP_TEST_KEYCLOAK_URL;
const skip = noDatabase || (ISSUER ? false : "WP_TEST_KEYCLOAK_URL not set (scripts/test-keycloak.sh prepares the realm)");
test.skip(!!skip, String(skip));
test.describe.configure({ mode: "serial" });

let database: any; let api: any; let shortApi: any; let plainApi: any;
const oidcEnv = (clientId: string) => ({ CORS_ORIGINS: ORIGIN, OIDC_ISSUER: ISSUER!, OIDC_AUDIENCE: "wirepulse-api", OIDC_CLIENT_ID: clientId, DEV_BEARER_TOKEN: "" });

test.beforeAll(async () => {
  database = await createTestDatabase();
  api = await startApi({ databaseUrl: database.url, env: oidcEnv("wirepulse-console") });
  // The second client's access tokens last 65 seconds, so the console renews them about five seconds after sign-in.
  shortApi = await startApi({ databaseUrl: database.url, env: oidcEnv("wirepulse-console-short"), });
  // No OIDC_CLIENT_ID: the control plane offers no browser sign-in.
  plainApi = await startApi({ databaseUrl: database.url, env: { CORS_ORIGINS: ORIGIN } });
});
test.afterAll(async () => {
  await plainApi?.stop(); await shortApi?.stop(); await api?.stop();
  await database?.drop();
});

async function startSignIn(page: Page, apiUrl: string) {
  await page.goto("/");
  await page.getByPlaceholder("https://api.wirepulse.example.com").fill(apiUrl);
  await page.getByRole("button", { name: "Sign in with SSO" }).click();
}
async function logInAtProvider(page: Page, username: string) {
  await page.waitForURL(/\/protocol\/openid-connect\/auth/);
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(`${username}-password`);
  await page.locator("#kc-login").click();
}

test("signs in through the provider's login page, connects, and keeps no token in browser storage", async ({ page }) => {
  const authorizationRequests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/protocol/openid-connect/auth?")) authorizationRequests.push(request.url()); });
  await startSignIn(page, api.url);
  await logInAtProvider(page, "pat");
  await expect(page.getByText(/^Connected\./)).toBeVisible({ timeout: 20_000 });

  // The request carried PKCE (S256 challenge, never the verifier), a state and a nonce, for the console's own client.
  const query = new URL(authorizationRequests[0]).searchParams;
  expect(query.get("response_type")).toBe("code");
  expect(query.get("client_id")).toBe("wirepulse-console");
  expect(query.get("code_challenge_method")).toBe("S256");
  expect(query.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(query.get("code_verifier")).toBeNull();
  expect(query.get("state")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  expect(query.get("nonce")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  expect(query.get("redirect_uri")).toBe(`${ORIGIN}/`);

  // Back on the console: the one-time code is gone from the address bar, and nothing secret was left in storage.
  expect(page.url()).toBe(`${ORIGIN}/`);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toMatch(/eyJ|access_token|refresh_token|code_verifier/);

  // The token works: the person (an ordinary member of nothing yet) creates a workspace through it.
  await expect(page.getByText("Signed in with SSO.")).toBeVisible();
  await page.getByPlaceholder("New workspace name").fill("SSO Lab");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Enterprise console · SSO Lab" })).toBeVisible();

  // Signing out ends the session in this tab and brings the sign-in controls back.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in with SSO" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Enterprise console · SSO Lab" })).toHaveCount(0);
});

test("a second person signs in and sees only their own workspaces", async ({ page }) => {
  await startSignIn(page, api.url);
  await logInAtProvider(page, "kim");
  await expect(page.getByText("Connected. 0 workspace(s) available.")).toBeVisible({ timeout: 20_000 });
});

test("a response whose state does not match the request is refused", async ({ page }) => {
  await startSignIn(page, api.url);
  await page.waitForURL(/\/protocol\/openid-connect\/auth/);
  await page.goto(`${ORIGIN}/?code=forged-code&state=not-the-state`);
  await expect(page.getByText(/Sign-in failed: .*\(state\)/)).toBeVisible();
  expect(page.url()).toBe(`${ORIGIN}/`);
  await expect(page.getByRole("button", { name: "Sign in with SSO" })).toBeVisible();
});

test("a refusal by the provider is shown, and the request is forgotten", async ({ page }) => {
  await page.route("**/protocol/openid-connect/auth?**", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    const back = new URL(query.get("redirect_uri")!);
    back.searchParams.set("error", "access_denied"); back.searchParams.set("error_description", "The administrator has not assigned you to this application."); back.searchParams.set("state", query.get("state")!);
    await route.fulfill({ status: 302, headers: { location: back.toString() } });
  });
  await startSignIn(page, api.url);
  await expect(page.getByText("Sign-in failed: The administrator has not assigned you to this application.")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
});

test("a control plane without browser sign-in says so and stays on the page", async ({ page }) => {
  await startSignIn(page, plainApi.url);
  await expect(page.getByText(/no browser sign-in configured/)).toBeVisible();
  expect(page.url()).toBe(`${ORIGIN}/`);
});

test("the console renews a short-lived access token by itself and keeps working", async ({ page }) => {
  const refreshes: string[] = [];
  page.on("request", (request) => { if (request.url().endsWith("/protocol/openid-connect/token") && request.postData()?.includes("grant_type=refresh_token")) refreshes.push(request.postData()!); });
  await startSignIn(page, shortApi.url);
  await logInAtProvider(page, "lee"); // lee's address is unverified; that only matters for invitations
  await expect(page.getByText(/^Connected\./)).toBeVisible({ timeout: 20_000 });
  await page.getByPlaceholder("New workspace name").fill("Renewal Lab");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Enterprise console · Renewal Lab" })).toBeVisible();

  await expect.poll(() => refreshes.length, { timeout: 30_000 }).toBeGreaterThan(0);
  // The 65-second token is not yet expired, but the next requests already use the renewed one; the console still answers.
  await page.getByRole("region", { name: "Enterprise console" }).getByRole("button", { name: "Refresh" }).first().click();
  await expect(page.getByText(/Could not load/)).toHaveCount(0);
  await expect(page.getByText("Signed in with SSO.")).toBeVisible();
});

test("the API answers its sign-in settings publicly, and only what the console needs", async () => {
  const anonymous = createClient(api.url);
  const configured = await anonymous("/auth/config");
  expect(configured.status).toBe(200);
  expect(configured.body).toEqual({ sso: { issuer: ISSUER, clientId: "wirepulse-console", scopes: "openid email profile", audience: null } });
  const plain = await createClient(plainApi.url)("/auth/config");
  expect(plain.body).toEqual({ sso: null });
});
