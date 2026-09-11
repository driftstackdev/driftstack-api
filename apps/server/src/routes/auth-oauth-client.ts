// V-667.C — OAuth-client (sign-in-with-Google/GitHub) routes.
//
//   POST /v1/auth/oauth-client/start           — issue authorize URL
//   GET  /v1/auth/oauth/:provider/callback     — IDP redirects here;
//                                                 302 to SPA callback
//   GET  /v1/auth/oauth-client/callback        — SPA-side exchange
//                                                 (existing flow)
//   POST /v1/auth/oauth-client/confirm-merge   — Verdict 1 collision-
//                                                 flow completion
//   POST /v1/auth/oauth-client/redeem          — v2: hand-off code +
//                                                 flow secret → session
//
// Path A (2026-05-16): the IDP redirect target moved from the SPA
// origin (`${dashboardOrigin}/auth/oauth-client/callback`) to the API
// per-provider path (`${callbackUrlBase}/${provider}/callback`) so the
// `redirect_uri` Google + GitHub Consoles registered actually matches
// what the IDP sees. The per-provider API route only does a 302 to
// the SPA, preserving the IDP's query string — so the existing SPA
// fetch flow against /v1/auth/oauth-client/callback is unchanged
// (PKCE cookie path scope still aligns).
//
// PKCE verifier storage: HTTP-only secure cookie keyed on the state
// nonce. The cookie is HMAC-signed via the same OAUTH_CLIENT_STATE_
// SIGNING_SECRET used to sign the state JWT; tampering is detected.
// Cookie path is restricted to /v1/auth/oauth-client and 5-min Max-
// Age matches the state TTL. The IDP-direct redirect path (/v1/auth
// /oauth/:provider/callback) doesn't need the cookie — it just 302s
// to the SPA which then fetches /v1/auth/oauth-client/callback where
// the cookie IS in scope.
//
// Cookie-free v2 (2026-09-11) — the owner's "Google/GitHub login broken"
// blocker. The dashboard lives on app.driftstack.io and the API on
// api.driftstack.dev: different registrable domains, so the PKCE cookie
// above is SET on the response to a cross-site XHR and Safari ITP (the
// owner's default) drops it before it is ever stored; the read at the
// callback then finds nothing ("PKCE verifier cookie missing or
// invalid"). No cookie attribute fixes a cookie that was never stored.
// v2 keeps NO browser state on the API host at all:
//   1. the dashboard mints a random flow_secret in its OWN first-party
//      localStorage and POSTs binding_hash = sha256(flow_secret) to
//      /start; the server signs `bind` into the state, stores the PKCE
//      verifier in Redis under the state nonce (single-use, 5 min) and
//      answers {authorize_url, flow_id} with NO Set-Cookie;
//   2. the IDP returns top-level to /v1/auth/oauth/:provider/callback,
//      which (for a verified state carrying `bind`) GETDELs the
//      verifier, runs the token exchange + userinfo, parks the result
//      in Redis under sha256(handoff_code) for 60 s and 302s to the
//      state's own allow-listed dashboard origin with the single-use
//      code in the URL FRAGMENT (never sent to a server, never in
//      Referer, stripped from history by the page);
//   3. the page POSTs {code, flow_secret} to /redeem (no credentials);
//      the server consumes the record, checks sha256(flow_secret) ===
//      bind in constant time, and only THEN links the account and mints
//      the session — the same JSON the legacy XHR callback returns.
// D2 is not dropped: the cookie↔state-nonce binding becomes a
// flow_secret↔state.bind binding, checked BEFORE any DB write or
// session mint, so an attacker's state paired with a victim's browser
// still fails (the preimage exists only in the initiating browser), and
// it does not rely on PKCE, so it holds for GitHub OAuth Apps too.
// Every state without `bind` (an old bundle, or one minted before the
// deploy) takes the legacy forward + cookie route below, byte-for-byte.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  buildAuthorizeUrl,
  type NormalizedUserInfo,
  type OAuthClientProvider,
} from '../lib/oauth-client-providers.js';
import { computeS256Challenge } from '../lib/oauth-pkce.js';
import { signOauthClientState, verifyOauthClientState } from '../lib/oauth-client-state.js';
import { exchangeCodeForTokens, fetchUserInfo } from '../lib/oauth-client-exchange.js';
import type { MfaChallengeStore } from '../services/mfa-challenge-store.js';
import { parseRequestBodyReportingUnknown } from '../lib/unknown-request-fields.js';
import type { OAuthClientService } from '../services/oauth-client.js';
import type { AuthFlowsService } from '../services/auth-flows.js';
import type { RateLimitStore } from '../services/rate-limit.js';
import { BadRequestError, ValidationError } from '../lib/errors.js';
import { FIRST_PARTY_DASHBOARD_ORIGINS } from '../lib/cors-allow.js';
import { readClientIp } from '../lib/client-ip.js';
import { AUTH_IP_LIMITS, ipRateLimit } from '../middleware/ip-rate-limit.js';
import type { Logger } from '../lib/logger.js';

