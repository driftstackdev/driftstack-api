// V-667.C — OAuth-client (sign-in-with-Google/GitHub) routes.
//
//   POST /v1/auth/oauth-client/start           — issue authorize URL
//   GET  /v1/auth/oauth/:provider/callback     — IDP returns here; token
//                                                 exchange, then 302 to
//                                                 the SPA with a fragment
//   POST /v1/auth/oauth-client/redeem          — hand-off code + flow
//                                                 secret → session
//   POST /v1/auth/oauth-client/confirm-merge   — Verdict 1 collision-
//                                                 flow completion
//
// Path A (2026-05-16): the IDP redirect target is the API per-provider
// path (`${callbackUrlBase}/${provider}/callback`), so the `redirect_uri`
// Google + GitHub Consoles registered is exactly what the IDP sees at
// authorize AND at token exchange (`callbackUrlFor`).
//
// Cookie-free flow (live 2026-09-11; the cookie path it replaced was
// retired 2026-09-14, after its old-bundle window closed with zero cookie-path
// callbacks measured on prod). The dashboard (app.driftstack.io) and the
// API (api.driftstack.dev) are different registrable domains, so NO
// browser state is kept on the API host at all:
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
//      the session.
// D2 (login-CSRF): the flow_secret↔state.bind binding is checked BEFORE
// any DB write or session mint, so an attacker's state paired with a
// victim's browser still fails (the preimage exists only in the
// initiating browser), and it does not rely on PKCE, so it holds for
// GitHub OAuth Apps too.
// A /start without binding_hash, or a state without `bind`, has no
// browser that can finish it: /start answers 400 telling the customer to
// reload the sign-in page, and the top-level callback bounces to the
// configured dashboard origin with #oauth_error=state_invalid. Nothing
// here reads or sets a cookie.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
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

// Store keys (caller-prefixed: the store is shared with the MFA challenge
// hand-off, which prefixes its own keys with 'mfa-challenge:').
const VERIFIER_KEY_PREFIX = 'oauth-client-verifier:';
const HANDOFF_KEY_PREFIX = 'oauth-client-handoff:';
/** Verifier record lifetime — equals the state TTL; the state's iat check
 *  stays the authority, the record TTL only bounds Redis occupancy. */
const VERIFIER_TTL_SECONDS = 300; // 5 min — matches state TTL
/** Hand-off record lifetime: the 302 → page load → redeem XHR takes
 *  seconds; 60 s bounds how long a leaked fragment could be redeemed
 *  (and it still needs the flow-secret preimage). */
const HANDOFF_TTL_SECONDS = 60;
/** 32 random bytes, base64url, unpadded → exactly 43 chars. Shared by
 *  binding_hash (sha256 digest), flow_secret and the hand-off code. */
const BASE64URL_256_BIT_RE = /^[A-Za-z0-9_-]{43}$/;

// binding_hash is REQUIRED: base64url SHA-256 of the flow secret the page
// minted in its own localStorage. Its preimage is what /redeem proves, so
// a start without it could never be finished — refused with
// STALE_SIGN_IN_PAGE_DETAIL rather than a bare validation error.
const StartBodySchema = z.object({
  provider: z.enum(['google', 'github']),
  redirect_to: z.string().url(),
  binding_hash: z.string().regex(BASE64URL_256_BIT_RE),
});

/** The 400 a /start with NO binding_hash gets. Only a sign-in page from
 *  before the cookie-free flow sends one (it minted no flow secret), and
 *  the server can no longer finish that flow — so the detail names the one
 *  fix in the customer's words. No page ever renders it: the only client
 *  that can send this body is an old cached bundle, whose error rendering
 *  is frozen at a generic line. `detail` and `reason` serve whoever reads
 *  the raw problem body — the smoke script, curl, support, the spec. */
const STALE_SIGN_IN_PAGE_DETAIL =
  'This sign-in page is out of date. Reload the sign-in page and try again.';
