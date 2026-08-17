// V-204 — customer email notification preferences.
// GET  /v1/account/email-preferences          — list (with defaults)
// PUT  /v1/account/email-preferences          — set one preference
//
// V-330d — both endpoints honor X-Driftstack-Account: a team member
// with a valid membership can read the OWNER's preferences. The PUT
// case requires the member's role to be 'admin' (Q2 verdict — member
// is read-only on writes); 'member' role gets 403. No header (or
// own-account header) keeps pre-V-330d behavior.

import type { FastifyInstance } from 'fastify';
import { knownRequestKeys, reportUnknownRequestFields } from '../lib/unknown-request-fields.js';
import { SetEmailPreferenceRequestSchema } from '@driftstack/api-types';
import type { EmailPreferencesService } from '../services/email-preferences.js';
import { BadRequestError, ForbiddenError } from '../lib/errors.js';
import { resolveEffectiveAccount } from '../services/auth.js';
import { readEffectiveAccountHeader } from '../lib/effective-account-header.js';
import type { AccountAuditService } from '../services/account-audit.js';
import { readClientIp } from '../lib/client-ip.js';

export interface EmailPreferencesRoutesOptions {
  emailPreferences: EmailPreferencesService;
  /** 2026-05-20 — customer audit-log writer. PUT emits
   *  `account.email_preferences_changed` on each opt-in/out toggle.
   *  Payload: { event_type, opted_in }. Best-effort emit (errors
   *  swallowed). */
  accountAudit?: AccountAuditService;
}

export function registerEmailPreferencesRoutes(
  app: FastifyInstance,
  opts: EmailPreferencesRoutesOptions,
): void {
  const { emailPreferences } = opts;
  const accountAudit = opts.accountAudit;

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
      reportUnknownRequestFields({
        body: request.body ?? {},
        knownKeys: knownRequestKeys(SetEmailPreferenceRequestSchema),
        reply,
        logger: request.log,
        route: 'PUT /v1/account/email-preferences',
      });
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
      // 2026-05-20 — audit emit after the toggle persists. Best-
      // effort; audit failure must not break the 204. Audited
      // account is the effective account (team-target case scopes
      // the audit row to the owner's log, not the team member's).
      if (accountAudit !== undefined) {
        const auditedAccountId = effective.kind === 'team' ? effective.accountId : ctx.account.id;
        try {
          await accountAudit.record({
            accountId: auditedAccountId,
            actorType: 'customer',
            actorAccountId: ctx.account.id,
            action: 'account.email_preferences_changed',
            targetResourceId: `account_${auditedAccountId}`,
            payload: {
              event_type: parsed.data.event_type,
              opted_in: parsed.data.opted_in,
            },
            ipAddress: readClientIp(request),
          });
        } catch {
          /* swallow */
        }
      }
      return reply.code(204).send();
    },
  );
}
