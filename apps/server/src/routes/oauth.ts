// V-667.B — OAuth 2.0 Fastify route layer.
//
// Wires the V-667 OAuthService onto the provider and dashboard surfaces:
//
//   * Admin (auth-gated):
//     - POST   /v1/admin/oauth/clients         — register
//     - GET    /v1/admin/oauth/clients         — list
//     - DELETE /v1/admin/oauth/clients/:id     — revoke
//
//   * OAuth provider surface (no account auth; client credentials protect
//     token exchange, introspection, and revocation):
//     - GET    /v1/oauth/authorize             — stage authorization
//     - POST   /v1/oauth/token                 — code → access_token
//     - POST   /v1/oauth/introspect            — token validation
//
//   * Interactive dashboard consent (web-session + account-rate-limit gated):
//     - POST   /v1/oauth/authorize/complete    — approve staged authorization
//
// Account context for /authorize/complete comes only from the dashboard's
// interactive web session. General API keys are rejected so they cannot mint
// independently-lived OAuth tokens or outlive their own revocation.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiKeyScopeSchema } from '@driftstack/api-types';
import { OAuthError, type OAuthService } from '../services/oauth.js';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../lib/errors.js';
import { METRIC_NAMES, type MetricsRegistry } from '../services/metrics-registry.js';
import { ipRateLimit, AUTH_IP_LIMITS } from '../middleware/ip-rate-limit.js';
import type { RateLimitStore } from '../services/rate-limit.js';

const RegisterClientBody = z.object({
  label: z.string().min(1).max(120),
  redirect_uris: z.array(z.string().url()).min(1).max(10),
  account_id: z.string().uuid().nullable().optional(),
});

// Length caps below mirror the slice 116 defensive pattern: any
// string field that flows into a downstream lookup / error message
// gets a max bound. Without these, a multi-MB value would bloat
// problem+json bodies on the not-found / invalid_client / etc.
// error paths. Caps are generous (≥10× the realistic upper bound)
// so legitimate variations stay valid.
const AuthorizeQuery = z.object({
  client_id: z.string().min(1).max(128),
  redirect_uri: z.string().url(),
  state: z.string().min(8).max(256),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
  scope: z.string().max(1024).optional(),
});

// SECURITY: account_id is intentionally NOT accepted from the body — the approving
// account is taken from the authenticated caller (see the /authorize/complete handler).
// A body-supplied account_id would let any authed principal mint an OAuth code/token for
// a VICTIM's account (cross-account takeover). Unknown keys are stripped by zod.
const ApproveAuthorizationBody = z.object({
  authorization_id: z.string().min(1).max(128),
});

const ExchangeCodeBody = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1).max(256),
  code_verifier: z.string().min(43).max(128),
  client_id: z.string().min(1).max(128),
  client_secret: z.string().min(1).max(256),
  redirect_uri: z.string().url(),
});

const IntrospectBody = z.object({
  token: z.string().min(1).max(2048),
  client_id: z.string().min(1).max(128),
  client_secret: z.string().min(1).max(256),
});

// V-667.C — RFC 7009 revoke. token_type_hint is informational
// (access_token | refresh_token); we ignore it but accept it so
// off-the-shelf OAuth clients can post unchanged.
const RevokeBody = z.object({
  token: z.string().min(1).max(2048),
  client_id: z.string().min(1).max(128),
  client_secret: z.string().min(1).max(256),
  token_type_hint: z.enum(['access_token', 'refresh_token']).optional(),
});

export interface RegisterOAuthRoutesDeps {
  service: OAuthService;
  /** IP-rate-limit store for the OAuth provider gates
   *  (authorize/token/introspect/revoke). Required so the brute-force
   *  protection can never be silently omitted when the provider
   *  is wired; the full app always has a `rateLimitStore`. */
  rateLimitStore: RateLimitStore;
  /** Arc 7 obs.7 — optional metrics registry. When wired, the
   *  /v1/oauth/token endpoint increments
   *  `driftstack_oauth_token_total{outcome}` per exchange. Outcome
   *  values: ok / invalid_grant / invalid_client / invalid_request /
   *  invalid_scope / access_denied / unauthorized_client / error. */
  metrics?: MetricsRegistry;
}

/** Map an OAuthError code (or unknown throw) to a bounded outcome
 *  label for the obs.7 counter. */
function classifyOAuthTokenError(err: unknown): string {
  if (err instanceof OAuthError) return err.code;
  return 'error';
}

