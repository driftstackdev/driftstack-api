// V-266 — Browser-OAuth-style activation flow for CLI / GUI clients.
//
//   POST /v1/auth/cli-authorize/initiate   — public; CLI/GUI starts the flow
//   POST /v1/auth/cli-authorize/bind-device-code — auth required; dashboard binds the code
//   POST /v1/auth/cli-authorize/exchange   — public; CLI/GUI polls for the issued key
//
// The bind endpoint requires an authenticated account (typically via
// the dashboard's web session). It mints an API key on that account
// and hands the plaintext to the CLI/GUI via the exchange endpoint.

import type { FastifyInstance } from 'fastify';
import {
  CliAuthorizeBindRequestSchema,
  CliAuthorizeExchangeRequestSchema,
  CliAuthorizeInitiateRequestSchema,
} from '@driftstack/api-types';
import type { ApiKeyScope } from '@driftstack/api-types';
import type { ApiKeysService } from '../services/api-keys.js';
import { CliAuthorizeError, type CliAuthorizeService } from '../services/cli-authorize.js';
import {
  BadRequestError,
  FeatureUnavailableError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../lib/errors.js';
import { AUTH_IP_LIMITS, ipRateLimit } from '../middleware/ip-rate-limit.js';
import { knownRequestKeys, reportUnknownRequestFields } from '../lib/unknown-request-fields.js';
import type { RateLimitStore } from '../services/rate-limit.js';

const DEFAULT_KEY_NAME = 'Desktop client';
const DEFAULT_SCOPES: ApiKeyScope[] = ['account_owner'];

export interface AuthCliRoutesDeps {
  cliAuthorizeService: CliAuthorizeService;
  apiKeysService: ApiKeysService;
  /**
   * IP-keyed rate-limit store shared with the other public auth routes.
   * /initiate + /exchange are unauthenticated (the client has no account
   * yet), so account-keyed limiting is impossible — every other public auth
   * route adds a dedicated per-IP gate on top of the app-wide pre-auth limiter.
   */
  rateLimitStore: RateLimitStore;
}

export function registerAuthCliRoutes(app: FastifyInstance, deps: AuthCliRoutesDeps): void {
  const { cliAuthorizeService, apiKeysService, rateLimitStore } = deps;

  // /initiate mints a code + browser URL per call → signup posture (5/min/IP).
  const initiateGate = ipRateLimit(rateLimitStore, {
    bucketPrefix: 'auth-ip:cli-authorize-initiate',
    capacity: AUTH_IP_LIMITS.cliAuthorizeInitiate.capacity,
    refillPerSecond: AUTH_IP_LIMITS.cliAuthorizeInitiate.refillPerSecond,
  });
  // /exchange is a CLI/GUI POLL endpoint → generous bucket (60/min/IP) so a
  // legitimate poll loop never trips it while a flood still gets friction.
  const exchangeGate = ipRateLimit(rateLimitStore, {
    bucketPrefix: 'auth-ip:cli-authorize-exchange',
    capacity: AUTH_IP_LIMITS.cliAuthorizeExchange.capacity,
    refillPerSecond: AUTH_IP_LIMITS.cliAuthorizeExchange.refillPerSecond,
  });

  app.post('/v1/auth/cli-authorize/initiate', { preHandler: [initiateGate] }, async (req) => {
    const parsed = CliAuthorizeInitiateRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());

    const result = await cliAuthorizeService.initiate({
      state: parsed.data.state,
      client_label: parsed.data.client_label ?? null,
    });
    return {
      code: result.code,
      user_code: result.user_code,
      browser_url: result.browser_url,
      expires_at: result.expires_at.toISOString(),
    };
  });

  app.post(
    '/v1/auth/cli-authorize/bind-device-code',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req, reply) => {
      const ctx = req.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      // C1 — bind must be driven by an interactive dashboard web session,
      // never an API key. Otherwise the public /initiate + an API-key-authed
      // /bind + /exchange is a self-mint laundering path: any key could mint
      // a fresh key for itself, and a device key could mint a sibling that
      // dodges its own deny-gate. The dashboard consent page authenticates
      // /bind with the web-session bearer, so this never affects real users.
      if (ctx.webSession === null) {
        throw new ForbiddenError('Authorizing a device requires an interactive dashboard session.');
      }
      const parsed = CliAuthorizeBindRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      // V-947 — report the keys zod stripped. Gate verified by reading this
      // route's own registration, not inferred: a pattern-based split misread
      // two of these in V-946.
      reportUnknownRequestFields({
        body: req.body,
        knownKeys: knownRequestKeys(CliAuthorizeBindRequestSchema),
        reply,
        logger: req.log,
        route: 'POST /v1/auth/cli-authorize/bind-device-code',
      });

      const scopes = parsed.data.scopes ?? DEFAULT_SCOPES;
      const created = await apiKeysService.create(ctx, {
        name: DEFAULT_KEY_NAME,
        scopes,
        expiresAt: null,
        // C1 — mark the minted key so the device-key deny-gate bars it
        // from account-takeover operations (mint/rotate/revoke keys, MFA,
        // team, Stripe billing, webhook writes, BYOK, web-session nuke).
        provenance: 'cli_device',
      });

      try {
        const result = await cliAuthorizeService.bind({
          code: parsed.data.code,
          state: parsed.data.state,
          user_code: parsed.data.user_code,
          account_id: `acc_${ctx.account.id}`,
          api_key_plaintext: created.plaintext,
        });
        return {
          ok: true as const,
          account_id: result.account_id,
          expires_at: result.expires_at.toISOString(),
        };
      } catch (err) {
        // Every failed bind must retire the just-minted key, including
        // infrastructure/serialization failures that are not expressed as
        // CliAuthorizeError. Otherwise its plaintext cannot reach a client
        // but the credential remains active. Keep the original bind error as
        // the response cause; log a secondary compensation failure so an
        // operator can revoke the key by id without exposing its plaintext.
        try {
          await apiKeysService.revoke(ctx, created.row.id);
        } catch (revokeErr) {
          req.log.error(
            { err: revokeErr, apiKeyId: created.row.id },
            'Failed to revoke API key after CLI authorization bind failure',
          );
        }
        if (err instanceof CliAuthorizeError) throw mapCliAuthorizeError(err);
        throw err;
      }
    },
  );

  app.post('/v1/auth/cli-authorize/exchange', { preHandler: [exchangeGate] }, async (req) => {
    const parsed = CliAuthorizeExchangeRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());

    try {
      const result = await cliAuthorizeService.exchange({
        code: parsed.data.code,
        state: parsed.data.state,
      });
      return result;
    } catch (err) {
      if (err instanceof CliAuthorizeError) throw mapCliAuthorizeError(err);
      throw err;
    }
  });
}

