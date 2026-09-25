// V-667.C-followup — customer-facing read of the OAuth links table.
//
//   GET /v1/account/me/oauth-links — list the authenticated account's
//                                     active sign-in-with-IDP links.
//   DELETE /v1/account/me/oauth-links/:id — remove one (sign-in audit #5).
//
// Used by the customer dashboard's account/security page to show
// "Linked accounts: Google (connected 2026-05-12), GitHub (revoked
// upstream — re-link or use password)", with a Remove control per link.
//
// The DELETE is registered by routes/auth.ts (registerAuthRoutes), because it
// runs through AuthFlowsService — see registerAccountOauthLinkRemovalRoute.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../lib/errors.js';
import type { OAuthLinksRepo, OAuthLinkRow } from '../services/oauth-client.js';
import type { AuthFlowsService } from '../services/auth-flows.js';
import { isKeyHeldByTeamMember } from '../services/auth.js';

// A link's public id is `ol_<uuid>` (publicLink below). The prefix is two
// letters, so it is pinned in the regex rather than matched by the usual
// three-letter class.
const PUBLIC_ID_RE = /^ol_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function uuidFromPrefixedId(value: string): string {
  const match = PUBLIC_ID_RE.exec(value);
  if (!match || !match[1]) {
    throw new BadRequestError('Invalid id format. Expected "ol_<uuid>".');
  }
  return match[1];
}

// V-1367 — validate the querystring rather than trusting the `Querystring` type.
//
// A repeated query key parses to an ARRAY, so `request.query.active_only` is
// `string | string[] | undefined` no matter what the generic says. Compared against
// `'true'` an array is simply not equal, so `?active_only=true&active_only=true`
// used to return 200 with the revoked links the caller asked to hide — a wrong
// answer, not an error, on the read the dashboard's "Connected accounts" view uses.
//
// `z.string()` and not `z.enum(['true','false'])`, which is what the two admin
// routes with a boolean query param use: an enum would also start rejecting
// `?active_only=1` and `?active_only=` on a documented customer-facing endpoint.
// Those are accepted today, mean "show all", and keep meaning that. The type of the
// parameter is what was wrong here, not its accepted values.
const ListOAuthLinksQuerySchema = z.object({
  active_only: z.string().optional(),
});

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
      // Security sweep #12 — the provider emails of the owner's linked sign-ins
      // are the owner's. A key a team member minted on the owner's account
      // authenticates as the owner but is held by the member; the header never
      // reached this read (it always answers for the caller), so neither may that key.
      if (isKeyHeldByTeamMember(ctx)) {
        throw new ForbiddenError(
          "Linked sign-ins are visible only to the account's owner, and this key was created by a team member.",
        );
      }
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
      const query = ListOAuthLinksQuerySchema.safeParse(request.query);
      if (!query.success) throw new ValidationError(query.error.flatten());
      const activeOnly = query.data.active_only === 'true';
      const filtered = activeOnly ? rows.filter((r) => r.lastRevokedAt === null) : rows;
      return { data: filtered.map(publicLink) };
    },
  );
}

export interface AccountOauthLinkRemovalRouteOptions {
  service: Pick<AuthFlowsService, 'removeOAuthLink'>;
}

/**
 * Sign-in audit #5 — DELETE /v1/account/me/oauth-links/:id: remove a linked
 * Google/GitHub sign-in. A linked identity used to be impossible to remove, so a
 * customer whose GitHub account was compromised had no way to cut that sign-in
 * off.
 *
 * - A signed-in browser only: an API key — even an account_owner one — cannot
 *   change how the account signs in, the same line the MFA routes draw.
 * - With two-factor on, it needs a fresh step-up (requireMfaFresh, a no-op when
 *   two-factor is off).
 * - Refused (409) when it is the account's last way to sign in: no password and
 *   no other link that still signs in.
 * - 204 on success; the service writes the "Recent activity" row and emails the
 *   account.
 */
export function registerAccountOauthLinkRemovalRoute(
  app: FastifyInstance,
  opts: AccountOauthLinkRemovalRouteOptions,
): void {
  const requireInteractiveWebSession = (request: FastifyRequest): Promise<void> => {
    const ctx = request.account;
    if (!ctx) throw new Error('account context missing after requireAuth');
    if (ctx.webSession === null) {
      throw new ForbiddenError(
        'Removing a linked sign-in needs you to be signed in to the dashboard.',
      );
    }
    // A promise, not a bare return: a one-argument synchronous preHandler is
    // treated as callback-style and would leave the request waiting.
    return Promise.resolve();
  };

  app.delete<{ Params: { id: string } }>(
    '/v1/account/me/oauth-links/:id',
    {
      preHandler: [
        app.requireAuth,
        app.requireScope('account_owner'),
        requireInteractiveWebSession,
        app.requireMfaFresh(),
        app.rateLimit('global'),
      ],
    },
    async (request, reply: FastifyReply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const linkId = uuidFromPrefixedId(request.params.id);
      const outcome = await opts.service.removeOAuthLink({
        accountId: ctx.account.id,
        linkId,
      });
      if (outcome === 'not_found') throw new NotFoundError('Linked sign-in not found.');
      if (outcome === 'last_sign_in_method') {
        throw new ConflictError(
          "This is your account's only way to sign in. Set a password first, then remove it.",
        );
      }
      reply.code(204);
      return null;
    },
  );
}
