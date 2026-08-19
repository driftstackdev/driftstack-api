// V-298c — Team RBAC v1 routes.
//
//   POST   /v1/team/invites              — owner invites email (account_owner)
//   GET    /v1/team/invites              — list pending (read; owner-scoped by query)
//   POST   /v1/team/invites/accept       — invitee accepts (account_owner)
//   GET    /v1/team/members              — list confirmed (read; owner-scoped by query)
//   GET    /v1/team/owners               — list teams caller joined (read)
//   DELETE /v1/team/members/:id          — remove member (account_owner)
//
// V-298c registered these routes; the auth-path integration it deferred
// has since SHIPPED. `resolveEffectiveAccount` (services/auth.ts) reads
// `X-Driftstack-Account`: naming an owner you hold a membership on
// returns that owner's account id with your role, and the participating
// routes then scope to the owner rather than to you.
//
// V-1010 — this paragraph used to describe that integration as still
// pending and, more strongly, said a membership granted no permissions
// on the owner's resources at all. The second half was flatly false: an
// admin member can act on the owner's account today, which V-795 and
// V-812 both document as designed behaviour.
//
// The part worth keeping, and kept: membership grants nothing IMPLICITLY.
// Without the header a member's key resolves to their own account, so
// access to an owner's resources is always an explicit act-as request.

import type { FastifyInstance } from 'fastify';
import { knownRequestKeys, reportUnknownRequestFields } from '../lib/unknown-request-fields.js';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import type { TeamInviteRow, TeamMemberRow, TeamMembersService } from '../services/team-members.js';

const InviteBodySchema = z.object({
  email: z.string().trim().email('Must be a valid email.').max(254),
  role: z.enum(['member', 'admin']).optional(),
});

const AcceptBodySchema = z.object({
  token: z.string().min(20, 'Missing or malformed token.'),
});

const MEMBER_ID_RE = /^mem_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function uuidFromMemberId(value: string): string {
  const match = MEMBER_ID_RE.exec(value);
  if (!match || !match[1]) {
    throw new ValidationError({
      formErrors: ['Invalid id format. Expected "mem_<uuid>".'],
      fieldErrors: {},
    });
  }
  return match[1];
}

function publicMember(row: TeamMemberRow): Record<string, unknown> {
  return {
    id: `mem_${row.id}`,
    owner_account_id: `acc_${row.ownerAccountId}`,
    member_account_id: `acc_${row.memberAccountId}`,
    member_email: row.memberEmail,
    role: row.role,
    invited_at: row.invitedAt.toISOString(),
    accepted_at: row.acceptedAt.toISOString(),
    invited_by_account_id: row.invitedByAccountId ? `acc_${row.invitedByAccountId}` : null,
  };
}

function publicInvite(row: TeamInviteRow): Record<string, unknown> {
  return {
    id: `inv_${row.id}`,
    owner_account_id: `acc_${row.ownerAccountId}`,
    invitee_email: row.inviteeEmail,
    role: row.role,
    expires_at: row.inviteExpiresAt.toISOString(),
    invited_by_account_id: row.invitedByAccountId ? `acc_${row.invitedByAccountId}` : null,
    accepted_at: row.acceptedAt ? row.acceptedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}

export interface TeamRoutesOptions {
  service: TeamMembersService;
}

export function registerTeamRoutes(app: FastifyInstance, opts: TeamRoutesOptions): void {
  const { service } = opts;

  app.post(
    '/v1/team/invites',
    { preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = InviteBodySchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      reportUnknownRequestFields({
        body: request.body,
        knownKeys: knownRequestKeys(InviteBodySchema),
        reply,
        logger: request.log,
        route: 'POST /v1/team/invites',
      });
      await service.invite({
        ownerAccountId: ctx.account.id,
        invitedByAccountId: ctx.account.id,
        inviteeEmail: parsed.data.email,
        ...(parsed.data.role !== undefined ? { role: parsed.data.role } : {}),
      });
      return reply
        .code(202)
        .send({ message: 'Invite sent. The invitee can accept via the email link.' });
    },
  );

  app.get(
    '/v1/team/invites',
    { preHandler: [app.requireAuth, app.requireScope('read'), app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const rows = await service.listPendingInvites(ctx.account.id);
      return { data: rows.map(publicInvite) };
    },
  );

  app.post(
    '/v1/team/invites/accept',
    { preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = AcceptBodySchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      reportUnknownRequestFields({
        body: request.body,
        knownKeys: knownRequestKeys(AcceptBodySchema),
        reply,
        logger: request.log,
        route: 'POST /v1/team/invites/accept',
      });
      const result = await service.accept({
        plaintextToken: parsed.data.token,
        acceptingAccountId: ctx.account.id,
      });
      return reply.code(200).send({ membership: publicMember(result.membership) });
    },
  );

  app.get(
    '/v1/team/members',
    { preHandler: [app.requireAuth, app.requireScope('read'), app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const rows = await service.listMembers(ctx.account.id);
      return { data: rows.map(publicMember) };
    },
  );

  // V-326c — list owner accounts the caller is a member of. Read
  // straight from ctx.teams (already loaded on auth-cache miss); no
  // DB call. The mirror of GET /v1/team/members (which lists "MY
  // members"); this is "teams I am ON".
  app.get(
    '/v1/team/owners',
    { preHandler: [app.requireAuth, app.requireScope('read'), app.rateLimit('global')] },
    (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      return {
        data: ctx.teams.map((t) => ({
          owner_account_id: `acc_${t.ownerAccountId}`,
          owner_email: t.ownerEmail ?? `acc_${t.ownerAccountId}`,
          owner_name: t.ownerName ?? null,
          role: t.role,
          membership_id: `mem_${t.membershipId}`,
        })),
      };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/team/members/:id',
    { preHandler: [app.requireAuth, app.requireScope('account_owner'), app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const id = uuidFromMemberId(request.params.id);
      const removed = await service.removeMember({
        membershipId: id,
        ownerAccountId: ctx.account.id,
      });
      if (!removed) {
        throw new NotFoundError(`Membership ${request.params.id} not found.`);
      }
      return reply.code(204).send();
    },
  );
}