function mapCliAuthorizeError(err: CliAuthorizeError): Error {
  switch (err.code) {
    case 'state_mismatch':
      return new BadRequestError('State parameter does not match.');
    case 'user_code_mismatch':
      return new BadRequestError('Device verification code does not match.');
    case 'already_bound':
      return new BadRequestError('Authorization code has already been bound.');
    case 'not_found':
    case 'expired':
      return new NotFoundError('Authorization code not found or expired.');
    case 'invalid_code':
      return new BadRequestError('Authorization code is invalid.');
  }
}

// V-1756 — activation-gate disabled stubs. `app.ts` registers these only when
// `deps.cliAuthorizeService` is wired; the else branch was missing, so a deployment
// without it answered 404 on published `/v1/auth/cli-authorize/*` operations. The CLI
// polls `exchange` in a loop, and a 404 there is indistinguishable from a wrong base
// URL — a 503 + FeatureUnavailable tells it to stop and say why.
export function registerAuthCliDisabledRoutes(app: FastifyInstance): void {
  const detail =
    'CLI authorization is not configured on this server. Reach out to support@driftstack.dev if you expected to use this endpoint.';

  const stub = (): never => {
    throw new FeatureUnavailableError(detail);
  };

  app.post('/v1/auth/cli-authorize/initiate', stub);
  app.post('/v1/auth/cli-authorize/bind-device-code', stub);
  app.post('/v1/auth/cli-authorize/exchange', stub);
}