const STALE_SIGN_IN_PAGE_REASON = 'stale_sign_in_page';

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
   *  /v1/auth/oauth/:provider/callback to the SPA callback page. */
  dashboardOrigin: string;
  /** HMAC-SHA256 key for state signing (≥32 chars). */
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
   * were untestable AND every arm that got past the state checks made
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
  /** 2026-05-20 — required for IP-gate preHandlers on /start, the
   *  top-level callback, /redeem + /confirm-merge (per 2026-05-19
   *  rate-limit audit doc — unauthenticated routes with no abuse gate).
   *  Same store the AUTH_IP_LIMITS gates on auth.ts use. */
  rateLimitStore: RateLimitStore;
  /** Test seam — defaults to Date.now() / randomBytes. */
  nowMs?: () => number;
  /**
   * 2026-09-11 — single-use store for the v2 PKCE verifier (keyed by the
   * state nonce) and the post-exchange hand-off record (keyed by the
   * hashed hand-off code). Production passes a RedisMfaChallengeStore;
   * tests the InMemory one. REQUIRED on purpose: a /start with no store
   * must fail to compile, not 500 on its first use. Fails closed on a
   * Redis outage, like MFA login.
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

/** A body that is a plain object but carries no binding_hash at all — the
 *  shape a pre-2026-09-11 sign-in page sends. A PRESENT but malformed
 *  digest, or a body that is not an object at all (null, a string, an
 *  array), is a caller bug, not a stale page, and stays a validation 400. */