export function registerOAuthRoutes(app: FastifyInstance, deps: RegisterOAuthRoutesDeps): void {
  const metrics = deps.metrics;

  // 2026-06-01 — IP gates on the OAuth provider surface (V-667).
  // authorize carries no client auth, while token/introspect/revoke use
  // client credentials instead of account bearer/scope auth. The client-
  // authenticated routes remain credential brute-force surfaces, so gate each
  // per-route (separate buckets) at AUTH_IP_LIMITS.oauthProvider
  // (60/min/IP) — generous for a legit client server, real friction for
  // an attacker. /authorize/complete is omitted (already requireAuth-
  // gated). Per-client_id keying is the future high-volume enhancement.
  const authorizeGate = ipRateLimit(deps.rateLimitStore, {
    bucketPrefix: 'oauth_provider_authorize',
    capacity: AUTH_IP_LIMITS.oauthProvider.capacity,
    refillPerSecond: AUTH_IP_LIMITS.oauthProvider.refillPerSecond,
  });
  const tokenGate = ipRateLimit(deps.rateLimitStore, {
    bucketPrefix: 'oauth_provider_token',
    capacity: AUTH_IP_LIMITS.oauthProvider.capacity,
    refillPerSecond: AUTH_IP_LIMITS.oauthProvider.refillPerSecond,
  });
  const introspectGate = ipRateLimit(deps.rateLimitStore, {
    bucketPrefix: 'oauth_provider_introspect',
    capacity: AUTH_IP_LIMITS.oauthProvider.capacity,
    refillPerSecond: AUTH_IP_LIMITS.oauthProvider.refillPerSecond,
  });
  const revokeGate = ipRateLimit(deps.rateLimitStore, {
    bucketPrefix: 'oauth_provider_revoke',
    capacity: AUTH_IP_LIMITS.oauthProvider.capacity,
    refillPerSecond: AUTH_IP_LIMITS.oauthProvider.refillPerSecond,
  });

  // ─── Admin surface ─────────────────────────────────────────────
  app.post(
    '/v1/admin/oauth/clients',
    { preHandler: [app.requireScope('driftstack_internal_admin')] },
    async (req: FastifyRequest, reply) => {
      const body = parseOrThrow(RegisterClientBody, req.body);
      const result = await deps.service.registerClient({
        label: body.label,
        redirect_uris: body.redirect_uris,
        account_id: body.account_id ?? null,
      });
      return reply.code(201).send(result);
    },
  );

  app.get(
    '/v1/admin/oauth/clients',
    { preHandler: [app.requireScope('driftstack_internal_admin')] },
    async (_req: FastifyRequest, reply) => {
      const clients = await deps.service.listClients();
      // Never expose the hashed secret to the admin UI; it's internal.
      return reply.send({
        clients: clients.map((c) => ({
          client_id: c.client_id,
          label: c.label,
          redirect_uris: c.redirect_uris,
          account_id: c.account_id,
          created_at: new Date(c.created_at).toISOString(),
          revoked_at: c.revoked_at !== null ? new Date(c.revoked_at).toISOString() : null,
        })),
      });
    },
  );

  // V-667.D — single-client lookup for the founder admin UI. Returns
  // 404 when the client doesn't exist, the full envelope (minus the
  // hashed secret) when it does. Revoked clients are returned with
  // their revoked_at populated so ops can audit "who/when revoked."
  app.get<{ Params: { id: string } }>(
    '/v1/admin/oauth/clients/:id',
    { preHandler: [app.requireScope('driftstack_internal_admin')] },
    async (req, reply) => {
      const c = await deps.service.getClient(req.params.id);
      if (c === null) {
        throw new NotFoundError(`OAuth client "${req.params.id}" not found.`);
      }
      return reply.send({
        client_id: c.client_id,
        label: c.label,
        redirect_uris: c.redirect_uris,
        account_id: c.account_id,
        created_at: new Date(c.created_at).toISOString(),
        revoked_at: c.revoked_at !== null ? new Date(c.revoked_at).toISOString() : null,
      });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/admin/oauth/clients/:id',
    { preHandler: [app.requireScope('driftstack_internal_admin')] },
    async (req, reply) => {
      await deps.service.revokeClient(req.params.id);
      return reply.code(204).send();
    },
  );

  // V-667.E — rotate the client_secret in place. Returns the new
  // plaintext ONCE (the store keeps only the hash). Existing access
  // tokens are NOT invalidated (they remain bearer-authenticated), but
  // the new secret is required for token exchange/introspection/revoke.
  app.post<{ Params: { id: string } }>(
    '/v1/admin/oauth/clients/:id/rotate-secret',
    { preHandler: [app.requireScope('driftstack_internal_admin')] },
    async (req, reply) => {
      try {
        const result = await deps.service.rotateClientSecret(req.params.id);
        return reply.send(result);
      } catch (err) {
        throw oauthErrorToHttp(err);
      }
    },
  );

  // ─── OAuth provider surface ───────────────────────────────────
  app.get(
    '/v1/oauth/authorize',
    { preHandler: [authorizeGate] },
    async (req: FastifyRequest, reply) => {
      const query = parseOrThrow(AuthorizeQuery, req.query);
      const scope = query.scope
        ? query.scope
            .split(/\s+/)
            .filter(Boolean)
            .map((s) => ApiKeyScopeSchema.parse(s))
        : [];
      try {
        const result = await deps.service.authorize({
          client_id: query.client_id,
          redirect_uri: query.redirect_uri,
          state: query.state,
          code_challenge: query.code_challenge,
          code_challenge_method: query.code_challenge_method,
          scope,
        });
        return reply.send(result);
      } catch (err) {
        throw oauthErrorToHttp(err);
      }
    },
  );

  app.post(
    '/v1/oauth/authorize/complete',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req: FastifyRequest, reply) => {
      const ctx = req.account;
      if (!ctx) throw new UnauthorizedError('authentication required');
      // Consent is a human dashboard action, not a general API-key mutation.
      // Accepting an API key here lets a stolen limited credential launder its
      // authority into an independent OAuth token that survives key revocation.
      if (ctx.webSession === null) {
        throw new ForbiddenError('OAuth authorization requires an interactive dashboard session.');
      }
      const body = parseOrThrow(ApproveAuthorizationBody, req.body);
      try {
        // SECURITY: bind the issued code to the AUTHENTICATED caller's account — never a
        // body-supplied account_id (cross-account takeover). The granted scope is the
        // approver's own scopes minus privileged ones (restricted service-side).
        const result = await deps.service.approveAuthorization({
          authorization_id: body.authorization_id,
          account_id: ctx.account.id,
          approverScopes: ctx.apiKey.scopes,
        });
        return reply.send(result);
      } catch (err) {
        throw oauthErrorToHttp(err);
      }
    },
  );

  app.post('/v1/oauth/token', { preHandler: [tokenGate] }, async (req: FastifyRequest, reply) => {
    const body = parseOrThrow(ExchangeCodeBody, req.body);
    try {
      const result = await deps.service.exchangeCode({
        code: body.code,
        code_verifier: body.code_verifier,
        client_id: body.client_id,
        client_secret: body.client_secret,
        redirect_uri: body.redirect_uri,
      });
      try {
        metrics?.inc(METRIC_NAMES.oauthTokenTotal, { outcome: 'ok' });
      } catch {
        // Swallow; metrics are best-effort.
      }
      return reply.send(result);
    } catch (err) {
      try {
        metrics?.inc(METRIC_NAMES.oauthTokenTotal, { outcome: classifyOAuthTokenError(err) });
      } catch {
        // Swallow; metrics are best-effort.
      }
      throw oauthErrorToHttp(err);
    }
  });

  app.post(
    '/v1/oauth/introspect',
    { preHandler: [introspectGate] },
    async (req: FastifyRequest, reply) => {
      const body = parseOrThrow(IntrospectBody, req.body);
      try {
        const token = await deps.service.introspectForClient(body);
        if (token === null) {
          return reply.send({ active: false });
        }
        return reply.send({
          active: true,
          client_id: token.client_id,
          account_id: token.account_id,
          scope: token.scope,
          exp: Math.floor(token.expires_at / 1000),
        });
      } catch (err) {
        throw oauthErrorToHttp(err);
      }
    },
  );

  // V-667.C — RFC 7009. Once client authentication succeeds, always
  // return 200 for owned, foreign, and unknown tokens so the response
  // cannot be used to enumerate token ownership or existence.
  app.post('/v1/oauth/revoke', { preHandler: [revokeGate] }, async (req: FastifyRequest, reply) => {
    const body = parseOrThrow(RevokeBody, req.body);
    try {
      await deps.service.revokeTokenForClient(body);
      return reply.code(200).send({});
    } catch (err) {
      throw oauthErrorToHttp(err);
    }
  });
}

function parseOrThrow<T>(schema: z.ZodSchema<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new BadRequestError(result.error.message);
  }
  return result.data;
}

function oauthErrorToHttp(err: unknown): Error {
  if (!(err instanceof OAuthError)) return err as Error;
  switch (err.code) {
    case 'invalid_client':
    case 'unauthorized_client':
      return new UnauthorizedError(err.message);
    case 'invalid_request':
    case 'invalid_scope':
    case 'invalid_grant':
    case 'access_denied':
      return new BadRequestError(err.message);
  }
}
