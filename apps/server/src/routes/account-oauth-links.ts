// V-667.C-followup — customer-facing read of the OAuth links table.
//
//   GET /v1/account/me/oauth-links — list the authenticated account's
//                                     active sign-in-with-IDP links.
//
// Used by the customer dashboard's account/security page to show
// "Linked accounts: Google (connected 2026-05-12), GitHub (revoked
// upstream — re-link or use password)". DELETE / revoke from
// driftstack-side is a separate slice (V-667.C-followup#2).

import type { FastifyInstance } from 'fastify';
import type { OAuthLinksRepo, OAuthLinkRow } from '../services/oauth-client.js';

export interface AccountOauthLinksRoutesOptions {
  links: OAuthLinksRepo;
}

interface PublicOAuthLink {
  id: string;
  provider: string;
  provider_email: string | null;
  linked_at: string;
  last_login_at: string | null;
  last_revoked_at: string | null;
}

function publicLink(row: OAuthLinkRow): PublicOAuthLink {
  return {
    id: `ol_${row.id}`,
    provider: row.provider,
    provider_email: row.providerEmail,
    linked_at: row.linkedAt.toISOString(),
    last_login_at: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    last_revoked_at: row.lastRevokedAt ? row.lastRevokedAt.toISOString() : null,
  };
}

export function registerAccountOauthLinksRoutes(
  app: FastifyInstance,
  opts: AccountOauthLinksRoutesOptions,
): void {
  app.get<{ Querystring: { active_only?: string } }>(
    '/v1/account/me/oauth-links',
    { preHandler: [app.requireAuth, app.requireScope('read'), app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const rows = await opts.links.listForAccount(ctx.account.id);
      // V-667.C — provider_avatar_url + provider_name are first-link-
      // only IDP signals (Verdict 3) and used internally; not surfaced
      // on this customer-facing endpoint so a future re-link change
      // doesn't leak as a profile update.
      //
      // ?active_only=true filters Verdict-2 revoked links so the
      // dashboard's "Connected accounts" UI doesn't have to filter
      // client-side. Defaults to false (show all) so audit views see
      // the full history.
      const activeOnly = request.query.active_only === 'true';
      const filtered = activeOnly ? rows.filter((r) => r.lastRevokedAt === null) : rows;
      return { data: filtered.map(publicLink) };
    },
  );
}
