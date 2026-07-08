// V-667.C — OAuth-client (sign-in-with-Google/GitHub) routes.
//
//   POST /v1/auth/oauth-client/start           — issue authorize URL
//   GET  /v1/auth/oauth/:provider/callback     — IDP redirects here;
//                                                 302 to SPA callback
//   GET  /v1/auth/oauth-client/callback        — SPA-side exchange
//                                                 (existing flow)
//   POST /v1/auth/oauth-client/confirm-merge   — Verdict 1 collision-
//                                                 flow completion
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

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { buildAuthorizeUrl, type OAuthClientProvider } from '../lib/oauth-client-providers.js';
import { computeS256Challenge } from '../lib/oauth-pkce.js';
import { signOauthClientState, verifyOauthClientState } from '../lib/oauth-client-state.js';
import { exchangeCodeForTokens, fetchUserInfo } from '../lib/oauth-client-exchange.js';
import type { OAuthClientService } from '../services/oauth-client.js';
import type { AuthFlowsService } from '../services/auth-flows.js';
import type { RateLimitStore } from '../services/rate-limit.js';
import { BadRequestError, ValidationError } from '../lib/errors.js';
import { readClientIp } from '../lib/client-ip.js';
import { AUTH_IP_LIMITS, ipRateLimit } from '../middleware/ip-rate-limit.js';
import type { Logger } from '../lib/logger.js';

const COOKIE_NAME = 'ds_oauth_pkce';
const COOKIE_TTL_SECONDS = 300; // 5 min — matches state TTL

const StartBodySchema = z.object({
  provider: z.enum(['google', 'github']),
  redirect_to: z.string().url(),
});

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
    if (new URL(parsed.data.redirect_to).origin !== new URL(deps.dashboardOrigin).origin) {
      throw new BadRequestError('redirect_to must be on the dashboard origin.');
    }
    const creds = deps.providers[provider];
    if (!creds) {
      throw new BadRequestError(`Provider "${provider}" is not configured on this server.`);
    }

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
    });
    const authorizeUrl = buildAuthorizeUrl({
      provider,
      clientId: creds.clientId,
      callbackUrl: callbackUrlFor(provider, deps.callbackUrlBase),
      state,
      codeChallenge: challenge,
    });

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
      const cookie = readPkceCookie(req, deps.signingSecret);
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
      clearPkceCookie(reply);

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
      });
      if (userinfo.kind !== 'ok') {
        deps.logger.warn(
          { component: 'oauth-client', provider, kind: userinfo.kind },
          'oauth-client userinfo fetch failed',
        );
        throw new BadRequestError(`Userinfo fetch failed: ${userinfo.kind}`);
      }

      // Service: link-or-create with founder-verdict-locked semantics.
      const result = await deps.service.linkOrCreateAccount({
        provider,
        providerSub: userinfo.user.providerSub,
        email: userinfo.user.email,
        name: userinfo.user.name,
        avatarUrl: userinfo.user.avatarUrl,
        now: new Date(now()),
      });

      // 2026-05-19 — successful link-or-create mints a 30-day web
      // session immediately so the dashboard finds a token in
      // localStorage on landing. Prior to this fix the callback
      // returned `{outcome, account_id, redirect_to}` only; the SPA
      // would then load the dashboard with no token and surface
      // "Sign in to see live account data" — same UX as if the
      // user had never signed in. The OAuth IDP's attestation IS
      // the auth event here; no password/MFA gate applies.
      let sessionToken: string | undefined;
      if (result.kind === 'signed-in-existing-link' || result.kind === 'created-new-account') {
        const session = await deps.authFlows.issueOAuthWebSession({
          accountId: result.accountId,
          issuedFromIp: readClientIp(req),
          userAgent:
            typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
          provider,
        });
        if (session !== null) sessionToken = session.plaintext;
      }

      return reply.code(200).send({
        outcome: result.kind,
        ...(result.kind === 'signed-in-existing-link' || result.kind === 'created-new-account'
          ? {
              account_id: result.accountId,
              redirect_to: redirectTo,
              ...(sessionToken !== undefined ? { session_token: sessionToken } : {}),
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
      });
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
  for (const provider of ['google', 'github'] as const) {
    app.get<{ Querystring: Record<string, string> }>(
      `/v1/auth/oauth/${provider}/callback`,
      async (req, reply) => {
        // Forward the IDP's entire query string verbatim. Includes
        // code+state on success or error+error_description on consent
        // denial — the SPA exchange route handles both.
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(req.query)) {
          if (typeof v === 'string') qs.append(k, v);
        }
        const target = `${deps.dashboardOrigin}/auth/oauth-client/callback?${qs.toString()}`;
        return reply.redirect(target, 302);
      },
    );
  }

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
  reply.header(
    'set-cookie',
    `${COOKIE_NAME}=${value}; Path=/v1/auth/oauth-client; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_TTL_SECONDS.toString()}`,
  );
}

function clearPkceCookie(reply: FastifyReply): void {
  reply.header(
    'set-cookie',
    `${COOKIE_NAME}=; Path=/v1/auth/oauth-client; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  );
}

function readPkceCookie(
  req: FastifyRequest,
  secret: string,
): { verifier: string; nonce: string } | null {
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE_NAME) {
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
