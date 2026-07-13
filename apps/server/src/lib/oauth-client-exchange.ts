// V-667.C — OAuth-CLIENT code-exchange + userinfo-fetch helpers.
//
// Step 4-5 of the auth flow: server-side POST to the IDP token
// endpoint to exchange `code` for `access_token`, then GET the
// userinfo endpoint to read the IDP's idea of the user. Both
// providers' responses are normalized to NormalizedUserInfo (see
// oauth-client-providers.ts) before the route layer touches them.
//
// fetch seam — every IDP-bound HTTP call routes through `deps.fetch`,
// allowing tests to mock both happy + error paths. Default is the
// global fetch in Node 22+.

import {
  type OAuthClientProvider,
  type NormalizedUserInfo,
  OAUTH_CLIENT_PROVIDERS,
} from './oauth-client-providers.js';

export interface ExchangeCodeOpts {
  provider: OAuthClientProvider;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  code: string;
  /** PKCE code_verifier matching the challenge in the authorize URL. */
  codeVerifier: string;
  fetch?: typeof fetch;
  /** Per-call IDP fetch deadline; defaults to DEFAULT_OAUTH_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface ExchangedTokens {
  accessToken: string;
  /** Google returns this; GitHub doesn't. The route uses it to read
   *  the sub claim without an extra userinfo round-trip. */
  idToken: string | null;
  /** Seconds until access_token expires. */
  expiresIn: number | null;
  refreshToken: string | null;
  /** IDP-returned scope string. Used as a sanity check vs requested. */
  scope: string | null;
}

export type ExchangeCodeResult =
  | { kind: 'ok'; tokens: ExchangedTokens }
  | { kind: 'invalid-grant' /* expired or already-used code */ }
  | { kind: 'invalid-client' /* mismatched client_id/secret */ }
  | { kind: 'idp-error'; status: number; body: string }
  | { kind: 'network-error'; message: string };

const DEFAULT_FETCH: typeof fetch = globalThis.fetch;

// V-667.C resilience — the IDP token/userinfo calls below run on the
// OAuth login request path. Node's global fetch has NO default timeout,
// so a hung/slow IDP endpoint would hang the login-callback handler
// indefinitely, holding a Fastify worker (no Fastify requestTimeout is
// set). Bound every IDP-bound fetch with an AbortController deadline,
// matching the pattern in lib/stripe-api.ts + lib/nowpayments-api.ts. A
// timeout surfaces through the existing catch as a network-error
// (token/userinfo) or falls through the /user/emails path to
// unverified-email — both already-handled results, no new variant.
const DEFAULT_OAUTH_FETCH_TIMEOUT_MS = 10_000;
const MAX_OAUTH_RESPONSE_BODY_BYTES = 256 * 1024;

class OAuthResponseTooLargeError extends Error {
  constructor(readonly status: number) {
    super(`IDP response exceeded ${MAX_OAUTH_RESPONSE_BODY_BYTES}-byte limit`);
    this.name = 'OAuthResponseTooLargeError';
  }
}

/** Status + ok + the fully-read body text. We return the read body (not the
 *  Response) so the abort timer can stay armed THROUGH the body read — clearing
 *  it after `fetch()` resolves (headers) but before the caller's `res.text()`
 *  would leave the body phase unbounded (only undici's ~300s default backstops
 *  it), the bug-class fixed in stripe-api `bc72ff48`. */
interface TimedResponse {
  status: number;
  ok: boolean;
  text: string;
}

