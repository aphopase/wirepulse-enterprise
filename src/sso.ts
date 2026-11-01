// Browser sign-in for the enterprise panel: OpenID Connect authorization code flow with PKCE (RFC 7636, S256) for a public client.
// The access token (and a refresh token, if the provider issues one) lives in memory only. The one thing written to sessionStorage is
// the request in flight (state, code verifier, nonce, the control-plane URL), removed the moment the provider sends the browser back.

export type SsoSettings = { issuer: string; clientId: string; scopes: string; audience: string | null };
export type SsoTokens = { accessToken: string; refreshToken: string | null; expiresAt: number };
export type SsoCallback = { apiUrl: string; tokens: SsoTokens; settings: SsoSettings };

type Discovery = { authorization_endpoint: string; token_endpoint: string };
type Pending = { state: string; verifier: string; nonce: string; apiUrl: string; redirectUri: string; settings: SsoSettings; tokenEndpoint: string; startedAt: number };

const PENDING_KEY = "wirepulse.sso.pending";
const PENDING_MAX_AGE_MS = 10 * 60_000;

export class SsoError extends Error {}

const base64Url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomString = (bytes: number): string => base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
const redirectUriHere = (): string => `${window.location.origin}${window.location.pathname}`;
const loopback = (host: string): boolean => host === "localhost" || host === "127.0.0.1" || host === "[::1]";
const trimSlash = (value: string): string => value.replace(/\/$/, "");

// Endpoints the browser will send credentials to must be https; plain http is accepted only for a provider on this machine (development).
function secureEndpoint(value: unknown, what: string): string {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new SsoError(`The identity provider's ${what} is not a URL.`); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname))) throw new SsoError(`The identity provider's ${what} must use https.`);
  return url.toString();
}

// Asks the control plane whether it offers browser sign-in. null: it does not (no OIDC_CLIENT_ID), so only a pasted token works.
export async function fetchSsoSettings(apiUrl: string): Promise<SsoSettings | null> {
  const response = await fetch(`${trimSlash(apiUrl)}/auth/config`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new SsoError(`The control plane did not answer the sign-in settings request (${response.status}).`);
  const body = (await response.json().catch(() => null)) as { sso?: Partial<SsoSettings> | null } | null;
  const sso = body?.sso;
  if (!sso) return null;
  if (typeof sso.issuer !== "string" || typeof sso.clientId !== "string" || typeof sso.scopes !== "string") throw new SsoError("The control plane sent sign-in settings that cannot be used.");
  return { issuer: sso.issuer, clientId: sso.clientId, scopes: sso.scopes, audience: typeof sso.audience === "string" ? sso.audience : null };
}

async function discover(settings: SsoSettings): Promise<Discovery> {
  const response = await fetch(`${trimSlash(settings.issuer)}/.well-known/openid-configuration`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new SsoError(`The identity provider's discovery document could not be read (${response.status}).`);
  const document = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!document || trimSlash(String(document.issuer)) !== trimSlash(settings.issuer)) throw new SsoError("The identity provider's discovery document names a different issuer than the control plane expects.");
  return { authorization_endpoint: secureEndpoint(document.authorization_endpoint, "authorization endpoint"), token_endpoint: secureEndpoint(document.token_endpoint, "token endpoint") };
}

// Leaves the page: the browser goes to the identity provider and comes back to this address with ?code=…&state=….
export async function beginSignIn(apiUrl: string, settings: SsoSettings): Promise<void> {
  if (!window.crypto?.subtle) throw new SsoError("Browser sign-in needs a secure context (https, or localhost).");
  const discovery = await discover(settings);
  const verifier = randomString(48);
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const pending: Pending = { state: randomString(24), verifier, nonce: randomString(24), apiUrl, redirectUri: redirectUriHere(), settings, tokenEndpoint: discovery.token_endpoint, startedAt: Date.now() };
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  const url = new URL(discovery.authorization_endpoint);
  const query: Record<string, string> = { response_type: "code", client_id: settings.clientId, redirect_uri: pending.redirectUri, scope: settings.scopes, state: pending.state, nonce: pending.nonce, code_challenge: challenge, code_challenge_method: "S256" };
  if (settings.audience) query.audience = settings.audience;
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  window.location.assign(url.toString());
}

async function tokenRequest(endpoint: string, form: Record<string, string>, previousRefresh: string | null): Promise<{ tokens: SsoTokens; idToken: string | null }> {
  let response: Response;
  try { response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form) }); }
  catch { throw new SsoError("The identity provider's token endpoint could not be reached."); }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof body.access_token !== "string" || !body.access_token) {
    throw new SsoError(typeof body.error_description === "string" ? body.error_description : typeof body.error === "string" ? `Sign-in failed: ${body.error}.` : `Sign-in failed (${response.status}).`);
  }
  const lifetime = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 300;
  return {
    tokens: { accessToken: body.access_token, refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : previousRefresh, expiresAt: Date.now() + lifetime * 1000 },
    idToken: typeof body.id_token === "string" ? body.id_token : null
  };
}

function nonceOf(idToken: string): string | null {
  try { return (JSON.parse(atob(idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { nonce?: string }).nonce ?? null; } catch { return null; }
}

// True when the address bar carries an authorization response (success or error) for a request this tab started.
export function isSsoReturn(): boolean {
  const query = new URLSearchParams(window.location.search);
  return query.has("state") && (query.has("code") || query.has("error")) && sessionStorage.getItem(PENDING_KEY) !== null;
}

// Finishes a sign-in begun by beginSignIn: checks state, exchanges the code (with the verifier) for tokens, and cleans the address bar.
export async function completeSignIn(): Promise<SsoCallback> {
  const query = new URLSearchParams(window.location.search);
  const raw = sessionStorage.getItem(PENDING_KEY);
  sessionStorage.removeItem(PENDING_KEY);
  window.history.replaceState(null, "", window.location.pathname); // the code is single-use; do not leave it in the history entry
  const pending = raw ? (JSON.parse(raw) as Pending) : null;
  if (!pending || Date.now() - pending.startedAt > PENDING_MAX_AGE_MS) throw new SsoError("That sign-in was not started here, or it took too long. Start again.");
  if (query.get("state") !== pending.state) throw new SsoError("The sign-in response did not match the request (state). Start again.");
  if (query.has("error")) throw new SsoError(query.get("error_description") ?? `The identity provider refused the sign-in: ${query.get("error")}.`);
  const code = query.get("code");
  if (!code) throw new SsoError("The sign-in response carried no code.");
  const { tokens, idToken } = await tokenRequest(pending.tokenEndpoint, { grant_type: "authorization_code", code, redirect_uri: pending.redirectUri, client_id: pending.settings.clientId, code_verifier: pending.verifier }, null);
  const returnedNonce = idToken ? nonceOf(idToken) : null;
  if (returnedNonce !== null && returnedNonce !== pending.nonce) throw new SsoError("The sign-in response did not match the request (nonce). Start again.");
  return { apiUrl: pending.apiUrl, tokens, settings: pending.settings };
}

// Trades the refresh token for a new access token. Throws when there is none or the provider refuses it (then the person signs in again).
export async function refreshSignIn(settings: SsoSettings, tokens: SsoTokens): Promise<SsoTokens> {
  if (!tokens.refreshToken) throw new SsoError("The session has ended. Sign in again.");
  const discovery = await discover(settings);
  return (await tokenRequest(discovery.token_endpoint, { grant_type: "refresh_token", refresh_token: tokens.refreshToken, client_id: settings.clientId }, tokens.refreshToken)).tokens;
}
