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
import { BadRequestError, ValidationError } from '../lib/errors.js';
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

  // ── POST /v1/auth/oauth-client/start ──────────────────────────
  app.post('/v1/auth/oauth-client/start', async (req, reply) => {
    const parsed = StartBodySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());
    const provider = parsed.data.provider;
    const creds = deps.providers[provider];
    if (!creds) {
      throw new BadRequestError(`Provider "${provider}" is not configured on this server.`);
    }

    // PKCE verifier — 43..128 base64url chars (RFC 7636 §4.1).
    const verifier = randomBytes(48).toString('base64url'); // 64 chars
    const challenge = computeS256Challenge(verifier);
    const state = signOauthClientState({
      provider,
      redirectTo: parsed.data.redirect_to,
      signingSecret: deps.signingSecret,
      nowMs: now(),
    });
    const authorizeUrl = buildAuthorizeUrl({
      provider,
      clientId: creds.clientId,
      callbackUrl: callbackUrlFor(provider, deps.callbackUrlBase),
      state,
      codeChallenge: challenge,
    });

    // Set the HTTP-only signed cookie carrying the verifier.
    setPkceCookie(reply, verifier, deps.signingSecret);

    return reply.code(200).send({ authorize_url: authorizeUrl });
  });

  // ── GET /v1/auth/oauth-client/callback ────────────────────────
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/v1/auth/oauth-client/callback',
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
      const { provider, redirectTo } = stateRes.payload;

      // Read + verify the PKCE verifier cookie.
      const verifier = readPkceCookie(req, deps.signingSecret);
      if (verifier === null) {
        throw new BadRequestError('PKCE verifier cookie missing or invalid.');
      }
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

      return reply.code(200).send({
        outcome: result.kind,
        ...(result.kind === 'signed-in-existing-link' || result.kind === 'created-new-account'
          ? { account_id: result.accountId, redirect_to: redirectTo }
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
  app.post('/v1/auth/oauth-client/confirm-merge', async (req, reply) => {
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
  });
}

// ─── cookie helpers ──────────────────────────────────────────────

function setPkceCookie(reply: FastifyReply, verifier: string, secret: string): void {
  const sig = createHmac('sha256', secret).update(verifier).digest('base64url');
  const value = `${verifier}.${sig}`;
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

function readPkceCookie(req: FastifyRequest, secret: string): string | null {
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE_NAME) {
      const value = rest.join('=');
      const [verifier, sig] = value.split('.');
      if (!verifier || !sig) return null;
      const expected = createHmac('sha256', secret).update(verifier).digest();
      let received: Buffer;
      try {
        received = Buffer.from(sig, 'base64url');
      } catch {
        return null;
      }
      if (received.length !== expected.length) return null;
      if (!timingSafeEqual(received, expected)) return null;
      return verifier;
    }
  }
  return null;
}