const COOKIE_NAME_PREFIX = 'ds_oauth_pkce_';
const COOKIE_TTL_SECONDS = 300; // 5 min — matches state TTL

// v2 store keys (caller-prefixed: the store is shared with the MFA
// challenge hand-off, which prefixes its own keys with 'mfa-challenge:').
const VERIFIER_KEY_PREFIX = 'oauth-client-verifier:';
const HANDOFF_KEY_PREFIX = 'oauth-client-handoff:';
/** Verifier record lifetime — equals the state TTL; the state's iat check
 *  stays the authority, the record TTL only bounds Redis occupancy. */
const VERIFIER_TTL_SECONDS = 300;
/** Hand-off record lifetime: the 302 → page load → redeem XHR takes
 *  seconds; 60 s bounds how long a leaked fragment could be redeemed
 *  (and it still needs the flow-secret preimage). */
const HANDOFF_TTL_SECONDS = 60;
/** 32 random bytes, base64url, unpadded → exactly 43 chars. Shared by
 *  binding_hash (sha256 digest), flow_secret and the hand-off code. */
const BASE64URL_256_BIT_RE = /^[A-Za-z0-9_-]{43}$/;

const StartBodySchema = z.object({
  provider: z.enum(['google', 'github']),
  redirect_to: z.string().url(),
});

// v2 opt-in on /start. Read from the raw body beside StartBodySchema rather
// than as an `.optional()` member of it: the anonymous-route exemption
// guard pins that schema as having no optional field, and its two-field
// shape is content-pinned. Present → v2 (must be a 43-char digest);
// absent → the legacy cookie flow, which is what an old bundle sends.
const BindingHashSchema = z.string().regex(BASE64URL_256_BIT_RE);

const RedeemBodySchema = z.object({
  code: z.string().regex(BASE64URL_256_BIT_RE),
  flow_secret: z.string().regex(BASE64URL_256_BIT_RE),
});

/** Bounded, fixed enum carried in the fragment on a v2 failure. Never a
 *  free-text IDP string: the Location header is the one place a caller
 *  value could otherwise reach. */
type OauthFragmentError =
  | 'idp_denied'
  | 'state_invalid'
  | 'state_replayed'
  | 'missing_code'
  | 'provider_unavailable'
  | 'exchange_failed'
  | 'userinfo_failed';

/** What the top-level callback parks in Redis between the IDP exchange
 *  and /redeem. No session, no challenge, no DB write has happened yet;
 *  PII sits here ≤ HANDOFF_TTL_SECONDS under a hashed key (precedent:
 *  MfaChallengePayload.email). */
interface HandoffRecord {
  v: 1;
  provider: OAuthClientProvider;
  user: NormalizedUserInfo;
  redirectTo: string;
  /** state.bind, carried so /redeem can check the preimage. */
  bind: string;
  iat: number;
}

const ConfirmMergeBodySchema = z.object({
  token: z.string().min(32).max(128),
});

export interface RegisterOAuthClientRoutesDeps {
  service: OAuthClientService;
  /** Per-provider client_id + client_secret. When a provider's creds
   *  are missing, /start with that provider returns 400. */
  providers: Partial<Record<OAuthClientProvider, { clientId: string; clientSecret: string }>>;
  /** Base origin+prefix for per-provider callback URL derivation.
   *  Full URL: `${callbackUrlBase}/${provider}/callback`. Must match
   *  the IDP-Console-registered redirect URI per provider. Should NOT
   *  end with a trailing slash; schema-level transform strips it. */
  callbackUrlBase: string;
  /** Dashboard origin for the post-IDP 302 redirect from
   *  /v1/auth/oauth/:provider/callback to the SPA exchange page. */
  dashboardOrigin: string;
  /** HMAC-SHA256 key for state JWT + cookie signing (≥32 chars). */
  signingSecret: string;
  logger: Logger;
  /**
   * Injectable HTTP client for the two IDP calls (token exchange +
   * userinfo). Optional; production leaves it unset and the exchange
   * helpers fall back to the global fetch.
   *
   * It exists because those helpers capture `globalThis.fetch` at MODULE
   * LOAD (`lib/oauth-client-exchange.ts`), so a test's
   * `vi.stubGlobal('fetch', …)` can never reach them — the capture still
   * points at the original. Without this seam the IDP legs of the callback
   * were untestable AND every arm that got past the state/cookie checks made
   * a REAL outbound request to the provider (measured: a POST to GitHub's
   * token endpoint answers 404 in ~250ms, which is why the failure surfaced
   * as `idp-error` rather than `network-error`).
   */
  fetch?: typeof fetch;
  /** 2026-05-19 — auth-flows service used to mint a 30-day web
   *  session after a successful link-or-create. Without this, the
   *  callback would return `{outcome, account_id}` without a token
   *  and the dashboard would show "Sign in to see live account data"
   *  on the post-OAuth landing. */
  authFlows: AuthFlowsService;
  /** 2026-05-20 — required for IP-gate preHandlers on /start +
   *  /callback + /confirm-merge (per 2026-05-19 rate-limit audit
   *  doc — these were unauthenticated routes with no abuse gate).
   *  Same store the AUTH_IP_LIMITS gates on auth.ts use. */
  rateLimitStore: RateLimitStore;
  /** Test seam — defaults to Date.now() / randomBytes. */
  nowMs?: () => number;
  /**
   * 2026-09-11 — single-use store for the v2 PKCE verifier (keyed by the
   * state nonce) and the post-exchange hand-off record (keyed by the
   * hashed hand-off code). Production passes a RedisMfaChallengeStore;
   * tests the InMemory one. REQUIRED on purpose: a v2 /start with no
   * store must fail to compile, not fall back to the cookie the design
   * exists to remove. Fails closed on a Redis outage, like MFA login.
   */
  flowStore: Pick<MfaChallengeStore, 'set' | 'consume'>;
}

