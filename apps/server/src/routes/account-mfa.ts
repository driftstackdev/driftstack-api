// V-353b — customer-facing MFA enrollment + status + disable + recovery
// code regen. Step-up gating (account-delete + MFA-disable per V-353a
// verdict Q3) lands in V-353e; for now, disable is gated only by web-
// session auth + an explicit confirm body field.

import type { FastifyInstance } from 'fastify';
import { CompleteMfaEnrollmentRequestSchema } from '@driftstack/api-types';
import type { MfaService } from '../services/mfa.js';
import { BadRequestError } from '../lib/errors.js';

export interface AccountMfaRoutesOptions {
  service: MfaService;
}

export function registerAccountMfaRoutes(
  app: FastifyInstance,
  opts: AccountMfaRoutesOptions,
): void {
  const { service } = opts;

  app.get(
    '/v1/account/mfa',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
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
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
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
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = CompleteMfaEnrollmentRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid body.');
      }
      const result = await service.completeEnrollment({
        accountId: ctx.account.id,
        code: parsed.data.code,
      });
      return { recovery_codes: result.recoveryCodes };
    },
  );

  // V-353b — disable. V-353a verdict Q3 marks this as one of the two
  // step-up-gated ops; V-353e wires the actual gate. For now the
  // route requires an explicit `confirm: 'disable-mfa'` body field
  // so a stray client request can't disable accidentally.
  app.delete(
    '/v1/account/mfa',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request, reply) => {
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
    },
  );

  app.post(
    '/v1/account/mfa/recovery-codes/regenerate',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
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
