// V-204 — customer email notification preferences.
// GET  /v1/account/email-preferences          — list (with defaults)
// PUT  /v1/account/email-preferences          — set one preference
//
// V-330d — both endpoints honor X-Driftstack-Account: a team member
// with a valid membership can read the OWNER's preferences. The PUT
// case requires the member's role to be 'admin' (Q2 verdict — member
// is read-only on writes); 'member' role gets 403. No header (or
// own-account header) keeps pre-V-330d behavior.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SetEmailPreferenceRequestSchema } from '@driftstack/api-types';
import type { EmailPreferencesService } from '../services/email-preferences.js';
import { BadRequestError, ForbiddenError } from '../lib/errors.js';
import { resolveEffectiveAccount } from '../services/auth.js';

const EFFECTIVE_ACCOUNT_HEADER = 'x-driftstack-account';

function readEffectiveAccountHeader(request: FastifyRequest): string | undefined {
  const raw = request.headers[EFFECTIVE_ACCOUNT_HEADER];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

export interface EmailPreferencesRoutesOptions {
  emailPreferences: EmailPreferencesService;
}

export function registerEmailPreferencesRoutes(
  app: FastifyInstance,
  opts: EmailPreferencesRoutesOptions,
): void {
  const { emailPreferences } = opts;

  app.get(
    '/v1/account/email-preferences',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      const records = await emailPreferences.list(
        ctx,
        effective.kind === 'team' ? { effectiveAccountId: effective.accountId } : {},
      );
      return {
        data: records.map((r) => ({
          event_type: r.eventType,
          opted_in: r.optedIn,
        })),
      };
    },
  );

  app.put(
    '/v1/account/email-preferences',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = SetEmailPreferenceRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new BadRequestError('Invalid request body.');
      }
      // V-330d Q2 — when the request targets an owner via
      // X-Driftstack-Account, the caller MUST be 'admin' on that
      // owner's team. 'member' role gets 403. Self-account writes
      // (no header / own-id header) bypass the role check entirely.
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      if (effective.kind === 'team' && effective.role !== 'admin') {
        throw new ForbiddenError(
          'Setting email preferences on a team owner requires admin role on that team.',
        );
      }
      await emailPreferences.set(
        ctx,
        parsed.data.event_type,
        parsed.data.opted_in,
        effective.kind === 'team' ? { effectiveAccountId: effective.accountId } : {},
      );
      return reply.code(204).send();
    },
  );
}