/**
 * Derive the IDP-facing callback URL for a given provider. Both
 * `buildAuthorizeUrl` (sent to IDP at authorize time) and
 * `exchangeCodeForTokens` (sent to IDP at token-exchange time) MUST
 * pass the same value — IDPs reject the token exchange if the
 * `redirect_uri` differs from what they saw at authorize.
 */
function callbackUrlFor(provider: OAuthClientProvider, base: string): string {
  return `${base}/${provider}/callback`;
}

/**
 * The closed dashboard-origin allow-list: the configured origin, widened to
 * BOTH first-party hosts only when the configured one is itself first-party
 * (T-3 host move, 2026-09-05). Never derived from the request.
 *
 * Deliberately the same rule as the inline block in /start, which stays
 * inline because a content-parity pin regexes it there; this helper serves
 * the REDIRECT site, where the final 302 origin is chosen. The two must not
 * drift — a guard compares them.
 */
export function allowedDashboardOrigins(dashboardOrigin: string): Set<string> {
  const configuredOrigin = new URL(dashboardOrigin).origin;
  const allowed = new Set([configuredOrigin]);
  if (FIRST_PARTY_DASHBOARD_ORIGINS.includes(configuredOrigin)) {
    for (const origin of FIRST_PARTY_DASHBOARD_ORIGINS) allowed.add(origin);
  }
  return allowed;
}

/**
 * Origin the top-level callback may 302 to for a VERIFIED state: the
 * origin of the state's own redirectTo when it is on the allow-list, else
 * null (the caller refuses — it never falls through to the raw value).
 * A sign-in started on app.driftstack.io finishes on app.driftstack.io even
 * while DASHBOARD_ORIGIN names app.driftstack.dev (measured on prod
 * 2026-09-05), which is also what keeps the flow secret in the partition
 * that wrote it under Firefox Total Cookie Protection.
 */
function redirectOriginFor(redirectTo: string, dashboardOrigin: string): string | null {
  let origin: string;
  try {
    origin = new URL(redirectTo).origin;
  } catch {
    return null;
  }
  return allowedDashboardOrigins(dashboardOrigin).has(origin) ? origin : null;
}

/** Fixed path + bounded enum in the FRAGMENT. */
function fragmentErrorUrl(origin: string, code: OauthFragmentError): string {
  return `${origin}/auth/oauth-client/callback/#oauth_error=${code}`;
}

function readBindingHash(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const raw = (body as Record<string, unknown>).binding_hash;
  if (raw === undefined) return undefined;
  const parsed = BindingHashSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.flatten());
  return parsed.data;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function verifierKey(nonce: string): string {
  return `${VERIFIER_KEY_PREFIX}${sha256Hex(nonce)}`;
}

function handoffKey(code: string): string {
  return `${HANDOFF_KEY_PREFIX}${sha256Hex(code)}`;
}

/** Public, non-secret id the page uses to find its own localStorage
 *  record. Derived from the nonce (already public inside the state). */
function flowIdFor(nonce: string): string {
  return createHash('sha256').update(nonce).digest('base64url');
}

function parseHandoffRecord(raw: string): HandoffRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (r.provider !== 'google' && r.provider !== 'github') return null;
  if (typeof r.redirectTo !== 'string' || typeof r.bind !== 'string') return null;
  if (typeof r.iat !== 'number') return null;
  const user = r.user;
  if (user === null || typeof user !== 'object') return null;
  const u = user as Record<string, unknown>;
  if (typeof u.providerSub !== 'string' || typeof u.email !== 'string') return null;
  if (typeof u.emailVerified !== 'boolean') return null;
  if (u.name !== null && typeof u.name !== 'string') return null;
  if (u.avatarUrl !== null && typeof u.avatarUrl !== 'string') return null;
  return {
    v: 1,
    provider: r.provider,
    user: {
      providerSub: u.providerSub,
      email: u.email,
      emailVerified: u.emailVerified,
      name: u.name,
      avatarUrl: u.avatarUrl,
    },
    redirectTo: r.redirectTo,
    bind: r.bind,
    iat: r.iat,
  };
}

