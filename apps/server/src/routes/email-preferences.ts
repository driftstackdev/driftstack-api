// V-204 — customer email notification preferences.
// GET  /v1/account/email-preferences          — list (with defaults)
// PUT  /v1/account/email-preferences          — set one preference
//
// Account-owner scope only. No admin override needed today (admin
// ops never touch this surface).

import type { FastifyInstance } from 'fastify';
import { SetEmailPreferenceRequestSchema } from '@driftstack/api-types';
import type { EmailPreferencesService } from '../services/email-preferences.js';
import { BadRequestError } from '../lib/errors.js';

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
      const records = await emailPreferences.list(ctx);
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
      await emailPreferences.set(ctx, parsed.data.event_type, parsed.data.opted_in);
      return reply.code(204).send();
    },
  );
}
