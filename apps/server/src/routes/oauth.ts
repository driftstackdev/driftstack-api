// V-667.B — OAuth 2.0 Fastify route layer.
//
// Wires the V-667 OAuthService onto two public route surfaces:
//
//   * Admin (auth-gated):
//     - POST   /v1/admin/oauth/clients         — register
//     - GET    /v1/admin/oauth/clients         — list
//     - DELETE /v1/admin/oauth/clients/:id     — revoke
//
//   * Public OAuth dance (no auth — PKCE + client_secret + code IS the auth):
//     - GET    /v1/oauth/authorize             — stage authorization
//     - POST   /v1/oauth/authorize/complete    — dashboard approval
//     - POST   /v1/oauth/token                 — code → access_token
//     - POST   /v1/oauth/introspect            — token validation
//
// Account context for /authorize/complete comes from the bearer-auth
// gate that gates the dashboard — the dashboard signs the customer in,
// then POSTs to /v1/oauth/authorize/complete on the customer's behalf.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiKeyScopeSchema } from '@driftstack/api-types';
import { OAuthError, type OAuthService } from '../services/oauth.js';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../lib/errors.js';

const RegisterClientBody = z.object({
  label: z.string().min(1).max(120),
  redirect_uris: z.array(z.string().url()).min(1).max(10),
  account_id: z.string().uuid().nullable().optional(),
});

const AuthorizeQuery = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  state: z.string().min(8).max(256),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
  scope: z.string().optional(),
});

const ApproveAuthorizationBody = z.object({
  authorization_id: z.string().min(1),
  account_id: z.string().uuid(),
});

const ExchangeCodeBody = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1),
  code_verifier: z.string().min(43).max(128),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  redirect_uri: z.string().url(),
});

const IntrospectBody = z.object({
  token: z.string().min(1),
});

// V-667.C — RFC 7009 revoke. token_type_hint is informational
// (access_token | refresh_token); we ignore it but accept it so
// off-the-shelf OAuth clients can post unchanged.
const RevokeBody = z.object({
  token: z.string().min(1),
  token_type_hint: z.enum(['access_token', 'refresh_token']).optional(),
});

export interface RegisterOAuthRoutesDeps {
  service: OAuthService;
}

export function registerOAuthRoutes(app: FastifyInstance, deps: RegisterOAuthRoutesDeps): void {
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
  // tokens are NOT invalidated (they're bearer-authenticated; the
  // secret is consulted only on the /token exchange).
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

  // ─── Public OAuth dance ───────────────────────────────────────
  app.get('/v1/oauth/authorize', async (req: FastifyRequest, reply) => {
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
  });

  app.post(
    '/v1/oauth/authorize/complete',
    { preHandler: [app.requireAuth] },
    async (req: FastifyRequest, reply) => {
      const body = parseOrThrow(ApproveAuthorizationBody, req.body);
      try {
        const result = await deps.service.approveAuthorization(body);
        return reply.send(result);
      } catch (err) {
        throw oauthErrorToHttp(err);
      }
    },
  );

  app.post('/v1/oauth/token', async (req: FastifyRequest, reply) => {
    const body = parseOrThrow(ExchangeCodeBody, req.body);
    try {
      const result = await deps.service.exchangeCode({
        code: body.code,
        code_verifier: body.code_verifier,
        client_id: body.client_id,
        client_secret: body.client_secret,
        redirect_uri: body.redirect_uri,
      });
      return reply.send(result);
    } catch (err) {
      throw oauthErrorToHttp(err);
    }
  });

  app.post('/v1/oauth/introspect', async (req: FastifyRequest, reply) => {
    const body = parseOrThrow(IntrospectBody, req.body);
    const token = await deps.service.introspect(body.token);
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
  });

  // V-667.C — RFC 7009. Always 200, regardless of whether the token
  // existed. Spec requirement: prevents probe-style enumeration.
  app.post('/v1/oauth/revoke', async (req: FastifyRequest, reply) => {
    const body = parseOrThrow(RevokeBody, req.body);
    await deps.service.revokeToken(body.token);
    return reply.code(200).send({});
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