export function registerOAuthClientRoutes(
  app: FastifyInstance,
  deps: RegisterOAuthClientRoutesDeps,
): void {
  const now = deps.nowMs ?? (() => Date.now());

  // 2026-05-20 — IP gates (pre-launch blocker per 2026-05-19
  // rate-limit audit). Unauthenticated routes; account-creation
  // flood is the real abuse vector on /callback's success path,
  // since the linkOrCreateAccount call mints a fresh row + a
  // 30-day web session for a never-seen IDP identity.
  const startGate = ipRateLimit(deps.rateLimitStore, {
    bucketPrefix: 'oauth_client_start',
    capacity: AUTH_IP_LIMITS.oauthClientStart.capacity,
    refillPerSecond: AUTH_IP_LIMITS.oauthClientStart.refillPerSecond,
  });
  const callbackGate = ipRateLimit(deps.rateLimitStore, {
    bucketPrefix: 'oauth_client_callback',
    capacity: AUTH_IP_LIMITS.oauthClientCallback.capacity,
    refillPerSecond: AUTH_IP_LIMITS.oauthClientCallback.refillPerSecond,
  });
  const confirmMergeGate = ipRateLimit(deps.rateLimitStore, {
    bucketPrefix: 'oauth_client_confirm_merge',
    capacity: AUTH_IP_LIMITS.oauthClientConfirmMerge.capacity,
    refillPerSecond: AUTH_IP_LIMITS.oauthClientConfirmMerge.refillPerSecond,
  });
  // 2026-09-11 — the top-level IDP-return route now makes outbound IDP
  // calls (v2) and /redeem is where the account row + session are minted,
  // so both are gated. Each has its OWN bucket: sharing `callbackGate`'s
  // bucket would charge a sign-in two tokens (top-level + redeem) and
  // could 429 the top-level NAVIGATION as a raw problem+json page on the
  // API host after a couple of quick retries. Same 5/min/IP budget.
  const topLevelGate = ipRateLimit(deps.rateLimitStore, {
    bucketPrefix: 'oauth_client_toplevel',
    capacity: AUTH_IP_LIMITS.oauthClientCallback.capacity,
    refillPerSecond: AUTH_IP_LIMITS.oauthClientCallback.refillPerSecond,
  });
  const redeemGate = ipRateLimit(deps.rateLimitStore, {
    bucketPrefix: 'oauth_client_redeem',
    capacity: AUTH_IP_LIMITS.oauthClientCallback.capacity,
    refillPerSecond: AUTH_IP_LIMITS.oauthClientCallback.refillPerSecond,
  });

  /**
   * Link-or-create + session mint + the 4-outcome JSON. Shared by the
   * legacy XHR callback (runs it right after the exchange) and /redeem
   * (runs it after the hand-off binding check) so both answer the same
   * shape and the SPA's outcome handling is one code path.
   */
  async function completeSignIn(
    req: FastifyRequest,
    provider: OAuthClientProvider,
    user: NormalizedUserInfo,
    redirectTo: string,
  ): Promise<Record<string, unknown>> {
    // Service: link-or-create with founder-verdict-locked semantics.
    const result = await deps.service.linkOrCreateAccount({
      provider,
      providerSub: user.providerSub,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      now: new Date(now()),
    });

    // 2026-05-19 — successful link-or-create mints a 30-day web
    // session immediately so the dashboard finds a token in
    // localStorage on landing. Prior to this fix the callback
    // returned `{outcome, account_id, redirect_to}` only; the SPA
    // would then load the dashboard with no token and surface
    // "Sign in to see live account data" — same UX as if the
    // user had never signed in. The OAuth IDP attestation is the
    // primary auth event; AuthFlows still refuses a session when
    // local MFA is enrolled, falling back to password + MFA until
    // the dashboard has a dedicated OAuth→MFA challenge handoff.
    let sessionToken: string | undefined;
    let mfaChallenge: { challengeToken: string; challengeExpiresAt: Date } | undefined;
    if (result.kind === 'signed-in-existing-link' || result.kind === 'created-new-account') {
      const session = await deps.authFlows.issueOAuthWebSession({
        accountId: result.accountId,
        issuedFromIp: readClientIp(req),
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
        provider,
      });
      if (session?.kind === 'session') sessionToken = session.session.plaintext;
      if (session?.kind === 'mfa_required') {
        mfaChallenge = {
          challengeToken: session.challengeToken,
          challengeExpiresAt: session.challengeExpiresAt,
        };
      }
    }

    return {
      outcome: result.kind,
      // v2 pages have no provider in their query string (the fragment
      // carries only flow+code), so the collision banner reads it here.
      provider,
      ...(result.kind === 'signed-in-existing-link' || result.kind === 'created-new-account'
        ? {
            account_id: result.accountId,
            redirect_to: redirectTo,
            ...(sessionToken !== undefined ? { session_token: sessionToken } : {}),
            ...(mfaChallenge !== undefined
              ? {
                  mfa_required: true as const,
                  challenge_token: mfaChallenge.challengeToken,
                  challenge_expires_at: mfaChallenge.challengeExpiresAt.toISOString(),
                }
              : {}),
          }
        : {}),
      ...(result.kind === 'collision-pending-verification'
        ? {
            pending_link_id: result.pendingLinkId,
            expires_at: result.expiresAt.toISOString(),
          }
        : {}),
      ...(result.kind === 'existing-link-revoked'
        ? {
            account_id: result.accountId,
            hint: 'fall back to password sign-in or re-link the IDP',
          }
        : {}),
    };
  }

  // ── POST /v1/auth/oauth-client/start ──────────────────────────
  app.post('/v1/auth/oauth-client/start', { preHandler: [startGate] }, async (req, reply) => {
    const parsed = StartBodySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());
    const provider = parsed.data.provider;
    // Open-redirect defense at the source: redirect_to MUST be on the dashboard
    // origin. z.string().url() above guarantees it parses; this rejects
    // off-origin targets so a forged /start can't mint an authorize URL that
    // bounces a just-signed-in user off-site (the callback echoes redirect_to
    // back in its JSON and the SPA navigates it). The dashboard client always
    // sends a same-origin value, so a mismatch is misconfiguration or abuse.
    // Belt-and-suspenders with the SPA-side safeNextPath sanitizer.
    // T-3 host move (2026-09-05): while the dashboard serves on both app.driftstack.io
    // and app.driftstack.dev, the SPA on either host sends its own origin, so a
    // single configured origin rejected the other host's sign-in (measured on prod:
    // 400 for every start from .io). When the configured origin is one of the two
    // first-party hosts, accept both; any other configuration stays exact. Still a
    // closed allow-list — never the request's own host.
    const configuredOrigin = new URL(deps.dashboardOrigin).origin;
    const allowedOrigins = new Set([configuredOrigin]);
    if (FIRST_PARTY_DASHBOARD_ORIGINS.includes(configuredOrigin)) {
      for (const origin of FIRST_PARTY_DASHBOARD_ORIGINS) allowedOrigins.add(origin);
    }
    if (!allowedOrigins.has(new URL(parsed.data.redirect_to).origin)) {
      throw new BadRequestError('redirect_to must be on the dashboard origin.');
    }
    const creds = deps.providers[provider];
    if (!creds) {
      throw new BadRequestError(`Provider "${provider}" is not configured on this server.`);
    }
    // v2 marker (see module header). Validated after the pinned schema so a
    // malformed digest is a 400, not a silent fall-through to the cookie flow.
    const bindingHash = readBindingHash(req.body);

    // PKCE verifier — 43..128 base64url chars (RFC 7636 §4.1).
    const verifier = randomBytes(48).toString('base64url'); // 64 chars
    const challenge = computeS256Challenge(verifier);
    // D2 — one nonce binds the signed state to the browser cookie set below,
    // so the callback can prove they came from the same /start.
    const nonce = randomBytes(16).toString('hex');
    const state = signOauthClientState({
      provider,
      redirectTo: parsed.data.redirect_to,
      signingSecret: deps.signingSecret,
      nowMs: now(),
      nonce,
      ...(bindingHash !== undefined ? { bind: bindingHash } : {}),
    });
    const authorizeUrl = buildAuthorizeUrl({
      provider,
      clientId: creds.clientId,
      callbackUrl: callbackUrlFor(provider, deps.callbackUrlBase),
      state,
      codeChallenge: challenge,
    });
    reply.header('cache-control', 'no-store');

    if (bindingHash !== undefined) {
      // v2 — the verifier never reaches the browser. Stored server-side
      // under the state nonce, consumed exactly once by the top-level
      // callback (GETDEL). NO Set-Cookie: on a cross-site XHR response
      // Safari would drop it anyway, and this design keeps zero browser
      // state on the API host.
      await deps.flowStore.set(verifierKey(nonce), verifier, VERIFIER_TTL_SECONDS);
      return reply.code(200).send({ authorize_url: authorizeUrl, flow_id: flowIdFor(nonce) });
    }

    // Set the HTTP-only signed cookie carrying the verifier + state nonce.
    setPkceCookie(reply, verifier, nonce, deps.signingSecret);

    return reply.code(200).send({ authorize_url: authorizeUrl });
  });

  // ── GET /v1/auth/oauth-client/callback ────────────────────────
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/v1/auth/oauth-client/callback',
    { preHandler: [callbackGate] },
    async (req, reply) => {
      // IDP may redirect with ?error=access_denied if the user
      // cancelled the consent — surface a clean 400 in that case.
      // Cap the error string to a sane bound before interpolating so
      // a crafted huge ?error= value doesn't swell the problem+json
      // body (OAuth-spec error codes are short tokens like
      // 'access_denied', 'invalid_scope', etc.).
      if (typeof req.query.error === 'string' && req.query.error.length > 0) {
        const errSlice = req.query.error.slice(0, 128);
        throw new BadRequestError(`IDP returned error: ${errSlice}`);
      }
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const stateToken = typeof req.query.state === 'string' ? req.query.state : '';
      if (code.length === 0 || stateToken.length === 0) {
        throw new BadRequestError('Missing code or state query parameter.');
      }

      // Verify state JWT — CSRF defense + extracts provider +
      // redirect_to. Bad / expired states 401.
      const stateRes = verifyOauthClientState({
        token: stateToken,
        signingSecret: deps.signingSecret,
        nowMs: now(),
      });
      if (stateRes.kind !== 'ok') {
        throw new BadRequestError(`State token invalid: ${stateRes.kind}`);
      }
      const { provider, redirectTo, nonce: stateNonce } = stateRes.payload;

      // Read + verify the PKCE verifier cookie.
      const cookie = readPkceCookie(req, deps.signingSecret, stateNonce);
      if (cookie === null) {
        throw new BadRequestError('PKCE verifier cookie missing or invalid.');
      }
      // D2 — the state and this cookie must have been minted by the SAME
      // /start. Rejects a login-CSRF that pairs an attacker-obtained valid
      // state with the victim's (or any other) cookie, even for an IDP that
      // ignores PKCE (GitHub OAuth Apps).
      if (cookie.nonce !== stateNonce) {
        throw new BadRequestError('State/cookie binding mismatch.');
      }
      const verifier = cookie.verifier;
      clearPkceCookie(reply, stateNonce);

      const creds = deps.providers[provider];
      if (!creds) {
        throw new BadRequestError(`Provider "${provider}" is not configured.`);
      }

      // Exchange the code for tokens. callbackUrl MUST equal the
      // per-provider URL we sent to authorize — IDPs reject mismatches.
      const tokens = await exchangeCodeForTokens({
        provider,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        callbackUrl: callbackUrlFor(provider, deps.callbackUrlBase),
        code,
        codeVerifier: verifier,
        ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
      });
      if (tokens.kind !== 'ok') {
        deps.logger.warn(
          { component: 'oauth-client', provider, kind: tokens.kind },
          'oauth-client token exchange failed',
        );
        throw new BadRequestError(`Token exchange failed: ${tokens.kind}`);
      }

      // Fetch userinfo + normalize.
      const userinfo = await fetchUserInfo({
        provider,
        accessToken: tokens.tokens.accessToken,
        ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
      });
      if (userinfo.kind !== 'ok') {
        deps.logger.warn(
          { component: 'oauth-client', provider, kind: userinfo.kind },
          'oauth-client userinfo fetch failed',
        );
        throw new BadRequestError(`Userinfo fetch failed: ${userinfo.kind}`);
      }

      return reply.code(200).send(await completeSignIn(req, provider, userinfo.user, redirectTo));
    },
  );

  // ── GET /v1/auth/oauth/:provider/callback ─────────────────────
  // Path A (2026-05-16): the IDP redirects the browser here with
  // ?code=...&state=... after the consent screen. This route does
  // NOT do the token exchange — it just 302s to the SPA callback
  // page preserving the query string. The SPA then fetches the
  // existing /v1/auth/oauth-client/callback endpoint (where the
  // PKCE cookie is in scope) to do the real exchange.
  //
  // Why the bounce: the IDP-Console-registered redirect_uri must
  // match what the SPA + API see at exchange time. Registering the
  // API URL keeps that contract clean (API owns its routes); the
  // 302-then-SPA-fetch shape lets the existing PKCE cookie scope
  // (`Path=/v1/auth/oauth-client`) stay valid without widening it.
  //
  // 2026-09-11 — the paragraph above now describes the LEGACY branch
  // only. The route verifies the state FIRST and branches on the signed
  // `bind` marker:
  //   • no usable state (absent, malformed, bad signature, expired) or a
  //     verified state WITHOUT `bind` → the verbatim query forward above,
  //     for every case including ?error= — an old bundle's XHR route then
  //     produces today's messages unchanged. A verified legacy state is
  //     forwarded to ITS OWN allow-listed origin (Q6); an unverifiable one
  //     can only go to the configured origin.
  //   • a verified state WITH `bind` → the v2 exchange runs HERE, on a
  //     top-level navigation, with the verifier read from the store; the
  //     browser is then 302'd with a single-use hand-off code in the
  //     FRAGMENT. Every expected failure after verification is a bounded
  //     #oauth_error=<enum> on the same page, never a raw problem+json
  //     page on the API host; unexpected 5xx/429 still render there.
  // The query string is never zod-parsed: the values are read once with
  // typeof checks, as the XHR route does.
  for (const provider of ['google', 'github'] as const) {
    app.get<{ Querystring: Record<string, string> }>(
      `/v1/auth/oauth/${provider}/callback`,
      { preHandler: [topLevelGate] },
      async (req, reply) => {
        // Every answer here is a per-flow 302 carrying either the IDP code
        // or a hand-off code; nothing may cache it.
        reply.header('cache-control', 'no-store');

        // Forward the IDP's entire query string verbatim. Includes
        // code+state on success or error+error_description on consent
        // denial — the SPA exchange route handles both.
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(req.query)) {
          if (typeof v === 'string') qs.append(k, v);
        }

        const stateToken = typeof req.query.state === 'string' ? req.query.state : '';
        const stateRes =
          stateToken.length > 0
            ? verifyOauthClientState({
                token: stateToken,
                signingSecret: deps.signingSecret,
                nowMs: now(),
              })
            : null;
        if (stateRes === null || stateRes.kind !== 'ok') {
          // Unverifiable → cannot be v2, cannot choose an origin from it.
          // Byte-identical to the pre-v2 bounce: the SPA's XHR route turns
          // this into "State token invalid: …" / "IDP returned error: …".
          const target = `${deps.dashboardOrigin}/auth/oauth-client/callback?${qs.toString()}`;
          return reply.redirect(target, 302);
        }
        const payload = stateRes.payload;

        // Open-redirect guard RE-APPLIED at the redirect site: the 302
        // origin is the verified state's own origin only when it is on the
        // closed allow-list. A validly-signed state whose redirectTo is
        // off-list (config changed mid-flight, or a signing-key compromise)
        // is REFUSED — bounced to the configured origin with a fixed error,
        // never forwarded and never exchanged.
        const origin = redirectOriginFor(payload.redirectTo, deps.dashboardOrigin);
        if (origin === null) {
          const configured = new URL(deps.dashboardOrigin).origin;
          return reply.redirect(fragmentErrorUrl(configured, 'state_invalid'), 302);
        }

        if (payload.bind === undefined) {
          // Legacy (old bundle / pre-deploy state): verbatim forward, to the
          // origin that started the flow.
          return reply.redirect(`${origin}/auth/oauth-client/callback?${qs.toString()}`, 302);
        }

        // ── v2 ────────────────────────────────────────────────────
        const fail = (code: OauthFragmentError) =>
          reply.redirect(fragmentErrorUrl(origin, code), 302);
        if (typeof req.query.error === 'string' && req.query.error.length > 0) {
          // Consent denied / IDP error. The raw string never reaches the
          // Location header — bounded enum only.
          return fail('idp_denied');
        }
        if (payload.provider !== provider) return fail('state_invalid');
        const code = typeof req.query.code === 'string' ? req.query.code : '';
        if (code.length === 0) return fail('missing_code');

        // Single-use verifier: GETDEL. A replayed callback URL — even inside
        // the state's 5-minute TTL — finds nothing and makes NO IDP call.
        const verifier = await deps.flowStore.consume(verifierKey(payload.nonce));
        if (verifier === null) return fail('state_replayed');

        const creds = deps.providers[provider];
        if (!creds) return fail('provider_unavailable');

        // Exchange the code for tokens. callbackUrl MUST equal the
        // per-provider URL we sent to authorize — IDPs reject mismatches.
        // This route IS that URL.
        const tokens = await exchangeCodeForTokens({
          provider,
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          callbackUrl: callbackUrlFor(provider, deps.callbackUrlBase),
          code,
          codeVerifier: verifier,
          ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
        });
        if (tokens.kind !== 'ok') {
          deps.logger.warn(
            { component: 'oauth-client', provider, kind: tokens.kind, flow: 'v2' },
            'oauth-client token exchange failed',
          );
          return fail('exchange_failed');
        }
        const userinfo = await fetchUserInfo({
          provider,
          accessToken: tokens.tokens.accessToken,
          ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
        });
        if (userinfo.kind !== 'ok') {
          deps.logger.warn(
            { component: 'oauth-client', provider, kind: userinfo.kind, flow: 'v2' },
            'oauth-client userinfo fetch failed',
          );
          return fail('userinfo_failed');
        }

        // Park the verified identity. NOTHING is written to Postgres here
        // and no session exists yet — that happens at /redeem, in the
        // browser that proves the flow secret.
        const handoffCode = randomBytes(32).toString('base64url');
        const record: HandoffRecord = {
          v: 1,
          provider,
          user: userinfo.user,
          redirectTo: payload.redirectTo,
          bind: payload.bind,
          iat: now(),
        };
        await deps.flowStore.set(
          handoffKey(handoffCode),
          JSON.stringify(record),
          HANDOFF_TTL_SECONDS,
        );
        // Fixed path on an allow-listed origin; the user's requested PATH
        // rides inside the record and comes back as redirect_to from
        // /redeem, where the SPA reduces it with safeNextPath. Fragment,
        // not query: never sent to any server, never in Referer.
        const location =
          // Trailing slash on purpose: the Pages host answers the bare path with a
          // 308 to `/callback/`, and the fragment then survives only by the browsers'
          // fragment-propagation rule. Emitting the canonical path skips that hop.
          `${origin}/auth/oauth-client/callback/` +
          `#flow=${encodeURIComponent(flowIdFor(payload.nonce))}` +
          `&code=${encodeURIComponent(handoffCode)}`;
        return reply.redirect(location, 302);
      },
    );
  }

  // ── POST /v1/auth/oauth-client/redeem ─────────────────────────
  // v2 step 3. The page that received the fragment proves it is the
  // browser that started the flow (sha256(flow_secret) === state.bind,
  // carried in the record) and only then is the account linked and the
  // session (or MFA challenge) minted — into THIS request's IP/user-agent,
  // i.e. the browser that will hold it. Cookie-less by construction.
  app.post('/v1/auth/oauth-client/redeem', { preHandler: [redeemGate] }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const body = parseRequestBodyReportingUnknown({
      schema: RedeemBodySchema,
      req,
      reply,
      route: 'POST /v1/auth/oauth-client/redeem',
    });

    // Consume FIRST: a binding mismatch below also burns the code, so a
    // stolen fragment gets one attempt at guessing a 256-bit preimage.
    const raw = await deps.flowStore.consume(handoffKey(body.code));
    if (raw === null) {
      throw new BadRequestError('Hand-off code invalid, expired, or already used.');
    }
    const record = parseHandoffRecord(raw);
    if (record === null) {
      deps.logger.warn(
        { component: 'oauth-client', flow: 'v2' },
        'oauth-client hand-off record failed to parse; refusing',
      );
      throw new BadRequestError('Hand-off code invalid, expired, or already used.');
    }

    // D2 replacement — constant-time compare of the presented preimage's
    // digest against the digest signed into the state at /start. Length is
    // checked first: timingSafeEqual throws on unequal lengths.
    const presented = createHash('sha256').update(body.flow_secret).digest();
    const expected = Buffer.from(record.bind, 'base64url');
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      throw new BadRequestError('Sign-in was not started by this browser.');
    }

    return reply
      .code(200)
      .send(await completeSignIn(req, record.provider, record.user, record.redirectTo));
  });

  // ── POST /v1/auth/oauth-client/confirm-merge ──────────────────
  app.post(
    '/v1/auth/oauth-client/confirm-merge',
    { preHandler: [confirmMergeGate] },
    async (req, reply) => {
      const parsed = ConfirmMergeBodySchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const result = await deps.service.confirmPendingLink(parsed.data.token, new Date(now()));
      if (result === null) {
        throw new BadRequestError('Merge confirmation token is invalid, expired, or already used.');
      }
      return reply.code(200).send({
        outcome: 'merged' as const,
        account_id: result.accountId,
        link_id: result.linkId,
      });
    },
  );
}