function bindingHashIsAbsent(body: unknown): boolean {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  return (body as Record<string, unknown>).binding_hash === undefined;
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
  // flood is the real abuse vector on /redeem's success path,
  // since the linkOrCreateAccount call mints a fresh row + a
  // 30-day web session for a never-seen IDP identity.
  const startGate = ipRateLimit(deps.rateLimitStore, {
    bucketPrefix: 'oauth_client_start',
    ...AUTH_IP_LIMITS.oauthClientStart,
  });
  const confirmMergeGate = ipRateLimit(deps.rateLimitStore, {
    bucketPrefix: 'oauth_client_confirm_merge',
    ...AUTH_IP_LIMITS.oauthClientConfirmMerge,
  });
  // 2026-09-11 — the top-level IDP-return route makes the outbound IDP
  // calls and /redeem is where the account row + session are minted, so
  // both are gated. Each has its OWN bucket: sharing one would charge a
  // sign-in two tokens (top-level + redeem) and could 429 the top-level
  // NAVIGATION as a raw problem+json page on the API host after a couple
  // of quick retries. Same 5/min/IP budget (the callback bound).
  const topLevelGate = ipRateLimit(deps.rateLimitStore, {
    bucketPrefix: 'oauth_client_toplevel',
    ...AUTH_IP_LIMITS.oauthClientCallback,
  });
  const redeemGate = ipRateLimit(deps.rateLimitStore, {
    bucketPrefix: 'oauth_client_redeem',
    ...AUTH_IP_LIMITS.oauthClientCallback,
  });

  /**
   * Link-or-create + session mint + the 4-outcome JSON. Runs at /redeem
   * only, after the hand-off binding check — never on the top-level
   * navigation — so the session is minted into the request of the browser
   * that proved the flow secret.
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
    if (!parsed.success) {
      // No binding_hash at all is a stale sign-in page, not a malformed
      // request: say so in the customer's words. Anything else (a present
      // but malformed digest included) stays a validation 400.
      if (bindingHashIsAbsent(req.body)) {
        throw new BadRequestError(STALE_SIGN_IN_PAGE_DETAIL, {
          reason: STALE_SIGN_IN_PAGE_REASON,
        });
      }
      throw new ValidationError(parsed.error.flatten());
    }
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
    // PKCE verifier — 43..128 base64url chars (RFC 7636 §4.1).
    const verifier = randomBytes(48).toString('base64url'); // 64 chars
    const challenge = computeS256Challenge(verifier);
    // The nonce keys the server-side verifier record; `bind` is the digest
    // whose preimage /redeem proves (D2, see module header). Both ride
    // inside the signed state.
    const nonce = randomBytes(16).toString('hex');
    const state = signOauthClientState({
      provider,
      redirectTo: parsed.data.redirect_to,
      signingSecret: deps.signingSecret,
      nowMs: now(),
      nonce,
      bind: parsed.data.binding_hash,
    });
    const authorizeUrl = buildAuthorizeUrl({
      provider,
      clientId: creds.clientId,
      callbackUrl: callbackUrlFor(provider, deps.callbackUrlBase),
      state,
      codeChallenge: challenge,
    });
    reply.header('cache-control', 'no-store');

    // The verifier never reaches the browser. Stored server-side under the
    // state nonce, consumed exactly once by the top-level callback (GETDEL).
    // NO Set-Cookie on any answer from this route: the design keeps zero
    // browser state on the API host.
    await deps.flowStore.set(verifierKey(nonce), verifier, VERIFIER_TTL_SECONDS);
    return reply.code(200).send({ authorize_url: authorizeUrl, flow_id: flowIdFor(nonce) });
  });

  // ── GET /v1/auth/oauth/:provider/callback ─────────────────────
  // The IDP redirects the browser here with ?code=...&state=... after the
  // consent screen — this route IS the Console-registered redirect_uri
  // (Path A, module header). The state is verified FIRST, and only a
  // verified state carrying `bind` can be finished:
  //   • no usable state (absent, malformed, bad signature, expired), or a
  //     verified one whose `bind` is missing or not a digest → nothing in
  //     it may choose an origin or a branch: 302 to the CONFIGURED
  //     dashboard origin with a bounded #oauth_error — state_invalid (the
  //     same refusal an off-list origin gets), or state_replayed for a
  //     state that is ours but past its TTL, since the page's copy for
  //     that code is the one that says "expired". Nothing from the query
  //     is forwarded.
  //   • a verified state WITH `bind` → the exchange runs HERE, on a
  //     top-level navigation, with the verifier read from the store; the
  //     browser is then 302'd with a single-use hand-off code in the
  //     FRAGMENT. Every expected failure after verification is a bounded
  //     #oauth_error=<enum> on the same page, never a raw problem+json
  //     page on the API host; unexpected 5xx/429 still render there.
  // The query string is never zod-parsed: the values are read once with
  // typeof checks.
  // No automatic HEAD twin (Fastify adds one per GET by default): a HEAD
  // here would run the whole handler — GETDEL the verifier, two IDP calls,
  // a parked hand-off — for an answer whose body nobody reads. Nothing in
  // the flow sends HEAD, so it is a 404.
  for (const provider of ['google', 'github'] as const) {
    app.get<{ Querystring: Record<string, string> }>(
      `/v1/auth/oauth/${provider}/callback`,
      { preHandler: [topLevelGate], exposeHeadRoute: false },
      async (req, reply) => {
        // Every answer here is a per-flow 302 carrying a hand-off code or a
        // bounded error; nothing may cache it.
        reply.header('cache-control', 'no-store');

        // Where a refusal lands when the state cannot vouch for an origin.
        const configuredOrigin = new URL(deps.dashboardOrigin).origin;
        const refuse = (code: OauthFragmentError = 'state_invalid') =>
          reply.redirect(fragmentErrorUrl(configuredOrigin, code), 302);

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
          // Unverifiable: absent, malformed, forged or expired. It cannot
          // choose an origin, and nothing else in the query (code, error,
          // extra IDP keys) is trusted or forwarded. An EXPIRED state is
          // still ours (a customer who sat on the consent screen past the
          // 5-minute TTL), so it gets the code whose copy says "expired";
          // everything else is state_invalid.
          return refuse(stateRes?.kind === 'expired' ? 'state_replayed' : 'state_invalid');
        }
        const payload = stateRes.payload;
        const bind = payload.bind;
        if (bind === undefined || !BASE64URL_256_BIT_RE.test(bind)) {
          // Signed by us but minted without a binding — a state from before
          // the cookie-free flow — or with one that is not a 256-bit digest,
          // which /start never signs. No browser holds a flow secret for it,
          // so it can never be finished: refused the same way, never
          // exchanged, verifier untouched.
          return refuse();
        }

        // Open-redirect guard RE-APPLIED at the redirect site: the 302
        // origin is the verified state's own origin only when it is on the
        // closed allow-list. A validly-signed state whose redirectTo is
        // off-list (config changed mid-flight, or a signing-key compromise)
        // is REFUSED — bounced to the configured origin with a fixed error,
        // never exchanged.
        const origin = redirectOriginFor(payload.redirectTo, deps.dashboardOrigin);
        if (origin === null) return refuse();

        // ── exchange ──────────────────────────────────────────────
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
          bind,
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