async function readBoundedResponseBody(res: Response): Promise<string> {
  const declaredLength = res.headers.get('content-length');
  if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
    const bytes = Number(declaredLength);
    if (bytes > MAX_OAUTH_RESPONSE_BODY_BYTES) {
      await res.body?.cancel().catch(() => {});
      throw new OAuthResponseTooLargeError(res.status);
    }
  }

  if (res.body === null) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_OAUTH_RESPONSE_BODY_BYTES) {
        throw new OAuthResponseTooLargeError(res.status);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<TimedResponse> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ac.signal });
    // Read the body inside the timer scope so a stalled body aborts at timeoutMs.
    // Stream with a raw-byte ceiling so a fast, oversized IDP response cannot
    // exhaust memory before the caller's bounded error-body slice runs.
    const text = await readBoundedResponseBody(res);
    return { status: res.status, ok: res.ok, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exchange an authorization code for tokens against the IDP. Per-provider
 * body shape:
 *   - Google: standard form-encoded POST with grant_type, code,
 *     redirect_uri, client_id, client_secret, code_verifier
 *   - GitHub: same shape but accepts Accept: application/json header
 *     (without it, GitHub returns x-www-form-urlencoded body)
 */
export async function exchangeCodeForTokens(opts: ExchangeCodeOpts): Promise<ExchangeCodeResult> {
  const provider = OAUTH_CLIENT_PROVIDERS[opts.provider];
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.callbackUrl,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code_verifier: opts.codeVerifier,
  });
  const fetchImpl = opts.fetch ?? DEFAULT_FETCH;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_OAUTH_FETCH_TIMEOUT_MS;
  let res: TimedResponse;
  try {
    res = await fetchWithTimeout(
      fetchImpl,
      provider.tokenUrl,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
      },
      timeoutMs,
    );
  } catch (err) {
    if (err instanceof OAuthResponseTooLargeError) {
      return { kind: 'idp-error', status: err.status, body: err.message };
    }
    return {
      kind: 'network-error',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const text = res.text;
  let parsed: Record<string, unknown>;
  try {
    parsed = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return { kind: 'idp-error', status: res.status, body: text.slice(0, 500) };
  }

  if (!res.ok) {
    const errCode = typeof parsed.error === 'string' ? parsed.error : '';
    if (errCode === 'invalid_grant') return { kind: 'invalid-grant' };
    if (errCode === 'invalid_client') return { kind: 'invalid-client' };
    return { kind: 'idp-error', status: res.status, body: text.slice(0, 500) };
  }

  // Some providers (notably GitHub before sending Accept: json) return a
  // 200 with `error=...` body when the code is bad. Treat that same as
  // an HTTP-error response.
  if (typeof parsed.error === 'string') {
    if (parsed.error === 'invalid_grant' || parsed.error === 'bad_verification_code') {
      return { kind: 'invalid-grant' };
    }
    if (parsed.error === 'invalid_client') return { kind: 'invalid-client' };
    return { kind: 'idp-error', status: 200, body: text.slice(0, 500) };
  }

  const accessToken = typeof parsed.access_token === 'string' ? parsed.access_token : '';
  if (accessToken.length === 0) {
    return { kind: 'idp-error', status: res.status, body: 'missing access_token' };
  }
  return {
    kind: 'ok',
    tokens: {
      accessToken,
      idToken: typeof parsed.id_token === 'string' ? parsed.id_token : null,
      expiresIn: typeof parsed.expires_in === 'number' ? parsed.expires_in : null,
      refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : null,
      scope: typeof parsed.scope === 'string' ? parsed.scope : null,
    },
  };
}

export interface FetchUserInfoOpts {
  provider: OAuthClientProvider;
  accessToken: string;
  fetch?: typeof fetch;
  /** Per-call IDP fetch deadline; defaults to DEFAULT_OAUTH_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
}

export type FetchUserInfoResult =
  | { kind: 'ok'; user: NormalizedUserInfo }
  | { kind: 'unauthorized' /* access_token rejected or revoked */ }
  | { kind: 'unverified-email' /* IDP returned no verified email */ }
  | { kind: 'idp-error'; status: number; body: string }
  | { kind: 'network-error'; message: string };

/**
 * Fetch + normalize the user profile from the IDP. Returns
 * NormalizedUserInfo on success. The function rejects unverified
 * emails — the Verdict 1 (merge-with-verification) collision-flow
 * depends on a trustworthy IDP-asserted email, so we don't proceed
 * unless the IDP says the email is verified.
 */
export async function fetchUserInfo(opts: FetchUserInfoOpts): Promise<FetchUserInfoResult> {
  const provider = OAUTH_CLIENT_PROVIDERS[opts.provider];
  const fetchImpl = opts.fetch ?? DEFAULT_FETCH;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_OAUTH_FETCH_TIMEOUT_MS;
  let res: TimedResponse;
  try {
    res = await fetchWithTimeout(
      fetchImpl,
      provider.userinfoUrl,
      {
        headers: {
          authorization: `Bearer ${opts.accessToken}`,
          accept: 'application/json',
          // GitHub requires a User-Agent on api.github.com requests.
          'user-agent': 'driftstack-api',
        },
      },
      timeoutMs,
    );
  } catch (err) {
    if (err instanceof OAuthResponseTooLargeError) {
      return { kind: 'idp-error', status: err.status, body: err.message };
    }
    return {
      kind: 'network-error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (res.status === 401) return { kind: 'unauthorized' };
  const text = res.text;
  if (!res.ok) {
    return { kind: 'idp-error', status: res.status, body: text.slice(0, 500) };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { kind: 'idp-error', status: res.status, body: text.slice(0, 500) };
  }

  if (opts.provider === 'google') {
    // Google openid userinfo response: { sub, email, email_verified, name, picture }
    const sub = typeof parsed.sub === 'string' ? parsed.sub : '';
    const email = typeof parsed.email === 'string' ? parsed.email : '';
    const emailVerified = parsed.email_verified === true;
    if (sub.length === 0 || email.length === 0) {
      return { kind: 'idp-error', status: 200, body: 'missing sub/email' };
    }
    if (!emailVerified) return { kind: 'unverified-email' };
    return {
      kind: 'ok',
      user: {
        providerSub: sub,
        email,
        emailVerified: true,
        name: typeof parsed.name === 'string' ? parsed.name : null,
        avatarUrl: typeof parsed.picture === 'string' ? parsed.picture : null,
      },
    };
  }

  // GitHub: /user returns { id: number, login, name, avatar_url }. Email
  // is null on /user when the customer has "Keep my email addresses
  // private" enabled in GitHub settings (the default for ~half of
  // accounts). Fall back to /user/emails (requires the user:email
  // scope which we always request) to find the primary + verified
  // address. 2026-05-20 fix: previously this path returned
  // unverified-email which surfaced as "Userinfo fetch failed:
  // unverified-email" on the customer side even though their
  // GitHub email IS verified.
  const id = parsed.id;
  const githubId = typeof id === 'number' ? String(id) : typeof id === 'string' ? id : '';
  if (githubId.length === 0) {
    return { kind: 'idp-error', status: 200, body: 'missing GitHub id' };
  }
  let email = typeof parsed.email === 'string' ? parsed.email : '';
  if (email.length === 0) {
    // /user/emails fallback. Returns:
    //   [{ email, primary, verified, visibility }, ...]
    // We want the primary + verified entry. The user:email scope is
    // always requested in OAUTH_CLIENT_PROVIDERS so this call should
    // succeed for any logged-in customer.
    try {
      const emailsRes = await fetchWithTimeout(
        fetchImpl,
        'https://api.github.com/user/emails',
        {
          headers: {
            authorization: `Bearer ${opts.accessToken}`,
            accept: 'application/json',
            'user-agent': 'driftstack-api',
          },
        },
        timeoutMs,
      );
      if (emailsRes.ok) {
        const emailsText = emailsRes.text;
        try {
          const emailsParsed = JSON.parse(emailsText) as Array<{
            email?: string;
            primary?: boolean;
            verified?: boolean;
          }>;
          if (Array.isArray(emailsParsed)) {
            const primary = emailsParsed.find(
              (e) => e.primary === true && e.verified === true && typeof e.email === 'string',
            );
            if (primary?.email !== undefined) email = primary.email;
          }
        } catch {
          /* fall through to unverified-email below */
        }
      }
    } catch {
      /* fall through to unverified-email below */
    }
  }
  if (email.length === 0) {
    return { kind: 'unverified-email' };
  }
  return {
    kind: 'ok',
    user: {
      providerSub: githubId,
      email,
      // GitHub's /user doesn't carry a per-user email_verified flag;
      // the /user/emails endpoint does. Caller cross-checks if needed.
      // Treat the primary email as verified for the V-667.C trust
      // contract since GitHub only exposes primary emails on verified
      // accounts.
      emailVerified: true,
      name: typeof parsed.name === 'string' ? parsed.name : null,
      avatarUrl: typeof parsed.avatar_url === 'string' ? parsed.avatar_url : null,
    },
  };
}
