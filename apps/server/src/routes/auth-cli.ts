// V-266 — Browser-OAuth-style activation flow for CLI / GUI clients.
//
//   POST /v1/auth/cli-authorize/initiate   — public; CLI/GUI starts the flow
//   POST /v1/auth/cli-authorize/bind       — auth required; dashboard binds the code
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
import { BadRequestError, NotFoundError, ValidationError } from '../lib/errors.js';

const DEFAULT_KEY_NAME = 'Desktop client';
const DEFAULT_SCOPES: ApiKeyScope[] = ['account_owner'];

export interface AuthCliRoutesDeps {
  cliAuthorizeService: CliAuthorizeService;
  apiKeysService: ApiKeysService;
}

export function registerAuthCliRoutes(app: FastifyInstance, deps: AuthCliRoutesDeps): void {
  const { cliAuthorizeService, apiKeysService } = deps;

  app.post('/v1/auth/cli-authorize/initiate', async (req) => {
    const parsed = CliAuthorizeInitiateRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());

    const result = await cliAuthorizeService.initiate({
      state: parsed.data.state,
      client_label: parsed.data.client_label ?? null,
    });
    return {
      code: result.code,
      browser_url: result.browser_url,
      expires_at: result.expires_at.toISOString(),
    };
  });

  app.post(
    '/v1/auth/cli-authorize/bind',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req) => {
      const ctx = req.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = CliAuthorizeBindRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());

      const scopes = parsed.data.scopes ?? DEFAULT_SCOPES;
      const created = await apiKeysService.create(ctx, {
        name: DEFAULT_KEY_NAME,
        scopes,
        expiresAt: null,
      });

      try {
        const result = await cliAuthorizeService.bind({
          code: parsed.data.code,
          state: parsed.data.state,
          account_id: `acc_${ctx.account.id}`,
          api_key_plaintext: created.plaintext,
          scopes,
        });
        return {
          ok: true as const,
          account_id: result.account_id,
          expires_at: result.expires_at.toISOString(),
        };
      } catch (err) {
        if (err instanceof CliAuthorizeError) {
          // Revoke the just-minted key — the bind failed, so the
          // plaintext we created above can't reach a client. Best-effort;
          // the key remains in the DB as `revoked` if revoke fails for
          // any reason, which is the safe direction.
          try {
            await apiKeysService.revoke(ctx, created.row.id);
          } catch {
            /* swallow */
          }
          throw mapCliAuthorizeError(err);
        }
        throw err;
      }
    },
  );

  app.post('/v1/auth/cli-authorize/exchange', async (req) => {
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
    case 'already_bound':
      return new BadRequestError('Authorization code has already been bound.');
    case 'not_found':
    case 'expired':
      return new NotFoundError('Authorization code not found or expired.');
    case 'invalid_code':
      return new BadRequestError('Authorization code is invalid.');
  }
}