// ─── cookie helpers ──────────────────────────────────────────────

function setPkceCookie(reply: FastifyReply, verifier: string, nonce: string, secret: string): void {
  // D2 — sign over verifier AND the state nonce so the cookie is bound to the
  // SAME /start that minted the state. This blocks pairing a valid state from
  // one flow with the verifier cookie of another (login-CSRF) — a gap PKCE
  // can't close for providers that ignore it (GitHub OAuth Apps). Signing over
  // `${verifier}.${nonce}` also prevents swapping a valid verifier onto a
  // different nonce.
  const sig = createHmac('sha256', secret).update(`${verifier}.${nonce}`).digest('base64url');
  const value = `${verifier}.${nonce}.${sig}`;
  const cookieName = pkceCookieName(nonce);
  // SameSite=None (was Lax) — 2026-09-09. The dashboard moved to app.driftstack.io
  // while this cookie is issued by api.driftstack.dev; those are different
  // registrable domains, so the SPA's credentialed callback fetch is now cross-site
  // and a Lax cookie would NOT be sent (→ "PKCE verifier cookie missing", breaking
  // BOTH Google and GitHub). None+Secure lets it ride the cross-site exchange. The
  // CSRF surface None widens is already closed here by the HttpOnly+signed cookie,
  // the state JWT, and the D2 verifier↔state-nonce binding checked at the callback.
  // (Safari ITP still blocks 3rd-party cookies → the durable fix is to run the token
  // exchange on the top-level /v1/auth/oauth/:provider/callback where the cookie is
  // first-party; tracked as the OAuth follow-up.)
  reply.header(
    'set-cookie',
    `${cookieName}=${value}; Path=/v1/auth/oauth-client; HttpOnly; Secure; SameSite=None; Max-Age=${COOKIE_TTL_SECONDS.toString()}`,
  );
}

