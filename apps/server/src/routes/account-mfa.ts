// V-353b — customer-facing MFA enrollment + status + disable + recovery
// code regen. Every operation that changes MFA credential state requires an
// interactive web session. API keys may read status, but cannot enroll an
// attacker-owned factor, replace recovery codes, or disable the human factor.
// Disable and recovery-code regeneration additionally require fresh MFA.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CompleteMfaEnrollmentRequestSchema } from '@driftstack/api-types';
import type { MfaService } from '../services/mfa.js';
import { BadRequestError, ForbiddenError } from '../lib/errors.js';

export interface AccountMfaRoutesOptions {
  service: MfaService;
}

export function registerAccountMfaRoutes(
  app: FastifyInstance,
  opts: AccountMfaRoutesOptions,
): void {
  const { service } = opts;

  // MFA configuration is a human credential-control surface, not an ordinary
  // machine API. An account_owner API key may be broadly privileged for SDK
  // operations, but letting it mutate MFA would allow a leaked key to enroll
  // an attacker-controlled TOTP secret or remove the dashboard's second
  // factor. Keep the generic requireMfaFresh machine carve-out intact for
  // unrelated routes while this surface fails closed on non-web bearers.
  const interactiveWebSessionId = (request: FastifyRequest): string => {
    const ctx = request.account;
    if (!ctx) throw new Error('account context missing after requireAuth');
    if (ctx.webSession === null) {
      throw new ForbiddenError('MFA credential management requires an interactive web session.');
    }
    return ctx.webSession.id;
  };
  const requireInteractiveWebSession = (request: FastifyRequest): Promise<void> => {
    interactiveWebSessionId(request);
    // Fastify preHandlers must either accept/call `done` or return a promise.
    // A synchronous one-argument function is treated as callback-style and
    // leaves the request waiting forever after successful authentication.
    return Promise.resolve();
  };

  app.get(
    '/v1/account/mfa',
    { preHandler: [app.requireAuth, app.requireScope('read'), app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const status = await service.getStatus(ctx.account.id);
      return {
        enrolled: status.enrolled,
        enrolled_at: status.enrolledAt ? status.enrolledAt.toISOString() : null,
        last_used_at: status.lastUsedAt ? status.lastUsedAt.toISOString() : null,
        unused_recovery_codes: status.unusedRecoveryCodes,
      };
    },
  );

  app.post(
    '/v1/account/mfa/enroll',
    {
      preHandler: [
        app.requireAuth,
        app.requireScope('account_owner'),
        requireInteractiveWebSession,
        app.rateLimit('global'),
      ],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const result = await service.startEnrollment({
        accountId: ctx.account.id,
        email: ctx.account.email,
      });
      return {
        otpauth_uri: result.otpauthUri,
        secret_base32: result.secretBase32,
        algorithm: 'SHA1',
        digits: 6,
        period_seconds: 30,
      };
    },
  );

  app.post(
    '/v1/account/mfa/verify',
    {
      preHandler: [
        app.requireAuth,
        app.requireScope('account_owner'),
        requireInteractiveWebSession,
        app.rateLimit('global'),
      ],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = CompleteMfaEnrollmentRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid body.');
      }
      const result = await service.completeEnrollment({
        accountId: ctx.account.id,
        currentWebSessionId: interactiveWebSessionId(request),
        code: parsed.data.code,
      });
      return { recovery_codes: result.recoveryCodes };
    },
  );

  // V-353b/V-353e — disable. Per V-353a verdict Q3 this is one of
  // the two step-up-gated ops (account-delete + MFA-disable). The
  // step-up gate (`requireMfaFresh`) refuses (403 + requires_mfa_step_up
  // extension) when the caller's session hasn't satisfied MFA in the
  // last 15 min. Caller refreshes via POST /v1/auth/mfa/step-up
  // (separate route, also bearer-authed) and retries.
  //
  // Body still requires `{ confirm: "disable-mfa" }` as a defensive
  // check against accidental DELETEs from a stray client.
  const disableHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<null> => {
    const ctx = request.account;
    if (!ctx) throw new Error('account context missing after requireAuth');
    const body = (request.body ?? {}) as { confirm?: string };
    if (body.confirm !== 'disable-mfa') {
      throw new BadRequestError(
        'Disable requires an explicit confirmation. Pass { "confirm": "disable-mfa" }.',
      );
    }
    await service.disable({ accountId: ctx.account.id });
    reply.code(204);
    return null;
  };

  // DELETE retains the original verb for back-compat with the V-353b
  // tests + clients.
  app.delete(
    '/v1/account/mfa',
    {
      preHandler: [
        app.requireAuth,
        app.requireScope('account_owner'),
        requireInteractiveWebSession,
        app.requireMfaFresh(),
        app.rateLimit('global'),
      ],
    },
    disableHandler,
  );

  // V-353f — POST alias per founder-named canonical shape. Same gate,
  // same handler. Some clients prefer POST for non-idempotent ops.
  app.post(
    '/v1/account/mfa/disable',
    {
      preHandler: [
        app.requireAuth,
        app.requireScope('account_owner'),
        requireInteractiveWebSession,
        app.requireMfaFresh(),
        app.rateLimit('global'),
      ],
    },
    disableHandler,
  );

  // V-353e step-up gate — regenerating recovery codes is a step-up-gated
  // op alongside disable. Without it a stolen web session could mint fresh
  // recovery codes, then redeem one to satisfy `requireMfaFresh` on disable
  // → full MFA bypass. The legitimate lost-device-but-logged-in flow still
  // works: an EXISTING recovery code satisfies step-up (POST /v1/auth/mfa/
  // step-up) before regenerating. Same gate/order as the disable routes.
  app.post(
    '/v1/account/mfa/recovery-codes/regenerate',
    {
      preHandler: [
        app.requireAuth,
        app.requireScope('account_owner'),
        requireInteractiveWebSession,
        app.requireMfaFresh(),
        app.rateLimit('global'),
      ],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const { recoveryCodes } = await service.regenerateRecoveryCodes({
        accountId: ctx.account.id,
      });
      return { recovery_codes: recoveryCodes };
    },
  );
}
