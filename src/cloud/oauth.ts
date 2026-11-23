/**
 * OAuth 2.0 sign-in for cloud storage, as a public client: authorization
 * code with PKCE, through a full-page redirect (the app's cross-origin
 * isolation cuts popups off from their opener), and refresh tokens to stay
 * signed in. No client secret and no backend.
 */

export type ProviderId = "dropbox" | "onedrive";

export interface OAuthConfig {
  id: ProviderId;
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Space-separated scopes; omitted when the app's settings decide them. */
  scope?: string;
  /** Extra parameters for the authorize request. */
  authorizeParams?: Record<string, string>;
}

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  /** When the access token expires (ms since epoch), with a margin. */
  expiresAt: number;
}

/** The sign-in expired or was revoked: the user has to sign in again. */
export class ReconnectNeeded extends Error {
  constructor(message = "Sign in again to keep syncing.") {
    super(message);
    this.name = "ReconnectNeeded";
  }
}

export interface PendingSignIn {
  provider: ProviderId;
  verifier: string;
  state: string;
}

const PENDING_KEY = "osplit-cloud-sign-in";

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A random URL-safe string, for the PKCE verifier and the state. */
export function randomString(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The S256 code challenge of a PKCE verifier. */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/**
 * The provider's sign-in page URL. Remembers the verifier and state in
 * `storage` (session storage survives the redirect in the same tab).
 */
export async function signInUrl(
  config: OAuthConfig,
  redirectUri: string,
  storage: Pick<Storage, "setItem">,
): Promise<string> {
  const pending: PendingSignIn = {
    provider: config.id,
    verifier: randomString(),
    state: randomString(),
  };
  storage.setItem(PENDING_KEY, JSON.stringify(pending));
  const url = new URL(config.authorizeUrl);
  const params: Record<string, string> = {
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    code_challenge: await codeChallenge(pending.verifier),
    code_challenge_method: "S256",
    state: pending.state,
    ...config.authorizeParams,
  };
  if (config.scope) params.scope = config.scope;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * The sign-in a redirect back to the app answers, if its state matches the
 * one this tab started. Forgets it either way, so it is used once.
 */
export function takePendingSignIn(
  params: URLSearchParams,
  storage: Pick<Storage, "getItem" | "removeItem">,
): PendingSignIn | null {
  const state = params.get("state");
  if (!state || !(params.has("code") || params.has("error"))) return null;
  const saved = storage.getItem(PENDING_KEY);
  storage.removeItem(PENDING_KEY);
  if (!saved) return null;
  try {
    const pending = JSON.parse(saved) as PendingSignIn;
    return pending.state === state ? pending : null;
  } catch {
    return null;
  }
}

async function tokenRequest(
  config: OAuthConfig,
  body: Record<string, string>,
  fetchFn: typeof fetch,
  previous?: Tokens,
): Promise<Tokens> {
  const response = await fetchFn(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, ...body }),
  });
  const result = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok || typeof result.access_token !== "string") {
    // The provider's own explanation, e.g. Microsoft's "AADSTS…" message.
    const detail = typeof result.error_description === "string"
      ? result.error_description.split(/\r?\n/)[0].slice(0, 300)
      : typeof result.error === "string" ? result.error : "";
    if (body.grant_type === "refresh_token" && (response.status === 400 || response.status === 401)) {
      throw new ReconnectNeeded();
    }
    throw new Error(`Sign-in failed (${response.status}${detail ? `: ${detail}` : ""}).`);
  }
  const expiresIn = typeof result.expires_in === "number" ? result.expires_in : 3600;
  return {
    accessToken: result.access_token,
    // Some providers send a new refresh token with each refresh; others keep
    // the first one.
    refreshToken: typeof result.refresh_token === "string"
      ? result.refresh_token
      : previous?.refreshToken,
    expiresAt: Date.now() + Math.max(60, expiresIn - 120) * 1000,
  };
}

/** Exchanges the code a redirect brought back for tokens. */
export function exchangeCode(
  config: OAuthConfig,
  code: string,
  verifier: string,
  redirectUri: string,
  fetchFn: typeof fetch = fetch,
): Promise<Tokens> {
  return tokenRequest(config, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  }, fetchFn);
}

/** New tokens from the refresh token; ReconnectNeeded when it no longer works. */
export function refreshTokens(
  config: OAuthConfig,
  tokens: Tokens,
  fetchFn: typeof fetch = fetch,
): Promise<Tokens> {
  if (!tokens.refreshToken) return Promise.reject(new ReconnectNeeded());
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
  };
  if (config.scope) body.scope = config.scope;
  return tokenRequest(config, body, fetchFn, tokens);
}

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits before retrying a throttled or failed request. */
function retryDelay(response: Response | null, attempt: number): number {
  const header = Number(response?.headers.get("Retry-After"));
  if (Number.isFinite(header) && header > 0) return Math.min(header, 60) * 1000;
  return 1000 * 2 ** attempt;
}

function retryable(response: Response): boolean {
  return response.status === 429 || (response.status >= 500 && response.status !== 501);
}

/**
 * Sends a request, retrying a few times when the service is throttling,
 * briefly failing or the network dropped.
 */
export async function withRetry(
  send: () => Promise<Response>,
  sleep: Sleep = realSleep,
  attempts = 4,
): Promise<Response> {
  for (let attempt = 0;; attempt++) {
    let response: Response | null = null;
    try {
      response = await send();
      if (!retryable(response) || attempt >= attempts - 1) return response;
    } catch (error) {
      if (attempt >= attempts - 1) throw error;
    }
    await sleep(retryDelay(response, attempt));
  }
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Sends requests with the access token, refreshing it when it expired or the
 * service rejects it, and saving refreshed tokens with `save`.
 */
export function authorizedFetcher(
  config: OAuthConfig,
  load: () => Tokens,
  save: (tokens: Tokens) => void,
  {
    fetchFn = fetch,
    sleep = realSleep,
    exclusive = (run) => run(),
  }: {
    fetchFn?: typeof fetch;
    sleep?: Sleep;
    /**
     * Runs a refresh alone across tabs: a provider that replaces the refresh
     * token on each use rejects a second refresh with the old one.
     */
    exclusive?: (run: () => Promise<Tokens>) => Promise<Tokens>;
  } = {},
): Fetcher {
  let refreshing: Promise<Tokens> | null = null;
  const refresh = (stale: Tokens): Promise<Tokens> => {
    refreshing ??= exclusive(async () => {
      // Another tab may have refreshed while this one waited.
      const current = load();
      if (current.accessToken !== stale.accessToken && Date.now() < current.expiresAt) {
        return current;
      }
      const tokens = await refreshTokens(config, current, fetchFn);
      save(tokens);
      return tokens;
    }).finally(() => {
      refreshing = null;
    });
    return refreshing;
  };
  const withToken = (init: RequestInit | undefined, token: string): RequestInit => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return { ...init, headers };
  };
  return async (url, init) => {
    let tokens = load();
    if (Date.now() >= tokens.expiresAt) tokens = await refresh(tokens);
    let response = await withRetry(() => fetchFn(url, withToken(init, tokens.accessToken)), sleep);
    if (response.status === 401) {
      tokens = await refresh(tokens);
      response = await withRetry(() => fetchFn(url, withToken(init, tokens.accessToken)), sleep);
      if (response.status === 401) throw new ReconnectNeeded();
    }
    return response;
  };
}