function clearPkceCookie(reply: FastifyReply, nonce: string): void {
  reply.header(
    'set-cookie',
    `${pkceCookieName(nonce)}=; Path=/v1/auth/oauth-client; HttpOnly; Secure; SameSite=None; Max-Age=0`,
  );
}

function readPkceCookie(
  req: FastifyRequest,
  secret: string,
  expectedNonce: string,
): { verifier: string; nonce: string } | null {
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader !== 'string') return null;
  const expectedName = pkceCookieName(expectedNonce);
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === expectedName) {
      const value = rest.join('=');
      // base64url verifier/sig and hex nonce contain no '.', so a 3-way split
      // is unambiguous.
      const [verifier, nonce, sig] = value.split('.');
      if (!verifier || !nonce || !sig) return null;
      const expected = createHmac('sha256', secret).update(`${verifier}.${nonce}`).digest();
      let received: Buffer;
      try {
        received = Buffer.from(sig, 'base64url');
      } catch {
        return null;
      }
      if (received.length !== expected.length) return null;
      if (!timingSafeEqual(received, expected)) return null;
      return { verifier, nonce };
    }
  }
  return null;
}

/**
 * Give each in-flight browser flow an independent cookie. Hashing the signed
 * nonce keeps the cookie name fixed-length and token-safe even if another
 * server-side state producer is added later. The nonce remains inside the
 * HMAC-protected value and is compared with the verified state on callback.
 */
function pkceCookieName(nonce: string): string {
  return `${COOKIE_NAME_PREFIX}${createHash('sha256').update(nonce).digest('base64url')}`;
}
